import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findOrder } from "../orders/store.ts";
import type { OrderRow, PaymentRow } from "../orders/types.ts";
import { usdcAta } from "../solana/accounts.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { testSigner } from "../testing/keys.ts";
import { seedOrder, seedPayment, seedSharedPayment } from "../testing/orders.ts";
import { findOrderRefund, refundGroup, requestRefund, returnManualToRedeemed } from "./request.ts";

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

async function paidOrder(
    state: OrderRow["state"],
    over: Partial<OrderRow> = {},
): Promise<{ order: OrderRow; payment: PaymentRow }> {
    const { order } = await seedOrder(db.pool, { state, ...over });
    const payment = await seedPayment(db.pool, order.id, {
        status: "confirmed",
        payer: "payer-a",
        sourceTokenAccount: "source-a",
    });
    return { order, payment };
}

async function countRefunds(orderId: string): Promise<number> {
    const res = await db.pool.query("select count(*)::int as n from refunds where order_id = $1", [
        orderId,
    ]);
    return res.rows[0].n;
}

describe("requestRefund", () => {
    it("refunds a paid order once, for the paid amount, to the payment source", async () => {
        const { order: paid, payment } = await paidOrder("paid");
        expect(await requestRefund(db.pool, paid.id, "unredeemed")).toBe("created");
        expect(await findOrderRefund(db.pool, paid.id)).toMatchObject({
            kind: "full",
            part: 0,
            reason: "unredeemed",
            amountMicros: 10_000,
            destination: payment.sourceTokenAccount,
            payer: payment.payer,
            state: "pending",
            fromWallet: "refund",
            signedAt: null,
            txSignature: null,
            attempts: 0,
        });
        expect((await findOrder(db.pool, paid.id))!.state).toBe("refunding");
    });

    it("refunds to the wallet that paid, not to the order's creator", async () => {
        const stranger = await testSigner(3);
        const { order } = await seedOrder(db.pool, { state: "redeemed", payer: "creator-wallet" });
        await seedPayment(db.pool, order.id, {
            payer: stranger.address,
            sourceTokenAccount: await usdcAta(stranger.address),
        });
        await requestRefund(db.pool, order.id, "router_refundable");
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            payer: stranger.address,
            destination: await usdcAta(stranger.address),
        });
    });

    it("creates exactly one refund when two triggers race", async () => {
        const { order } = await paidOrder("redeemed");
        const r = await Promise.all([
            requestRefund(db.pool, order.id, "router_refundable"),
            requestRefund(db.pool, order.id, "unredeemed"),
        ]);
        expect(r.sort()).toEqual(["created", "exists"]);
        expect(await countRefunds(order.id)).toBe(1);
    });

    it("does not refund unpaid, settling or expired orders", async () => {
        for (const state of ["unpaid", "settling", "expired"] as const) {
            const { order } = await seedOrder(db.pool, { state });
            expect(await requestRefund(db.pool, order.id, "operator")).toBe("not_refundable");
            expect(await countRefunds(order.id)).toBe(0);
            expect((await findOrder(db.pool, order.id))!.state).toBe(state);
        }
    });

    it("answers exists for refunding and refunded orders, unknown for a missing one", async () => {
        for (const state of ["refunding", "refunded"] as const) {
            const { order } = await paidOrder(state);
            expect(await requestRefund(db.pool, order.id, "operator")).toBe("exists");
            expect(await countRefunds(order.id)).toBe(0);
        }
        expect(await requestRefund(db.pool, "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", "operator")).toBe(
            "unknown",
        );
    });

    it("refunds a manual order that has no refund row, once", async () => {
        const { order } = await paidOrder("manual", { manualReason: "no_event_unverifiable" });
        expect(await requestRefund(db.pool, order.id, "router_refundable")).toBe("created");
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "refunding",
            manualReason: null,
        });
        expect(await requestRefund(db.pool, order.id, "router_refundable")).toBe("exists");

        const withRow = await paidOrder("manual", { manualReason: "refund_failed" });
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state)
             values ($1, 'full', 'late', 10000, 'source-a', 'payer-a', 'manual')`,
            [withRow.order.id],
        );
        expect(await requestRefund(db.pool, withRow.order.id, "operator")).toBe("exists");
        expect(await countRefunds(withRow.order.id)).toBe(1);
        expect((await findOrder(db.pool, withRow.order.id))!.state).toBe("manual");
    });

    it("refunds part of a payment when given an amount", async () => {
        const { order, payment } = await paidOrder("redeemed");
        expect(
            await requestRefund(db.pool, order.id, "router_refundable", { amountMicros: 4_000 }),
        ).toBe("created");
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            kind: "partial",
            amountMicros: 4_000,
            destination: payment.sourceTokenAccount,
        });
        expect(await requestRefund(db.pool, order.id, "unredeemed")).toBe("exists");
        expect(await countRefunds(order.id)).toBe(1);
    });

    it("answers exists for a partial refund after a full one", async () => {
        const { order } = await paidOrder("paid");
        await requestRefund(db.pool, order.id, "unredeemed");
        expect(
            await requestRefund(db.pool, order.id, "router_refundable", { amountMicros: 100 }),
        ).toBe("exists");
        expect(await countRefunds(order.id)).toBe(1);
    });

    it("rejects amounts outside 1..paid and creates nothing", async () => {
        const { order } = await paidOrder("redeemed");
        for (const amount of [0, -5, 10_001, 1.5, Number.NaN]) {
            expect(
                await requestRefund(db.pool, order.id, "router_refundable", {
                    amountMicros: amount,
                }),
            ).toBe("invalid_amount");
        }
        expect(await countRefunds(order.id)).toBe(0);
        expect((await findOrder(db.pool, order.id))!.state).toBe("redeemed");
        expect(
            await requestRefund(db.pool, order.id, "router_refundable", { amountMicros: 10_000 }),
        ).toBe("created");
    });
});

describe("every insert site splits a shared payment", () => {
    it("cold requestRefund inserts one full row per owner", async () => {
        const { order } = await seedOrder(db.pool, { state: "paid", amountMicros: 50_000 });
        await seedSharedPayment(db.pool, order.id);
        expect(await requestRefund(db.pool, order.id, "unredeemed")).toBe("created");
        expect(await refundGroup(db.pool, order.id, "full")).toEqual([
            expect.objectContaining({
                part: 0,
                destination: "SrcA",
                payer: "OwnA",
                amountMicros: 30_000,
                state: "pending",
                fromWallet: "refund",
            }),
            expect.objectContaining({
                part: 1,
                destination: "SrcB",
                payer: "OwnB",
                amountMicros: 20_000,
                state: "pending",
                fromWallet: "refund",
            }),
        ]);
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({ part: 0 });
        expect(await requestRefund(db.pool, order.id, "operator")).toBe("exists");
        expect(await countRefunds(order.id)).toBe(2);
    });
});

describe("returnManualToRedeemed", () => {
    const at = new Date("2030-01-01T00:00:00Z");

    it("moves a manual order back, clears the reason and sets router_confirmed_at", async () => {
        const { order } = await paidOrder("manual", { manualReason: "no_event_unverifiable" });
        expect(await returnManualToRedeemed(db.pool, order.id, at)).toBe(true);
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "redeemed",
            manualReason: null,
            routerConfirmedAt: at,
        });
    });

    it("only acts on the listed reasons when given, and never on non-manual orders", async () => {
        const { order } = await paidOrder("manual", { manualReason: "refund_failed" });
        const only = ["no_event_unverifiable"];
        expect(await returnManualToRedeemed(db.pool, order.id, at, only)).toBe(false);
        expect((await findOrder(db.pool, order.id))!.state).toBe("manual");
        const redeemed = await paidOrder("redeemed");
        expect(await returnManualToRedeemed(db.pool, redeemed.order.id, at)).toBe(false);
    });

    it("leaves a manual order that has a refund row alone", async () => {
        const { order } = await paidOrder("manual", { manualReason: "no_event_unverifiable" });
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state)
             values ($1, 'full', 'late', 10000, 'source-a', 'payer-a', 'manual')`,
            [order.id],
        );
        expect(await returnManualToRedeemed(db.pool, order.id, at)).toBe(false);
    });
});

describe("requestRefund eligibility check", () => {
    it("refuses and creates nothing when the check fails under the lock", async () => {
        const { order } = await paidOrder("redeemed");
        const result = await requestRefund(db.pool, order.id, "unredeemed", {
            eligible: (o) => o.state === "paid",
        });
        expect(result).toBe("not_refundable");
        expect(await countRefunds(order.id)).toBe(0);
        expect((await findOrder(db.pool, order.id))!.state).toBe("redeemed");
    });
});
