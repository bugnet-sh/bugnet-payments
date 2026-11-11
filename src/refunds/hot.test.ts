import { getBase58Decoder } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { memoryLog } from "../log.ts";
import { findOrder } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedOrder, seedPayment, seedSharedPayment } from "../testing/orders.ts";
import { resetLedger, seedAccount, seedFunding } from "../testing/x402.ts";
import { createAllowanceFunding } from "../x402/funding.ts";
import { findAccount, lockAccount, readPool } from "../x402/ledger.ts";
import { confirmHotRefund, resolveHotRefundByHand, writeHotPartial } from "./hot.ts";
import { findOrderRefund, findRefundById, refundGroup, requestRefund } from "./request.ts";

const X = parseSettings(
    stringify({ solana: { recipient: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" } }),
    "t",
).x402;
const F = createAllowanceFunding({ x402: X, log: memoryLog() });
const AT = new Date("2030-01-01T00:30:00Z");
const sig = (n: number) => getBase58Decoder().decode(new Uint8Array(64).fill(n));
const SIG = sig(2);
const HAND = sig(3);

let db: TestDb;
let log: ReturnType<typeof memoryLog>;
let opts: { funding: typeof F; at: Date; log: typeof log };
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await resetLedger(db.pool);
    log = memoryLog();
    opts = { funding: F, at: AT, log };
});

async function hotStart(
    state: OrderRow["state"],
    over: Partial<OrderRow> & { noFunding?: boolean } = {},
): Promise<{ order: OrderRow }> {
    const { noFunding, ...fields } = over;
    const account = await seedAccount(db.pool, {});
    await db.pool.query("update orders set state = $2 where id = $1", [account.id, state]);
    await db.pool.query(
        "update orders set x402_refusal = $2, cold_transfer_id = $3 where id = $1",
        [account.id, fields.x402Refusal ?? null, fields.coldTransferId ?? null],
    );
    if (fields.coldTransferId) {
        await db.pool.query(
            `insert into x402_cold_transfers (id, amount_micros, state) values ($1, 1, 'confirmed')
             on conflict do nothing`,
            [fields.coldTransferId],
        );
    }
    await seedPayment(db.pool, account.id, {
        status: "confirmed",
        payer: "payer-1",
        sourceTokenAccount: "src-1",
    });
    if (!noFunding) {
        await setPool(1_000_000, 0);
        await seedFunding(db.pool, {
            accountId: account.id,
            orderId: account.id,
            allowanceMicros: 1_000_000,
            payer: "payer-1",
            sourceTokenAccount: "src-1",
        });
    }
    return { order: (await findOrder(db.pool, account.id))! };
}

async function storedEvent(type: string, payload: Record<string, unknown>) {
    await db.pool.query(
        `insert into events (event_id, type, created_at, order_id, payload)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [`ev-${type}-${Math.random()}`, type, AT, payload.order_id, JSON.stringify(payload)],
    );
}

async function rawAllowanceRow(
    orderId: string,
    r: {
        kind?: "allowance" | "full" | "partial";
        amountMicros: number;
        state: string;
        txSignature?: string;
        previous?: string[];
        manual?: boolean;
    },
): Promise<number> {
    const kind = r.kind ?? "allowance";
    const res = await db.pool.query(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            from_wallet, tx_signature, previous_signatures, manual_reason, created_at)
         values ($1, $2, $3, $4, 'src-1', 'payer-1', $5, 'allowance', $6, $7, $8, $9) returning id`,
        [
            orderId,
            kind,
            kind === "allowance" ? "x402_unspent" : "operator",
            r.amountMicros,
            r.state,
            r.txSignature ?? null,
            r.previous ?? [],
            r.state === "manual" ? "needs_hand" : null,
            AT,
        ],
    );
    return Number(res.rows[0].id);
}

const accountRowText = async (id: string) =>
    (
        await db.pool.query("select row_to_json(a)::text as t from x402_accounts a where id = $1", [
            id,
        ])
    ).rows[0].t as string;
const fundingOf = async (orderId: string) =>
    (
        await db.pool.query("select voided_at from x402_fundings where order_id = $1", [orderId])
    ).rows.map((r) => ({ voidedAt: r.voided_at }))[0];
const routerEvents = async (orderId: string) =>
    (
        await db.pool.query(
            "select phase, payload from x402_router_events where order_id = $1 order by id",
            [orderId],
        )
    ).rows as { phase: string; payload: Record<string, unknown> }[];
const setPool = (committed: number, unpaid: number) =>
    db.pool.query("update x402_pool set committed_micros = $1, unpaid_micros = $2 where id = 1", [
        committed,
        unpaid,
    ]);
const alarms = () => log.lines.filter((l) => l.alarm === "manual_queue");

describe("requestRefund on a hot order", () => {
    it("refunds a hot order with no funding row in full from the hot wallet", async () => {
        const { order } = await hotStart("manual", {
            noFunding: true,
            x402Refusal: "sandbox_ended",
        });
        expect(await requestRefund(db.pool, order.id, "operator", opts)).toBe("created");
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            kind: "full",
            amountMicros: 1_013_000,
            fromWallet: "allowance",
            destination: "src-1",
            state: "pending",
        });
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
    });

    it("needs funding and a log", async () => {
        const { order } = await hotStart("paid");
        await expect(requestRefund(db.pool, order.id, "operator", { log })).rejects.toThrow(
            "hot order refund needs AllowanceFunding",
        );
        await expect(requestRefund(db.pool, order.id, "operator", { funding: F })).rejects.toThrow(
            "hot order refund needs a Log",
        );
    });

    it("refuses once the share went to cold", async () => {
        const { order } = await hotStart("redeemed", { coldTransferId: 5 });
        expect(await requestRefund(db.pool, order.id, "unredeemed", opts)).toBe("not_refundable");
        expect(await findOrderRefund(db.pool, order.id)).toBeNull();
    });

    it("refunds in full and voids in one transaction under the void conditions", async () => {
        const { order } = await hotStart("paid");
        expect(await requestRefund(db.pool, order.id, "unredeemed", opts)).toBe("created");
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            kind: "full",
            amountMicros: 1_013_000,
            fromWallet: "allowance",
        });
        expect(await fundingOf(order.id)).toMatchObject({ voidedAt: AT });
        expect((await findAccount(db.pool, order.id))!.state).toBe("closing");
    });

    it("refunds package and fee as one partial for router_refundable after ready", async () => {
        const { order } = await hotStart("redeemed");
        await storedEvent("placement.ready", {
            order_id: order.id,
            deadline: "2030-01-01T01:00:00Z",
        });
        expect(await requestRefund(db.pool, order.id, "router_refundable", opts)).toBe("created");
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            kind: "partial",
            amountMicros: 13_000,
            fromWallet: "allowance",
        });
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "redeemed",
            hotRouterRefundMicros: 13_000,
        });
    });

    it("parks any other reason after ready as refund_amount_pending", async () => {
        const { order } = await hotStart("redeemed");
        await storedEvent("placement.ready", {
            order_id: order.id,
            deadline: "2030-01-01T01:00:00Z",
        });
        expect(await requestRefund(db.pool, order.id, "unredeemed", opts)).toBe("parked");
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_amount_pending",
        });
        expect(alarms()).toEqual([
            expect.objectContaining({ orderId: order.id, reason: "refund_amount_pending" }),
        ]);
        expect(await requestRefund(db.pool, order.id, "unredeemed", opts)).toBe("parked");
        expect(alarms()).toHaveLength(1);
        expect(await findOrderRefund(db.pool, order.id)).toBeNull();
    });

    it("gives a manual order with another reason the pending reason", async () => {
        const { order } = await hotStart("manual");
        await storedEvent("placement.ready", {
            order_id: order.id,
            deadline: "2030-01-01T01:00:00Z",
        });
        await db.pool.query(
            "update orders set manual_reason = 'no_event_unverifiable' where id = $1",
            [order.id],
        );
        expect(await requestRefund(db.pool, order.id, "late", opts)).toBe("parked");
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_amount_pending",
        });
        expect(alarms()).toHaveLength(1);
    });
});

