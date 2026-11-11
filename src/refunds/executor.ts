/**
 * Refund executor and its pause controls.
 *
 * Each tick takes up to five refunds, oldest first, each under its own row lock and transaction.
 * A pending refund first locks the refund_controls row, so the pause, daily cap, hourly rate and
 * float checks of every runner happen one at a time. It is then signed and stored as `signed`
 * before the send, so a crash never loses a transaction that may land. A signed or sent refund is
 * checked once it is 20 s old, finalized height first and signature status second, its earlier
 * attempts' signatures read with it. It is then
 * confirmed, sent to the manual queue when it failed, signed again when its blockhash expired and
 * the signature is not found (up to max_attempts), or else resent unchanged. While refunds are
 * paused a tick only records what the chain decided and signs or sends nothing. An RPC error, or
 * an RPC call past `solana.rpc_timeout`, leaves the refund as it was for the next tick.
 *
 * Refunds paid from the allowance wallet (the hot ones) run as a second wallet of the same tick
 * loop. They ignore the pause, the kill switch and the [refunds] caps; only `refunds_held` stops
 * them signing, and a daily budget of their own limits what a first signing may send. A blockhash
 * that expired is signed again only once the mirror proves no earlier signature can still land.
 */
import {
    address,
    type Address,
    type Base64EncodedWireTransaction,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    isAddress,
    type KeyPairSigner,
} from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import { type Queryable, withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import { findPaymentByOrder, lockOrder, setOrderState } from "../orders/store.ts";
import { ownedUsdcAccount, usdcAta } from "../solana/accounts.ts";
import type { BlockhashHint } from "../solana/blockhash.ts";
import { MEMO_PROGRAM } from "../solana/constants.ts";
import { readLanding } from "../solana/landing.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";
import { signV0Transaction, usdcTransferChecked } from "../solana/transfer.ts";
import { readControls } from "../x402/controls.ts";
import { utcDay } from "../x402/reserve.ts";
import { resignProof } from "../x402/resign.ts";
import { confirmHotRefund } from "./hot.ts";
import { type RefundDbRow, type RefundRow, type RefundWallet, toRefund } from "./request.ts";

export interface RefundDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    feePayer: KeyPairSigner;
    refundSigner: KeyPairSigner;
    allowanceSigner: KeyPairSigner | null;
    x402: Settings["x402"];
    hotTokenAccount: Address | null;
    cfg: Settings["refunds"];
    rpcTimeoutMs: number;
    log: Log;
    now: () => Date;
}

export interface RefundTick {
    sent: number;
    resent: number;
    resigned: number;
    confirmed: number;
    manual: number;
    paused: string | null;
}

export interface SignedRefund {
    wire: string;
    signature: string;
    lastValidBlockHeight: bigint;
}

type ManualReason =
    | "refund_exceeds_payment"
    | "refund_destination_invalid"
    | "refund_exceeds_cap"
    | "refund_failed_onchain"
    | "refund_expired_repeatedly"
    | "refund_balance_short"
    | "x402_refund_budget";

type Step =
    | { kind: "send"; signed: SignedRefund; resigned: boolean }
    | { kind: "resend"; wire: string; signature: string }
    | { kind: "confirmed"; signature: string }
    | { kind: "manual"; reason: ManualReason }
    | { kind: "pause"; reason: "daily_cap" | "hourly_rate" }
    | { kind: "float_low"; balanceMicros: bigint; unconfirmedMicros: number }
    | { kind: "held"; paused: string }
    | { kind: "wait" };

type InFlight = RefundRow & { txSignature: string; wireTx: string; lastValidBlockHeight: bigint };

const PER_TICK = 5;
export const FRESH_SEND = { encoding: "base64", preflightCommitment: "confirmed" } as const;
export const RESEND = { encoding: "base64", skipPreflight: true, maxRetries: 0n } as const;
const REFUND_AGE_MS = 20_000;
// Zero rows back means the day's total would pass the cap; a waived row passes it anyway
const SPEND_BUDGET = `insert into x402_refund_days as d (day, micros)
    select $1::date, $2::bigint where $2::bigint <= $3::bigint or $4::boolean
    on conflict (day) do update set micros = d.micros + excluded.micros
        where d.micros + excluded.micros <= $3::bigint or $4::boolean
    returning micros`;
const SELECT_CONTROLS = "select paused, reason from refund_controls where id = 1";

// An RPC failure is routine and retried, every other failure in a step needs an operator's eye
export class RpcUnavailable extends Error {}

