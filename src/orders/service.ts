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
import type { SettleResponse } from "@x402/core/types";
import type pg from "pg";
import { z } from "zod";
import type { Settings } from "../config.ts";
import { withTx, type Queryable } from "../db/pool.ts";
import { isRecord } from "../is-record.ts";
import type { Log } from "../log.ts";
import { findOrderRefund } from "../refunds/request.ts";
import type { BlockhashCache } from "../solana/blockhash.ts";
import { SOLANA_MAINNET } from "../solana/constants.ts";
import { type ChallengeContext, challengeFor, payUrlFor } from "../x402/challenge.ts";
import { planOrder, sameSetupTerms, type ValidCreate, type X402OrderDeps } from "../x402/create.ts";
import { findAccountByHandle, isFirstUse, reserveUnpaid } from "../x402/ledger.ts";
import { SERVICE_ID } from "../x402/ids.ts";
import { accountView } from "../x402/view.ts";
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
import { claimsFor, paymentProof, signOrderToken, type PaymentProof } from "./token.ts";
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
    x402: X402OrderDeps;
    log: Log;
    now: () => Date;
}

type Refused = Extract<OrderResult, { status: "refused" }>;
type Paid = Extract<OrderResult, { status: "paid"; kind: "start" | "extend" }>;
type AllowancePaid = Extract<OrderResult, { status: "paid"; kind: "allowance" }>;
type PaymentRequiredResult = Extract<OrderResult, { status: "payment_required" }>;

interface Found {
    order: OrderRow;
    idempotencyHit: boolean;
}

const CONTROL_CHARS = /\p{Cc}/u;
export const MAX_PINS = 64;
const ALLOWANCE_PACKAGE_ID = "x402-allowance";
const REQUIRED_CREATE_FIELDS = ["kind", "packageId", "amountMicros", "description"] as const;

export function shortText(max: number) {
    return z
        .string()
        .min(1)
        .max(max)
        .refine((s) => !CONTROL_CHARS.test(s));
}

function urlMatchesHost(pin: { url: string; host: string }): boolean {
    try {
        const u = new URL(pin.url);
        return (
            (u.protocol === "https:" || u.protocol === "http:") && u.host.toLowerCase() === pin.host
        );
    } catch {
        return false;
    }
}

export const x402PinSchema = z
    .strictObject({
        serviceId: z.string().regex(SERVICE_ID),
        method: z.enum(["GET", "POST"]),
        host: z.string().min(1).max(253),
        prefix: z.string().startsWith("/"),
        url: z.string().max(2_048),
        maxPriceMicros: z.int().min(1),
        payTo: z.string().max(64),
        listed: z.enum(["indexed", "unlisted"]),
        pinnedFrom: z.enum(["probe", "index"]),
        probe: z.strictObject({ at: z.string(), status: z.int(), accepted: z.json() }),
    })
    .refine(urlMatchesHost);

const x402Schema = z.strictObject({
    services: z.array(x402PinSchema).max(MAX_PINS).optional(),
    disable: z.array(z.string().regex(SERVICE_ID)).max(MAX_PINS).optional(),
    spendPerMinuteMicros: z.int().min(1).optional(),
});

const schemas = new Map<number, z.ZodType<OrderRequest>>();

function requestSchema(maxAmountMicros: number): z.ZodType<OrderRequest> {
    let schema = schemas.get(maxAmountMicros);
    if (schema !== undefined) return schema;
    schema = z
        .object({
            kind: z.enum(["start", "extend", "allowance"]).optional(),
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
            allowanceMicros: z.int().min(0).optional(),
            feeMicros: z.int().min(0).optional(),
            x402: x402Schema.optional(),
        })
        .refine((r) => isPaidRetry(r) || hasTerms(r))
        .refine(
            (r) => r.kind === undefined || (r.kind !== "start") === (r.handleSha256 !== undefined),
        )
        .refine(
            (r) =>
                r.kind !== "extend" ||
                (r.allowanceMicros === undefined && r.feeMicros === undefined),
        )
        .refine((r) => (r.feeMicros ?? 0) === 0 || (r.allowanceMicros ?? 0) > 0)
        .refine((r) => r.x402 === undefined || (r.allowanceMicros ?? 0) > 0)
        .refine(
            (r) =>
                r.x402?.services === undefined ||
                new Set(r.x402.services.map((p) => p.serviceId)).size === r.x402.services.length,
        )
        .refine(
            (r) =>
                r.kind !== "allowance" ||
                !hasTerms(r) ||
                (r.packageId === ALLOWANCE_PACKAGE_ID &&
                    (r.allowanceMicros ?? 0) >= 1 &&
                    r.amountMicros === r.allowanceMicros! + (r.feeMicros ?? 0)),
        )
        .refine(
            (r) =>
                r.kind !== "start" ||
                r.amountMicros === undefined ||
                (r.allowanceMicros ?? 0) + (r.feeMicros ?? 0) <= r.amountMicros,
        );
    schemas.set(maxAmountMicros, schema);
    return schema;
}

function isPaidRetry(r: OrderRequest): boolean {
    return (
        (r.orderId !== undefined && (r.claim !== undefined || r.payment !== undefined)) ||
        memoOf(r.payment) !== undefined
    );
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
            const created = await create(d, r as ValidCreate, key, signal);
            if ("status" in created) return created;
            found = created;
        } else {
            found = { order, idempotencyHit: true };
        }
    }
    return answerFound(d, r, found, key, signal);
}

class PoolFull extends Error {}