describe("writeHotPartial", () => {
    it("writes no partial beside a full row", async () => {
        const { order } = await hotStart("manual", { noFunding: true });
        expect(await requestRefund(db.pool, order.id, "operator", opts)).toBe("created");
        expect(await writeHotPartial(db.pool, order.id, 10_000, AT)).toBe("exists");
        expect((await findOrderRefund(db.pool, order.id))!.kind).toBe("full");
    });

    it("writes hot partials within their bound", async () => {
        const { order } = await hotStart("redeemed");
        expect(await writeHotPartial(db.pool, order.id, 13_001, AT)).toBe("invalid_amount");
        expect(await writeHotPartial(db.pool, order.id, -1, AT)).toBe("invalid_amount");
        expect(await findOrderRefund(db.pool, order.id)).toBeNull();
        expect(await writeHotPartial(db.pool, order.id, 10_000, AT, { budgetWaived: true })).toBe(
            "created",
        );
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            kind: "partial",
            reason: "router_refundable",
            amountMicros: 10_000,
            fromWallet: "allowance",
            budgetWaived: true,
        });
        expect((await findOrder(db.pool, order.id))!.hotRouterRefundMicros).toBe(10_000);
    });

    it("answers zero_share for a share of 0 and returns a parked order to redeemed", async () => {
        const { order } = await hotStart("manual");
        await db.pool.query(
            `update orders set manual_reason = 'refund_amount_pending', event_seen_at = null,
                router_confirmed_at = null where id = $1`,
            [order.id],
        );
        expect(await writeHotPartial(db.pool, order.id, 0, AT)).toBe("zero_share");
        expect(await findOrderRefund(db.pool, order.id)).toBeNull();
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "redeemed",
            manualReason: null,
            eventSeenAt: AT,
            routerConfirmedAt: AT,
        });
    });

    it("answers zero_share for a router entry equal to the allowance (row 4)", async () => {
        const { order } = await hotStart("redeemed");
        await db.pool.query(
            "update orders set amount_micros = allowance_micros, fee_micros = 0 where id = $1",
            [order.id],
        );
        await storedEvent("placement.ready", {
            order_id: order.id,
            deadline: "2030-01-01T01:00:00Z",
        });
        expect(await requestRefund(db.pool, order.id, "router_refundable", opts)).toBe(
            "zero_share",
        );
        expect(await findOrderRefund(db.pool, order.id)).toBeNull();
    });

    it("refuses a hot partial for an order that does not pay into the allowance", async () => {
        const { order } = await hotStart("redeemed");
        await db.pool.query(
            "update orders set pay_into = 'cold', allowance_micros = 0, fee_micros = 0 where id = $1",
            [order.id],
        );
        await expect(writeHotPartial(db.pool, order.id, 10_000, AT)).rejects.toThrow();
        expect(await findOrderRefund(db.pool, order.id)).toBeNull();
    });

    it("pays a share from the refund wallet once the share went to cold", async () => {
        const { order } = await hotStart("redeemed", { coldTransferId: 5 });
        expect(await writeHotPartial(db.pool, order.id, 10_000, AT)).toBe("created");
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({ fromWallet: "refund" });
        expect((await findOrder(db.pool, order.id))!.hotRouterRefundMicros).toBe(0);
    });

    it("keeps one order's rows together at most the payment", async () => {
        const { order } = await hotStart("redeemed");
        await rawAllowanceRow(order.id, { amountMicros: 1_005_000, state: "pending" });
        expect(await writeHotPartial(db.pool, order.id, 10_000, AT)).toBe("invalid_amount");
        expect(await findOrderRefund(db.pool, order.id)).toBeNull();
    });
});

