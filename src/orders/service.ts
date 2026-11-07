/**
 * The internal order API: create, idempotent replay, x402 payment from MCP _meta, and redeem.
 *
 * A request is validated, matched to an order (by orderId, then the payment's memo, then the
 * idempotency key) or creates one. A caller is authorized by the order's claim, by the payment it
 * just settled, or by presenting that payment again with the idempotency key that settled it. A
 * settled transaction is public on chain, so it never authorizes on its own. Only an authorized
 * caller gets an order token, and a redeem decides
 * under the row lock so it never races the refund sweeper. Every answer comes from the stored
 * order, never from the request's terms.
 */
import type { KeyObject } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { Settings } from "../config.ts";
import { withTx, type Queryable } from "../db/pool.ts";
import { isRecord } from "../is-record.ts";
import type { Log } from "../log.ts";
import type { BlockhashCache } from "../solana/blockhash.ts";
import { SOLANA_MAINNET } from "../solana/constants.ts";
import { type ChallengeContext, challengeFor, payUrlFor } from "../x402/challenge.ts";
import { claimHash, claimMatches, newClaim, openClaim, sealClaim } from "./claim.ts";
import { isOrderId, newOrderId } from "./ids.ts";
import type { PayOutcome } from "./pay.ts";
import {
    findOrder,
    findOrderByIdempotencyKey,
    findPaymentByOrder,
    insertOrder,
    lockOrder,
    setOrderState,
    StaleStateError,
    updateOrderFields,
} from "./store.ts";
import { claimsFor, signOrderToken } from "./token.ts";
import type { OrderRequest, OrderResult, OrderRow, RefusalReason } from "./types.ts";

export interface OrderServiceDeps {
    pool: pg.Pool;
    settings: Settings;
    challenge: ChallengeContext;
    hints: BlockhashCache;
    orderKey: KeyObject;
    claimKey: Buffer;
    pay: (
        orderId: string,
        raw: unknown,
        signal: AbortSignal,
        key: string | null,
    ) => Promise<PayOutcome>;
    log: Log;
    now: () => Date;
}

type Refused = Extract<OrderResult, { status: "refused" }>;
type Paid = Extract<OrderResult, { status: "paid" }>;
type PaymentRequiredResult = Extract<OrderResult, { status: "payment_required" }>;

interface Found {
    order: OrderRow;
    idempotencyHit: boolean;
}

const CONTROL_CHARS = /\p{Cc}/u;
const REQUIRED_CREATE_FIELDS = ["kind", "packageId", "amountMicros", "description"] as const;

export function shortText(max: number) {
    return z
        .string()
        .min(1)
        .max(max)
        .refine((s) => !CONTROL_CHARS.test(s));
}

const schemas = new Map<number, z.ZodType<OrderRequest>>();

function requestSchema(maxAmountMicros: number): z.ZodType<OrderRequest> {
    let schema = schemas.get(maxAmountMicros);
    if (schema !== undefined) return schema;
    schema = z
        .object({
            kind: z.enum(["start", "extend"]).optional(),
            packageId: z
                .string()
                .regex(/^[A-Za-z0-9._-]{1,64}$/)
                .optional(),
            amountMicros: z.int().min(1).max(maxAmountMicros).optional(),
            description: shortText(200).optional(),
            handleSha256: z
                .string()
                .regex(/^[0-9a-f]{64}$/)
                .optional(),
            orderId: z.string().optional(),
            claim: z
                .string()
                .regex(/^[A-Za-z0-9_-]{43}$/)
                .optional(),
            payment: z.unknown().optional(),
            idempotencyKey: z.string().max(200).optional(),
        })
        .refine((r) => (r.orderId !== undefined && r.claim !== undefined) || hasTerms(r))
        .refine(
            (r) => r.kind === undefined || (r.kind === "extend") === (r.handleSha256 !== undefined),
        );
    schemas.set(maxAmountMicros, schema);
    return schema;
}

function hasTerms(r: OrderRequest): boolean {
    return REQUIRED_CREATE_FIELDS.every((t) => r[t] !== undefined);
}

function refused(reason: RefusalReason, orderId?: string, retryAfterSeconds?: number): Refused {
    const out: Refused = { status: "refused", reason };
    if (orderId !== undefined) out.orderId = orderId;
    if (retryAfterSeconds !== undefined) out.retryAfterSeconds = retryAfterSeconds;
    return out;
}

function memoOf(payment: unknown): string | undefined {
    if (!isRecord(payment) || !isRecord(payment.accepted)) return undefined;
    const extra = payment.accepted.extra;
    return isRecord(extra) && isOrderId(extra.memo) ? extra.memo : undefined;
}

