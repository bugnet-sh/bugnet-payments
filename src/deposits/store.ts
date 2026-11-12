/**
 * Row access for deposits and their transfers, moves, holds and shares (spec 5, 6.1, 7).
 *
 * A deposit row holds only public data: the address, its token account, the key version and the
 * salt. The key is derived again from the seed whenever a move is signed.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Settings } from "../config.ts";
import type { Queryable } from "../db/pool.ts";
import type { OrderRow } from "../orders/types.ts";
import { type RefundDbRow, type RefundRow, toRefund } from "../refunds/request.ts";
import type { DepositKeys } from "./keys.ts";
import { moveFeeLamports } from "./moves.ts";
import { createAndCloseLamports } from "./plan.ts";
import type {
    DepositRow,
    HoldRow,
    MoveRow,
    NewMove,
    NewTransfer,
    ShareRow,
    TransferOutcome,
    TransferReason,
    TransferRow,
} from "./types.ts";

type Int8 = string | number | bigint;

interface DepositDbRow extends pg.QueryResultRow {
    order_id: string;
    address: string;
    token_account: string;
    key_version: number;
    salt: Buffer;
    state: DepositRow["state"];
    balance_micros: Int8;
    last_signature: string | null;
    scan_slot: Int8 | null;
    scan_top: string | null;
    scan_before: string | null;
    rent_payer: string | null;
    viewer_key: string | null;
    viewer_block: string | null;
    review_reason: DepositRow["reviewReason"];
    hold_reason: DepositRow["holdReason"];
    moves_failing_reset_at: Date | null;
    recheck_at: Date | null;
    expiry_due_at: Date | null;
    hard_stop_at: Date | null;
    expiry_min_slot: Int8 | null;
    close_separately: boolean;
    close_failures: number;
    close_after: Date | null;
    stable_since: Date | null;
    late_returns: number;
    created_at: Date;
    ready_at: Date | null;
    checked_at: Date | null;
    checked_slot: Int8 | null;
    settled_at: Date | null;
    closed_at: Date | null;
    watch_until: Date | null;
}

interface TransferDbRow extends pg.QueryResultRow {
    order_id: string;
    signature: string;
    slot: Int8;
    seq: number;
    block_time: Date;
    seen_at: Date;
    amount_micros: Int8;
    source_token_account: string | null;
    source_owner: string | null;
    source_balance_micros: Int8 | null;
    outcome: TransferOutcome;
    applied_micros: Int8;
    reason: TransferReason | null;
    blocked_until: Date | null;
    move_id: Int8 | null;
    refund_id: Int8 | null;
}

interface MoveDbRow extends pg.QueryResultRow {
    id: Int8;
    order_id: string;
    kind: MoveRow["kind"];
    amount_micros: Int8;
    keep_micros: Int8;
    held_micros: Int8;
    destination: string | null;
    payer: string | null;
    memo: string | null;
    closes: boolean;
    close_to: string | null;
    state: MoveRow["state"];
    tx_signature: string | null;
    wire_tx: string | null;
    last_valid_block_height: Int8 | null;
    previous_signatures: string[];
    attempts: number;
    landed_slot: Int8 | null;
    expiry_seen_slot: Int8 | null;
    preflight_refused_at: Date | null;
    manual_reason: string | null;
    created_at: Date;
    signed_at: Date | null;
    sent_at: Date | null;
    confirmed_at: Date | null;
    failed_at: Date | null;
}

interface ShareDbRow extends pg.QueryResultRow {
    order_id: string;
    part: number;
    owner: string;
    source_token_account: string;
    applied_micros: Int8;
}

interface HoldDbRow extends pg.QueryResultRow {
    order_id: string;
    owner: string;
    reason: HoldRow["reason"];
    recheck_at: Date;
    since: Date;
}

const big = (v: Int8 | null): bigint | null => (v === null ? null : BigInt(v));
const num = (v: Int8 | null): number | null => (v === null ? null : Number(v));
const int8 = (v: bigint | null): string | null => (v === null ? null : v.toString());

function toDeposit(r: DepositDbRow): DepositRow {
    return {
        orderId: r.order_id,
        address: r.address,
        tokenAccount: r.token_account,
        keyVersion: r.key_version,
        salt: r.salt,
        state: r.state,
        balanceMicros: BigInt(r.balance_micros),
        lastSignature: r.last_signature,
        scanSlot: big(r.scan_slot),
        scanTop: r.scan_top,
        scanBefore: r.scan_before,
        rentPayer: r.rent_payer,
        viewerKey: r.viewer_key,
        viewerBlock: r.viewer_block,
        reviewReason: r.review_reason,
        holdReason: r.hold_reason,
        movesFailingResetAt: r.moves_failing_reset_at,
        recheckAt: r.recheck_at,
        expiryDueAt: r.expiry_due_at,
        hardStopAt: r.hard_stop_at,
        expiryMinSlot: big(r.expiry_min_slot),
        closeSeparately: r.close_separately,
        closeFailures: r.close_failures,
        closeAfter: r.close_after,
        stableSince: r.stable_since,
        lateReturns: r.late_returns,
        createdAt: r.created_at,
        readyAt: r.ready_at,
        checkedAt: r.checked_at,
        checkedSlot: big(r.checked_slot),
        settledAt: r.settled_at,
        closedAt: r.closed_at,
        watchUntil: r.watch_until,
    };
}

function toTransfer(r: TransferDbRow): TransferRow {
    return {
        orderId: r.order_id,
        signature: r.signature,
        slot: BigInt(r.slot),
        seq: r.seq,
        blockTime: r.block_time,
        seenAt: r.seen_at,
        amountMicros: Number(r.amount_micros),
        sourceTokenAccount: r.source_token_account,
        sourceOwner: r.source_owner,
        sourceBalanceMicros: big(r.source_balance_micros),
        outcome: r.outcome,
        appliedMicros: Number(r.applied_micros),
        reason: r.reason,
        blockedUntil: r.blocked_until,
        moveId: num(r.move_id),
        refundId: num(r.refund_id),
    };
}

function toMove(r: MoveDbRow): MoveRow {
    return {
        id: Number(r.id),
        orderId: r.order_id,
        kind: r.kind,
        amountMicros: Number(r.amount_micros),
        keepMicros: Number(r.keep_micros),
        heldMicros: Number(r.held_micros),
        destination: r.destination,
        payer: r.payer,
        memo: r.memo,
        closes: r.closes,
        closeTo: r.close_to,
        state: r.state,
        txSignature: r.tx_signature,
        wireTx: r.wire_tx,
        lastValidBlockHeight: big(r.last_valid_block_height),
        previousSignatures: r.previous_signatures,
        attempts: r.attempts,
        landedSlot: big(r.landed_slot),
        expirySeenSlot: big(r.expiry_seen_slot),
        preflightRefusedAt: r.preflight_refused_at,
        manualReason: r.manual_reason,
        createdAt: r.created_at,
        signedAt: r.signed_at,
        sentAt: r.sent_at,
        confirmedAt: r.confirmed_at,
        failedAt: r.failed_at,
    };
}

function toShare(r: ShareDbRow): ShareRow {
    return {
        orderId: r.order_id,
        part: r.part,
        owner: r.owner,
        sourceTokenAccount: r.source_token_account,
        appliedMicros: Number(r.applied_micros),
    };
}

function toHold(r: HoldDbRow): HoldRow {
    return {
        orderId: r.order_id,
        owner: r.owner,
        reason: r.reason,
        recheckAt: r.recheck_at,
        since: r.since,
    };
}

export async function findDeposit(db: Queryable, orderId: string): Promise<DepositRow | null> {
    const { rows } = await db.query<DepositDbRow>("select * from deposits where order_id = $1", [
        orderId,
    ]);
    return rows[0] ? toDeposit(rows[0]) : null;
}

export async function lockDeposit(c: pg.PoolClient, orderId: string): Promise<DepositRow | null> {
    const { rows } = await c.query<DepositDbRow>(
        "select * from deposits where order_id = $1 for no key update",
        [orderId],
    );
    return rows[0] ? toDeposit(rows[0]) : null;
}

// Rows are created only for an unpaid order before its deadline. The salt is drawn only when no
// row exists yet, and a racing insert keeps the row that won, so an address never changes.
export async function ensureDeposit(
    db: Queryable,
    keys: DepositKeys,
    order: OrderRow,
    now: Date,
    salt: () => Buffer = () => randomBytes(16),
): Promise<DepositRow | null> {
    if (order.state !== "unpaid" || now.getTime() >= order.expiresAt.getTime()) return null;
    const existing = await findDeposit(db, order.id);
    if (existing !== null) return existing;
    const s = salt();
    const a = await keys.address(order.id, s);
    const { rows } = await db.query<DepositDbRow>(
        `insert into deposits (order_id, address, token_account, key_version, salt, created_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (order_id) do nothing
         returning *`,
        [order.id, a.address, a.tokenAccount, a.keyVersion, s, now],
    );
    return rows[0] ? toDeposit(rows[0]) : findDeposit(db, order.id);
}

export async function findMove(db: Queryable, id: number): Promise<MoveRow | null> {
    const { rows } = await db.query<MoveDbRow>("select * from deposit_moves where id = $1", [id]);
    return rows[0] ? toMove(rows[0]) : null;
}

export async function lockMove(c: pg.PoolClient, id: number): Promise<MoveRow | null> {
    const { rows } = await c.query<MoveDbRow>(
        "select * from deposit_moves where id = $1 for no key update",
        [id],
    );
    return rows[0] ? toMove(rows[0]) : null;
}

export async function depositLedger(
    db: Queryable,
    orderId: string,
): Promise<{
    deposit: DepositRow;
    transfers: TransferRow[];
    moves: MoveRow[];
    holds: HoldRow[];
    depositRefunds: RefundRow[];
} | null> {
    const deposit = await findDeposit(db, orderId);
    if (deposit === null) return null;
    const transfers = await db.query<TransferDbRow>(
        "select * from deposit_transfers where order_id = $1 order by slot, seq, signature",
        [orderId],
    );
    const moves = await db.query<MoveDbRow>(
        "select * from deposit_moves where order_id = $1 order by id",
        [orderId],
    );
    const refunds = await db.query<RefundDbRow>(
        "select * from refunds where order_id = $1 and kind = 'deposit' order by part",
        [orderId],
    );
    return {
        deposit,
        transfers: transfers.rows.map(toTransfer),
        moves: moves.rows.map(toMove),
        holds: await holdsOf(db, orderId),
        depositRefunds: refunds.rows.map(toRefund),
    };
}

export async function insertTransfers(
    c: pg.PoolClient,
    orderId: string,
    rows: readonly (NewTransfer & { outcome?: "review"; reason?: "unreadable" })[],
): Promise<number> {
    let inserted = 0;
    for (const t of rows) {
        const res = await c.query(
            `insert into deposit_transfers (order_id, signature, slot, seq, block_time, seen_at,
                amount_micros, source_token_account, source_owner, source_balance_micros, outcome,
                reason)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             on conflict (order_id, signature) do nothing`,
            [
                orderId,
                t.signature,
                t.slot.toString(),
                t.seq,
                t.blockTime,
                t.seenAt,
                t.amountMicros,
                t.sourceTokenAccount,
                t.sourceOwner,
                int8(t.sourceBalanceMicros),
                t.outcome ?? "open",
                t.reason ?? null,
            ],
        );
        inserted += res.rowCount ?? 0;
    }
    return inserted;
}

// A null cursor keeps last_signature and scan_slot and only stores an unfinished listing
export async function moveCursor(
    c: pg.PoolClient,
    orderId: string,
    cursor: { signature: string; slot: bigint } | null,
    listing: { top: string | null; before: string | null },
): Promise<void> {
    if (cursor === null) {
        await c.query("update deposits set scan_top = $2, scan_before = $3 where order_id = $1", [
            orderId,
            listing.top,
            listing.before,
        ]);
        return;
    }
    await c.query(
        `update deposits set last_signature = $2, scan_slot = $3, scan_top = $4, scan_before = $5
         where order_id = $1`,
        [orderId, cursor.signature, cursor.slot.toString(), listing.top, listing.before],
    );
}

export async function insertMove(
    c: pg.PoolClient,
    m: NewMove,
    transfers: readonly string[],
    now: Date,
): Promise<MoveRow> {
    const { rows } = await c.query<MoveDbRow>(
        `insert into deposit_moves (order_id, kind, amount_micros, keep_micros, held_micros,
            destination, payer, memo, closes, close_to, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning *`,
        [
            m.orderId,
            m.kind,
            m.amountMicros,
            m.keepMicros,
            m.heldMicros,
            m.destination,
            m.payer,
            m.memo,
            m.closes,
            m.closeTo,
            now,
        ],
    );
    const move = toMove(rows[0]!);
    const carried = [...new Set(transfers)];
    if (carried.length > 0) {
        const res = await c.query(
            `update deposit_transfers set move_id = $3
             where order_id = $1 and signature = any($2::text[])`,
            [m.orderId, carried, move.id],
        );
        if (res.rowCount !== carried.length) {
            throw new Error(`move ${move.id} names a transfer the deposit does not hold`);
        }
    }
    return move;
}

/**
 * The planner reads the ledger without a lock. A step it plans checks under the deposit lock that
 * no transfer changed since that read, so an operator's return-to that committed in between is
 * never carried by a stale move or overwritten by a stale outcome (spec 17); the tick plans again.
 */
