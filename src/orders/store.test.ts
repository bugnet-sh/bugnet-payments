import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTx } from "../db/pool.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedAllowanceOrder, seedOrder, seedPayment } from "../testing/orders.ts";
import {
    archivePayment,
    confirmPayment,
    findOrder,
    findOrderByIdempotencyKey,
    findPaymentByOrder,
    IllegalTransitionError,
    insertOrder,
    insertPayment,
    lockOrder,
    lockOrders,
    lockPayment,
    markEventSeen,
    setOrderState,
    setPaymentLandedSlot,
    StaleStateError,
    updateOrderFields,
} from "./store.ts";
import { ALLOWED_TRANSITIONS } from "./types.ts";
import type { StoredPin, StoredX402Setup } from "../x402/types.ts";
import { newOrderId } from "./ids.ts";

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

describe("order store", () => {
    it("pins the transition table", () => {
        expect(ALLOWED_TRANSITIONS).toEqual({
            unpaid: ["settling", "expired"],
            settling: ["paid", "unpaid", "expired"],
            paid: ["redeemed", "refunding", "manual"],
            redeemed: ["refunding", "manual"],
            refunding: ["refunded", "manual"],
            manual: ["refunding", "refunded", "redeemed"],
            refunded: [],
            expired: [],
        });
    });

    it("inserts and finds an order by id and idempotency key", async () => {
        const seeded = (await seedOrder(db.pool)).order;
        const id = newOrderId();
        const inserted = await insertOrder(db.pool, {
            id,
            kind: "extend",
            packageId: "pkg-x",
            amountMicros: 25_000,
            handleSha256: "a".repeat(64),
            description: "extend",
            claimSha256: seeded.claimSha256,
            claimBox: Buffer.alloc(60, 1),
            idempotencyKey: "key-1",
            expiresAt: new Date("2026-11-06T12:15:00Z"),
            payInto: "cold",
            allowanceMicros: 0,
            feeMicros: 0,
            x402Setup: null,
        });
        expect(inserted).toMatchObject({ id, state: "unpaid", kind: "extend", paidAt: null });
        expect(await findOrder(db.pool, id)).toEqual(inserted);
        expect(await findOrderByIdempotencyKey(db.pool, "key-1")).toEqual(inserted);
        expect(await findOrderByIdempotencyKey(db.pool, "nope")).toBeNull();
        expect(await findOrder(db.pool, "ord_zzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
    });

    it("updates fields without a state change", async () => {
        const { order } = await seedOrder(db.pool, { state: "redeemed" });
        const at = new Date("2026-11-06T12:00:00Z");
        expect(
            await updateOrderFields(db.pool, order.id, { abandonReason: "denied", abandonAt: at }),
        ).toBe(true);
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "redeemed",
            abandonReason: "denied",
            abandonAt: at,
        });
        expect(
            await updateOrderFields(db.pool, "ord_zzzzzzzzzzzzzzzzzzzzzzzzzz", { abandonAt: at }),
        ).toBe(false);
    });

    it("markEventSeen keeps the first time", async () => {
        const { order } = await seedOrder(db.pool, { state: "redeemed" });
        await markEventSeen(db.pool, order.id, new Date("2026-11-06T12:00:00Z"));
        await markEventSeen(db.pool, order.id, new Date("2026-11-06T12:05:00Z"));
        expect((await findOrder(db.pool, order.id))!.eventSeenAt).toEqual(
            new Date("2026-11-06T12:00:00Z"),
        );
    });

    it("refuses an illegal and a stale transition", async () => {
        const { order } = await seedOrder(db.pool);
        await expect(setOrderState(db.pool, order.id, "unpaid", "paid")).rejects.toBeInstanceOf(
            IllegalTransitionError,
        );
        await expect(setOrderState(db.pool, order.id, "paid", "redeemed")).rejects.toBeInstanceOf(
            StaleStateError,
        );
        expect((await findOrder(db.pool, order.id))!.state).toBe("unpaid");
    });

    it("writes the fields given with a transition", async () => {
        const { order } = await seedOrder(db.pool, { state: "settling" });
        const at = new Date("2026-11-06T12:00:00Z");
        await setOrderState(db.pool, order.id, "settling", "paid", { paidAt: at, payer: "wallet" });
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "paid",
            paidAt: at,
            payer: "wallet",
        });
    });

    it("drops the claim seal when the order leaves unpaid", async () => {
        const { order } = await seedOrder(db.pool, { claimBox: Buffer.alloc(60) });
        await setOrderState(db.pool, order.id, "unpaid", "settling");
        expect((await findOrder(db.pool, order.id))!.claimBox).toBeNull();
    });

    it("lockOrder blocks a second locker", async () => {
        const { order } = await seedOrder(db.pool);
        const a = await db.pool.connect();
        const b = await db.pool.connect();
        try {
            await a.query("begin");
            expect((await lockOrder(a, order.id))!.id).toBe(order.id);
            await b.query("begin");
            await b.query("set local lock_timeout = '200ms'");
            await expect(lockOrder(b, order.id)).rejects.toMatchObject({ code: "55P03" });
        } finally {
            await b.query("rollback").catch(() => undefined);
            await a.query("rollback").catch(() => undefined);
            a.release();
            b.release();
        }
        await withTx(db.pool, async (c) => {
            expect(await lockOrder(c, "ord_zzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
        });
    });

    it("lockPayment returns the payment and blocks a second locker", async () => {
        const { order } = await seedOrder(db.pool, { state: "settling" });
        const payment = await seedPayment(db.pool, order.id);
        const a = await db.pool.connect();
        const b = await db.pool.connect();
        try {
            await a.query("begin");
            expect(await lockPayment(a, order.id)).toEqual(payment);
            await b.query("begin");
            await b.query("set local lock_timeout = '200ms'");
            await expect(lockPayment(b, order.id)).rejects.toMatchObject({ code: "55P03" });
        } finally {
            await b.query("rollback").catch(() => undefined);
            await a.query("rollback").catch(() => undefined);
            a.release();
            b.release();
        }
        const unpaid = await seedOrder(db.pool);
        await withTx(db.pool, async (c) => {
            expect(await lockPayment(c, unpaid.order.id)).toBeNull();
        });
    });

    it("confirms a payment", async () => {
        const { order } = await seedOrder(db.pool, { state: "settling" });
        await seedPayment(db.pool, order.id);
        const at = new Date("2026-11-06T12:00:00Z");
        await confirmPayment(db.pool, order.id, at);
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            status: "confirmed",
            confirmedAt: at,
        });
    });

    it("confirmPayment is idempotent and reports whether a row changed", async () => {
        const { order } = await seedOrder(db.pool, { state: "settling" });
        await seedPayment(db.pool, order.id);
        const first = new Date("2026-11-06T12:00:00Z");
        expect(await confirmPayment(db.pool, order.id, first)).toBe(true);
        expect(await confirmPayment(db.pool, order.id, new Date("2026-11-06T13:00:00Z"))).toBe(
            false,
        );
        expect((await findPaymentByOrder(db.pool, order.id))?.confirmedAt).toEqual(first);
        expect(await confirmPayment(db.pool, newOrderId(), first)).toBe(false);
    });

    it("archivePayment leaves a confirmed payment untouched", async () => {
        const { order } = await seedOrder(db.pool, { state: "settling" });
        await seedPayment(db.pool, order.id);
        await confirmPayment(db.pool, order.id, new Date());
        expect(await archivePayment(db.pool, order.id, "onchain_failed")).toBe(false);
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({ status: "confirmed" });
        expect((await findOrder(db.pool, order.id))?.state).toBe("settling");
        const failed = await db.pool.query("select 1 from failed_payments where order_id = $1", [
            order.id,
        ]);
        expect(failed.rowCount).toBe(0);
    });

    it("archivePayment frees the order for a new payment", async () => {
        const { order } = await seedOrder(db.pool, { state: "settling" });
        const first = await seedPayment(db.pool, order.id);
        expect(await archivePayment(db.pool, order.id, "blockhash_expired")).toBe(true);
        expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
        const failed = await db.pool.query(
            "select tx_signature, reason from failed_payments where order_id = $1",
            [order.id],
        );
        expect(failed.rows).toEqual([
            { tx_signature: first.txSignature, reason: "blockhash_expired" },
        ]);
        await seedPayment(db.pool, order.id);
    });

    it("round-trips amounts and block heights", async () => {
        const { order } = await seedOrder(db.pool, { state: "settling" });
        expect(order.amountMicros).toBe(10_000);
        const p = await seedPayment(db.pool, order.id, { lastValidBlockHeight: 400_000_123n });
        expect(p.lastValidBlockHeight).toBe(400_000_123n);
        expect(p.amountMicros).toBe(10_000);
        const second = await seedOrder(db.pool, { state: "settling" });
        await insertPayment(db.pool, {
            orderId: second.order.id,
            txSignature: "sig",
            messageHash: "hash",
            payer: "p",
            sourceTokenAccount: "s",
            amountMicros: 10_000,
            blockhash: "b",
            lastValidBlockHeight: 2n ** 40n,
            createdAt: new Date("2026-11-06T12:00:00Z"),
        });
        expect(await findPaymentByOrder(db.pool, second.order.id)).toMatchObject({
            status: "settling",
            confirmedAt: null,
            lastValidBlockHeight: 2n ** 40n,
            createdAt: new Date("2026-11-06T12:00:00Z"),
        });
    });
});

