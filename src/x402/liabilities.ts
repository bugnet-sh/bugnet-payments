import type { Queryable } from "../db/pool.ts";
import type { Tail } from "./tail.ts";

export async function liabilities(db: Queryable): Promise<bigint> {
    const res = await db.query<{ micros: string }>(
        `select
            (select coalesce(sum(funded_micros - spent_micros - refunded_micros - kept_micros), 0)
                from x402_accounts where state <> 'closed')
            + (select coalesce(sum(amount_micros), 0) from refunds
                where from_wallet = 'allowance'
                  and (state in ('pending', 'signed', 'sent')
                       or (state = 'manual' and manual_reason is distinct from 'resolved_by_hand')))
            as micros`,
    );
    return BigInt(res.rows[0]!.micros);
}

// Money by when it moved: fundings by their order payment's landing, spending as booked with the
// seller payments that landed above C added back, and a hot refund until a stored transaction at or before C carries it.
export async function liabilitiesAt(db: Queryable, slotC: bigint, tail: Tail): Promise<bigint> {
    const res = await db.query<{ micros: string }>(
        `with
        fund as (select coalesce(sum(f.allowance_micros), 0) v
            from x402_fundings f
            join x402_accounts a on a.id = f.account_id and a.state <> 'closed'
            join payments p on p.order_id = f.order_id
            where f.voided_at is null and p.landed_slot between $2 and $1),
        acct as (select coalesce(sum(spent_micros + refunded_micros + kept_micros), 0) v
            from x402_accounts where state <> 'closed'),
        above as (select coalesce(sum(xp.amount_micros), 0) v
            from x402_payments xp
            join x402_accounts a on a.id = xp.account_id and a.state <> 'closed'
            where xp.state = 'confirmed' and xp.landed_slot > $1),
        hot as (select coalesce(sum(r.amount_micros), 0) v
            from refunds r
            where r.from_wallet = 'allowance'
              and r.manual_reason is distinct from 'resolved_by_hand'
              and (r.state <> 'confirmed' or $3::timestamptz is null or r.confirmed_at > $3)
              and (r.kind = 'allowance' or exists (select 1 from payments p
                    where p.order_id = r.order_id and p.landed_slot between $2 and $1))
              and not exists (select 1 from x402_chain_txs t
                    where not t.failed and t.slot <= $1
                      and t.signature = any(array_append(r.previous_signatures, r.tx_signature))))
        select fund.v - acct.v + above.v + hot.v as micros from fund, acct, above, hot`,
        [slotC.toString(), tail.openingSlot.toString(), tail.openedAt],
    );
    return BigInt(res.rows[0]!.micros);
}

export interface TransferPart {
    kind: "share" | "fee" | "kept";
    orderId: string | null;
    accountId: string | null;
    micros: number;
    since: Date;
}

interface PartDbRow {
    kind: TransferPart["kind"];
    order_id: string | null;
    account_id: string | null;
    micros: string;
    since: Date;
}

// needsEnd: a share is transferable only once its placement is ready or ended for good (7.11);
// the audit (7.17) counts every share still in the wallet.
async function parts(
    db: Queryable,
    slot: bigint,
    tail: Tail,
    needsEnd: boolean,
): Promise<TransferPart[]> {
    const res = await db.query<PartDbRow>(
        `select kind, order_id, account_id, micros, since from (
            select 'share' as kind, o.id as order_id, null::text as account_id,
                o.amount_micros - o.allowance_micros - o.hot_router_refund_micros as micros,
                o.paid_at as since
            from orders o
            join payments p on p.order_id = o.id and p.landed_slot between $2 and $1
            where o.kind = 'start' and o.pay_into = 'allowance' and o.cold_transfer_id is null
              and o.amount_micros - o.allowance_micros - o.hot_router_refund_micros > 0
              and not exists (select 1 from refunds r where r.order_id = o.id and r.kind = 'full')
              and (not $4::boolean or exists (select 1 from events e
                    where e.payload->>'order_id' = o.id
                      and (e.type = 'placement.ready'
                           or (e.type in ('placement.terminated', 'placement.failed')
                               and e.payload->'refundable' = 'false'::jsonb))))
            union all
            select 'fee', o.id, null, o.fee_micros, f.created_at
            from orders o
            join x402_fundings f on f.order_id = o.id
            join payments p on p.order_id = o.id and p.landed_slot between $2 and $1
            where o.kind = 'allowance' and o.fee_micros > 0 and o.cold_transfer_id is null
              and f.voided_at is null and f.fee_credited_micros = 0
            union all
            select 'kept', null, a.id, a.kept_micros, a.closed_at
            from x402_accounts a
            where a.state = 'closed' and a.kept_micros > 0 and a.kept_cold_transfer_id is null
              and ($3::timestamptz is null or a.closed_at > $3)
              and not exists (select 1 from x402_fundings f
                    left join payments p on p.order_id = f.order_id
                    where f.account_id = a.id and f.voided_at is null
                      and (p.landed_slot is null or p.landed_slot not between $2 and $1))
         ) t
         order by since, kind, coalesce(order_id, account_id)`,
        [slot.toString(), tail.openingSlot.toString(), tail.openedAt, needsEnd],
    );
    return res.rows.map((r) => ({
        kind: r.kind,
        orderId: r.order_id,
        accountId: r.account_id,
        micros: Number(r.micros),
        since: r.since,
    }));
}

export async function transferableParts(
    db: Queryable,
    slotC: bigint,
    tail: Tail,
): Promise<TransferPart[]> {
    return parts(db, slotC, tail, true);
}

export async function bugnetMoneyAt(db: Queryable, slotV: bigint, tail: Tail): Promise<bigint> {
    const all = await parts(db, slotV, tail, false);
    return all.reduce((sum, p) => sum + BigInt(p.micros), 0n);
}

export async function unsettledColdTransfersAt(db: Queryable, slotC: bigint): Promise<bigint> {
    const res = await db.query<{ micros: string }>(
        `select coalesce(sum(c.amount_micros), 0) as micros
         from x402_cold_transfers c
         where c.state <> 'failed'
           and not exists (select 1 from x402_chain_txs t
                where not t.failed and t.slot <= $1
                  and t.signature = any(array_append(c.previous_signatures, c.tx_signature)))`,
        [slotC.toString()],
    );
    return BigInt(res.rows[0]!.micros);
}