export async function transfersChanged(
    c: pg.PoolClient,
    orderId: string,
    read: readonly TransferRow[],
): Promise<boolean> {
    const { rows } = await c.query<TransferDbRow>(
        "select * from deposit_transfers where order_id = $1",
        [orderId],
    );
    if (rows.length !== read.length) return true;
    const before = new Map(read.map((t) => [t.signature, t]));
    return rows.map(toTransfer).some((t) => {
        const b = before.get(t.signature);
        return (
            b === undefined ||
            b.outcome !== t.outcome ||
            b.reason !== t.reason ||
            b.appliedMicros !== t.appliedMicros ||
            b.moveId !== t.moveId ||
            b.refundId !== t.refundId ||
            b.sourceTokenAccount !== t.sourceTokenAccount ||
            b.sourceOwner !== t.sourceOwner
        );
    });
}

// Only a never-signed pending row may go: a signed one may still land
export async function deletePendingMove(c: pg.PoolClient, moveId: number): Promise<boolean> {
    const { rows } = await c.query<{ order_id: string }>(
        `delete from deposit_moves
         where id = $1 and state = 'pending' and tx_signature is null
            and previous_signatures = '{}'
         returning order_id`,
        [moveId],
    );
    if (rows[0] === undefined) return false;
    await c.query(
        "update deposit_transfers set move_id = null where order_id = $1 and move_id = $2",
        [rows[0].order_id, moveId],
    );
    return true;
}

