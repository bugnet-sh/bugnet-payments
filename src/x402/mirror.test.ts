import { randomBytes } from "node:crypto";
import { address } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { memoryLog } from "../log.ts";
import { findPaymentByOrder } from "../orders/store.ts";
import { usdcAta } from "../solana/accounts.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { startFakeChain, type FakeChain } from "../testing/fake-chain.ts";
import { testSigner } from "../testing/keys.ts";
import {
    hotOrderPaidWith,
    landPayment,
    resetLedger,
    seedAccount,
    seedFunding,
    signedRow,
    TEST_PAYTO,
} from "../testing/x402.ts";
import { readControls } from "./controls.ts";
import { SignerGate } from "./listener.ts";
import {
    mirrorBusy,
    mirrorInterval,
    resetMirrorState,
    runMirror,
    type MirrorDeps,
} from "./mirror.ts";
import { findX402Payment } from "./reserve.ts";
import { advanceVerified, openTail, readTail } from "./tail.ts";

const NOW = new Date("2030-01-01T12:00:00Z");
const OPENED = new Date(NOW.getTime() - 1_000);

let db: TestDb;
let chain: FakeChain;
let d: MirrorDeps;
let log: ReturnType<typeof memoryLog>;
let gate: SignerGate;
let clock: Date;
let x402: Settings["x402"];
let hot: string;
let payToAta: string;
let cold: string;
let allowance: Awaited<ReturnType<typeof testSigner>>;

beforeAll(async () => {
    db = await testDb();
    x402 = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t").x402;
    allowance = await testSigner(11);
    hot = await usdcAta(allowance.address);
    payToAta = await usdcAta(address(TEST_PAYTO));
    cold = await usdcAta((await testSigner(23)).address);
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await resetLedger(db.pool);
    await db.pool.query(
        `truncate x402_chain_txs, x402_incidents, x402_cold_transfers, x402_payto_days,
            x402_unlisted_days, x402_outflow_days cascade`,
    );
    await db.pool.query("update x402_tail set finalized_height = 0 where id = 1");
    resetMirrorState();
    chain = await startFakeChain({ autoFinalize: true });
    chain.setTokenAccount({ address: hot, owner: allowance.address, amount: 1_000_000n });
    chain.setTokenAccount({ address: payToAta, owner: TEST_PAYTO, amount: 0n });
    chain.setTokenAccount({ address: cold, owner: (await testSigner(23)).address, amount: 0n });
    await openTail(db.pool, hot, 1_000_000n, chain.slot(), OPENED);
    chain.advance(1);
    clock = NOW;
    log = memoryLog();
    gate = new SignerGate({ staleAfterMs: 120_000, log, now: () => clock });
    gate.record("tls", "pass");
    d = {
        pool: db.pool,
        rpc: chain.rpc,
        allowanceWallet: allowance.address,
        hotTokenAccount: address(hot),
        coldTokenAccount: address(cold),
        x402,
        gate,
        log,
        now: () => clock,
        rpcTimeoutMs: 2_000,
    };
});
afterEach(async () => {
    await chain.close();
});

const paymentRow = async (id: string) => (await findX402Payment(db.pool, id))!;
const chainRows = async () => (await db.pool.query("select * from x402_chain_txs")).rows;
const chainSignatures = async () =>
    (await db.pool.query<{ signature: string }>("select signature from x402_chain_txs")).rows
        .map((r) => r.signature)
        .sort();
const incidents = async () =>
    (await db.pool.query("select * from x402_incidents order by id")).rows;
const alarms = (name: string) => log.lines.filter((l) => l.alarm === name);

