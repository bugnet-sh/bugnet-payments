/**
 * Writing off a debit Bugnet did not sign (spec 23.1). The debit is recorded at its slot, split
 * onto the senders' transfers, and each known sender's part is paid from the refund float; the
 * job then finishes the deposit as usual.
 *
 * The split takes the money that was in the account at the debit's slot: unapplied money first,
 * newest transfer first, and a settling payment's applied money last. Taking applied money means
 * the sweep can never land, so the payment is failed and the order expires, and every sender's
 * money goes back.
 */
import type pg from "pg";
import type { Settings } from "../config.ts";
import type { Log } from "../log.ts";
import { archivePayment, lockOrder, lockPayment, setOrderState } from "../orders/store.ts";
import { lockRefundGroup } from "../refunds/split.ts";
import { movePool } from "../x402/ledger.ts";
import { chainOrder } from "./coverage.ts";
import { expectedBalanceAt } from "./scan.ts";
import {
    deletePendingMove,
    depositLedger,
    insertWriteOff,
    lockDeposit,
    setTransferOutcomes,
    updateDeposit,
} from "./store.ts";
import type { MoveRow, ReviewReason, TransferRow } from "./types.ts";

export interface SplitInput {
    transfers: readonly TransferRow[];
    moves: readonly MoveRow[];
    slot: bigint;
    // Signatures of the debit's slot that came before it
    olderInSlot: ReadonlySet<string>;
    micros: number;
    // The settling payment's sweep has not landed, so its applied money is still in the account
    settling: boolean;
}

export interface SplitPart {
    signature: string;
    micros: number;
    // Of micros, the settling payment's applied money
    appliedMicros: number;
}

/**
 * Money in the account at the debit's slot first, its unapplied money and then the settling
 * payment's applied money, newest transfer first. Money a move that landed after the debit
 * carried away was not there for the thief alone, so when what is left at the slot is short the
 * rest falls on money that came after it, in the same order (ruling, spec 23.1 split).
 */
export function splitDebit(i: SplitInput): { parts: SplitPart[]; shortMicros: number } {
    const landed = new Set(i.moves.filter((m) => m.landedSlot !== null).map((m) => m.id));
    const carried = (t: TransferRow) => t.moveId !== null && landed.has(t.moveId);
    const unapplied = (t: TransferRow) =>
        carried(t) ? 0 : Math.max(0, t.amountMicros - t.appliedMicros - t.lostMicros);
    const applied = (t: TransferRow) => (i.settling ? t.appliedMicros : 0);
    const atSlot = (t: TransferRow) =>
        t.slot < i.slot || (t.slot === i.slot && i.olderInSlot.has(t.signature));
    const newest = [...i.transfers].sort((a, b) => chainOrder(b, a));
    const before = newest.filter(atSlot);
    const after = newest.filter((t) => !atSlot(t));
    const order: [TransferRow, number, boolean][] = [];
    for (const group of [before, after]) {
        for (const t of group) order.push([t, unapplied(t), false]);
        for (const t of group) order.push([t, applied(t), true]);
    }
    const parts = new Map<string, SplitPart>();
    let left = i.micros;
    for (const [t, available, isApplied] of order) {
        const take = Math.min(left, available);
        if (take <= 0) continue;
        left -= take;
        const p = parts.get(t.signature) ?? { signature: t.signature, micros: 0, appliedMicros: 0 };
        p.micros += take;
        if (isApplied) p.appliedMicros += take;
        parts.set(t.signature, p);
    }
    const inChainOrder = i.transfers
        .filter((t) => parts.has(t.signature))
        .sort(chainOrder)
        .map((t) => parts.get(t.signature)!);
    return { parts: inChainOrder, shortMicros: left };
}

export interface WriteOffRequest {
    orderId: string;
    signature: string;
    slot: bigint;
    micros: number;
    olderInSlot: ReadonlySet<string>;
    // A read of the account after the debit; review clears only when it matches the ledger
    read: { micros: bigint; contextSlot: bigint } | null;
    at: Date;
    x402: Settings["x402"];
    log: Log;
}

export interface WrittenPart {
    transferSignature: string;
    micros: number;
    appliedMicros: number;
    refundId: number | null;
    destination: string | null;
    // the payout went into this write-off row of the transfer, which was still pending
    joined: boolean;
    // why a part of a known sender got no payout: its earlier write-off row is past pending
    unpaid: string | null;
}

