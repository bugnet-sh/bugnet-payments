import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedOrder } from "../testing/orders.ts";
import { seedAccount } from "../testing/x402.ts";
import {
    advanceVerified,
    hotLedgerEmpty,
    openTail,
    raiseFinalizedHeight,
    readTail,
    setMismatchSince,
} from "./tail.ts";

const T0 = new Date("2030-01-01T00:00:00Z");
const T1 = new Date("2030-01-01T00:01:00Z");
const T2 = new Date("2030-01-01T00:02:00Z");

let db: TestDb;
let pool: pg.Pool;
beforeEach(async () => {
    db = await testDb();
    pool = db.pool;
});
afterEach(async () => {
    await db.close();
});

describe("the hot tail", () => {
    it("readTail of a fresh database", async () => {
        expect(await readTail(pool)).toEqual({
            tokenAccount: null,
            openingBalanceMicros: 0n,
            openingSlot: 0n,
            openedAt: null,
            verifiedSlot: 0n,
            verifiedAt: null,
            finalizedHeight: 0n,
            mismatchSince: null,
        });
    });

    it("openTail sets the opening and the verified slot", async () => {
        await openTail(pool, "ATA", 2_029_000n, 5_000n, T0);
        expect(await readTail(pool)).toMatchObject({
            tokenAccount: "ATA",
            openingBalanceMicros: 2_029_000n,
            openingSlot: 5_000n,
            openedAt: T0,
            verifiedSlot: 5_000n,
            verifiedAt: T0,
            mismatchSince: null,
        });
    });

    it("openTail clears a mismatch", async () => {
        await setMismatchSince(pool, T0);
        await openTail(pool, "ATA", 0n, 100n, T1);
        expect((await readTail(pool)).mismatchSince).toBeNull();
    });

    it("advanceVerified never moves back", async () => {
        await openTail(pool, "ATA", 0n, 100n, T0);
        expect(await advanceVerified(pool, 200n, T1)).toBe(true);
        expect(await advanceVerified(pool, 150n, T2)).toBe(false);
        expect(await advanceVerified(pool, 200n, T2)).toBe(false);
        expect(await readTail(pool)).toMatchObject({ verifiedSlot: 200n, verifiedAt: T1 });
    });

    it("raiseFinalizedHeight only raises", async () => {
        await raiseFinalizedHeight(pool, 900n);
        await raiseFinalizedHeight(pool, 899n);
        expect((await readTail(pool)).finalizedHeight).toBe(900n);
    });

    it("setMismatchSince sets and clears", async () => {
        await setMismatchSince(pool, T0);
        expect((await readTail(pool)).mismatchSince).toEqual(T0);
        await setMismatchSince(pool, null);
        expect((await readTail(pool)).mismatchSince).toBeNull();
    });
});

describe("hotLedgerEmpty", () => {
    it("is false for each blocking condition and true when all clear", async () => {
        expect(await hotLedgerEmpty(pool)).toBe(true);

        const acct = await seedAccount(pool, { state: "closing" });
        expect(await hotLedgerEmpty(pool)).toBe(false);
        await pool.query("update x402_accounts set state = 'closed' where id = $1", [acct.id]);
        expect(await hotLedgerEmpty(pool)).toBe(true);

        await pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                manual_reason, from_wallet)
             values ($1, 'allowance', 'x402_unspent', 1000, 'dest', 'payer', 'manual',
                'refund_balance_short', 'allowance')`,
            [acct.id],
        );
        expect(await hotLedgerEmpty(pool)).toBe(false);
        await pool.query("update refunds set manual_reason = 'resolved_by_hand'");
        expect(await hotLedgerEmpty(pool)).toBe(true);

        const { order } = await seedOrder(pool, {
            state: "settling",
            payInto: "allowance",
            amountMicros: 1_013_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
        });
        expect(await hotLedgerEmpty(pool)).toBe(false);
        await pool.query("update orders set state = 'paid' where id = $1", [order.id]);
        expect(await hotLedgerEmpty(pool)).toBe(true);

        await pool.query(
            "insert into x402_cold_transfers (amount_micros, state) values (20000000, 'sent')",
        );
        expect(await hotLedgerEmpty(pool)).toBe(false);
        await pool.query("update x402_cold_transfers set state = 'confirmed'");
        expect(await hotLedgerEmpty(pool)).toBe(true);
        await pool.query("update x402_cold_transfers set state = 'failed'");
        expect(await hotLedgerEmpty(pool)).toBe(true);
    });

    it("a confirmed allowance refund does not block", async () => {
        const acct = await seedAccount(pool, { state: "closed" });
        await pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                from_wallet)
             values ($1, 'allowance', 'x402_unspent', 1000, 'dest', 'payer', 'confirmed',
                'allowance')`,
            [acct.id],
        );
        expect(await hotLedgerEmpty(pool)).toBe(true);
    });
});
