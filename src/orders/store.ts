import type pg from "pg";
import type { Queryable } from "../db/pool.ts";
import {
    ALLOWED_TRANSITIONS,
    type NewOrder,
    type NewPayment,
    type OrderKind,
    type OrderRow,
    type OrderState,
    type OrderUpdate,
    type PaymentRow,
} from "./types.ts";
import type { PayInto, StoredX402Setup, X402Refusal } from "../x402/types.ts";

export class IllegalTransitionError extends Error {
    constructor(from: OrderState, to: OrderState) {
        super(`illegal order transition ${from} -> ${to}`);
        this.name = "IllegalTransitionError";
    }
}

export class StaleStateError extends Error {
    constructor(id: string, from: OrderState) {
        super(`order ${id} is not in state ${from}`);
        this.name = "StaleStateError";
    }
}

const COLUMNS: Record<string, string> = {
    paidAt: "paid_at",
    payer: "payer",
    redeemedAt: "redeemed_at",
    tokenExpiresAt: "token_expires_at",
    manualReason: "manual_reason",
    routerConfirmedAt: "router_confirmed_at",
    eventSeenAt: "event_seen_at",
    x402Refusal: "x402_refusal",
    coldTransferId: "cold_transfer_id",
    hotRouterRefundMicros: "hot_router_refund_micros",
    abandonReason: "abandon_reason",
    abandonAt: "abandon_at",
    paidVia: "paid_via",
};

interface OrderDbRow extends pg.QueryResultRow {
    id: string;
    kind: OrderKind;
    package_id: string;
    amount_micros: string | number;
    handle_sha256: string | null;
    description: string;
    claim_sha256: Buffer;
    claim_box: Buffer | null;
    idempotency_key: string | null;
    state: OrderState;
    created_at: Date;
    expires_at: Date;
    paid_at: Date | null;
    payer: string | null;
    redeemed_at: Date | null;
    token_expires_at: Date | null;
    event_seen_at: Date | null;
    router_confirmed_at: Date | null;
    abandon_reason: string | null;
    abandon_at: Date | null;
    manual_reason: string | null;
    pay_into: PayInto;
    allowance_micros: string | number;
    fee_micros: string | number;
    x402_setup: StoredX402Setup | null;
    x402_refusal: X402Refusal | null;
    cold_transfer_id: string | number | null;
    hot_router_refund_micros: string | number;
}

interface PaymentDbRow extends pg.QueryResultRow {
    order_id: string;
    tx_signature: string;
    message_hash: string;
    payer: string;
    source_token_account: string;
    amount_micros: string | number;
    blockhash: string;
    last_valid_block_height: string | number | bigint;
    status: "settling" | "confirmed";
    created_at: Date;
    confirmed_at: Date | null;
    landed_slot: string | number | bigint | null;
    payer_counted: boolean;
    multi_sender: boolean;
    split_min_micros: string | number | null;
}

function toOrder(r: OrderDbRow): OrderRow {
    return {
        id: r.id,
        kind: r.kind,
        packageId: r.package_id,
        amountMicros: Number(r.amount_micros),
        handleSha256: r.handle_sha256,
        description: r.description,
        claimSha256: r.claim_sha256,
        claimBox: r.claim_box,
        idempotencyKey: r.idempotency_key,
        state: r.state,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        paidAt: r.paid_at,
        payer: r.payer,
        redeemedAt: r.redeemed_at,
        tokenExpiresAt: r.token_expires_at,
        eventSeenAt: r.event_seen_at,
        routerConfirmedAt: r.router_confirmed_at,
        abandonReason: r.abandon_reason,
        abandonAt: r.abandon_at,
        manualReason: r.manual_reason,
        payInto: r.pay_into,
        allowanceMicros: Number(r.allowance_micros),
        feeMicros: Number(r.fee_micros),
        x402Setup: r.x402_setup,
        x402Refusal: r.x402_refusal,
        coldTransferId: r.cold_transfer_id === null ? null : Number(r.cold_transfer_id),
        hotRouterRefundMicros: Number(r.hot_router_refund_micros),
    };
}