export async function viaRpc<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (err) {
        throw new RpcUnavailable("rpc call failed", { cause: err });
    }
}

export async function buildRefundTransaction(
    d: Pick<RefundDeps, "feePayer" | "cfg">,
    r: { destination: Address; amountMicros: number; source: KeyPairSigner; memo: string | null },
    hint: BlockhashHint,
): Promise<SignedRefund> {
    const signed = await signV0Transaction({
        feePayer: d.feePayer,
        blockhash: hint.blockhash,
        lastValidBlockHeight: hint.lastValidBlockHeight,
        computeUnitLimit: d.cfg.compute_unit_limit,
        computeUnitPrice: d.cfg.compute_unit_price_micro_lamports,
        instructions: [
            await usdcTransferChecked(r.source, r.destination, BigInt(r.amountMicros)),
            ...(r.memo === null
                ? []
                : [{ programAddress: MEMO_PROGRAM, data: new TextEncoder().encode(r.memo) }]),
        ],
    });
    return {
        wire: getBase64EncodedWireTransaction(signed),
        signature: getSignatureFromTransaction(signed),
        lastValidBlockHeight: hint.lastValidBlockHeight,
    };
}

export async function pauseRefunds(pool: pg.Pool, reason: string, log: Log): Promise<void> {
    const res = await pool.query(
        `update refund_controls set paused = true, reason = $1, paused_at = now()
         where id = 1 and not paused`,
        [reason],
    );
    if (res.rowCount === 1) log.alarm("refunds_paused", { reason });
}

export async function resumeRefunds(pool: pg.Pool): Promise<void> {
    await pool.query(
        "update refund_controls set paused = false, reason = null, paused_at = null where id = 1",
    );
}

export async function refundsPaused(db: Queryable): Promise<string | null> {
    return pauseReason(await db.query(SELECT_CONTROLS));
}

// Held until COMMIT, so a second runner checks the caps only after this refund is stored
async function lockControls(c: pg.PoolClient): Promise<string | null> {
    return pauseReason(await c.query(`${SELECT_CONTROLS} for update`));
}

function pauseReason(res: pg.QueryResult<{ paused: boolean; reason: string | null }>) {
    const row = res.rows[0];
    return row?.paused ? (row.reason ?? "paused") : null;
}

export async function runRefunds(d: RefundDeps, wallet: RefundWallet): Promise<RefundTick> {
    if (wallet === "allowance" && (d.allowanceSigner === null || d.hotTokenAccount === null)) {
        throw new Error("hot refunds need the allowance wallet");
    }
    const tick: RefundTick = {
        sent: 0,
        resent: 0,
        resigned: 0,
        confirmed: 0,
        manual: 0,
        paused:
            wallet === "refund"
                ? await refundsPaused(d.pool)
                : (await readControls(d.pool)).refundsHeld
                  ? "refunds_held"
                  : null,
    };
    const taken: number[] = [];
    for (let i = 0; i < PER_TICK; i++) {
        const now = d.now();
        const current: { refund?: RefundRow } = {};
        const takenBefore = taken.length;
        try {
            const step = await withTx(d.pool, async (c) => {
                // A deadlock re-run starts this callback again over the same closure
                taken.length = takenBefore;
                current.refund = undefined;
                const pick = await pickRefund(c, taken, now, tick.paused === null, wallet);
                if (pick === null) return null;
                taken.push(pick.id);
                if (pick.kind !== "allowance") await lockOrder(c, pick.orderId);
                const r = await lockRefund(c, pick.id);
                if (r === null) return { kind: "wait" } satisfies Step;
                current.refund = r;
                if (!isDue(r, now, tick.paused === null)) return { kind: "wait" } satisfies Step;
                return r.state === "pending"
                    ? checkPending(d, c, r, now)
                    : checkInFlight(d, c, r, now);
            });
            if (step === null) break;
            if (current.refund === undefined) continue;
            await finish(d, current.refund, step, now, tick);
        } catch (err) {
            const ids = { refundId: current.refund?.id, orderId: current.refund?.orderId };
            if (err instanceof RpcUnavailable) {
                d.log.warn("refund rpc call failed, retrying next tick", {
                    ...ids,
                    err: err.cause,
                });
            } else {
                d.log.error("refund step failed, retrying next tick", { ...ids, err });
            }
        }
    }
    return tick;
}

