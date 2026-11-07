import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setPaymentLandedSlot } from "../orders/store.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedAllowanceOrder, seedOrder, seedPayment } from "../testing/orders.ts";
import { seedAccount, seedFunding, seedX402Payment } from "../testing/x402.ts";
import {
    bugnetMoneyAt,
    liabilities,
    liabilitiesAt,
    transferableParts,
    unsettledColdTransfersAt,
} from "./liabilities.ts";
import type { Tail } from "./tail.ts";

const TAIL0: Tail = {
    tokenAccount: null,
    openingBalanceMicros: 0n,
    openingSlot: 0n,
    openedAt: null,
    verifiedSlot: 0n,
    verifiedAt: null,
    finalizedHeight: 0n,
    mismatchSince: null,
};
const PAID = new Date("2030-01-01T00:00:00Z");

let db: TestDb;
let pool: pg.Pool;
beforeEach(async () => {
    db = await testDb();
    pool = db.pool;
});
afterEach(async () => {
    await db.close();
});

async function landedAt(orderId: string, slot: bigint): Promise<void> {
    await seedPayment(pool, orderId, { status: "confirmed" });
    await setPaymentLandedSlot(pool, orderId, slot);
}

async function hotStart(o: {
    landed: bigint;
    hotRouterRefundMicros?: number;
    coldTransferId?: number;
    state?: "paid" | "refunding";
}): Promise<{ id: string }> {
    const { order } = await seedOrder(pool, {
        kind: "start",
        state: o.state ?? "paid",
        payInto: "allowance",
        amountMicros: 1_013_000,
        allowanceMicros: 1_000_000,
        feeMicros: 3_000,
        paidAt: PAID,
        hotRouterRefundMicros: o.hotRouterRefundMicros ?? 0,
        coldTransferId: o.coldTransferId ?? null,
    });
    await landedAt(order.id, o.landed);
    return { id: order.id };
}

let eventSeq = 0;
async function storeEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    eventSeq += 1;
    await pool.query(
        "insert into events (event_id, type, created_at, order_id, payload) values ($1, $2, now(), $3, $4)",
        [`ev-${eventSeq}`, type, payload.order_id ?? null, JSON.stringify(payload)],
    );
}

async function storeChainTx(signature: string, slot: bigint, failed: boolean): Promise<void> {
    await pool.query(
        `insert into x402_chain_txs (signature, slot, delta_micros, failed, matched)
         values ($1, $2, 0, $3, 'refund')`,
        [signature, slot.toString(), failed],
    );
}

async function allowanceRow(o: {
    orderId: string;
    amountMicros: number;
    state: string;
    kind?: "allowance" | "full";
    reason?: string;
    manualReason?: string | null;
    txSignature?: string | null;
    previousSignatures?: string[];
}): Promise<void> {
    const kind = o.kind ?? "allowance";
    await pool.query(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            manual_reason, tx_signature, previous_signatures, from_wallet)
         values ($1, $2, $3, $4, 'dest', 'payer', $5, $6, $7, $8, 'allowance')`,
        [
            o.orderId,
            kind,
            o.reason ?? (kind === "allowance" ? "x402_unspent" : "x402_ceiling"),
            o.amountMicros,
            o.state,
            o.manualReason ?? null,
            o.txSignature ?? null,
            o.previousSignatures ?? [],
        ],
    );
}

// funded 1_000_000 (order payment landed at 100), spent 300_000 (seller payment landed at 150),
// refunded 200_000 by an allowance row signed as "R"
async function movedAccount(): Promise<{ id: string }> {
    const acct = await seedAccount(pool);
    const f = await seedFunding(pool, { accountId: acct.id, allowanceMicros: 1_000_000 });
    await setPaymentLandedSlot(pool, f.orderId, 100n);
    await seedX402Payment(pool, {
        accountId: acct.id,
        amountMicros: 300_000,
        state: "confirmed",
        landedSlot: 150n,
    });
    await pool.query(
        "update x402_accounts set spent_micros = 300000, refunded_micros = 200000 where id = $1",
        [acct.id],
    );
    await allowanceRow({
        orderId: acct.id,
        amountMicros: 200_000,
        state: "signed",
        txSignature: "R",
    });
    return acct;
}

describe("liabilities", () => {
    it("count open accounts and open hot rows", async () => {
        const acct = await seedAccount(pool, {
            fundedMicros: 1_000_000,
            spentMicros: 300_000,
            refundedMicros: 200_000,
        });
        await allowanceRow({ orderId: acct.id, amountMicros: 200_000, state: "pending" });
        expect(await liabilities(pool)).toBe(700_000n);
        const closed = await seedAccount(pool, {
            state: "closed",
            handleSha256: "cd".repeat(32),
            fundedMicros: 500_000,
            spentMicros: 500_000,
            closedAt: PAID,
        });
        await allowanceRow({
            orderId: closed.id,
            amountMicros: 50_000,
            state: "manual",
            manualReason: "resolved_by_hand",
        });
        expect(await liabilities(pool)).toBe(700_000n);
        await pool.query(
            `update refunds set state = 'manual', manual_reason = 'refund_balance_short'
             where order_id = $1`,
            [acct.id],
        );
        expect(await liabilities(pool)).toBe(700_000n);
    });

    it("ignore rows paid from the refund wallet", async () => {
        const acct = await seedAccount(pool, { fundedMicros: 1_000_000 });
        await pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state)
             values ($1, 'partial', 'operator', 5000, 'dest', 'payer', 'pending')`,
            [acct.id],
        );
        expect(await liabilities(pool)).toBe(1_000_000n);
    });
});

