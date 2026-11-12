/**
 * The deposit planner (spec 9). It reads only its input and returns one step; the tick applies
 * it and plans again. The first rule that applies wins.
 *
 * Nothing a sender does can stop another sender's money: unattributed, late and stranger money
 * is decided per transfer, a held owner is left out of coverage, and a failing destination
 * stops only its own returns.
 */
import type { Settings } from "../config.ts";
import type { OrderRow } from "../orders/types.ts";
import { chainOrder, type Coverage, coverage } from "./coverage.ts";
import type {
    DepositHoldReason,
    DepositRow,
    HoldRow,
    MoveRow,
    MoveState,
    NewMove,
    OwnerHoldReason,
    ReviewReason,
    TransferOutcome,
    TransferReason,
    TransferRow,
} from "./types.ts";

export interface PlanInput {
    order: Pick<OrderRow, "id" | "state" | "amountMicros" | "expiresAt" | "payInto" | "kind">;
    deposit: DepositRow;
    read: {
        exists: boolean;
        micros: bigint;
        contextSlot: bigint;
        invariant: "held" | "below" | "above";
    };
    // expectedBalance at the read's slot
    expectedMicros: bigint;
    // oldest first by (slot, seq)
    transfers: readonly TransferRow[];
    moves: readonly MoveRow[];
    holds: readonly HoldRow[];
    bugnetOwners: ReadonlySet<string>;
    viewer: { seen: boolean; ipRented: number; blockRented: number };
    // open and settling deposits holding Bugnet-paid rent
    rentHolding: number;
    // lamports left in this hour's unpaid-create budget
    unpaidCreateLeft: bigint;
    // lamports left in this hour's free-move budget
    feeBudgetLeft: bigint;
    // metered returns per owner in the last hour
    ownerReturns: ReadonlyMap<string, number>;
    feePayer: string;
    now: Date;
    cfg: Pick<
        Settings["deposits"],
        | "settle_grace"
        | "refund_min_micros"
        | "max_open"
        | "rented_per_ip"
        | "rented_per_block"
        | "max_attempts"
        | "max_late_returns"
        | "busy_every"
        | "close_retry_after"
        | "returns_per_owner_per_hour"
        | "max_split_owners"
        | "compute_unit_limit"
        | "compute_unit_price_micro_lamports"
    >;
}

export interface Assignment {
    signature: string;
    outcome: TransferOutcome;
    reason: TransferReason;
}

// A paid entry is the crossing transfer: it stays paid and its rest is extra or kept
export interface SettleOther {
    signature: string;
    outcome: "return" | "keep" | "paid";
    reason: "extra" | "below_minimum";
}

export type Plan =
    | { kind: "wait" }
    // the tick sets state = 'draining'
    | { kind: "drain" }
    // clearHolds: hold_reason and every deposit_holds row
    | {
          kind: "assign";
          rows: readonly Assignment[];
          review?: ReviewReason;
          clearHolds?: boolean;
      }
    // multiSender: the token names no payer
    | {
          kind: "settle";
          owners: Coverage["owners"];
          multiSender: boolean;
          applied: ReadonlyMap<string, number>;
          extra: ReadonlyMap<string, number>;
          others: readonly SettleOther[];
          paidAt: Date;
          closes: boolean;
      }
    // pin a slot past the deadline (spec 6.6)
    | { kind: "need_slot" }
    | { kind: "expire" }
    // transfers: every transfer the move carries, held review transfers included
    | { kind: "move"; move: NewMove; transfers: string[]; lateReturn?: boolean; metered: boolean }
    // the account already exists: set ready_at
    | { kind: "ready" }
    | { kind: "closed" }
    | { kind: "done" };

const WAIT: Plan = { kind: "wait" };
const SIGNATURE_LAMPORTS = 5_000n;
const IN_FLIGHT: ReadonlySet<MoveState> = new Set(["pending", "signed", "sent"]);
const DEPOSIT_HOLD_RETURN: Record<DepositHoldReason, TransferReason> = {
    router_unavailable: "router_unavailable",
    allowance_paused: "allowance_unavailable",
};
const OWNER_HOLD_RETURN: Record<OwnerHoldReason, TransferReason> = {
    payer_busy: "payer_busy",
    payer_rate_limited: "payer_rate_limited",
    anonymous_busy: "pool_busy",
};

