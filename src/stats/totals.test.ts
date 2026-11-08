import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import type { OrderRow, PaidVia } from "../orders/types.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedAllowanceOrder, seedOrder, seedPayment } from "../testing/orders.ts";
import { seedAccount, seedX402Payment } from "../testing/x402.ts";
import { statsTotals } from "./totals.ts";

const NOW = new Date("2030-01-10T12:00:00Z");
const RECIPIENT = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

let db: TestDb;
let settings: Settings;

beforeAll(async () => {
    db = await testDb();
    settings = parseSettings(
        `[solana]\nrecipient = "${RECIPIENT}"\n[orders]\nmax_amount_micros = 70000000\n` +
            `[x402]\nmax_allowance_per_sandbox_micros = 4000000\nmax_price_per_call_micros = 400000\n`,
        "test",
    );
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await db.pool.query("truncate orders, events cascade");
});

const at = (s: string) => new Date(`${s}Z`);

async function paidOrder(
    confirmedAt: Date,
    over: Partial<OrderRow> = {},
    via: PaidVia | null = null,
    status: "confirmed" | "settling" = "confirmed",
): Promise<OrderRow> {
    const seed = over.kind === "allowance" ? seedAllowanceOrder : seedOrder;
    const { order } = await seed(db.pool, { state: "paid", ...over });
    await seedPayment(db.pool, order.id, {
        status,
        confirmedAt: status === "confirmed" ? confirmedAt : null,
    });
    await db.pool.query("update orders set paid_via = $2 where id = $1", [order.id, via]);
    return order;
}

let refundSeq = 0;

