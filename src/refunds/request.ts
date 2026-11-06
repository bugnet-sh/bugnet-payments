import type pg from "pg";
import { type Queryable, withTx } from "../db/pool.ts";
import type { OrderRow } from "../orders/types.ts";
import { findPaymentByOrder, lockOrder, setOrderState } from "../orders/store.ts";

export type RefundReason =
    "unredeemed" | "late" | "router_refundable" | "abandoned" | "no_router_record" | "operator";

export interface RefundRow {
    id: number;
    orderId: string;
    kind: "full" | "partial";
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
}

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
    };
}

export async function findRefund(db: Queryable, orderId: string): Promise<RefundRow | null> {
    const res = await db.query<RefundDbRow>(
        "select * from refunds where order_id = $1 order by id limit 1",
        [orderId],
    );
    return res.rows[0] ? toRefund(res.rows[0]) : null;
}

export type RefundRequest = "created" | "exists" | "not_refundable" | "unknown" | "invalid_amount";

// The order lock makes the state check and the insert one step, so two triggers (an event and
// the sweeper) can never both create a refund, and a full and a partial refund never coexist.
// Without an amount the refund is full; with one it is partial and must not exceed the payment.
// A caller that chose the order before taking the lock passes `eligible` to re-check it under it.
export async function requestRefund(
    pool: pg.Pool,
    orderId: string,
    reason: RefundReason,
    amountMicros?: number,
    eligible?: (order: OrderRow) => boolean,
): Promise<RefundRequest> {
    return withTx(pool, async (c) => {
        const order = await lockOrder(c, orderId);
        if (order === null) return "unknown";
        if (eligible !== undefined && !eligible(order)) return "not_refundable";
        if (order.state === "refunding" || order.state === "refunded") return "exists";
        if (order.state === "manual") {
            if ((await findRefund(c, orderId)) !== null) return "exists";
        } else if (order.state !== "paid" && order.state !== "redeemed") {
            return "not_refundable";
        }
        const payment = await findPaymentByOrder(c, orderId);
        if (payment === null) return "not_refundable";
        if (
            amountMicros !== undefined &&
            (!Number.isSafeInteger(amountMicros) ||
                amountMicros < 1 ||
                amountMicros > payment.amountMicros)
        ) {
            return "invalid_amount";
        }
        const inserted = await c.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state)
             values ($1, $2, $3, $4, $5, $6, 'pending')
             on conflict do nothing`,
            [
                orderId,
                amountMicros === undefined ? "full" : "partial",
                reason,
                amountMicros ?? payment.amountMicros,
                payment.sourceTokenAccount,
                payment.payer,
            ],
        );
        if (inserted.rowCount !== 1) return "exists";
        await setOrderState(c, orderId, order.state, "refunding");
        return "created";
    });
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
        if ((await findRefund(c, orderId)) !== null) return false;
        await setOrderState(c, orderId, "manual", "redeemed", {
            manualReason: null,
            routerConfirmedAt: at,
        });
        return true;
    });
}
