import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "smol-toml";
import { parseSettings } from "../config.ts";
import { memoryLog } from "../log.ts";
import { findOrder } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { findRefund, requestRefund } from "../refunds/request.ts";
import { writeHotPartial } from "../refunds/hot.ts";
import type { LookupKey, PlacementLookup, PlacementState, RouterClient } from "../router/client.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import {
    resetLedger,
    seedAccount,
    seedFunding,
    seedX402Payment,
    TEST_PAYTO,
} from "../testing/x402.ts";
import { type CloseDeps, runCloseCheck, runCloseJob } from "./close.ts";
import { createAllowanceFunding } from "./funding.ts";
import { findAccount } from "./ledger.ts";
import type { AccountRow } from "./types.ts";

const T0 = new Date("2030-01-01T12:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const P = TEST_PAYTO;
const S = "1".repeat(32);
const HOT_START = {
    kind: "start",
    payInto: "allowance",
    allowanceMicros: 1_000_000,
    feeMicros: 3_000,
    amountMicros: 1_013_000,
} as const;
const due = { deadline: later(-600_001), handleSha256: null };
const settings = parseSettings(stringify({ solana: { recipient: P } }), "t");

let db: TestDb;
let log = memoryLog();
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    log = memoryLog();
    await resetLedger(db.pool);
    await db.pool.query("truncate x402_cold_transfers, x402_chain_txs, x402_refund_days cascade");
});

const alarms = (name: string) => log.lines.filter((l) => l.alarm === name);

function lookups(answer: (key: LookupKey) => PlacementLookup) {
    const keys: LookupKey[] = [];
    const router = {
        lookupPlacement: async (key: LookupKey) => {
            keys.push(key);
            return answer(key);
        },
    } as unknown as RouterClient;
    return { router, keys };
}
const nobody = lookups(() => ({ kind: "unknown" })).router;

function deps(router: RouterClient, at: Date): CloseDeps {
    return {
        pool: db.pool,
        router,
        funding: createAllowanceFunding({ x402: settings.x402, log }),
        x402: settings.x402,
        orders: settings.orders,
        log,
        now: () => at,
    };
}

const found = (state: PlacementState, deadline: Date | null = null): PlacementLookup => ({
    kind: "found",
    placementId: "8f9c0a52-0000-4000-8000-000000000001",
    startOrderId: "",
    state,
    deadline,
    endedAt: null,
    x402Capable: true,
    packageId: "cpu-small",
});

// seedFunding raises funded_micros by the allowance itself, so it is set back afterwards.
async function closing(over: Partial<AccountRow> = {}): Promise<AccountRow> {
    const a = await seedAccount(db.pool, {
        state: "closing",
        closingAt: T0,
        fundedMicros: 1_000_000,
        ...over,
    });
    await seedFunding(db.pool, {
        accountId: a.id,
        orderId: a.id,
        allowanceMicros: 1_000_000,
        payer: P,
        sourceTokenAccount: S,
    });
    await db.pool.query("update x402_accounts set funded_micros = 1000000 where id = $1", [a.id]);
    await db.pool.query("update x402_pool set committed_micros = 1000000");
    return (await findAccount(db.pool, a.id))!;
}

const count = async (sql: string) => (await db.pool.query(sql)).rowCount;