function toPayment(r: PaymentDbRow): PaymentRow {
    return {
        orderId: r.order_id,
        txSignature: r.tx_signature,
        messageHash: r.message_hash,
        payer: r.payer,
        sourceTokenAccount: r.source_token_account,
        amountMicros: Number(r.amount_micros),
        blockhash: r.blockhash,
        lastValidBlockHeight: BigInt(r.last_valid_block_height),
        status: r.status,
        createdAt: r.created_at,
        confirmedAt: r.confirmed_at,
        landedSlot: r.landed_slot === null ? null : BigInt(r.landed_slot),
        payerCounted: r.payer_counted,
        multiSender: r.multi_sender,
        splitMinMicros: r.split_min_micros === null ? null : Number(r.split_min_micros),
    };
}

// Builds "col = $n" assignments from a whitelisted field map; values start at $first.
function assignments(
    fields: Partial<Record<string, unknown>>,
    first: number,
): { sql: string[]; values: unknown[] } {
    const sql: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const col = COLUMNS[key];
        if (col === undefined) throw new Error(`unknown order field ${key}`);
        values.push(value);
        sql.push(`${col} = $${first + values.length - 1}`);
    }
    return { sql, values };
}

export async function insertOrder(db: Queryable, o: NewOrder): Promise<OrderRow> {
    const res = await db.query<OrderDbRow>(
        `insert into orders (id, kind, package_id, amount_micros, handle_sha256, description,
            claim_sha256, claim_box, idempotency_key, state, expires_at, pay_into,
            allowance_micros, fee_micros, x402_setup)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unpaid', $10, $11, $12, $13, $14::jsonb)
         returning *`,
        [
            o.id,
            o.kind,
            o.packageId,
            o.amountMicros,
            o.handleSha256,
            o.description,
            o.claimSha256,
            o.claimBox,
            o.idempotencyKey,
            o.expiresAt,
            o.payInto,
            o.allowanceMicros,
            o.feeMicros,
            o.x402Setup === null ? null : JSON.stringify(o.x402Setup),
        ],
    );
    return toOrder(res.rows[0]!);
}

export async function findOrder(db: Queryable, id: string): Promise<OrderRow | null> {
    const res = await db.query<OrderDbRow>("select * from orders where id = $1", [id]);
    return res.rows[0] ? toOrder(res.rows[0]) : null;
}

export async function findOrderByIdempotencyKey(
    db: Queryable,
    key: string,
): Promise<OrderRow | null> {
    const res = await db.query<OrderDbRow>("select * from orders where idempotency_key = $1", [
        key,
    ]);
    return res.rows[0] ? toOrder(res.rows[0]) : null;
}

export async function lockOrder(c: pg.PoolClient, id: string): Promise<OrderRow | null> {
    const res = await c.query<OrderDbRow>("select * from orders where id = $1 for no key update", [
        id,
    ]);
    return res.rows[0] ? toOrder(res.rows[0]) : null;
}

export async function lockOrders(c: pg.PoolClient, ids: readonly string[]): Promise<OrderRow[]> {
    const res = await c.query<OrderDbRow>(
        "select * from orders where id = any($1::text[]) order by id for no key update",
        [ids],
    );
    return res.rows.map(toOrder);
}

export async function setOrderState(
    db: Queryable,
    id: string,
    from: OrderState,
    to: OrderState,
    fields: OrderUpdate = {},
): Promise<void> {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) throw new IllegalTransitionError(from, to);
    const { sql, values } = assignments(fields, 4);
    const set = ["state = $3", ...(to !== "unpaid" ? ["claim_box = null"] : []), ...sql];
    const res = await db.query(`update orders set ${set.join(", ")} where id = $1 and state = $2`, [
        id,
        from,
        to,
        ...values,
    ]);
    if (res.rowCount === 0) throw new StaleStateError(id, from);
}

