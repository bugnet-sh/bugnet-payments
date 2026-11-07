import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx, type Queryable } from "../db/pool.ts";
import type { Log } from "../log.ts";
import { findAccount, leftMicros, lockAccount, movePool } from "./ledger.ts";
import type { Listed, SellerHintText, X402PaymentRow, X402PaymentState } from "./types.ts";

export interface ReserveInput {
    id: string;
    ref: string;
    accountId: string;
    placementId: string;
    serviceId: string;
    method: string;
    host: string;
    path: string;
    targetSha256: Buffer;
    bodySha256: Buffer;
    amountMicros: number;
    payTo: string;
    payToTokenAccount: string;
    feePayer: string;
    listed: Listed;
}

export type ReserveRefusal =
    | "account_closed"
    | "allowance_spent"
    | "rate_cap"
    | "too_many_open_payments"
    | "payto_daily_cap"
    | "outflow_cap";

export type ReserveResult =
    | { ok: true; capDay: string; leftMicros: number }
    | { ok: false; reason: ReserveRefusal; leftMicros: number };

export type RoomChange = "confirmed" | "expired_unlanded" | "failed_onchain";

const RELEASE_BATCH = 50;

// pg parses a date column as a local-time Date, so cap_day is read as text
export const X402_PAYMENT_COLUMNS = `id, ref, account_id, service_id, placement_id, method, host,
    path, target_sha256, body_sha256, amount_micros, pay_to, pay_to_token_account, fee_payer,
    listed, cap_day::text as cap_day, state, blockhash, last_valid_block_height, signing_slot,
    memo, compute_unit_limit, compute_unit_price_microlamports, accepted_json, message_hash,
    our_signature_sha256, payment_identifier, keep_until, landed_slot, expiry_seen_slot,
    tx_signature, late_landed, hint, hint_tx, hint_error, http_status, stream_cut, ended_clean,
    created_at, signed_at, resolved_at`;

class ReserveRefused extends Error {
    constructor(readonly reason: ReserveRefusal) {
        super(reason);
    }
}

const outflowAlarmed = new Set<string>();

export function utcDay(at: Date): string {
    return at.toISOString().slice(0, 10);
}

function big(v: unknown): bigint | null {
    return v === null || v === undefined ? null : BigInt(v as string | number | bigint);
}

function num(v: unknown): number | null {
    return v === null || v === undefined ? null : Number(v);
}

export function toX402Payment(r: Record<string, unknown>): X402PaymentRow {
    return {
        id: r.id as string,
        ref: r.ref as string,
        accountId: r.account_id as string,
        serviceId: r.service_id as string,
        placementId: r.placement_id as string,
        method: r.method as string,
        host: r.host as string,
        path: r.path as string,
        targetSha256: r.target_sha256 as Buffer,
        bodySha256: r.body_sha256 as Buffer,
        amountMicros: Number(r.amount_micros),
        payTo: r.pay_to as string,
        payToTokenAccount: r.pay_to_token_account as string,
        feePayer: r.fee_payer as string,
        listed: r.listed as Listed,
        capDay: r.cap_day as string,
        state: r.state as X402PaymentState,
        blockhash: (r.blockhash as string | null) ?? null,
        lastValidBlockHeight: big(r.last_valid_block_height),
        signingSlot: big(r.signing_slot),
        memo: (r.memo as Buffer | null) ?? null,
        computeUnitLimit: num(r.compute_unit_limit),
        computeUnitPriceMicroLamports: big(r.compute_unit_price_microlamports),
        acceptedJson: (r.accepted_json as string | null) ?? null,
        messageHash: (r.message_hash as string | null) ?? null,
        ourSignatureSha256: (r.our_signature_sha256 as Buffer | null) ?? null,
        paymentIdentifier: (r.payment_identifier as string | null) ?? null,
        keepUntil: (r.keep_until as Date | null) ?? null,
        landedSlot: big(r.landed_slot),
        expirySeenSlot: big(r.expiry_seen_slot),
        txSignature: (r.tx_signature as string | null) ?? null,
        lateLanded: r.late_landed as boolean,
        hint: (r.hint as SellerHintText | null) ?? null,
        hintTx: (r.hint_tx as string | null) ?? null,
        hintError: (r.hint_error as string | null) ?? null,
        httpStatus: num(r.http_status),
        streamCut: r.stream_cut as boolean,
        endedClean: r.ended_clean as boolean,
        createdAt: r.created_at as Date,
        signedAt: (r.signed_at as Date | null) ?? null,
        resolvedAt: (r.resolved_at as Date | null) ?? null,
    };
}

