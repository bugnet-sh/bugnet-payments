import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type Address,
    address,
    getAddressEncoder,
    getBase58Decoder,
    type KeyPairSigner,
} from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    BootCheckError,
    bootChecks,
    refuseUnfinishedAllowanceOrders,
    x402BootChecks,
    type X402BootDeps,
} from "./boot.ts";
import { setPaymentLandedSlot } from "./orders/store.ts";
import { parseSettings } from "./config.ts";
import { orderPublicKeyBase64 } from "./orders/token.ts";
import { usdcAta } from "./solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "./solana/constants.ts";
import { testDb, type TestDb } from "./testing/db.ts";
import {
    createFakeRpc,
    type FakeRpc,
    type FakeRpcScript,
    neverAnswers,
} from "./testing/fake-rpc.ts";
import { testSigner } from "./testing/keys.ts";
import { memoryLog } from "./log.ts";
import { makeTestPki } from "./testing/pki.ts";
import { seedOrder, seedPayment } from "./testing/orders.ts";
import { seedAccount, seedFunding, TEST_PAYTO } from "./testing/x402.ts";
import { openIncidents } from "./x402/incidents.ts";
import { SignerGate } from "./x402/listener.ts";
import { transferableParts } from "./x402/liabilities.ts";
import { hotLedgerEmpty, openTail, readTail } from "./x402/tail.ts";

const recipient = address("Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw");
const feePayer = address("73iCm2eWpXsEqTpYkNHe4VoiR4Eq7nyCLv9wYZzEnFM9");
const refundWallet = address("57cyJJfb1o617JNvfCZfbXEsPAyK2z8HxEfWSHiVJAq9");
const EVENT_KEY = "a".repeat(43);

interface Overrides {
    programOwner?: string;
    mint?: string;
    owner?: string;
    state?: string;
}

function tokenAccount(owner: Address, o: Overrides = {}) {
    return {
        value: {
            owner: o.programOwner ?? TOKEN_PROGRAM,
            data: {
                program: "spl-token",
                parsed: {
                    type: "account",
                    info: {
                        mint: o.mint ?? USDC_MINT,
                        owner: o.owner ?? owner,
                        state: o.state ?? "initialized",
                        tokenAmount: { amount: "5000000", decimals: 6 },
                    },
                },
            },
        },
    };
}

function okAccounts(script: Partial<FakeRpcScript> = {}, recipientOverrides: Overrides = {}) {
    return createFakeRpc({
        getAccountInfo: async (ata: Address) =>
            ata === (await usdcAta(recipient))
                ? tokenAccount(recipient, recipientOverrides)
                : tokenAccount(refundWallet),
        getBalance: () => ({ value: 100_000_000n }),
        ...script,
    });
}

function deps(rpc: FakeRpc) {
    return {
        rpc,
        recipient,
        feePayer,
        refundWallet,
        feePayerMinLamports: 100_000_000n,
        refundsEnabled: false,
        eventPublicKey: EVENT_KEY,
        rpcTimeoutMs: 1_000,
    };
}

// The deadline's own abort, not a fast failure of another cause, ends the read
async function endsAtDeadline(run: Promise<unknown>): Promise<void> {
    const started = Date.now();
    await expect(run).rejects.toThrow(/abort|timeout/i);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(1_500);
}

describe("boot deadlines", () => {
    it("boot reads have a deadline", async () => {
        await endsAtDeadline(bootChecks(deps(okAccounts({ getBalance: neverAnswers }))));
        await endsAtDeadline(bootChecks(deps(okAccounts({ getAccountInfo: neverAnswers }))));
        // The refund wallet's account is read last, with refunds on
        const recipientAta = await usdcAta(recipient);
        const refundStalls = okAccounts({
            getAccountInfo: (ata: Address) =>
                ata === recipientAta ? tokenAccount(recipient) : neverAnswers(),
        });
        await endsAtDeadline(bootChecks({ ...deps(refundStalls), refundsEnabled: true }));
    });
});

