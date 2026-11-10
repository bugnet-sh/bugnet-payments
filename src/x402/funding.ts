import type pg from "pg";
import type { Settings } from "../config.ts";
import type { Log } from "../log.ts";
import type { OrderRow, PaymentRow } from "../orders/types.ts";
import {
    creditMicros,
    insertFirstUse,
    movePool,
    startClosing,
    voidConditionsHold,
} from "./ledger.ts";
import { dropPendingPaidEvent, enqueueAllowanceEvent } from "./outbox.ts";
import type { AccountRow, FundingRow } from "./types.ts";

export type UnspentOutcome =
    | { kind: "not_ready" }
    | { kind: "already" }
    | { kind: "none" }
    | { kind: "kept"; keptMicros: number }
    | { kind: "refund"; refundIds: number[]; amountMicros: number };

// The caller holds the account row lock in every method, and the order row lock in all but refund.
export interface AllowanceFunding {
    fund(
        c: pg.PoolClient,
        order: OrderRow,
        payment: PaymentRow,
        account: AccountRow,
        at: Date,
    ): Promise<FundingRow>;
    void(
        c: pg.PoolClient,
        order: OrderRow,
        account: AccountRow,
        at: Date,
        triggerDeadline?: Date | null,
    ): Promise<boolean>;
    refund(c: pg.PoolClient, account: AccountRow, at: Date): Promise<UnspentOutcome>;
}

interface FundingDbRow extends pg.QueryResultRow {
    order_id: string;
    account_id: string;
    allowance_micros: string | number;
    fee_credited_micros: string | number;
    payer: string;
    source_token_account: string;
    created_at: Date;
    voided_at: Date | null;
}

export function toFunding(r: FundingDbRow): FundingRow {
    return {
        orderId: r.order_id,
        accountId: r.account_id,
        allowanceMicros: Number(r.allowance_micros),
        feeCreditedMicros: Number(r.fee_credited_micros),
        payer: r.payer,
        sourceTokenAccount: r.source_token_account,
        createdAt: r.created_at,
        voidedAt: r.voided_at,
    };
}