function isKeyConflict(err: unknown): boolean {
    const e = err as { code?: unknown; constraint?: unknown } | null;
    return e?.code === "23505" && e.constraint === "orders_idempotency_key_key";
}

export async function handleOrderRequest(
    d: OrderServiceDeps,
    body: unknown,
    signal: AbortSignal,
): Promise<OrderResult> {
    const parsed = requestSchema(d.settings.orders.max_amount_micros).safeParse(body);
    if (!parsed.success) return refused("bad_request");
    const r = parsed.data;
    const key =
        r.idempotencyKey !== undefined &&
        r.idempotencyKey.length >= d.settings.orders.min_idempotency_key_length
            ? r.idempotencyKey
            : null;

    const memo = memoOf(r.payment);
    let found: Found;
    if (r.orderId !== undefined || memo !== undefined) {
        const id = r.orderId ?? memo!;
        if (!isOrderId(id)) return refused("order_unknown");
        const order = await findOrder(d.pool, id);
        if (order === null) return refused("order_unknown", id);
        found = { order, idempotencyHit: false };
    } else {
        const order = key === null ? null : await findOrderByIdempotencyKey(d.pool, key);
        if (order === null) {
            const created = await create(d, r, key);
            if ("status" in created) return created;
            found = created;
        } else {
            found = { order, idempotencyHit: true };
        }
    }
    return answerFound(d, r, found, key, signal);
}

async function create(
    d: OrderServiceDeps,
    r: OrderRequest,
    key: string | null,
): Promise<PaymentRequiredResult | Found> {
    const id = newOrderId();
    const claim = newClaim();
    let order: OrderRow;
    try {
        order = await insertOrder(d.pool, {
            id,
            kind: r.kind!,
            packageId: r.packageId!,
            amountMicros: r.amountMicros!,
            handleSha256: r.handleSha256 ?? null,
            description: r.description!,
            claimSha256: claimHash(claim)!,
            claimBox: sealClaim(d.claimKey, id, claim),
            idempotencyKey: key,
            expiresAt: new Date(d.now().getTime() + d.settings.orders.unpaid_ttl),
        });
    } catch (err) {
        if (key === null || !isKeyConflict(err)) throw err;
        const winner = await findOrderByIdempotencyKey(d.pool, key);
        if (winner === null) throw err;
        return { order: winner, idempotencyHit: true };
    }
    d.log.info("order created", { orderId: id, kind: order.kind, packageId: order.packageId });
    return paymentRequired(d, order, claim);
}

async function answerFound(
    d: OrderServiceDeps,
    r: OrderRequest,
    { order, idempotencyHit }: Found,
    key: string | null,
    signal: AbortSignal,
): Promise<OrderResult> {
    if (termsDiffer(r, order)) {
        return refused(idempotencyHit ? "idempotency_conflict" : "terms_mismatch", order.id);
    }
    let authorized = false;
    if (r.payment !== undefined) {
        const outcome = await d.pay(order.id, r.payment, signal, key);
        switch (outcome.kind) {
            case "refused":
                return refused(outcome.reason, order.id, outcome.retryAfterSeconds);
            case "settling":
                return refused("settling", order.id);
            case "paid":
                authorized = true;
                break;
            case "already_paid":
                authorized = outcome.samePayment && outcome.sameKey;
                break;
        }
    }
    if (r.claim !== undefined) {
        if (!claimMatches(r.claim, order.claimSha256)) return refused("claim_mismatch", order.id);
        authorized = true;
    }
    // A payment just moved the order on, so the stored row decides from here
    const current = r.payment === undefined ? order : await findOrder(d.pool, order.id);
    if (current === null) return refused("order_unknown", order.id);
    return authorized
        ? answerAuthorized(d, current, true)
        : answerUnauthorized(d, current, idempotencyHit);
}

function termsDiffer(r: OrderRequest, o: OrderRow): boolean {
    return (
        (r.kind !== undefined && r.kind !== o.kind) ||
        (r.packageId !== undefined && r.packageId !== o.packageId) ||
        (r.amountMicros !== undefined && r.amountMicros !== o.amountMicros) ||
        (r.handleSha256 !== undefined && r.handleSha256 !== o.handleSha256)
    );
}

function lapsed(o: OrderRow, now: Date): boolean {
    return now.getTime() >= o.expiresAt.getTime();
}

function closed(o: OrderRow): Refused {
    return refused(o.state === "expired" ? "order_expired" : "order_closed", o.id);
}