describe("confirmHotRefund", () => {
    const confirm = (id: number, signature: string, slot: bigint | null = 123n) =>
        withTx(db.pool, (c) => confirmHotRefund(c, id, { slot, signature }, AT, X, log));

    it("confirms an allowance row, writes refunded and lowers the pool", async () => {
        const { order } = await hotStart("redeemed");
        const id = await rawAllowanceRow(order.id, {
            amountMicros: 300_000,
            state: "sent",
            txSignature: SIG,
        });
        await setPool(1_000_000, 0);
        const before = await accountRowText(order.id);
        expect(await confirm(id, SIG)).toBe(true);
        expect(await findRefundById(db.pool, id)).toMatchObject({
            state: "confirmed",
            landedSlot: 123n,
            confirmedAt: AT,
        });
        expect((await readPool(db.pool)).committedMicros).toBe(700_000);
        expect(await routerEvents(order.id)).toContainEqual(
            expect.objectContaining({
                phase: "refunded",
                payload: expect.objectContaining({ amountMicros: 300_000, tx: SIG }),
            }),
        );
        expect(await accountRowText(order.id)).toBe(before);
    });

    it("moves a full row's order to refunded", async () => {
        const { order } = await hotStart("refunding");
        const id = await rawAllowanceRow(order.id, {
            kind: "full",
            amountMicros: 1_013_000,
            state: "sent",
            txSignature: SIG,
        });
        expect(await confirm(id, SIG, 9n)).toBe(true);
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunded");
    });

    it("writes a partial row's confirmation with no effect", async () => {
        const { order } = await hotStart("redeemed");
        const id = await rawAllowanceRow(order.id, {
            kind: "partial",
            amountMicros: 13_000,
            state: "sent",
            txSignature: SIG,
        });
        await setPool(1_000_000, 0);
        expect(await confirm(id, SIG)).toBe(true);
        expect((await readPool(db.pool)).committedMicros).toBe(1_000_000);
        expect(await routerEvents(order.id)).toEqual([]);
        expect((await findOrder(db.pool, order.id))!.state).toBe("redeemed");
    });

    it("writes refunded for a voided start funding only when its paid event was sent", async () => {
        for (const paid of ["sent", "pending", "dropped"] as const) {
            await resetLedger(db.pool);
            const { order } = await hotStart("paid");
            await db.pool.query(
                `insert into x402_router_events (kind, start_order_id, order_id, phase, payload,
                    created_at, next_at, state)
                 values ('allowance', $1, $1, 'paid', '{}'::jsonb, $2, $2, $3)`,
                [order.id, AT, paid],
            );
            expect(await requestRefund(db.pool, order.id, "unredeemed", opts)).toBe("created");
            const row = (await findOrderRefund(db.pool, order.id))!;
            await db.pool.query(
                "update refunds set state = 'sent', tx_signature = $2 where id = $1",
                [row.id, SIG],
            );
            expect(await confirm(row.id, SIG)).toBe(true);
            const refunded = (await routerEvents(order.id)).filter((e) => e.phase === "refunded");
            if (paid === "sent") {
                expect(refunded).toEqual([
                    expect.objectContaining({
                        payload: expect.objectContaining({ amountMicros: 1_000_000, tx: SIG }),
                    }),
                ]);
            } else {
                expect(refunded).toEqual([]);
            }
            expect((await findOrder(db.pool, order.id))!.state).toBe("refunded");
        }
    });

    it("confirms only signed or sent rows", async () => {
        const { order } = await hotStart("redeemed");
        const id = await rawAllowanceRow(order.id, {
            amountMicros: 300_000,
            state: "pending",
            txSignature: SIG,
        });
        await setPool(1_000_000, 0);
        expect(await confirm(id, SIG, 9n)).toBe(false);
        expect(await findRefundById(db.pool, id)).toMatchObject({
            state: "pending",
            landedSlot: null,
        });
        expect(await routerEvents(order.id)).toEqual([]);
        expect((await readPool(db.pool)).committedMicros).toBe(1_000_000);
    });

    it("answers false for a second confirm and leaves the pool unchanged", async () => {
        const { order } = await hotStart("redeemed");
        const id = await rawAllowanceRow(order.id, {
            amountMicros: 300_000,
            state: "sent",
            txSignature: SIG,
        });
        await setPool(1_000_000, 0);
        expect(await confirm(id, SIG)).toBe(true);
        const pool = await readPool(db.pool);
        expect(await confirm(id, SIG)).toBe(false);
        expect(await readPool(db.pool)).toEqual(pool);
    });

    it("refuses a signature the row never had", async () => {
        const { order } = await hotStart("redeemed");
        const id = await rawAllowanceRow(order.id, {
            amountMicros: 300_000,
            state: "sent",
            txSignature: SIG,
        });
        expect(await confirm(id, HAND)).toBe(false);
        expect((await findRefundById(db.pool, id))!.state).toBe("sent");
        expect(log.lines.some((l) => l.level === "error")).toBe(true);
    });

    it("accepts a previous signature as the landed one", async () => {
        const { order } = await hotStart("redeemed");
        const s1 = sig(4);
        const s2 = sig(5);
        const id = await rawAllowanceRow(order.id, {
            amountMicros: 300_000,
            state: "sent",
            txSignature: s2,
            previous: [s1],
        });
        await setPool(1_000_000, 0);
        expect(await confirm(id, s1)).toBe(true);
        expect(await findRefundById(db.pool, id)).toMatchObject({
            txSignature: s1,
            previousSignatures: [s2],
        });
    });
});

