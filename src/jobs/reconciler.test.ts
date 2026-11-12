import { randomBytes } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../config.ts";
import { memoryLog, silentLog } from "../log.ts";
import {
    archivePayment,
    confirmPayment,
    findOrder,
    findPaymentByOrder,
    setOrderState,
} from "../orders/store.ts";
import type { OrderRow, PaymentRow } from "../orders/types.ts";
import { findOrderRefund } from "../refunds/request.ts";
import { createRouterClient } from "../router/client.ts";
import { until } from "../testing/app.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { createFakeRpc, epochAt, type FakeRpc, neverAnswers } from "../testing/fake-rpc.ts";
import { seedAllowanceOrder, seedOrder, seedPayment } from "../testing/orders.ts";
import { createAllowanceFunding } from "../x402/funding.ts";
import { readPool } from "../x402/ledger.ts";
import { seedAccount } from "../testing/x402.ts";
import { DepositKeys } from "../deposits/keys.ts";
import { ensureDeposit, findDeposit, updateDeposit } from "../deposits/store.ts";
import { reconcileSettling, type ReconcileDeps, type ReconcileReport } from "./reconciler.ts";
import { sweep } from "./sweeper.ts";

const MIN = 60_000;
const t0 = new Date("2030-01-01T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const PAYER = "6s69A41N2jAn8AymLgczY3TfrDQiHYc32MdQAw7RvtoB";
const RECIPIENT = "Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw";
const defaults = parseSettings(stringify({ solana: { recipient: RECIPIENT } }), "defaults");
const STALL_MS = 100;

const CONFIRMED = { confirmationStatus: "confirmed", err: null, slot: 1n, confirmations: 1n };
const LANDED_FAILED = {
    confirmationStatus: "confirmed",
    err: { InstructionError: [2, { Custom: 1 }] },
    slot: 1n,
    confirmations: 1n,
};
const notFound = () => ({ value: [null] });

let db: TestDb;

beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await db.pool.query("truncate orders cascade");
});

function deps(rpc: FakeRpc, now: Date, log: ReconcileDeps["log"] = silentLog): ReconcileDeps {
    return {
        pool: db.pool,
        rpc,
        rpcTimeoutMs: defaults.solana.rpc_timeout,
        log,
        now: () => now,
        paid: null,
        x402: defaults.x402,
        deposits: defaults.deposits,
    };
}

function newSignature(): string {
    return getBase58Decoder().decode(randomBytes(64));
}

// A settling order whose payment was recorded at recordedAt, before broadcast
async function settling(
    recordedAt: Date,
    over: { expiresAt?: Date; lastValidBlockHeight?: bigint; txSignature?: string } = {},
): Promise<{ order: OrderRow; payment: PaymentRow }> {
    const { order } = await seedOrder(db.pool, {
        state: "settling",
        payer: PAYER,
        createdAt: new Date(recordedAt.getTime() - MIN),
        expiresAt: over.expiresAt ?? new Date(recordedAt.getTime() + 14 * MIN),
    });
    const payment = await seedPayment(db.pool, order.id, {
        txSignature: over.txSignature ?? newSignature(),
        payer: PAYER,
        createdAt: recordedAt,
        lastValidBlockHeight: over.lastValidBlockHeight ?? 1_000n,
    });
    return { order, payment };
}

const orderOf = async (id: string) => (await findOrder(db.pool, id))!;

async function failedPayments(orderId: string) {
    const res = await db.pool.query(
        `select order_id, tx_signature, message_hash, payer, amount_micros::int, reason
         from failed_payments where order_id = $1 order by id`,
        [orderId],
    );
    return res.rows;
}

function archivedAs(payment: PaymentRow, reason: string) {
    return {
        order_id: payment.orderId,
        tx_signature: payment.txSignature,
        message_hash: payment.messageHash,
        payer: payment.payer,
        amount_micros: payment.amountMicros,
        reason,
    };
}

async function lockWaiters(): Promise<number> {
    const res = await db.pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
    );
    return res.rows[0]!.n;
}

const levels = (log: ReturnType<typeof memoryLog>, level: string) =>
    log.lines.filter((l) => l.level === level);

const changedLine = (orderId: string, signature: string) =>
    expect.objectContaining({
        msg: "settling order changed while its status was read, left as is",
        orderId,
        signature,
    });

