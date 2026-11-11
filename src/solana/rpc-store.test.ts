import { createHmac, hkdfSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedAllowanceOrder, seedOrder, seedPayment } from "../testing/orders.ts";
import type { RouterSnapshot, VerdictRow } from "./router/index.ts";
import {
    endpointFingerprint,
    historyProbe,
    pgSnapshotStore,
    pgUsageStore,
    pgVerdictStore,
    readSnapshot,
} from "./rpc-store.ts";

const AT = new Date("2026-11-10T14:00:15.000Z");
const ATA = "AtaRecipient1111111111111111111111111111111";
const FP = "0123456789abcdef0123456789abcdef";

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await db.pool.query("truncate orders, rpc_usage, rpc_health, rpc_verdicts cascade");
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
    try {
        await p;
    } catch (err) {
        return (err as { code?: string }).code;
    }
    return undefined;
}

describe("pgVerdictStore", () => {
    const no: VerdictRow = {
        fingerprint: FP,
        endpoint: "rpc2",
        noAt: Date.parse("2026-11-10T13:00:00.123Z"),
        reason: "found_then_missing",
        historyPassed: true,
    };

    it("verdicts round-trip by fingerprint", async () => {
        const store = pgVerdictStore(db.pool, () => AT);
        await store.save(no);
        expect(await store.load()).toEqual([no]);
        const cleared: VerdictRow = { ...no, endpoint: "rpc3", noAt: null, reason: null };
        await store.save(cleared);
        expect(await store.load()).toEqual([cleared]);
        const stored = await db.pool.query("select updated_at from rpc_verdicts");
        expect(stored.rows).toEqual([{ updated_at: AT }]);

        expect(await codeOf(store.save({ ...no, fingerprint: "0123" }))).toBe("23514");
        expect(await codeOf(store.save({ ...no, fingerprint: FP.toUpperCase() }))).toBe("23514");
        expect(await codeOf(store.save({ ...no, endpoint: "a.example" }))).toBe("23514");
        expect(await codeOf(store.save({ ...no, noAt: null }))).toBe("23514");
        expect(await store.load()).toEqual([cleared]);
    });
});

describe("endpointFingerprint", () => {
    it("a fingerprint follows the URL and the key only", () => {
        const key = Buffer.alloc(32, 1);
        const fp = endpointFingerprint(key);
        const a = fp("https://a.example");
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(fp("https://a.example/")).toBe(a);
        expect(fp("https://b.example")).not.toBe(a);
        expect(endpointFingerprint(Buffer.alloc(32, 2))("https://a.example")).not.toBe(a);

        const derived = Buffer.from(
            hkdfSync("sha256", key, Buffer.alloc(0), "bugnet rpc endpoint fingerprint", 32),
        );
        const hmac = createHmac("sha256", derived).update("https://a.example/").digest("hex");
        expect(a).toBe(hmac.slice(0, 32));

        const secret = "0123456789abcdef0123456789abcdef";
        const keyed = `https://one.x.example/${secret}?api-key=k1`;
        const value = fp(keyed);
        for (const part of [secret, "one.x.example", "k1", "https"]) {
            expect(value).not.toContain(part);
        }
        expect(() => fp("not a url")).toThrow("rpc endpoint fingerprint: not a URL");
    });
});

describe("pgUsageStore", () => {
    it("usage adds up", async () => {
        const store = pgUsageStore(db.pool);
        await store.add("2026-11", [{ endpoint: "rpc1", requests: 3, background: 1 }]);
        await store.add("2026-11", [{ endpoint: "rpc1", requests: 3, background: 1 }]);
        expect(await store.load("2026-11")).toEqual({ rpc1: { requests: 6, background: 2 } });
    });

    it("load reads one month", async () => {
        const store = pgUsageStore(db.pool);
        await store.add("2026-10", [{ endpoint: "rpc1", requests: 9, background: 4 }]);
        await store.add("2026-11", [
            { endpoint: "rpc1", requests: 3, background: 1 },
            { endpoint: "rpc2", requests: 2, background: 0 },
        ]);
        expect(await store.load("2026-11")).toEqual({
            rpc1: { requests: 3, background: 1 },
            rpc2: { requests: 2, background: 0 },
        });
        expect(await store.load("2026-12")).toEqual({});
    });

    it("a bad month is refused", async () => {
        const store = pgUsageStore(db.pool);
        const row = { endpoint: "rpc1", requests: 1, background: 0 };
        expect(await codeOf(store.add("2026-1", [row]))).toBe("23514");
    });

    it("only a position name is stored", async () => {
        const store = pgUsageStore(db.pool);
        const row = (endpoint: string) => [{ endpoint, requests: 1, background: 0 }];
        expect(await codeOf(store.add("2026-11", row("a.example")))).toBe("23514");
        expect(await codeOf(store.add("2026-11", row("primary")))).toBe("23514");
        expect(await codeOf(store.add("2026-11", row("rpc0")))).toBe("23514");
        await store.add("2026-11", row("rpc12"));
        expect(await store.load("2026-11")).toEqual({ rpc12: { requests: 1, background: 0 } });
    });

    it("rows of one endpoint in one add are summed", async () => {
        const store = pgUsageStore(db.pool);
        await store.add("2026-11", [
            { endpoint: "rpc1", requests: 2, background: 1 },
            { endpoint: "rpc1", requests: 5, background: 0 },
        ]);
        await store.add("2026-11", []);
        expect(await store.load("2026-11")).toEqual({ rpc1: { requests: 7, background: 1 } });
    });
});