describe("liabilitiesAt", () => {
    it("counts money by when it moved", async () => {
        await movedAccount();
        expect(await liabilitiesAt(pool, 99n, TAIL0)).toBe(0n);
        expect(await liabilitiesAt(pool, 120n, TAIL0)).toBe(1_000_000n);
        expect(await liabilitiesAt(pool, 200n, TAIL0)).toBe(700_000n);
        await storeChainTx("R", 180n, false);
        expect(await liabilitiesAt(pool, 200n, TAIL0)).toBe(500_000n);
        expect(await liabilitiesAt(pool, 170n, TAIL0)).toBe(700_000n);
    });

    it("reads a stored failed transaction or a previous signature as the rule says", async () => {
        const acct = await movedAccount();
        await pool.query(
            "update refunds set tx_signature = 'R2', previous_signatures = '{R}' where order_id = $1",
            [acct.id],
        );
        await storeChainTx("R", 180n, true);
        expect(await liabilitiesAt(pool, 200n, TAIL0)).toBe(700_000n);
        await storeChainTx("R2", 190n, false);
        expect(await liabilitiesAt(pool, 200n, TAIL0)).toBe(500_000n);
    });

    it("leaves a confirmed payment with no landed slot or a late landing out of the add-back", async () => {
        const acct = await movedAccount();
        await pool.query("update x402_payments set landed_slot = null where account_id = $1", [
            acct.id,
        ]);
        expect(await liabilitiesAt(pool, 120n, TAIL0)).toBe(700_000n);
        expect(await liabilitiesAt(pool, 200n, TAIL0)).toBe(700_000n);
        await pool.query(
            "update x402_payments set landed_slot = 150, late_landed = true where account_id = $1",
            [acct.id],
        );
        expect(await liabilitiesAt(pool, 200n, TAIL0)).toBe(700_000n);
    });

    it("stops counting a confirmed hot refund once its confirmation is before the tail opened", async () => {
        const tail = { ...TAIL0, openedAt: new Date("2030-01-05T00:00:00Z") };
        const acct = await seedAccount(pool);
        await allowanceRow({ orderId: acct.id, amountMicros: 9_000, state: "confirmed" });
        await pool.query("update refunds set confirmed_at = $2 where order_id = $1", [
            acct.id,
            new Date("2030-01-04T00:00:00Z"),
        ]);
        expect(await liabilitiesAt(pool, 200n, tail)).toBe(0n);
        await pool.query("update refunds set confirmed_at = $2 where order_id = $1", [
            acct.id,
            new Date("2030-01-06T00:00:00Z"),
        ]);
        expect(await liabilitiesAt(pool, 200n, tail)).toBe(9_000n);
    });

    it("counts a hot full row once its order payment landed", async () => {
        const o = await hotStart({ landed: 300n, state: "refunding" });
        await pool.query("update orders set x402_refusal = 'allowance_ceiling' where id = $1", [
            o.id,
        ]);
        await allowanceRow({
            orderId: o.id,
            kind: "full",
            amountMicros: 1_013_000,
            state: "pending",
        });
        expect(await liabilitiesAt(pool, 250n, TAIL0)).toBe(0n);
        expect(await liabilitiesAt(pool, 350n, TAIL0)).toBe(1_013_000n);
    });

    it("never counts old tail parts", async () => {
        const tail = { ...TAIL0, openingSlot: 1_000n, openedAt: new Date("2030-01-01T00:00:00Z") };
        const open = await seedAccount(pool);
        const f = await seedFunding(pool, { accountId: open.id, allowanceMicros: 1_000_000 });
        await setPaymentLandedSlot(pool, f.orderId, 900n);
        const closed = await seedAccount(pool, {
            state: "closed",
            handleSha256: "cd".repeat(32),
            fundedMicros: 4_000,
            keptMicros: 4_000,
            closedAt: new Date("2029-12-31T00:00:00Z"),
        });
        const g = await seedFunding(pool, { accountId: closed.id, allowanceMicros: 1_000_000 });
        await setPaymentLandedSlot(pool, g.orderId, 900n);
        expect(await liabilitiesAt(pool, 2_000n, tail)).toBe(0n);
        expect(await transferableParts(pool, 2_000n, tail)).toEqual([]);
    });
});

