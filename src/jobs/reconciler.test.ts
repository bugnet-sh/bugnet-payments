import { randomBytes } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../config.ts";
import { memoryLog, silentLog } from "../log.ts";
import {
    archivePayment,
    confirmPayment,
    findOrder,
    findPaymentByOrder,
    setOrderState,
} from "../orders/store.ts";
import type { OrderRow, PaymentRow } from "../orders/types.ts";
import { findRefund } from "../refunds/request.ts";
import { createRouterClient } from "../router/client.ts";
import { until } from "../testing/app.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { createFakeRpc, type FakeRpc } from "../testing/fake-rpc.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import { reconcileSettling, type ReconcileDeps } from "./reconciler.ts";
import { sweep } from "./sweeper.ts";

const MIN = 60_000;
const t0 = new Date("2030-01-01T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const PAYER = "6s69A41N2jAn8AymLgczY3TfrDQiHYc32MdQAw7RvtoB";

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
    return { pool: db.pool, rpc, log, now: () => now };
}

function newSignature(): string {
    return getBase58Decoder().decode(randomBytes(64));
}

// A settling order whose payment was recorded at recordedAt, before broadcast
async function settling(
    recordedAt: Date,
    over: { expiresAt?: Date; lastValidBlockHeight?: bigint } = {},
): Promise<{ order: OrderRow; payment: PaymentRow }> {
    const { order } = await seedOrder(db.pool, {
        state: "settling",
        payer: PAYER,
        createdAt: new Date(recordedAt.getTime() - MIN),
        expiresAt: over.expiresAt ?? new Date(recordedAt.getTime() + 14 * MIN),
    });
    const payment = await seedPayment(db.pool, order.id, {
        txSignature: newSignature(),
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
            getBlockHeight: (...args: unknown[]) => {
                heightCalls.push(args);
                return 900n;
            },
        });

        expect(await reconcileSettling(deps(rpc, t0))).toEqual({
            paid: 1,
            reverted: 0,
            waiting: 0,
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
            });
        }
        expect(rpc.calls.getSignatureStatuses).toBe(0);
        expect(rpc.calls.getBlockHeight).toBe(0);
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
            getBlockHeight: () => height,
        });

        expect(await reconcileSettling(deps(rpc, t0))).toEqual({
            paid: 0,
            reverted: 0,
            waiting: 1,
        });
        expect((await orderOf(order.id)).state).toBe("settling");
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({ status: "settling" });
        expect(await failedPayments(order.id)).toEqual([]);

        height = 1_001n;
        expect(await reconcileSettling(deps(rpc, at(10_000)))).toEqual({
            paid: 0,
            reverted: 1,
            waiting: 0,
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
            getBlockHeight: () => {
                landed = true;
                return 1_001n;
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

    it("expires instead of reopening an order past its expiry", async () => {
        const failed = await settling(at(-5 * MIN), { expiresAt: at(-MIN) });
        const vanished = await settling(at(-5 * MIN), { expiresAt: t0 });
        const rpc = createFakeRpc({
            getSignatureStatuses: (sigs: string[]) => ({
                value: sigs.map((s) => (s === failed.payment.txSignature ? LANDED_FAILED : null)),
            }),
            getBlockHeight: () => 1_001n,
        });

        expect(await reconcileSettling(deps(rpc, t0))).toEqual({
            paid: 0,
            reverted: 2,
            waiting: 0,
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

    it.each(["getSignatureStatuses", "getBlockHeight"] as const)(
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
            });
            expect((await orderOf(order.id)).state).toBe("settling");
            expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
                status: "settling",
            });
            expect(levels(log, "warn")).toEqual([expect.objectContaining({ orderId: order.id })]);
            expect(levels(log, "error")).toEqual([]);
        },
    );

    it.each([
        ["no error", null],
        ["an error", LANDED_FAILED.err],
    ])("keeps waiting on a processed-only status with %s", async (_, err) => {
        const { order } = await settling(at(-60_000));
        const rpc = createFakeRpc({
            getSignatureStatuses: () => ({
                value: [{ confirmationStatus: "processed", err, slot: 1n, confirmations: 0n }],
            }),
            getBlockHeight: () => 1_001n,
        });

        expect(await reconcileSettling(deps(rpc, t0))).toEqual({
            paid: 0,
            reverted: 0,
            waiting: 1,
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

        const orders: Settings["orders"] = {
            unpaid_ttl: 15 * MIN,
            unredeemed_refund_after: 30 * MIN,
            token_ttl: 10 * MIN,
            router_grace: 2 * MIN,
            max_amount_micros: 100_000_000,
            attempts_per_order_per_minute: 5,
            min_idempotency_key_length: 16,
        };
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
            orders,
            log: silentLog,
            now: () => later,
        });
        expect(Object.values(swept.refunds).every((n) => n === 0)).toBe(true);
        expect((await orderOf(order.id)).state).toBe("paid");
        expect(await findRefund(db.pool, order.id)).toBeNull();
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
    });

    it("waits for payOrder's confirmation on the payment row without a deadlock", async () => {
        const { order, payment } = await settling(at(-60_000));
        const confirmedAt = at(-1_000);
        const log = memoryLog();
        const other = await db.pool.connect();
        try {
            await other.query("begin");
            await confirmPayment(other, order.id, confirmedAt);
            const running = reconcileSettling(deps(createFakeRpc(), t0, log));
            await until(async () => (await lockWaiters()) === 1, 5_000);
            await setOrderState(other, order.id, "settling", "paid", {
                paidAt: payment.createdAt,
            });
            await other.query("commit");

            expect(await running).toEqual({ paid: 0, reverted: 0, waiting: 0 });
        } finally {
            await other.query("rollback").catch(() => undefined);
            other.release();
        }
        expect(levels(log, "error")).toEqual([]);
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

        expect(await reconcileSettling(deps(rpc, t0))).toEqual({
            paid: 0,
            reverted: 0,
            waiting: 0,
        });
        expect((await orderOf(order.id)).state).toBe("settling");
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            txSignature: next,
            status: "settling",
        });
        expect(await failedPayments(order.id)).toEqual([archivedAs(payment, "onchain_failed")]);
    });
});
