/**
 * Refund executor and its pause controls.
 *
 * Each tick takes up to five refunds, oldest first, each under its own row lock and transaction.
 * A pending refund passes the amount, destination, daily cap, hourly rate and float checks, then
 * is signed and stored as `signed` before the send, so a crash never loses a transaction that may
 * land. A signed or sent refund is checked by signature status once it is 20 s old. It is then
 * confirmed, sent to the manual queue when it failed, signed again when its blockhash expired and
 * the signature is not found (up to max_attempts), or else resent unchanged. An RPC error leaves
 * the refund as it was for the next tick.
 */
import {
    address,
    type Address,
    appendTransactionMessageInstructions,
    type Base64EncodedWireTransaction,
    blockhash,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    isAddress,
    type KeyPairSigner,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signature,
    signTransactionMessageWithSigners,
} from "@solana/kit";
import {
    getSetComputeUnitLimitInstruction,
    getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getTransferCheckedInstruction } from "@solana-program/token";
import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import { findPaymentByOrder, lockOrder, setOrderState } from "../orders/store.ts";
import { inspectTokenAccount, usdcAta } from "../solana/accounts.ts";
import type { BlockhashHint } from "../solana/blockhash.ts";
import { TOKEN_PROGRAM, USDC_DECIMALS, USDC_MINT } from "../solana/constants.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { type RefundDbRow, type RefundRow, toRefund } from "./request.ts";

export interface RefundDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    feePayer: KeyPairSigner;
    refundSigner: KeyPairSigner;
    cfg: Settings["refunds"];
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

interface SignedRefund {
    wire: string;
    signature: string;
    lastValidBlockHeight: bigint;
}

type ManualReason =
    | "refund_exceeds_payment"
    | "refund_destination_invalid"
    | "refund_failed_onchain"
    | "refund_expired_repeatedly";

type Step =
    | { kind: "send"; signed: SignedRefund; resigned: boolean }
    | { kind: "resend"; wire: string; signature: string }
    | { kind: "confirmed" }
    | { kind: "manual"; reason: ManualReason }
    | { kind: "pause"; reason: "daily_cap" | "hourly_rate" }
    | { kind: "float_low"; balanceMicros: bigint }
    | { kind: "wait" };

type InFlight = RefundRow & { txSignature: string; wireTx: string; lastValidBlockHeight: bigint };

const PER_TICK = 5;
const FRESH_SEND = { encoding: "base64", preflightCommitment: "confirmed" } as const;
const RESEND = { encoding: "base64", skipPreflight: true, maxRetries: 0n } as const;

export async function buildRefundTransaction(
    d: Pick<RefundDeps, "feePayer" | "refundSigner" | "cfg">,
    r: { destination: Address; amountMicros: number },
    hint: BlockhashHint,
): Promise<SignedRefund> {
    const transfer = getTransferCheckedInstruction({
        source: await usdcAta(d.refundSigner.address),
        mint: USDC_MINT,
        destination: r.destination,
        authority: d.refundSigner,
        amount: BigInt(r.amountMicros),
        decimals: USDC_DECIMALS,
    });
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(d.feePayer, m),
        (m) =>
            setTransactionMessageLifetimeUsingBlockhash(
                {
                    blockhash: blockhash(hint.blockhash),
                    lastValidBlockHeight: hint.lastValidBlockHeight,
                },
                m,
            ),
        (m) =>
            appendTransactionMessageInstructions(
                [
                    getSetComputeUnitLimitInstruction({ units: d.cfg.compute_unit_limit }),
                    getSetComputeUnitPriceInstruction({
                        microLamports: d.cfg.compute_unit_price_micro_lamports,
                    }),
                    transfer,
                ],
                m,
            ),
    );
    const signed = await signTransactionMessageWithSigners(message);
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

export async function refundsPaused(pool: pg.Pool): Promise<string | null> {
    const res = await pool.query<{ paused: boolean; reason: string | null }>(
        "select paused, reason from refund_controls where id = 1",
    );
    const row = res.rows[0];
    return row?.paused ? (row.reason ?? "paused") : null;
}

