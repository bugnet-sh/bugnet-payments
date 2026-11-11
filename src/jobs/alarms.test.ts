import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import { stringify } from "smol-toml";
import { parseSettings, type Settings } from "../config.ts";
import { DepositKeys } from "../deposits/keys.ts";
import { ensureDeposit } from "../deposits/store.ts";
import { memoryLog } from "../log.ts";
import { createFakeRpc, type FakeRpcScript, neverAnswers } from "../testing/fake-rpc.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import { checkAlarms, depositLamports, type AlarmSnapshot } from "./alarms.ts";

const MIN = 60_000;
const t0 = new Date("2026-11-06T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const FEE_PAYER = address("11111111111111111111111111111112");
const REFUND_WALLET = address("11111111111111111111111111111113");
const RPC_TIMEOUT_MS = 10_000;
const DEPOSITS = parseSettings(
    stringify({ solana: { recipient: "Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw" } }),
    "alarms.test",
).deposits;
const STALL_MS = 100;

const defaults: Settings["alarms"] = {
    fee_payer_min_lamports: 100_000_000,
    max_lamports_per_order: 20_000,
};
const refunds = {
    float_low_micros: 10_000_000,
    max_per_hour: 10,
    compute_unit_limit: 20_000,
    compute_unit_price_micro_lamports: 10_000,
} as Settings["refunds"];

let db: TestDb;

beforeAll(async () => {
    db = await testDb();
});
afterAll(() => db.close());
beforeEach(async () => {
    await db.pool.query("truncate orders cascade");
    await db.pool.query("truncate x402_cold_transfers cascade");
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
            deposits: DEPOSITS,
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
    confirmedPayments: 0,
});

async function confirmedPayments(n: number) {
    for (let i = 0; i < n; i++) {
        const { order } = await seedOrder(db.pool, { state: "paid" });
        await seedPayment(db.pool, order.id, { status: "confirmed", confirmedAt: at(-MIN) });
    }
}

async function allowanceRows(n: number, state: "confirmed" | "pending", when: Date) {
    for (let i = 0; i < n; i++) {
        const { order } = await seedOrder(db.pool, {
            kind: "start",
            state: "redeemed",
            payInto: "allowance",
            amountMicros: 1_013_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
        });
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                from_wallet, created_at, confirmed_at)
             values ($1, 'allowance', 'x402_unspent', 10000, 'dest', 'payer', $2, 'allowance', $3, $4)`,
            [order.id, state, when, state === "confirmed" ? when : null],
        );
    }
}
const lowMin = { ...defaults, fee_payer_min_lamports: 0 };

describe("checkAlarms", () => {
    it("x402 ends never raise sol_per_order_high or sol_spent_without_orders", async () => {
        await allowanceRows(3, "confirmed", at(-30_000));
        await db.pool.query(
            "insert into x402_cold_transfers (amount_micros, state, confirmed_at) values (1, 'confirmed', $1)",
            [at(-30_000)],
        );
        const prev = { at: at(-60_000), feePayerLamports: 1_000_000n, confirmedPayments: 0 };
        expect(await run({ lamports: 959_200n, prev, alarms: lowMin }).names()).toEqual([]);
        expect(await run({ lamports: 939_199n, prev, alarms: lowMin }).names()).toContain(
            "sol_spent_without_orders",
        );
    });

    it("refunds_per_hour_high ignores allowance rows", async () => {
        await allowanceRows(11, "pending", at(-10 * MIN));
        expect(await run({ alarms: lowMin }).names()).not.toContain("refunds_per_hour_high");
    });

    it("gives up on a stalled getBalance within solana.rpc_timeout and raises nothing", async () => {
        const started = performance.now();
        const { result, log } = run({
            script: { getBalance: neverAnswers },
            rpcTimeoutMs: STALL_MS,
        });
        await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
        expect(performance.now() - started).toBeLessThan(STALL_MS + 900);
        expect(log.lines).toEqual([]);
    });

    it("a stalled refund float read is logged at warn and does not hide refunds_per_hour_high", async () => {
        for (let i = 0; i < 11; i++) {
            const { order } = await seedOrder(db.pool, { state: "refunding" });
            await db.pool.query(
                `insert into refunds (order_id, kind, reason, amount_micros, destination, payer,
                    state, created_at)
                 values ($1, 'full', 'late', 10000, 'dest', 'payer', 'pending', $2)`,
                [order.id, at(-MIN)],
            );
        }
        const started = performance.now();
        const { result, names, log } = run({
            script: { getTokenAccountBalance: neverAnswers },
            rpcTimeoutMs: STALL_MS,
        });
        await expect(result).resolves.toMatchObject({ at: t0 });
        expect(performance.now() - started).toBeLessThan(STALL_MS + 900);
        expect(await names()).toEqual(["refunds_per_hour_high"]);
        expect(log.lines.some((l) => l.level === "warn")).toBe(true);
    });

    it("counts only confirmed payments, not settling ones", async () => {
        await confirmedPayments(1);
        const { order } = await seedOrder(db.pool, { state: "paid" });
        await seedPayment(db.pool, order.id, { status: "settling", confirmedAt: at(-MIN) });
        const snap = await run({ prev: prevAt(1_000_000_000n) }).result;
        expect(snap.confirmedPayments).toBe(1);
    });

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
        expect(snap).toEqual({ at: t0, feePayerLamports: 990_000_000n, confirmedPayments: 2 });
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

describe("deposit moves in the fee payer alarm", () => {
    const keys = new DepositKeys(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    beforeEach(async () => {
        await db.pool.query("truncate deposits cascade");
    });
    async function deposit(): Promise<string> {
        const { order } = await seedOrder(db.pool, {
            state: "unpaid",
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 3_600_000),
        });
        await ensureDeposit(db.pool, keys, order, new Date());
        return order.id;
    }
    async function move(
        orderId: string,
        m: {
            kind: "create" | "sweep" | "return" | "close";
            state: "confirmed" | "failed";
            at: Date;
            closes?: boolean;
            closeTo?: string;
            refused?: boolean;
        },
    ) {
        const amount = m.kind === "sweep" || m.kind === "return" ? 1_000 : 0;
        await db.pool.query(
            `insert into deposit_moves (order_id, kind, amount_micros, payer, closes, close_to,
                state, created_at, confirmed_at, failed_at, preflight_refused_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
                orderId,
                m.kind,
                amount,
                m.kind === "return" ? "Payer" : null,
                m.closes ?? false,
                m.closeTo ?? null,
                m.state,
                m.at,
                m.state === "confirmed" ? m.at : null,
                m.state === "failed" ? m.at : null,
                m.refused === true ? m.at : null,
            ],
        );
    }

    it("depositLamports counts fees, rent out and rent back", async () => {
        const id = await deposit();
        await move(id, { kind: "create", state: "confirmed", at: at(-4 * MIN) });
        await move(id, {
            kind: "sweep",
            state: "confirmed",
            at: at(-3 * MIN),
            closes: true,
            closeTo: FEE_PAYER,
        });
        await move(id, { kind: "return", state: "failed", at: at(-2 * MIN) });
        await move(id, { kind: "return", state: "failed", at: at(-MIN), refused: true });
        expect(await depositLamports(db.pool, at(-5 * MIN), t0, FEE_PAYER, DEPOSITS)).toBe(26_200n);
    });

    it("rent to someone else is not counted back", async () => {
        const id = await deposit();
        await move(id, {
            kind: "return",
            state: "confirmed",
            at: at(-MIN),
            closes: true,
            closeTo: "Other",
        });
        expect(await depositLamports(db.pool, at(-5 * MIN), t0, FEE_PAYER, DEPOSITS)).toBe(10_400n);
    });

    it("a viewed, unpaid deposit does not alarm", async () => {
        const id = await deposit();
        await move(id, { kind: "create", state: "confirmed", at: at(-4 * MIN) });
        await move(id, {
            kind: "close",
            state: "confirmed",
            at: at(-2 * MIN),
            closes: true,
            closeTo: FEE_PAYER,
        });
        // Below the 15,800 the balance fell, so only counting the deposit moves keeps it quiet
        const { names } = run({
            lamports: 1_000_000_000n - 15_800n,
            prev: prevAt(1_000_000_000n),
            alarms: { ...defaults, max_lamports_per_order: 10_000 },
        });
        expect(await names()).not.toContain("sol_spent_without_orders");
    });
});
