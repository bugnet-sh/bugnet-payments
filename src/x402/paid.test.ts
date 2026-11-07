import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "smol-toml";
import { parseSettings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { silentLog } from "../log.ts";
import { findOrder, lockOrder } from "../orders/store.ts";
import type { OrderRow, PaymentRow } from "../orders/types.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedAllowanceOrder, seedOrder, seedPayment } from "../testing/orders.ts";
import { testSigner } from "../testing/keys.ts";
import { agentPin, resetLedger, seedAccount, seedFunding, seedService } from "../testing/x402.ts";
import { createAllowanceFunding } from "./funding.ts";
import { serviceIdFor } from "./ids.ts";
import { findAccount, isFirstUse, readPool } from "./ledger.ts";
import { onOrderPaid, type PaidDeps, type PaidOutcome } from "./paid.ts";
import type { StoredPin, StoredX402Setup } from "./types.ts";

const X = parseSettings(
    stringify({ solana: { recipient: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" } }),
    "t",
).x402;
const D: PaidDeps = {
    funding: createAllowanceFunding({ x402: X, log: silentLog }),
    x402: X,
    log: silentLog,
};
const PAYER = (await testSigner(3)).address;
const PAYER2 = (await testSigner(4)).address;
const AT = new Date("2030-01-01T00:30:00Z");

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(() => resetLedger(db.pool));

const newAgentPin: StoredPin = {
    ...agentPin({ listed: "unlisted" }),
    paidPath: "/v1/auto/chat/completions",
    newPin: true,
};

function setPool(committed: number, unpaid: number) {
    return db.pool.query(
        "update x402_pool set committed_micros = $1, unpaid_micros = $2 where id = 1",
        [committed, unpaid],
    );
}

function paid(
    order: OrderRow,
    payment: PaymentRow,
    d: PaidDeps = D,
    paidOrder: OrderRow = order,
): Promise<PaidOutcome> {
    return withTx(db.pool, async (c) => {
        await lockOrder(c, order.id);
        return onOrderPaid(c, d, paidOrder, payment, AT);
    });
}

async function hotStart(over: Partial<OrderRow> = {}, payer = PAYER) {
    const { order } = await seedOrder(db.pool, {
        kind: "start",
        state: "paid",
        packageId: "cpu-small",
        amountMicros: 1_013_000,
        allowanceMicros: 1_000_000,
        feeMicros: 3_000,
        payInto: "allowance",
        paidAt: AT,
        ...over,
    });
    const payment = await seedPayment(db.pool, order.id, { status: "confirmed", payer });
    await db.pool.query(
        "update x402_pool set unpaid_micros = unpaid_micros + 1000000 where id = 1",
    );
    return { order, payment };
}

async function hotAllowance(handle: string, over: Partial<OrderRow> = {}, payer = PAYER) {
    const { order } = await seedAllowanceOrder(db.pool, {
        state: "paid",
        handleSha256: handle,
        paidAt: AT,
        expiresAt: new Date(AT.getTime() + 60_000),
        ...over,
    });
    const payment = await seedPayment(db.pool, order.id, { status: "confirmed", payer });
    await db.pool.query("update x402_pool set unpaid_micros = unpaid_micros + $1 where id = 1", [
        order.allowanceMicros,
    ]);
    return { order, payment };
}

async function serviceRow(accountId: string, serviceId: string) {
    const res = await db.pool.query(
        `select listed, paid_path as "paidPath", state, order_id as "orderId",
            max_price_micros::int as "maxPriceMicros", failures
         from x402_services where account_id = $1 and service_id = $2`,
        [accountId, serviceId],
    );
    return res.rows[0];
}

async function routerEvents(startOrderId: string) {
    const res = await db.pool.query(
        "select phase, payload from x402_router_events where start_order_id = $1 order by id",
        [startOrderId],
    );
    return res.rows as { phase: string; payload: Record<string, unknown> }[];
}

async function fundingOf(orderId: string) {
    const res = await db.pool.query(
        `select allowance_micros::int as "allowanceMicros", fee_credited_micros::int as "credit",
            voided_at as "voidedAt" from x402_fundings where order_id = $1`,
        [orderId],
    );
    return res.rows[0];
}

async function refundRow(orderId: string) {
    const res = await db.pool.query(
        `select kind, reason, amount_micros::int as "amountMicros", destination, payer, state,
            from_wallet as "fromWallet" from refunds where order_id = $1`,
        [orderId],
    );
    return res.rows;
}

async function count(table: string): Promise<number> {
    const res = await db.pool.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    return res.rows[0]!.n;
}

describe("onOrderPaid", () => {
    it("opens a start order's account when paid", async () => {
        const { order, payment } = await hotStart({
            x402Setup: {
                services: [newAgentPin],
                disable: [],
                spendPerMinuteMicros: 2_000_000,
            },
        });
        expect(await paid(order, payment)).toMatchObject({
            kind: "funded",
            funding: { allowanceMicros: 1_000_000 },
        });
        expect(await findAccount(db.pool, order.id)).toMatchObject({
            handleSha256: null,
            placementId: null,
            packageId: "cpu-small",
            spendPerMinuteMicros: 2_000_000,
            fundedMicros: 1_000_000,
        });
        expect(await serviceRow(order.id, newAgentPin.serviceId)).toMatchObject({
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
            state: "enabled",
            orderId: order.id,
        });
        expect(await routerEvents(order.id)).toEqual([
            expect.objectContaining({
                phase: "paid",
                payload: expect.objectContaining({
                    amountMicros: 1_000_000,
                    tx: payment.txSignature,
                }),
            }),
        ]);
        expect((await findOrder(db.pool, order.id))!.state).toBe("paid");
        expect(await isFirstUse(db.pool, payment.payer, order.id)).toBe(true);
    });

    it("gives a start order without a setup the default spend rate", async () => {
        const { order, payment } = await hotStart({ x402Setup: null });
        await paid(order, payment);
        expect(await findAccount(db.pool, order.id)).toMatchObject({
            spendPerMinuteMicros: 500_000,
        });
    });

    it("sets the spend rate of an existing account from an allowance order's setup", async () => {
        const account = await seedAccount(db.pool, { spendPerMinuteMicros: 500_000 });
        const { order, payment } = await hotAllowance(account.handleSha256!, {
            x402Setup: { services: [], disable: [], spendPerMinuteMicros: 1_500_000 },
        });
        await paid(order, payment);
        expect(await findAccount(db.pool, account.id)).toMatchObject({
            spendPerMinuteMicros: 1_500_000,
        });
    });

    it("moves an allowance order on to redeemed with its funding", async () => {
        const account = await seedAccount(db.pool);
        const { order, payment } = await hotAllowance(account.handleSha256!);
        expect(await paid(order, payment)).toMatchObject({
            kind: "funded",
            funding: { orderId: order.id, accountId: account.id, allowanceMicros: 1_000_000 },
        });
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "redeemed",
            redeemedAt: AT,
        });
        expect(await fundingOf(order.id)).toMatchObject({ allowanceMicros: 1_000_000, credit: 0 });
    });

    it("refunds a late allowance order without a funding", async () => {
        const account = await seedAccount(db.pool);
        const expiresAt = new Date(AT.getTime() - 1);
        const { order, payment } = await hotAllowance(account.handleSha256!, { expiresAt });
        expect(await paid(order, payment)).toEqual({ kind: "refused", refusal: "order_expired" });
        expect(await refundRow(order.id)).toEqual([
            {
                kind: "full",
                reason: "late",
                amountMicros: 1_003_000,
                destination: payment.sourceTokenAccount,
                payer: payment.payer,
                state: "pending",
                fromWallet: "allowance",
            },
        ]);
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "refunding",
            x402Refusal: "order_expired",
        });
        expect(await fundingOf(order.id)).toBeUndefined();
    });

    it("funds an allowance order paid exactly at its expiry", async () => {
        const account = await seedAccount(db.pool);
        const { order, payment } = await hotAllowance(account.handleSha256!, { expiresAt: AT });
        expect(await paid(order, payment)).toMatchObject({ kind: "funded" });
    });

    it("refuses a closing account and a stored end of the placement", async () => {
        const closing = await seedAccount(db.pool, { state: "closing" });
        const a = await hotAllowance(closing.handleSha256!);
        expect(await paid(a.order, a.payment)).toEqual({
            kind: "refused",
            refusal: "sandbox_ended",
        });
        expect((await refundRow(a.order.id))[0]).toMatchObject({ reason: "x402_closed" });

        const open = await seedAccount(db.pool, { handleSha256: "cd".repeat(32) });
        await db.pool.query(
            `insert into events (event_id, type, payload, created_at)
             values ($1, 'placement.terminated', $2::jsonb, now())`,
            ["ev-1", JSON.stringify({ order_id: open.id })],
        );
        const b = await hotAllowance(open.handleSha256!);
        expect(await paid(b.order, b.payment)).toEqual({
            kind: "refused",
            refusal: "sandbox_ended",
        });
    });

    it("refuses an allowance order with no account", async () => {
        const a = await hotAllowance("ef".repeat(32));
        expect(await paid(a.order, a.payment)).toEqual({
            kind: "refused",
            refusal: "sandbox_ended",
        });
    });

    it("refuses a funding past the account ceiling", async () => {
        const account = await seedAccount(db.pool);
        await seedFunding(db.pool, { accountId: account.id, allowanceMicros: 4_500_000 });
        const a = await hotAllowance(account.handleSha256!, {
            allowanceMicros: 1_000_000,
            feeMicros: 0,
            amountMicros: 1_000_000,
        });
        expect(await paid(a.order, a.payment)).toEqual({
            kind: "refused",
            refusal: "allowance_ceiling",
        });
        expect((await refundRow(a.order.id))[0]).toMatchObject({
            reason: "x402_ceiling",
            amountMicros: 1_000_000,
        });
    });

    it("refuses a funding past the pool at paid", async () => {
        const account = await seedAccount(db.pool);
        await setPool(49_500_000, 0);
        const a = await hotAllowance(account.handleSha256!);
        expect(await paid(a.order, a.payment)).toEqual({
            kind: "refused",
            refusal: "allowance_pool_full",
        });
        expect((await refundRow(a.order.id))[0]).toMatchObject({ reason: "x402_ceiling" });
    });

    it("writes no funding, pin, first use or event for a refused order and lowers only unpaid", async () => {
        const account = await seedAccount(db.pool, { state: "closing" });
        const a = await hotAllowance(account.handleSha256!, {
            x402Setup: { services: [newAgentPin], disable: [], spendPerMinuteMicros: 900_000 },
        });
        await setPool(2_000_000, 0);
        await db.pool.query("update x402_pool set unpaid_micros = 1000000 where id = 1");
        await paid(a.order, a.payment);
        expect(await count("x402_fundings")).toBe(0);
        expect(await count("x402_services")).toBe(0);
        expect(await count("x402_payers")).toBe(0);
        expect(await count("x402_router_events")).toBe(0);
        expect(await readPool(db.pool)).toEqual({ committedMicros: 2_000_000, unpaidMicros: 0 });
        expect(await findAccount(db.pool, account.id)).toMatchObject({
            spendPerMinuteMicros: 500_000,
        });
    });

    it("gives one first use per payer under two concurrent first orders", async () => {
        const a1 = await seedAccount(db.pool, { handleSha256: "a1".repeat(32) });
        const a2 = await seedAccount(db.pool, { handleSha256: "a2".repeat(32) });
        const o1 = await hotAllowance(a1.handleSha256!);
        const o2 = await hotAllowance(a2.handleSha256!);
        await Promise.all([paid(o1.order, o1.payment), paid(o2.order, o2.payment)]);
        const firsts = [
            await isFirstUse(db.pool, PAYER, o1.order.id),
            await isFirstUse(db.pool, PAYER, o2.order.id),
        ];
        expect(firsts.filter(Boolean)).toHaveLength(1);
        expect(await count("x402_fundings")).toBe(2);
    });

    it("keeps a second payer's first use separate", async () => {
        const a1 = await seedAccount(db.pool, { handleSha256: "a1".repeat(32) });
        const a2 = await seedAccount(db.pool, { handleSha256: "a2".repeat(32) });
        const o1 = await hotAllowance(a1.handleSha256!, {}, PAYER);
        const o2 = await hotAllowance(a2.handleSha256!, {}, PAYER2);
        await Promise.all([paid(o1.order, o1.payment), paid(o2.order, o2.payment)]);
        expect(await isFirstUse(db.pool, PAYER, o1.order.id)).toBe(true);
        expect(await isFirstUse(db.pool, PAYER2, o2.order.id)).toBe(true);
    });
});