describe("bootChecks", () => {
    it("refuses a missing recipient USDC account", async () => {
        const rpc = createFakeRpc({ getAccountInfo: () => ({ value: null }) });
        await expect(bootChecks(deps(rpc))).rejects.toThrow(
            /recipient USDC account \w+ does not exist.*keys fund --create-recipient-ata \w{32,44}$/,
        );
    });

    it("refuses a frozen, foreign or wrong-mint recipient account", async () => {
        await expect(bootChecks(deps(okAccounts({}, { state: "frozen" })))).rejects.toThrow(
            /frozen/,
        );
        await expect(bootChecks(deps(okAccounts({}, { owner: feePayer })))).rejects.toThrow(
            /owned by/,
        );
        await expect(bootChecks(deps(okAccounts({}, { mint: feePayer })))).rejects.toThrow(/mint/);
        await expect(bootChecks(deps(okAccounts({}, { programOwner: feePayer })))).rejects.toThrow(
            /owned by program/,
        );
        await expect(bootChecks(deps(okAccounts({}, { state: "uninitialized" })))).rejects.toThrow(
            /not initialized/,
        );
    });

    it("refuses a fee payer below the float", async () => {
        const rpc = okAccounts({ getBalance: () => ({ value: 99_999_999n }) });
        await expect(bootChecks(deps(rpc))).rejects.toThrow(
            "fee payer holds 99999999 lamports, needs at least 100000000",
        );
    });

    it("refuses a missing refund USDC account only when refunds are on", async () => {
        const missingRefund = () =>
            okAccounts({
                getAccountInfo: async (ata: Address) =>
                    ata === (await usdcAta(recipient)) ? tokenAccount(recipient) : { value: null },
            });
        await expect(
            bootChecks({ ...deps(missingRefund()), refundsEnabled: true }),
        ).rejects.toThrow(/refund USDC account \w+ does not exist/);
        await expect(bootChecks(deps(missingRefund()))).resolves.toBeDefined();
    });

    it("refuses refunds without a router event key, before any RPC", async () => {
        const rpc = okAccounts();
        await expect(
            bootChecks({ ...deps(rpc), refundsEnabled: true, eventPublicKey: "" }),
        ).rejects.toThrow(
            'router.event_public_key: set it to the output of bugnet-dev pubkey --priv "$BUGNET_EVENT_SIGNING_KEY" ' +
                "(dev only: the key appears in argv and shell history; use pubkey --event once router Task 39 ships)",
        );
        expect(Object.values(rpc.calls).reduce((a, b) => a + b, 0)).toBe(0);
        await expect(
            bootChecks({ ...deps(okAccounts()), refundsEnabled: false, eventPublicKey: "" }),
        ).resolves.toBeDefined();
    });

    it("refuses a recipient equal to the fee payer or the refund wallet", async () => {
        for (const hot of [feePayer, refundWallet]) {
            const err = await bootChecks({ ...deps(okAccounts()), recipient: hot }).catch(
                (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(BootCheckError);
            expect((err as Error).message).toBe(
                `recipient must be a cold address: ${hot} is also the fee payer or the refund ` +
                    "wallet; set [solana] recipient in the TOML settings to the cold wallet's address",
            );
            expect((err as Error).message).not.toContain("BUGNET_RECIPIENT_KEY");
        }
    });

    it("passes and reports the recipient account and fee payer balance", async () => {
        const r = await bootChecks({ ...deps(okAccounts()), refundsEnabled: true });
        expect(r.recipientAta).toBe(await usdcAta(recipient));
        expect(r.feePayerLamports).toBe(100_000_000n);
    });
});

async function secretKey(seed: number): Promise<string> {
    const signer = await testSigner(seed);
    const bytes = new Uint8Array(64);
    bytes.fill(seed, 0, 32);
    bytes.set(getAddressEncoder().encode(signer.address), 32);
    return getBase58Decoder().decode(bytes);
}

const T0 = new Date("2030-01-01T00:00:00Z");

describe("x402BootChecks", () => {
    let db: TestDb;
    let log: ReturnType<typeof memoryLog>;
    let dir: string;
    let indexPath: string;
    let allowance: KeyPairSigner;
    let allowanceKey: string;
    let tls: { certPem: string; keyPem: string; caPem: string };

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), "bugnet-boot-"));
        const pki = makeTestPki(dir, { days: 3650 });
        tls = {
            certPem: readFileSync(pki.serverCert, "utf8"),
            keyPem: readFileSync(pki.serverKey, "utf8"),
            caPem: readFileSync(pki.ca, "utf8"),
        };
        allowance = await testSigner(11);
        allowanceKey = await secretKey(11);
        indexPath = join(dir, "index.json");
    });
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
        db = await testDb();
        log = memoryLog();
        writeFileSync(indexPath, '{"v":1,"services":[]}');
    });
    afterEach(async () => {
        await db.close();
    });

    function hotAccount(
        o: { amount?: string; slot?: bigint; delegate?: string; closeAuthority?: string } = {},
    ) {
        return {
            context: { slot: o.slot ?? 5_000n },
            value: {
                owner: TOKEN_PROGRAM,
                data: {
                    program: "spl-token",
                    parsed: {
                        type: "account",
                        info: {
                            mint: USDC_MINT,
                            owner: allowance.address,
                            state: "initialized",
                            tokenAmount: { amount: o.amount ?? "0", decimals: 6 },
                            ...(o.delegate ? { delegate: o.delegate } : {}),
                            ...(o.closeAuthority ? { closeAuthority: o.closeAuthority } : {}),
                        },
                    },
                },
            },
        };
    }

    const hotRpc = (o: Parameters<typeof hotAccount>[0] = {}) =>
        createFakeRpc({ getAccountInfo: () => hotAccount(o) });

    function x402Deps(over: Partial<X402BootDeps> = {}): X402BootDeps {
        return {
            pool: db.pool,
            allowanceKey,
            x402: parseSettings(
                stringify({
                    solana: { recipient },
                    x402: {
                        allowance_wallet: allowance.address,
                        indexed_services_file: indexPath,
                    },
                }),
                "boot.test",
            ).x402,
            others: {
                feePayer: "73iCm2eWpXsEqTpYkNHe4VoiR4Eq7nyCLv9wYZzEnFM9",
                refundWallet: "57cyJJfb1o617JNvfCZfbXEsPAyK2z8HxEfWSHiVJAq9",
                recipient: "Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw",
                orderPublicKeyBase64: orderPublicKeyBase64(Buffer.alloc(32, 7)),
            },
            routerToken: "router-token",
            eventPublicKey: EVENT_KEY,
            tls,
            gate: new SignerGate({ staleAfterMs: 120_000, log, now: () => T0 }),
            runMirror: vi.fn(async () => "skipped" as const),
            log,
            now: () => T0,
            rpcTimeoutMs: 1_000,
            ...over,
        };
    }

    // the account's hot start order: payment landed at the slot, one stored placement.ready
    async function seedReadyShare(accountId: string, landedSlot: bigint): Promise<void> {
        await seedPayment(db.pool, accountId, { status: "confirmed" });
        await setPaymentLandedSlot(db.pool, accountId, landedSlot);
        await db.pool.query(
            `insert into events (event_id, type, created_at, order_id, payload)
             values ('ev-ready', 'placement.ready', now(), $1, $2)`,
            [accountId, JSON.stringify({ order_id: accountId })],
        );
    }

    it("the hot account read has a deadline", async () => {
        await endsAtDeadline(
            x402BootChecks(createFakeRpc({ getAccountInfo: neverAnswers }), x402Deps()),
        );
    });

    it("refuses a key whose address is not allowance_wallet", async () => {
        const other = await secretKey(12);
        const run = x402BootChecks(hotRpc(), x402Deps({ allowanceKey: other }));
        await expect(run).rejects.toBeInstanceOf(BootCheckError);
        await expect(run).rejects.toThrow(/BUGNET_ALLOWANCE_KEY/);
        await expect(run).rejects.not.toThrow(other);
        await expect(x402BootChecks(hotRpc(), x402Deps({ allowanceKey: "abc" }))).rejects.toThrow(
            /BUGNET_ALLOWANCE_KEY/,
        );
    });

    it("refuses an allowance key equal to the fee payer, refund wallet, recipient or order key", async () => {
        const base = x402Deps().others;
        const spki = Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(getAddressEncoder().encode(allowance.address)),
        ]).toString("base64");
        for (const [others, name] of [
            [{ ...base, feePayer: allowance.address }, "the fee payer"],
            [{ ...base, refundWallet: allowance.address }, "the refund wallet"],
            [{ ...base, recipient: allowance.address }, "the recipient"],
            [{ ...base, orderPublicKeyBase64: spki }, "the order-token key"],
        ] as const) {
            await expect(x402BootChecks(hotRpc(), x402Deps({ others }))).rejects.toThrow(
                `BUGNET_ALLOWANCE_KEY must be its own wallet: its address is also ${name}`,
            );
        }
    });

    it("refuses an index that fails to parse", async () => {
        writeFileSync(indexPath, '{"v":2,"services":[]}');
        const run = x402BootChecks(hotRpc(), x402Deps());
        await expect(run).rejects.toBeInstanceOf(BootCheckError);
        await expect(run).rejects.toThrow(/v must be 1/);
    });

    it("requires the event key and the router token whenever allowance_wallet is set, even with refunds off", async () => {
        await expect(x402BootChecks(hotRpc(), x402Deps({ eventPublicKey: "" }))).rejects.toThrow(
            /router\.event_public_key/,
        );
        await expect(x402BootChecks(hotRpc(), x402Deps({ routerToken: "" }))).rejects.toThrow(
            /BUGNET_PAYMENTS_ROUTER_TOKEN/,
        );
    });

    it("the first boot opens the tail at the current finalized slot and balance", async () => {
        const seen: unknown[] = [];
        const rpc = createFakeRpc({
            getAccountInfo: (_a: string, cfg: unknown) => {
                seen.push(cfg);
                return hotAccount({ amount: "250000", slot: 5_000n });
            },
        });
        const d = x402Deps();
        const r = await x402BootChecks(rpc, d);
        expect(r.hotTokenAccount).toBe(await usdcAta(allowance.address));
        expect(r.allowance.address).toBe(allowance.address);
        expect(await readTail(db.pool)).toMatchObject({
            tokenAccount: r.hotTokenAccount,
            openingBalanceMicros: 250_000n,
            openingSlot: 5_000n,
            verifiedSlot: 5_000n,
        });
        expect(seen[0]).toMatchObject({ encoding: "jsonParsed", commitment: "finalized" });
        expect(d.gate.open()).toBe(true);
    });

    it("refuses a first boot whose hot USDC account does not exist", async () => {
        const rpc = createFakeRpc({
            getAccountInfo: () => ({ context: { slot: 5_000n }, value: null }),
        });
        await expect(x402BootChecks(rpc, x402Deps())).rejects.toThrow(
            /allowance USDC account \w+ does not exist: create it once with: pnpm cli keys fund --create-allowance-ata/,
        );
    });

    it("a boot with a new allowance key is refused until the hot ledger is empty, and the new tail never counts the old account's parts", async () => {
        const oldAta = await usdcAta((await testSigner(13)).address);
        await openTail(db.pool, oldAta, 0n, 100n, T0);
        const { order } = await seedOrder(db.pool, {
            kind: "start",
            state: "paid",
            payInto: "allowance",
            amountMicros: 1_013_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            paidAt: T0,
        });
        const account = await seedAccount(db.pool, { id: order.id, state: "open" });
        await seedReadyShare(account.id, 150n);
        expect(await hotLedgerEmpty(db.pool)).toBe(false);
        expect(await transferableParts(db.pool, 6_000n, await readTail(db.pool))).toHaveLength(1);

        await expect(x402BootChecks(hotRpc(), x402Deps())).rejects.toThrow(
            `x402_tail token account ${oldAta} is not ATA(${allowance.address}) and the hot ledger is not empty: run keys drain --allowance first`,
        );

        await db.pool.query(
            "update x402_accounts set state = 'closed', closed_at = $2 where id = $1",
            [account.id, T0],
        );
        const T1 = new Date("2030-01-02T00:00:00Z");
        const r = await x402BootChecks(hotRpc({ slot: 5_000n }), x402Deps({ now: () => T1 }));
        const tail = await readTail(db.pool);
        expect(tail).toMatchObject({
            tokenAccount: r.hotTokenAccount,
            openingSlot: 5_000n,
            openedAt: T1,
        });
        expect(await transferableParts(db.pool, 6_000n, tail)).toEqual([]);
    });

    it("a failing live check closes the gate without stopping the boot", async () => {
        const d = x402Deps();
        await openTail(db.pool, await usdcAta(allowance.address), 0n, 100n, T0);
        await expect(x402BootChecks(hotRpc({ delegate: TEST_PAYTO }), d)).resolves.toBeDefined();
        expect(d.gate.open()).toBe(false);
        expect(log.lines.filter((l) => l.alarm === "x402_signer_down")).toHaveLength(1);
        expect((await openIncidents(db.pool)).map((i) => i.kind)).toEqual([
            "token_account_changed",
        ]);
    });

    it("an expired server certificate closes the gate without stopping the boot", async () => {
        const d = x402Deps({ now: () => new Date("2040-01-01T00:00:00Z") });
        await expect(x402BootChecks(hotRpc(), d)).resolves.toBeDefined();
        expect(d.gate.open()).toBe(false);
    });

    it("an RPC error on an open tail keeps the boot going and records error", async () => {
        await openTail(db.pool, await usdcAta(allowance.address), 0n, 100n, T0);
        const rpc = createFakeRpc({ getAccountInfo: () => Promise.reject(new Error("rpc down")) });
        const d = x402Deps();
        const record = vi.spyOn(d.gate, "record");
        await expect(x402BootChecks(rpc, d)).resolves.toBeDefined();
        expect(record).toHaveBeenCalledWith("token_account", "error", "read failed");
        expect(d.gate.open()).toBe(false);
        expect(await openIncidents(db.pool)).toEqual([]);
    });

    it("an RPC error on a first boot stops the boot", async () => {
        const rpc = createFakeRpc({ getAccountInfo: () => Promise.reject(new Error("rpc down")) });
        await expect(x402BootChecks(rpc, x402Deps())).rejects.toThrow();
    });

    it("runs the mirror at boot only when the last verified run is older than mirror_idle_every", async () => {
        const d = x402Deps();
        await x402BootChecks(hotRpc(), d);
        expect(d.runMirror).toHaveBeenCalledTimes(1);
        await db.pool.query("update x402_tail set verified_at = $1", [
            new Date(T0.getTime() - 30_000),
        ]);
        const d2 = x402Deps();
        await x402BootChecks(hotRpc(), d2);
        expect(d2.runMirror).toHaveBeenCalledTimes(0);
        await db.pool.query("update x402_tail set verified_at = $1", [
            new Date(T0.getTime() - 60_001),
        ]);
        const d3 = x402Deps({ runMirror: vi.fn(() => Promise.reject(new Error("rpc down"))) });
        await expect(x402BootChecks(hotRpc(), d3)).resolves.toBeDefined();
        expect(d3.runMirror).toHaveBeenCalledTimes(1);
        expect(log.lines.some((l) => l.msg === "boot mirror run failed")).toBe(true);
    });

    it("nothing x402 runs when allowance_wallet is empty", async () => {
        const rpc = okAccounts();
        await bootChecks(deps(rpc));
        expect(rpc.calls.getAccountInfo).toBe(1);
    });

    it("refuses to start with allowance_wallet empty while an allowance order is not finished", async () => {
        await expect(refuseUnfinishedAllowanceOrders(db.pool)).resolves.toBeUndefined();
        await seedOrder(db.pool, {
            kind: "start",
            state: "refunded",
            payInto: "allowance",
            amountMicros: 1_013_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
        });
        const { order } = await seedOrder(db.pool, {
            kind: "start",
            state: "redeemed",
            payInto: "allowance",
            amountMicros: 1_013_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
        });
        await seedAccount(db.pool, { id: order.id, state: "closed", closedAt: T0 });
        await expect(refuseUnfinishedAllowanceOrders(db.pool)).resolves.toBeUndefined();
        await seedOrder(db.pool, {
            kind: "start",
            state: "paid",
            payInto: "allowance",
            amountMicros: 1_013_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
        });
        const err = await refuseUnfinishedAllowanceOrders(db.pool).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BootCheckError);
        expect((err as Error).message).toMatch(/while 1 allowance order\(s\) are not finished/);
    });

    it("counts an allowance order funded through x402_fundings by its account's state", async () => {
        const start = await seedOrder(db.pool, { kind: "start", state: "refunded" });
        await seedAccount(db.pool, { id: start.order.id, state: "closed", closedAt: T0 });
        await seedFunding(db.pool, { accountId: start.order.id });
        await expect(refuseUnfinishedAllowanceOrders(db.pool)).resolves.toBeUndefined();
    });

    it("refuses a top-up order whose account is still open", async () => {
        const start = await seedOrder(db.pool, { kind: "start", state: "refunded" });
        await seedAccount(db.pool, { id: start.order.id });
        await seedFunding(db.pool, { accountId: start.order.id });
        await expect(refuseUnfinishedAllowanceOrders(db.pool)).rejects.toThrow(
            /while 1 allowance order\(s\) are not finished/,
        );
    });

    it("refuses an unresolved allowance refund even when every account is closed", async () => {
        const { order } = await seedOrder(db.pool, { kind: "start", state: "refunded" });
        await seedAccount(db.pool, { id: order.id, state: "closed", closedAt: T0 });
        const insert = (state: string, reason: string | null, kind: string) =>
            db.pool.query(
                `insert into refunds (order_id, kind, reason, amount_micros, destination, payer,
                    state, from_wallet, manual_reason)
                 values ($1, $2, $3, 1000, 'dest', 'payer', $4, 'allowance', $5)`,
                [
                    order.id,
                    kind,
                    kind === "allowance" ? "x402_unspent" : "x402_closed",
                    state,
                    reason,
                ],
            );
        await insert("sent", null, "allowance");
        const err = await refuseUnfinishedAllowanceOrders(db.pool).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BootCheckError);
        expect((err as Error).message).toMatch(/while 1 allowance refund\(s\) are not finished/);
        await db.pool.query(
            "update refunds set state = 'manual', manual_reason = 'resolved_by_hand'",
        );
        await expect(refuseUnfinishedAllowanceOrders(db.pool)).resolves.toBeUndefined();
        await db.pool.query("update refunds set state = 'confirmed', manual_reason = null");
        await expect(refuseUnfinishedAllowanceOrders(db.pool)).resolves.toBeUndefined();
    });
});