describe("reconcileSettling", () => {
    it("finishes a payment that landed while the process was down", async () => {
        const { order, payment } = await settling(at(-60_000));
        const statusCalls: unknown[][] = [];
        const heightCalls: unknown[][] = [];
        const rpc = createFakeRpc({
            getSignatureStatuses: (...args: unknown[]) => {
                statusCalls.push(args);
                return { value: [CONFIRMED] };
            },
            getEpochInfo: (...args: unknown[]) => {
                heightCalls.push(args);
                return epochAt(900n);
            },
        });

        expect(await reconcileSettling(deps(rpc, t0))).toEqual({
            paid: 1,
            reverted: 0,
            waiting: 0,
            changed: 0,
        });
        expect(statusCalls).toEqual([[[payment.txSignature], { searchTransactionHistory: true }]]);
        expect(heightCalls).toEqual([[{ commitment: "finalized" }]]);
        expect(await orderOf(order.id)).toMatchObject({
            state: "paid",
            paidAt: payment.createdAt,
            payer: PAYER,
        });
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            status: "confirmed",
            confirmedAt: t0,
        });
        expect(await failedPayments(order.id)).toEqual([]);
    });

    it("skips a payment recorded less than 45 s ago", async () => {
        const { order, payment } = await settling(t0);
        const rpc = createFakeRpc();

        for (const now of [at(30_000), at(45_000)]) {
            expect(await reconcileSettling(deps(rpc, now))).toEqual({
                paid: 0,
                reverted: 0,
                waiting: 0,
                changed: 0,
            });
        }
        expect(rpc.calls.getSignatureStatuses).toBe(0);
        expect(rpc.calls.getEpochInfo).toBe(0);
        expect((await orderOf(order.id)).state).toBe("settling");

        expect((await reconcileSettling(deps(rpc, at(46_000)))).paid).toBe(1);
        expect(await orderOf(order.id)).toMatchObject({
            state: "paid",
            paidAt: payment.createdAt,
        });
    });

    it("returns an order to unpaid after a landed failure", async () => {
        const { order, payment } = await settling(at(-60_000));
        const rpc = createFakeRpc({ getSignatureStatuses: () => ({ value: [LANDED_FAILED] }) });

        expect(await reconcileSettling(deps(rpc, t0))).toEqual({
            paid: 0,
            reverted: 1,
            waiting: 0,
            changed: 0,
        });
        expect(await failedPayments(order.id)).toEqual([archivedAs(payment, "onchain_failed")]);
        expect(await orderOf(order.id)).toMatchObject({ state: "unpaid", paidAt: null });
        expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
    });

    it("returns an order to unpaid only after expiry and not found", async () => {
        const { order, payment } = await settling(at(-60_000), { lastValidBlockHeight: 1_000n });
        let height = 1_000n;
        const rpc = createFakeRpc({
            getSignatureStatuses: notFound,
            getEpochInfo: () => epochAt(height),
        });

        expect(await reconcileSettling(deps(rpc, t0))).toEqual({
            paid: 0,
            reverted: 0,
            waiting: 1,
            changed: 0,
        });
        expect((await orderOf(order.id)).state).toBe("settling");
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({ status: "settling" });
        expect(await failedPayments(order.id)).toEqual([]);

        height = 1_001n;
        expect(await reconcileSettling(deps(rpc, at(10_000)))).toEqual({
            paid: 0,
            reverted: 1,
            waiting: 0,
            changed: 0,
        });
        expect((await orderOf(order.id)).state).toBe("unpaid");
        expect(await failedPayments(order.id)).toEqual([archivedAs(payment, "blockhash_expired")]);
        expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
    });

    it("never reopens an order whose payment landed just before expiry", async () => {
        const { order, payment } = await settling(at(-60_000), { lastValidBlockHeight: 1_000n });
        // The transaction lands in block 1_000, so a status read before the height sees nothing
        let landed = false;
        const rpc = createFakeRpc({
            getEpochInfo: () => {
                landed = true;
                return epochAt(1_001n);
            },
            getSignatureStatuses: () => ({ value: [landed ? CONFIRMED : null] }),
        });

        expect((await reconcileSettling(deps(rpc, t0))).paid).toBe(1);
        expect(await orderOf(order.id)).toMatchObject({
            state: "paid",
            paidAt: payment.createdAt,
        });
        expect(await failedPayments(order.id)).toEqual([]);
    });

    it("keeps waiting on a missing status from a node behind the finalized slot", async () => {
        const { order } = await settling(at(-60_000), { lastValidBlockHeight: 1_000n });
        const rpc = createFakeRpc({
            getEpochInfo: () => epochAt(1_001n, 10_000n),
            getSignatureStatuses: () => ({ context: { slot: 9_967n }, value: [null] }),
        });

        expect((await reconcileSettling(deps(rpc, t0))).waiting).toBe(1);
        expect((await orderOf(order.id)).state).toBe("settling");
        expect(await failedPayments(order.id)).toEqual([]);
    });

    it("expires instead of reopening an order past its expiry", async () => {
        const failed = await settling(at(-5 * MIN), { expiresAt: at(-MIN) });
        const vanished = await settling(at(-5 * MIN), { expiresAt: t0 });
        const rpc = createFakeRpc({
            getSignatureStatuses: (sigs: string[]) => ({
                value: sigs.map((s) => (s === failed.payment.txSignature ? LANDED_FAILED : null)),
            }),
            getEpochInfo: () => epochAt(1_001n),
        });

        expect(await reconcileSettling(deps(rpc, t0))).toEqual({
            paid: 0,
            reverted: 2,
            waiting: 0,
            changed: 0,
        });
        expect((await orderOf(failed.order.id)).state).toBe("expired");
        expect((await orderOf(vanished.order.id)).state).toBe("expired");
        expect(await failedPayments(failed.order.id)).toEqual([
            archivedAs(failed.payment, "onchain_failed"),
        ]);
        expect(await failedPayments(vanished.order.id)).toEqual([
            archivedAs(vanished.payment, "blockhash_expired"),
        ]);
    });

    it.each(["getSignatureStatuses", "getEpochInfo"] as const)(
        "keeps waiting when the RPC fails (%s throws)",
        async (method) => {
            const { order } = await settling(at(-60_000));
            const rpc = createFakeRpc({
                [method]: () => {
                    throw new Error("rpc down");
                },
            });
            const log = memoryLog();

            expect(await reconcileSettling(deps(rpc, t0, log))).toEqual({
                paid: 0,
                reverted: 0,
                waiting: 1,
                changed: 0,
            });
            expect((await orderOf(order.id)).state).toBe("settling");
            expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
                status: "settling",
            });
            expect(levels(log, "warn")).toEqual([expect.objectContaining({ orderId: order.id })]);
            expect(levels(log, "error")).toEqual([]);
        },
    );

    it.each(["getEpochInfo", "getSignatureStatuses"] as const)(
        "gives up on a stalled %s within solana.rpc_timeout and changes nothing",
        async (method) => {
            const { order, payment } = await settling(at(-60_000));
            const rpc = createFakeRpc({ [method]: neverAnswers });
            const log = memoryLog();

            const started = performance.now();
            const report = await reconcileSettling({
                ...deps(rpc, t0, log),
                rpcTimeoutMs: STALL_MS,
            });
            expect(performance.now() - started).toBeLessThan(STALL_MS + 900);
            expect(report).toEqual({ paid: 0, reverted: 0, waiting: 1, changed: 0 });
            expect(await orderOf(order.id)).toEqual(order);
            expect(await findPaymentByOrder(db.pool, order.id)).toEqual(payment);
            expect(await failedPayments(order.id)).toEqual([]);
            expect(levels(log, "warn")).toEqual([
                expect.objectContaining({
                    msg: "signature status unavailable, retrying next run",
                    orderId: order.id,
                    err: expect.objectContaining({ name: "TimeoutError" }),
                }),
            ]);
        },
    );

    it.each([
        ["characters outside base58", "not-a-signature"],
        ["an address, which decodes to 32 bytes", PAYER],
    ])("reports a stored signature with %s once and leaves the order settling", async (_, bad) => {
        const { order, payment } = await settling(at(-60_000), { txSignature: bad });
        const rpc = createFakeRpc();
        const log = memoryLog();

        for (const now of [t0, at(10_000)]) {
            expect(await reconcileSettling(deps(rpc, now, log))).toEqual({
                paid: 0,
                reverted: 0,
                waiting: 1,
                changed: 0,
            });
        }
        expect(levels(log, "error")).toEqual([
            expect.objectContaining({
                msg: "stored payment signature is malformed, order left settling",
                orderId: order.id,
            }),
        ]);
        expect(levels(log, "warn")).toEqual([]);
        expect(rpc.calls.getEpochInfo).toBe(0);
        expect(rpc.calls.getSignatureStatuses).toBe(0);
        expect(await orderOf(order.id)).toEqual(order);
        expect(await findPaymentByOrder(db.pool, order.id)).toEqual(payment);
        expect(await failedPayments(order.id)).toEqual([]);
    });

    it.each([
        ["no error", null],
        ["an error", LANDED_FAILED.err],
    ])("keeps waiting on a processed-only status with %s", async (_, err) => {
        const { order } = await settling(at(-60_000));
        const rpc = createFakeRpc({
            getSignatureStatuses: () => ({
                value: [{ confirmationStatus: "processed", err, slot: 1n, confirmations: 0n }],
            }),
            getEpochInfo: () => epochAt(1_001n),
        });

        expect(await reconcileSettling(deps(rpc, t0))).toEqual({
            paid: 0,
            reverted: 0,
            waiting: 1,
            changed: 0,
        });
        expect((await orderOf(order.id)).state).toBe("settling");
        expect(await failedPayments(order.id)).toEqual([]);
    });

    it("dates paid_at by the record time, so a payment recorded in time is not late", async () => {
        const { order, payment } = await settling(at(-10_000), { expiresAt: t0 });
        const later = at(5 * MIN);

        expect((await reconcileSettling(deps(createFakeRpc(), later))).paid).toBe(1);
        const paid = await orderOf(order.id);
        expect(paid.paidAt).toEqual(payment.createdAt);
        expect(paid.paidAt!.getTime()).toBeLessThanOrEqual(paid.expiresAt.getTime());

        const swept = await sweep({
            pool: db.pool,
            router: createRouterClient({
                url: "http://127.0.0.1:9",
                token: "rt",
                timeoutMs: 1_000,
                checkPayer: false,
                getOrder: false,
                log: silentLog,
            }),
            orders: defaults.orders,
            funding: null,
            x402: defaults.x402,
            log: silentLog,
            now: () => later,
            unavailableAlarmed: new Set(),
        });
        expect(Object.values(swept.refunds).every((n) => n === 0)).toBe(true);
        expect((await orderOf(order.id)).state).toBe("paid");
        expect(await findOrderRefund(db.pool, order.id)).toBeNull();
    });
});