// The pick takes no lock; the runner locks the order and the row, then checks the same
// predicate again, so a refund another runner just signed is left alone. The age keeps a
// refund just signed away from a second runner.
async function pickRefund(
    c: pg.PoolClient,
    taken: readonly number[],
    now: Date,
    withPending: boolean,
    wallet: RefundWallet,
): Promise<{ id: number; orderId: string; kind: RefundRow["kind"] } | null> {
    const res = await c.query<{ id: string | number; order_id: string; kind: RefundRow["kind"] }>(
        `select id, order_id, kind from refunds
         where id <> all($1::bigint[]) and from_wallet = $4
           and ((state = 'pending' and $3::boolean)
                or (state in ('signed', 'sent')
                    and coalesce(sent_at, signed_at) <= $2::timestamptz - $5::bigint * interval '1 millisecond'))
         order by created_at, id
         limit 1`,
        [taken, now, withPending, wallet, REFUND_AGE_MS],
    );
    const row = res.rows[0];
    return row ? { id: Number(row.id), orderId: row.order_id, kind: row.kind } : null;
}

async function lockRefund(c: pg.PoolClient, id: number): Promise<RefundRow | null> {
    const res = await c.query<RefundDbRow>(
        "select * from refunds where id = $1 for no key update",
        [id],
    );
    return res.rows[0] ? toRefund(res.rows[0]) : null;
}

function isDue(r: RefundRow, now: Date, withPending: boolean): boolean {
    if (r.state === "pending") return withPending;
    if (r.state !== "signed" && r.state !== "sent") return false;
    const since = r.sentAt ?? r.signedAt;
    return since !== null && since.getTime() <= now.getTime() - REFUND_AGE_MS;
}

function checkPending(d: RefundDeps, c: pg.PoolClient, r: RefundRow, now: Date): Promise<Step> {
    return r.fromWallet === "allowance"
        ? checkHotPending(d, c, r, now)
        : checkColdPending(d, c, r, now);
}

async function checkHotPending(
    d: RefundDeps,
    c: pg.PoolClient,
    r: RefundRow,
    now: Date,
): Promise<Step> {
    if ((await readControls(c)).refundsHeld) return { kind: "held", paused: "refunds_held" };
    if (!(await withinPayment(c, r))) return toManual(c, r, "refund_exceeds_payment");
    if (!(await viaRpc(() => destinationValid(d, r)))) {
        return toManual(c, r, "refund_destination_invalid");
    }
    const balance = (await viaRpc(() => hotBalance(d))) - (await hotUnconfirmed(c));
    if (balance < BigInt(r.amountMicros)) {
        return toManual(c, r, "refund_balance_short");
    }
    return sign(d, c, r, now, false);
}

// The caller holds the order lock of a full or partial refund
async function withinPayment(c: pg.PoolClient, r: RefundRow): Promise<boolean> {
    if (r.kind === "allowance") {
        const res = await c.query<{ allowance_micros: string }>(
            "select allowance_micros from x402_fundings where order_id = $1",
            [r.orderId],
        );
        const funded = res.rows[0];
        return funded !== undefined && r.amountMicros <= Number(funded.allowance_micros);
    }
    if (r.kind === "full") {
        const payment = await findPaymentByOrder(c, r.orderId);
        return payment !== null && r.amountMicros <= payment.amountMicros;
    }
    const order = await lockOrder(c, r.orderId);
    return order !== null && r.amountMicros <= order.amountMicros - order.allowanceMicros;
}

async function hotBalance(d: RefundDeps): Promise<bigint> {
    const { value } = await d.rpc
        .getTokenAccountBalance(d.hotTokenAccount!, { commitment: "confirmed" })
        .send(deadline(d.rpcTimeoutMs));
    return BigInt(value.amount);
}

// The confirmed balance does not show what is signed and still on its way out
async function hotUnconfirmed(c: pg.PoolClient): Promise<bigint> {
    const res = await c.query<{ total: string }>(
        `select (
            (select coalesce(sum(amount_micros), 0) from refunds
             where state in ('signed', 'sent') and from_wallet = 'allowance')
          + (select coalesce(sum(amount_micros), 0) from x402_cold_transfers
             where state in ('signed', 'sent'))
         )::text as total`,
    );
    return BigInt(res.rows[0]?.total ?? 0);
}