describe("resolveHotRefundByHand", () => {
    const resolve = (id: number, tx: string) =>
        withTx(db.pool, (c) => resolveHotRefundByHand(c, id, tx, AT, X, log));

    it("resolves a hot row by hand", async () => {
        const { order } = await hotStart("redeemed");
        const id = await rawAllowanceRow(order.id, { amountMicros: 300_000, state: "manual" });
        await setPool(1_000_000, 0);
        expect(await resolve(id, HAND)).toBe(true);
        expect(await findRefundById(db.pool, id)).toMatchObject({
            handTx: HAND,
            manualReason: "resolved_by_hand",
            state: "manual",
            confirmedAt: AT,
        });
        expect(await routerEvents(order.id)).toContainEqual(
            expect.objectContaining({
                phase: "refunded",
                payload: expect.objectContaining({ tx: HAND }),
            }),
        );
        expect((await readPool(db.pool)).committedMicros).toBe(700_000);
        expect(await resolve(id, HAND)).toBe(false);
    });

    it("refuses a row paid from the refund wallet", async () => {
        const { order } = await hotStart("redeemed");
        const id = await rawAllowanceRow(order.id, { amountMicros: 300_000, state: "manual" });
        await db.pool.query("update refunds set from_wallet = 'refund' where id = $1", [id]);
        expect(await resolve(id, HAND)).toBe(false);
        expect((await findRefundById(db.pool, id))!.handTx).toBeNull();
    });

    it("moves a full row's order to refunded", async () => {
        const { order } = await hotStart("manual");
        const id = await rawAllowanceRow(order.id, {
            kind: "full",
            amountMicros: 1_013_000,
            state: "manual",
        });
        expect(await resolve(id, HAND)).toBe(true);
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "refunded",
            manualReason: null,
        });
    });

    it("refuses a signature that is not canonical", async () => {
        const { order } = await hotStart("redeemed");
        const id = await rawAllowanceRow(order.id, { amountMicros: 300_000, state: "manual" });
        const before = await findRefundById(db.pool, id);
        const s63 = getBase58Decoder().decode(new Uint8Array(63).fill(1));
        expect(await resolve(id, s63)).toBe(false);
        expect(await findRefundById(db.pool, id)).toEqual(before);
    });
});

