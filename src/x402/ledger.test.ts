import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { memoryLog, silentLog } from "../log.ts";
import { createRouterClient } from "../router/client.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { startFakeRouter, type FakeRouter } from "../testing/fake-router.ts";
import { seedAllowanceOrder, seedOrder } from "../testing/orders.ts";
import {
    resetLedger,
    seedAccount,
    seedFunding,
    seedX402Payment,
    TEST_HANDLE_SHA256,
} from "../testing/x402.ts";
import {
    ceilingUsedMicros,
    feeDue,
    findAccount,
    findAccountByHandle,
    findAccountForHandle,
    insertAccount,
    insertFirstUse,
    isFirstUse,
    leftMicros,
    lockAccount,
    movePool,
    placementEnded,
    readPool,
    reserveUnpaid,
    startClosing,
    voidConditionsHold,
} from "./ledger.ts";

const X = parseSettings(
    stringify({ solana: { recipient: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" } }),
    "t",
).x402;
const P = "8f9c0a52-0000-4000-8000-000000000001";
const D = new Date("2030-01-01T01:00:00Z");

let db: TestDb;
const routers: FakeRouter[] = [];
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(() => resetLedger(db.pool));
afterEach(async () => {
    await Promise.all(routers.splice(0).map((r) => r.close()));
});

async function routerWith(impl: Parameters<typeof startFakeRouter>[0]) {
    const r = await startFakeRouter(impl);
    routers.push(r);
    return createRouterClient({
        url: r.url,
        token: "rt",
        timeoutMs: 5_000,
        checkPayer: false,
        getOrder: false,
        log: silentLog,
    });
}
const setPool = (committed: number, unpaid: number) =>
    db.pool.query("update x402_pool set committed_micros = $1, unpaid_micros = $2 where id = 1", [
        committed,
        unpaid,
    ]);

describe("account lookup", () => {
    it("finds an account opened by a start order by handle hash through LookupPlacement and stores the hash", async () => {
        const account = await seedAccount(db.pool, { handleSha256: null });
        const seen: string[] = [];
        const router = await routerWith({
            lookupPlacement: (req) => {
                seen.push(req.key.case!);
                return {
                    placementId: P,
                    startOrderId: account.id,
                    state: "ready",
                    deadline: timestampFromDate(D),
                    x402Capable: true,
                    packageId: "cpu-small",
                };
            },
        });
        expect((await findAccountForHandle(db.pool, router, TEST_HANDLE_SHA256)).kind).toBe(
            "found",
        );
        expect(await findAccount(db.pool, account.id)).toMatchObject({
            handleSha256: TEST_HANDLE_SHA256,
            placementId: P,
            deadline: D,
        });
        await findAccountForHandle(db.pool, router, TEST_HANDLE_SHA256);
        expect(seen).toEqual(["handleSha256"]);
    });

    it("answers placement for a sandbox started without x402", async () => {
        const { order } = await seedOrder(db.pool, { kind: "start", state: "redeemed" });
        const router = await routerWith({
            lookupPlacement: () => ({
                placementId: P,
                startOrderId: order.id,
                state: "ready",
                x402Capable: true,
                packageId: "cpu-small",
            }),
        });
        expect(await findAccountForHandle(db.pool, router, "cd".repeat(32))).toMatchObject({
            kind: "placement",
            placement: { startOrderId: order.id, packageId: "cpu-small" },
        });
    });

    it("answers unknown for NotFound and unavailable for other errors", async () => {
        const failing = (code: Code) =>
            routerWith({
                lookupPlacement: () => {
                    throw new ConnectError("x", code);
                },
            });
        expect(
            await findAccountForHandle(db.pool, await failing(Code.NotFound), "cd".repeat(32)),
        ).toEqual({ kind: "unknown" });
        expect(
            await findAccountForHandle(db.pool, await failing(Code.Unavailable), "cd".repeat(32)),
        ).toEqual({ kind: "unavailable" });
    });

    it("insertAccount keeps the first row and findAccountByHandle reads it", async () => {
        const { order } = await seedOrder(db.pool, { kind: "start", state: "redeemed" });
        const created = new Date("2030-01-01T00:00:00Z");
        const a = await insertAccount(db.pool, {
            id: order.id,
            handleSha256: TEST_HANDLE_SHA256,
            placementId: P,
            packageId: "cpu-small",
            spendPerMinuteMicros: 500_000,
            deadline: D,
            createdAt: created,
        });
        expect(a).toMatchObject({
            createdAt: created,
            minuteStart: created,
            deadline: D,
            state: "open",
        });
        const again = await insertAccount(db.pool, {
            id: order.id,
            handleSha256: null,
            placementId: null,
            packageId: "other",
            spendPerMinuteMicros: 10_000,
            deadline: null,
        });
        expect(again).toEqual(a);
        expect(await findAccountByHandle(db.pool, TEST_HANDLE_SHA256)).toEqual(a);
        expect(await findAccountByHandle(db.pool, "cd".repeat(32))).toBeNull();
    });
});

describe("ledger reads", () => {
    it("keeps the fee due until a fee-carrying order has an unvoided funding", async () => {
        expect(await feeDue(db.pool, null)).toBe(true);
        const account = await seedAccount(db.pool);
        await seedAllowanceOrder(db.pool, { state: "unpaid" });
        expect(await feeDue(db.pool, account.id)).toBe(true);
        await seedFunding(db.pool, { accountId: account.id });
        expect(await feeDue(db.pool, account.id)).toBe(true);
        await seedFunding(db.pool, { accountId: account.id, orderId: account.id });
        expect(await feeDue(db.pool, account.id)).toBe(false);
        await db.pool.query("update x402_fundings set voided_at = now() where order_id = $1", [
            account.id,
        ]);
        expect(await feeDue(db.pool, account.id)).toBe(true);
    });

    it("counts the ceiling net of credited fees and without voided fundings", async () => {
        const a = await seedAccount(db.pool);
        await seedFunding(db.pool, { accountId: a.id, allowanceMicros: 1_000_000 });
        await seedFunding(db.pool, {
            accountId: a.id,
            allowanceMicros: 2_003_000,
            feeCreditedMicros: 3_000,
        });
        await seedFunding(db.pool, {
            accountId: a.id,
            allowanceMicros: 700_000,
            voidedAt: new Date(),
        });
        expect(await ceilingUsedMicros(db.pool, a.id)).toBe(3_000_000);
        expect((await findAccount(db.pool, a.id))!.fundedMicros).toBe(3_003_000);
    });

    it("records the first use of a payer once", async () => {
        const a = await seedAccount(db.pool);
        const b = await seedAllowanceOrder(db.pool, { state: "paid" });
        expect(await isFirstUse(db.pool, "payer-x", a.id)).toBe(false);
        await withTx(db.pool, async (c) => {
            await insertFirstUse(c, "payer-x", a.id, new Date());
            await insertFirstUse(c, "payer-x", b.order.id, new Date());
        });
        expect(await isFirstUse(db.pool, "payer-x", a.id)).toBe(true);
        expect(await isFirstUse(db.pool, "payer-x", b.order.id)).toBe(false);
    });

    it("computes what is left and closes an open account once", async () => {
        const a = await seedAccount(db.pool, {
            fundedMicros: 1_000_000,
            spentMicros: 300_000,
            heldMicros: 100_000,
            refundedMicros: 0,
            keptMicros: 0,
        });
        expect(leftMicros(a)).toBe(600_000);
        const at = new Date("2030-01-01T00:00:00Z");
        const first = await withTx(db.pool, async (c) => {
            await lockAccount(c, a.id);
            return [await startClosing(c, a.id, at), await startClosing(c, a.id, at)];
        });
        expect(first).toEqual([true, false]);
        expect(await findAccount(db.pool, a.id)).toMatchObject({ state: "closing", closingAt: at });
    });

    it("finds an ended placement by its terminal event", async () => {
        const a = await seedAccount(db.pool);
        expect(await placementEnded(db.pool, a.id)).toBe(false);
        await db.pool.query(
            `insert into events (event_id, type, created_at, order_id, payload)
             values ('e1', 'placement.ready', now(), $1, jsonb_build_object('order_id', $1::text))`,
            [a.id],
        );
        expect(await placementEnded(db.pool, a.id)).toBe(false);
        await db.pool.query(
            `insert into events (event_id, type, created_at, order_id, payload)
             values ('e2', 'placement.failed', now(), $1, jsonb_build_object('order_id', $1::text))`,
            [a.id],
        );
        expect(await placementEnded(db.pool, a.id)).toBe(true);
    });

    it("holds the void conditions only for an untouched account", async () => {
        const a = await seedAccount(db.pool);
        const check = (acc = a, t?: Date | null) =>
            withTx(db.pool, (c) => voidConditionsHold(c, acc, t));
        expect(await check()).toBe(true);
        expect(await check(a, null)).toBe(true);
        expect(await check(a, D)).toBe(false);
        expect(await check({ ...a, refundedMicros: 1 })).toBe(false);
        expect(await check({ ...a, keptMicros: 1 })).toBe(false);
        await db.pool.query(
            `insert into events (event_id, type, created_at, order_id, payload)
             values ('e1', 'placement.ready', now(), $1, jsonb_build_object('order_id', $1::text))`,
            [a.id],
        );
        expect(await check()).toBe(true);
        await db.pool.query('update events set payload = payload || \'{"deadline": "x"}\'');
        expect(await check()).toBe(false);
        await db.pool.query("truncate events");
        await seedX402Payment(db.pool, { accountId: a.id });
        expect(await check()).toBe(false);
    });
});

describe("pool", () => {
    it("refuses an unpaid reservation past either pool limit", async () => {
        const take = (m: number) => withTx(db.pool, (c) => reserveUnpaid(c, m, X, silentLog));
        await setPool(0, 9_000_000);
        expect(await take(1_000_001)).toBe(false);
        await setPool(45_000_000, 4_000_000);
        expect(await take(1_000_001)).toBe(false);
        await setPool(0, 0);
        expect(await take(1_000_000)).toBe(true);
        expect(await readPool(db.pool)).toEqual({ committedMicros: 0, unpaidMicros: 1_000_000 });
    });

    it("fires x402_pool_high once when the pool passes 80 percent and never goes negative", async () => {
        const log = memoryLog();
        await setPool(39_000_000, 0);
        await withTx(db.pool, (c) => movePool(c, { unpaid: 1_000_001 }, X, log));
        await withTx(db.pool, (c) => movePool(c, { unpaid: 1 }, X, log));
        const alarms = log.lines.filter((l) => l.alarm === "x402_pool_high");
        expect(alarms).toHaveLength(1);
        expect(alarms[0]).toMatchObject({ committedMicros: 39_000_000, unpaidMicros: 1_000_001 });
        await expect(
            withTx(db.pool, (c) => movePool(c, { committed: -40_000_000 }, X, log)),
        ).rejects.toMatchObject({ code: "23514" });
    });

    it("fires x402_pool_high from a reservation that crosses the threshold", async () => {
        const log = memoryLog();
        await setPool(39_500_000, 0);
        expect(await withTx(db.pool, (c) => reserveUnpaid(c, 500_001, X, log))).toBe(true);
        expect(log.lines.filter((l) => l.alarm === "x402_pool_high")).toHaveLength(1);
    });
});
