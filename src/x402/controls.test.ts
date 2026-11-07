import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "../testing/db.ts";
import {
    blockedAmong,
    blockPayTo,
    isPayToBlocked,
    readControls,
    setControls,
    unblockPayTo,
} from "./controls.ts";

const P = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const Q = "1".repeat(32);

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

describe("x402 controls", () => {
    it("controls default to all false", async () => {
        expect(await readControls(db.pool)).toEqual({
            disabled: false,
            paused: false,
            refundsHeld: false,
            reason: null,
            changedAt: null,
        });
    });
    it("setControls pauses with a reason and touches only the given fields", async () => {
        const at = new Date("2026-11-07T10:00:00Z");
        await setControls(db.pool, { paused: true }, "audit", at);
        expect(await readControls(db.pool)).toEqual({
            disabled: false,
            paused: true,
            refundsHeld: false,
            reason: "audit",
            changedAt: at,
        });
        await setControls(db.pool, { refundsHeld: true }, null, at);
        expect(await readControls(db.pool)).toMatchObject({ paused: true, refundsHeld: true });
        await setControls(db.pool, { paused: false, refundsHeld: false }, null, at);
        expect(await readControls(db.pool)).toMatchObject({ paused: false, refundsHeld: false });
    });
    it("block and unblock are idempotent", async () => {
        await blockPayTo(db.pool, P, "dishonest hints");
        await blockPayTo(db.pool, P, "again");
        expect(await isPayToBlocked(db.pool, P)).toBe(true);
        expect([...(await blockedAmong(db.pool, [P, Q]))]).toEqual([P]);
        expect(await unblockPayTo(db.pool, P)).toBe(true);
        expect(await unblockPayTo(db.pool, P)).toBe(false);
        expect(await isPayToBlocked(db.pool, P)).toBe(false);
    });
});