// A hot start order of 50,000 (allowance 20,000) paid by OwnA (30,000) and OwnB (20,000)
async function hotShared(state: OrderRow["state"], o: { funding?: boolean } = {}) {
    const { order } = await seedOrder(db.pool, {
        kind: "start",
        state,
        packageId: "cpu-small",
        amountMicros: 50_000,
        allowanceMicros: 20_000,
        feeMicros: 3_000,
        payInto: "allowance",
    });
    await seedSharedPayment(db.pool, order.id);
    if (o.funding ?? true) {
        await seedAccount(db.pool, { id: order.id });
        await setPool(20_000, 0);
        await seedFunding(db.pool, {
            accountId: order.id,
            orderId: order.id,
            allowanceMicros: 20_000,
            payer: "OwnA",
            sourceTokenAccount: "SrcA",
        });
    }
    return (await findOrder(db.pool, order.id))!;
}

const parts = async (orderId: string, kind: "full" | "partial" | "allowance") =>
    (await refundGroup(db.pool, orderId, kind)).map((r) => ({
        part: r.part,
        amountMicros: r.amountMicros,
        destination: r.destination,
        payer: r.payer,
        state: r.state,
        fromWallet: r.fromWallet,
    }));

describe("every insert site splits a shared payment", () => {
    it("a router partial of a hot shared order is one partial row per owner", async () => {
        const order = await hotShared("redeemed", { funding: false });
        expect(
            await requestRefund(db.pool, order.id, "router_refundable", { amountMicros: 20_000 }),
        ).toBe("created");
        expect(await parts(order.id, "partial")).toEqual([
            {
                part: 0,
                amountMicros: 12_000,
                destination: "SrcA",
                payer: "OwnA",
                state: "pending",
                fromWallet: "allowance",
            },
            {
                part: 1,
                amountMicros: 8_000,
                destination: "SrcB",
                payer: "OwnB",
                state: "pending",
                fromWallet: "allowance",
            },
        ]);
        expect((await findOrder(db.pool, order.id))!.hotRouterRefundMicros).toBe(20_000);
    });

    it("decideHotFullRefund with a voidable funding is one full row per owner", async () => {
        const order = await hotShared("paid");
        expect(await requestRefund(db.pool, order.id, "unredeemed", opts)).toBe("created");
        expect(await parts(order.id, "full")).toEqual([
            expect.objectContaining({ part: 0, amountMicros: 30_000, destination: "SrcA" }),
            expect.objectContaining({ part: 1, amountMicros: 20_000, destination: "SrcB" }),
        ]);
        expect((await parts(order.id, "full")).every((p) => p.fromWallet === "allowance")).toBe(
            true,
        );
        expect(await fundingOf(order.id)).toMatchObject({ voidedAt: AT });
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
    });
});