interface Ctx {
    i: PlanInput;
    now: number;
    deadline: number;
    graceEnd: number;
    min: number;
    moves: ReadonlyMap<number, MoveRow>;
    bySignature: ReadonlyMap<string, TransferRow>;
    sorted: readonly TransferRow[];
    open: readonly TransferRow[];
}

interface Group {
    account: string;
    payer: string;
    micros: number;
    transfers: TransferRow[];
}

interface Leftovers {
    keep: number;
    held: number;
    transfers: TransferRow[];
}

export function transferTime(t: Pick<TransferRow, "blockTime">): Date {
    return t.blockTime;
}

// What a written-off debit took from a transfer is no longer in the account (spec 23.1)
const rest = (t: TransferRow) => t.amountMicros - t.appliedMicros - t.lostMicros;
const unlost = (t: TransferRow) => t.amountMicros - t.lostMicros;
const owned = (t: TransferRow) => t.sourceOwner !== null && t.sourceTokenAccount !== null;
const late = (c: Ctx, t: TransferRow) => transferTime(t).getTime() > c.deadline;
const row = (t: TransferRow, outcome: TransferOutcome, reason: TransferReason): Assignment => ({
    signature: t.signature,
    outcome,
    reason,
});

function assign(rows: readonly Assignment[]): Plan | null {
    return rows.length === 0 ? null : { kind: "assign", rows };
}

function moveOf(
    c: Ctx,
    move: Omit<NewMove, "orderId">,
    transfers: readonly TransferRow[],
    metered: boolean,
    lateReturn = false,
): Plan {
    const plan: Plan = {
        kind: "move",
        move: { orderId: c.i.order.id, ...move },
        transfers: transfers.map((t) => t.signature),
        metered,
    };
    return lateReturn ? { ...plan, lateReturn } : plan;
}

// Money in a confirmed move has left the deposit; a failed move's money is still there
function carried(c: Ctx, t: TransferRow): boolean {
    return t.moveId !== null && c.moves.get(t.moveId)?.state === "confirmed";
}

function owed(c: Ctx, t: TransferRow): boolean {
    if (rest(t) <= 0 || carried(c, t)) return false;
    return t.outcome === "return" || (t.outcome === "paid" && t.reason !== "below_minimum");
}

// An x402 payment in flight may still revert to unpaid, and the deposit may then pay (spec 8.1)
function takesMoney(c: Ctx): boolean {
    const { order, deposit } = c.i;
    if (order.state === "unpaid") return c.now < c.deadline;
    return order.state === "settling" && deposit.settledAt === null;
}

// The write-off of a settling payment's money failed its sweep for good (spec 23.1)
function writtenOff(c: Ctx): boolean {
    return c.i.moves.some((m) => m.kind === "sweep" && m.manualReason === "written_off");
}

function finished(c: Ctx): boolean {
    return c.i.order.state !== "unpaid" && c.i.order.state !== "settling";
}

function meterAllows(c: Ctx, payer: string | null): boolean {
    if (c.i.feeBudgetLeft <= 0n) return false;
    if (payer === null) return true;
    return (c.i.ownerReturns.get(payer) ?? 0) < c.i.cfg.returns_per_owner_per_hour;
}

// The unpaid-create budget counts a create together with the close it will need (spec 5)
export function createAndCloseLamports(
    cfg: Pick<Settings["deposits"], "compute_unit_limit" | "compute_unit_price_micro_lamports">,
): bigint {
    const units = BigInt(cfg.compute_unit_limit) * BigInt(cfg.compute_unit_price_micro_lamports);
    const priority = (units + 999_999n) / 1_000_000n;
    return SIGNATURE_LAMPORTS * 3n + priority * 2n;
}

function context(i: PlanInput): Ctx {
    const sorted = [...i.transfers].sort(chainOrder);
    const deadline = i.order.expiresAt.getTime();
    return {
        i,
        now: i.now.getTime(),
        deadline,
        graceEnd: deadline + i.cfg.settle_grace,
        min: i.cfg.refund_min_micros,
        moves: new Map(i.moves.map((m) => [m.id, m])),
        bySignature: new Map(sorted.map((t) => [t.signature, t])),
        sorted,
        open: sorted.filter((t) => t.outcome === "open"),
    };
}