export type WriteOffResult =
    | { refused: string }
    | {
          parts: WrittenPart[];
          expired: boolean;
          dropped: number;
          review: ReviewReason | null;
          reviewCleared: boolean;
          expectedMicros: bigint | null;
      };

const IN_FLIGHT = ["signed", "sent"];

/**
 * Decided under the locks of spec 7, payment, order, deposit, then the moves and the deposit
 * refund group, so no move of the deposit and no refund of its group changes in between. Every
 * check of the command is made again here; the caller has read the chain.
 */
export async function writeOff(c: pg.PoolClient, w: WriteOffRequest): Promise<WriteOffResult> {
    const payment = await lockPayment(c, w.orderId);
    const order = await lockOrder(c, w.orderId);
    const deposit = await lockDeposit(c, w.orderId);
    if (order === null || deposit === null) return { refused: `no deposit for ${w.orderId}` };
    if (deposit.state === "done") {
        return { refused: `deposit ${w.orderId} is done, so the job no longer reads it` };
    }
    const ledger = (await depositLedger(c, w.orderId))!;
    if (ledger.writeOffs.some((x) => x.signature === w.signature)) {
        return { refused: `${w.signature} is already written off for ${w.orderId}` };
    }
    if (ledger.moves.some((m) => IN_FLIGHT.includes(m.state))) {
        return { refused: `deposit ${w.orderId} has a move in flight; try again shortly` };
    }
    const ours = ledger.moves.some(
        (m) => m.txSignature === w.signature || m.previousSignatures.includes(w.signature),
    );
    if (ours) return { refused: `${w.signature} is a move of ${w.orderId}` };
    if (ledger.transfers.some((t) => t.signature === w.signature)) {
        return { refused: `${w.signature} is a transfer of ${w.orderId}` };
    }

    const sweeps = ledger.moves.filter((m) => m.kind === "sweep");
    const settling =
        order.state === "settling" &&
        deposit.settledAt !== null &&
        payment?.status === "settling" &&
        !sweeps.some((m) => m.landedSlot !== null);
    const split = splitDebit({
        transfers: ledger.transfers,
        moves: ledger.moves,
        slot: w.slot,
        olderInSlot: w.olderInSlot,
        micros: w.micros,
        settling,
    });
    if (split.shortMicros > 0) {
        return {
            refused: `the ledger of ${w.orderId} holds ${split.shortMicros} less than the debit`,
        };
    }
    const bySignature = new Map(ledger.transfers.map((t) => [t.signature, t]));
    const expires = split.parts.some((p) => p.appliedMicros > 0);
    if (expires) {
        // A settling payment's extra is never returned before its sweep lands (rule 1), so no
        // applied transfer has a confirmed move of its own
        const landed = new Set(ledger.moves.filter((m) => m.landedSlot !== null).map((m) => m.id));
        const carried = ledger.transfers.find(
            (t) => t.appliedMicros > 0 && t.moveId !== null && landed.has(t.moveId),
        );
        if (carried !== undefined) {
            return { refused: `applied transfer ${carried.signature} has a landed move` };
        }
    }

    // A move planned before the write-off would carry money that is gone
    let dropped = 0;
    for (const m of ledger.moves) {
        if (m.state !== "pending" || m.kind === "create" || m.kind === "sweep") continue;
        if (await deletePendingMove(c, m.id)) dropped++;
    }

    await insertWriteOff(
        c,
        {
            orderId: w.orderId,
            signature: w.signature,
            slot: w.slot,
            micros: w.micros,
            writtenAt: w.at,
        },
        split.parts.map((p) => ({
            transferSignature: p.signature,
            micros: p.micros,
            refundId: null,
        })),
    );
    const parts: WrittenPart[] = [];
    for (const p of split.parts) {
        parts.push(await payPart(c, w, bySignature.get(p.signature)!, p));
    }

    if (expires) await expireSettling(c, w, order, ledger.transfers, sweeps);

    const after = (await depositLedger(c, w.orderId))!;
    const expectedMicros =
        w.read === null
            ? null
            : expectedBalanceAt(after.transfers, after.moves, after.writeOffs, w.read.contextSlot);
    const reviewCleared =
        deposit.reviewReason === "unknown_debit" &&
        w.read !== null &&
        w.read.micros === expectedMicros;
    if (reviewCleared) await updateDeposit(c, w.orderId, { reviewReason: null });
    return {
        parts,
        expired: expires,
        dropped,
        review: reviewCleared ? null : deposit.reviewReason,
        reviewCleared,
        expectedMicros,
    };
}

