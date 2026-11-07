import { getBase58Decoder } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { createPool, withTx } from "../db/pool.ts";
import { memoryLog } from "../log.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { testSigner } from "../testing/keys.ts";
import { seedAccount, seedX402Payment, TEST_PAYTO } from "../testing/x402.ts";
import { readControls } from "./controls.ts";
import { newX402PaymentId } from "./ids.ts";
import { findAccount, readPool } from "./ledger.ts";
import {
    findX402Payment,
    releaseReserved,
    reserve,
    resolveSigned,
    runReleaseJob,
    utcDay,
    type ReserveInput,
} from "./reserve.ts";
import type { AccountRow } from "./types.ts";

const T0 = new Date("2030-01-01T12:00:00Z");
const PLACEMENT = "8f9c0a52-0000-4000-8000-000000000001";
const PLACEMENT_B = "8f9c0a52-0000-4000-8000-000000000002";
const SIG = "1".repeat(63) + "2";
const DAY_TABLES = ["x402_payto_days", "x402_unlisted_days", "x402_outflow_days"] as const;

let db: TestDb;
let x402: Settings["x402"];
let log: ReturnType<typeof memoryLog>;
let account: AccountRow;
let otherPayTo: string;

beforeAll(async () => {
    db = await testDb();
    const recipient = (await testSigner(1)).address;
    x402 = parseSettings(stringify({ solana: { recipient } }), "t").x402;
    otherPayTo = (await testSigner(8)).address;
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await db.pool.query(
        "truncate orders, x402_payto_days, x402_unlisted_days, x402_outflow_days cascade",
    );
    await db.pool.query("update x402_pool set committed_micros = 1000000, unpaid_micros = 0");
    await db.pool.query("update x402_controls set paused = false, disabled = false");
    log = memoryLog();
    account = await seedAccount(db.pool, {
        fundedMicros: 1_000_000,
        spendPerMinuteMicros: 500_000,
        placementId: PLACEMENT,
    });
});

function later(ms: number): Date {
    return new Date(T0.getTime() + ms);
}
function input(over: Partial<ReserveInput> = {}): ReserveInput {
    return {
        id: newX402PaymentId(),
        ref: newX402PaymentId().slice(3, 19),
        accountId: account.id,
        placementId: PLACEMENT,
        serviceId: "xs_" + "a".repeat(16),
        method: "POST",
        host: "s.example",
        path: "/v1/chat",
        targetSha256: Buffer.alloc(32, 1),
        bodySha256: Buffer.alloc(32, 2),
        amountMicros: 10_000,
        payTo: TEST_PAYTO,
        payToTokenAccount: TEST_PAYTO,
        feePayer: otherPayTo,
        listed: "unlisted",
        ...over,
    };
}
async function dayMicros(table: (typeof DAY_TABLES)[number], day: string): Promise<number | null> {
    const where = table === "x402_payto_days" ? "and pay_to = $2" : "";
    const params = table === "x402_payto_days" ? [day, TEST_PAYTO] : [day];
    const { rows } = await db.pool.query(
        `select micros from ${table} where day = $1::date ${where}`,
        params,
    );
    return rows.length === 0 ? null : Number(rows[0].micros);
}
async function money(): Promise<{ held: number; spent: number }> {
    const a = (await findAccount(db.pool, account.id))!;
    return { held: a.heldMicros, spent: a.spentMicros };
}
async function markSigned(id: string): Promise<void> {
    await db.pool.query("update x402_payments set state = 'signed' where id = $1", [id]);
}
function alarms(name: string) {
    return log.lines.filter((l) => l.alarm === name);
}