async function checkColdPending(
    d: RefundDeps,
    c: pg.PoolClient,
    r: RefundRow,
    now: Date,
): Promise<Step> {
    const paused = await lockControls(c);
    if (paused !== null) return { kind: "held", paused };
    const payment = await findPaymentByOrder(c, r.orderId);
    if (payment === null || r.amountMicros > payment.amountMicros) {
        return toManual(c, r, "refund_exceeds_payment");
    }
    if (!(await viaRpc(() => destinationValid(d, r)))) {
        return toManual(c, r, "refund_destination_invalid");
    }
    // No later day would let it through, so pausing for it would stop every refund behind it
    if (r.amountMicros > d.cfg.daily_cap_micros) {
        return toManual(c, r, "refund_exceeds_cap");
    }
    if ((await signedToday(c, now)) + r.amountMicros > d.cfg.daily_cap_micros) {
        return { kind: "pause", reason: "daily_cap" };
    }
    if ((await signedLastHour(c, now)) >= d.cfg.max_per_hour) {
        return { kind: "pause", reason: "hourly_rate" };
    }
    const balanceMicros = await viaRpc(() => floatBalance(d));
    const unconfirmedMicros = await unconfirmedTotal(c);
    if (balanceMicros - BigInt(unconfirmedMicros) < BigInt(r.amountMicros)) {
        return { kind: "float_low", balanceMicros, unconfirmedMicros };
    }
    return sign(d, c, r, now, false);
}

async function checkInFlight(
    d: RefundDeps,
    c: pg.PoolClient,
    r: RefundRow,
    now: Date,
): Promise<Step> {
    if (!isInFlight(r)) {
        throw new Error(`refund ${r.id} is ${r.state} without a stored transaction`);
    }
    // An earlier attempt can still land after a re-sign, and then this refund is paid already
    const read = await viaRpc(() =>
        readLanding(
            d.rpc,
            r.txSignature,
            r.lastValidBlockHeight,
            d.rpcTimeoutMs,
            r.previousSignatures,
        ),
    );
    switch (read.landing) {
        case "processed":
            return { kind: "wait" };
        case "onchain_failed":
            return toManual(c, r, "refund_failed_onchain");
        case "landed":
            return r.fromWallet === "allowance"
                ? confirmHot(d, c, r, read, now)
                : confirm(c, r, read.signature, now);
        case "blockhash_expired":
            if (r.fromWallet === "allowance") return checkHotExpired(d, c, r, now);
            if (r.attempts >= d.cfg.max_attempts) {
                return toManual(c, r, "refund_expired_repeatedly");
            }
            return unlessPaused(c, () => sign(d, c, r, now, true));
        case "not_found": {
            const resend: Step = { kind: "resend", wire: r.wireTx, signature: r.txSignature };
            // Its own bytes cannot move more money than the first signing did, so a hold does not stop it
            return r.fromWallet === "allowance" ? resend : unlessPaused(c, async () => resend);
        }
    }
}

async function confirmHot(
    d: RefundDeps,
    c: pg.PoolClient,
    r: RefundRow,
    read: { signature: string; slot: bigint },
    now: Date,
): Promise<Step> {
    clearResignWait(`refund:${r.id}`);
    const done = await confirmHotRefund(
        c,
        r.id,
        { slot: read.slot, signature: read.signature },
        now,
        d.x402,
        d.log,
    );
    return done ? { kind: "confirmed", signature: read.signature } : { kind: "wait" };
}

// 7.10: signed again only when the mirror proves no signature of the row can still land
async function checkHotExpired(
    d: RefundDeps,
    c: pg.PoolClient,
    r: InFlight,
    now: Date,
): Promise<Step> {
    const key = `refund:${r.id}`;
    const proof = await resignProof(
        c,
        d.rpc,
        { signatures: [r.txSignature, ...r.previousSignatures], expirySeenSlot: r.expirySeenSlot },
        d.x402,
        d.rpcTimeoutMs,
    );
    if (proof === "wait") {
        noteResignWait(key, now, d.x402, d.log, { refundId: r.id, orderId: r.orderId });
        return { kind: "wait" };
    }
    clearResignWait(key);
    if (proof === "landed") return { kind: "wait" };
    if ((await readControls(c)).refundsHeld) {
        await c.query("update refunds set state = 'pending' where id = $1", [r.id]);
        return { kind: "wait" };
    }
    if (r.attempts >= d.cfg.max_attempts) return toManual(c, r, "refund_expired_repeatedly");
    return sign(d, c, r, now, true);
}

const resignWaits = new Map<string, { since: number; alarmed: boolean }>();

