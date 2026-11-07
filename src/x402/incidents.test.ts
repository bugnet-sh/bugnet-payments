import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTx } from "../db/pool.ts";
import { type Log, memoryLog, silentLog } from "../log.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { readControls } from "./controls.ts";
import { type IncidentFact, openIncidents, recordIncident, resolveIncident } from "./incidents.ts";

const AT = new Date("2026-11-07T10:00:00Z");
const FACT: IncidentFact = {
    kind: "balance_short",
    subject: "balance_short",
    detail: { short: 5 },
};

let db: TestDb;
beforeEach(async () => {
    db = await testDb();
});
afterEach(async () => {
    await db.close();
});

const record = (log: Log, f: IncidentFact = FACT) =>
    withTx(db.pool, (c) => recordIncident(c, f, log, AT));

describe("x402 incidents", () => {
    it("one open row per kind and subject, and the pause", async () => {
        const log = memoryLog();
        expect(await record(log)).toBe(true);
        expect(await record(log)).toBe(false);
        expect(await readControls(db.pool)).toMatchObject({
            paused: true,
            reason: "incident balance_short",
        });
        const alarms = log.lines.filter((l) => l.level === "alarm");
        expect(alarms).toHaveLength(1);
        expect(alarms[0]).toMatchObject({ alarm: "x402_incident", kind: "balance_short" });
        expect(await openIncidents(db.pool)).toHaveLength(1);
    });
    it("resolve then record again", async () => {
        await record(silentLog);
        const [row] = await openIncidents(db.pool);
        expect(await resolveIncident(db.pool, row!.id, "rpc lag, covered", AT)).toBe(true);
        expect(await resolveIncident(db.pool, row!.id, "again", AT)).toBe(false);
        expect(await openIncidents(db.pool)).toEqual([]);
        expect(await record(silentLog)).toBe(true);
    });
    it("lossMicros defaults to 0", async () => {
        await record(silentLog);
        expect((await openIncidents(db.pool))[0]).toMatchObject({
            kind: "balance_short",
            subject: "balance_short",
            lossMicros: 0,
            paymentId: null,
            refundId: null,
            coldTransferId: null,
            detail: { short: 5 },
            createdAt: AT,
            resolvedAt: null,
            resolution: null,
        });
    });
    it("a subject of its own is a second open row", async () => {
        await record(silentLog);
        const other = { ...FACT, kind: "unknown_change", subject: "1".repeat(63) + "2" } as const;
        expect(await record(silentLog, other)).toBe(true);
        expect(await openIncidents(db.pool)).toHaveLength(2);
    });
});
