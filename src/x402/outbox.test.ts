import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "smol-toml";
import { parseSettings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { memoryLog } from "../log.ts";
import type { AppendResult, RouterClient, X402ResolvedInput } from "../router/client.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { until } from "../testing/app.ts";
import { seedOrder } from "../testing/orders.ts";
import { seedAccount, resetLedger, TEST_PAYTO } from "../testing/x402.ts";
import {
    dropPendingPaidEvent,
    enqueueAllowanceEvent,
    enqueueX402Resolved,
    paidEventSent,
    runOutbox,
} from "./outbox.ts";

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(() => resetLedger(db.pool));

const AT = new Date("2030-01-01T00:00:00Z");
const resolved = (over: Partial<X402ResolvedInput> = {}): X402ResolvedInput => ({
    startOrderId: "",
    ref: "abcdefghijklmnop",
    status: "paid",
    amountMicros: 10_000,
    tx: "1".repeat(63) + "2",
    at: AT,
    host: "agent402.tools",
    method: "POST",
    path: "/v1/auto/chat/completions",
    payTo: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    ...over,
});
const rows = async () => (await db.pool.query("select * from x402_router_events order by id")).rows;

describe("outbox writer", () => {
    it("writes one row per (order, phase) and per ref", async () => {
        const a = await seedAccount(db.pool);
        const e = {
            startOrderId: a.id,
            orderId: a.id,
            phase: "paid" as const,
            amountMicros: 1_000_000,
            keptMicros: 0,
            tx: null,
        };
        expect(await enqueueAllowanceEvent(db.pool, e, AT)).toBe(true);
        expect(await enqueueAllowanceEvent(db.pool, e, AT)).toBe(false);
        expect(await enqueueAllowanceEvent(db.pool, { ...e, phase: "kept" }, AT)).toBe(true);
        expect(await enqueueX402Resolved(db.pool, resolved({ startOrderId: a.id }), AT)).toBe(true);
        expect(await enqueueX402Resolved(db.pool, resolved({ startOrderId: a.id }), AT)).toBe(
            false,
        );
        const all = await rows();
        expect(all).toHaveLength(3);
        expect(all[0]).toMatchObject({
            kind: "allowance",
            start_order_id: a.id,
            order_id: a.id,
            phase: "paid",
            state: "pending",
            created_at: AT,
            next_at: AT,
            payload: {
                orderId: a.id,
                startOrderId: a.id,
                phase: "paid",
                amountMicros: 1_000_000,
                keptMicros: 0,
                tx: "",
            },
        });
        expect(all[2]).toMatchObject({
            kind: "x402_resolved",
            ref: "abcdefghijklmnop",
            order_id: null,
            phase: null,
        });
    });

    it("cuts the x402_resolved path to 80 characters", async () => {
        const a = await seedAccount(db.pool);
        const path = "/" + "a".repeat(99);
        await enqueueX402Resolved(db.pool, resolved({ startOrderId: a.id, path }), AT);
        const payload = (await rows())[0].payload;
        expect(payload.path).toBe(path.slice(0, 80));
        expect(payload.path).toHaveLength(80);
        expect(payload.at).toBe("2030-01-01T00:00:00.000Z");
    });

    it("cuts the path by code points", async () => {
        const a = await seedAccount(db.pool);
        const path = "/" + "\u{1F600}".repeat(99);
        await enqueueX402Resolved(db.pool, resolved({ startOrderId: a.id, path }), AT);
        expect(Array.from((await rows())[0].payload.path)).toHaveLength(80);
    });

    it("drops only a pending paid row", async () => {
        const a = await seedAccount(db.pool);
        const e = {
            startOrderId: a.id,
            orderId: a.id,
            phase: "paid" as const,
            amountMicros: 1_000_000,
            keptMicros: 0,
            tx: "sig",
        };
        await enqueueAllowanceEvent(db.pool, e, AT);
        expect(await paidEventSent(db.pool, a.id)).toBe(false);
        expect(await dropPendingPaidEvent(db.pool, a.id, "voided")).toBe(true);
        expect(await rows()).toEqual([
            expect.objectContaining({ state: "dropped", dropped_reason: "voided" }),
        ]);
        expect(await dropPendingPaidEvent(db.pool, a.id, "voided")).toBe(false);

        await resetLedger(db.pool);
        const b = await seedAccount(db.pool);
        await enqueueAllowanceEvent(db.pool, { ...e, startOrderId: b.id, orderId: b.id }, AT);
        await db.pool.query("update x402_router_events set state = 'sent', sent_at = $1", [AT]);
        expect(await paidEventSent(db.pool, b.id)).toBe(true);
        expect(await dropPendingPaidEvent(db.pool, b.id, "voided")).toBe(false);
        expect(await rows()).toEqual([expect.objectContaining({ state: "sent" })]);
    });
});

describe("runOutbox", () => {
    const T0 = new Date("2030-01-01T12:00:00Z");
    const later = (ms: number) => new Date(T0.getTime() + ms);
    const SIG = "1".repeat(63) + "2";
    const settings = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t");
    let log = memoryLog();
    beforeEach(() => {
        log = memoryLog();
    });

    const alarms = (name: string) => log.lines.filter((l) => l.alarm === name);
    const start = () => seedAccount(db.pool);
    const rowOf = async (orderId: string, phase: string) =>
        (
            await db.pool.query(
                "select * from x402_router_events where kind = 'allowance' and order_id = $1 and phase = $2",
                [orderId, phase],
            )
        ).rows[0];
    const deps = (router: RouterClient, at: Date) => ({
        pool: db.pool,
        router,
        x402: settings.x402,
        log,
        now: () => at,
    });
    const router = (
        answer: (kind: string, input: unknown) => AppendResult | Promise<AppendResult>,
    ) => {
        const calls: [string, unknown][] = [];
        const stub = {
            appendAllowanceEvent: async (i: unknown) => {
                calls.push(["allowance", i]);
                return answer("allowance", i);
            },
            appendX402Resolved: async (i: unknown) => {
                calls.push(["x402_resolved", i]);
                return answer("x402_resolved", i);
            },
        } as unknown as RouterClient;
        return { router: stub, calls };
    };
    const paidEvent = (id: string) =>
        enqueueAllowanceEvent(
            db.pool,
            {
                startOrderId: id,
                orderId: id,
                phase: "paid",
                amountMicros: 1_000_000,
                keptMicros: 0,
                tx: SIG,
            },
            T0,
        );
    const queueResolved = (startOrderId: string, i: number) =>
        enqueueX402Resolved(
            db.pool,
            {
                startOrderId,
                ref: "r" + String(i).padStart(15, "0"),
                status: "paid",
                amountMicros: 10_000,
                tx: SIG,
                at: T0,
                host: "seller.example",
                method: "GET",
                path: "/ok/x",
                payTo: TEST_PAYTO,
            },
            T0,
        );

    it("sends due rows, at most 50 a run", async () => {
        const s = await start();
        for (let i = 0; i < 60; i++) await queueResolved(s.id, i);
        const r = router(() => "ok");
        expect(await runOutbox(deps(r.router, T0))).toEqual({ sent: 50, dropped: 0, retried: 0 });
        expect(await runOutbox(deps(r.router, T0))).toEqual({ sent: 10, dropped: 0, retried: 0 });
    });

    it("OK marks sent", async () => {
        const s = await start();
        await paidEvent(s.id);
        await runOutbox(deps(router(() => "ok").router, later(1)));
        expect(await rowOf(s.id, "paid")).toMatchObject({
            state: "sent",
            sent_at: later(1),
            attempts: 1,
        });
    });

    it("ORDER_UNKNOWN keeps an allowance row retrying with backoff", async () => {
        const s = await start();
        await paidEvent(s.id);
        const steps: number[] = [];
        let at = T0;
        for (let i = 0; i < 10; i++) {
            await runOutbox(deps(router(() => "order_unknown").router, at));
            const r = await rowOf(s.id, "paid");
            expect(r.state).toBe("pending");
            steps.push(r.next_at.getTime() - at.getTime());
            at = r.next_at;
        }
        expect(steps).toEqual([
            2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
        ]);
    });

    it("void drops a pending paid row", async () => {
        const s = await start();
        await paidEvent(s.id);
        await dropPendingPaidEvent(db.pool, s.id, "voided");
        const r = router(() => "ok");
        await runOutbox(deps(r.router, T0));
        expect(r.calls).toHaveLength(0);
        expect(await rowOf(s.id, "paid")).toMatchObject({
            state: "dropped",
            dropped_reason: "voided",
        });
    });

    it("ORDER_UNKNOWN drops an x402_resolved row and alarms x402_event_dropped", async () => {
        const s = await start();
        await queueResolved(s.id, 1);
        expect(await runOutbox(deps(router(() => "order_unknown").router, T0))).toEqual({
            sent: 0,
            dropped: 1,
            retried: 0,
        });
        expect(
            (await db.pool.query("select state, dropped_reason from x402_router_events")).rows,
        ).toEqual([{ state: "dropped", dropped_reason: "order_unknown" }]);
        expect(alarms("x402_event_dropped")).toEqual([
            expect.objectContaining({ startOrderId: s.id, ref: "r000000000000001" }),
        ]);
    });

    it("InvalidArgument drops at once and alarms x402_event_refused", async () => {
        const s = await start();
        await queueResolved(s.id, 1);
        expect(await runOutbox(deps(router(() => "invalid").router, T0))).toMatchObject({
            dropped: 1,
        });
        expect((await db.pool.query("select dropped_reason from x402_router_events")).rows).toEqual(
            [{ dropped_reason: "invalid" }],
        );
        expect(alarms("x402_event_refused")).toEqual([
            expect.objectContaining({ kind: "x402_resolved", startOrderId: s.id }),
        ]);
    });

    it("anything else retries", async () => {
        const s = await start();
        await queueResolved(s.id, 1);
        expect(await runOutbox(deps(router(() => "retry").router, T0))).toEqual({
            sent: 0,
            dropped: 0,
            retried: 1,
        });
        expect(
            (await db.pool.query("select state, attempts, next_at from x402_router_events")).rows,
        ).toEqual([{ state: "pending", attempts: 1, next_at: later(2_000) }]);
    });

    it("x402_events_stuck after 10 minutes for a redeemed start order", async () => {
        const s = await start();
        const { order: paid } = await seedOrder(db.pool, { state: "paid" });
        await queueResolved(s.id, 1);
        await queueResolved(paid.id, 2);
        const r = router(() => "retry");
        await runOutbox(deps(r.router, later(600_000)));
        expect(alarms("x402_events_stuck")).toHaveLength(0);
        await runOutbox(deps(r.router, later(600_001)));
        await runOutbox(deps(r.router, later(600_002)));
        expect(alarms("x402_events_stuck")).toEqual([
            expect.objectContaining({ startOrderId: s.id }),
        ]);
    });

    it("the outbox across a restart", async () => {
        const s = await start();
        await enqueueAllowanceEvent(
            db.pool,
            {
                startOrderId: s.id,
                orderId: s.id,
                phase: "kept",
                amountMicros: 0,
                keptMicros: 4_000,
                tx: null,
            },
            T0,
        );
        await queueResolved(s.id, 1);
        const r = router(() => "ok");
        expect(await runOutbox(deps(r.router, T0))).toMatchObject({ sent: 2 });
        expect(r.calls).toEqual(
            expect.arrayContaining([
                [
                    "allowance",
                    {
                        orderId: s.id,
                        startOrderId: s.id,
                        phase: "kept",
                        amountMicros: 0,
                        keptMicros: 4_000,
                        tx: "",
                    },
                ],
                [
                    "x402_resolved",
                    {
                        startOrderId: s.id,
                        ref: "r000000000000001",
                        status: "paid",
                        amountMicros: 10_000,
                        tx: SIG,
                        at: T0,
                        host: "seller.example",
                        method: "GET",
                        path: "/ok/x",
                        payTo: TEST_PAYTO,
                    },
                ],
            ]),
        );
    });

    it("the row lock is held through the call", async () => {
        const s = await start();
        await paidEvent(s.id);
        let release = () => {};
        const gate = new Promise<void>((r) => (release = r));
        const r = router(async (): Promise<AppendResult> => {
            await gate;
            return "ok";
        });
        const run = runOutbox(deps(r.router, T0));
        await until(async () => r.calls.length === 1, 2_000);
        let dropped: boolean | undefined;
        const drop = withTx(db.pool, (c) => dropPendingPaidEvent(c, s.id, "voided")).then(
            (v) => (dropped = v),
        );
        await new Promise((res) => setTimeout(res, 200));
        expect(dropped).toBeUndefined();
        release();
        await Promise.all([run, drop]);
        expect(dropped).toBe(false);
        expect((await rowOf(s.id, "paid")).state).toBe("sent");
    });
});
