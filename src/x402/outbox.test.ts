import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedAccount, resetLedger } from "../testing/x402.ts";
import type { X402ResolvedInput } from "../router/client.ts";
import {
    dropPendingPaidEvent,
    enqueueAllowanceEvent,
    enqueueX402Resolved,
    paidEventSent,
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