describe("runCloseCheck", () => {
    it("terminated or failed closes", async () => {
        for (const state of ["terminated", "failed"] as const) {
            await resetLedger(db.pool);
            const a = await seedAccount(db.pool, due);
            const r = lookups(() => found(state));
            expect(await runCloseCheck(deps(r.router, T0))).toEqual({
                closing: 1,
                waiting: 0,
                failing: 0,
            });
            expect(r.keys).toEqual([{ startOrderId: a.id }]);
            expect(await findAccount(db.pool, a.id)).toMatchObject({
                state: "closing",
                closingAt: T0,
            });
        }
    });

    it("NotFound with the start order refunding, refunded or manual closes", async () => {
        for (const state of ["refunding", "refunded", "manual"] as const) {
            const { order } = await seedOrder(db.pool, { ...HOT_START, state });
            await seedAccount(db.pool, { id: order.id, ...due });
        }
        const r = lookups(() => ({ kind: "unknown" }));
        expect(await runCloseCheck(deps(r.router, T0))).toEqual({
            closing: 3,
            waiting: 0,
            failing: 0,
        });
    });

    it("NotFound with a redeemed order the router confirmed, past its token expiry plus 2 minutes, closes", async () => {
        const seed = async (o: Partial<OrderRow>) => {
            const { order } = await seedOrder(db.pool, { ...HOT_START, state: "redeemed", ...o });
            return seedAccount(db.pool, { id: order.id, ...due });
        };
        const confirmed = await seed({
            tokenExpiresAt: later(-120_001),
            routerConfirmedAt: later(-3_600_000),
        });
        const seen = await seed({
            tokenExpiresAt: later(-120_001),
            eventSeenAt: later(-3_600_000),
        });
        const edge = await seed({
            tokenExpiresAt: later(-120_000),
            routerConfirmedAt: later(-3_600_000),
        });
        const r = lookups(() => ({ kind: "unknown" }));
        expect(await runCloseCheck(deps(r.router, T0))).toEqual({
            closing: 2,
            waiting: 1,
            failing: 0,
        });
        expect((await findAccount(db.pool, confirmed.id))!.state).toBe("closing");
        expect((await findAccount(db.pool, seen.id))!.state).toBe("closing");
        expect((await findAccount(db.pool, edge.id))!.state).toBe("open");
    });

    it("NotFound with a paid unredeemed order waits", async () => {
        const { order } = await seedOrder(db.pool, { ...HOT_START, state: "paid" });
        await seedAccount(db.pool, { id: order.id, ...due });
        const r = lookups(() => ({ kind: "unknown" }));
        expect(await runCloseCheck(deps(r.router, T0))).toEqual({
            closing: 0,
            waiting: 1,
            failing: 0,
        });
        expect((await findAccount(db.pool, order.id))!.state).toBe("open");
    });

    it("the close check leaves a redeemed order the router never confirmed to sweeper rule 4 or 5", async () => {
        const { order } = await seedOrder(db.pool, {
            ...HOT_START,
            state: "redeemed",
            tokenExpiresAt: later(-3_600_000),
        });
        await seedAccount(db.pool, { id: order.id, ...due });
        await runCloseCheck(deps(lookups(() => ({ kind: "unknown" })).router, T0));
        expect((await findAccount(db.pool, order.id))!.state).toBe("open");
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "redeemed",
            manualReason: null,
        });
        expect(await count("select 1 from refunds")).toBe(0);
    });

    it("placing or ready stores the deadline and waits", async () => {
        const D = new Date("2030-01-01T13:00:00Z");
        for (const state of ["placing", "ready"] as const) {
            await resetLedger(db.pool);
            const a = await seedAccount(db.pool, due);
            const r = lookups(() => found(state, D));
            expect(await runCloseCheck(deps(r.router, T0))).toEqual({
                closing: 0,
                waiting: 1,
                failing: 0,
            });
            expect(await findAccount(db.pool, a.id)).toMatchObject({
                state: "open",
                deadline: D,
                placementId: "8f9c0a52-0000-4000-8000-000000000001",
            });
        }
    });

    it("errors set close_check_failing_since; an answer clears it; x402_close_unverifiable after 30 minutes", async () => {
        const a = await seedAccount(db.pool, due);
        const down = lookups(() => ({ kind: "unavailable" }));
        expect(await runCloseCheck(deps(down.router, T0))).toEqual({
            closing: 0,
            waiting: 0,
            failing: 1,
        });
        expect((await findAccount(db.pool, a.id))!.closeCheckFailingSince).toEqual(T0);
        await runCloseCheck(deps(down.router, later(1_800_000)));
        expect((await findAccount(db.pool, a.id))!.closeCheckFailingSince).toEqual(T0);
        expect(alarms("x402_close_unverifiable")).toHaveLength(0);
        await runCloseCheck(deps(down.router, later(1_800_001)));
        await runCloseCheck(deps(down.router, later(1_800_002)));
        expect(alarms("x402_close_unverifiable")).toEqual([
            expect.objectContaining({ accountId: a.id }),
        ]);
        await runCloseCheck(
            deps(lookups(() => found("ready", later(-600_001))).router, later(1_800_003)),
        );
        expect((await findAccount(db.pool, a.id))!.closeCheckFailingSince).toBeNull();
    });

    it("selects only open accounts 10 minutes past the deadline, or created 10 minutes ago without one", async () => {
        const past = await seedAccount(db.pool, { handleSha256: null, deadline: later(-600_001) });
        await seedAccount(db.pool, { handleSha256: null, deadline: later(-600_000) });
        const old = await seedAccount(db.pool, {
            handleSha256: null,
            deadline: null,
            createdAt: later(-600_001),
        });
        await seedAccount(db.pool, {
            handleSha256: null,
            deadline: null,
            createdAt: later(-600_000),
        });
        await seedAccount(db.pool, {
            handleSha256: null,
            deadline: later(-3_600_000),
            state: "closing",
            closingAt: T0,
        });
        const r = lookups(() => found("ready", later(3_600_000)));
        await runCloseCheck(deps(r.router, T0));
        expect(r.keys.map((k) => "startOrderId" in k && k.startOrderId).sort()).toEqual(
            [past.id, old.id].sort(),
        );
    });
});

