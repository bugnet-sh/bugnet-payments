/**
 * The live deposit status (spec 8.3 and 14.1) and the summary publicState reads (spec 8.4).
 *
 * Everything here reads the database only, so the status route never makes an RPC call. The
 * amount asked for is the price minus the largest single owner's money, so a stranger's transfer
 * never lowers it; other owners' money is its own line.
 */
import type { Settings } from "../config.ts";
import type { Queryable } from "../db/pool.ts";
import type { OrderRow, OrderState } from "../orders/types.ts";
import type { RefundRow } from "../refunds/request.ts";
import { chainOrder, type Coverage, coverage } from "./coverage.ts";
import { depositLedger } from "./store.ts";
import type {
    DepositRow,
    DepositStatus,
    DepositView,
    HoldReason,
    HoldRow,
    MoveRow,
    OwnerHoldReason,
    TransferReason,
    TransferRow,
    WriteOffPartRow,
} from "./types.ts";

export interface DepositSummary {
    onTimeMicros: number;
    returnedOrReturningMicros: number;
    keptMicros: number;
    // checked past expires_at + settle_grace at expiry_min_slot (spec 8.4)
    decided: boolean;
}

/**
 * Spec 8.4: an unpaid order past its deadline has lapsed only with no deposit, or with one a
 * pinned read decided holds nothing on time; until then the deposit job may still settle it.
 * publicState and the internal order API both answer by this one rule.
 */
export function depositLapsed(expiresAt: Date, now: Date, dep: DepositSummary | null): boolean {
    if (now.getTime() < expiresAt.getTime()) return false;
    return dep === null || (dep.onTimeMicros === 0 && dep.decided);
}

export interface DepositLedger {
    deposit: DepositRow;
    transfers: readonly TransferRow[];
    moves: readonly MoveRow[];
    holds: readonly HoldRow[];
    depositRefunds: readonly RefundRow[];
    writeOffParts: readonly WriteOffPartRow[];
}

type StatusOrder = Pick<OrderRow, "state" | "amountMicros" | "expiresAt">;
type StatusCfg = Pick<Settings["deposits"], "refund_min_micros" | "max_split_owners">;
type ViewCfg = StatusCfg & Pick<Settings["deposits"], "settle_grace">;
type ViewOutcome = DepositView["transfers"][number]["outcome"];

const PAID_STATES: ReadonlySet<OrderState> = new Set(["paid", "redeemed", "refunding", "refunded"]);
const RETURNING_REFUND: ReadonlySet<RefundRow["state"]> = new Set(["pending", "signed", "sent"]);
const LISTED_TRANSFERS = 10;

// An x402 payment in flight may still revert to unpaid, so open money waits instead of going back
function takesMoney(state: OrderState): boolean {
    return state === "unpaid" || state === "settling";
}

const onTime = (t: TransferRow, expiresAt: Date) => t.blockTime.getTime() <= expiresAt.getTime();
// What is still in the deposit; a written-off debit took the rest (spec 23.1)
const rest = (t: TransferRow) => t.amountMicros - t.appliedMicros - t.lostMicros;

type PartOutcome = "returned" | "returning" | "kept" | "review";
interface ShownPart {
    micros: number;
    outcome: PartOutcome;
    returnSignature: string | null;
}
// Written-off parts by transfer signature
type WrittenOff = ReadonlyMap<string, readonly ShownPart[]>;
// A transfer taken whole shows by its part that needs the most attention
const PART_RANK: Readonly<Record<PartOutcome, number>> = {
    kept: 0,
    returned: 1,
    returning: 2,
    review: 3,
};

/**
 * A written-off part by its payout: the float pays it back, Bugnet keeps it by the reason stored
 * when it was written off, or it is paid by hand (spec 23.1). The payer is never shown a part
 * Bugnet keeps, as kept or as returned.
 */
