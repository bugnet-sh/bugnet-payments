import type pg from "pg";
import type { Settings } from "../config.ts";
import type { Queryable } from "../db/pool.ts";
import type { Log } from "../log.ts";
import type { PlacementLookup, RouterClient } from "../router/client.ts";
import type { AccountRow, AccountState } from "./types.ts";

interface AccountDbRow extends pg.QueryResultRow {
    id: string;
    handle_sha256: string | null;
    placement_id: string | null;
    package_id: string;
    state: AccountState;
    funded_micros: string | number;
    spent_micros: string | number;
    held_micros: string | number;
    refunded_micros: string | number;
    kept_micros: string | number;
    kept_cold_transfer_id: string | number | null;
    spend_per_minute_micros: string | number;
    minute_start: Date;
    minute_micros: string | number;
    deadline: Date | null;
    close_check_failing_since: Date | null;
    created_at: Date;
    closing_at: Date | null;
    closed_at: Date | null;
}

export function toAccount(r: AccountDbRow): AccountRow {
    return {
        id: r.id,
        handleSha256: r.handle_sha256,
        placementId: r.placement_id,
        packageId: r.package_id,
        state: r.state,
        fundedMicros: Number(r.funded_micros),
        spentMicros: Number(r.spent_micros),
        heldMicros: Number(r.held_micros),
        refundedMicros: Number(r.refunded_micros),
        keptMicros: Number(r.kept_micros),
        keptColdTransferId:
            r.kept_cold_transfer_id === null ? null : Number(r.kept_cold_transfer_id),
        spendPerMinuteMicros: Number(r.spend_per_minute_micros),
        minuteStart: r.minute_start,
        minuteMicros: Number(r.minute_micros),
        deadline: r.deadline,
        closeCheckFailingSince: r.close_check_failing_since,
        createdAt: r.created_at,
        closingAt: r.closing_at,
        closedAt: r.closed_at,
    };
}

export interface NewAccount {
    id: string;
    handleSha256: string | null;
    placementId: string | null;
    packageId: string;
    spendPerMinuteMicros: number;
    deadline: Date | null;
    createdAt?: Date;
}

export async function findAccount(db: Queryable, id: string): Promise<AccountRow | null> {
    const res = await db.query<AccountDbRow>("select * from x402_accounts where id = $1", [id]);
    return res.rows[0] ? toAccount(res.rows[0]) : null;
}

export async function findAccountByHandle(
    db: Queryable,
    handleSha256: string,
): Promise<AccountRow | null> {
    const res = await db.query<AccountDbRow>(
        "select * from x402_accounts where handle_sha256 = $1",
        [handleSha256],
    );
    return res.rows[0] ? toAccount(res.rows[0]) : null;
}

export async function lockAccount(c: pg.PoolClient, id: string): Promise<AccountRow | null> {
    const res = await c.query<AccountDbRow>(
        "select * from x402_accounts where id = $1 for no key update",
        [id],
    );
    return res.rows[0] ? toAccount(res.rows[0]) : null;
}

export async function insertAccount(db: Queryable, a: NewAccount): Promise<AccountRow> {
    await db.query(
        `insert into x402_accounts (id, handle_sha256, placement_id, package_id,
            spend_per_minute_micros, deadline, created_at, minute_start)
         values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()),
            coalesce($7::timestamptz, now()))
         on conflict (id) do nothing`,
        [
            a.id,
            a.handleSha256,
            a.placementId,
            a.packageId,
            a.spendPerMinuteMicros,
            a.deadline,
            a.createdAt ?? null,
        ],
    );
    return (await findAccount(db, a.id))!;
}

export async function storePlacement(
    db: Queryable,
    id: string,
    p: { handleSha256?: string; placementId: string; deadline: Date | null },
): Promise<void> {
    await db.query(
        `update x402_accounts set handle_sha256 = coalesce(handle_sha256, $2),
            placement_id = $3, deadline = $4
         where id = $1`,
        [id, p.handleSha256 ?? null, p.placementId, p.deadline],
    );
}

export type AccountFind =
    | { kind: "found"; account: AccountRow }
    | { kind: "placement"; placement: Extract<PlacementLookup, { kind: "found" }> }
    | { kind: "unknown" }
    | { kind: "unavailable" };

export async function findAccountForHandle(
    pool: pg.Pool,
    router: RouterClient,
    handleSha256: string,
    signal?: AbortSignal,
): Promise<AccountFind> {
    const known = await findAccountByHandle(pool, handleSha256);
    if (known) return { kind: "found", account: known };
    const placement = await router.lookupPlacement({ handleSha256 }, signal);
    if (placement.kind !== "found") return placement;
    if (!(await findAccount(pool, placement.startOrderId))) return { kind: "placement", placement };
    await storePlacement(pool, placement.startOrderId, {
        handleSha256,
        placementId: placement.placementId,
        deadline: placement.deadline,
    });
    return { kind: "found", account: (await findAccount(pool, placement.startOrderId))! };
}