export async function setTransferOutcomes(
    c: pg.PoolClient,
    orderId: string,
    rows: readonly {
        signature: string;
        outcome: TransferOutcome;
        reason: TransferReason | null;
        appliedMicros?: number;
        moveId?: number | null;
        blockedUntil?: Date | null;
    }[],
): Promise<void> {
    for (const r of rows) {
        const set = ["outcome = $3", "reason = $4"];
        const values: unknown[] = [orderId, r.signature, r.outcome, r.reason];
        const optional: [string, unknown][] = [
            ["applied_micros", r.appliedMicros],
            ["move_id", r.moveId],
            ["blocked_until", r.blockedUntil],
        ];
        for (const [col, value] of optional) {
            if (value === undefined) continue;
            values.push(value);
            set.push(`${col} = $${values.length}`);
        }
        const res = await c.query(
            `update deposit_transfers set ${set.join(", ")}
             where order_id = $1 and signature = $2`,
            values,
        );
        if (res.rowCount === 0) throw new Error(`no transfer ${r.signature} on ${orderId}`);
    }
}

type DepositUpdate = Partial<
    Omit<DepositRow, "orderId" | "address" | "tokenAccount" | "keyVersion" | "salt">
>;

const DEPOSIT_COLUMNS: Record<keyof DepositUpdate, string> = {
    state: "state",
    balanceMicros: "balance_micros",
    lastSignature: "last_signature",
    scanSlot: "scan_slot",
    scanTop: "scan_top",
    scanBefore: "scan_before",
    rentPayer: "rent_payer",
    viewerKey: "viewer_key",
    viewerBlock: "viewer_block",
    reviewReason: "review_reason",
    holdReason: "hold_reason",
    movesFailingResetAt: "moves_failing_reset_at",
    recheckAt: "recheck_at",
    expiryDueAt: "expiry_due_at",
    hardStopAt: "hard_stop_at",
    expiryMinSlot: "expiry_min_slot",
    closeSeparately: "close_separately",
    closeFailures: "close_failures",
    closeAfter: "close_after",
    stableSince: "stable_since",
    lateReturns: "late_returns",
    createdAt: "created_at",
    readyAt: "ready_at",
    checkedAt: "checked_at",
    checkedSlot: "checked_slot",
    settledAt: "settled_at",
    closedAt: "closed_at",
    watchUntil: "watch_until",
};