export async function findX402Payment(db: Queryable, id: string): Promise<X402PaymentRow | null> {
    const res = await db.query(`select ${X402_PAYMENT_COLUMNS} from x402_payments where id = $1`, [
        id,
    ]);
    return res.rows[0] ? toX402Payment(res.rows[0]) : null;
}

async function addToDay(
    c: pg.PoolClient,
    table: "x402_payto_days" | "x402_unlisted_days" | "x402_outflow_days",
    key: string | null,
    day: string,
    amount: number,
    cap: number,
    refusal: ReserveRefusal,
): Promise<void> {
    const keyed = key !== null;
    const keyCol = keyed ? "pay_to, " : "";
    const keyVal = keyed ? "$2, " : "";
    const keyWhere = keyed ? "pay_to = $3 and " : "";
    const params: unknown[] = [day, amount];
    if (keyed) params.push(key);
    params.push(cap);
    await c.query(
        `insert into ${table} (${keyCol}day) values (${keyVal}$1::date) on conflict do nothing`,
        keyed ? [day, key] : [day],
    );
    const res = await c.query(
        `update ${table} set micros = micros + $2
         where ${keyWhere}day = $1::date and micros + $2 <= $${params.length} returning micros`,
        params,
    );
    if (res.rows.length !== 1) throw new ReserveRefused(refusal);
}

async function giveBackDays(
    c: pg.PoolClient,
    p: { payTo: string; listed: Listed; capDay: string; amountMicros: number },
): Promise<void> {
    await c.query(
        `update x402_payto_days set micros = micros - $3
         where pay_to = $1 and day = $2::date`,
        [p.payTo, p.capDay, p.amountMicros],
    );
    if (p.listed === "unlisted") {
        await c.query(`update x402_unlisted_days set micros = micros - $2 where day = $1::date`, [
            p.capDay,
            p.amountMicros,
        ]);
    }
    await c.query(`update x402_outflow_days set micros = micros - $2 where day = $1::date`, [
        p.capDay,
        p.amountMicros,
    ]);
}

export async function reserve(
    pool: pg.Pool,
    r: ReserveInput,
    x402: Settings["x402"],
    log: Log,
    now: Date,
): Promise<ReserveResult> {
    const day = utcDay(now);
    const amount = r.amountMicros;
    try {
        const left = await withTx(pool, async (c) => {
            const step1 = await c.query<{ left_micros: string }>(
                `update x402_accounts set
                    held_micros = held_micros + $2,
                    minute_micros = case when minute_start < date_trunc('minute', $3::timestamptz, 'UTC')
                        then $2 else minute_micros + $2 end,
                    minute_start = greatest(minute_start, date_trunc('minute', $3::timestamptz, 'UTC'))
                 where id = $1 and state = 'open'
                    and funded_micros - spent_micros - held_micros - refunded_micros - kept_micros >= $2
                    and (case when minute_start < date_trunc('minute', $3::timestamptz, 'UTC')
                        then 0 else minute_micros end) + $2 <= spend_per_minute_micros
                 returning funded_micros - spent_micros - held_micros - refunded_micros
                    - kept_micros as left_micros`,
                [r.accountId, amount, now],
            );
            if (step1.rows.length !== 1) throw new ReserveRefused("account_closed");

            const open = await c.query<{ n: string }>(
                `select count(*) as n from x402_payments
                 where placement_id = $1 and state in ('reserved', 'signed')
                    and landed_slot is null`,
                [r.placementId],
            );
            if (Number(open.rows[0]!.n) >= x402.max_open_payments_per_placement) {
                throw new ReserveRefused("too_many_open_payments");
            }

            const paytoCap =
                r.listed === "indexed"
                    ? x402.payto_daily_cap_indexed_micros
                    : x402.payto_daily_cap_unlisted_micros;
            await addToDay(c, "x402_payto_days", r.payTo, day, amount, paytoCap, "payto_daily_cap");
            if (r.listed === "unlisted") {
                await addToDay(
                    c,
                    "x402_unlisted_days",
                    null,
                    day,
                    amount,
                    x402.unlisted_daily_cap_micros,
                    "payto_daily_cap",
                );
            }
            await addToDay(
                c,
                "x402_outflow_days",
                null,
                day,
                amount,
                x402.outflow_daily_cap_micros,
                "outflow_cap",
            );

            await c.query(
                `insert into x402_payments (id, ref, account_id, service_id, placement_id, method,
                    host, path, target_sha256, body_sha256, amount_micros, pay_to,
                    pay_to_token_account, fee_payer, listed, cap_day, state, created_at)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                    $16::date, 'reserved', $17)`,
                [
                    r.id,
                    r.ref,
                    r.accountId,
                    r.serviceId,
                    r.placementId,
                    r.method,
                    r.host,
                    r.path,
                    r.targetSha256,
                    r.bodySha256,
                    amount,
                    r.payTo,
                    r.payToTokenAccount,
                    r.feePayer,
                    r.listed,
                    day,
                    now,
                ],
            );
            return Number(step1.rows[0]!.left_micros);
        });
        return { ok: true, capDay: day, leftMicros: left };
    } catch (err) {
        if (!(err instanceof ReserveRefused)) throw err;
        const account = await findAccount(pool, r.accountId);
        const left = account ? leftMicros(account) : 0;
        let reason = err.reason;
        if (reason === "account_closed" && account?.state === "open") {
            reason = left < amount ? "allowance_spent" : "rate_cap";
        }
        if (reason === "outflow_cap" && !outflowAlarmed.has(day)) {
            outflowAlarmed.add(day);
            log.alarm("x402_outflow_cap", { day, capMicros: x402.outflow_daily_cap_micros });
        }
        return { ok: false, reason, leftMicros: left };
    }
}