export async function startClosing(
    c: pg.PoolClient,
    accountId: string,
    at: Date,
): Promise<boolean> {
    const res = await c.query(
        "update x402_accounts set state = 'closing', closing_at = $2 where id = $1 and state = 'open'",
        [accountId, at],
    );
    return res.rowCount === 1;
}

export function leftMicros(a: AccountRow): number {
    return a.fundedMicros - a.spentMicros - a.heldMicros - a.refundedMicros - a.keptMicros;
}

export async function ceilingUsedMicros(db: Queryable, accountId: string): Promise<number> {
    const res = await db.query<{ used: string }>(
        `select coalesce(sum(allowance_micros - fee_credited_micros), 0) as used
         from x402_fundings where account_id = $1 and voided_at is null`,
        [accountId],
    );
    return Number(res.rows[0]!.used);
}

export async function feeDue(db: Queryable, accountId: string | null): Promise<boolean> {
    if (accountId === null) return true;
    const res = await db.query(
        `select 1 from x402_fundings f join orders o on o.id = f.order_id
         where f.account_id = $1 and f.voided_at is null and o.fee_micros > 0 limit 1`,
        [accountId],
    );
    return res.rows.length === 0;
}

export async function isFirstUse(db: Queryable, payer: string, orderId: string): Promise<boolean> {
    const res = await db.query(
        "select 1 from x402_payers where payer = $1 and first_order_id = $2",
        [payer, orderId],
    );
    return res.rows.length === 1;
}

export async function insertFirstUse(
    c: pg.PoolClient,
    payer: string,
    orderId: string,
    at: Date,
): Promise<void> {
    await c.query(
        `insert into x402_payers (payer, first_order_id, first_funded_at) values ($1, $2, $3)
         on conflict do nothing`,
        [payer, orderId, at],
    );
}

export interface PoolCounters {
    committedMicros: number;
    unpaidMicros: number;
}

export async function readPool(db: Queryable): Promise<PoolCounters> {
    const res = await db.query<{ committed_micros: string; unpaid_micros: string }>(
        "select committed_micros, unpaid_micros from x402_pool where id = 1",
    );
    return counters(res.rows[0]!);
}

function counters(r: { committed_micros: string | number; unpaid_micros: string | number }) {
    return { committedMicros: Number(r.committed_micros), unpaidMicros: Number(r.unpaid_micros) };
}

function alarmIfHigh(before: number, after: PoolCounters, x402: Settings["x402"], log: Log): void {
    const threshold = Math.floor((x402.pool_max_micros * x402.pool_high_alarm_percent) / 100);
    const total = after.committedMicros + after.unpaidMicros;
    if (before <= threshold && total > threshold) {
        log.alarm("x402_pool_high", {
            committedMicros: after.committedMicros,
            unpaidMicros: after.unpaidMicros,
        });
    }
}

export async function reserveUnpaid(
    c: pg.PoolClient,
    micros: number,
    x402: Settings["x402"],
    log: Log,
): Promise<boolean> {
    const res = await c.query<{ committed_micros: string; unpaid_micros: string }>(
        `update x402_pool set unpaid_micros = unpaid_micros + $1
         where id = 1 and unpaid_micros + $1 <= $2 and committed_micros + unpaid_micros + $1 <= $3
         returning committed_micros, unpaid_micros`,
        [micros, x402.pool_unpaid_max_micros, x402.pool_max_micros],
    );
    if (res.rows.length !== 1) return false;
    const after = counters(res.rows[0]!);
    alarmIfHigh(after.committedMicros + after.unpaidMicros - micros, after, x402, log);
    return true;
}

// A move that would take a counter below 0 fails the column check (23514) and is not caught.
export async function movePool(
    c: pg.PoolClient,
    delta: { unpaid?: number; committed?: number },
    x402: Settings["x402"],
    log: Log,
): Promise<PoolCounters> {
    const unpaid = delta.unpaid ?? 0;
    const committed = delta.committed ?? 0;
    const res = await c.query<{ committed_micros: string; unpaid_micros: string }>(
        `update x402_pool set unpaid_micros = unpaid_micros + $1,
            committed_micros = committed_micros + $2
         where id = 1 returning committed_micros, unpaid_micros`,
        [unpaid, committed],
    );
    const after = counters(res.rows[0]!);
    alarmIfHigh(after.committedMicros + after.unpaidMicros - unpaid - committed, after, x402, log);
    return after;
}

export async function voidConditionsHold(
    c: pg.PoolClient,
    account: AccountRow,
    triggerDeadline?: Date | null,
): Promise<boolean> {
    if (triggerDeadline instanceof Date) return false;
    if (account.refundedMicros > 0 || account.keptMicros > 0) return false;
    const used = await c.query(
        `select 1 from x402_payments where account_id = $1
         union all
         select 1 from events
         where payload->>'order_id' = $1 and payload->>'deadline' is not null
         limit 1`,
        [account.id],
    );
    return used.rows.length === 0;
}

export async function placementEnded(db: Queryable, startOrderId: string): Promise<boolean> {
    const res = await db.query(
        `select 1 from events where payload->>'order_id' = $1
            and type in ('placement.terminated', 'placement.failed') limit 1`,
        [startOrderId],
    );
    return res.rows.length === 1;
}