export async function updateDeposit(
    c: Queryable,
    orderId: string,
    f: DepositUpdate,
): Promise<void> {
    const set: string[] = [];
    const values: unknown[] = [orderId];
    for (const [key, value] of Object.entries(f)) {
        if (value === undefined) continue;
        const col = DEPOSIT_COLUMNS[key as keyof DepositUpdate];
        if (col === undefined) throw new Error(`unknown deposit field ${key}`);
        values.push(typeof value === "bigint" ? value.toString() : value);
        set.push(`${col} = $${values.length}`);
    }
    if (set.length === 0) return;
    const res = await c.query(`update deposits set ${set.join(", ")} where order_id = $1`, values);
    if (res.rowCount === 0) throw new Error(`no deposit for ${orderId}`);
}

// Closed deposits are read every closedEveryMs for late money, and once more when their watch
// ends so the planner can mark them done. One that still holds review money then keeps the
// closed pace until a close carries it.
export async function watchedDeposits(
    db: Queryable,
    now: Date,
    closedEveryMs: number,
): Promise<DepositRow[]> {
    const { rows } = await db.query<DepositDbRow>(
        `select * from deposits
         where state in ('open', 'settling', 'draining')
            or (state = 'closed' and (checked_at is null or checked_at <= $2
                or watch_until is null or (watch_until <= $1 and checked_at < watch_until)))
         order by order_id`,
        [now, new Date(now.getTime() - closedEveryMs)],
    );
    return rows.map(toDeposit);
}

