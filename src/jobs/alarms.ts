/**
 * Alarm checks, run every `jobs.alarms_every`.
 *
 * Each run reads the fee payer's SOL balance and compares it with the previous run's snapshot:
 * the SOL spent since then, divided by the payments confirmed since then (refunds are not counted), is the cost per paid
 * order. A balance that rose (a top-up) raises no ratio alarm. Refund float and refund rate are
 * checked on every run.
 */
import type { Address } from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import type { Log } from "../log.ts";
import { usdcAta } from "../solana/accounts.ts";
import type { SolanaRpc } from "../solana/rpc.ts";

export interface AlarmSnapshot {
    at: Date;
    feePayerLamports: bigint;
    feePayingTxs: number;
}

export interface AlarmDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    feePayer: Address;
    refundWallet: Address;
    alarms: Settings["alarms"];
    refunds: Settings["refunds"];
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
        .send();
    const txs = prev ? await confirmedPayments(d.pool, prev.at, now) : 0;

    if (lamports < BigInt(d.alarms.fee_payer_min_lamports)) {
        d.log.alarm("fee_payer_sol_low", {
            lamports,
            minLamports: d.alarms.fee_payer_min_lamports,
        });
    }

    const spent = prev ? prev.feePayerLamports - lamports : 0n;
    const max = BigInt(d.alarms.max_lamports_per_order);
    if (spent > 0n) {
        if (txs === 0) {
            if (spent > max) d.log.alarm("sol_spent_without_orders", { spentLamports: spent });
        } else if (spent / BigInt(txs) > max) {
            d.log.alarm("sol_per_order_high", {
                spentLamports: spent,
                feePayingTxs: txs,
                lamportsPerTx: spent / BigInt(txs),
            });
        }
    }

    const { value: float } = await d.rpc
        .getTokenAccountBalance(await usdcAta(d.refundWallet), { commitment: "confirmed" })
        .send();
    if (BigInt(float.amount) < BigInt(d.refunds.float_low_micros)) {
        d.log.alarm("refund_float_low", {
            balanceMicros: BigInt(float.amount),
            floatLowMicros: d.refunds.float_low_micros,
        });
    }

    const created = await refundsCreatedLastHour(d.pool, now);
    if (created > d.refunds.max_per_hour) {
        d.log.alarm("refunds_per_hour_high", { created, maxPerHour: d.refunds.max_per_hour });
    }

    return { at: now, feePayerLamports: lamports, feePayingTxs: txs };
}

async function confirmedPayments(pool: pg.Pool, from: Date, to: Date): Promise<number> {
    const res = await pool.query<{ n: number }>(
        `select count(*)::int as n from payments where confirmed_at > $1 and confirmed_at <= $2`,
        [from, to],
    );
    return res.rows[0]?.n ?? 0;
}

async function refundsCreatedLastHour(pool: pg.Pool, now: Date): Promise<number> {
    const res = await pool.query<{ n: number }>(
        `select count(*)::int as n from refunds
         where created_at > $1::timestamptz - interval '1 hour' and created_at <= $1`,
        [now],
    );
    return res.rows[0]?.n ?? 0;
}
