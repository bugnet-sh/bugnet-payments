import type pg from "pg";
import { type Queryable, withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import { findPaymentByOrder, lockOrder, setOrderState } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import type { AllowanceFunding } from "../x402/funding.ts";
import { lockAccount } from "../x402/ledger.ts";
import { decideHotFullRefund, writeHotPartial } from "./hot.ts";

export type RefundKind = "full" | "partial" | "allowance" | "deposit";
export type RefundWallet = "refund" | "allowance";
export type RefundReason =
    | "unredeemed"
    | "late"
    | "router_refundable"
    | "abandoned"
    | "no_router_record"
    | "operator"
    | "x402_unspent"
    | "x402_ceiling"
    | "x402_closed"
    | "deposit_held";

export interface RefundRow {
    id: number;
    orderId: string;
    kind: RefundKind;
    reason: RefundReason;
    amountMicros: number;
    destination: string;
    payer: string;
    state: "pending" | "signed" | "sent" | "confirmed" | "manual";
    txSignature: string | null;
    wireTx: string | null;
    lastValidBlockHeight: bigint | null;
    previousSignatures: string[];
    attempts: number;
    manualReason: string | null;
    createdAt: Date;
    signedAt: Date | null;
    sentAt: Date | null;
    confirmedAt: Date | null;
    fromWallet: RefundWallet;
    landedSlot: bigint | null;
    expirySeenSlot: bigint | null;
    signingSlot: bigint | null;
    budgetWaived: boolean;
    handTx: string | null;
    part: number;
    depositSignature: string | null;
}

export interface RefundDbRow extends pg.QueryResultRow {
    id: string | number;
    order_id: string;
    kind: RefundRow["kind"];
    reason: RefundReason;
    amount_micros: string | number;
    destination: string;
    payer: string;
    state: RefundRow["state"];
    tx_signature: string | null;
    wire_tx: string | null;
    last_valid_block_height: string | number | bigint | null;
    previous_signatures: string[];
    attempts: number;
    manual_reason: string | null;
    created_at: Date;
    signed_at: Date | null;
    sent_at: Date | null;
    confirmed_at: Date | null;
    from_wallet: RefundWallet;
    landed_slot: string | number | bigint | null;
    expiry_seen_slot: string | number | bigint | null;
    signing_slot: string | number | bigint | null;
    budget_waived: boolean;
    hand_tx: string | null;
    part: number;
    deposit_signature: string | null;
}

const slot = (v: string | number | bigint | null): bigint | null => (v === null ? null : BigInt(v));

export function toRefund(r: RefundDbRow): RefundRow {
    return {
        id: Number(r.id),
        orderId: r.order_id,
        kind: r.kind,
        reason: r.reason,
        amountMicros: Number(r.amount_micros),
        destination: r.destination,
        payer: r.payer,
        state: r.state,
        txSignature: r.tx_signature,
        wireTx: r.wire_tx,
        lastValidBlockHeight:
            r.last_valid_block_height === null ? null : BigInt(r.last_valid_block_height),
        previousSignatures: r.previous_signatures,
        attempts: r.attempts,
        manualReason: r.manual_reason,
        createdAt: r.created_at,
        signedAt: r.signed_at,
        sentAt: r.sent_at,
        confirmedAt: r.confirmed_at,
        fromWallet: r.from_wallet,
        landedSlot: slot(r.landed_slot),
        expirySeenSlot: slot(r.expiry_seen_slot),
        signingSlot: slot(r.signing_slot),
        budgetWaived: r.budget_waived,
        handTx: r.hand_tx,
        part: r.part,
        depositSignature: r.deposit_signature,
    };
}

export async function findRefund(
    db: Queryable,
    orderId: string,
    kind: RefundKind,
): Promise<RefundRow | null> {
    const res = await db.query<RefundDbRow>(
        "select * from refunds where order_id = $1 and kind = $2",
        [orderId, kind],
    );
    return res.rows[0] ? toRefund(res.rows[0]) : null;
}

export async function findOrderRefund(db: Queryable, orderId: string): Promise<RefundRow | null> {
    const res = await db.query<RefundDbRow>(
        "select * from refunds where order_id = $1 and kind in ('full', 'partial') order by id limit 1",
        [orderId],
    );
    return res.rows[0] ? toRefund(res.rows[0]) : null;
}

export async function findRefundById(db: Queryable, id: number): Promise<RefundRow | null> {
    const res = await db.query<RefundDbRow>("select * from refunds where id = $1", [id]);
    return res.rows[0] ? toRefund(res.rows[0]) : null;
}

export type RefundRequest =
    | "created"
    | "exists"
    | "not_refundable"
    | "unknown"
    | "invalid_amount"
    | "parked"
    | "zero_share";

// The order lock makes the state check and the insert one step, so two triggers (an event and
// the sweeper) can never both create a refund, and a full and a partial refund never coexist.
// Without an amount the refund is full; with one it is partial and must not exceed the payment.
// A caller that chose the order before taking the lock passes `eligible` to re-check it under it.
// A hot order (paid into the allowance wallet) is refunded by the 7.2 table, which needs `funding`.
export async function requestRefund(
    pool: pg.Pool,
    orderId: string,
    reason: RefundReason,
    opts: {
        amountMicros?: number;
        eligible?: (order: OrderRow) => boolean;
        triggerDeadline?: Date | null;
        budgetWaived?: boolean;
        funding?: AllowanceFunding;
        at?: Date;
        log?: Log;
    } = {},
): Promise<RefundRequest> {
    const { amountMicros, eligible, triggerDeadline, funding, log } = opts;
    const budgetWaived = opts.budgetWaived ?? false;
    const at = opts.at ?? new Date();
    const first = await pool.query<{ pay_into: string }>(
        "select pay_into from orders where id = $1",
        [orderId],
    );
    const hot = first.rows[0]?.pay_into === "allowance";
    if (hot && amountMicros !== undefined) {
        return writeHotPartial(pool, orderId, amountMicros, at, { budgetWaived, log });
    }
    if (hot) {
        if (funding === undefined) throw new Error("hot order refund needs AllowanceFunding");
        if (log === undefined) throw new Error("hot order refund needs a Log");
    }
    const afterCommit: (() => void)[] = [];
    const result = await withTx(pool, async (c) => {
        const order = await lockOrder(c, orderId);
        if (order === null) return "unknown";
        if (eligible !== undefined && !eligible(order)) return "not_refundable";
        if (order.state === "refunding" || order.state === "refunded") return "exists";
        if (hot) {
            if ((await findOrderRefund(c, orderId)) !== null) return "exists";
            if (order.state !== "paid" && order.state !== "redeemed" && order.state !== "manual") {
                return "not_refundable";
            }
        } else if (order.state === "manual") {
            if ((await findOrderRefund(c, orderId)) !== null) return "exists";
        } else if (order.state !== "paid" && order.state !== "redeemed") {
            return "not_refundable";
        }
        const payment = await findPaymentByOrder(c, orderId);
        if (payment === null) return "not_refundable";
        if (hot) {
            const funded = await c.query<{ account_id: string }>(
                "select account_id from x402_fundings where order_id = $1",
                [orderId],
            );
            const account =
                funded.rows[0] === undefined
                    ? null
                    : await lockAccount(c, funded.rows[0].account_id);
            return decideHotFullRefund(
                c,
                order,
                account,
                reason,
                funding!,
                at,
                log!,
                triggerDeadline,
                budgetWaived,
                afterCommit,
            );
        }
        if (
            amountMicros !== undefined &&
            (!Number.isSafeInteger(amountMicros) ||
                amountMicros < 1 ||
                amountMicros > payment.amountMicros)
        ) {
            return "invalid_amount";
        }
        const inserted = await c.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                from_wallet, budget_waived, created_at)
             values ($1, $2, $3, $4, $5, $6, 'pending', 'refund', $7, $8)
             on conflict do nothing`,
            [
                orderId,
                amountMicros === undefined ? "full" : "partial",
                reason,
                amountMicros ?? payment.amountMicros,
                payment.sourceTokenAccount,
                payment.payer,
                budgetWaived,
                at,
            ],
        );
        if (inserted.rowCount !== 1) return "exists";
        await setOrderState(
            c,
            orderId,
            order.state,
            "refunding",
            order.state === "manual" ? { manualReason: null } : {},
        );
        return "created";
    });
    for (const f of afterCommit) f();
    return result;
}

// Shared by the router event handler and the operator's dismiss: a manual order with no refund
// row goes back to redeemed, and router_confirmed_at stops the sweeper parking it again.
export async function returnManualToRedeemed(
    pool: pg.Pool,
    orderId: string,
    at: Date,
    onlyReasons?: readonly string[],
): Promise<boolean> {
    return withTx(pool, async (c) => {
        const order = await lockOrder(c, orderId);
        if (order === null || order.state !== "manual") return false;
        if (
            onlyReasons !== undefined &&
            (order.manualReason === null || !onlyReasons.includes(order.manualReason))
        ) {
            return false;
        }
        if ((await findOrderRefund(c, orderId)) !== null) return false;
        await setOrderState(c, orderId, "manual", "redeemed", {
            manualReason: null,
            routerConfirmedAt: at,
        });
        return true;
    });
}