export function createAllowanceFunding(d: { x402: Settings["x402"]; log: Log }): AllowanceFunding {
    const { x402, log } = d;

    async function fund(
        c: pg.PoolClient,
        order: OrderRow,
        payment: PaymentRow,
        account: AccountRow,
        at: Date,
    ): Promise<FundingRow> {
        const credit = await creditMicros(c, order.feeMicros, account.id);
        const amount = order.allowanceMicros + credit;
        const inserted = await c.query<FundingDbRow>(
            `insert into x402_fundings (order_id, account_id, allowance_micros,
                fee_credited_micros, payer, source_token_account, created_at)
             values ($1, $2, $3, $4, $5, $6, $7) returning *`,
            [order.id, account.id, amount, credit, payment.payer, payment.sourceTokenAccount, at],
        );
        const raised = await c.query(
            `update x402_accounts set funded_micros = funded_micros + $2
             where id = $1 and state = 'open'`,
            [account.id, amount],
        );
        if (raised.rowCount !== 1) throw new Error(`x402 account ${account.id} is not open`);
        await insertFirstUse(c, payment.payer, order.id, at);
        await enqueueAllowanceEvent(
            c,
            {
                startOrderId: account.id,
                orderId: order.id,
                phase: "paid",
                amountMicros: amount,
                keptMicros: 0,
                tx: payment.txSignature,
            },
            at,
        );
        await movePool(c, { unpaid: -order.allowanceMicros, committed: amount }, x402, log);
        return toFunding(inserted.rows[0]!);
    }

    async function voidFunding(
        c: pg.PoolClient,
        order: OrderRow,
        account: AccountRow,
        at: Date,
        triggerDeadline?: Date | null,
    ): Promise<boolean> {
        if (!(await voidConditionsHold(c, account, triggerDeadline))) return false;
        const voided = await c.query<{ allowance_micros: string; payer: string }>(
            `update x402_fundings set voided_at = $2
             where order_id = $1 and account_id = $3 and voided_at is null
             returning allowance_micros, payer`,
            [order.id, at, account.id],
        );
        if (voided.rows.length !== 1) return false;
        const { payer } = voided.rows[0]!;
        const amount = Number(voided.rows[0]!.allowance_micros);
        const lowered = await c.query(
            `update x402_accounts set funded_micros = funded_micros - $2
             where id = $1 and funded_micros >= $2`,
            [account.id, amount],
        );
        if (lowered.rowCount !== 1) throw new Error(`x402 account ${account.id} changed`);
        await c.query(
            `delete from x402_payers p where p.payer = $1 and p.first_order_id = $2
             and not exists (select 1 from x402_fundings f where f.payer = $1 and f.voided_at is null)`,
            [payer, order.id],
        );
        await dropPendingPaidEvent(c, order.id, "voided");
        await startClosing(c, account.id, at);
        await movePool(c, { committed: -amount }, x402, log);
        return true;
    }

    async function refund(
        c: pg.PoolClient,
        account: AccountRow,
        at: Date,
    ): Promise<UnspentOutcome> {
        if (account.heldMicros > 0) return { kind: "not_ready" };
        const done = await c.query(
            `select 1 from refunds r join x402_fundings f on f.order_id = r.order_id
             where f.account_id = $1 and r.kind = 'allowance' limit 1`,
            [account.id],
        );
        if (done.rows.length > 0) return { kind: "already" };
        const unspent =
            account.fundedMicros -
            account.spentMicros -
            account.refundedMicros -
            account.keptMicros;
        if (unspent <= 0) return { kind: "none" };
        if (unspent < x402.refund_min_micros) {
            const kept = await c.query(
                `update x402_accounts set kept_micros = $2
                 where id = $1 and held_micros = 0 and kept_micros = 0
                 and funded_micros - spent_micros - refunded_micros - kept_micros = $2`,
                [account.id, unspent],
            );
            if (kept.rowCount !== 1) throw new Error(`x402 account ${account.id} changed`);
            await enqueueAllowanceEvent(
                c,
                {
                    startOrderId: account.id,
                    orderId: account.id,
                    phase: "kept",
                    amountMicros: 0,
                    keptMicros: unspent,
                    tx: null,
                },
                at,
            );
            await movePool(c, { committed: -unspent }, x402, log);
            return { kind: "kept", keptMicros: unspent };
        }
        const raised = await c.query(
            `update x402_accounts set refunded_micros = refunded_micros + $2
             where id = $1 and held_micros = 0
             and funded_micros - spent_micros - refunded_micros - kept_micros = $2`,
            [account.id, unspent],
        );
        if (raised.rowCount !== 1) throw new Error(`x402 account ${account.id} changed`);
        const fundings = await c.query<FundingDbRow>(
            `select * from x402_fundings where account_id = $1 and voided_at is null
             order by created_at desc, order_id desc`,
            [account.id],
        );
        const refundIds: number[] = [];
        let left = unspent;
        for (const f of fundings.rows.map(toFunding)) {
            if (left === 0) break;
            const share = Math.min(left, f.allowanceMicros);
            const row = await c.query<{ id: string }>(
                `insert into refunds (order_id, kind, reason, amount_micros, destination, payer,
                    state, from_wallet, created_at)
                 values ($1, 'allowance', 'x402_unspent', $2, $3, $4, 'pending', 'allowance', $5)
                 on conflict (order_id, kind, part) do nothing returning id`,
                [f.orderId, share, f.sourceTokenAccount, f.payer, at],
            );
            if (row.rows.length !== 1) throw new Error(`allowance refund of ${f.orderId} exists`);
            refundIds.push(Number(row.rows[0]!.id));
            left -= share;
        }
        if (left !== 0) throw new Error(`x402 account ${account.id} has unrefundable money`);
        return { kind: "refund", refundIds, amountMicros: unspent };
    }

    return { fund, void: voidFunding, refund };
}