describe("runMirror", () => {
    it("verifies a complete history and moves verified_slot forward only", async () => {
        chain.credit(hot, 5_000n);
        chain.advance(1);
        const r1 = await runMirror(d);
        expect(r1).toMatchObject({ verified: true, c: chain.slot(), stored: 1 });
        expect((await readTail(db.pool)).verifiedSlot).toBe(r1.c);
        chain.advance(3);
        const r2 = await runMirror(d);
        expect(r2).toMatchObject({ verified: true, stored: 0 });
        expect((await readTail(db.pool)).verifiedSlot).toBe(r1.c + 3n);
        expect((await readTail(db.pool)).finalizedHeight).toBe(r2.h0);
    });

    it("a backlog delays expiry and is never a mismatch", async () => {
        const row = await signedRow(db.pool, { lastValidBlockHeight: 1n, expirySeenSlot: 1n });
        for (let i = 0; i < 5; i++) chain.credit(hot, 1n);
        const small = { ...d, x402: { ...x402, mirror_page_size: 2 } };
        expect(await runMirror(small)).toMatchObject({
            verified: false,
            reason: "backlog",
            stored: 2,
        });
        expect(await incidents()).toEqual([]);
        expect((await readTail(db.pool)).mismatchSince).toBeNull();
        expect((await paymentRow(row.id)).state).toBe("signed");
        await runMirror(small);
        expect(await runMirror(small)).toMatchObject({ verified: true });
    });

    it("a history index that hides a landed transfer never expires the row, and alarms after 2 minutes", async () => {
        const p = await landPayment(chain, db.pool);
        const row = await signedRow(db.pool, {
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
            lastValidBlockHeight: 1n,
            expirySeenSlot: 1n,
        });
        chain.hideFromIndex(p.txSignature, 600_000);
        expect(await runMirror(d)).toMatchObject({ verified: false, reason: "balance" });
        expect((await readTail(db.pool)).mismatchSince).toEqual(NOW);
        expect(await incidents()).toEqual([]);
        clock = new Date(NOW.getTime() + 120_001);
        await runMirror(d);
        expect(await incidents()).toEqual([
            expect.objectContaining({ kind: "balance_mismatch", subject: "balance_mismatch" }),
        ]);
        expect((await readControls(db.pool)).paused).toBe(true);
        expect((await paymentRow(row.id)).state).toBe("signed");
    });

    it("equal balances clear mismatch_since", async () => {
        await db.pool.query("update x402_tail set mismatch_since = $1", [NOW]);
        const s = chain.credit(hot, 1_013_000n);
        chain.hideFromIndex(s, 600_000);
        await runMirror(d);
        expect((await readTail(db.pool)).mismatchSince).toEqual(NOW);
        chain.hideFromIndex(s, 0);
        await runMirror(d);
        expect((await readTail(db.pool)).mismatchSince).toBeNull();
    });

    it("reads below minContextSlot are thrown away", async () => {
        chain.credit(hot, 5_000n);
        chain.lagNode(5, { methods: ["getAccountInfo"] });
        expect(await runMirror(d)).toMatchObject({ verified: false, reason: "rpc", stored: 0 });
        chain.lagNode(5, { methods: ["getAccountInfo"], refuse: false });
        expect(await runMirror(d)).toMatchObject({ verified: false, reason: "rpc", stored: 0 });
        expect(await chainRows()).toEqual([]);
    });

    it("a null getTransaction for a listed signature is retried, never stored", async () => {
        const s = chain.credit(hot, 5_000n);
        chain.withholdTransaction(s, 1);
        expect(await runMirror(d)).toMatchObject({ verified: false, reason: "backlog", stored: 0 });
        expect(await chainRows()).toEqual([]);
        expect(await runMirror(d)).toMatchObject({ verified: true, stored: 1 });
    });

    it("a run that throws on an unparseable transaction still raises x402_tail_lag", async () => {
        chain.credit(hot, 5_000n);
        const rpc = new Proxy(chain.rpc, {
            get: (target, prop, recv) =>
                prop === "getTransaction"
                    ? () => ({ send: async () => ({ slot: 1n, transaction: [], meta: null }) })
                    : Reflect.get(target, prop, recv),
        });
        const broken = { ...d, rpc };
        await expect(runMirror(broken)).rejects.toThrow();
        expect(alarms("x402_tail_lag")).toHaveLength(0);
        clock = new Date(NOW.getTime() + 60_001);
        await expect(runMirror(broken)).rejects.toThrow();
        expect(alarms("x402_tail_lag")).toHaveLength(1);
    });

    it("a known order payment with a null landed_slot is looked up by status first", async () => {
        const s = chain.credit(hot, 1_013_000n);
        const at = chain.slot();
        chain.hideFromIndex(s, 600_000);
        const order = await hotOrderPaidWith(db.pool, s);
        expect(await runMirror(d)).toMatchObject({ verified: false, reason: "known_missing" });
        expect((await findPaymentByOrder(db.pool, order.id))!.landedSlot).toBe(at);
    });

    it("a known payment the status never finds is a mirror_gap after 2 minutes", async () => {
        const sig = "1".repeat(63) + "2";
        await hotOrderPaidWith(db.pool, sig);
        expect(await runMirror(d)).toMatchObject({ verified: false, reason: "known_missing" });
        expect(await incidents()).toEqual([]);
        clock = new Date(NOW.getTime() + 120_001);
        await runMirror(d);
        expect(await incidents()).toEqual([
            expect.objectContaining({ kind: "mirror_gap", subject: sig }),
        ]);
    });

    it("a known landed payment missing from the history is a mirror_gap once it is 300 slots old", async () => {
        const s = chain.credit(hot, 1_013_000n);
        chain.hideFromIndex(s, 600_000);
        const order = await hotOrderPaidWith(db.pool, s);
        await runMirror(d);
        expect(await incidents()).toEqual([]);
        chain.advance(300);
        await runMirror(d);
        expect(await incidents()).toEqual([
            expect.objectContaining({ kind: "mirror_gap", subject: s }),
        ]);
        expect((await findPaymentByOrder(db.pool, order.id))!.landedSlot).not.toBeNull();
    });

    it("a dust flood delays expiries only", async () => {
        for (let i = 0; i < 3_000; i++) chain.credit(hot, 1n);
        chain.advance(1);
        const p = await landPayment(chain, db.pool);
        const row = await signedRow(db.pool, {
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
            signingSlot: chain.slot(),
        });
        const expiring = await signedRow(db.pool, { lastValidBlockHeight: 1n, expirySeenSlot: 1n });
        expect(await runMirror(d)).toMatchObject({
            verified: false,
            reason: "backlog",
            stored: 1_000,
        });
        expect((await paymentRow(row.id)).state).toBe("confirmed");
        expect((await paymentRow(expiring.id)).state).toBe("signed");
        expect(await incidents()).toEqual([]);
        expect(alarms("x402_tail_lag")).toHaveLength(0);
        clock = new Date(NOW.getTime() + 60_001);
        const small = { ...d, x402: { ...x402, mirror_page_size: 10 } };
        await runMirror(small);
        expect(alarms("x402_tail_lag")).toHaveLength(1);
        await runMirror(small);
        expect(alarms("x402_tail_lag")).toHaveLength(1);
    }, 60_000);

    it("the rescan pages down to verified_slot - 300 and the lowest open signing_slot, never below opening_slot", async () => {
        const opening = (await readTail(db.pool)).openingSlot;
        chain.advance(Number(opening + 1_650n - chain.slot()));
        const low = chain.credit(hot, 1_000n);
        const lowSlot = chain.slot();
        chain.advance(100);
        const high = chain.credit(hot, 2_000n);
        chain.advance(Number(opening + 2_000n - chain.slot()));
        await advanceVerified(db.pool, chain.slot(), NOW);
        expect(lowSlot).toBe(opening + 1_650n);

        await runMirror(d);
        expect(await chainSignatures()).toEqual([high]);

        await signedRow(db.pool, { signingSlot: opening + 1_600n });
        await runMirror(d);
        expect(await chainSignatures()).toEqual([low, high].sort());

        await db.pool.query("truncate x402_chain_txs");
        await openTail(db.pool, hot, 1_000_000n, opening + 1_700n, OPENED);
        await runMirror(d);
        expect(await chainSignatures()).toEqual([high]);
    });

    it("live check 5 on every run", async () => {
        await runMirror(d);
        expect(gate.open()).toBe(true);
        chain.approve(hot, TEST_PAYTO);
        await runMirror(d);
        expect(gate.open()).toBe(false);
        expect(await incidents()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "token_account_changed",
                    subject: "token_account_changed",
                    detail: { tokenAccount: hot, problem: "delegate" },
                }),
            ]),
        );
        expect(alarms("x402_signer_down")).toHaveLength(1);
    });

    it("a missing token account is an incident and stops the run", async () => {
        const gone = { ...d, hotTokenAccount: address(payToAta.replace(/.$/, "1")) };
        await db.pool.query("update x402_tail set token_account = $1 where id = 1", [
            gone.hotTokenAccount,
        ]);
        const r = await runMirror(gone);
        expect(r).toMatchObject({ verified: false, reason: "token_account" });
        expect(await incidents()).toEqual([
            expect.objectContaining({
                kind: "token_account_changed",
                detail: { tokenAccount: gone.hotTokenAccount, problem: "missing" },
            }),
        ]);
        expect(gate.open()).toBe(false);
    });

    it("a null token-account answer from a node behind C0 is an rpc retry, never an incident", async () => {
        const gone = { ...d, hotTokenAccount: address(payToAta.replace(/.$/, "1")) };
        await db.pool.query("update x402_tail set token_account = $1 where id = 1", [
            gone.hotTokenAccount,
        ]);
        chain.lagNode(5, { methods: ["getAccountInfo"], refuse: false });
        expect(await runMirror(gone)).toMatchObject({ verified: false, reason: "rpc" });
        expect(await incidents()).toEqual([]);
        const bare = new Proxy(chain.rpc, {
            get: (target, prop, recv) =>
                prop === "getAccountInfo"
                    ? () => ({ send: async () => ({ value: null }) })
                    : Reflect.get(target, prop, recv),
        });
        expect(await runMirror({ ...gone, rpc: bare })).toMatchObject({
            verified: false,
            reason: "rpc",
        });
        expect(await incidents()).toEqual([]);
    });

    it("a tail opened on another token account is refused with a token_account reason", async () => {
        const other = { ...d, hotTokenAccount: address(cold) };
        const before = chain.calls().length;
        expect(await runMirror(other)).toMatchObject({ verified: false, reason: "token_account" });
        expect(chain.calls().length).toBe(before);
        expect(
            log.lines.some((l) => String(l.msg).includes("not the configured hot account")),
        ).toBe(true);
    });

    it("listing stops at 10 pages per run and verified_slot waits until it reaches the lower bound", async () => {
        for (let i = 0; i < 60; i++) chain.credit(hot, 1n);
        chain.advance(1);
        const small = { ...d, x402: { ...x402, mirror_page_size: 5 } };
        const listCalls = () =>
            chain.calls().filter((c) => c.method === "getSignaturesForAddress").length;
        const opening = (await readTail(db.pool)).verifiedSlot;
        let before = listCalls();
        await runMirror(small);
        expect(listCalls() - before).toBe(10);
        expect((await readTail(db.pool)).verifiedSlot).toBe(opening);
        let verified = false;
        for (let i = 0; i < 40 && !verified; i++) {
            before = listCalls();
            verified = (await runMirror(small)).verified;
            expect(listCalls() - before).toBeLessThanOrEqual(10);
        }
        expect(verified).toBe(true);
        expect((await readTail(db.pool)).verifiedSlot).toBeGreaterThan(opening);
        expect(await chainRows()).toHaveLength(60);
        expect(await incidents()).toEqual([]);
    }, 60_000);

    it("a known payment waiting in the backlog is never a mirror_gap", async () => {
        for (let i = 0; i < 30; i++) chain.credit(hot, 1n);
        const s = chain.credit(hot, 1_013_000n);
        await hotOrderPaidWith(db.pool, s);
        chain.advance(400);
        const small = { ...d, x402: { ...x402, mirror_page_size: 5 } };
        expect(await runMirror(small)).toMatchObject({ verified: false, reason: "backlog" });
        expect(await chainSignatures()).not.toContain(s);
        expect(await incidents()).toEqual([]);
    });

    it("a known payment listed by an earlier run is not a mirror_gap on the run that completes", async () => {
        for (let i = 0; i < 40; i++) chain.credit(hot, 1n);
        const s = chain.credit(hot, 1_013_000n);
        await hotOrderPaidWith(db.pool, s);
        chain.advance(400);
        const small = { ...d, x402: { ...x402, mirror_page_size: 3 } };
        let completed = false;
        for (let i = 0; i < 40 && !completed; i++) {
            const run = await runMirror(small);
            const stored = (await chainSignatures()).includes(s);
            if (!stored && run.verified === false && run.reason === "backlog") continue;
            completed = true;
        }
        expect(await incidents()).toEqual([]);
    }, 60_000);

    it("a tail that is not open returns token_account with no RPC call", async () => {
        await db.pool.query("update x402_tail set token_account = null where id = 1");
        const before = chain.calls().length;
        expect(await runMirror(d)).toMatchObject({ verified: false, reason: "token_account" });
        expect(chain.calls().length).toBe(before);
    });

    it("an RPC error on the token account keeps the gate's last result", async () => {
        await runMirror(d);
        chain.lagNode(5, { methods: ["getAccountInfo"] });
        await runMirror(d);
        expect(gate.open()).toBe(true);
    });

    it("the balance check on a verified run", async () => {
        const account = await seedAccount(db.pool, { fundedMicros: 0 });
        const funding = await seedFunding(db.pool, {
            accountId: account.id,
            allowanceMicros: 3_000_000,
        });
        const s = chain.credit(hot, 1_000_000n);
        await db.pool.query(
            `update payments set tx_signature = $2, landed_slot = $3, status = 'confirmed',
                confirmed_at = $4 where order_id = $1`,
            [funding.orderId, s, chain.slot().toString(), NOW],
        );
        expect(await runMirror(d)).toMatchObject({ verified: true });
        expect(await incidents()).toEqual([
            expect.objectContaining({
                kind: "balance_short",
                subject: "balance_short",
                loss_micros: "1000000",
            }),
        ]);
    });

    it("the mirror storing payments.landed_slot of a markPaid order", async () => {
        const s = chain.credit(hot, 1_013_000n);
        const at = chain.slot();
        const order = await hotOrderPaidWith(db.pool, s);
        expect(await runMirror(d)).toMatchObject({ verified: true });
        expect((await findPaymentByOrder(db.pool, order.id))!.landedSlot).toBe(at);
    });
});