async function refund(
    orderId: string,
    from: "refund" | "allowance",
    amountMicros: number,
    confirmedAt: Date,
    state = "confirmed",
): Promise<void> {
    refundSeq += 1;
    const allowance = from === "allowance";
    await db.pool.query(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            tx_signature, confirmed_at, from_wallet)
         values ($1, $2, $3, $4, 'dest', 'payer', $5, $6, $7, $8)`,
        [
            orderId,
            allowance ? "allowance" : "full",
            allowance ? "x402_unspent" : "late",
            amountMicros,
            state,
            `sig-${refundSeq}`,
            state === "confirmed" ? confirmedAt : null,
            from,
        ],
    );
}

const ZERO = { earnedMicros: 0, refundedMicros: 0, allowanceReturnedMicros: 0, x402SpentMicros: 0 };

describe("statsTotals", () => {
    it("answers zeros, all four kinds and no days for an empty database", async () => {
        expect(await statsTotals(db.pool, settings, NOW)).toEqual({
            version: 1,
            daily: [],
            totals: ZERO,
            byKind: [
                { kind: "sandbox", count: 0, micros: 0 },
                { kind: "extend", count: 0, micros: 0 },
                { kind: "x402_allowance", count: 0, micros: 0 },
                { kind: "x402_fee", count: 0, micros: 0 },
            ],
            refunds: { count: 0, micros: 0 },
            byMethod: [],
            limits: {
                "order.max_micros": 70_000_000,
                "x402.max_allowance_micros": 4_000_000,
                "x402.max_price_per_call_micros": 400_000,
            },
        });
    });

    it("splits a start order with an allowance into three kinds and earns all but the allowance", async () => {
        await paidOrder(at("2030-01-10T01:00:00"), {
            amountMicros: 1_063_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            payInto: "allowance",
        });
        const t = await statsTotals(db.pool, settings, NOW);
        expect(t.byKind).toEqual([
            { kind: "sandbox", count: 1, micros: 60_000 },
            { kind: "extend", count: 0, micros: 0 },
            { kind: "x402_allowance", count: 1, micros: 1_000_000 },
            { kind: "x402_fee", count: 1, micros: 3_000 },
        ]);
        expect(t.totals.earnedMicros).toBe(63_000);
        expect(t.daily).toEqual([{ day: "2030-01-10", ...ZERO, earnedMicros: 63_000 }]);
    });

    it("counts an allowance order in allowance and fee, and an extend in extend", async () => {
        await paidOrder(at("2030-01-10T01:00:00"), { kind: "allowance" });
        await paidOrder(at("2030-01-10T02:00:00"), {
            kind: "extend",
            handleSha256: "cd".repeat(32),
            amountMicros: 20_000,
        });
        const t = await statsTotals(db.pool, settings, NOW);
        expect(t.byKind).toEqual([
            { kind: "sandbox", count: 0, micros: 0 },
            { kind: "extend", count: 1, micros: 20_000 },
            { kind: "x402_allowance", count: 1, micros: 1_000_000 },
            { kind: "x402_fee", count: 1, micros: 3_000 },
        ]);
        expect(t.totals.earnedMicros).toBe(23_000);
    });

    it("leaves out an unconfirmed payment and an unconfirmed refund", async () => {
        const o = await paidOrder(at("2030-01-10T01:00:00"), {}, "checkout", "settling");
        await refund(o.id, "refund", 5_000, at("2030-01-10T02:00:00"), "sent");
        const t = await statsTotals(db.pool, settings, NOW);
        expect(t.totals).toEqual(ZERO);
        expect(t.byKind.every((k) => k.count === 0 && k.micros === 0)).toBe(true);
        expect(t.refunds).toEqual({ count: 0, micros: 0 });
        expect(t.byMethod).toEqual([]);
        expect(t.daily).toEqual([]);
    });

    it("puts a refund-wallet refund in refunded and an allowance return only in allowance returned", async () => {
        const o = await paidOrder(at("2030-01-10T01:00:00"), { amountMicros: 50_000 });
        await refund(o.id, "refund", 50_000, at("2030-01-10T03:00:00"));
        const a = await paidOrder(at("2030-01-10T01:00:00"), { kind: "allowance" });
        await refund(a.id, "allowance", 400_000, at("2030-01-10T04:00:00"));
        const t = await statsTotals(db.pool, settings, NOW);
        expect(t.totals).toEqual({
            earnedMicros: 53_000,
            refundedMicros: 50_000,
            allowanceReturnedMicros: 400_000,
            x402SpentMicros: 0,
        });
        expect(t.refunds).toEqual({ count: 1, micros: 50_000 });
        expect(t.daily).toEqual([{ day: "2030-01-10", ...t.totals }]);
    });

    it("counts x402 spend from confirmed rows that did not land late, on their resolve day", async () => {
        const account = await seedAccount(db.pool);
        await seedX402Payment(db.pool, {
            accountId: account.id,
            amountMicros: 10_000,
            resolvedAt: at("2030-01-09T23:59:59"),
        });
        await seedX402Payment(db.pool, {
            accountId: account.id,
            amountMicros: 7_000,
            resolvedAt: at("2030-01-10T00:00:00"),
        });
        await seedX402Payment(db.pool, {
            accountId: account.id,
            amountMicros: 1_000,
            lateLanded: true,
            resolvedAt: at("2030-01-10T00:00:00"),
        });
        await seedX402Payment(db.pool, {
            accountId: account.id,
            amountMicros: 2_000,
            state: "signed",
            signedAt: at("2030-01-10T00:00:00"),
        });
        const t = await statsTotals(db.pool, settings, NOW);
        expect(t.totals).toEqual({ ...ZERO, x402SpentMicros: 17_000 });
        expect(t.daily).toEqual([
            { day: "2030-01-09", ...ZERO, x402SpentMicros: 10_000 },
            { day: "2030-01-10", ...ZERO, x402SpentMicros: 7_000 },
        ]);
    });

    it("zero-fills a gap day and ends at today", async () => {
        const o = await paidOrder(at("2030-01-07T10:00:00"), { amountMicros: 30_000 });
        await refund(o.id, "refund", 30_000, at("2030-01-09T10:00:00"));
        const t = await statsTotals(db.pool, settings, NOW);
        expect(t.daily).toEqual([
            { day: "2030-01-07", ...ZERO, earnedMicros: 30_000 },
            { day: "2030-01-08", ...ZERO },
            { day: "2030-01-09", ...ZERO, refundedMicros: 30_000 },
            { day: "2030-01-10", ...ZERO },
        ]);
    });

    it("never lists a day after today, and still counts its money in the totals", async () => {
        await paidOrder(at("2030-01-11T00:00:01"), { amountMicros: 30_000 });
        const t = await statsTotals(db.pool, settings, NOW);
        expect(t.daily).toEqual([]);
        expect(t.totals.earnedMicros).toBe(30_000);
    });

    it("groups byMethod by paid_via and leaves out orders without one", async () => {
        const when = at("2030-01-10T01:00:00");
        await paidOrder(when, { amountMicros: 10_000 }, "checkout");
        await paidOrder(when, { amountMicros: 20_000 }, "checkout");
        await paidOrder(when, { amountMicros: 40_000 }, "pay_cli");
        await paidOrder(when, { amountMicros: 80_000 }, null);
        const t = await statsTotals(db.pool, settings, NOW);
        expect(t.byMethod).toEqual([
            { method: "checkout", count: 2, micros: 30_000 },
            { method: "pay_cli", count: 1, micros: 40_000 },
        ]);
        expect(t.totals.earnedMicros).toBe(150_000);
    });

    it("throws rather than answer a sum past 2^53 - 1", async () => {
        const when = at("2030-01-10T01:00:00");
        await paidOrder(when, { amountMicros: Number.MAX_SAFE_INTEGER });
        await paidOrder(when, { amountMicros: 1 });
        await expect(statsTotals(db.pool, settings, NOW)).rejects.toThrow(/safe integer/);
    });
});