function coverOf(c: Ctx): Coverage {
    const { order, holds, cfg } = c.i;
    const owners = new Map<string, OwnerHoldReason>();
    let shared = false;
    for (const h of holds) {
        if (h.recheckAt.getTime() <= c.now) continue;
        if (h.owner === "") shared = true;
        else owners.set(h.owner, h.reason);
    }
    return coverage(order.amountMicros, c.sorted, order.expiresAt, { owners, shared }, cfg);
}

// Rule 3
function attribution(c: Ctx): Plan | null {
    const rows: Assignment[] = [];
    for (const t of c.open) {
        if (!owned(t)) rows.push(row(t, "review", "unattributed"));
        else if (c.i.bugnetOwners.has(t.sourceOwner!)) rows.push(row(t, "review", "from_bugnet"));
    }
    return assign(rows);
}

// Each late return costs Bugnet a fee a stranger can trigger, so they are capped (spec 6.7)
function capped(c: Ctx, t: TransferRow, reason: TransferReason): Assignment {
    const { deposit, cfg } = c.i;
    const limited =
        (reason === "late" || reason === "after_paid") &&
        (deposit.state === "closed" || deposit.state === "draining") &&
        deposit.lateReturns >= cfg.max_late_returns;
    return limited ? row(t, "review", "late_limit") : row(t, "return", reason);
}

// Rule 4
function pastDeadline(c: Ctx): Plan | null {
    if (c.i.order.state !== "unpaid") return null;
    return assign(c.open.filter((t) => late(c, t)).map((t) => capped(c, t, "late")));
}

function holdCovers(c: Ctx, t: TransferRow): boolean {
    if (c.i.deposit.holdReason !== null) return true;
    return c.i.holds.some((h) => h.owner === "" || h.owner === t.sourceOwner);
}

// Rule 5
function notPayable(c: Ctx): Plan | null {
    const { order, deposit } = c.i;
    if (order.state === "unpaid" || c.open.length === 0) return null;
    if (order.state === "settling" && deposit.settledAt === null) return WAIT;
    const rows: Assignment[] = [];
    for (const t of c.open) {
        const isLate = late(c, t);
        if (order.state === "expired") {
            // Rule 9 returns held money with its hold's reason
            if (!isLate && holdCovers(c, t)) continue;
            rows.push(capped(c, t, isLate ? "late" : "unpaid"));
        } else if (deposit.settledAt !== null) {
            rows.push(capped(c, t, isLate ? "late" : "after_paid"));
        } else {
            rows.push(row(t, "return", "paid_otherwise"));
        }
    }
    return assign(rows);
}

// Rule 7. A failed move that carried CloseAccount only makes later moves close separately. Sweeps
// that failed before an operator's retry no longer count.
function failingMoves(c: Ctx): Plan | null {
    const { moves, cfg, deposit } = c.i;
    const failed = moves.filter((m) => m.state === "failed" && !m.closes);
    const sweepsConfirmed = moves.some((m) => m.kind === "sweep" && m.state === "confirmed");
    const reset = deposit.movesFailingResetAt?.getTime() ?? null;
    const failedSweeps = failed.filter(
        (m) => m.kind === "sweep" && (reset === null || m.createdAt.getTime() > reset),
    ).length;
    if (!sweepsConfirmed && !writtenOff(c) && failedSweeps >= cfg.max_attempts) {
        return { kind: "assign", rows: [], review: "moves_failing" };
    }
    const perDestination = new Map<string, number>();
    for (const m of failed) {
        if (m.kind !== "return" || m.destination === null) continue;
        perDestination.set(m.destination, (perDestination.get(m.destination) ?? 0) + 1);
    }
    const stopped = new Set(
        [...perDestination].filter(([, n]) => n >= cfg.max_attempts).map(([d]) => d),
    );
    if (stopped.size === 0) return null;
    return assign(
        c.sorted
            .filter((t) => owed(c, t) && stopped.has(t.sourceTokenAccount ?? ""))
            .map((t) => row(t, "review", "return_failed")),
    );
}

// A sweep carries CloseAccount only when it empties the account and the creator is known
function sweepCloses(c: Ctx, amountMicros: number): boolean {
    const { read, deposit } = c.i;
    return (
        read.invariant === "held" &&
        read.micros === BigInt(amountMicros) &&
        !deposit.closeSeparately &&
        deposit.rentPayer !== null
    );
}