describe("reserve", () => {
    it("32 concurrent reservations at $0.01 against $0.05 give exactly 5", async () => {
        await db.pool.query("update x402_accounts set funded_micros = 50000 where id = $1", [
            account.id,
        ]);
        const results = await Promise.all(
            Array.from({ length: 32 }, () => reserve(db.pool, input(), x402, log, T0)),
        );
        expect(results.filter((r) => r.ok)).toHaveLength(5);
        expect(results.filter((r) => !r.ok && r.reason === "allowance_spent")).toHaveLength(27);
        expect((await money()).held).toBe(50_000);
    });

    it("never more than 8 open per placement", async () => {
        const first = input();
        expect(await reserve(db.pool, first, x402, log, T0)).toEqual({
            ok: true,
            capDay: "2030-01-01",
            leftMicros: 990_000,
        });
        for (let i = 0; i < 7; i++) {
            expect((await reserve(db.pool, input(), x402, log, T0)).ok).toBe(true);
        }
        expect(await reserve(db.pool, input(), x402, log, T0)).toEqual({
            ok: false,
            reason: "too_many_open_payments",
            leftMicros: 920_000,
        });
        await db.pool.query("update x402_payments set landed_slot = 1 where id = $1", [first.id]);
        expect((await reserve(db.pool, input(), x402, log, T0)).ok).toBe(true);
    });

    it("the minute bucket", async () => {
        await db.pool.query("update x402_accounts set spend_per_minute_micros = 20000");
        const at = (iso: string, r = input()) => reserve(db.pool, r, x402, log, new Date(iso));
        expect((await at("2030-01-01T12:00:10Z")).ok).toBe(true);
        expect((await at("2030-01-01T12:00:20Z")).ok).toBe(true);
        expect(await at("2030-01-01T12:00:30Z")).toMatchObject({ ok: false, reason: "rate_cap" });
        expect((await at("2030-01-01T12:01:00Z")).ok).toBe(true);
        const fifth = input();
        expect((await at("2030-01-01T12:01:05Z", fifth)).ok).toBe(true);
        expect(await releaseReserved(db.pool, fifth.id, new Date("2030-01-01T12:01:06Z"))).toBe(
            true,
        );
        expect(await at("2030-01-01T12:01:10Z")).toMatchObject({ ok: false, reason: "rate_cap" });
    });

    it("the payee day", async () => {
        await db.pool.query(
            "insert into x402_payto_days (pay_to, day, micros) values ($1, '2030-01-01', 19995000)",
            [TEST_PAYTO],
        );
        expect(await reserve(db.pool, input({ listed: "unlisted" }), x402, log, T0)).toMatchObject({
            ok: false,
            reason: "payto_daily_cap",
        });
        expect(await reserve(db.pool, input({ listed: "indexed" }), x402, log, T0)).toMatchObject({
            ok: true,
        });
        expect(await dayMicros("x402_payto_days", "2030-01-01")).toBe(20_005_000);
    });

    it("the unlisted day", async () => {
        await db.pool.query(
            "insert into x402_unlisted_days (day, micros) values ('2030-01-01', 19995000)",
        );
        const unlisted = input({ listed: "unlisted", payTo: otherPayTo });
        expect(await reserve(db.pool, unlisted, x402, log, T0)).toMatchObject({
            ok: false,
            reason: "payto_daily_cap",
        });
        expect((await reserve(db.pool, input({ listed: "indexed" }), x402, log, T0)).ok).toBe(true);
        expect(await dayMicros("x402_unlisted_days", "2030-01-01")).toBe(19_995_000);
    });

    // 2030-01-02 is used by no other test: the alarm fires once per UTC day per process
    it("the outflow cap refuses until the next UTC day and sets no pause", async () => {
        const d2 = new Date("2030-01-02T08:00:00Z");
        await db.pool.query(
            "insert into x402_outflow_days (day, micros) values ('2030-01-02', 99995000)",
        );
        expect(await reserve(db.pool, input(), x402, log, d2)).toMatchObject({
            ok: false,
            reason: "outflow_cap",
        });
        expect(await reserve(db.pool, input(), x402, log, d2)).toMatchObject({
            ok: false,
            reason: "outflow_cap",
        });
        expect((await readControls(db.pool)).paused).toBe(false);
        expect(alarms("x402_outflow_cap")).toHaveLength(1);
        const d3 = new Date("2030-01-03T00:00:00Z");
        expect(await reserve(db.pool, input(), x402, log, d3)).toMatchObject({
            ok: true,
            capDay: "2030-01-03",
        });
    });

    it("account_closed for a closing account or no account", async () => {
        await db.pool.query("update x402_accounts set state = 'closing' where id = $1", [
            account.id,
        ]);
        expect(await reserve(db.pool, input(), x402, log, T0)).toEqual({
            ok: false,
            reason: "account_closed",
            leftMicros: 1_000_000,
        });
        const none = input({ accountId: "ord_" + "z".repeat(26) });
        expect(await reserve(db.pool, none, x402, log, T0)).toEqual({
            ok: false,
            reason: "account_closed",
            leftMicros: 0,
        });
    });
});