async function partsFixture(): Promise<{
    ready: { id: string };
    ended: { id: string };
    excluded: string[];
    failedRefundable: { id: string };
}> {
    const ready = await hotStart({ landed: 100n });
    await storeEvent("placement.ready", { order_id: ready.id, deadline: "2030-01-01T01:00:00Z" });
    const netted = await hotStart({ landed: 100n, hotRouterRefundMicros: 8_000 });
    await storeEvent("placement.ready", { order_id: netted.id });
    const late = await hotStart({ landed: 300n });
    await storeEvent("placement.ready", { order_id: late.id });
    const moved = await hotStart({ landed: 100n, coldTransferId: 5 });
    await storeEvent("placement.ready", { order_id: moved.id });
    const ended = await hotStart({ landed: 100n });
    await storeEvent("placement.terminated", { order_id: ended.id, refundable: false });
    const failedRefundable = await hotStart({ landed: 100n });
    await storeEvent("placement.failed", { order_id: failedRefundable.id, refundable: true });

    const feeAcct = await seedAccount(pool);
    const feeOrder = await seedAllowanceOrder(pool);
    await seedFunding(pool, {
        accountId: feeAcct.id,
        orderId: feeOrder.order.id,
        allowanceMicros: 1_000_000,
        feeCreditedMicros: 0,
    });
    await setPaymentLandedSlot(pool, feeOrder.order.id, 100n);
    const creditOrder = await seedAllowanceOrder(pool);
    await seedFunding(pool, {
        accountId: feeAcct.id,
        orderId: creditOrder.order.id,
        allowanceMicros: 1_000_000,
        feeCreditedMicros: 3_000,
    });
    await setPaymentLandedSlot(pool, creditOrder.order.id, 100n);

    const closed = await seedAccount(pool, {
        state: "closed",
        handleSha256: "cd".repeat(32),
        fundedMicros: 4_000,
        keptMicros: 4_000,
        closedAt: new Date("2030-01-02T00:00:00Z"),
    });
    const g = await seedFunding(pool, { accountId: closed.id, allowanceMicros: 1_000_000 });
    await setPaymentLandedSlot(pool, g.orderId, 100n);
    return {
        ready,
        ended,
        excluded: [late.id, moved.id, failedRefundable.id],
        failedRefundable,
    };
}