// Rule 8. Settle and CheckPayer never run again: the payments row follows the new sweep.
function sweepAgain(c: Ctx): Plan | null {
    const { deposit, moves } = c.i;
    if (deposit.state !== "settling" || writtenOff(c)) return null;
    const sweeps = moves.filter((m) => m.kind === "sweep");
    if (sweeps.some((m) => m.state === "confirmed")) return null;
    const latest = sweeps.reduce<MoveRow | undefined>(
        (a, m) => (a === undefined || m.id > a.id ? m : a),
        undefined,
    );
    if (latest?.state !== "failed") return null;
    const closes = sweepCloses(c, latest.amountMicros);
    return moveOf(
        c,
        {
            kind: "sweep",
            amountMicros: latest.amountMicros,
            keepMicros: 0,
            heldMicros: 0,
            destination: latest.destination,
            payer: null,
            memo: latest.memo,
            closes,
            closeTo: closes ? deposit.rentPayer : null,
        },
        [],
        false,
    );
}

// The owners a shared payment would take, as coverage picks them, without the owners held alone
function sharedSet(c: Ctx, heldAlone: ReadonlyMap<string, OwnerHoldReason>): Set<string> {
    const sums = new Map<string, number>();
    for (const t of c.open) {
        if (late(c, t) || heldAlone.has(t.sourceOwner!)) continue;
        sums.set(t.sourceOwner!, (sums.get(t.sourceOwner!) ?? 0) + unlost(t));
    }
    const set = new Set<string>();
    for (const [owner, sum] of sums) {
        if (sum >= c.min && set.size < c.i.cfg.max_split_owners) set.add(owner);
    }
    return set;
}

function holdWaits(c: Ctx): boolean {
    const { deposit } = c.i;
    return (
        deposit.holdReason !== null &&
        deposit.recheckAt !== null &&
        deposit.recheckAt.getTime() > c.now
    );
}

// Rule 9. An owner's row does not stop planning: coverage leaves that owner out until recheck_at.
function holdsEnd(c: Ctx): Plan | null {
    const { order, deposit, holds } = c.i;
    if (deposit.holdReason === null && holds.length === 0) return null;
    const ended = c.now >= c.graceEnd && (order.state === "unpaid" || order.state === "expired");
    if (!ended) return order.state === "unpaid" && holdWaits(c) ? WAIT : null;

    const alone = new Map(holds.filter((h) => h.owner !== "").map((h) => [h.owner, h.reason]));
    const pool = holds.some((h) => h.owner === "") ? sharedSet(c, alone) : new Set<string>();
    const rows: Assignment[] = [];
    for (const t of c.open) {
        if (late(c, t)) continue;
        const owner = t.sourceOwner!;
        let reason: TransferReason | null = null;
        if (deposit.holdReason !== null) reason = DEPOSIT_HOLD_RETURN[deposit.holdReason];
        else if (alone.has(owner)) reason = OWNER_HOLD_RETURN[alone.get(owner)!];
        else if (pool.has(owner)) reason = OWNER_HOLD_RETURN.anonymous_busy;
        if (reason !== null) rows.push(row(t, "return", reason));
    }
    return { kind: "assign", rows, clearHolds: true };
}

// Rule 10
function expiry(c: Ctx, cov: Coverage): Plan | null {
    const { order, deposit, read } = c.i;
    if (order.state !== "unpaid" || c.now < c.deadline || cov.mode !== "short") return null;
    if (c.now >= c.graceEnd && deposit.expiryMinSlot === null) return { kind: "need_slot" };
    const checked =
        read.invariant === "held" &&
        deposit.checkedAt !== null &&
        deposit.checkedAt.getTime() >= c.graceEnd &&
        deposit.expiryMinSlot !== null &&
        deposit.checkedSlot !== null &&
        deposit.checkedSlot >= deposit.expiryMinSlot;
    return checked ? { kind: "expire" } : WAIT;
}

