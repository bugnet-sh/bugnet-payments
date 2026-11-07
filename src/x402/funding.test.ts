import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "smol-toml";
import { parseSettings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { silentLog } from "../log.ts";
import type { OrderRow, PaymentRow } from "../orders/types.ts";
import { findOrder, lockOrder, lockPayment } from "../orders/store.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedAllowanceOrder, seedPayment } from "../testing/orders.ts";
import { testSigner } from "../testing/keys.ts";
import { resetLedger, seedAccount, seedFunding, seedX402Payment } from "../testing/x402.ts";
import type pg from "pg";
import { createAllowanceFunding } from "./funding.ts";
import { findAccount, isFirstUse, lockAccount, readPool } from "./ledger.ts";
import type { AccountRow } from "./types.ts";

const X = parseSettings(
    stringify({ solana: { recipient: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" } }),
    "t",
).x402;
const F = createAllowanceFunding({ x402: X, log: silentLog });
const PAYER = (await testSigner(3)).address;
const AT = new Date("2030-01-01T00:30:00Z");
const D = new Date("2030-01-01T01:00:00Z");
const T0 = new Date("2030-01-01T00:00:00Z");
const T1 = new Date("2030-01-01T00:10:00Z");

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(() => resetLedger(db.pool));

interface Paid {
    order: OrderRow;
    payment: PaymentRow;
}

const setPool = (committed: number, unpaid: number) =>
    db.pool.query("update x402_pool set committed_micros = $1, unpaid_micros = $2 where id = 1", [
        committed,
        unpaid,
    ]);

async function paidFeeOrder(account: AccountRow, payer: string): Promise<Paid> {
    const { order } = await seedAllowanceOrder(db.pool, {
        state: "paid",
        handleSha256: account.handleSha256,
    });
    const payment = await seedPayment(db.pool, order.id, { status: "confirmed", payer });
    return { order, payment };
}

async function startPaid(account: AccountRow, payer: string): Promise<Paid> {
    const order = (await findOrder(db.pool, account.id))!;
    const payment = await seedPayment(db.pool, order.id, { status: "confirmed", payer });
    return { order, payment };
}

function inTx<T>(
    p: Paid,
    fn: (c: pg.PoolClient, o: OrderRow, pay: PaymentRow, a: AccountRow) => Promise<T>,
    accountId?: string,
): Promise<T> {
    return withTx(db.pool, async (c) => {
        const o = (await lockOrder(c, p.order.id))!;
        const pay = (await lockPayment(c, p.order.id))!;
        const a = (await lockAccount(c, accountId ?? p.order.id))!;
        return fn(c, o, pay, a);
    });
}

function inAccountTx<T>(
    id: string,
    fn: (c: pg.PoolClient, a: AccountRow) => Promise<T>,
): Promise<T> {
    return withTx(db.pool, async (c) => fn(c, (await lockAccount(c, id))!));
}

const routerEvents = async (orderId: string) =>
    (
        await db.pool.query(
            `select phase, state, dropped_reason, payload from x402_router_events
             where order_id = $1 order by id`,
            [orderId],
        )
    ).rows.map((r) => ({
        phase: r.phase,
        state: r.state,
        droppedReason: r.dropped_reason,
        payload: r.payload,
    }));
const fundingOf = async (orderId: string) =>
    (
        await db.pool.query("select voided_at from x402_fundings where order_id = $1", [orderId])
    ).rows.map((r) => ({ voidedAt: r.voided_at }))[0];
const payerRow = async (payer: string) =>
    (await db.pool.query("select * from x402_payers where payer = $1", [payer])).rows[0] ?? null;
const allowanceRows = async (accountId: string) =>
    (
        await db.pool.query(
            `select r.* from refunds r join x402_fundings f on f.order_id = r.order_id
             where f.account_id = $1 and r.kind = 'allowance' order by r.id`,
            [accountId],
        )
    ).rows.map((r) => ({
        kind: r.kind,
        reason: r.reason,
        fromWallet: r.from_wallet,
        state: r.state,
        amountMicros: Number(r.amount_micros),
        destination: r.destination,
        payer: r.payer,
    }));

describe("fund", () => {
    it("credits the fee of a second fee-carrying funding", async () => {
        const account = await seedAccount(db.pool);
        await setPool(0, 2_000_000);
        const one = await paidFeeOrder(account, PAYER);
        const two = await paidFeeOrder(account, PAYER);
        expect(await inTx(one, (c, o, p, a) => F.fund(c, o, p, a, AT), account.id)).toMatchObject({
            allowanceMicros: 1_000_000,
            feeCreditedMicros: 0,
            payer: PAYER,
        });
        expect(await inTx(two, (c, o, p, a) => F.fund(c, o, p, a, AT), account.id)).toMatchObject({
            allowanceMicros: 1_003_000,
            feeCreditedMicros: 3_000,
        });
        expect((await findAccount(db.pool, account.id))!.fundedMicros).toBe(2_003_000);
        expect(await readPool(db.pool)).toEqual({ committedMicros: 2_003_000, unpaidMicros: 0 });
        expect(await isFirstUse(db.pool, PAYER, one.order.id)).toBe(true);
        expect(await isFirstUse(db.pool, PAYER, two.order.id)).toBe(false);
        expect(await routerEvents(two.order.id)).toEqual([
            expect.objectContaining({
                phase: "paid",
                state: "pending",
                payload: expect.objectContaining({
                    amountMicros: 1_003_000,
                    startOrderId: account.id,
                    tx: two.payment.txSignature,
                }),
            }),
        ]);
    });

    it("refuses an account that is not open", async () => {
        const account = await seedAccount(db.pool, { state: "closing" });
        await setPool(0, 1_000_000);
        const one = await paidFeeOrder(account, PAYER);
        await expect(inTx(one, (c, o, p, a) => F.fund(c, o, p, a, AT), account.id)).rejects.toThrow(
            /not open/,
        );
        expect(await readPool(db.pool)).toEqual({ committedMicros: 0, unpaidMicros: 1_000_000 });
        expect(await fundingOf(one.order.id)).toBeUndefined();
    });
});

describe("void", () => {
    async function fundedStart() {
        const account = await seedAccount(db.pool);
        await setPool(0, 1_000_000);
        const start = await startPaid(account, PAYER);
        await inTx(start, (c, o, p, a) => F.fund(c, o, p, a, AT));
        return { account, start };
    }
    const unchanged = async (account: AccountRow, start: Paid) => {
        expect((await fundingOf(start.order.id))!.voidedAt).toBeNull();
        expect((await findAccount(db.pool, account.id))!.fundedMicros).toBe(1_000_000);
        expect((await readPool(db.pool)).committedMicros).toBe(1_000_000);
    };

    it("voids only under the void conditions", async () => {
        const { account, start } = await fundedStart();
        const attempt = (t?: Date | null) => inTx(start, (c, o, _p, a) => F.void(c, o, a, AT, t));

        await seedX402Payment(db.pool, { accountId: account.id });
        expect(await attempt(null)).toBe(false);
        await unchanged(account, start);
        await db.pool.query("truncate x402_payments cascade");

        await db.pool.query(
            `insert into events (event_id, type, created_at, order_id, payload)
             values ('e1', 'placement.ready', now(), $1,
                jsonb_build_object('order_id', $1::text, 'deadline', '2030-01-01T01:00:00Z'))`,
            [account.id],
        );
        expect(await attempt(null)).toBe(false);
        await unchanged(account, start);
        await db.pool.query("truncate events");

        expect(await attempt(D)).toBe(false);
        await unchanged(account, start);

        expect(await attempt(null)).toBe(true);
        expect(await fundingOf(start.order.id)).toMatchObject({ voidedAt: AT });
        expect(await findAccount(db.pool, account.id)).toMatchObject({
            fundedMicros: 0,
            state: "closing",
            closingAt: AT,
        });
        expect((await readPool(db.pool)).committedMicros).toBe(0);
        expect(await routerEvents(start.order.id)).toEqual([
            expect.objectContaining({ phase: "paid", state: "dropped", droppedReason: "voided" }),
        ]);
        expect(await payerRow(PAYER)).toBeNull();
        expect(await attempt(null)).toBe(false);
    });

    it("keeps the payer row when the payer has another unvoided funding (F12)", async () => {
        const { account, start } = await fundedStart();
        const other = await seedAccount(db.pool, { handleSha256: "cd".repeat(32) });
        await seedFunding(db.pool, { accountId: other.id, payer: PAYER });
        expect(await inTx(start, (c, o, _p, a) => F.void(c, o, a, AT, null))).toBe(true);
        expect(await payerRow(PAYER)).toMatchObject({
            payer: PAYER,
            first_order_id: start.order.id,
        });
        expect(await findAccount(db.pool, account.id)).toMatchObject({ state: "closing" });
    });
});

describe("refund", () => {
    async function fundedAccount(spent: number) {
        const a = await seedAccount(db.pool);
        await seedFunding(db.pool, {
            accountId: a.id,
            allowanceMicros: 1_000_000,
            createdAt: T0,
            sourceTokenAccount: "src-a",
            payer: "payer-a",
        });
        await db.pool.query("update x402_accounts set spent_micros = $2 where id = $1", [
            a.id,
            spent,
        ]);
        await setPool(1_000_000, 0);
        return a;
    }

    it("allocates the unspent rest newest first, each at most its funding", async () => {
        const a = await seedAccount(db.pool);
        const f1 = await seedFunding(db.pool, {
            accountId: a.id,
            allowanceMicros: 1_000_000,
            createdAt: T0,
            sourceTokenAccount: "src-a",
            payer: "payer-a",
        });
        const f2 = await seedFunding(db.pool, {
            accountId: a.id,
            allowanceMicros: 500_000,
            createdAt: T1,
            sourceTokenAccount: "src-b",
            payer: "payer-b",
        });
        await db.pool.query("update x402_accounts set spent_micros = 700000 where id = $1", [a.id]);
        const out = await inAccountTx(a.id, (c, locked) => F.refund(c, locked, AT));
        expect(out).toMatchObject({ kind: "refund", amountMicros: 800_000 });
        expect(await allowanceRows(a.id)).toEqual([
            expect.objectContaining({
                kind: "allowance",
                reason: "x402_unspent",
                fromWallet: "allowance",
                state: "pending",
                amountMicros: 500_000,
                destination: "src-b",
                payer: "payer-b",
            }),
            expect.objectContaining({
                kind: "allowance",
                amountMicros: 300_000,
                destination: "src-a",
                payer: "payer-a",
            }),
        ]);
        expect(out.kind === "refund" && out.refundIds).toHaveLength(2);
        expect((await findAccount(db.pool, a.id))!.refundedMicros).toBe(800_000);
        const states = await db.pool.query("select state from orders where id = any($1)", [
            [f1.orderId, f2.orderId],
        ]);
        expect(states.rows.map((r) => r.state)).toEqual(["redeemed", "redeemed"]);
    });

    it("keeps an unspent rest under the minimum once", async () => {
        const a = await fundedAccount(996_000);
        expect(await inAccountTx(a.id, (c, l) => F.refund(c, l, AT))).toEqual({
            kind: "kept",
            keptMicros: 4_000,
        });
        expect(await routerEvents(a.id)).toEqual([
            expect.objectContaining({
                phase: "kept",
                payload: {
                    startOrderId: a.id,
                    orderId: a.id,
                    phase: "kept",
                    amountMicros: 0,
                    keptMicros: 4_000,
                    tx: "",
                },
            }),
        ]);
        expect((await readPool(db.pool)).committedMicros).toBe(996_000);
        expect((await findAccount(db.pool, a.id))!.keptMicros).toBe(4_000);
        expect(await inAccountTx(a.id, (c, l) => F.refund(c, l, AT))).toEqual({ kind: "none" });
        expect(await allowanceRows(a.id)).toEqual([]);
    });

    it("waits while money is held", async () => {
        const a = await fundedAccount(700_000);
        await db.pool.query("update x402_accounts set held_micros = 10000 where id = $1", [a.id]);
        expect(await inAccountTx(a.id, (c, l) => F.refund(c, l, AT))).toEqual({
            kind: "not_ready",
        });
        expect(await allowanceRows(a.id)).toEqual([]);
    });

    it("writes nothing for an unspent rest of 0", async () => {
        const a = await fundedAccount(1_000_000);
        expect(await inAccountTx(a.id, (c, l) => F.refund(c, l, AT))).toEqual({ kind: "none" });
        expect(await allowanceRows(a.id)).toEqual([]);
        expect(await routerEvents(a.id)).toEqual([]);
    });

    it("answers already once an allowance row exists", async () => {
        const a = await fundedAccount(700_000);
        expect(await inAccountTx(a.id, (c, l) => F.refund(c, l, AT))).toMatchObject({
            kind: "refund",
            amountMicros: 300_000,
        });
        expect(await inAccountTx(a.id, (c, l) => F.refund(c, l, AT))).toEqual({ kind: "already" });
        expect(await allowanceRows(a.id)).toHaveLength(1);
    });
});