async function answerUnauthorized(
    d: OrderServiceDeps,
    o: OrderRow,
    idempotencyHit: boolean,
): Promise<OrderResult> {
    switch (o.state) {
        case "unpaid": {
            if (lapsed(o, d.now())) return refused("order_expired", o.id);
            const claim =
                idempotencyHit && o.claimBox !== null
                    ? openClaim(d.claimKey, o.id, o.claimBox)
                    : undefined;
            return paymentRequired(d, o, claim);
        }
        case "settling":
        case "paid":
        case "redeemed":
            return refused("paid_claim_required", o.id);
        default:
            return closed(o);
    }
}

async function answerAuthorized(
    d: OrderServiceDeps,
    o: OrderRow,
    retryStale: boolean,
): Promise<OrderResult> {
    switch (o.state) {
        case "unpaid":
            return lapsed(o, d.now()) ? refused("order_expired", o.id) : paymentRequired(d, o);
        case "settling":
            return refused("settling", o.id);
        case "paid":
        case "redeemed":
            return redeem(d, o.id, retryStale);
        default:
            return closed(o);
    }
}

async function redeem(d: OrderServiceDeps, id: string, retryStale: boolean): Promise<OrderResult> {
    let justRedeemed = false;
    try {
        const result = await withTx(d.pool, async (c) => {
            justRedeemed = false;
            const o = await lockOrder(c, id);
            if (o === null) return refused("order_unknown", id);
            const now = d.now();
            switch (o.state) {
                case "paid": {
                    // Unreachable, payOrder records paid_at only before the order expires
                    if (o.paidAt !== null && o.paidAt.getTime() > o.expiresAt.getTime()) {
                        d.log.error("impossible late payment", { orderId: id });
                        return refused("payment_late", id);
                    }
                    const tokenExpiresAt = new Date(now.getTime() + d.settings.orders.token_ttl);
                    await setOrderState(c, id, "paid", "redeemed", {
                        redeemedAt: now,
                        tokenExpiresAt,
                    });
                    justRedeemed = true;
                    return paid(d, c, o, tokenExpiresAt);
                }
                case "redeemed":
                    return o.tokenExpiresAt !== null && o.tokenExpiresAt.getTime() > now.getTime()
                        ? paid(d, c, o, o.tokenExpiresAt)
                        : refused("token_expired", id);
                default:
                    // Paid and redeemed orders only move on to refunding, refunded or manual
                    return closed(o);
            }
        });
        if (justRedeemed) d.log.info("order redeemed", { orderId: id });
        return result;
    } catch (err) {
        if (!(err instanceof StaleStateError) || !retryStale) throw err;
        const fresh = await findOrder(d.pool, id);
        return fresh === null ? refused("order_unknown", id) : answerAuthorized(d, fresh, false);
    }
}

async function paid(
    d: OrderServiceDeps,
    db: Queryable,
    o: OrderRow,
    tokenExpiresAt: Date,
): Promise<Paid> {
    const payment = await findPaymentByOrder(db, o.id);
    const payer = o.payer ?? payment?.payer;
    if (payer === undefined) throw new Error(`paid order ${o.id} has no payer`);
    const out: Paid = {
        status: "paid",
        orderId: o.id,
        orderToken: signOrderToken(d.orderKey, claimsFor(o, tokenExpiresAt)),
        payer,
        kind: o.kind,
        packageId: o.packageId,
        amountMicros: o.amountMicros,
    };
    if (o.handleSha256 !== null) out.handleSha256 = o.handleSha256;
    if (payment !== null) {
        out.paymentResponse = {
            success: true,
            transaction: payment.txSignature,
            network: SOLANA_MAINNET,
            payer: payment.payer,
        };
    }
    return out;
}

async function paymentRequired(
    d: OrderServiceDeps,
    o: OrderRow,
    claim?: string,
): Promise<PaymentRequiredResult> {
    const out: PaymentRequiredResult = {
        status: "payment_required",
        orderId: o.id,
        payUrl: payUrlFor(d.challenge.publicUrl, o.id),
        paymentRequired: await challengeFor(o, d.challenge, d.hints, d.log),
    };
    return claim === undefined ? out : { ...out, claim };
}

export async function abandonOrder(
    pool: pg.Pool,
    id: string,
    reason: string,
    now: Date,
): Promise<"recorded" | "unknown"> {
    if (!isOrderId(id)) return "unknown";
    const found = await updateOrderFields(pool, id, { abandonReason: reason, abandonAt: now });
    return found ? "recorded" : "unknown";
}
