import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTx } from "../db/pool.ts";
import type { ShareRow } from "../deposits/types.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { heldRefundId, seedHeldTransfer } from "../testing/deposits.ts";
import { seedOrder, seedPayment, seedSharedPayment } from "../testing/orders.ts";
import { findRefundById } from "./request.ts";
import { insertDepositRefund, refundTargets, splitRefund } from "./split.ts";

const AT = new Date("2030-01-01T00:30:00Z");

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

function shares(...applied: number[]): ShareRow[] {
    return applied.map((appliedMicros, part) => ({
        orderId: "ord_test",
        part,
        owner: `Own${part}`,
        sourceTokenAccount: `Src${part}`,
        appliedMicros,
    }));
}

const amounts = (amount: number, s: ShareRow[], min = 1_000) =>
    splitRefund(amount, s, min).map((t) => [t.part, t.amountMicros]);

describe("splitRefund", () => {
    it("gives each owner its share of a full refund, with its own destination and payer", () => {
        expect(splitRefund(50_000, shares(30_000, 20_000), 1_000)).toEqual([
            { part: 0, destination: "Src0", payer: "Own0", amountMicros: 30_000 },
            { part: 1, destination: "Src1", payer: "Own1", amountMicros: 20_000 },
        ]);
    });

    it("parts kept are always share parts 0..k-1", () => {
        expect(amounts(5_000, shares(30_000, 15_000, 5_000))).toEqual([
            [0, 3_500],
            [1, 1_500],
        ]);
    });

    it("splits by the shares, merges a part below the minimum into part 0", () => {
        expect(amounts(10_000, shares(30_000, 20_000))).toEqual([
            [0, 6_000],
            [1, 4_000],
        ]);
        expect(amounts(1_500, shares(30_000, 20_000))).toEqual([[0, 1_500]]);
    });

    it("gives the remainder to part 0", () => {
        expect(amounts(50_001, shares(30_000, 20_000))).toEqual([
            [0, 30_001],
            [1, 20_000],
        ]);
        expect(amounts(7, shares(25_000, 15_000, 10_000), 0)).toEqual([
            [0, 4],
            [1, 2],
            [2, 1],
        ]);
    });

    it("refuses shares out of order, which would give a refund part another share's owner", () => {
        // The middle share is merged away, so the last one would become refund part 1
        expect(() => splitRefund(150_500, shares(100_000, 500, 50_000), 1_000)).toThrow(
            "refund part 1 would go to share part 2",
        );
    });

    it("drops parts left at 0 and numbers the rest from 0", () => {
        expect(amounts(1, shares(30_000, 20_000), 0)).toEqual([[0, 1]]);
        expect(amounts(4, shares(30_000, 15_000, 5_000), 0)).toEqual([
            [0, 3],
            [1, 1],
        ]);
    });
});

describe("refundTargets", () => {
    it("refundTargets reads the stored minimum", async () => {
        for (const [min, want] of [
            [0, [900, 600]],
            [1_000, [1_500]],
        ] as const) {
            const { order } = await seedOrder(db.pool, { state: "paid", amountMicros: 50_000 });
            await seedSharedPayment(db.pool, order.id, { splitMinMicros: min });
            const targets = await refundTargets(db.pool, order.id, 1_500);
            expect(targets!.map((t) => t.amountMicros)).toEqual(want);
            expect(targets![0]).toMatchObject({ part: 0, destination: "SrcA", payer: "OwnA" });
        }
    });

    it("answers one target from a single owner's payment, null without a payment", async () => {
        const { order } = await seedOrder(db.pool, { state: "paid", amountMicros: 50_000 });
        expect(await refundTargets(db.pool, order.id, 1_500)).toBeNull();
        await seedPayment(db.pool, order.id, { payer: "payer-a", sourceTokenAccount: "source-a" });
        expect(await refundTargets(db.pool, order.id, 1_500)).toEqual([
            { part: 0, destination: "source-a", payer: "payer-a", amountMicros: 1_500 },
        ]);
    });
});

describe("insertDepositRefund", () => {
    const depositRows = async (orderId: string) =>
        (
            await db.pool.query(
                "select count(*)::int as n from refunds where order_id = $1 and kind = 'deposit'",
                [orderId],
            )
        ).rows[0].n as number;
    const returnTo = (orderId: string, signature: string, destination: string, payer: string) =>
        withTx(db.pool, (c) =>
            insertDepositRefund(c, { orderId, signature, destination, payer, at: AT }),
        );

    it("a held transfer gets one deposit refund", async () => {
        const { order } = await seedOrder(db.pool, { state: "paid", amountMicros: 50_000 });
        const { signature } = await seedHeldTransfer(db.pool, order.id);
        const first = await returnTo(order.id, signature, "DstA", "PayA");
        expect(first).toEqual({ id: expect.any(Number), repointed: false });
        const id = (first as { id: number }).id;
        for (const state of ["pending", "signed", "sent", "confirmed"]) {
            await db.pool.query("update refunds set state = $2 where id = $1", [id, state]);
            expect(await returnTo(order.id, signature, "DstB", "PayB")).toBe("refused");
            expect(await depositRows(order.id)).toBe(1);
        }
        await db.pool.query(
            `update refunds set state = 'manual', manual_reason = 'refund_destination_invalid',
                attempts = 3 where id = $1`,
            [id],
        );
        expect(await returnTo(order.id, signature, "DstB", "PayB")).toEqual({
            id,
            repointed: true,
        });
        expect(await findRefundById(db.pool, id)).toMatchObject({
            state: "pending",
            destination: "DstB",
            payer: "PayB",
            attempts: 0,
            manualReason: null,
        });
        expect(await depositRows(order.id)).toBe(1);
        await db.pool.query(
            "update refunds set state = 'manual', manual_reason = 'resolved_by_hand' where id = $1",
            [id],
        );
        expect(await returnTo(order.id, signature, "DstC", "PayC")).toBe("refused");

        const other = await seedOrder(db.pool, { state: "paid", amountMicros: 50_000 });
        const carried = await seedHeldTransfer(db.pool, other.order.id, { moveState: "sent" });
        expect(await returnTo(other.order.id, carried.signature, "DstA", "PayA")).toBe("refused");
        expect(await depositRows(other.order.id)).toBe(0);
        expect(await heldRefundId(db.pool, other.order.id, carried.signature)).toBeNull();
    });
});