const PIN: StoredPin = {
    serviceId: "xs_w5a4htopmpzmmhos",
    method: "POST",
    host: "agent402.tools",
    prefix: "/v1/auto/",
    url: "https://agent402.tools/v1/auto/chat/completions",
    maxPriceMicros: 10_000,
    payTo: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    listed: "indexed",
    paidPath: null,
    pinnedFrom: "probe",
    probe: {
        at: "2026-11-07T10:00:00.000Z",
        status: 402,
        accepted: { scheme: "exact", amount: "10000" },
    },
    newPin: true,
};

describe("x402 order columns", () => {
    it("stores and reads every new order column", async () => {
        const seeded = (await seedOrder(db.pool)).order;
        const setup: StoredX402Setup = {
            services: [PIN],
            disable: [],
            spendPerMinuteMicros: 2_000_000,
        };
        const inserted = await insertOrder(db.pool, {
            id: newOrderId(),
            kind: "start",
            packageId: "cpu-small",
            amountMicros: 1_013_000,
            handleSha256: null,
            description: "start",
            claimSha256: seeded.claimSha256,
            claimBox: null,
            idempotencyKey: null,
            expiresAt: new Date("2026-11-07T12:05:00Z"),
            payInto: "allowance",
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            x402Setup: setup,
        });
        expect(inserted).toMatchObject({
            payInto: "allowance",
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            amountMicros: 1_013_000,
            x402Refusal: null,
            coldTransferId: null,
            hotRouterRefundMicros: 0,
        });
        expect(inserted.x402Setup).toEqual(setup);
        expect(await findOrder(db.pool, inserted.id)).toEqual(inserted);
    });

    it("writes x402Refusal with a transition", async () => {
        const { order } = await seedAllowanceOrder(db.pool, { state: "paid" });
        await setOrderState(db.pool, order.id, "paid", "refunding", {
            x402Refusal: "allowance_ceiling",
        });
        expect((await findOrder(db.pool, order.id))!.x402Refusal).toBe("allowance_ceiling");
    });

    it("lockOrder never blocks a foreign-key insert", async () => {
        const { order } = await seedOrder(db.pool);
        const a = await db.pool.connect();
        const b = await db.pool.connect();
        try {
            await a.query("begin");
            await lockOrder(a, order.id);
            await b.query("begin");
            await b.query("set local lock_timeout = '1000ms'");
            await expect(
                b.query(
                    `insert into refunds (order_id, kind, reason, amount_micros, destination, payer,
                        state) values ($1, 'full', 'late', 1000, 'dest', 'payer', 'pending')`,
                    [order.id],
                ),
            ).resolves.toMatchObject({ rowCount: 1 });
            await b.query("commit");
            await a.query("commit");
        } finally {
            await b.query("rollback").catch(() => undefined);
            await a.query("rollback").catch(() => undefined);
            a.release();
            b.release();
        }
    });

    it("lockOrders returns rows in id order", async () => {
        const ids = await Promise.all(
            [1, 2, 3].map(async () => (await seedOrder(db.pool)).order.id),
        );
        const rows = await withTx(db.pool, (c) =>
            lockOrders(c, [...ids].reverse().concat("ord_zzzzzzzzzzzzzzzzzzzzzzzzzz")),
        );
        expect(rows.map((r) => r.id)).toEqual([...ids].sort());
    });

    it("setPaymentLandedSlot writes once", async () => {
        const { order } = await seedOrder(db.pool, { state: "settling" });
        expect((await seedPayment(db.pool, order.id)).landedSlot).toBeNull();
        expect(await setPaymentLandedSlot(db.pool, order.id, 100n)).toBe(true);
        expect(await setPaymentLandedSlot(db.pool, order.id, 200n)).toBe(false);
        expect((await findPaymentByOrder(db.pool, order.id))!.landedSlot).toBe(100n);
    });

    it("seedAllowanceOrder seeds a hot allowance order", async () => {
        const { order } = await seedAllowanceOrder(db.pool);
        expect(order).toMatchObject({
            kind: "allowance",
            packageId: "x402-allowance",
            handleSha256: "ab".repeat(32),
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            amountMicros: 1_003_000,
            payInto: "allowance",
            x402Setup: { services: [], disable: [], spendPerMinuteMicros: null },
        });
    });
});