export async function runRefunds(d: RefundDeps): Promise<RefundTick> {
    const tick: RefundTick = {
        sent: 0,
        resent: 0,
        resigned: 0,
        confirmed: 0,
        manual: 0,
        paused: await refundsPaused(d.pool),
    };
    const taken: number[] = [];
    for (let i = 0; i < PER_TICK && tick.paused === null; i++) {
        const now = d.now();
        const current: { refund?: RefundRow } = {};
        try {
            const step = await withTx(d.pool, async (c) => {
                const r = await takeRefund(c, taken, now);
                if (r === null) return null;
                taken.push(r.id);
                current.refund = r;
                return r.state === "pending"
                    ? checkPending(d, c, r, now)
                    : checkInFlight(d, c, r, now);
            });
            if (step === null || current.refund === undefined) break;
            await finish(d, current.refund, step, now, tick);
        } catch (err) {
            d.log.warn("refund step failed, retrying next tick", {
                refundId: current.refund?.id,
                orderId: current.refund?.orderId,
                err,
            });
        }
    }
    return tick;
}

// The row lock ends at COMMIT, so the 20 s age keeps a second runner off a refund just signed
async function takeRefund(
    c: pg.PoolClient,
    taken: readonly number[],
    now: Date,
): Promise<RefundRow | null> {
    const res = await c.query<RefundDbRow>(
        `select * from refunds
         where id <> all($1::bigint[])
           and (state = 'pending'
                or (state in ('signed', 'sent')
                    and coalesce(sent_at, signed_at) <= $2::timestamptz - interval '20 seconds'))
         order by created_at, id
         limit 1
         for update skip locked`,
        [taken, now],
    );
    return res.rows[0] ? toRefund(res.rows[0]) : null;
}

async function checkPending(
    d: RefundDeps,
    c: pg.PoolClient,
    r: RefundRow,
    now: Date,
): Promise<Step> {
    const payment = await findPaymentByOrder(c, r.orderId);
    if (payment === null || r.amountMicros > payment.amountMicros) {
        return toManual(c, r, "refund_exceeds_payment");
    }
    if (!(await destinationValid(d.rpc, r))) return toManual(c, r, "refund_destination_invalid");
    if ((await signedToday(c, now)) + r.amountMicros > d.cfg.daily_cap_micros) {
        return { kind: "pause", reason: "daily_cap" };
    }
    if ((await signedLastHour(c, now)) >= d.cfg.max_per_hour) {
        return { kind: "pause", reason: "hourly_rate" };
    }
    const { value } = await d.rpc
        .getTokenAccountBalance(await usdcAta(d.refundSigner.address), { commitment: "confirmed" })
        .send();
    const balanceMicros = BigInt(value.amount);
    if (balanceMicros < BigInt(r.amountMicros)) return { kind: "float_low", balanceMicros };
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
    const {
        value: [status],
    } = await d.rpc
        .getSignatureStatuses([signature(r.txSignature)], { searchTransactionHistory: true })
        .send();
    if (status) {
        // A processed-only result can still be dropped with its fork, so it decides nothing
        if (
            status.confirmationStatus !== "confirmed" &&
            status.confirmationStatus !== "finalized"
        ) {
            return { kind: "wait" };
        }
        if (status.err !== null) return toManual(c, r, "refund_failed_onchain");
        await c.query("update refunds set state = 'confirmed', confirmed_at = $2 where id = $1", [
            r.id,
            now,
        ]);
        const order = await lockOrder(c, r.orderId);
        if (order?.state === "refunding") {
            await setOrderState(c, r.orderId, "refunding", "refunded");
        }
        return { kind: "confirmed" };
    }
    const height = await d.rpc.getBlockHeight({ commitment: "finalized" }).send();
    if (height <= r.lastValidBlockHeight) {
        return { kind: "resend", wire: r.wireTx, signature: r.txSignature };
    }
    if (r.attempts >= d.cfg.max_attempts) return toManual(c, r, "refund_expired_repeatedly");
    return sign(d, c, r, now, true);
}

