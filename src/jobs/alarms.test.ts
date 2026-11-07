import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import type { Settings } from "../config.ts";
import { memoryLog } from "../log.ts";
import { createFakeRpc, type FakeRpcScript, neverAnswers } from "../testing/fake-rpc.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import { checkAlarms, type AlarmSnapshot } from "./alarms.ts";

const MIN = 60_000;
const t0 = new Date("2026-11-06T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const FEE_PAYER = address("11111111111111111111111111111112");
const REFUND_WALLET = address("11111111111111111111111111111113");
const RPC_TIMEOUT_MS = 10_000;
const STALL_MS = 100;

const defaults: Settings["alarms"] = {
    fee_payer_min_lamports: 100_000_000,
    max_lamports_per_order: 20_000,
};
const refunds = {
    float_low_micros: 10_000_000,
    max_per_hour: 10,
} as Settings["refunds"];

let db: TestDb;

beforeAll(async () => {
    db = await testDb();
});
afterAll(() => db.close());
beforeEach(async () => {
    await db.pool.query("truncate orders cascade");
});

function run(
    opts: {
        lamports?: bigint;
        floatMicros?: string;
        prev?: AlarmSnapshot | null;
        alarms?: Settings["alarms"];
        script?: Partial<FakeRpcScript>;
        rpcTimeoutMs?: number;
    } = {},
) {
    const log = memoryLog();
    const rpc = createFakeRpc({
        getBalance: () => ({ value: opts.lamports ?? 1_000_000_000n }),
        getTokenAccountBalance: () => ({
            value: {
                amount: opts.floatMicros ?? "1000000000",
                decimals: 6,
                uiAmount: 0,
                uiAmountString: "0",
            },
        }),
        ...opts.script,
    });
    const result = checkAlarms(
        {
            pool: db.pool,
            rpc,
            feePayer: FEE_PAYER,
            refundWallet: REFUND_WALLET,
            alarms: opts.alarms ?? defaults,
            refunds,
            rpcTimeoutMs: opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS,
            log,
            now: () => t0,
        },
        opts.prev ?? null,
    );
    const names = async () => {
        await result;
        return log.lines.filter((l) => l.alarm).map((l) => l.alarm);
    };
    return { result, names, log };
}

const prevAt = (lamports: bigint): AlarmSnapshot => ({
    at: at(-5 * MIN),
    feePayerLamports: lamports,
    feePayingTxs: 0,
});

async function confirmedPayments(n: number) {
    for (let i = 0; i < n; i++) {
        const { order } = await seedOrder(db.pool, { state: "paid" });
        await seedPayment(db.pool, order.id, { status: "confirmed", confirmedAt: at(-MIN) });
    }
}

describe("checkAlarms", () => {
    it.each(["getBalance", "getTokenAccountBalance"] as const)(
        "gives up on a stalled %s within solana.rpc_timeout and raises nothing",
        async (method) => {
            const started = performance.now();
            const { result, log } = run({
                script: { [method]: neverAnswers },
                rpcTimeoutMs: STALL_MS,
            });
            await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
            expect(performance.now() - started).toBeLessThan(STALL_MS + 900);
            expect(log.lines).toEqual([]);
        },
    );

    it("alarms below alarms.fee_payer_min_lamports", async () => {
        expect(await run({ lamports: 99_999_999n }).names()).toEqual(["fee_payer_sol_low"]);
        expect(await run({ lamports: 100_000_000n }).names()).toEqual([]);
        const dev = { ...defaults, fee_payer_min_lamports: 20_000_000 };
        expect(await run({ lamports: 50_000_000n, alarms: dev }).names()).toEqual([]);
        expect(await run({ lamports: 19_999_999n, alarms: dev }).names()).toEqual([
            "fee_payer_sol_low",
        ]);
    });

    it("returns the snapshot of this run", async () => {
        await confirmedPayments(2);
        const snap = await run({ lamports: 990_000_000n, prev: prevAt(990_000_000n) }).result;
        expect(snap).toEqual({ at: t0, feePayerLamports: 990_000_000n, feePayingTxs: 2 });
    });

    it("alarms above 20_000 lamports per confirmed payment", async () => {
        await confirmedPayments(2);
        const high = run({ lamports: 950_000n, prev: prevAt(1_000_000n), alarms: dev() });
        expect(await high.names()).toEqual(["sol_per_order_high"]);
        expect(high.log.lines.find((l) => l.alarm)).toMatchObject({ lamportsPerTx: "25000" });
        expect(
            await run({ lamports: 960_000n, prev: prevAt(1_000_000n), alarms: dev() }).names(),
        ).toEqual([]);
    });

    it("ignores a top-up", async () => {
        await confirmedPayments(1);
        const names = await run({
            lamports: 1_000_000_000n,
            prev: prevAt(1_000n),
        }).names();
        expect(names).toEqual([]);
    });

    it("alarms on spend with no orders", async () => {
        const over = run({ lamports: 975_000n, prev: prevAt(1_000_000n), alarms: dev() });
        expect(await over.names()).toEqual(["sol_spent_without_orders"]);
        const at20k = run({ lamports: 980_000n, prev: prevAt(1_000_000n), alarms: dev() });
        expect(await at20k.names()).toEqual([]);
    });

    it("raises no ratio alarm on the first run", async () => {
        expect(await run({ lamports: 100_000_000n }).names()).toEqual([]);
    });

    it("alarms on a low refund float", async () => {
        expect(await run({ floatMicros: "9999999" }).names()).toEqual(["refund_float_low"]);
        expect(await run({ floatMicros: "10000000" }).names()).toEqual([]);
    });

    it("alarms on more than max_per_hour refunds created in the last hour", async () => {
        const seed = async (n: number, createdAt: Date) => {
            for (let i = 0; i < n; i++) {
                const { order } = await seedOrder(db.pool, { state: "refunding" });
                await db.pool.query(
                    `insert into refunds (order_id, kind, reason, amount_micros, destination, payer,
                        state, created_at)
                     values ($1, 'full', 'late', 10000, 'dest', 'payer', 'pending', $2)`,
                    [order.id, createdAt],
                );
            }
        };
        await seed(5, at(-61 * MIN));
        await seed(10, at(-30 * MIN));
        expect(await run().names()).toEqual([]);
        await seed(1, at(-MIN));
        expect(await run().names()).toEqual(["refunds_per_hour_high"]);
    });
});

function dev() {
    return { ...defaults, fee_payer_min_lamports: 0 };
}