function writtenOff(l: Pick<DepositLedger, "depositRefunds" | "writeOffParts">): WrittenOff {
    const byId = new Map(l.depositRefunds.map((r) => [r.id, r]));
    const parts = new Map<string, ShownPart[]>();
    for (const p of l.writeOffParts) {
        const payout = p.refundId === null ? undefined : byId.get(p.refundId);
        let outcome: PartOutcome;
        if (payout?.state === "confirmed") outcome = "returned";
        else if (payout !== undefined && RETURNING_REFUND.has(payout.state)) outcome = "returning";
        else if (payout === undefined && p.keptReason !== null) outcome = "kept";
        else outcome = "review";
        const shown = { micros: p.micros, outcome, returnSignature: payout?.txSignature ?? null };
        parts.set(p.transferSignature, [...(parts.get(p.transferSignature) ?? []), shown]);
    }
    return parts;
}

// What goes back to the sender: the rest from the deposit, and the written-off parts the float
// pays back
function owedBack(t: TransferRow, parts: WrittenOff): number {
    let back = rest(t);
    for (const p of parts.get(t.signature) ?? []) {
        if (p.outcome === "returned" || p.outcome === "returning") back += p.micros;
    }
    return back;
}

// A paid transfer's rest is extra unless it was kept as dust
function reasonOf(t: TransferRow): TransferReason | null {
    if (t.outcome !== "paid") return t.reason;
    return t.reason === "below_minimum" ? "below_minimum" : "extra";
}

function newest(transfers: readonly TransferRow[]): TransferRow | undefined {
    return transfers.reduce<TransferRow | undefined>(
        (a, t) => (a === undefined || chainOrder(a, t) < 0 ? t : a),
        undefined,
    );
}

interface Facts {
    status: DepositStatus;
    cov: Coverage;
    receivedMicros: number;
    otherMicros: number;
    extraMicros: number;
    returningMicros: number;
    returnedMicros: number;
    keptMicros: number;
    reviewMicros: number;
    outcomes: Map<string, { outcome: ViewOutcome; returnSignature: string | null }>;
    parts: WrittenOff;
}