// Process-local: a restart starts the wait over, which only delays the alarm
export function noteResignWait(
    key: string,
    now: Date,
    x402: Settings["x402"],
    log: Log,
    fields: Record<string, unknown>,
): void {
    const wait = resignWaits.get(key) ?? { since: now.getTime(), alarmed: false };
    resignWaits.set(key, wait);
    if (wait.alarmed || now.getTime() - wait.since <= x402.resign_wait_alarm_after) return;
    wait.alarmed = true;
    log.alarm("x402_resign_waiting", fields);
}

export function clearResignWait(key: string): void {
    resignWaits.delete(key);
}

// A pause stops money leaving, so a paused tick records chain results but sends nothing
async function unlessPaused(c: pg.PoolClient, next: () => Promise<Step>): Promise<Step> {
    const paused = await refundsPaused(c);
    return paused === null ? next() : { kind: "held", paused };
}

function isInFlight(r: RefundRow): r is InFlight {
    return r.txSignature !== null && r.wireTx !== null && r.lastValidBlockHeight !== null;
}

async function destinationValid(d: RefundDeps, r: RefundRow): Promise<boolean> {
    if (!isAddress(r.destination)) return false;
    return ownedUsdcAccount(d.rpc, r.destination, r.payer, d.rpcTimeoutMs);
}

async function floatBalance(d: RefundDeps): Promise<bigint> {
    const { value } = await d.rpc
        .getTokenAccountBalance(await usdcAta(d.refundSigner.address), { commitment: "confirmed" })
        .send(deadline(d.rpcTimeoutMs));
    return BigInt(value.amount);
}

// A refund that landed but is not confirmed here yet counts twice, which can only pause early
async function unconfirmedTotal(c: pg.PoolClient): Promise<number> {
    const res = await c.query<{ total: string }>(
        `select coalesce(sum(amount_micros), 0)::text as total from refunds
         where state in ('signed', 'sent') and from_wallet = 'refund'`,
    );
    return Number(res.rows[0]?.total ?? 0);
}

async function signedToday(c: pg.PoolClient, now: Date): Promise<number> {
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const res = await c.query<{ total: string }>(
        `select coalesce(sum(amount_micros), 0)::text as total from refunds
         where state in ('signed', 'sent', 'confirmed') and from_wallet = 'refund'
           and signed_at >= $1`,
        [midnight],
    );
    return Number(res.rows[0]?.total ?? 0);
}

// A pending row may keep the signed_at of an attempt an operator retried, so it is not counted
async function signedLastHour(c: pg.PoolClient, now: Date): Promise<number> {
    const res = await c.query<{ n: number }>(
        `select count(*)::int as n from refunds
         where state <> 'pending' and from_wallet = 'refund'
           and signed_at > $1::timestamptz - interval '1 hour'`,
        [now],
    );
    return res.rows[0]?.n ?? 0;
}

async function sign(
    d: RefundDeps,
    c: pg.PoolClient,
    r: RefundRow,
    now: Date,
    resigned: boolean,
): Promise<Step> {
    const hot = r.fromWallet === "allowance";
    const { context, value } = await viaRpc(() =>
        d.rpc.getLatestBlockhash({ commitment: "confirmed" }).send(deadline(d.rpcTimeoutMs)),
    );
    const signed = await buildRefundTransaction(
        d,
        {
            destination: address(r.destination),
            amountMicros: r.amountMicros,
            source: hot ? d.allowanceSigner! : d.refundSigner,
            memo: hot ? `bugnet-refund ${r.id}` : null,
        },
        value,
    );
    // The same amount to the same account under the same blockhash is the same transaction
    const twin = await c.query("select 1 from refunds where tx_signature = $1", [signed.signature]);
    if (twin.rowCount !== 0) {
        d.log.info("identical refund transaction already stored, signing on a later blockhash", {
            refundId: r.id,
            orderId: r.orderId,
        });
        return { kind: "wait" };
    }
    const firstSigning = r.txSignature === null && r.previousSignatures.length === 0;
    if (hot && firstSigning) {
        const day = await c.query(SPEND_BUDGET, [
            utcDay(now),
            r.amountMicros,
            d.x402.refund_daily_cap_micros,
            r.budgetWaived,
        ]);
        if (day.rowCount === 0) return toManual(c, r, "x402_refund_budget");
    }
    await c.query(
        `update refunds set state = 'signed', wire_tx = $2, tx_signature = $3,
            last_valid_block_height = $4, signed_at = $5, sent_at = null, attempts = attempts + 1,
            previous_signatures = case when tx_signature is null then previous_signatures
                else array_append(previous_signatures, tx_signature) end,
            signing_slot = case when $6::boolean then $7::bigint else signing_slot end,
            expiry_seen_slot = case when $6::boolean then null else expiry_seen_slot end
         where id = $1`,
        [
            r.id,
            signed.wire,
            signed.signature,
            signed.lastValidBlockHeight.toString(),
            now,
            hot,
            hot ? context.slot.toString() : null,
        ],
    );
    return { kind: "send", signed, resigned };
}

