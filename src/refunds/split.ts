/**
 * Refunds of a payment shared by several owners (spec 10.9, founder decision D5): one refund row
 * per owner part, `(order_id, kind, part)` unique. A single owner's payment is a group of one row,
 * part 0, exactly as before groups.
 */
import type pg from "pg";
import type { Queryable } from "../db/pool.ts";
import { lockDeposit, sharesOf } from "../deposits/store.ts";
import type { ShareRow } from "../deposits/types.ts";
import { findPaymentByOrder, lockOrder } from "../orders/store.ts";
import {
    findRefundById,
    type RefundDbRow,
    type RefundKind,
    type RefundReason,
    type RefundRow,
    type RefundWallet,
    toRefund,
} from "./request.ts";

export interface RefundTarget {
    part: number;
    destination: string;
    payer: string;
    amountMicros: number;
}

// Shares are largest first, so a part merged or left at 0 is always one of the last ones and
// refund part i stays share part i
export function splitRefund(
    amountMicros: number,
    shares: readonly ShareRow[],
    minPartMicros: number,
): RefundTarget[] {
    const total = shares.reduce((sum, s) => sum + BigInt(s.appliedMicros), 0n);
    if (shares.length === 0 || total <= 0n) throw new Error("a split needs shares");
    const amount = BigInt(amountMicros);
    const parts = shares.map((s) => (amount * BigInt(s.appliedMicros)) / total);
    let first = amount - parts.slice(1).reduce((sum, p) => sum + p, 0n);
    // A part below the minimum would cost more in fees than it returns
    for (let i = 1; i < parts.length; i++) {
        const p = parts[i]!;
        if (p > 0n && p < BigInt(minPartMicros)) {
            first += p;
            parts[i] = 0n;
        }
    }
    parts[0] = first;
    const kept = shares
        .map((s, i) => ({ share: s, amount: parts[i]! }))
        .filter((p) => p.amount > 0n);
    // Shares out of order would send refund part i to another share's owner
    for (const [part, p] of kept.entries()) {
        if (p.share.part !== part) {
            throw new Error(`refund part ${part} would go to share part ${p.share.part}`);
        }
    }
    return kept.map((p, part) => ({
        part,
        destination: p.share.sourceTokenAccount,
        payer: p.share.owner,
        amountMicros: Number(p.amount),
    }));
}

export async function refundTargets(
    c: Queryable,
    orderId: string,
    amountMicros: number,
): Promise<RefundTarget[] | null> {
    const payment = await findPaymentByOrder(c, orderId);
    if (payment === null) return null;
    if (!payment.multiSender) {
        return [
            {
                part: 0,
                destination: payment.sourceTokenAccount,
                payer: payment.payer,
                amountMicros,
            },
        ];
    }
    const shares = await sharesOf(c, orderId);
    if (shares.length === 0) throw new Error(`shared payment of ${orderId} has no shares`);
    return splitRefund(amountMicros, shares, payment.splitMinMicros ?? 0);
}

// In the caller's transaction. Parts are inserted in part order, so of two racing inserts of one
// group the second always meets part 0 first and answers exists.
export async function insertRefundGroup(
    c: pg.PoolClient,
    base: {
        orderId: string;
        kind: RefundKind;
        reason: RefundReason;
        fromWallet: RefundWallet;
        budgetWaived: boolean;
        at: Date;
    },
    targets: readonly RefundTarget[],
): Promise<{ ids: number[] } | "exists"> {
    if (targets.length === 0) throw new Error(`refund of ${base.orderId} has no parts`);
    const any = await c.query("select 1 from refunds where order_id = $1 and kind = $2 limit 1", [
        base.orderId,
        base.kind,
    ]);
    if (any.rows.length > 0) return "exists";
    const ids: number[] = [];
    for (const t of targets) {
        const res = await c.query<{ id: string }>(
            `insert into refunds (order_id, kind, part, reason, amount_micros, destination, payer,
                state, from_wallet, budget_waived, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
             on conflict do nothing returning id`,
            [
                base.orderId,
                base.kind,
                t.part,
                base.reason,
                t.amountMicros,
                t.destination,
                t.payer,
                base.fromWallet,
                base.budgetWaived,
                base.at,
            ],
        );
        if (res.rows.length === 1) {
            ids.push(Number(res.rows[0]!.id));
            continue;
        }
        if (ids.length === 0) return "exists";
        throw new Error(`refund group ${base.orderId} ${base.kind} has part ${t.part} already`);
    }
    return { ids };
}