describe("a confirmed payment under a settling order", () => {
    async function confirmedUnderSettling() {
        const { order, payment } = await settling(at(-60_000));
        await confirmPayment(db.pool, order.id, at(-30_000));
        return { order, payment };
    }

    it("marks the order paid and keeps the first confirmation time", async () => {
        const { order, payment } = await confirmedUnderSettling();

        expect((await reconcileSettling(deps(createFakeRpc(), t0))).paid).toBe(1);
        expect(await orderOf(order.id)).toMatchObject({
            state: "paid",
            paidAt: payment.createdAt,
        });
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            confirmedAt: at(-30_000),
        });
    });

    it("never reopens the order when the chain reports a failure", async () => {
        const { order } = await confirmedUnderSettling();
        const rpc = createFakeRpc({ getSignatureStatuses: () => ({ value: [LANDED_FAILED] }) });
        const log = memoryLog();

        expect(await reconcileSettling(deps(rpc, t0, log))).toEqual({
            paid: 0,
            reverted: 0,
            waiting: 1,
            changed: 0,
        });
        expect((await orderOf(order.id)).state).toBe("settling");
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({ status: "confirmed" });
        expect(await failedPayments(order.id)).toEqual([]);
        expect(levels(log, "error")).toEqual([expect.objectContaining({ orderId: order.id })]);
    });
});