describe("storePins", () => {
    const id = (n: number) => serviceIdFor("POST", `s${n}.example`, "/v1/");
    const pin = (n: number, over: Partial<StoredPin> = {}): StoredPin => ({
        ...agentPin({
            serviceId: id(n),
            host: `s${n}.example`,
            prefix: "/v1/",
            url: `https://s${n}.example/v1/run`,
            listed: "unlisted",
        }),
        paidPath: "/v1/run",
        newPin: false,
        ...over,
    });

    it("re-pins, re-prices and disables in one storePins", async () => {
        const account = await seedAccount(db.pool);
        const base = { accountId: account.id, listed: "unlisted" as const, paidPath: "/v1/run" };
        await seedService(db.pool, { ...base, serviceId: id(1), maxPriceMicros: 10_000 });
        await seedService(db.pool, { ...base, serviceId: id(2), maxPriceMicros: 10_000 });
        const { order, payment } = await hotAllowance(account.handleSha256!, {
            x402Setup: {
                services: [pin(3, { newPin: true }), pin(1, { maxPriceMicros: 20_000 })],
                disable: [id(2)],
                spendPerMinuteMicros: null,
            } satisfies StoredX402Setup,
        });
        await paid(order, payment);
        expect(await serviceRow(account.id, id(1))).toMatchObject({
            maxPriceMicros: 20_000,
            state: "enabled",
        });
        expect(await serviceRow(account.id, id(2))).toMatchObject({ state: "disabled" });
        expect(await serviceRow(account.id, id(3))).toMatchObject({
            state: "enabled",
            orderId: order.id,
        });
    });

    it("overwrites a held service when a pin is new again and resets its failures", async () => {
        const account = await seedAccount(db.pool);
        await seedService(db.pool, {
            accountId: account.id,
            serviceId: id(1),
            listed: "unlisted",
            paidPath: "/old",
            state: "unreliable",
            failures: 4,
        });
        const { order, payment } = await hotAllowance(account.handleSha256!, {
            x402Setup: {
                services: [pin(1, { newPin: true, paidPath: "/v1/run" })],
                disable: [],
                spendPerMinuteMicros: null,
            },
        });
        await paid(order, payment);
        expect(await serviceRow(account.id, id(1))).toMatchObject({
            paidPath: "/v1/run",
            state: "enabled",
            failures: 0,
            orderId: order.id,
        });
    });
});