describe("runCloseJob", () => {
    it("waits while any row is reserved or signed; x402_close_slow after 10 minutes", async () => {
        const a = await closing({ heldMicros: 10_000 });
        await seedX402Payment(db.pool, { accountId: a.id, state: "signed", amountMicros: 10_000 });
        const d = (ms: number) => deps(nobody, later(ms));
        expect(await runCloseJob(d(600_000))).toEqual({
            refunded: 0,
            kept: 0,
            closed: 0,
            waiting: 1,
        });
        expect(alarms("x402_close_slow")).toHaveLength(0);
        await runCloseJob(d(600_001));
        await runCloseJob(d(600_002));
        expect(alarms("x402_close_slow")).toEqual([expect.objectContaining({ accountId: a.id })]);
        expect(await count("select 1 from refunds")).toBe(0);
    });

    it("unspent 0 closes with no event and no row", async () => {
        const a = await closing({ spentMicros: 1_000_000 });
        expect(await runCloseJob(deps(nobody, T0))).toEqual({
            refunded: 0,
            kept: 0,
            closed: 1,
            waiting: 0,
        });
        expect(await findAccount(db.pool, a.id)).toMatchObject({ state: "closed", closedAt: T0 });
        expect(await count("select 1 from refunds")).toBe(0);
        expect(await count("select 1 from x402_router_events where phase <> 'paid'")).toBe(0);
    });

    it("under $0.01 keeps it once, with a kept event, and closes", async () => {
        const a = await closing({ spentMicros: 996_000 });
        expect(await runCloseJob(deps(nobody, T0))).toEqual({
            refunded: 0,
            kept: 1,
            closed: 1,
            waiting: 0,
        });
        expect(await findAccount(db.pool, a.id)).toMatchObject({
            state: "closed",
            keptMicros: 4_000,
        });
        const kept = await db.pool.query(
            "select order_id from x402_router_events where phase = 'kept'",
        );
        expect(kept.rows).toEqual([{ order_id: a.id }]);
        await runCloseJob(deps(nobody, later(5_000)));
        expect(await count("select 1 from x402_router_events where phase = 'kept'")).toBe(1);
    });

    it("refunds the unspent rest and closes once each row is confirmed or manual", async () => {
        for (const end of ["confirmed", "manual"] as const) {
            await resetLedger(db.pool);
            const a = await closing({ spentMicros: 700_000 });
            expect(await runCloseJob(deps(nobody, T0))).toEqual({
                refunded: 1,
                kept: 0,
                closed: 0,
                waiting: 0,
            });
            const row = (await findRefund(db.pool, a.id, "allowance"))!;
            expect(row).toMatchObject({
                amountMicros: 300_000,
                fromWallet: "allowance",
                destination: S,
                payer: P,
            });
            expect(await runCloseJob(deps(nobody, later(5_000)))).toMatchObject({
                refunded: 0,
                closed: 0,
            });
            await db.pool.query("update refunds set state = $2 where id = $1", [row.id, end]);
            expect(await runCloseJob(deps(nobody, later(10_000)))).toMatchObject({ closed: 1 });
            expect(await findAccount(db.pool, a.id)).toMatchObject({
                state: "closed",
                closedAt: later(10_000),
            });
        }
    });

    it("a provider_failed end after 10 paid calls returns the allowance minus the spend, never more", async () => {
        const { order } = await seedOrder(db.pool, { ...HOT_START, state: "redeemed" });
        await seedPayment(db.pool, order.id, { status: "confirmed" });
        const a = await closing({ id: order.id, spentMicros: 100_000 });
        expect(await writeHotPartial(db.pool, order.id, 8_000, T0)).toBe("created");
        await runCloseJob(deps(nobody, T0));
        expect((await findRefund(db.pool, a.id, "allowance"))!.amountMicros).toBe(900_000);
        const sum = await db.pool.query(
            "select sum(amount_micros)::int as s from refunds where order_id = $1",
            [order.id],
        );
        expect(sum.rows[0].s).toBe(908_000);
        expect(sum.rows[0].s).toBeLessThanOrEqual(1_013_000);
    });

    it("the close never refunds the allowance first and parks the package", async () => {
        const { order } = await seedOrder(db.pool, { ...HOT_START, state: "paid" });
        await seedPayment(db.pool, order.id, { status: "confirmed" });
        await seedAccount(db.pool, { id: order.id, ...due });
        await seedFunding(db.pool, {
            accountId: order.id,
            orderId: order.id,
            allowanceMicros: 1_000_000,
        });
        await db.pool.query("update x402_pool set committed_micros = 1000000");
        const d = deps(lookups(() => ({ kind: "unknown" })).router, T0);
        expect(await runCloseCheck(d)).toMatchObject({ closing: 0, waiting: 1 });
        // sweeper rule 2's unredeemed refund, as Task 30 wires it
        expect(
            await requestRefund(db.pool, order.id, "unredeemed", {
                funding: d.funding,
                at: T0,
                log,
            }),
        ).toBe("created");
        expect((await findAccount(db.pool, order.id))!.state).toBe("closing");
        expect(await runCloseJob(d)).toEqual({ refunded: 0, kept: 0, closed: 1, waiting: 0 });
        expect(await findRefund(db.pool, order.id, "allowance")).toBeNull();
        expect(await findOrder(db.pool, order.id)).toMatchObject({ state: "refunding" });
    });

    it("a restart resumes", async () => {
        const a = await closing({ spentMicros: 700_000 });
        await runCloseJob(deps(nobody, T0));
        await runCloseJob(deps(nobody, later(5_000)));
        const rows = await db.pool.query("select 1 from refunds where order_id = $1", [a.id]);
        expect(rows.rowCount).toBe(1);
        expect((await findAccount(db.pool, a.id))!.refundedMicros).toBe(300_000);
    });
});