// tx_signature names the transfer that moved the money, the attempts that did not land are kept
async function confirm(c: pg.PoolClient, r: RefundRow, landed: string, now: Date): Promise<Step> {
    await c.query(
        `update refunds set state = 'confirmed', confirmed_at = $2, tx_signature = $3,
            previous_signatures = case when tx_signature = $3 then previous_signatures
                else array_append(array_remove(previous_signatures, $3), tx_signature) end
         where id = $1`,
        [r.id, now, landed],
    );
    if (r.kind !== "allowance") {
        const order = await lockOrder(c, r.orderId);
        if (order?.state === "refunding") {
            await setOrderState(c, r.orderId, "refunding", "refunded");
        }
    }
    return { kind: "confirmed", signature: landed };
}

async function toManual(c: pg.PoolClient, r: RefundRow, reason: ManualReason): Promise<Step> {
    await c.query("update refunds set state = 'manual', manual_reason = $2 where id = $1", [
        r.id,
        reason,
    ]);
    if (r.kind !== "allowance") {
        const order = await lockOrder(c, r.orderId);
        if (order?.state === "refunding") {
            await setOrderState(c, r.orderId, "refunding", "manual", { manualReason: reason });
        }
    }
    return { kind: "manual", reason };
}

// Runs after the refund's COMMIT, so nothing here holds its row lock
async function finish(
    d: RefundDeps,
    r: RefundRow,
    step: Step,
    now: Date,
    tick: RefundTick,
): Promise<void> {
    const ids = { refundId: r.id, orderId: r.orderId };
    switch (step.kind) {
        case "send":
            await send(d, r, step.signed.wire, step.signed.signature, FRESH_SEND, now);
            if (step.resigned) tick.resigned++;
            else tick.sent++;
            d.log.info("refund sent", {
                ...ids,
                signature: step.signed.signature,
                resigned: step.resigned,
            });
            return;
        case "resend":
            await send(d, r, step.wire, step.signature, RESEND, now);
            tick.resent++;
            return;
        case "confirmed":
            tick.confirmed++;
            d.log.info("refund confirmed", { ...ids, signature: step.signature });
            return;
        case "manual":
            tick.manual++;
            if (step.reason === "x402_refund_budget") {
                d.log.alarm("x402_refund_budget", { ...ids, amountMicros: r.amountMicros });
            } else {
                d.log.alarm("manual_queue", { ...ids, reason: step.reason });
            }
            return;
        case "float_low":
            d.log.alarm("refund_float_low", {
                ...ids,
                balanceMicros: step.balanceMicros,
                unconfirmedMicros: step.unconfirmedMicros,
                amountMicros: r.amountMicros,
            });
            await pauseRefunds(d.pool, "float_low", d.log);
            tick.paused = "float_low";
            return;
        case "pause":
            await pauseRefunds(d.pool, step.reason, d.log);
            tick.paused = step.reason;
            return;
        case "held":
            tick.paused = step.paused;
            return;
        case "wait":
            return;
    }
}

async function send(
    d: RefundDeps,
    r: RefundRow,
    wire: string,
    sig: string,
    config: typeof FRESH_SEND | typeof RESEND,
    now: Date,
): Promise<void> {
    const answered = await viaRpc(() =>
        d.rpc
            .sendTransaction(wire as Base64EncodedWireTransaction, config)
            .send(deadline(d.rpcTimeoutMs)),
    );
    if (answered !== sig) {
        d.log.warn("rpc answered another signature", {
            refundId: r.id,
            orderId: r.orderId,
            signature: sig,
            answered,
        });
    }
    await d.pool.query(
        `update refunds set state = 'sent', sent_at = coalesce(sent_at, $3)
         where id = $1 and tx_signature = $2 and state in ('signed', 'sent')`,
        [r.id, sig, now],
    );
}