describe("racing payOrder", () => {
    it("leaves an order that payOrder marked paid while the status was read", async () => {
        const { order, payment } = await settling(at(-60_000));
        const confirmedAt = at(-20_000);
        const rpc = createFakeRpc({
            getSignatureStatuses: async () => {
                await confirmPayment(db.pool, order.id, confirmedAt);
                await setOrderState(db.pool, order.id, "settling", "paid", {
                    paidAt: payment.createdAt,
                });
                return { value: [CONFIRMED] };
            },
        });
        const log = memoryLog();

        expect(await reconcileSettling(deps(rpc, t0, log))).toEqual({
            paid: 0,
            reverted: 0,
            waiting: 0,
            changed: 1,
        });
        expect(await orderOf(order.id)).toMatchObject({
            state: "paid",
            paidAt: payment.createdAt,
        });
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            status: "confirmed",
            confirmedAt,
        });
        expect(levels(log, "error")).toEqual([]);
        expect(levels(log, "info")).toEqual([changedLine(order.id, payment.txSignature)]);
    });

    it("waits for payOrder's confirmation on the payment row without a deadlock", async () => {
        const { order, payment } = await settling(at(-60_000));
        const confirmedAt = at(-1_000);
        const log = memoryLog();
        const other = await db.pool.connect();
        let running: Promise<ReconcileReport> | undefined;
        try {
            await other.query("begin");
            await confirmPayment(other, order.id, confirmedAt);
            running = reconcileSettling(deps(createFakeRpc(), t0, log));
            await until(async () => (await lockWaiters()) === 1, 5_000);
            await setOrderState(other, order.id, "settling", "paid", {
                paidAt: payment.createdAt,
            });
            await other.query("commit");
        } catch (err) {
            await other.query("rollback").catch(() => undefined);
            throw err;
        } finally {
            other.release();
        }

        expect(await running).toEqual({ paid: 0, reverted: 0, waiting: 0, changed: 1 });
        expect(levels(log, "error")).toEqual([]);
        expect(levels(log, "info")).toEqual([changedLine(order.id, payment.txSignature)]);
        expect(await orderOf(order.id)).toMatchObject({
            state: "paid",
            paidAt: payment.createdAt,
        });
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({ confirmedAt });
    });

    it("never applies a status to a payment that replaced the one it read", async () => {
        const { order, payment } = await settling(at(-60_000));
        const next = newSignature();
        const rpc = createFakeRpc({
            // Another reconciler reopens the order and a second payer records a new payment
            getSignatureStatuses: async () => {
                await archivePayment(db.pool, order.id, "onchain_failed");
                await setOrderState(db.pool, order.id, "settling", "unpaid");
                await seedPayment(db.pool, order.id, { txSignature: next, createdAt: at(-1_000) });
                await setOrderState(db.pool, order.id, "unpaid", "settling");
                return { value: [LANDED_FAILED] };
            },
        });
        const log = memoryLog();

        expect(await reconcileSettling(deps(rpc, t0, log))).toEqual({
            paid: 0,
            reverted: 0,
            waiting: 0,
            changed: 1,
        });
        expect(levels(log, "info")).toEqual([changedLine(order.id, payment.txSignature)]);
        expect((await orderOf(order.id)).state).toBe("settling");
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            txSignature: next,
            status: "settling",
        });
        expect(await failedPayments(order.id)).toEqual([archivedAs(payment, "onchain_failed")]);
    });
});