async function accountOf(db: Queryable, paymentId: string): Promise<string | null> {
    const res = await db.query<{ account_id: string }>(
        "select account_id from x402_payments where id = $1",
        [paymentId],
    );
    return res.rows[0]?.account_id ?? null;
}

export async function releaseReserved(
    pool: pg.Pool,
    paymentId: string,
    at: Date,
): Promise<boolean> {
    const accountId = await accountOf(pool, paymentId);
    if (accountId === null) return false;
    return withTx(pool, async (c) => {
        await lockAccount(c, accountId);
        const res = await c.query<{
            amount_micros: string;
            pay_to: string;
            listed: Listed;
            cap_day: string;
        }>(
            `update x402_payments set state = 'released', resolved_at = $2
             where id = $1 and state = 'reserved'
             returning amount_micros, pay_to, listed, cap_day::text as cap_day`,
            [paymentId, at],
        );
        const row = res.rows[0];
        if (!row) return false;
        const amountMicros = Number(row.amount_micros);
        await c.query("update x402_accounts set held_micros = held_micros - $2 where id = $1", [
            accountId,
            amountMicros,
        ]);
        await giveBackDays(c, {
            payTo: row.pay_to,
            listed: row.listed,
            capDay: row.cap_day,
            amountMicros,
        });
        return true;
    });
}

export async function resolveSigned(
    c: pg.PoolClient,
    paymentId: string,
    to: RoomChange,
    f: { landedSlot?: bigint; txSignature?: string },
    at: Date,
    x402: Settings["x402"],
    log: Log,
): Promise<X402PaymentRow | null> {
    const accountId = await accountOf(c, paymentId);
    if (accountId === null) return null;
    await lockAccount(c, accountId);
    const res = await c.query(
        `update x402_payments set state = $2, resolved_at = $3,
            landed_slot = coalesce($4, landed_slot), tx_signature = coalesce($5, tx_signature)
         where id = $1 and state = 'signed'
         returning ${X402_PAYMENT_COLUMNS}`,
        [paymentId, to, at, f.landedSlot?.toString() ?? null, f.txSignature ?? null],
    );
    if (res.rows.length !== 1) return null;
    const row = toX402Payment(res.rows[0]!);
    if (to === "confirmed") {
        await c.query(
            `update x402_accounts set held_micros = held_micros - $2, spent_micros = spent_micros + $2
             where id = $1`,
            [accountId, row.amountMicros],
        );
        await movePool(c, { committed: -row.amountMicros }, x402, log);
    } else {
        await c.query("update x402_accounts set held_micros = held_micros - $2 where id = $1", [
            accountId,
            row.amountMicros,
        ]);
        await giveBackDays(c, row);
    }
    return row;
}

export async function runReleaseJob(
    pool: pg.Pool,
    x402: Settings["x402"],
    _log: Log,
    now: Date,
): Promise<number> {
    const due = await pool.query<{ id: string }>(
        `select id from x402_payments
         where state = 'reserved' and created_at < $1::timestamptz - make_interval(secs => $2::float8 / 1000.0)
         order by created_at limit ${RELEASE_BATCH}`,
        [now, x402.reserved_release_after],
    );
    let released = 0;
    for (const { id } of due.rows) {
        if (await releaseReserved(pool, id, now)) released++;
    }
    return released;
}
