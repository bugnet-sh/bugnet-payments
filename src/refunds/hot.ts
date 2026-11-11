import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import { findPaymentByOrder, lockOrder, setManualReason, setOrderState } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { isCanonicalSignature } from "../solana/base58.ts";
import type { AllowanceFunding } from "../x402/funding.ts";
import { movePool, voidConditionsHold } from "../x402/ledger.ts";
import { enqueueAllowanceEvent, paidEventSent } from "../x402/outbox.ts";
import type { AccountRow } from "../x402/types.ts";
import { findRefund, type RefundReason, type RefundRequest, type RefundRow } from "./request.ts";
import { groupComplete, groupSum, insertRefundGroup, lockRefund, refundTargets } from "./split.ts";

async function insertFullRow(
    c: pg.PoolClient,
    order: OrderRow,
    reason: RefundReason,
    at: Date,
    budgetWaived: boolean,
): Promise<RefundRequest> {
    const payment = await findPaymentByOrder(c, order.id);
    if (payment === null) return "not_refundable";
    const targets = await refundTargets(c, order.id, payment.amountMicros);
    if (targets === null) return "not_refundable";
    const inserted = await insertRefundGroup(
        c,
        { orderId: order.id, kind: "full", reason, fromWallet: "allowance", budgetWaived, at },
        targets,
    );
    if (inserted === "exists") return "exists";
    await setOrderState(
        c,
        order.id,
        order.state,
        "refunding",
        order.state === "manual" ? { manualReason: null } : {},
    );
    return "created";
}

// The caller holds the order lock. Every refund of the order's payment counts against it; a
// deposit row returns held review money, not the payment, so it does not.
async function hotPartial(
    c: pg.PoolClient,
    order: OrderRow,
    share: number,
    at: Date,
    opts: { budgetWaived: boolean },
): Promise<RefundRequest> {
    if (order.state === "refunding" || order.state === "refunded") return "exists";
    if (order.state !== "paid" && order.state !== "redeemed" && order.state !== "manual") {
        return "not_refundable";
    }
    const payment = await findPaymentByOrder(c, order.id);
    if (payment === null) return "not_refundable";
    if ((await findRefund(c, order.id, "full")) !== null) return "exists";
    if ((await findRefund(c, order.id, "partial")) !== null) return "exists";
    const total = await groupSum(c, order.id, ["full", "partial", "allowance"]);
    if (
        !Number.isSafeInteger(share) ||
        share < 0 ||
        share > order.amountMicros - order.allowanceMicros ||
        total + share > payment.amountMicros
    ) {
        return "invalid_amount";
    }
    if (share > 0) {
        const wallet = order.coldTransferId === null ? "allowance" : "refund";
        const targets = await refundTargets(c, order.id, share);
        if (targets === null) return "not_refundable";
        const inserted = await insertRefundGroup(
            c,
            {
                orderId: order.id,
                kind: "partial",
                reason: "router_refundable",
                fromWallet: wallet,
                budgetWaived: opts.budgetWaived,
                at,
            },
            targets,
        );
        if (inserted === "exists") return "exists";
        if (wallet === "allowance") {
            await c.query(
                `update orders set hot_router_refund_micros = hot_router_refund_micros + $2
                 where id = $1`,
                [order.id, share],
            );
        }
    }
    await c.query(
        `update orders set router_confirmed_at = coalesce(router_confirmed_at, $2),
            event_seen_at = coalesce(event_seen_at, $2) where id = $1`,
        [order.id, at],
    );
    if (order.state === "manual") {
        await setOrderState(c, order.id, "manual", "redeemed", { manualReason: null });
    }
    return share === 0 ? "zero_share" : "created";
}

// The 7.2 table, first row that applies. The caller holds the order and account locks.
export async function decideHotFullRefund(
    c: pg.PoolClient,
    order: OrderRow,
    account: AccountRow | null,
    reason: RefundReason,
    funding: AllowanceFunding,
    at: Date,
    log: Log,
    triggerDeadline: Date | null | undefined,
    budgetWaived: boolean,
    afterCommit: (() => void)[],
): Promise<RefundRequest> {
    const funded = await c.query("select 1 from x402_fundings where order_id = $1", [order.id]);
    if (funded.rows.length === 0) return insertFullRow(c, order, reason, at, budgetWaived);
    if (order.coldTransferId !== null) return "not_refundable";
    if (account !== null && (await voidConditionsHold(c, account, triggerDeadline))) {
        const made = await insertFullRow(c, order, reason, at, budgetWaived);
        if (made !== "created") return made;
        if (!(await funding.void(c, order, account, at, triggerDeadline))) {
            throw new Error(`x402 funding of order ${order.id} could not be voided`);
        }
        return made;
    }
    if (reason === "router_refundable") {
        return hotPartial(c, order, order.amountMicros - order.allowanceMicros, at, {
            budgetWaived,
        });
    }
    if (order.state === "paid" || order.state === "redeemed") {
        await setOrderState(c, order.id, order.state, "manual", {
            manualReason: "refund_amount_pending",
        });
    } else if (order.manualReason === "refund_amount_pending") {
        return "parked";
    } else {
        await setManualReason(c, order.id, "refund_amount_pending");
    }
    afterCommit.push(() =>
        log.alarm("manual_queue", { orderId: order.id, reason: "refund_amount_pending" }),
    );
    return "parked";
}

