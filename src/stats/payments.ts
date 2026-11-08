import type pg from "pg";
import type { Queryable } from "../db/pool.ts";
import type { PaidVia } from "../orders/types.ts";
import { isCanonicalAddress, isCanonicalSignature } from "../solana/base58.ts";
import { type Cursor, encodeCursor, type ListKind } from "./cursor.ts";

export interface StatsPaymentItem {
    at: string;
    kind: ListKind;
    amountMicros: number;
    method?: PaidVia;
    wallet: string;
    tx: string;
}

export interface StatsPaymentsPage {
    items: StatsPaymentItem[];
    next: string | null;
}

export const PAGE_SIZE = 50;
const WINDOW_MS = 30 * 86_400_000;
const BATCH = PAGE_SIZE + 1;

interface ItemRow extends pg.QueryResultRow {
    at: Date;
    kind: ListKind;
    id: string;
    amount_micros: string;
    method: PaidVia | null;
    wallet: string;
    tx: string | null;
}

// Times are cut to the millisecond and text compared bytewise, so the cursor repeats the order exactly
const PAGE_SQL = `
    with items as (
        select date_trunc('milliseconds', p.confirmed_at) as at,
            (case o.kind when 'start' then 'sandbox' when 'extend' then 'extend'
                else 'x402_allowance' end) collate "C" as kind,
            p.order_id collate "C" as id, p.amount_micros, o.paid_via as method,
            p.payer as wallet, p.tx_signature as tx
          from payments p join orders o on o.id = p.order_id
         where p.status = 'confirmed' and p.confirmed_at > $1 and p.confirmed_at <= $2
        union all
        select date_trunc('milliseconds', confirmed_at),
            (case from_wallet when 'refund' then 'refund' else 'allowance_return' end) collate "C",
            id::text collate "C", amount_micros, null, destination, tx_signature
          from refunds
         where state = 'confirmed' and confirmed_at > $1 and confirmed_at <= $2
    )
    select at, kind, id, amount_micros::text, method, wallet, tx from items
     where at > $1 and at <= $2
       and ($3::timestamptz is null or at < $3
            or (at = $3 and (kind > $4 or (kind = $4 and id < $5))))
     order by at desc, kind, id desc
     limit $6`;

function cursorOf(r: ItemRow): Cursor {
    return { at: r.at.getTime(), kind: r.kind, id: r.id };
}

function toItem(r: ItemRow): StatsPaymentItem | null {
    if (!isCanonicalAddress(r.wallet) || !isCanonicalSignature(r.tx)) return null;
    const amount = BigInt(r.amount_micros);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const item: StatsPaymentItem = {
        at: r.at.toISOString(),
        kind: r.kind,
        amountMicros: Number(amount),
        wallet: r.wallet,
        tx: r.tx,
    };
    if (r.method !== null) item.method = r.method;
    return item;
}

/** One page of the public payment list: the last 30 days, newest first (site-and-stats 7). */
export async function statsPayments(
    db: Queryable,
    before: Cursor | null,
    now: Date,
): Promise<StatsPaymentsPage> {
    const from = new Date(now.getTime() - WINDOW_MS);
    const items: StatsPaymentItem[] = [];
    let last: ItemRow | undefined;
    let after = before;
    for (;;) {
        const { rows } = await db.query<ItemRow>(PAGE_SQL, [
            from,
            now,
            after === null ? null : new Date(after.at),
            after?.kind ?? null,
            after?.id ?? null,
            BATCH,
        ]);
        for (const r of rows) {
            const item = toItem(r);
            if (item === null) continue;
            if (items.length === PAGE_SIZE) return { items, next: encodeCursor(cursorOf(last!)) };
            items.push(item);
            last = r;
        }
        if (rows.length < BATCH) return { items, next: null };
        after = cursorOf(rows.at(-1)!);
    }
}