describe("a settling hot order", () => {
    const X = defaults.x402;
    const paidDeps = {
        funding: createAllowanceFunding({ x402: X, log: silentLog }),
        x402: X,
        log: silentLog,
    };
    const landedRpc = () =>
        createFakeRpc({
            getSignatureStatuses: () => ({ value: [CONFIRMED] }),
            getEpochInfo: () => epochAt(900n),
        });
    let hot: OrderRow;

    beforeEach(async () => {
        await db.pool.query(
            "update x402_pool set committed_micros = 0, unpaid_micros = 1000000 where id = 1",
        );
        const account = await seedAccount(db.pool);
        ({ order: hot } = await seedAllowanceOrder(db.pool, {
            state: "settling",
            payer: PAYER,
            handleSha256: account.handleSha256,
            createdAt: at(-2 * MIN),
            expiresAt: at(13 * MIN),
        }));
        await seedPayment(db.pool, hot.id, {
            txSignature: newSignature(),
            payer: PAYER,
            createdAt: at(-46_000),
        });
    });
    afterEach(async () => {
        await db.pool.query("update x402_pool set committed_micros = 0, unpaid_micros = 0");
    });

    const fundings = async () =>
        (
            await db.pool.query<{ n: number }>(
                "select count(*)::int as n from x402_fundings where order_id = $1",
                [hot.id],
            )
        ).rows[0]!.n;

    it("funds a settling hot order whose payment landed", async () => {
        expect(await reconcileSettling({ ...deps(landedRpc(), t0), paid: paidDeps })).toMatchObject(
            { paid: 1 },
        );
        expect(await fundings()).toBe(1);
        expect(await orderOf(hot.id)).toMatchObject({ state: "redeemed", paidAt: at(-46_000) });
    });

    it("creates the account and funds a settling hot START order, which stays paid", async () => {
        const { order: start } = await seedAllowanceOrder(db.pool, {
            kind: "start",
            state: "settling",
            packageId: "cpu-small",
            handleSha256: null,
            payer: PAYER,
            createdAt: at(-2 * MIN),
            expiresAt: at(13 * MIN),
        });
        await seedPayment(db.pool, start.id, {
            txSignature: newSignature(),
            payer: PAYER,
            createdAt: at(-46_000),
        });
        await db.pool.query("update x402_pool set unpaid_micros = 3000000 where id = 1");
        await reconcileSettling({ ...deps(landedRpc(), t0), paid: paidDeps });
        expect(await orderOf(start.id)).toMatchObject({ state: "paid", paidAt: at(-46_000) });
        const accounts = await db.pool.query<{ state: string; funded: number }>(
            "select state, funded_micros::int as funded from x402_accounts where id = $1",
            [start.id],
        );
        expect(accounts.rows).toEqual([{ state: "open", funded: start.allowanceMicros }]);
        const funded = await db.pool.query<{ n: number }>(
            "select count(*)::int as n from x402_fundings where order_id = $1",
            [start.id],
        );
        expect(funded.rows[0]!.n).toBe(1);
    });

    it("rolls back when onOrderPaid throws and funds on the next run", async () => {
        const broken = {
            ...paidDeps,
            funding: { ...paidDeps.funding, fund: () => Promise.reject(new Error("boom")) },
        };
        const rpc = landedRpc();
        expect(await reconcileSettling({ ...deps(rpc, t0), paid: broken })).toMatchObject({
            paid: 0,
            waiting: 1,
        });
        expect((await orderOf(hot.id)).state).toBe("settling");
        expect((await findPaymentByOrder(db.pool, hot.id))!.status).toBe("settling");
        expect(await fundings()).toBe(0);
        expect(await reconcileSettling({ ...deps(rpc, t0), paid: paidDeps })).toMatchObject({
            paid: 1,
        });
    });

    it("leaves a hot order settling when no PaidDeps are given", async () => {
        const log = memoryLog();
        expect(await reconcileSettling(deps(landedRpc(), t0, log))).toMatchObject({
            paid: 0,
            waiting: 1,
        });
        expect((await orderOf(hot.id)).state).toBe("settling");
        expect(JSON.stringify(levels(log, "error"))).toContain(
            `hot order ${hot.id} needs PaidDeps`,
        );
    });
});

