import { randomBytes } from "node:crypto";
import {
    type Address,
    getBase58Decoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    type KeyPairSigner,
} from "@solana/kit";
import { getTransferCheckedInstructionDataDecoder } from "@solana-program/token";
import type pg from "pg";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { memoryLog } from "../log.ts";
import {
    confirmPayment,
    findOrder,
    lockOrder,
    lockPayment,
    setOrderState,
} from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { writeHotPartial } from "../refunds/hot.ts";
import type { RefundDeps } from "../refunds/executor.ts";
import { runRefunds } from "../refunds/executor.ts";
import { findRefund, findRefundById, requestRefund } from "../refunds/request.ts";
import type { RouterClient } from "../router/client.ts";
import { usdcAta } from "../solana/accounts.ts";
import { MEMO_PROGRAM, TOKEN_PROGRAM } from "../solana/constants.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import {
    createFakeRpc,
    epochAt,
    type FakeRpc,
    type FakeRpcScript,
    TEST_BLOCKHASH,
    TEST_LVBH,
} from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { seedAllowanceOrder, seedOrder, seedPayment } from "../testing/orders.ts";
import {
    resetLedger,
    seedAccount,
    seedFunding,
    seedX402Payment,
    TEST_PAYTO,
    usdcAccountAnswer,
} from "../testing/x402.ts";
import { advanceColdTransfers, balanceAt, type ColdDeps, runColdTransfer } from "./cold.ts";
import { type CloseDeps, runCloseJob } from "./close.ts";
import { readControls, setControls } from "./controls.ts";
import { recordIncident, openIncidents } from "./incidents.ts";
import { createAllowanceFunding } from "./funding.ts";
import { findAccount } from "./ledger.ts";
import { onOrderPaid } from "./paid.ts";
import { resolveSigned, runReleaseJob } from "./reserve.ts";
import { advanceVerified, openTail } from "./tail.ts";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const T0 = new Date("2030-01-01T12:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const LANDED_FAILED = {
    confirmationStatus: "confirmed",
    err: { InstructionError: [2, { Custom: 1 }] },
    slot: 1n,
};

let db: TestDb;
let log = memoryLog();
let settings: Settings;
let feePayer: KeyPairSigner;
let allowance: KeyPairSigner;
let payer: KeyPairSigner;
let HOT: Address;
let COLD: Address;
let SOURCE: Address;

beforeAll(async () => {
    db = await testDb();
    feePayer = await testSigner(4);
    allowance = await testSigner(7);
    payer = await testSigner(6);
    HOT = await usdcAta(allowance.address);
    COLD = await usdcAta((await testSigner(1)).address);
    SOURCE = await usdcAta(payer.address);
    settings = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t");
});
afterAll(async () => {
    await db.close();
});

async function reset(): Promise<void> {
    log = memoryLog();
    await resetLedger(db.pool);
    await db.pool.query(
        "truncate x402_cold_transfers, x402_chain_txs, x402_refund_days, x402_incidents cascade",
    );
    await db.pool.query("update x402_tail set verified_slot = 0, verified_at = null");
}
beforeEach(reset);

const alarms = (name: string) => log.lines.filter((l) => l.alarm === name);

function rpc(script: Partial<FakeRpcScript> = {}): FakeRpc {
    return createFakeRpc({
        getLatestBlockhash: () => ({
            context: { slot: 777n },
            value: { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: TEST_LVBH },
        }),
        ...script,
    });
}

function deps(at: Date, over: Partial<ColdDeps> = {}): ColdDeps {
    return {
        pool: db.pool,
        rpc: rpc(),
        feePayer,
        allowance,
        hotTokenAccount: HOT,
        coldTokenAccount: COLD,
        refunds: settings.refunds,
        x402: settings.x402,
        rpcTimeoutMs: settings.solana.rpc_timeout,
        log,
        now: () => at,
        requestMirror: async () => null,
        ...over,
    };
}

async function verified(at: Date, slot = 200n, balance = 100_000_000n): Promise<void> {
    await openTail(db.pool, HOT, balance, 1n, later(-3_600_000));
    await advanceVerified(db.pool, slot, at);
}