function facts(order: StatusOrder, l: DepositLedger, now: Date, cfg: StatusCfg): Facts {
    const { deposit } = l;
    const moves = new Map(l.moves.map((m) => [m.id, m]));
    const refunds = new Map(
        l.depositRefunds
            .filter((r) => r.reason === "deposit_held")
            .map((r) => [r.depositSignature, r]),
    );
    const parts = writtenOff(l);
    const heldOwners = new Map<string, OwnerHoldReason>();
    let sharedHeld = false;
    for (const h of l.holds) {
        if (h.recheckAt.getTime() <= now.getTime()) continue;
        if (h.owner === "") sharedHeld = true;
        else heldOwners.set(h.owner, h.reason);
    }
    const cov = coverage(
        order.amountMicros,
        l.transfers,
        order.expiresAt,
        { owners: heldOwners, shared: sharedHeld },
        cfg,
    );

    let extra = 0;
    let returning = 0;
    let returned = 0;
    let kept = 0;
    let review = 0;
    let openOnTime = 0;
    let paidMicros = 0;
    const outcomes = new Map<string, { outcome: ViewOutcome; returnSignature: string | null }>();
    const takes = takesMoney(order.state);
    for (const t of l.transfers) {
        let lost: ShownPart | null = null;
        for (const p of parts.get(t.signature) ?? []) {
            if (p.outcome === "returned") returned += p.micros;
            else if (p.outcome === "returning") returning += p.micros;
            else if (p.outcome === "review") review += p.micros;
            if (lost === null || PART_RANK[p.outcome] > PART_RANK[lost.outcome]) lost = p;
        }
        const move = t.moveId === null ? undefined : moves.get(t.moveId);
        const moved = move?.state === "confirmed";
        const back = (amount: number) => {
            if (moved) returned += amount;
            else returning += amount;
        };
        let outcome: ViewOutcome;
        let returnSignature: string | null = null;
        // A paid transfer whose rest could not go back goes to review keeping its applied part
        // (spec 11.2; 10.9 holds amount minus applied), so it still counts toward the order
        const applied = t.outcome === "paid" || t.appliedMicros > 0;
        if (applied) paidMicros += t.amountMicros;
        switch (t.outcome) {
            case "open": {
                if (t.sourceOwner !== null && onTime(t, order.expiresAt)) {
                    openOnTime += rest(t);
                }
                // Late money, and any money once the order stops taking it, can only go back
                const counted = takes && onTime(t, order.expiresAt);
                outcome = counted ? "counted" : "returning";
                if (!counted) returning += rest(t);
                break;
            }
            case "paid":
                outcome = "counted";
                if (reasonOf(t) === "below_minimum") {
                    kept += rest(t);
                    break;
                }
                extra += owedBack(t, parts);
                if (rest(t) === 0) break;
                back(rest(t));
                returnSignature = move?.txSignature ?? null;
                break;
            case "return":
                if (t.reason === "extra") extra += owedBack(t, parts);
                back(rest(t));
                outcome = moved ? "returned" : "returning";
                returnSignature = move?.txSignature ?? null;
                break;
            case "keep":
                kept += rest(t);
                outcome = "kept";
                break;
            case "review": {
                // Held review money comes back through a deposit refund row (spec 10.9)
                const refund = refunds.get(t.signature);
                if (refund?.state === "confirmed") {
                    returned += rest(t);
                    outcome = "returned";
                } else if (refund !== undefined && RETURNING_REFUND.has(refund.state)) {
                    returning += rest(t);
                    outcome = "returning";
                } else {
                    review += rest(t);
                    outcome = "review";
                }
                returnSignature = refund?.txSignature ?? null;
                break;
            }
        }
        if (lost !== null && rest(t) === 0) {
            outcome = lost.outcome;
            returnSignature = lost.returnSignature;
        }
        outcomes.set(t.signature, { outcome: applied ? "counted" : outcome, returnSignature });
    }

    const settled = deposit.settledAt !== null;
    let receivedMicros: number;
    if (settled) receivedMicros = paidMicros;
    else receivedMicros = cov.mode === "short" ? cov.largestMicros : cov.countedMicros;
    const reviewing =
        deposit.reviewReason !== null ||
        l.moves.some((m) => m.state === "manual") ||
        order.state === "manual";

    let status: DepositStatus;
    if (reviewing) status = "review";
    else if (settled && PAID_STATES.has(order.state)) status = "paid";
    else if (order.state === "settling") status = "confirming";
    else if (order.state === "unpaid" && deposit.holdReason === null && cov.mode !== "short") {
        status = "confirming";
    } else if (
        order.state === "unpaid" &&
        (deposit.holdReason !== null || cov.heldCovers !== null)
    ) {
        status = "held";
    } else if (order.state === "unpaid" && now.getTime() < order.expiresAt.getTime()) {
        status = receivedMicros > 0 ? "partial" : "waiting";
    } else if (returning > 0) status = "refunding";
    else if (order.state === "unpaid") status = "checking";
    else if (order.state === "expired" && returned + kept === 0) status = "expired";
    else status = "refunded";

    return {
        status,
        cov,
        receivedMicros,
        otherMicros: settled ? openOnTime : cov.otherMicros,
        extraMicros: extra,
        returningMicros: returning,
        returnedMicros: returned,
        keptMicros: kept,
        reviewMicros: review,
        outcomes,
        parts,
    };
}

export function depositStatus(
    order: StatusOrder,
    ledger: DepositLedger,
    now: Date,
    cfg: StatusCfg,
): DepositStatus {
    return facts(order, ledger, now, cfg).status;
}