// Not-applied transfers and the crossing rest, grouped per source account; dust owners are kept
function settleOthers(c: Ctx, cov: Coverage): SettleOther[] {
    const groups = new Map<string, { micros: number; members: TransferRow[] }>();
    const add = (t: TransferRow, micros: number) => {
        const g = groups.get(t.sourceTokenAccount!) ?? { micros: 0, members: [] };
        g.micros += micros;
        g.members.push(t);
        groups.set(t.sourceTokenAccount!, g);
    };
    for (const signature of cov.notApplied) {
        const t = c.bySignature.get(signature)!;
        add(t, unlost(t));
    }
    for (const [signature, micros] of cov.extra) add(c.bySignature.get(signature)!, micros);

    const others = new Map<string, SettleOther>();
    for (const signature of cov.dust) {
        others.set(signature, { signature, outcome: "keep", reason: "below_minimum" });
    }
    for (const g of groups.values()) {
        const small = g.micros < c.min;
        for (const t of g.members) {
            const outcome = cov.applied.has(t.signature) ? "paid" : small ? "keep" : "return";
            const reason = small ? "below_minimum" : "extra";
            others.set(t.signature, { signature: t.signature, outcome, reason });
        }
    }
    return c.sorted.filter((t) => others.has(t.signature)).map((t) => others.get(t.signature)!);
}

// Rule 11
function settle(c: Ctx, cov: Coverage): Plan | null {
    const { order, deposit } = c.i;
    if (order.state !== "unpaid" || deposit.settledAt !== null || deposit.reviewReason !== null) {
        return null;
    }
    if (holdWaits(c) || cov.mode === "short" || cov.crossing === null) return null;
    return {
        kind: "settle",
        owners: cov.owners,
        multiSender: cov.owners.length > 1,
        applied: cov.applied,
        extra: cov.extra,
        others: settleOthers(c, cov),
        paidAt: transferTime(cov.crossing),
        closes: sweepCloses(c, order.amountMicros),
    };
}

// Kept dust and held review money still in the account, which only a closing move carries
function leftovers(c: Ctx): Leftovers {
    const out: Leftovers = { keep: 0, held: 0, transfers: [] };
    for (const t of c.sorted) {
        if (rest(t) <= 0 || carried(c, t)) continue;
        if (t.outcome === "keep" || (t.outcome === "paid" && t.reason === "below_minimum")) {
            out.keep += rest(t);
        } else if (t.outcome === "review") {
            out.held += rest(t);
        } else {
            continue;
        }
        out.transfers.push(t);
    }
    return out;
}

// Owed money per source account, the group of the oldest transfer first
function owedGroups(c: Ctx): Group[] {
    const groups = new Map<string, Group>();
    for (const t of c.sorted) {
        if (!owed(c, t) || !owned(t)) continue;
        const account = t.sourceTokenAccount!;
        const g = groups.get(account) ?? {
            account,
            payer: t.sourceOwner!,
            micros: 0,
            transfers: [],
        };
        g.micros += rest(t);
        g.transfers.push(t);
        groups.set(account, g);
    }
    return [...groups.values()];
}

// Rule 12
function moveMoney(c: Ctx): Plan | null {
    const { deposit, read, feePayer } = c.i;
    const groups = owedGroups(c);
    const dust = new Set<TransferRow>();
    for (const t of c.sorted) {
        const review = t.outcome === "review" && !carried(c, t);
        if (review && rest(t) > 0 && rest(t) < c.min) dust.add(t);
    }
    for (const g of groups) {
        if (g.micros < c.min) for (const t of g.transfers) dust.add(t);
    }
    if (dust.size > 0) {
        return assign(
            c.sorted
                .filter((t) => dust.has(t))
                .map((t) => row(t, t.outcome === "paid" ? "paid" : "keep", "below_minimum")),
        );
    }
    if (groups.length === 0) return null;

    const left = leftovers(c);
    const closable = !takesMoney(c) && !deposit.closeSeparately && deposit.rentPayer !== null;
    for (const g of groups) {
        const closes = closable && read.micros === BigInt(g.micros + left.keep + left.held);
        const closeTo = closes ? deposit.rentPayer : null;
        // A close to the fee payer returns more rent than its fee
        const metered = !(closes && closeTo === feePayer);
        if (metered && !meterAllows(c, g.payer)) continue;
        return moveOf(
            c,
            {
                kind: "return",
                amountMicros: g.micros,
                keepMicros: closes ? left.keep : 0,
                heldMicros: closes ? left.held : 0,
                destination: g.account,
                payer: g.payer,
                memo: `bugnet-return ${c.i.order.id}`,
                closes,
                closeTo,
            },
            closes ? [...g.transfers, ...left.transfers] : g.transfers,
            metered,
            deposit.state === "closed",
        );
    }
    return WAIT;
}