// Every row confirmed or resolved by hand; a group with no row is not complete
export async function groupComplete(
    c: Queryable,
    orderId: string,
    kind: RefundKind,
): Promise<boolean> {
    const res = await c.query<{ n: number; open: number }>(
        `select count(*)::int as n,
            (count(*) filter (where state <> 'confirmed'
                and manual_reason is distinct from 'resolved_by_hand'))::int as open
         from refunds where order_id = $1 and kind = $2`,
        [orderId, kind],
    );
    const row = res.rows[0]!;
    return row.n > 0 && row.open === 0;
}

export async function groupSum(
    c: Queryable,
    orderId: string,
    kinds: readonly RefundKind[],
): Promise<number> {
    const res = await c.query<{ total: string }>(
        `select coalesce(sum(amount_micros), 0)::text as total from refunds
         where order_id = $1 and kind = any($2::text[])`,
        [orderId, kinds],
    );
    return Number(res.rows[0]!.total);
}

// Two parts confirmed at once each wait for the other's row, so one of them sees the group
// complete. Callers take the order lock first where they take one (lock order: orders, refunds).
export async function lockRefundGroup(
    c: pg.PoolClient,
    orderId: string,
    kind: RefundKind,
): Promise<RefundRow[]> {
    const res = await c.query<RefundDbRow>(
        `select * from refunds where order_id = $1 and kind = $2 order by part
         for no key update`,
        [orderId, kind],
    );
    return res.rows.map(toRefund);
}

// The order (every kind but allowance), then the refund's whole group
export async function lockRefund(c: pg.PoolClient, refundId: number): Promise<RefundRow | null> {
    const peek = await findRefundById(c, refundId);
    if (peek === null) return null;
    if (peek.kind !== "allowance") await lockOrder(c, peek.orderId);
    const rows = await lockRefundGroup(c, peek.orderId, peek.kind);
    return rows.find((r) => r.id === refundId) ?? null;
}

// Held review money goes back once per transfer (spec 10.9, 17): the deposit lock keeps the next
// free part free, the transfer lock keeps a command typed twice from inserting twice.
export async function insertDepositRefund(
    c: pg.PoolClient,
    o: { orderId: string; signature: string; destination: string; payer: string; at: Date },
): Promise<{ id: number; repointed: boolean } | "refused"> {
    if ((await lockDeposit(c, o.orderId)) === null) return "refused";
    const res = await c.query<{
        amount_micros: string;
        applied_micros: string;
        outcome: string;
        refund_id: string | null;
        move_state: string | null;
        closes: boolean | null;
    }>(
        `select t.amount_micros, t.applied_micros, t.outcome, t.refund_id,
            m.state as move_state, m.closes
         from deposit_transfers t left join deposit_moves m on m.id = t.move_id
         where t.order_id = $1 and t.signature = $2
         for no key update of t`,
        [o.orderId, o.signature],
    );
    const t = res.rows[0];
    if (t === undefined || t.outcome !== "review") return "refused";
    if (t.move_state !== "confirmed" || t.closes !== true) return "refused";
    const held = Number(t.amount_micros) - Number(t.applied_micros);
    if (held <= 0) return "refused";
    if (t.refund_id === null) {
        const next = await c.query<{ part: number }>(
            `select coalesce(max(part) + 1, 0)::int as part from refunds
             where order_id = $1 and kind = 'deposit'`,
            [o.orderId],
        );
        const inserted = await c.query<{ id: string }>(
            `insert into refunds (order_id, kind, part, reason, amount_micros, destination, payer,
                state, from_wallet, deposit_signature, created_at)
             values ($1, 'deposit', $2, 'deposit_held', $3, $4, $5, 'pending', 'refund', $6, $7)
             returning id`,
            [o.orderId, next.rows[0]!.part, held, o.destination, o.payer, o.signature, o.at],
        );
        const id = Number(inserted.rows[0]!.id);
        await c.query(
            "update deposit_transfers set refund_id = $3 where order_id = $1 and signature = $2",
            [o.orderId, o.signature, id],
        );
        return { id, repointed: false };
    }
    const id = Number(t.refund_id);
    await lockRefundGroup(c, o.orderId, "deposit");
    // A row in flight or paid keeps its destination; only a manual one is pointed elsewhere
    const repointed = await c.query(
        `update refunds set destination = $2, payer = $3, state = 'pending', attempts = 0,
            manual_reason = null
         where id = $1 and state = 'manual'
            and manual_reason is distinct from 'resolved_by_hand'`,
        [id, o.destination, o.payer],
    );
    return repointed.rowCount === 1 ? { id, repointed: true } : "refused";
}