// A redeemed hot start order whose placement is ready, with `micros` of Bugnet's share
async function share(
    micros: number,
    since: Date,
    o: { landedSlot?: bigint; hotRouterRefundMicros?: number } = {},
): Promise<OrderRow> {
    const { order } = await seedOrder(db.pool, {
        kind: "start",
        state: "redeemed",
        payInto: "allowance",
        allowanceMicros: 1_000_000,
        feeMicros: Math.min(3_000, micros),
        amountMicros: 1_000_000 + micros,
        createdAt: since,
        paidAt: since,
        hotRouterRefundMicros: o.hotRouterRefundMicros ?? 0,
    });
    await seedPayment(db.pool, order.id, {
        status: "confirmed",
        confirmedAt: since,
        landedSlot: o.landedSlot ?? 100n,
    });
    await db.pool.query(
        `insert into events (event_id, type, created_at, received_at, order_id, payload)
         values ($1, 'placement.ready', $2, $2, $3, $4::jsonb)`,
        [
            randomBytes(8).toString("hex"),
            since,
            order.id,
            JSON.stringify({ order_id: order.id, deadline: later(3_600_000).toISOString() }),
        ],
    );
    return order;
}

async function kept(micros: number, since: Date) {
    const a = await seedAccount(db.pool, {
        state: "closed",
        closedAt: since,
        fundedMicros: micros,
        keptMicros: micros,
        handleSha256: randomBytes(32).toString("hex"),
    });
    await seedPayment(db.pool, a.id, { status: "confirmed", confirmedAt: since, landedSlot: 100n });
    return a;
}

async function fee(accountSince: Date): Promise<void> {
    const a = await seedAccount(db.pool, { state: "open", createdAt: accountSince });
    const { order } = await seedAllowanceOrder(db.pool, {
        state: "redeemed",
        feeMicros: 3_000,
        paidAt: accountSince,
    });
    await seedPayment(db.pool, order.id, {
        status: "confirmed",
        confirmedAt: accountSince,
        landedSlot: 100n,
    });
    await seedFunding(db.pool, {
        accountId: a.id,
        orderId: order.id,
        feeCreditedMicros: 0,
        createdAt: accountSince,
    });
}

function refundDeps(at: Date): RefundDeps {
    return {
        pool: db.pool,
        rpc: rpc({ getAccountInfo: () => usdcAccountAnswer(payer.address) }),
        feePayer,
        refundSigner: feePayer,
        allowanceSigner: allowance,
        x402: settings.x402,
        hotTokenAccount: HOT,
        cfg: settings.refunds,
        rpcTimeoutMs: settings.solana.rpc_timeout,
        log,
        now: () => at,
    };
}