describe("transferable parts", () => {
    it("lists shares, fees and kept money that can move to cold", async () => {
        const fx = await partsFixture();
        const parts = await transferableParts(pool, 200n, TAIL0);
        expect(parts.map((p) => [p.kind, p.micros]).sort()).toEqual(
            [
                ["fee", 3_000],
                ["kept", 4_000],
                ["share", 5_000],
                ["share", 13_000],
                ["share", 13_000],
            ].sort(),
        );
        expect(parts.find((p) => p.orderId === fx.ended.id)?.micros).toBe(13_000);
        expect(parts.some((p) => p.orderId !== null && fx.excluded.includes(p.orderId))).toBe(
            false,
        );
        const kept = parts.find((p) => p.kind === "kept")!;
        expect(kept.orderId).toBeNull();
        expect(kept.accountId).not.toBeNull();
        expect(kept.since).toEqual(new Date("2030-01-02T00:00:00Z"));
        expect(parts.find((p) => p.kind === "share")!.since).toEqual(PAID);
        const sinces = parts.map((p) => p.since.getTime());
        expect(sinces).toEqual([...sinces].sort((a, b) => a - b));
    });

    it("keeps a share held when its terminal event has no refundable field", async () => {
        const o = await hotStart({ landed: 100n });
        await storeEvent("placement.terminated", { order_id: o.id });
        expect(await transferableParts(pool, 200n, TAIL0)).toEqual([]);
        const p = await hotStart({ landed: 100n });
        await storeEvent("placement.failed", { order_id: p.id, refundable: false });
        expect((await transferableParts(pool, 200n, TAIL0)).map((x) => x.orderId)).toEqual([p.id]);
    });

    it("counts a kept part only when the account closed after the tail opened", async () => {
        const closed = await seedAccount(pool, {
            state: "closed",
            handleSha256: "cd".repeat(32),
            fundedMicros: 4_000,
            keptMicros: 4_000,
            closedAt: new Date("2030-01-02T00:00:00Z"),
        });
        const g = await seedFunding(pool, { accountId: closed.id, allowanceMicros: 1_000_000 });
        await setPaymentLandedSlot(pool, g.orderId, 100n);
        const before = { ...TAIL0, openedAt: new Date("2030-01-03T00:00:00Z") };
        expect(await transferableParts(pool, 200n, before)).toEqual([]);
        const after = { ...TAIL0, openedAt: new Date("2030-01-01T00:00:00Z") };
        expect((await transferableParts(pool, 200n, after)).map((p) => p.kind)).toEqual(["kept"]);
    });

    it("leaves out a share whose start order has a full refund row", async () => {
        const o = await hotStart({ landed: 100n });
        await storeEvent("placement.ready", { order_id: o.id });
        await allowanceRow({
            orderId: o.id,
            kind: "full",
            amountMicros: 1_013_000,
            state: "pending",
        });
        expect(await transferableParts(pool, 200n, TAIL0)).toEqual([]);
    });
});

describe("bugnetMoneyAt", () => {
    it("counts every share with no full row, ready or not", async () => {
        await partsFixture();
        expect(await bugnetMoneyAt(pool, 200n, TAIL0)).toBe(51_000n);
    });
});

describe("unsettledColdTransfersAt", () => {
    it("is what is not failed and not yet stored at C", async () => {
        await pool.query(
            `insert into x402_cold_transfers (amount_micros, state, tx_signature)
             values (20000000, 'sent', 'T')`,
        );
        expect(await unsettledColdTransfersAt(pool, 500n)).toBe(20_000_000n);
        await storeChainTx("T", 400n, false);
        expect(await unsettledColdTransfersAt(pool, 500n)).toBe(0n);
        expect(await unsettledColdTransfersAt(pool, 399n)).toBe(20_000_000n);
        await pool.query("update x402_cold_transfers set state = 'failed'");
        expect(await unsettledColdTransfersAt(pool, 399n)).toBe(0n);
    });

    it("reads a previous signature as the row's", async () => {
        await pool.query(
            `insert into x402_cold_transfers (amount_micros, state, tx_signature, previous_signatures)
             values (7000000, 'sent', 'T2', '{T1}')`,
        );
        await storeChainTx("T1", 300n, false);
        expect(await unsettledColdTransfersAt(pool, 300n)).toBe(0n);
        expect(await unsettledColdTransfersAt(pool, 299n)).toBe(7_000_000n);
    });
});