export async function insertShares(c: pg.PoolClient, rows: readonly ShareRow[]): Promise<void> {
    for (const s of rows) {
        await c.query(
            `insert into payment_shares (order_id, part, owner, source_token_account,
                applied_micros)
             values ($1, $2, $3, $4, $5)`,
            [s.orderId, s.part, s.owner, s.sourceTokenAccount, s.appliedMicros],
        );
    }
}

export async function sharesOf(db: Queryable, orderId: string): Promise<ShareRow[]> {
    const { rows } = await db.query<ShareDbRow>(
        "select * from payment_shares where order_id = $1 order by part",
        [orderId],
    );
    return rows.map(toShare);
}

export async function holdsOf(db: Queryable, orderId: string): Promise<HoldRow[]> {
    const { rows } = await db.query<HoldDbRow>(
        "select * from deposit_holds where order_id = $1 order by owner",
        [orderId],
    );
    return rows.map(toHold);
}

// A hold checked again keeps its first since, so it shows how long the owner has waited
export async function putHold(c: pg.PoolClient, h: HoldRow): Promise<void> {
    await c.query(
        `insert into deposit_holds (order_id, owner, reason, recheck_at, since)
         values ($1, $2, $3, $4, $5)
         on conflict (order_id, owner)
         do update set reason = excluded.reason, recheck_at = excluded.recheck_at`,
        [h.orderId, h.owner, h.reason, h.recheckAt, h.since],
    );
}