// Rule 13
function closeAccount(c: Ctx): Plan | null {
    const { deposit, read, feePayer, cfg } = c.i;
    if (!finished(c) || !read.exists || deposit.readyAt === null || deposit.rentPayer === null) {
        return null;
    }
    const left = leftovers(c);
    if (read.micros !== BigInt(left.keep + left.held)) return null;
    // A stranger who opened a closed account again with only dust gets no transaction (spec 6.7)
    if (deposit.state === "closed" && left.held === 0) return null;
    if (deposit.stableSince === null || c.now - deposit.stableSince.getTime() < cfg.busy_every) {
        return null;
    }
    if (deposit.closeAfter !== null && deposit.closeAfter.getTime() > c.now) return null;
    const metered = deposit.rentPayer !== feePayer;
    if (metered && !meterAllows(c, null)) return WAIT;
    return moveOf(
        c,
        {
            kind: "close",
            amountMicros: 0,
            keepMicros: left.keep,
            heldMicros: left.held,
            destination: null,
            payer: null,
            memo: null,
            closes: true,
            closeTo: deposit.rentPayer,
        },
        left.transfers,
        metered,
    );
}

// Rule 14. Review money still in the account keeps a closed deposit watched until a close
// carries it to the float: a done deposit is never read again, so nothing could move it (spec 5)
function closedOrDone(c: Ctx): Plan | null {
    const { deposit, read } = c.i;
    if (deposit.state === "closed") {
        const over = deposit.watchUntil !== null && c.now >= deposit.watchUntil.getTime();
        return over && leftovers(c).held === 0 ? { kind: "done" } : null;
    }
    return finished(c) && !read.exists ? { kind: "closed" } : null;
}

// Rule 15. Creates are bounded by their own caps, so they are never metered.
function createAccount(c: Ctx): Plan | null {
    const { deposit, read, viewer, cfg, moves } = c.i;
    if (deposit.readyAt !== null) return null;
    if (read.exists) return { kind: "ready" };
    if (deposit.state !== "open" || c.now >= c.deadline || !viewer.seen) return null;
    if (c.i.rentHolding >= cfg.max_open) return null;
    if (viewer.ipRented >= cfg.rented_per_ip || viewer.blockRented >= cfg.rented_per_block) {
        return null;
    }
    if (c.i.unpaidCreateLeft < createAndCloseLamports(cfg)) return null;
    const failed = moves.filter((m) => m.kind === "create" && m.state === "failed").length;
    if (failed >= cfg.max_attempts) return null;
    return moveOf(
        c,
        {
            kind: "create",
            amountMicros: 0,
            keepMicros: 0,
            heldMicros: 0,
            destination: null,
            payer: null,
            memo: null,
            closes: false,
            closeTo: null,
        },
        [],
        false,
    );
}

export function planDeposit(i: PlanInput): Plan {
    const { deposit, order, read } = i;
    if (deposit.state === "done") return WAIT;
    // An open deposit stops taking money as soon as its order does (spec 8.1)
    const drains =
        deposit.state === "open" && order.state !== "unpaid" && order.state !== "settling";
    if (drains) return { kind: "drain" };
    // Rules 1 and 2
    if (i.moves.some((m) => IN_FLIGHT.has(m.state))) return WAIT;
    if (read.invariant === "below") return WAIT;

    const c = context(i);
    const assigned = attribution(c) ?? pastDeadline(c) ?? notPayable(c);
    if (assigned !== null) return assigned;

    const cov = coverOf(c);
    // Rule 6: review stops moves, never the order's expiry
    if (deposit.reviewReason !== null) {
        return read.invariant === "held" ? (expiry(c, cov) ?? WAIT) : WAIT;
    }
    // Unrecorded money may only settle, and the sweep then never closes
    if (read.invariant === "above") return settle(c, cov) ?? WAIT;

    return (
        failingMoves(c) ??
        sweepAgain(c) ??
        holdsEnd(c) ??
        expiry(c, cov) ??
        settle(c, cov) ??
        moveMoney(c) ??
        closeAccount(c) ??
        closedOrDone(c) ??
        createAccount(c) ??
        WAIT
    );
}