async function create(
    d: OrderServiceDeps,
    r: ValidCreate,
    key: string | null,
    signal: AbortSignal,
): Promise<OrderResult | Found> {
    const plan = (r.allowanceMicros ?? 0) > 0 ? await planOrder(d.pool, d.x402, r, signal) : null;
    if (plan !== null && !plan.ok) return plan.refused;
    const id = newOrderId();
    const claim = newClaim();
    const terms = {
        id,
        kind: r.kind,
        packageId: r.packageId,
        amountMicros: r.amountMicros,
        handleSha256: r.handleSha256 ?? null,
        description: plan?.description ?? r.description,
        claimSha256: claimHash(claim)!,
        claimBox: sealClaim(d.claimKey, id, claim),
        idempotencyKey: key,
        expiresAt: new Date(d.now().getTime() + (plan?.ttlMs ?? d.settings.orders.unpaid_ttl)),
        payInto: plan?.payInto ?? "cold",
        allowanceMicros: plan?.allowanceMicros ?? 0,
        feeMicros: plan?.feeMicros ?? 0,
        x402Setup: plan?.setup ?? null,
    } as const;
    let order: OrderRow;
    try {
        order =
            plan === null
                ? await insertOrder(d.pool, terms)
                : await withTx(d.pool, async (c) => {
                      const inserted = await insertOrder(c, terms);
                      if (!(await reserveUnpaid(c, plan.allowanceMicros, d.x402.x402, d.log))) {
                          throw new PoolFull();
                      }
                      return inserted;
                  });
    } catch (err) {
        if (err instanceof PoolFull) return refused("allowance_pool_full");
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
                return outcome.charged === false
                    ? {
                          ...refused(outcome.reason, order.id, outcome.retryAfterSeconds),
                          charged: false,
                      }
                    : refused(outcome.reason, order.id, outcome.retryAfterSeconds);
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
        (r.handleSha256 !== undefined && r.handleSha256 !== o.handleSha256) ||
        (r.allowanceMicros !== undefined && r.allowanceMicros !== o.allowanceMicros) ||
        (r.feeMicros !== undefined && r.feeMicros !== o.feeMicros) ||
        !sameSetupTerms(r.x402, o.x402Setup)
    );
}

function lapsed(o: OrderRow, now: Date): boolean {
    return now.getTime() >= o.expiresAt.getTime();
}

async function closedAnswer(db: Queryable, o: OrderRow): Promise<Refused> {
    if (o.x402Refusal !== null && ["refunding", "refunded", "manual"].includes(o.state)) {
        const row = await findOrderRefund(db, o.id);
        const done = row?.state === "confirmed" || row?.manualReason === "resolved_by_hand";
        return { ...refused(o.x402Refusal, o.id), refundPending: !done };
    }
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
            return closedAnswer(d.pool, o);
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
            return o.kind === "allowance"
                ? allowancePaid(d, d.pool, o)
                : redeem(d, o.id, retryStale);
        default:
            return closedAnswer(d.pool, o);
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
                    return closedAnswer(c, o);
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
    if (o.kind === "allowance") throw new Error("allowance orders carry no token");
    const payment = await findPaymentByOrder(db, o.id);
    const payer = o.payer ?? payment?.payer;
    if (payer === undefined) throw new Error(`paid order ${o.id} has no payer`);
    let proof: PaymentProof | undefined;
    if (d.settings.router.token_payer_claims) {
        proof = paymentProof(payment?.payer, d.challenge.feePayer, payment?.txSignature);
        if (proof === undefined) d.log.warn("order token payer claims dropped", { orderId: o.id });
    }
    const out: Paid = {
        status: "paid",
        orderId: o.id,
        orderToken: signOrderToken(
            d.orderKey,
            claimsFor(o, tokenExpiresAt, d.settings.router.allowance_claim, proof),
        ),
        payer,
        kind: o.kind,
        packageId: o.packageId,
        amountMicros: o.amountMicros,
    };
    if (o.handleSha256 !== null) out.handleSha256 = o.handleSha256;
    if (payment !== null) out.paymentResponse = settleResponse(payment);
    if (o.allowanceMicros > 0) {
        out.allowanceMicros = o.allowanceMicros;
        out.firstUse = await isFirstUse(db, payer, o.id);
        out.x402 = await accountView(db, o.id, d.x402.x402);
    }
    return out;
}

function settleResponse(payment: { txSignature: string; payer: string }): SettleResponse {
    return {
        success: true,
        transaction: payment.txSignature,
        network: SOLANA_MAINNET,
        payer: payment.payer,
    };
}

export async function allowancePaid(
    d: OrderServiceDeps,
    db: Queryable,
    o: OrderRow,
): Promise<AllowancePaid> {
    const payment = await findPaymentByOrder(db, o.id);
    const payer = o.payer ?? payment?.payer;
    if (payer === undefined || payment === null) {
        throw new Error(`paid order ${o.id} has no payer or payment`);
    }
    const account = o.handleSha256 === null ? null : await findAccountByHandle(db, o.handleSha256);
    if (account === null) throw new Error(`allowance order ${o.id} has no account`);
    return {
        status: "paid",
        orderId: o.id,
        kind: "allowance",
        handleSha256: o.handleSha256!,
        payer,
        amountMicros: o.amountMicros,
        allowanceMicros: o.allowanceMicros,
        firstUse: await isFirstUse(db, payer, o.id),
        x402: await accountView(db, account.id, d.x402.x402),
        paymentResponse: settleResponse(payment),
    };
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
): Promise<"recorded" | "ignored" | "unknown"> {
    if (!isOrderId(id)) return "unknown";
    const order = await findOrder(pool, id);
    if (order === null) return "unknown";
    if (order.kind === "allowance") return "ignored";
    const found = await updateOrderFields(pool, id, { abandonReason: reason, abandonAt: now });
    return found ? "recorded" : "unknown";
}