export async function insertPayment(c: Queryable, p: NewPayment): Promise<void> {
    await c.query(
        `insert into payments (order_id, tx_signature, message_hash, payer, source_token_account,
            amount_micros, blockhash, last_valid_block_height, status, created_at, key_sha256,
            payer_counted, multi_sender, split_min_micros)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'settling', $9, $10, $11, $12, $13)`,
        [
            p.orderId,
            p.txSignature,
            p.messageHash,
            p.payer,
            p.sourceTokenAccount,
            p.amountMicros,
            p.blockhash,
            p.lastValidBlockHeight.toString(),
            p.createdAt,
            p.keySha256 ?? null,
            p.payerCounted ?? true,
            p.multiSender ?? false,
            p.splitMinMicros ?? null,
        ],
    );
}

// A deposit sweep signed again: the row names the attempt that can still land (spec 10.4)
export async function replacePaymentTx(
    c: pg.PoolClient,
    orderId: string,
    s: {
        txSignature: string;
        messageHash: string;
        blockhash: string;
        lastValidBlockHeight: bigint;
    },
): Promise<void> {
    const res = await c.query(
        `update payments set tx_signature = $2, message_hash = $3, blockhash = $4,
            last_valid_block_height = $5
         where order_id = $1`,
        [orderId, s.txSignature, s.messageHash, s.blockhash, s.lastValidBlockHeight.toString()],
    );
    if (res.rowCount !== 1) throw new Error(`no payment for order ${orderId}`);
}

export async function paymentKeyHash(db: Queryable, orderId: string): Promise<Buffer | null> {
    const res = await db.query<{ key_sha256: Buffer | null }>(
        "select key_sha256 from payments where order_id = $1",
        [orderId],
    );
    return res.rows[0]?.key_sha256 ?? null;
}

export async function findPaymentByOrder(
    db: Queryable,
    orderId: string,
): Promise<PaymentRow | null> {
    const res = await db.query<PaymentDbRow>("select * from payments where order_id = $1", [
        orderId,
    ]);
    return res.rows[0] ? toPayment(res.rows[0]) : null;
}

export async function lockPayment(c: pg.PoolClient, orderId: string): Promise<PaymentRow | null> {
    const res = await c.query<PaymentDbRow>(
        "select * from payments where order_id = $1 for no key update",
        [orderId],
    );
    return res.rows[0] ? toPayment(res.rows[0]) : null;
}

export async function setPaymentLandedSlot(
    db: Queryable,
    orderId: string,
    slot: bigint,
): Promise<boolean> {
    const res = await db.query(
        "update payments set landed_slot = $2 where order_id = $1 and landed_slot is null",
        [orderId, slot.toString()],
    );
    return res.rowCount === 1;
}

export async function confirmPayment(db: Queryable, orderId: string, at: Date): Promise<boolean> {
    const res = await db.query(
        `update payments set status = 'confirmed', confirmed_at = $2
         where order_id = $1 and status = 'settling'`,
        [orderId, at],
    );
    return res.rowCount === 1;
}

export async function archivePayment(
    db: Queryable,
    orderId: string,
    reason: "onchain_failed" | "blockhash_expired",
): Promise<boolean> {
    const res = await db.query(
        `with moved as (
            delete from payments where order_id = $1 and status = 'settling' returning *
         )
         insert into failed_payments (order_id, tx_signature, message_hash, payer, amount_micros,
            reason)
         select order_id, tx_signature, message_hash, payer, amount_micros, $2 from moved`,
        [orderId, reason],
    );
    return res.rowCount === 1;
}

export async function updateOrderFields(
    db: Queryable,
    id: string,
    fields: Partial<
        Pick<OrderRow, "eventSeenAt" | "routerConfirmedAt" | "abandonReason" | "abandonAt">
    >,
): Promise<boolean> {
    const { sql, values } = assignments(fields, 2);
    if (sql.length === 0) return (await findOrder(db, id)) !== null;
    const res = await db.query(`update orders set ${sql.join(", ")} where id = $1`, [
        id,
        ...values,
    ]);
    return res.rowCount === 1;
}

export async function markEventSeen(db: Queryable, id: string, at: Date): Promise<void> {
    await db.query("update orders set event_seen_at = coalesce(event_seen_at, $2) where id = $1", [
        id,
        at,
    ]);
}

export async function setManualReason(db: Queryable, id: string, reason: string): Promise<void> {
    await db.query("update orders set manual_reason = $2 where id = $1", [id, reason]);
}