function isInFlight(r: RefundRow): r is InFlight {
    return r.txSignature !== null && r.wireTx !== null && r.lastValidBlockHeight !== null;
}

// Only a successful answer showing the account missing or wrong counts, an RPC throw propagates
async function destinationValid(rpc: SolanaRpc, r: RefundRow): Promise<boolean> {
    if (!isAddress(r.destination)) return false;
    const account = await inspectTokenAccount(rpc, r.destination);
    return (
        account !== null &&
        account.programOwner === TOKEN_PROGRAM &&
        account.mint === USDC_MINT &&
        account.state === "initialized" &&
        account.owner === r.payer
    );
}

async function signedToday(c: pg.PoolClient, now: Date): Promise<number> {
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const res = await c.query<{ total: string }>(
        `select coalesce(sum(amount_micros), 0)::text as total from refunds
         where state in ('signed', 'sent', 'confirmed') and signed_at >= $1`,
        [midnight],
    );
    return Number(res.rows[0]?.total ?? 0);
}

// A pending row may keep the signed_at of an attempt an operator retried, so it is not counted
async function signedLastHour(c: pg.PoolClient, now: Date): Promise<number> {
    const res = await c.query<{ n: number }>(
        `select count(*)::int as n from refunds
         where state <> 'pending' and signed_at > $1::timestamptz - interval '1 hour'`,
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
    const { value } = await d.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const signed = await buildRefundTransaction(
        d,
        { destination: address(r.destination), amountMicros: r.amountMicros },
        value,
    );
    await c.query(
        `update refunds set state = 'signed', wire_tx = $2, tx_signature = $3,
            last_valid_block_height = $4, signed_at = $5, sent_at = null, attempts = attempts + 1,
            previous_signatures = case when tx_signature is null then previous_signatures
                else array_append(previous_signatures, tx_signature) end
         where id = $1`,
        [r.id, signed.wire, signed.signature, signed.lastValidBlockHeight.toString(), now],
    );
    return { kind: "send", signed, resigned };
}

async function toManual(c: pg.PoolClient, r: RefundRow, reason: ManualReason): Promise<Step> {
    await c.query("update refunds set state = 'manual', manual_reason = $2 where id = $1", [
        r.id,
        reason,
    ]);
    const order = await lockOrder(c, r.orderId);
    if (order?.state === "refunding") {
        await setOrderState(c, r.orderId, "refunding", "manual", { manualReason: reason });
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
            await send(d, r.id, step.signed.wire, step.signed.signature, FRESH_SEND, now);
            if (step.resigned) tick.resigned++;
            else tick.sent++;
            d.log.info("refund sent", {
                ...ids,
                signature: step.signed.signature,
                resigned: step.resigned,
            });
            return;
        case "resend":
            await send(d, r.id, step.wire, step.signature, RESEND, now);
            tick.resent++;
            return;
        case "confirmed":
            tick.confirmed++;
            d.log.info("refund confirmed", { ...ids, signature: r.txSignature });
            return;
        case "manual":
            tick.manual++;
            d.log.alarm("manual_queue", { ...ids, reason: step.reason });
            return;
        case "float_low":
            d.log.alarm("refund_float_low", {
                ...ids,
                balanceMicros: step.balanceMicros,
                amountMicros: r.amountMicros,
            });
            await pauseRefunds(d.pool, "float_low", d.log);
            tick.paused = "float_low";
            return;
        case "pause":
            await pauseRefunds(d.pool, step.reason, d.log);
            tick.paused = step.reason;
            return;
        case "wait":
            return;
    }
}

async function send(
    d: RefundDeps,
    id: number,
    wire: string,
    sig: string,
    config: typeof FRESH_SEND | typeof RESEND,
    now: Date,
): Promise<void> {
    await d.rpc.sendTransaction(wire as Base64EncodedWireTransaction, config).send();
    await d.pool.query(
        `update refunds set state = 'sent', sent_at = coalesce(sent_at, $3)
         where id = $1 and tx_signature = $2 and state in ('signed', 'sent')`,
        [id, sig, now],
    );
}