/**
 * One float payout per part of a known sender. A transfer has one write-off row: a later part
 * joins it while it is still pending, and is otherwise left for support like money of no known
 * sender (ruling, spec 23.1).
 */
async function payPart(
    c: pg.PoolClient,
    w: WriteOffRequest,
    t: TransferRow,
    p: SplitPart,
): Promise<WrittenPart> {
    const base = {
        transferSignature: p.signature,
        micros: p.micros,
        appliedMicros: p.appliedMicros,
        destination: t.sourceTokenAccount,
    };
    const none = { ...base, refundId: null, joined: false, unpaid: null };
    if (t.sourceOwner === null || t.sourceTokenAccount === null) return none;
    const group = await lockRefundGroup(c, w.orderId, "deposit");
    const existing = group.find(
        (r) => r.reason === "deposit_write_off" && r.depositSignature === t.signature,
    );
    let refundId: number;
    if (existing !== undefined) {
        if (existing.state !== "pending") {
            return { ...none, unpaid: `refund ${existing.id} is ${existing.state}` };
        }
        await c.query("update refunds set amount_micros = amount_micros + $2 where id = $1", [
            existing.id,
            p.micros,
        ]);
        refundId = existing.id;
    } else {
        const next = group.reduce((max, r) => Math.max(max, r.part + 1), 0);
        const inserted = await c.query<{ id: string }>(
            `insert into refunds (order_id, kind, part, reason, amount_micros, destination, payer,
                state, from_wallet, deposit_signature, created_at)
             values ($1, 'deposit', $2, 'deposit_write_off', $3, $4, $5, 'pending', 'refund', $6,
                $7)
             returning id`,
            [w.orderId, next, p.micros, t.sourceTokenAccount, t.sourceOwner, t.signature, w.at],
        );
        refundId = Number(inserted.rows[0]!.id);
    }
    await c.query(
        `update deposit_write_off_parts set refund_id = $4
         where order_id = $1 and signature = $2 and transfer_signature = $3`,
        [w.orderId, w.signature, t.signature, refundId],
    );
    return { ...base, refundId, joined: existing !== undefined, unpaid: null };
}

/**
 * Spec 23.1, settling payment: the sweep can no longer land. It fails for good, the payments row
 * is archived as a failed x402 payment is, the order expires, and every applied transfer goes
 * back with nothing applied and the shares gone. No token was issued for a settling order.
 */
async function expireSettling(
    c: pg.PoolClient,
    w: WriteOffRequest,
    order: NonNullable<Awaited<ReturnType<typeof lockOrder>>>,
    transfers: readonly TransferRow[],
    sweeps: readonly MoveRow[],
): Promise<void> {
    const latest = sweeps.reduce<MoveRow | undefined>(
        (a, m) => (a === undefined || m.id > a.id ? m : a),
        undefined,
    );
    if (latest !== undefined) {
        await c.query(
            `update deposit_moves set state = 'failed', manual_reason = 'written_off'
             where id = $1 and landed_slot is null`,
            [latest.id],
        );
    }
    if (!(await archivePayment(c, w.orderId, "written_off"))) {
        throw new Error(`payment of order ${w.orderId} is not settling`);
    }
    await setOrderState(c, w.orderId, "settling", "expired");
    if (order.allowanceMicros > 0) {
        await movePool(c, { unpaid: -order.allowanceMicros }, w.x402, w.log);
    }
    await setTransferOutcomes(
        c,
        w.orderId,
        transfers
            .filter((t) => t.appliedMicros > 0)
            .map((t) =>
                t.outcome === "review"
                    ? {
                          signature: t.signature,
                          outcome: "review",
                          reason: t.reason,
                          appliedMicros: 0,
                      }
                    : {
                          signature: t.signature,
                          outcome: "return",
                          reason: "unpaid",
                          appliedMicros: 0,
                          moveId: null,
                      },
            ),
    );
    await c.query("delete from payment_shares where order_id = $1", [w.orderId]);
    await updateDeposit(c, w.orderId, { state: "draining", settledAt: null });
}