describe("cadence", () => {
    const sig = (c: string) => c.repeat(63) + "2";
    const busyCases: [string, () => Promise<() => Promise<unknown>>][] = [
        [
            "a reserved row",
            async () => {
                const row = await signedRow(db.pool, { state: "reserved" });
                return () => db.pool.query("delete from x402_payments where id = $1", [row.id]);
            },
        ],
        [
            "an account closing",
            async () => {
                const a = await seedAccount(db.pool, {
                    state: "closing",
                    handleSha256: randomBytes(32).toString("hex"),
                });
                return () =>
                    db.pool.query("update x402_accounts set state = 'closed' where id = $1", [
                        a.id,
                    ]);
            },
        ],
        [
            "an allowance order settling",
            async () => {
                const order = await hotOrderPaidWith(db.pool, sig("1"));
                await db.pool.query("update orders set state = 'settling' where id = $1", [
                    order.id,
                ]);
                return () =>
                    db.pool.query("update orders set state = 'paid' where id = $1", [order.id]);
            },
        ],
        [
            "an allowance refund sent",
            async () => {
                const a = await seedAccount(db.pool, {
                    handleSha256: randomBytes(32).toString("hex"),
                });
                await db.pool.query(
                    `insert into refunds (order_id, kind, reason, amount_micros, destination, payer,
                        state, from_wallet, tx_signature)
                     values ($1, 'allowance', 'x402_unspent', 10000, 'dest', 'payer-1', 'sent',
                        'allowance', $2)`,
                    [a.id, sig("2")],
                );
                return () => db.pool.query("update refunds set state = 'confirmed'");
            },
        ],
        [
            "a cold transfer signed",
            async () => {
                await db.pool.query(
                    `insert into x402_cold_transfers (amount_micros, state, tx_signature)
                     values (10000, 'signed', $1)`,
                    [sig("3")],
                );
                return () => db.pool.query("update x402_cold_transfers set state = 'confirmed'");
            },
        ],
    ];

    it.each(busyCases)("is busy with %s", async (_name, make) => {
        expect(await mirrorBusy(db.pool)).toBe(false);
        const undo = await make();
        expect(await mirrorBusy(db.pool)).toBe(true);
        await undo();
        expect(await mirrorBusy(db.pool)).toBe(false);
    });

    it("picks mirror_every when busy and mirror_idle_every when idle", () => {
        expect(mirrorInterval(true, x402)).toBe(5_000);
        expect(mirrorInterval(false, x402)).toBe(60_000);
    });
});