describe("a settling hot order and the pool", () => {
    const X = defaults.x402;
    const paidDeps = {
        funding: createAllowanceFunding({ x402: X, log: silentLog }),
        x402: X,
        log: silentLog,
    };

    async function hotSettling(recordedAt: Date, over: Partial<OrderRow> = {}) {
        const { order } = await seedAllowanceOrder(db.pool, {
            state: "settling",
            payer: PAYER,
            createdAt: new Date(recordedAt.getTime() - MIN),
            expiresAt: new Date(recordedAt.getTime() + 4 * MIN),
            ...over,
        });
        await seedAccount(db.pool, { handleSha256: order.handleSha256 });
        const payment = await seedPayment(db.pool, order.id, {
            txSignature: newSignature(),
            payer: PAYER,
            createdAt: recordedAt,
            lastValidBlockHeight: 1_000n,
        });
        await db.pool.query(
            "update x402_pool set unpaid_micros = 1000000, committed_micros = 0 where id = 1",
        );
        return { order, payment };
    }
    afterEach(async () => {
        await db.pool.query("update x402_pool set committed_micros = 0, unpaid_micros = 0");
    });

    it("reconciler settling to expired lowers unpaid", async () => {
        const { order } = await hotSettling(at(-10 * MIN));
        const rpc = createFakeRpc({
            getEpochInfo: () => epochAt(1_001n),
            getSignatureStatuses: notFound,
        });
        expect((await reconcileSettling(deps(rpc, t0))).reverted).toBe(1);
        expect((await orderOf(order.id)).state).toBe("expired");
        expect((await readPool(db.pool)).unpaidMicros).toBe(0);
    });

    it("reconciler settling to unpaid keeps unpaid", async () => {
        const { order } = await hotSettling(at(-MIN), { expiresAt: at(4 * MIN) });
        const rpc = createFakeRpc({
            getEpochInfo: () => epochAt(1_001n),
            getSignatureStatuses: notFound,
        });
        await reconcileSettling(deps(rpc, t0));
        expect((await orderOf(order.id)).state).toBe("unpaid");
        expect((await readPool(db.pool)).unpaidMicros).toBe(1_000_000);
    });

    it("reconciler records landed_slot of a hot order payment and not of a cold one", async () => {
        const { order } = await hotSettling(at(-MIN));
        const slotRpc = (slot: bigint) =>
            createFakeRpc({ getSignatureStatuses: () => ({ value: [{ ...CONFIRMED, slot }] }) });
        expect((await reconcileSettling({ ...deps(slotRpc(555n), t0), paid: paidDeps })).paid).toBe(
            1,
        );
        expect((await findPaymentByOrder(db.pool, order.id))!.landedSlot).toBe(555n);
        const cold = await settling(at(-MIN));
        await reconcileSettling(deps(slotRpc(556n), t0));
        expect((await findPaymentByOrder(db.pool, cold.order.id))!.landedSlot).toBeNull();
    });
});