export async function clearHolds(c: pg.PoolClient, orderId: string): Promise<void> {
    await c.query("delete from deposit_holds where order_id = $1", [orderId]);
}

const IN_FLIGHT_SQL = "('pending', 'signed', 'sent')";

/**
 * Fees of metered moves (returns and closes that do not close to the fee payer) and of every
 * failed move since then (spec 11.5). Moves still in flight count too, so deposits planned in
 * one tick cannot together pass the budget before any of them lands.
 */
export async function meteredLamports(
    db: Queryable,
    since: Date,
    feePayer: string,
    cfg: Pick<Settings["deposits"], "compute_unit_limit" | "compute_unit_price_micro_lamports">,
): Promise<bigint> {
    const { rows } = await db.query<Pick<MoveDbRow, "kind" | "preflight_refused_at">>(
        `select kind, preflight_refused_at from deposit_moves
         where (state = 'failed' and failed_at >= $1)
            or (kind in ('return', 'close') and not (closes and close_to is not distinct from $2)
                and ((state = 'confirmed' and confirmed_at >= $1)
                    or (state in ${IN_FLIGHT_SQL} and created_at >= $1)))`,
        [since, feePayer],
    );
    let sum = 0n;
    for (const r of rows) {
        sum += moveFeeLamports({ kind: r.kind, preflightRefusedAt: r.preflight_refused_at }, cfg);
    }
    return sum;
}

// Metered returns planned for each sending owner since then
export async function ownerReturns(
    db: Queryable,
    since: Date,
    feePayer: string,
): Promise<Map<string, number>> {
    const { rows } = await db.query<{ payer: string; n: number }>(
        `select payer, count(*)::int as n from deposit_moves
         where kind = 'return' and created_at >= $1
            and not (closes and close_to is not distinct from $2)
         group by payer`,
        [since, feePayer],
    );
    return new Map(rows.map((r) => [r.payer, r.n]));
}

// Rent Bugnet paid, or is about to pay with a create in flight, on a deposit that still takes
// money; draining deposits close as soon as their returns land, so they are not counted (spec 5)
const RENTED = `d.state in ('open', 'settling')
    and (d.rent_payer = $1 or exists (select 1 from deposit_moves m
        where m.order_id = d.order_id and m.kind = 'create' and m.state in ${IN_FLIGHT_SQL}))`;

export async function rentHolding(db: Queryable, feePayer: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from deposits d where ${RENTED}`,
        [feePayer],
    );
    return rows[0]!.n;
}

export async function rentedBy(
    db: Queryable,
    viewerKey: string | null,
    viewerBlock: string | null,
    feePayer: string,
): Promise<{ ipRented: number; blockRented: number }> {
    const { rows } = await db.query<{ ip: number; block: number }>(
        `select count(*) filter (where d.viewer_key = $2)::int as ip,
            count(*) filter (where d.viewer_block = $3)::int as block
         from deposits d
         where (d.viewer_key = $2 or d.viewer_block = $3) and ${RENTED}`,
        [feePayer, viewerKey, viewerBlock],
    );
    return { ipRented: rows[0]!.ip, blockRented: rows[0]!.block };
}

// Creates since then whose deposit holds no transfer, each with the close it will need, priced
// as the planner prices the budget it compares against; a create in flight counts already, so
// viewers in one tick cannot together pass the budget
export async function unpaidCreateLamports(
    db: Queryable,
    since: Date,
    cfg: Pick<Settings["deposits"], "compute_unit_limit" | "compute_unit_price_micro_lamports">,
): Promise<bigint> {
    const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from deposit_moves m
         where m.kind = 'create'
            and ((m.state = 'confirmed' and m.confirmed_at >= $1)
                or (m.state in ${IN_FLIGHT_SQL} and m.created_at >= $1))
            and not exists (select 1 from deposit_transfers t where t.order_id = m.order_id)`,
        [since],
    );
    return BigInt(rows[0]!.n) * createAndCloseLamports(cfg);
}