describe("room changes", () => {
    it("release returns room", async () => {
        const r = input({ listed: "unlisted" });
        await reserve(db.pool, r, x402, log, T0);
        expect(await releaseReserved(db.pool, r.id, later(1_000))).toBe(true);
        expect(await releaseReserved(db.pool, r.id, later(2_000))).toBe(false);
        expect((await money()).held).toBe(0);
        for (const t of DAY_TABLES) expect(await dayMicros(t, "2030-01-01")).toBe(0);
        expect(await findX402Payment(db.pool, r.id)).toMatchObject({
            state: "released",
            capDay: "2030-01-01",
            resolvedAt: later(1_000),
        });
    });

    it("the job releases only rows older than 30_000 ms", async () => {
        const old = input();
        const young = input();
        await reserve(db.pool, old, x402, log, T0);
        await reserve(db.pool, young, x402, log, later(10_000));
        expect(await runReleaseJob(db.pool, x402, log, later(35_000))).toBe(1);
        expect((await findX402Payment(db.pool, old.id))!.state).toBe("released");
        expect((await findX402Payment(db.pool, young.id))!.state).toBe("reserved");
    });

    it("the job releases at most 50 per run", async () => {
        await db.pool.query("update x402_accounts set held_micros = 510000 where id = $1", [
            account.id,
        ]);
        for (let i = 0; i < 51; i++) {
            await seedX402Payment(db.pool, {
                accountId: account.id,
                placementId: PLACEMENT,
                state: "reserved",
                amountMicros: 10_000,
                createdAt: T0,
            });
        }
        expect(await runReleaseJob(db.pool, x402, log, later(60_000))).toBe(50);
        expect(await runReleaseJob(db.pool, x402, log, later(60_000))).toBe(1);
        expect((await money()).held).toBe(0);
    });

    it("signed to confirmed moves held to spent, keeps the days and lowers committed", async () => {
        const r = input({ listed: "unlisted" });
        await reserve(db.pool, r, x402, log, T0);
        await markSigned(r.id);
        const row = await withTx(db.pool, (c) =>
            resolveSigned(
                c,
                r.id,
                "confirmed",
                { landedSlot: 77n, txSignature: SIG },
                later(5_000),
                x402,
                log,
            ),
        );
        expect(row).toMatchObject({
            state: "confirmed",
            landedSlot: 77n,
            txSignature: SIG,
            resolvedAt: later(5_000),
        });
        expect(await money()).toEqual({ held: 0, spent: 10_000 });
        for (const t of DAY_TABLES) expect(await dayMicros(t, "2030-01-01")).toBe(10_000);
        expect((await readPool(db.pool)).committedMicros).toBe(990_000);
    });

    it.each(["expired_unlanded", "failed_onchain"] as const)(
        "signed to %s returns the days",
        async (to) => {
            const r = input({ listed: "unlisted" });
            await reserve(db.pool, r, x402, log, T0);
            await markSigned(r.id);
            const row = await withTx(db.pool, (c) =>
                resolveSigned(c, r.id, to, {}, later(5_000), x402, log),
            );
            expect(row!.state).toBe(to);
            expect(await money()).toEqual({ held: 0, spent: 0 });
            for (const t of DAY_TABLES) expect(await dayMicros(t, "2030-01-01")).toBe(0);
            expect((await readPool(db.pool)).committedMicros).toBe(1_000_000);
        },
    );

    it("a released or reserved row is never resolved", async () => {
        const released = input();
        await reserve(db.pool, released, x402, log, T0);
        await releaseReserved(db.pool, released.id, T0);
        const reserved = input();
        await reserve(db.pool, reserved, x402, log, T0);
        for (const id of [released.id, reserved.id]) {
            expect(
                await withTx(db.pool, (c) => resolveSigned(c, id, "confirmed", {}, T0, x402, log)),
            ).toBeNull();
        }
        expect(await money()).toEqual({ held: 10_000, spent: 0 });
    });

    it("returns room to the stored cap_day after midnight", async () => {
        const before = new Date("2030-01-01T23:59:59.900Z");
        expect(utcDay(before)).toBe("2030-01-01");
        const released = input({ listed: "unlisted" });
        const expired = input({ listed: "unlisted" });
        await reserve(db.pool, released, x402, log, before);
        await reserve(db.pool, expired, x402, log, before);
        await markSigned(expired.id);
        const after = new Date("2030-01-02T00:00:00.100Z");
        expect(await releaseReserved(db.pool, released.id, after)).toBe(true);
        await withTx(db.pool, (c) =>
            resolveSigned(c, expired.id, "expired_unlanded", {}, after, x402, log),
        );
        for (const t of DAY_TABLES) {
            expect(await dayMicros(t, "2030-01-01")).toBe(0);
            expect(await dayMicros(t, "2030-01-02")).toBeNull();
        }
    });

    it("lock order never deadlocks", async () => {
        const pool = createPool(db.url);
        let deadlocks = 0;
        pool.on("connect", (client) => {
            const query = client.query.bind(client) as (...a: unknown[]) => unknown;
            (client as unknown as { query: unknown }).query = (...a: unknown[]) => {
                const p = query(...a);
                if (p instanceof Promise) {
                    p.catch((e: { code?: string }) => {
                        if (e.code === "40P01") deadlocks++;
                    });
                }
                return p;
            };
        });
        await db.pool.query(
            "update x402_accounts set funded_micros = 100000000, spend_per_minute_micros = 5000000",
        );
        const b = await seedAccount(db.pool, {
            fundedMicros: 100_000_000,
            spendPerMinuteMicros: 5_000_000,
            placementId: PLACEMENT_B,
            handleSha256: "cd".repeat(32),
        });
        for (let i = 0; i < 200; i++) {
            const t = later(i * 60_000);
            const signed = input({ amountMicros: 1_000 });
            await reserve(pool, signed, x402, log, t);
            await markSigned(signed.id);
            const sig = getBase58Decoder().decode(new Uint8Array(64).fill(i + 1));
            await Promise.all([
                reserve(pool, input({ amountMicros: 1_000 }), x402, log, t),
                reserve(
                    pool,
                    input({ accountId: b.id, placementId: PLACEMENT_B, amountMicros: 1_000 }),
                    x402,
                    log,
                    t,
                ),
                runReleaseJob(pool, x402, log, later(i * 60_000 + 31_000)),
                withTx(pool, (c) =>
                    resolveSigned(
                        c,
                        signed.id,
                        "confirmed",
                        { landedSlot: BigInt(i + 1), txSignature: sig },
                        t,
                        x402,
                        log,
                    ),
                ),
            ]);
        }
        await pool.end();
        expect(deadlocks).toBe(0);
    });
});