export function depositViewFrom(
    order: StatusOrder,
    ledger: DepositLedger,
    now: Date,
    cfg: ViewCfg,
): DepositView {
    const f = facts(order, ledger, now, cfg);
    const { deposit } = ledger;
    const until = new Date(order.expiresAt.getTime() + cfg.settle_grace).toISOString();
    let hold: DepositView["hold"] = null;
    const holdReason: HoldReason | null =
        deposit.holdReason ?? (f.status === "held" ? f.cov.heldCovers : null);
    if (holdReason !== null) hold = { reason: holdReason, until };

    // A transfer whose money left is all in parts Bugnet keeps or pays by hand has no reason line
    const owed = (t: TransferRow) => owedBack(t, f.parts);
    const told = ledger.transfers.filter((t) => t.outcome !== "open" && owed(t) > 0);
    const latest = newest(told);
    const reason = latest === undefined ? null : reasonOf(latest);
    const reasonMicros =
        reason === null
            ? 0
            : told.filter((t) => reasonOf(t) === reason).reduce((a, t) => a + owed(t), 0);
    const blocked = newest(ledger.transfers.filter((t) => t.reason === "payer_blocked"));

    const listed = [...ledger.transfers]
        .sort((a, b) => chainOrder(b, a))
        .slice(0, LISTED_TRANSFERS);
    return {
        address: deposit.address,
        ready: deposit.readyAt !== null,
        status: f.status,
        receivedMicros: f.receivedMicros,
        otherMicros: f.otherMicros,
        remainingMicros: Math.max(0, order.amountMicros - f.receivedMicros),
        extraMicros: f.extraMicros,
        returningMicros: f.returningMicros,
        returnedMicros: f.returnedMicros,
        keptMicros: f.keptMicros,
        reviewMicros: f.reviewMicros,
        reason,
        reasonMicros,
        blockedUntil: blocked?.blockedUntil?.toISOString() ?? null,
        hold,
        transfers: listed.map((t) => ({
            signature: t.signature,
            amountMicros: t.amountMicros,
            at: t.blockTime.toISOString(),
            outcome: f.outcomes.get(t.signature)!.outcome,
            reason: t.reason,
            returnSignature: f.outcomes.get(t.signature)!.returnSignature,
        })),
    };
}

export function depositSummary(
    order: Pick<OrderRow, "expiresAt">,
    ledger: Pick<DepositLedger, "deposit" | "transfers" | "moves" | "writeOffParts">,
    settleGraceMs: number,
): DepositSummary {
    let onTimeMicros = 0;
    let back = 0;
    let kept = 0;
    // A written-off part Bugnet keeps is neither returned nor kept for the payer (spec 23.1)
    const keptLost = new Map<string, number>();
    for (const p of ledger.writeOffParts) {
        if (p.keptReason === null) continue;
        keptLost.set(p.transferSignature, (keptLost.get(p.transferSignature) ?? 0) + p.micros);
    }
    for (const t of ledger.transfers) {
        if (t.outcome === "open" && onTime(t, order.expiresAt)) onTimeMicros += rest(t);
        if (t.outcome === "keep" || reasonOf(t) === "below_minimum") kept += rest(t);
        // Money neither applied nor kept goes back to its sender, by the job or, for review money,
        // by an operator, so an expired order holding any of it did take money
        else back += rest(t);
        back += t.lostMicros - (keptLost.get(t.signature) ?? 0);
    }
    const d = ledger.deposit;
    const graceEnd = order.expiresAt.getTime() + settleGraceMs;
    const decided =
        d.checkedAt !== null &&
        d.checkedAt.getTime() >= graceEnd &&
        d.expiryMinSlot !== null &&
        d.checkedSlot !== null &&
        d.checkedSlot >= d.expiryMinSlot;
    return { onTimeMicros, returnedOrReturningMicros: back, keptMicros: kept, decided };
}

// depositView's answer from a ledger already read
export function depositViewOf(
    order: StatusOrder,
    ledger: DepositLedger,
    now: Date,
    cfg: ViewCfg,
): DepositView | null {
    // An order paid another way, or being paid, shows only its own state when no money came here
    const otherwise =
        ledger.deposit.settledAt === null &&
        (PAID_STATES.has(order.state) || order.state === "settling");
    if (otherwise && ledger.transfers.length === 0) return null;
    return depositViewFrom(order, ledger, now, cfg);
}

export async function depositView(
    db: Queryable,
    order: OrderRow,
    now: Date,
    cfg: Settings["deposits"],
): Promise<DepositView | null> {
    const ledger = await depositLedger(db, order.id);
    return ledger === null ? null : depositViewOf(order, ledger, now, cfg);
}