describe("orders with a deposit", () => {
    const keys = new DepositKeys(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const clock = (hhmmss: string) => new Date(`2030-01-01T${hhmmss}Z`);
    const EXPIRES = clock("00:15:00");

    afterEach(async () => {
        await db.pool.query("update x402_pool set committed_micros = 0, unpaid_micros = 0");
    });

    // An order created at 00:00 with its deposit, then settling through a payment recorded then
    async function settlingWithDeposit(recordedAt: Date, o: { allowance?: boolean } = {}) {
        const fields = {
            state: "unpaid" as const,
            payer: PAYER,
            createdAt: t0,
            expiresAt: EXPIRES,
        };
        const { order } = o.allowance
            ? await seedAllowanceOrder(db.pool, fields)
            : await seedOrder(db.pool, { amountMicros: 50_000, ...fields });
        await ensureDeposit(db.pool, keys, order, t0, () => Buffer.alloc(16, 1));
        await db.pool.query("update orders set state = 'settling' where id = $1", [order.id]);
        const payment = await seedPayment(db.pool, order.id, {
            txSignature: newSignature(),
            payer: PAYER,
            createdAt: recordedAt,
            lastValidBlockHeight: 1_000n,
        });
        return { order, payment };
    }

    const expiredRpc = () =>
        createFakeRpc({ getEpochInfo: () => epochAt(1_001n), getSignatureStatuses: notFound });

    it("an x402 failure after the deadline reverts to unpaid when a deposit is live", async () => {
        const { order } = await settlingWithDeposit(clock("00:14:50"), { allowance: true });
        await db.pool.query("update x402_pool set unpaid_micros = 1000000 where id = 1");

        expect((await reconcileSettling(deps(expiredRpc(), clock("00:16:30")))).reverted).toBe(1);
        expect((await orderOf(order.id)).state).toBe("unpaid");
        expect((await findDeposit(db.pool, order.id))!.hardStopAt).toEqual(clock("00:21:30"));
        expect((await readPool(db.pool)).unpaidMicros).toBe(1_000_000);
    });

    it("without a live deposit the order expires as before", async () => {
        const { order } = await settlingWithDeposit(clock("00:14:50"), { allowance: true });
        await updateDeposit(db.pool, order.id, { state: "done" });
        await db.pool.query("update x402_pool set unpaid_micros = 1000000 where id = 1");

        expect((await reconcileSettling(deps(expiredRpc(), clock("00:16:30")))).reverted).toBe(1);
        expect((await orderOf(order.id)).state).toBe("expired");
        expect((await findDeposit(db.pool, order.id))!.hardStopAt).toBeNull();
        expect((await readPool(db.pool)).unpaidMicros).toBe(0);
    });

    it("the reconciler leaves transfer orders", async () => {
        const { order } = await settlingWithDeposit(clock("00:05:00"));
        await db.pool.query("update orders set paid_via = 'transfer' where id = $1", [order.id]);
        const rpc = expiredRpc();

        expect(await reconcileSettling(deps(rpc, clock("00:06:00")))).toEqual({
            paid: 0,
            reverted: 0,
            waiting: 0,
            changed: 0,
        });
        expect(rpc.calls.getSignatureStatuses ?? 0).toBe(0);
        expect((await orderOf(order.id)).state).toBe("settling");
    });
});
