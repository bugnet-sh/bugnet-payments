import { createHash, timingSafeEqual } from "node:crypto";
import { bindX402ExactCredential, InvalidProofError } from "@solana/pay-kit";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import type pg from "pg";
import { withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import type { Settings } from "../config.ts";
import type { RateLimiter } from "../ratelimit.ts";
import type { PayerCheck, RouterClient } from "../router/client.ts";
import { settleGate } from "../x402/create.ts";
import { type ChallengeContext, requirementsFor } from "../x402/challenge.ts";
import {
    type DecodedPayment,
    decodePayment,
    PaymentRefusal,
    type PayRefusal,
} from "../x402/decode.ts";
import { findAccountByHandle } from "../x402/ledger.ts";
import type { SettleAttempt, Settler } from "../x402/settler.ts";
import {
    confirmPayment,
    findOrder,
    findPaymentByOrder,
    insertPayment,
    lockOrder,
    lockPayment,
    paymentKeyHash,
    setOrderState,
    StaleStateError,
} from "./store.ts";
import { onOrderPaid, type PaidDeps } from "../x402/paid.ts";
import type { SignerHealth } from "../x402/types.ts";
import type { OrderRow } from "./types.ts";

export type PayOutcome =
    | { kind: "paid"; orderId: string; payer: string; signature: string }
    | { kind: "already_paid"; orderId: string; samePayment: false }
    | {
          kind: "already_paid";
          orderId: string;
          samePayment: true;
          // The settling request's idempotency key came back, which a settled transaction never shows
          sameKey: boolean;
          signature: string;
          payer: string;
      }
    | { kind: "settling"; orderId: string }
    | {
          kind: "refused";
          orderId: string;
          httpStatus: 400 | 403 | 404 | 409 | 410 | 422 | 429 | 503;
          reason: PayRefusal;
          code?: string;
          charged?: false;
          retryAfterSeconds?: number;
          blockedUntil?: string;
      };

export interface PayDeps {
    pool: pg.Pool;
    settler: Settler;
    router: RouterClient;
    attempts: RateLimiter;
    challenge: ChallengeContext;
    x402: { x402: Settings["x402"]; signer: SignerHealth; paid: PaidDeps };
    log: Log;
    now: () => Date;
}

const UNAVAILABLE_RETRY = { charged: false, retryAfterSeconds: 30 } as const;

// The settler signs as fee payer for exactly the terms the challenge advertises
export function createPayDeps(d: PayDeps): PayDeps {
    if (d.settler.feePayer !== d.challenge.feePayer) {
        throw new Error(
            `settler fee payer ${d.settler.feePayer} differs from the challenge's ${d.challenge.feePayer}`,
        );
    }
    const ours = d.settler.transactionVersions.join(",");
    const theirs = d.challenge.transactionVersions.join(",");
    if (ours !== theirs) {
        throw new Error(
            `settler transaction versions [${ours}] differ from the challenge's [${theirs}]`,
        );
    }
    return d;
}

type Refused = Extract<PayOutcome, { kind: "refused" }>;

interface Checked {
    dec: DecodedPayment;
    req: PaymentRequirements;
}

class Tx {
    private open = false;
    private broken = false;
    private released = false;

    constructor(private readonly c: pg.PoolClient) {}

    async begin(): Promise<void> {
        await this.c.query("begin");
        this.open = true;
    }

    async commit(): Promise<void> {
        this.open = false;
        try {
            await this.c.query("commit");
        } catch (err) {
            this.broken = true;
            throw err;
        }
    }

    async rollback(): Promise<void> {
        if (!this.open) return;
        this.open = false;
        try {
            await this.c.query("rollback");
        } catch {
            this.broken = true;
        }
    }

    release(): void {
        if (this.released) return;
        this.released = true;
        this.c.release(this.broken);
    }
}

function refused(
    orderId: string,
    httpStatus: Refused["httpStatus"],
    reason: PayRefusal,
    more: Pick<Refused, "code" | "charged" | "retryAfterSeconds" | "blockedUntil"> = {},
): Refused {
    const out: Refused = { kind: "refused", orderId, httpStatus, reason };
    if (more.code !== undefined) out.code = more.code;
    if (more.charged !== undefined) out.charged = more.charged;
    if (more.retryAfterSeconds !== undefined) out.retryAfterSeconds = more.retryAfterSeconds;
    if (more.blockedUntil !== undefined) out.blockedUntil = more.blockedUntil;
    return out;
}

function settling(orderId: string): PayOutcome {
    return { kind: "settling", orderId };
}

function keyHash(key: string | null): Buffer | null {
    return key === null ? null : createHash("sha256").update(key, "utf8").digest();
}

/**
 * `key` is the paying request's idempotency key. It is stored with the payment, so a retry of
 * that request can be told from a stranger replaying the transaction once it is public on chain.
 */
export async function payOrder(
    d: PayDeps,
    orderId: string,
    raw: unknown,
    signal: AbortSignal,
    key: string | null = null,
): Promise<PayOutcome> {
    const c = await d.pool.connect();
    const tx = new Tx(c);
    try {
        await tx.begin();
        const order = await lockOrder(c, orderId);
        if (order === null) return refused(orderId, 404, "order_unknown");
        const t = d.now();
        const answer = await answerForState(d, c, order, raw, key, t);
        if (answer !== undefined) return answer;
        if (order.payInto === "allowance") {
            const gate = await settleGate(c, d.x402);
            if (gate === "x402_disabled") return refused(order.id, 403, gate, { charged: false });
            if (gate !== null) {
                return refused(order.id, 503, gate, UNAVAILABLE_RETRY);
            }
        }
        const checked = await checkPayment(d, c, order, raw, signal);
        if ("kind" in checked) return checked;
        return await settle(d, c, tx, order, checked, key, t);
    } finally {
        await tx.rollback();
        tx.release();
    }
}

async function answerForState(
    d: PayDeps,
    c: pg.PoolClient,
    order: OrderRow,
    raw: unknown,
    key: string | null,
    t: Date,
): Promise<PayOutcome | undefined> {
    switch (order.state) {
        case "paid":
        case "redeemed":
            return alreadyPaid(d, c, order.id, raw, key);
        case "settling":
            return settling(order.id);
        case "expired":
            return refused(order.id, 410, "order_expired");
        case "refunding":
        case "refunded":
        case "manual":
            return order.x402Refusal === null
                ? refused(order.id, 410, "order_closed")
                : refused(order.id, 410, "order_closed", { code: order.x402Refusal });
        case "unpaid":
            if (t.getTime() >= order.expiresAt.getTime()) {
                return refused(order.id, 410, "order_expired");
            }
            return undefined;
    }
}

async function alreadyPaid(
    d: PayDeps,
    c: pg.PoolClient,
    orderId: string,
    raw: unknown,
    key: string | null,
): Promise<PayOutcome> {
    const payment = await findPaymentByOrder(c, orderId);
    let hash: string | undefined;
    try {
        hash = decodePayment(raw, d.challenge).messageHash;
    } catch (err) {
        if (!(err instanceof PaymentRefusal)) throw err;
    }
    if (payment === null || hash !== payment.messageHash) {
        return { kind: "already_paid", orderId, samePayment: false };
    }
    const stored = await paymentKeyHash(c, orderId);
    const given = keyHash(key);
    return {
        kind: "already_paid",
        orderId,
        samePayment: true,
        sameKey: stored !== null && given !== null && timingSafeEqual(stored, given),
        signature: payment.txSignature,
        payer: payment.payer,
    };
}

async function checkPayment(
    d: PayDeps,
    c: pg.PoolClient,
    order: OrderRow,
    raw: unknown,
    signal: AbortSignal,
): Promise<Checked | Refused> {
    let dec: DecodedPayment;
    try {
        dec = decodePayment(raw, d.challenge);
    } catch (err) {
        if (!(err instanceof PaymentRefusal)) throw err;
        const status = err.reason === "payment_malformed" ? 400 : 422;
        return refused(order.id, status, err.reason, { code: err.code });
    }
    if (dec.memoOrderId !== order.id) return refused(order.id, 422, "payment_order_mismatch");
    // Counted only once the payment names this order, so junk never uses up the payer's attempts
    const taken = d.attempts.take(`order:${order.id}:${dec.payer}`);
    if (!taken.ok) {
        return refused(order.id, 429, "too_many_attempts", {
            retryAfterSeconds: taken.retryAfterSeconds,
        });
    }
    const req = requirementsFor(order, d.challenge);
    try {
        bindX402ExactCredential(dec.payload, req);
    } catch (err) {
        if (!(err instanceof InvalidProofError)) throw err;
        return refused(order.id, 422, "payment_invalid", { code: err.code });
    }
    let packageId = order.packageId;
    let kind = order.kind;
    if (order.kind === "allowance") {
        const account = await findAccountByHandle(c, order.handleSha256 ?? "");
        if (account === null) {
            d.log.error("allowance order has no account", { orderId: order.id });
            return refused(order.id, 503, "x402_unavailable", UNAVAILABLE_RETRY);
        }
        packageId = account.packageId;
        kind = "extend";
    }
    const check = await d.router.checkPayer(
        { payer: dec.payer, feePayer: d.challenge.feePayer, packageId, kind },
        signal,
    );
    return payerRefusal(order.id, check) ?? { dec, req };
}

function payerRefusal(orderId: string, check: PayerCheck): Refused | undefined {
    switch (check.verdict) {
        case "ok":
        case "skipped":
            return undefined;
        case "blocked":
            return refused(orderId, 403, "payer_blocked", { blockedUntil: check.blockedUntil });
        case "busy":
            return refused(orderId, 429, "payer_busy", {
                retryAfterSeconds: check.retryAfterSeconds,
            });
        case "rate_limited":
            return refused(orderId, 429, "payer_rate_limited", {
                retryAfterSeconds: check.retryAfterSeconds,
            });
        case "invalid":
            return refused(orderId, 422, "payer_invalid");
        case "unavailable":
            return refused(orderId, 503, "router_unavailable");
    }
}

async function settle(
    d: PayDeps,
    c: pg.PoolClient,
    tx: Tx,
    order: OrderRow,
    { dec, req }: Checked,
    key: string | null,
    t: Date,
): Promise<PayOutcome> {
    const attempt: SettleAttempt = {
        messageHash: dec.messageHash,
        committed: false,
        // The settling row must be durable before the settler broadcasts
        async commit(r) {
            if (attempt.committed) throw new Error("attempt already committed");
            await insertPayment(c, {
                orderId: order.id,
                txSignature: r.signature,
                messageHash: r.messageHash,
                payer: dec.payer,
                sourceTokenAccount: dec.sourceTokenAccount,
                amountMicros: order.amountMicros,
                blockhash: r.blockhash,
                lastValidBlockHeight: r.lastValidBlockHeight,
                createdAt: t,
                keySha256: keyHash(key),
            });
            await setOrderState(c, order.id, "unpaid", "settling", { payer: dec.payer });
            await tx.commit();
            // The confirmation wait can take 30 s and must not hold a pool client
            tx.release();
        },
    };
    let res: SettleResponse;
    try {
        res = await d.settler.settle(attempt, dec.payload, req);
    } catch (err) {
        d.log.error("settle threw", { orderId: order.id, committed: attempt.committed, err });
        if (attempt.committed) return settling(order.id);
        return attempt.failure === "rpc_unavailable"
            ? refused(order.id, 503, "rpc_unavailable")
            : refused(order.id, 503, "settlement_unavailable");
    }
    if (res.success) return markPaid(d, order.id, dec.payer, res.transaction, t);
    if (attempt.committed) return settling(order.id);
    switch (attempt.failure) {
        case "commit_conflict":
            return refused(order.id, 409, "payment_replayed");
        case "block_height_unavailable":
        case "rpc_unavailable":
            return refused(order.id, 503, "rpc_unavailable");
        case "commit_failed":
            return refused(order.id, 503, "settlement_unavailable");
    }
    if (res.errorReason === "duplicate_settlement") {
        return refused(order.id, 409, "payment_replayed");
    }
    return refused(order.id, 422, "payment_invalid", { code: res.errorReason });
}

async function markPaid(
    d: PayDeps,
    orderId: string,
    payer: string,
    signature: string,
    paidAt: Date,
): Promise<PayOutcome> {
    const paid: PayOutcome = { kind: "paid", orderId, payer, signature };
    let confirmed: boolean;
    try {
        confirmed = await withTx(d.pool, async (c) => {
            // Payment row before order row, the order the reconciler locks them in
            const payment = await lockPayment(c, orderId);
            const order = await lockOrder(c, orderId);
            if (!(await confirmPayment(c, orderId, d.now()))) return false;
            await setOrderState(c, orderId, "settling", "paid", { paidAt });
            if (order?.payInto === "allowance" && payment !== null) {
                await onOrderPaid(
                    c,
                    d.x402.paid,
                    { ...order, state: "paid", paidAt },
                    { ...payment, status: "confirmed" },
                    d.now(),
                );
            }
            return true;
        });
    } catch (err) {
        if (!(err instanceof StaleStateError)) {
            d.log.error("marking the order paid failed", { orderId, err });
            return settling(orderId);
        }
        return (await paidElsewhere(d, orderId, signature)) ? paid : settling(orderId);
    }
    if (confirmed || (await paidElsewhere(d, orderId, signature))) return paid;
    d.log.error("payment was not settling at confirmation", { orderId, signature });
    return settling(orderId);
}

async function paidElsewhere(d: PayDeps, orderId: string, signature: string): Promise<boolean> {
    try {
        const order = await findOrder(d.pool, orderId);
        const payment = await findPaymentByOrder(d.pool, orderId);
        return (
            (order?.state === "paid" || order?.state === "redeemed") &&
            payment?.txSignature === signature
        );
    } catch (err) {
        d.log.error("re-reading the order failed", { orderId, err });
        return false;
    }
}