async function hotRefundRow(micros: number): Promise<void> {
    const account = await seedAccount(db.pool, {
        state: "open",
        handleSha256: randomBytes(32).toString("hex"),
    });
    const funding = await seedFunding(db.pool, {
        accountId: account.id,
        allowanceMicros: 1_000_000,
        payer: payer.address,
        sourceTokenAccount: SOURCE,
    });
    await db.pool.query("update x402_pool set committed_micros = 1000000");
    const res = await db.pool.query<{ id: string }>(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            from_wallet, budget_waived)
         values ($1, 'allowance', 'x402_unspent', $2, $3, $4, 'pending', 'allowance', false)
         returning id`,
        [funding.orderId, micros, SOURCE, payer.address],
    );
    expect(await findRefundById(db.pool, Number(res.rows[0]!.id))).not.toBeNull();
}

function decodeMessage(wire: string) {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (msg.version !== 0) throw new Error(`expected a v0 message, got ${msg.version}`);
    return msg;
}
type Message = ReturnType<typeof decodeMessage>;
const programsOf = (msg: Message) =>
    msg.instructions.map((i) => msg.staticAccounts[i.programAddressIndex]);

function transferOf(msg: Message) {
    const ix = msg.instructions.find(
        (i) => msg.staticAccounts[i.programAddressIndex] === TOKEN_PROGRAM,
    )!;
    const [source, mint, destination, authority] = ix.accountIndices!.map(
        (n) => msg.staticAccounts[n],
    );
    const data = getTransferCheckedInstructionDataDecoder().decode(ix.data!);
    return { source, mint, destination, authority, amount: data.amount, decimals: data.decimals };
}

function memoOf(msg: Message): string {
    const ix = msg.instructions.find(
        (i) => msg.staticAccounts[i.programAddressIndex] === MEMO_PROGRAM,
    )!;
    return new TextDecoder().decode(ix.data!);
}

// Counts the deadlocks (40P01) any client checked out with pool.connect reports, withTx re-runs
// included
function countDeadlocks(pool: pg.Pool): { count(): number; restore(): void } {
    let n = 0;
    const connect = pool.connect;
    const patched = new WeakSet<object>();
    pool.connect = (async (...args: unknown[]) => {
        const client = await (connect as (...a: unknown[]) => Promise<pg.PoolClient>).apply(
            pool,
            args,
        );
        if (args.length === 0 && !patched.has(client)) {
            patched.add(client);
            const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
            (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
                try {
                    return await query(...a);
                } catch (err) {
                    if ((err as { code?: string } | null)?.code === "40P01") n++;
                    throw err;
                }
            };
        }
        return client;
    }) as typeof pool.connect;
    return {
        count: () => n,
        restore: () => {
            pool.connect = connect;
        },
    };
}

describe("balanceAt", () => {
    it("adds stored deltas after the opening slot up to C", async () => {
        await verified(T0, 200n, 1_000n);
        for (const [sig, slot, delta] of [
            ["a", 1n, 5_000n],
            ["b", 2n, -300n],
            ["c", 200n, 50n],
            ["d", 201n, 7_000n],
        ] as const) {
            await db.pool.query(
                `insert into x402_chain_txs (signature, slot, delta_micros, failed, matched)
                 values ($1, $2, $3, false, 'unknown')`,
                [sig, slot.toString(), delta.toString()],
            );
        }
        const tail = (await import("./tail.ts")).readTail;
        expect(await balanceAt(db.pool, 200n, await tail(db.pool))).toBe(750n);
    });
});

describe("runColdTransfer", () => {
    it("threshold and age", async () => {
        await verified(T0);
        await share(19_999_999, later(-3_540_000));
        expect(await runColdTransfer(deps(T0))).toMatchObject({
            sent: false,
            reason: "below_threshold",
        });
        await share(1, later(-60_000));
        expect(await runColdTransfer(deps(T0))).toMatchObject({
            sent: true,
            amountMicros: 20_000_000,
            parts: 2,
        });
        await reset();
        await verified(T0);
        await share(13_000, later(-3_600_000));
        expect(await runColdTransfer(deps(T0))).toMatchObject({
            sent: true,
            amountMicros: 13_000,
            parts: 1,
        });
    });

    it("only eligible shares, kept amounts included, net of hot router refunds", async () => {
        await verified(T0);
        await share(13_000, later(-60_000), { hotRouterRefundMicros: 8_000 });
        await fee(later(-60_000));
        await kept(4_000, later(-60_000));
        await share(13_000, later(-60_000), { landedSlot: 201n });
        const d = deps(T0, { x402: { ...settings.x402, cold_transfer_threshold_micros: 1 } });
        expect(await runColdTransfer(d)).toMatchObject({
            sent: true,
            amountMicros: 12_000,
            parts: 3,
        });
    });

    it("a balance mismatch pauses transfers and seller payments, not refunds", async () => {
        await verified(T0);
        await share(20_000_000, later(-60_000));
        await withTx(db.pool, (c) =>
            recordIncident(
                c,
                { kind: "balance_mismatch", subject: "balance_mismatch", detail: {} },
                log,
                T0,
            ),
        );
        expect(await runColdTransfer(deps(T0))).toMatchObject({ sent: false, reason: "paused" });
        expect((await readControls(db.pool)).paused).toBe(true);
        await hotRefundRow(300_000);
        const tick = await runRefunds(refundDeps(T0), "allowance");
        expect(tick.sent).toBe(1);
    });

    it("sends only after a verified run within 60 s, and only above the liabilities", async () => {
        await verified(later(-60_001), 200n, 19_999_999n);
        await share(20_000_000, later(-60_000));
        expect(await runColdTransfer(deps(T0))).toMatchObject({
            sent: false,
            reason: "unverified",
        });
        const mirror = async () => {
            await advanceVerified(db.pool, 210n, T0);
            return null;
        };
        expect(await runColdTransfer(deps(T0, { requestMirror: mirror }))).toMatchObject({
            sent: false,
            reason: "balance_short",
        });
        expect((await openIncidents(db.pool)).map((i) => i.kind)).toEqual(["balance_short"]);
        await reset();
        await verified(later(-60_001), 200n, 20_000_000n);
        await share(20_000_000, later(-60_000));
        expect(await runColdTransfer(deps(T0, { requestMirror: mirror }))).toMatchObject({
            sent: true,
            amountMicros: 20_000_000,
        });
    });

    it("one TransferChecked, fee payer first, memo bugnet-cold <id>, stored before broadcast", async () => {
        await verified(T0);
        const o = await share(20_000_000, later(-60_000));
        const seen: Record<string, unknown> = {};
        const d = deps(T0, {
            rpc: rpc({
                sendTransaction: async (wire: string) => {
                    const row = (await db.pool.query("select * from x402_cold_transfers")).rows[0];
                    Object.assign(seen, { row, order: await findOrder(db.pool, o.id), wire });
                    return row.tx_signature;
                },
            }),
        });
        expect(await runColdTransfer(d)).toMatchObject({ sent: true, amountMicros: 20_000_000 });
        const { row, order, wire } = seen as {
            row: Record<string, unknown>;
            order: OrderRow;
            wire: string;
        };
        expect(row).toMatchObject({
            state: "signed",
            wire_tx: wire,
            signing_slot: "777",
            attempts: 1,
        });
        expect(order.coldTransferId).toBe(Number(row.id));
        const msg = decodeMessage(wire);
        expect(msg.staticAccounts.slice(0, 2)).toEqual([feePayer.address, allowance.address]);
        expect(programsOf(msg)).toEqual([
            COMPUTE_BUDGET,
            COMPUTE_BUDGET,
            TOKEN_PROGRAM,
            MEMO_PROGRAM,
        ]);
        expect(transferOf(msg)).toMatchObject({
            source: HOT,
            destination: COLD,
            authority: allowance.address,
            amount: 20_000_000n,
            decimals: 6,
        });
        expect(memoOf(msg)).toBe(`bugnet-cold ${row.id}`);
        expect((await db.pool.query("select state from x402_cold_transfers")).rows).toEqual([
            { state: "sent" },
        ]);
        expect(await runColdTransfer(deps(T0))).toMatchObject({
            sent: false,
            reason: "in_flight",
        });
    });

    it("a failed transfer to cold clears its ids", async () => {
        await verified(T0);
        const o = await share(20_000_000, later(-60_000));
        const k = await kept(4_000, later(-60_000));
        await runColdTransfer(deps(T0));
        const failing = rpc({ getSignatureStatuses: () => ({ value: [LANDED_FAILED] }) });
        expect(await advanceColdTransfers(deps(later(30_000), { rpc: failing }))).toMatchObject({
            failed: 1,
        });
        expect((await db.pool.query("select state from x402_cold_transfers")).rows).toEqual([
            { state: "failed" },
        ]);
        expect(alarms("x402_cold_transfer_failed")).toHaveLength(1);
        expect((await findOrder(db.pool, o.id))!.coldTransferId).toBeNull();
        expect((await findAccount(db.pool, k.id))!.keptColdTransferId).toBeNull();
        expect(await runColdTransfer(deps(later(31_000)))).toMatchObject({
            sent: true,
            amountMicros: 20_004_000,
        });
    });

    it("re-signed only after the 7.10 proof", async () => {
        await verified(T0);
        await share(20_000_000, later(-60_000));
        await runColdTransfer(deps(T0));
        const first = (
            await db.pool.query("select id, tx_signature, wire_tx from x402_cold_transfers")
        ).rows[0];
        await db.pool.query("update x402_cold_transfers set expiry_seen_slot = 1000");
        let blockhashes = 1;
        const atSend: Record<string, unknown>[] = [];
        const expired = rpc({
            getEpochInfo: () => epochAt(1_000n, 2_000n),
            getSignatureStatuses: (signatures: string[]) => ({
                context: { slot: 2_000n },
                value: signatures.map(() => null),
            }),
            getLatestBlockhash: () => ({
                context: { slot: 888n },
                value: {
                    blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(++blockhashes)),
                    lastValidBlockHeight: TEST_LVBH + 50n,
                },
            }),
            sendTransaction: async (wire: string) => {
                const row = (await db.pool.query("select * from x402_cold_transfers")).rows[0];
                atSend.push({ ...row, sentWire: wire });
                return row.tx_signature;
            },
        });
        await advanceVerified(db.pool, 1_299n, T0);
        expect(await advanceColdTransfers(deps(later(30_000), { rpc: expired }))).toMatchObject({
            resigned: 0,
        });
        await advanceVerified(db.pool, 1_300n, T0);
        expect(await advanceColdTransfers(deps(later(60_000), { rpc: expired }))).toMatchObject({
            resigned: 1,
        });
        expect(
            (
                await db.pool.query(
                    "select attempts, previous_signatures, expiry_seen_slot from x402_cold_transfers",
                )
            ).rows[0],
        ).toEqual({
            attempts: 2,
            previous_signatures: [first.tx_signature],
            expiry_seen_slot: null,
        });
        expect(atSend).toHaveLength(1);
        expect(atSend[0]).toMatchObject({ state: "signed", attempts: 2, signing_slot: "888" });
        expect(atSend[0]!.tx_signature).not.toBe(first.tx_signature);
        expect(atSend[0]!.wire_tx).not.toBe(first.wire_tx);
        expect(atSend[0]!.wire_tx).toBe(atSend[0]!.sentWire);
        await db.pool.query("update x402_cold_transfers set attempts = 3, expiry_seen_slot = 1000");
        expect(await advanceColdTransfers(deps(later(90_000), { rpc: expired }))).toMatchObject({
            failed: 1,
        });
    });

    it("a pause raised during the run stops the send, the row stays signed", async () => {
        await verified(T0);
        await share(20_000_000, later(-60_000));
        const pausing = rpc({
            getLatestBlockhash: async () => {
                await setControls(db.pool, { paused: true }, "test", T0);
                return {
                    context: { slot: 777n },
                    value: { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: TEST_LVBH },
                };
            },
        });
        await runColdTransfer(deps(T0, { rpc: pausing }));
        expect(pausing.calls.sendTransaction).toBe(0);
        expect((await db.pool.query("select state from x402_cold_transfers")).rows).toEqual([
            { state: "signed" },
        ]);
    });

    it("a pause blocks a re-sign", async () => {
        await verified(T0);
        await share(20_000_000, later(-60_000));
        await runColdTransfer(deps(T0));
        await db.pool.query("update x402_cold_transfers set expiry_seen_slot = 1000");
        await advanceVerified(db.pool, 1_300n, T0);
        await setControls(db.pool, { paused: true }, "test", T0);
        const expired = rpc({
            getEpochInfo: () => epochAt(1_000n, 2_000n),
            getSignatureStatuses: () => ({ context: { slot: 2_000n }, value: [null] }),
        });
        expect(await advanceColdTransfers(deps(later(60_000), { rpc: expired }))).toMatchObject({
            resigned: 0,
            failed: 0,
        });
        expect(expired.calls.getLatestBlockhash).toBe(0);
        expect(
            (await db.pool.query("select attempts from x402_cold_transfers")).rows[0].attempts,
        ).toBe(1);
    });
});

describe("advanceColdTransfers", () => {
    it("a landed transfer is confirmed", async () => {
        await verified(T0);
        await share(20_000_000, later(-60_000));
        await runColdTransfer(deps(T0));
        const landed = rpc({
            getSignatureStatuses: () => ({
                value: [{ confirmationStatus: "finalized", err: null, slot: 321n }],
            }),
        });
        expect(await advanceColdTransfers(deps(later(30_000), { rpc: landed }))).toMatchObject({
            confirmed: 1,
            failed: 0,
        });
        expect(
            (await db.pool.query("select state, landed_slot from x402_cold_transfers")).rows,
        ).toEqual([{ state: "confirmed", landed_slot: "321" }]);
    });

    it("a transfer not found before its blockhash expires is sent again as stored", async () => {
        await verified(T0);
        await share(20_000_000, later(-60_000));
        await runColdTransfer(deps(T0));
        const stored = (await db.pool.query("select wire_tx from x402_cold_transfers")).rows[0];
        const missing = rpc({
            getEpochInfo: () => epochAt(800n),
            getSignatureStatuses: () => ({ value: [null] }),
        });
        expect(await advanceColdTransfers(deps(later(30_000), { rpc: missing }))).toMatchObject({
            resent: 1,
            resigned: 0,
        });
        expect(missing.sent).toEqual([stored.wire_tx]);
        expect(
            (await db.pool.query("select state, attempts from x402_cold_transfers")).rows,
        ).toEqual([{ state: "sent", attempts: 1 }]);
    });

    it("a row another run already failed is not counted or alarmed", async () => {
        await verified(T0);
        await share(20_000_000, later(-60_000));
        await runColdTransfer(deps(T0));
        const failing = rpc({
            getSignatureStatuses: async () => {
                await db.pool.query("update x402_cold_transfers set state = 'failed'");
                return { value: [LANDED_FAILED] };
            },
        });
        expect(await advanceColdTransfers(deps(later(30_000), { rpc: failing }))).toMatchObject({
            failed: 0,
        });
        expect(alarms("x402_cold_transfer_failed")).toHaveLength(0);
    });
});

describe("runColdTransfer, races", () => {
    it("a refund and the transfer never both use one share", async () => {
        for (let i = 0; i < 20; i++) {
            await reset();
            await verified(T0);
            const o = await share(13_000, later(-3_600_000));
            const [partial, cold] = await Promise.all([
                writeHotPartial(db.pool, o.id, 8_000, T0, { log }),
                runColdTransfer(deps(T0)),
            ]);
            expect(partial).toBe("created");
            const row = (await findRefund(db.pool, o.id, "partial"))!;
            const order = (await findOrder(db.pool, o.id))!;
            if (row.fromWallet === "allowance") {
                expect(order.hotRouterRefundMicros).toBe(8_000);
                expect(cold.amountMicros).toBe(cold.sent ? 5_000 : 0);
            } else {
                expect(cold).toMatchObject({ sent: true, amountMicros: 13_000 });
                expect(order.hotRouterRefundMicros).toBe(0);
            }
        }
    });

    it("lock-order stress test", async () => {
        const funding = createAllowanceFunding({ x402: settings.x402, log });
        const closeDeps = (at: Date): CloseDeps => ({
            pool: db.pool,
            router: {
                lookupPlacement: async () => ({ kind: "unknown" }),
            } as unknown as RouterClient,
            funding,
            x402: settings.x402,
            orders: settings.orders,
            log,
            now: () => at,
        });
        async function stressFixture() {
            await reset();
            await verified(T0);
            const account = await seedAccount(db.pool, {
                state: "closing",
                closingAt: T0,
                fundedMicros: 1_000_000,
                heldMicros: 20_000,
            });
            await seedFunding(db.pool, {
                accountId: account.id,
                allowanceMicros: 1_000_000,
                payer: TEST_PAYTO,
                sourceTokenAccount: "1".repeat(32),
            });
            await db.pool.query("update x402_accounts set funded_micros = 1000000 where id = $1", [
                account.id,
            ]);
            await db.pool.query(
                "update x402_pool set committed_micros = 1000000, unpaid_micros = 100000",
            );
            const sig = randomBytes(32).toString("hex");
            const signed = await seedX402Payment(db.pool, {
                accountId: account.id,
                state: "signed",
                amountMicros: 10_000,
                txSignature: sig,
                signedAt: T0,
                createdAt: T0,
            });
            await seedX402Payment(db.pool, {
                accountId: account.id,
                state: "reserved",
                amountMicros: 10_000,
                createdAt: T0,
            });
            const { order: topUp } = await seedAllowanceOrder(db.pool, {
                state: "settling",
                handleSha256: account.handleSha256,
                allowanceMicros: 100_000,
                feeMicros: 0,
                amountMicros: 100_000,
            });
            await seedPayment(db.pool, topUp.id, { status: "settling" });
            const otherStart = await share(13_000, later(-3_600_000));
            await seedAccount(db.pool, {
                id: otherStart.id,
                state: "open",
                handleSha256: randomBytes(32).toString("hex"),
            });
            return { paymentId: signed.id, sig, topUp, otherStart };
        }
        const paidTransaction = (c: pg.PoolClient, topUp: OrderRow) =>
            (async () => {
                const payment = await lockPayment(c, topUp.id);
                const order = await lockOrder(c, topUp.id);
                if (payment === null || order === null) return;
                await confirmPayment(c, topUp.id, T0);
                await setOrderState(c, topUp.id, "settling", "paid");
                await onOrderPaid(
                    c,
                    { funding, x402: settings.x402, log },
                    { ...order, state: "paid" },
                    payment,
                    T0,
                );
            })();
        const dl = countDeadlocks(db.pool);
        try {
            for (let i = 0; i < 100; i++) {
                const f = await stressFixture();
                await Promise.all([
                    runCloseJob(closeDeps(T0)),
                    requestRefund(db.pool, f.otherStart.id, "router_refundable", {
                        funding,
                        at: T0,
                        log,
                    }),
                    runColdTransfer(deps(T0)),
                    runReleaseJob(db.pool, settings.x402, log, later(31_000)),
                    withTx(db.pool, (c) =>
                        resolveSigned(
                            c,
                            f.paymentId,
                            "confirmed",
                            { landedSlot: 150n, txSignature: f.sig },
                            T0,
                            settings.x402,
                            log,
                        ),
                    ),
                    withTx(db.pool, (c) => paidTransaction(c, f.topUp)),
                ]);
            }
        } finally {
            dl.restore();
        }
        expect(dl.count()).toBe(0);
    }, 120_000);
});
