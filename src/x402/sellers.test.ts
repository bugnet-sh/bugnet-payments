import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "../testing/db.ts";
import { resetLedger, seedAccount, seedX402Payment } from "../testing/x402.ts";
import { parseHosts, sellerStats } from "./sellers.ts";

const DAY = 86_400_000;
const t0 = new Date("2030-01-01T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(() => resetLedger(db.pool));

describe("sellerStats", () => {
    it("counts the last 30 days per host and lists every asked host", async () => {
        const a = await seedAccount(db.pool, {});
        const host = "a.example";
        for (let i = 0; i < 3; i++) {
            await seedX402Payment(db.pool, {
                accountId: a.id,
                host,
                state: "confirmed",
                endedClean: true,
                createdAt: at(-DAY),
            });
        }
        await seedX402Payment(db.pool, {
            accountId: a.id,
            host,
            state: "failed_onchain",
            createdAt: at(-DAY),
        });
        await seedX402Payment(db.pool, {
            accountId: a.id,
            host,
            state: "confirmed",
            endedClean: true,
            createdAt: at(-31 * DAY),
        });
        expect(await sellerStats(db.pool, [host, "b.example"], t0)).toEqual({
            "a.example": { paidCalls30d: 3, failedPaid30d: 1 },
            "b.example": { paidCalls30d: 0, failedPaid30d: 0 },
        });
    });

    it("keeps late-landed and unclean confirmed payments apart", async () => {
        const a = await seedAccount(db.pool, {});
        const host = "c.example";
        const mk = (over: object) =>
            seedX402Payment(db.pool, { accountId: a.id, host, createdAt: at(-DAY), ...over });
        await mk({ state: "confirmed", lateLanded: true, endedClean: true });
        await mk({ state: "confirmed", endedClean: false });
        await mk({ state: "expired_unlanded" });
        await mk({ state: "released" });
        expect(await sellerStats(db.pool, [host], t0)).toEqual({
            [host]: { paidCalls30d: 1, failedPaid30d: 2 },
        });
    });
});

describe("parseHosts", () => {
    it("splits, drops empties and repeats, and bounds the count", () => {
        expect(parseHosts("a.example,,b.example,a.example")).toEqual(["a.example", "b.example"]);
        const many = Array.from({ length: 21 }, (_, i) => `h${i}.example`).join(",");
        expect(parseHosts(many)).toBeNull();
        expect(parseHosts(null)).toBeNull();
        expect(parseHosts("")).toBeNull();
        expect(parseHosts(`${"a".repeat(254)}`)).toBeNull();
    });
});