describe("refund groups on the hot path", () => {
    it("a second refund of the same kind is refused for the whole group", async () => {
        const order = await hotShared("redeemed", { funding: false });
        expect(await writeHotPartial(db.pool, order.id, 20_000, AT)).toBe("created");
        expect(await writeHotPartial(db.pool, order.id, 5_000, AT)).toBe("exists");
        expect(await parts(order.id, "partial")).toHaveLength(2);
        expect((await findOrder(db.pool, order.id))!.hotRouterRefundMicros).toBe(20_000);
    });

    it("hotPartial leaves deposit rows out of its sum", async () => {
        const { order } = await seedOrder(db.pool, {
            kind: "start",
            state: "redeemed",
            amountMicros: 20_000,
            allowanceMicros: 5_000,
            payInto: "allowance",
        });
        await seedPayment(db.pool, order.id, {
            status: "confirmed",
            payer: "payer-1",
            sourceTokenAccount: "src-1",
        });
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                from_wallet, deposit_signature, created_at)
             values ($1, 'deposit', 'deposit_held', 7000, 'src-9', 'payer-9', 'pending', 'refund',
                'held-1', $2)`,
            [order.id, AT],
        );
        expect(await writeHotPartial(db.pool, order.id, 15_000, AT)).toBe("created");
        expect(await parts(order.id, "partial")).toEqual([
            expect.objectContaining({ part: 0, amountMicros: 15_000 }),
        ]);
    });

    it("the allowance refunded event is sent once per group", async () => {
        const account = await seedAccount(db.pool, { state: "closing", closingAt: AT });
        const { order } = await seedOrder(db.pool, {
            kind: "allowance",
            state: "redeemed",
            packageId: "x402-allowance",
            handleSha256: account.handleSha256,
            amountMicros: 50_000,
            allowanceMicros: 50_000,
            payInto: "allowance",
        });
        await seedSharedPayment(db.pool, order.id);
        await seedFunding(db.pool, {
            accountId: account.id,
            orderId: order.id,
            allowanceMicros: 50_000,
            payer: "OwnA",
            sourceTokenAccount: "SrcA",
        });
        await db.pool.query("update x402_accounts set spent_micros = 40000 where id = $1", [
            account.id,
        ]);
        const out = await withTx(db.pool, async (c) =>
            F.refund(c, (await lockAccount(c, account.id))!, AT),
        );
        expect(out).toMatchObject({ kind: "refund", amountMicros: 10_000 });
        const [p0, p1] = await refundGroup(db.pool, order.id, "allowance");
        for (const [r, s] of [
            [p0!, sig(5)],
            [p1!, sig(6)],
        ] as const) {
            await db.pool.query(
                "update refunds set state = 'sent', tx_signature = $2 where id = $1",
                [r.id, s],
            );
        }
        await setPool(10_000, 0);
        const confirm = (id: number, signature: string) =>
            withTx(db.pool, (c) => confirmHotRefund(c, id, { slot: 9n, signature }, AT, X, log));
        const refunded = async () =>
            (await routerEvents(order.id)).filter((e) => e.phase === "refunded");

        expect(await confirm(p0!.id, sig(5))).toBe(true);
        expect(await refunded()).toEqual([]);
        expect((await readPool(db.pool)).committedMicros).toBe(4_000);
        expect(await confirm(p1!.id, sig(6))).toBe(true);
        expect(await refunded()).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({ amountMicros: 10_000, tx: sig(6) }),
            }),
        ]);
        expect((await readPool(db.pool)).committedMicros).toBe(0);
    });
});