// The router's entry as given (F9), or a share of 0.
export async function writeHotPartial(
    pool: pg.Pool,
    orderId: string,
    shareMicros: number,
    at: Date,
    opts: { budgetWaived?: boolean; log?: Log } = {},
): Promise<RefundRequest> {
    return withTx(pool, async (c) => {
        const order = await lockOrder(c, orderId);
        if (order === null) return "unknown";
        if (order.payInto !== "allowance") {
            throw new Error(`order ${orderId} does not pay into the allowance`);
        }
        return hotPartial(c, order, shareMicros, at, { budgetWaived: opts.budgetWaived ?? false });
    });
}

// What a paid hot refund does to the ledger, shared by the confirm and by-hand paths. The caller
// holds the group's locks, so of two parts confirmed at once only the second sees the group
// complete, and the group's event and order change happen once.
async function applyEffects(
    c: pg.PoolClient,
    row: RefundRow,
    tx: string,
    at: Date,
    x402: Settings["x402"],
    log: Log,
): Promise<void> {
    const funding = await c.query<{
        account_id: string;
        allowance_micros: string;
        voided_at: Date | null;
    }>("select account_id, allowance_micros, voided_at from x402_fundings where order_id = $1", [
        row.orderId,
    ]);
    const f = funding.rows[0];
    if (row.kind === "allowance") {
        if (f === undefined) throw new Error(`allowance refund ${row.id} has no funding`);
        await movePool(c, { committed: -row.amountMicros }, x402, log);
        if (!(await groupComplete(c, row.orderId, "allowance"))) return;
        await enqueueAllowanceEvent(
            c,
            {
                startOrderId: f.account_id,
                orderId: row.orderId,
                phase: "refunded",
                amountMicros: await groupSum(c, row.orderId, ["allowance"]),
                keptMicros: 0,
                tx,
            },
            at,
        );
        return;
    }
    if (row.kind !== "full" || !(await groupComplete(c, row.orderId, "full"))) return;
    const order = await lockOrder(c, row.orderId);
    if (order !== null && (order.state === "refunding" || order.state === "manual")) {
        await setOrderState(
            c,
            row.orderId,
            order.state,
            "refunded",
            order.state === "manual" ? { manualReason: null } : {},
        );
    }
    if (f !== undefined && f.voided_at !== null && (await paidEventSent(c, row.orderId))) {
        await enqueueAllowanceEvent(
            c,
            {
                startOrderId: f.account_id,
                orderId: row.orderId,
                phase: "refunded",
                amountMicros: Number(f.allowance_micros),
                keptMicros: 0,
                tx,
            },
            at,
        );
    }
}

// The one confirm path: every hot refund that landed ends here, from the executor, the
// reconciler or the sweeper.
export async function confirmHotRefund(
    c: pg.PoolClient,
    refundId: number,
    landed: { slot: bigint | null; signature: string },
    at: Date,
    x402: Settings["x402"],
    log: Log,
): Promise<boolean> {
    const row = await lockRefund(c, refundId);
    if (row === null) return false;
    if (
        landed.signature !== row.txSignature &&
        !row.previousSignatures.includes(landed.signature)
    ) {
        log.error("landed signature does not belong to the refund", { refundId });
        return false;
    }
    const res = await c.query(
        `update refunds set state = 'confirmed', confirmed_at = $2, landed_slot = $3,
            tx_signature = $4,
            previous_signatures = case when tx_signature = $4 then previous_signatures
                else array_append(array_remove(previous_signatures, $4), tx_signature) end
         where id = $1 and state in ('signed', 'sent')`,
        [refundId, at, landed.slot, landed.signature],
    );
    if (res.rowCount !== 1) return false;
    await applyEffects(c, row, landed.signature, at, x402, log);
    return true;
}

// The caller proves the transfer and checks the hold (Task 28); this records it.
export async function resolveHotRefundByHand(
    c: pg.PoolClient,
    refundId: number,
    handTx: string,
    at: Date,
    x402: Settings["x402"],
    log: Log,
): Promise<boolean> {
    if (!isCanonicalSignature(handTx)) return false;
    const row = await lockRefund(c, refundId);
    if (row === null) return false;
    const res = await c.query(
        `update refunds set hand_tx = $2, confirmed_at = $3, state = 'manual',
            manual_reason = 'resolved_by_hand'
         where id = $1 and from_wallet = 'allowance' and state in ('manual', 'pending')
            and manual_reason is distinct from 'resolved_by_hand'`,
        [refundId, handTx, at],
    );
    if (res.rowCount !== 1) return false;
    await applyEffects(c, row, handTx, at, x402, log);
    return true;
}