function snapshotAt(at: number, serving: string | null): RouterSnapshot {
    return {
        at,
        mode: "routed",
        serving,
        domains: 2,
        absenceQuorum: 2,
        sendFanout: 1,
        endpoints: [
            {
                name: "rpc1",
                roles: ["read", "history", "send"],
                state: "cooling",
                untilMs: at + 7_000,
                latencyMs: 84.5,
                errorRate: 0.25,
                inflight: 1,
                confirmedSlot: "467621707",
                lag: 0,
                consistent: "yes",
                limits: { "*": 80, getTransaction: 8 },
                monthRequests: 412_334,
                monthBackground: 127_823,
                hourRequests: 40,
                laneRequests: { money: 28, background: 12 },
                outcomes: { getSlot: { ok: 2, http_429: 1 } },
                checks: {
                    genesis: "ok",
                    history: "ok",
                    pinnedAccounts: "ok",
                    pinnedSignatures: "ignored",
                },
                lastError: { at: at - 1_000, err: "SolanaError", status: 429 },
            },
            {
                name: "rpc2",
                roles: ["read", "send"],
                state: "unchecked",
                untilMs: null,
                latencyMs: 0,
                errorRate: 0,
                inflight: 0,
                confirmedSlot: null,
                lag: null,
                consistent: "unknown",
                limits: {},
                monthRequests: 0,
                monthBackground: 0,
                hourRequests: 0,
                laneRequests: { money: 0, background: 0 },
                outcomes: {},
                checks: {
                    genesis: "error http_400",
                    history: "unchecked",
                    pinnedAccounts: "unchecked",
                    pinnedSignatures: "unchecked",
                },
                lastError: null,
            },
        ],
    };
}

describe("pgSnapshotStore", () => {
    it("the snapshot round-trips", async () => {
        let now = AT;
        const store = pgSnapshotStore(db.pool, () => now);
        const s = snapshotAt(AT.getTime(), "rpc1");
        await store.write(s);
        expect(await readSnapshot(db.pool)).toStrictEqual({ snapshot: s, writtenAt: AT });

        now = new Date(AT.getTime() + 15_000);
        const next = snapshotAt(now.getTime(), null);
        await store.write(next);
        expect(await readSnapshot(db.pool)).toStrictEqual({ snapshot: next, writtenAt: now });
        const count = await db.pool.query("select count(*)::int as n from rpc_health");
        expect(count.rows).toEqual([{ n: 1 }]);
    });

    it("no snapshot yet", async () => {
        expect(await readSnapshot(db.pool)).toBeNull();
    });
});

describe("historyProbe", () => {
    const FIRST = new Date("2030-01-01T00:00:00Z");
    const SECOND = new Date("2030-01-01T00:00:30Z");
    const THIRD = new Date("2030-01-01T00:02:00Z");

    async function cold(signature: string, confirmedAt: Date, createdAt = confirmedAt) {
        const { order } = await seedOrder(db.pool, { state: "paid" });
        await seedPayment(db.pool, order.id, {
            txSignature: signature,
            status: "confirmed",
            createdAt,
            confirmedAt,
        });
    }

    async function settling(signature: string, at: Date): Promise<void> {
        const { order } = await seedOrder(db.pool, { state: "settling" });
        // A confirmed_at on a settling row shows that the status decides, not the time
        await seedPayment(db.pool, order.id, {
            txSignature: signature,
            status: "settling",
            createdAt: at,
            confirmedAt: at,
        });
    }

    async function allowance(signature: string, confirmedAt: Date): Promise<void> {
        const { order } = await seedAllowanceOrder(db.pool, { state: "paid" });
        await seedPayment(db.pool, order.id, {
            txSignature: signature,
            status: "confirmed",
            createdAt: confirmedAt,
            confirmedAt,
        });
    }

    it("the history probe is the oldest confirmed payment and one a minute younger", async () => {
        await settling("sig-settling", new Date("2029-12-31T00:00:00Z"));
        expect(await historyProbe(db.pool, ATA)).toBeNull();
        await cold("sig-first", FIRST);
        expect(await historyProbe(db.pool, ATA)).toEqual({
            address: ATA,
            oldest: "sig-first",
            later: null,
        });
        await cold("sig-second", SECOND);
        await cold("sig-third", THIRD);
        expect(await historyProbe(db.pool, ATA)).toEqual({
            address: ATA,
            oldest: "sig-first",
            later: "sig-third",
        });
    });

    it("a payment the reconciler confirmed late is not later", async () => {
        // A landed first but was confirmed last, so a page before A could never hold B
        await cold("sig-a", new Date("2030-01-01T00:03:00Z"), FIRST);
        await cold("sig-b", SECOND);
        expect(await historyProbe(db.pool, ATA)).toEqual({
            address: ATA,
            oldest: "sig-b",
            later: null,
        });
        await cold("sig-c", THIRD);
        expect(await historyProbe(db.pool, ATA)).toEqual({
            address: ATA,
            oldest: "sig-b",
            later: "sig-c",
        });
    });

    it("the history probe skips allowance payments", async () => {
        await allowance("sig-allowance-early", new Date("2029-12-31T23:00:00Z"));
        await allowance("sig-allowance-minute", new Date("2030-01-01T00:01:00Z"));
        expect(await historyProbe(db.pool, ATA)).toBeNull();
        await cold("sig-first", FIRST);
        await cold("sig-second", SECOND);
        await cold("sig-third", THIRD);
        expect(await historyProbe(db.pool, ATA)).toEqual({
            address: ATA,
            oldest: "sig-first",
            later: "sig-third",
        });
    });
});
