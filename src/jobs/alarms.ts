/**
 * Alarm checks, run every `jobs.alarms_every`.
 *
 * Each run reads the fee payer's SOL balance and compares it with the previous run's snapshot:
 * the SOL spent since then, divided by the payments confirmed since then (refunds are not
 * counted), is the cost per paid order. A balance that rose (a top-up) raises no ratio alarm.
 * Refund float and refund rate are checked on every run.
 */
import type { Address } from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import type { Log } from "../log.ts";
import { usdcAta } from "../solana/accounts.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";
import { moveFeeLamports } from "../deposits/moves.ts";
import { hotFeeLamports } from "../x402/audit.ts";

// What a USDC token account holds in rent; the fee payer pays it at a create and gets it back at
// a close to itself
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

export interface AlarmSnapshot {
    at: Date;
    feePayerLamports: bigint;
    confirmedPayments: number;
}

export interface AlarmDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    feePayer: Address;
    refundWallet: Address;
    alarms: Settings["alarms"];
    refunds: Settings["refunds"];
    deposits: Settings["deposits"];
    rpcTimeoutMs: number;
    log: Log;
    now: () => Date;
}

export async function checkAlarms(
    d: AlarmDeps,
    prev: AlarmSnapshot | null,
): Promise<AlarmSnapshot> {
    const now = d.now();
    const { value: lamports } = await d.rpc
        .getBalance(d.feePayer, { commitment: "confirmed" })
        .send(deadline(d.rpcTimeoutMs));
    const txs = prev ? await confirmedPayments(d.pool, prev.at, now) : 0;

    if (lamports < BigInt(d.alarms.fee_payer_min_lamports)) {
        d.log.alarm("fee_payer_sol_low", {
            lamports,
            minLamports: d.alarms.fee_payer_min_lamports,
        });
    }

    const x402Ends = prev ? await hotEnds(d.pool, prev.at, now) : 0;
    const spent = prev
        ? prev.feePayerLamports -
          lamports -
          hotFeeLamports(d.refunds) * BigInt(x402Ends) -
          (await depositLamports(d.pool, prev.at, now, d.feePayer, d.deposits))
        : 0n;
    const max = BigInt(d.alarms.max_lamports_per_order);
    if (spent > 0n) {
        if (txs === 0) {
            if (spent > max) d.log.alarm("sol_spent_without_orders", { spentLamports: spent });
        } else if (spent / BigInt(txs) > max) {
            d.log.alarm("sol_per_order_high", {
                spentLamports: spent,
                confirmedPayments: txs,
                lamportsPerTx: spent / BigInt(txs),
            });
        }
    }

    try {
        const { value: float } = await d.rpc
            .getTokenAccountBalance(await usdcAta(d.refundWallet), { commitment: "confirmed" })
            .send(deadline(d.rpcTimeoutMs));
        if (BigInt(float.amount) < BigInt(d.refunds.float_low_micros)) {
            d.log.alarm("refund_float_low", {
                balanceMicros: BigInt(float.amount),
                floatLowMicros: d.refunds.float_low_micros,
            });
        }
    } catch (err) {
        d.log.warn("alarm check failed: refund_float_low", { error: String(err) });
    }

    try {
        const created = await refundsCreatedLastHour(d.pool, now);
        if (created > d.refunds.max_per_hour) {
            d.log.alarm("refunds_per_hour_high", { created, maxPerHour: d.refunds.max_per_hour });
        }
    } catch (err) {
        d.log.warn("alarm check failed: refunds_per_hour_high", { error: String(err) });
    }

    return { at: now, feePayerLamports: lamports, confirmedPayments: txs };
}

async function confirmedPayments(pool: pg.Pool, from: Date, to: Date): Promise<number> {
    const res = await pool.query<{ n: number }>(
        `select count(*)::int as n from payments where status = 'confirmed' and confirmed_at > $1 and confirmed_at <= $2`,
        [from, to],
    );
    return res.rows[0]?.n ?? 0;
}

// Hot refunds and cold transfers are paid for by the fee payer without an order behind them.
async function hotEnds(pool: pg.Pool, from: Date, to: Date): Promise<number> {
    const res = await pool.query<{ n: number }>(
        `select (select count(*) from refunds where from_wallet = 'allowance'
                    and state = 'confirmed' and confirmed_at > $1 and confirmed_at <= $2)::int
              + (select count(*) from x402_cold_transfers
                    where state = 'confirmed' and confirmed_at > $1 and confirmed_at <= $2)::int
              as n`,
        [from, to],
    );
    return res.rows[0]?.n ?? 0;
}

async function refundsCreatedLastHour(pool: pg.Pool, now: Date): Promise<number> {
    const res = await pool.query<{ n: number }>(
        `select count(*)::int as n from refunds
         where from_wallet = 'refund' and created_at > $1::timestamptz - interval '1 hour' and created_at <= $1`,
        [now],
    );
    return res.rows[0]?.n ?? 0;
}

// The fee payer's SOL that deposit moves used in [from, to): every landed or failed move's fee
// (a refused preflight costs nothing), a create's rent out, and a close's rent back to itself
export async function depositLamports(
    pool: pg.Pool,
    from: Date,
    to: Date,
    feePayer: string,
    cfg: Settings["deposits"],
): Promise<bigint> {
    const { rows } = await pool.query<{
        kind: "create" | "sweep" | "return" | "close";
        state: string;
        closes: boolean;
        close_to: string | null;
        preflight_refused_at: Date | null;
    }>(
        `select kind, state, closes, close_to, preflight_refused_at from deposit_moves
         where (state = 'confirmed' and confirmed_at >= $1 and confirmed_at < $2)
            or (state = 'failed' and failed_at >= $1 and failed_at < $2)`,
        [from, to],
    );
    let sum = 0n;
    for (const m of rows) {
        sum += moveFeeLamports({ kind: m.kind, preflightRefusedAt: m.preflight_refused_at }, cfg);
        if (m.state !== "confirmed") continue;
        if (m.kind === "create") sum += TOKEN_ACCOUNT_RENT_LAMPORTS;
        if (m.closes && m.close_to === feePayer) sum -= TOKEN_ACCOUNT_RENT_LAMPORTS;
    }
    return sum;
}
