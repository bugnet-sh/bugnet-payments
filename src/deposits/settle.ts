/**
 * The settle step, the sweep confirmation and the payments hook (spec 10.1 to 10.4).
 *
 * Settle asks the router about the owners the plan applies, outside any database transaction.
 * A single owner is always named and checked, an exchange included; a shared payment names no
 * payer and acts only on blocks, then asks the anonymous pool once. Any assignment or hold ends
 * the settle, so the next plan starts from the new state. Otherwise a guard read pinned to the
 * ledger and a blockhash pinned to it come before one transaction that signs the sweep, stores it
 * with its payments row and moves the order to settling; the sweep is sent after COMMIT. The
 * order is paid only when that sweep lands, and the payments row always names the attempt that
 * can still land.
 */
import { address, type Address, type KeyPairSigner } from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import {
    confirmPayment,
    findOrder,
    insertPayment,
    lockOrder,
    lockPayment,
    replacePaymentTx,
    setOrderState,
    setPaymentLandedSlot,
} from "../orders/store.ts";
import type { OrderKind, OrderRow } from "../orders/types.ts";
import { FRESH_SEND, viaRpc } from "../refunds/executor.ts";
import type { PayerCheck, RouterClient } from "../router/client.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { settleGate } from "../x402/create.ts";
import { findAccountByHandle } from "../x402/ledger.ts";
import { onOrderPaid } from "../x402/paid.ts";
import type { SignerHealth } from "../x402/types.ts";
import type { DepositKeys } from "./keys.ts";
import {
    buildMoveTransaction,
    guardRead,
    type MoveDeps,
    pinnedBlockhash,
    sendMove,
    type SignedMove,
} from "./moves.ts";
import type { Plan } from "./plan.ts";
import {
    clearHolds,
    depositLedger,
    findMove,
    insertMove,
    insertShares,
    lockDeposit,
    putHold,
    setTransferOutcomes,
    updateDeposit,
} from "./store.ts";
import type {
    DepositHoldReason,
    DepositRow,
    MoveRow,
    NewMove,
    OwnerHoldReason,
    TransferOutcome,
    TransferReason,
    TransferRow,
} from "./types.ts";

export interface SettleDeps {
    pool: pg.Pool;
    router: RouterClient;
    feePayer: KeyPairSigner;
    // The challenge's fee payer is Payments' own, never a sender's transaction fee payer
    challengeFeePayer: string;
    x402: { x402: Settings["x402"]; signer: SignerHealth };
    keys: DepositKeys;
    cfg: Settings["deposits"];
    recipientTokenAccount: Address;
    hotTokenAccount: Address | null;
    // The money lane: the guard read, the blockhash and the send
    rpc: SolanaRpc;
    rpcTimeoutMs: number;
    log: Log;
    now: () => Date;
    // What is left of max_split_owners + 1 router calls for this deposit this tick
    routerCalls: { left: number };
}

export type SettleOutcome = "settling" | "returned" | "held" | "changed" | "wait";
export type SettlePlan = Extract<Plan, { kind: "settle" }>;

type Target = { packageId: string; kind: OrderKind };
type Decided = Exclude<SettleOutcome, "settling" | "changed">;
type Assigned = {
    signature: string;
    outcome: TransferOutcome;
    reason: TransferReason;
    blockedUntil?: Date | null;
};

const onTime = (order: Pick<OrderRow, "expiresAt">, t: TransferRow) =>
    t.outcome === "open" && t.blockTime.getTime() <= order.expiresAt.getTime();
const stillSettles = (order: OrderRow, deposit: DepositRow) =>
    order.state === "unpaid" && deposit.state === "open" && deposit.settledAt === null;
const maxOf = (a: bigint, b: bigint) => (a > b ? a : b);

export async function settleDeposit(
    d: SettleDeps,
    orderId: string,
    plan: SettlePlan,
    readSlot: bigint,
    signal: AbortSignal,
): Promise<SettleOutcome> {
    const order = await findOrder(d.pool, orderId);
    const ledger = await depositLedger(d.pool, orderId);
    if (order === null || ledger === null) throw new Error(`no deposit for ${orderId}`);
    if (!stillSettles(order, ledger.deposit)) return "changed";
    const open = ledger.transfers.filter((t) => onTime(order, t));

    if (order.payInto === "allowance") {
        const gate = await settleGate(d.pool, d.x402);
        if (gate === "x402_disabled") {
            const rows = open.map((t) => returned(t, "allowance_unavailable"));
            return await assign(d, orderId, rows);
        }
        if (gate !== null) return await holdDeposit(d, orderId, "allowance_paused");
    }
    const target = await targetOf(d, order);
    if (target === null) return await holdDeposit(d, orderId, "allowance_paused");
    const ask = async (payer: string): Promise<PayerCheck | null> => {
        if (d.routerCalls.left <= 0) return null;
        d.routerCalls.left--;
        const r = { payer, feePayer: d.challengeFeePayer, ...target };
        return await d.router.checkPayer(r, signal);
    };
    const checked = plan.multiSender
        ? await checkShared(d, order, plan, open, ask)
        : await checkSingle(d, order, plan.owners[0]!.owner, open, ask);
    if (checked !== null) return checked;
    return await signSweep(d, order, ledger, plan, readSlot);
}

// The router answers any kind but start or extend as invalid, so a top-up is checked as extend.
// The job's early blocked check asks with the same kind and package.
export async function targetOf(
    d: Pick<SettleDeps, "pool" | "log">,
    order: OrderRow,
): Promise<Target | null> {
    if (order.kind !== "allowance") return { packageId: order.packageId, kind: order.kind };
    const account = await findAccountByHandle(d.pool, order.handleSha256 ?? "");
    if (account === null) {
        d.log.error("allowance order has no account", { orderId: order.id });
        return null;
    }
    return { packageId: account.packageId, kind: "extend" };
}

async function checkSingle(
    d: SettleDeps,
    order: OrderRow,
    owner: string,
    open: readonly TransferRow[],
    ask: (payer: string) => Promise<PayerCheck | null>,
): Promise<Decided | null> {
    const check = await ask(owner);
    if (check === null) return "wait";
    const own = open.filter((t) => t.sourceOwner === owner);
    switch (check.verdict) {
        case "ok":
        case "skipped":
            return null;
        case "blocked":
            return await assign(
                d,
                order.id,
                own.map((t) => blocked(t, check.blockedUntil)),
            );
        case "busy":
            return await holdOwner(d, order.id, owner, "payer_busy");
        case "rate_limited":
            return await holdOwner(d, order.id, owner, "payer_rate_limited");
        case "invalid": {
            const rows = own.map((t) => ({
                signature: t.signature,
                outcome: "review" as const,
                reason: "unattributed" as const,
            }));
            const outcome = await assign(d, order.id, rows);
            d.log.alarm("deposit_review", {
                orderId: order.id,
                owner,
                signatures: rows.map((r) => r.signature),
                reason: "unattributed",
            });
            return outcome;
        }
        case "unavailable":
            // Start and extend orders are checked again at CreatePlacement; a top-up never is
            if (order.kind === "allowance") {
                return await holdDeposit(d, order.id, "router_unavailable");
            }
            return null;
    }
}

// Only a block counts for a shared payment's owners: its token names no payer, so no owner's
// own limit, a stranger's included, can stall it
async function checkShared(
    d: SettleDeps,
    order: OrderRow,
    plan: SettlePlan,
    open: readonly TransferRow[],
    ask: (payer: string) => Promise<PayerCheck | null>,
): Promise<Decided | null> {
    const rows: Assigned[] = [];
    let spent = false;
    for (const { owner } of plan.owners) {
        const check = await ask(owner);
        if (check === null) {
            spent = true;
            break;
        }
        if (check.verdict !== "blocked") continue;
        const own = open.filter((t) => t.sourceOwner === owner);
        rows.push(...own.map((t) => blocked(t, check.blockedUntil)));
    }
    if (rows.length > 0) return await assign(d, order.id, rows);
    if (spent) return "wait";
    const pool = await ask("");
    if (pool === null) return "wait";
    if (pool.verdict === "busy" || pool.verdict === "rate_limited") {
        return await holdOwner(d, order.id, "", "anonymous_busy");
    }
    if (pool.verdict === "unavailable" && order.kind === "allowance") {
        return await holdDeposit(d, order.id, "router_unavailable");
    }
    return null;
}

function returned(t: TransferRow, reason: TransferReason): Assigned {
    return { signature: t.signature, outcome: "return", reason };
}

function blocked(t: TransferRow, until: string | undefined): Assigned {
    return {
        ...returned(t, "payer_blocked"),
        blockedUntil: until === undefined ? null : new Date(until),
    };
}

// Only transfers still open are assigned; the next plan starts from what was written
async function assign(d: SettleDeps, orderId: string, rows: readonly Assigned[]): Promise<Decided> {
    await withTx(
        d.pool,
        async (c) => {
            await lockDeposit(c, orderId);
            const open = await openSignatures(c, orderId);
            await setTransferOutcomes(
                c,
                orderId,
                rows.filter((r) => open.has(r.signature)),
            );
        },
        d.log,
    );
    return "returned";
}

async function holdOwner(
    d: SettleDeps,
    orderId: string,
    owner: string,
    reason: OwnerHoldReason,
): Promise<Decided> {
    const now = d.now();
    const recheckAt = new Date(now.getTime() + d.cfg.payer_recheck_every);
    await withTx(
        d.pool,
        async (c) => {
            await lockDeposit(c, orderId);
            await putHold(c, { orderId, owner, reason, recheckAt, since: now });
        },
        d.log,
    );
    return "held";
}

async function holdDeposit(
    d: SettleDeps,
    orderId: string,
    reason: DepositHoldReason,
): Promise<Decided> {
    const recheckAt = new Date(d.now().getTime() + d.cfg.payer_recheck_every);
    await withTx(
        d.pool,
        async (c) => {
            await lockDeposit(c, orderId);
            await updateDeposit(c, orderId, { holdReason: reason, recheckAt });
        },
        d.log,
    );
    return "held";
}

async function openSignatures(c: pg.PoolClient, orderId: string): Promise<Set<string>> {
    const { rows } = await c.query<{ signature: string }>(
        "select signature from deposit_transfers where order_id = $1 and outcome = 'open'",
        [orderId],
    );
    return new Set(rows.map((r) => r.signature));
}

// The crossing transfer stays paid and takes only the reason of its rest
function outcomesOf(plan: SettlePlan) {
    const reasons = new Map(plan.others.map((o) => [o.signature, o.reason]));
    const rows: {
        signature: string;
        outcome: TransferOutcome;
        reason: TransferReason | null;
        appliedMicros?: number;
    }[] = [];
    for (const [signature, appliedMicros] of plan.applied) {
        rows.push({
            signature,
            outcome: "paid",
            reason: reasons.get(signature) ?? null,
            appliedMicros,
        });
    }
    for (const o of plan.others) {
        if (!plan.applied.has(o.signature)) rows.push(o);
    }
    return rows;
}

/**
 * Spec 10.1 step 5. The router calls can take seconds, so the guard reads the account again,
 * pinned to the ledger and to the read the plan came from. The sweep carries CloseAccount only
 * when that read is exactly the price, so money that arrived meanwhile never makes it fail.
 */
async function signSweep(
    d: SettleDeps,
    order: OrderRow,
    ledger: NonNullable<Awaited<ReturnType<typeof depositLedger>>>,
    plan: SettlePlan,
    readSlot: bigint,
): Promise<SettleOutcome> {
    const { deposit } = ledger;
    const pinned = { ...deposit, checkedSlot: maxOf(deposit.checkedSlot ?? 0n, readSlot) };
    const guard = await guardRead(
        d,
        pinned,
        {
            id: 0,
            orderId: order.id,
            state: "pending",
            closes: false,
            amountMicros: order.amountMicros,
            keepMicros: 0,
            heldMicros: 0,
        },
        ledger,
    );
    if (guard.verdict !== "sign") {
        d.log.info("deposit guard read is below the ledger, settle waits for the scan", {
            orderId: order.id,
            slot: guard.slot,
            micros: guard.micros,
        });
        return "wait";
    }
    const closes =
        plan.closes && guard.micros === BigInt(order.amountMicros) && deposit.rentPayer !== null;
    const hint = await viaRpc(() => pinnedBlockhash(d, guard.slot));
    const destination = sweepDestination(d, order);
    const now = d.now();
    const stored = await withTx(
        d.pool,
        async (c): Promise<{ move: MoveRow; signed: SignedMove } | null> => {
            await lockPayment(c, order.id);
            const current = await lockOrder(c, order.id);
            const dep = await lockDeposit(c, order.id);
            if (current === null || dep === null || !stillSettles(current, dep)) return null;
            const open = await openSignatures(c, order.id);
            if ([...plan.applied.keys()].some((s) => !open.has(s))) return null;

            const sweep: NewMove = {
                orderId: order.id,
                kind: "sweep",
                amountMicros: order.amountMicros,
                keepMicros: 0,
                heldMicros: 0,
                destination,
                payer: null,
                memo: order.id,
                closes,
                closeTo: closes ? dep.rentPayer : null,
            };
            const owner = await d.keys.signer(order.id, dep.salt, dep.keyVersion);
            // A sweep never carries held money, so the float account is never used
            const signed = await buildMoveTransaction(
                { ...d, floatTokenAccount: d.recipientTokenAccount },
                sweep,
                { owner, address: address(dep.address) },
                hint,
            );
            const inserted = await insertMove(c, sweep, [], now);
            await c.query(
                `update deposit_moves set state = 'signed', wire_tx = $2, tx_signature = $3,
                    last_valid_block_height = $4, signed_at = $5, attempts = 1
                 where id = $1`,
                [
                    inserted.id,
                    signed.wire,
                    signed.signature,
                    signed.lastValidBlockHeight.toString(),
                    now,
                ],
            );
            await recordPayment(c, d, order, plan, signed);
            await setTransferOutcomes(c, order.id, outcomesOf(plan));
            await updateDeposit(c, order.id, {
                state: "settling",
                settledAt: now,
                holdReason: null,
                recheckAt: null,
            });
            await clearHolds(c, order.id);
            return { move: (await findMove(c, inserted.id))!, signed };
        },
        d.log,
    );
    if (stored === null) return "changed";
    const { move, signed } = stored;
    await sendMove(d, move, signed.wire, FRESH_SEND, maxOf(guard.slot, signed.contextSlot));
    return "settling";
}

function sweepDestination(d: SettleDeps, order: OrderRow): Address {
    if (order.payInto !== "allowance") return d.recipientTokenAccount;
    if (d.hotTokenAccount === null) throw new Error(`hot order ${order.id} needs the hot account`);
    return d.hotTokenAccount;
}

// Part 0 is the payer of record; a shared payment's token names no payer (spec 10.5)
async function recordPayment(
    c: pg.PoolClient,
    d: SettleDeps,
    order: OrderRow,
    plan: SettlePlan,
    signed: SignedMove,
): Promise<void> {
    const first = plan.owners[0]!;
    await insertPayment(c, {
        orderId: order.id,
        txSignature: signed.signature,
        messageHash: signed.messageHash,
        payer: first.owner,
        sourceTokenAccount: first.sourceTokenAccount,
        amountMicros: order.amountMicros,
        blockhash: signed.blockhash,
        lastValidBlockHeight: signed.lastValidBlockHeight,
        createdAt: plan.paidAt,
        keySha256: null,
        payerCounted: !plan.multiSender,
        multiSender: plan.multiSender,
        splitMinMicros: plan.multiSender ? d.cfg.refund_min_micros : null,
    });
    if (plan.multiSender) {
        await insertShares(
            c,
            plan.owners.map((o, part) => ({
                orderId: order.id,
                part,
                owner: o.owner,
                sourceTokenAccount: o.sourceTokenAccount,
                appliedMicros: o.appliedMicros,
            })),
        );
    }
    await setOrderState(c, order.id, "unpaid", "settling", {
        payer: first.owner,
        paidVia: "transfer",
    });
}

/**
 * Spec 10.3, in the executor's transaction, which already holds the payment, order, deposit and
 * move locks. paid_at is the block time of the transfer that crossed the price, so the deadline
 * checks downstream hold even when the sweep lands late. The move keeps the signature that landed.
 */
export async function confirmSweep(
    c: pg.PoolClient,
    d: Pick<MoveDeps, "paid" | "now" | "log" | "cfg">,
    move: MoveRow,
    landed: { signature: string; slot: bigint },
): Promise<void> {
    const payment = await lockPayment(c, move.orderId);
    const order = await lockOrder(c, move.orderId);
    if (payment === null || order === null) {
        throw new Error(`deposit sweep ${move.id} of ${move.orderId} has no payment`);
    }
    const now = d.now();
    if (landed.signature !== payment.txSignature) {
        d.log.warn("an earlier attempt of a deposit sweep landed", {
            orderId: order.id,
            moveId: move.id,
            signature: landed.signature,
        });
        await c.query("update payments set tx_signature = $2 where order_id = $1", [
            order.id,
            landed.signature,
        ]);
    }
    await c.query(
        `update deposit_moves set state = 'confirmed', confirmed_at = $2, landed_slot = $3,
            tx_signature = $4,
            previous_signatures = case when tx_signature = $4 then previous_signatures
                else array_append(array_remove(previous_signatures, $4), tx_signature) end
         where id = $1`,
        [move.id, now, landed.slot.toString(), landed.signature],
    );
    if (order.state === "settling") {
        await confirmPayment(c, order.id, now);
        if (order.payInto === "allowance") await setPaymentLandedSlot(c, order.id, landed.slot);
        const paidAt = payment.createdAt;
        await setOrderState(c, order.id, "settling", "paid", { paidAt });
        if (order.payInto === "allowance") {
            if (d.paid === null) throw new Error(`hot order ${order.id} needs PaidDeps`);
            await onOrderPaid(
                c,
                d.paid,
                { ...order, state: "paid", paidAt },
                { ...payment, txSignature: landed.signature, status: "confirmed" },
                now,
            );
        }
    } else {
        d.log.error("deposit sweep landed for an order that is not settling", {
            orderId: order.id,
            moveId: move.id,
            state: order.state,
        });
    }
    await updateDeposit(
        c,
        move.orderId,
        move.closes
            ? {
                  state: "closed",
                  closedAt: now,
                  watchUntil: new Date(now.getTime() + d.cfg.watch_after_close),
                  rentPayer: null,
              }
            : { state: "draining" },
    );
}

// The executor's signing transaction already holds both locks; taking them here keeps the
// spec 7 order whoever calls it
export async function onSweepSigned(
    c: pg.PoolClient,
    move: MoveRow,
    signed: SignedMove,
): Promise<void> {
    await lockPayment(c, move.orderId);
    await lockOrder(c, move.orderId);
    await replacePaymentTx(c, move.orderId, {
        txSignature: signed.signature,
        messageHash: signed.messageHash,
        blockhash: signed.blockhash,
        lastValidBlockHeight: signed.lastValidBlockHeight,
    });
}

// The executor's sweep hooks, bound to the deps confirmSweep needs
export function sweepHooks(
    d: Pick<MoveDeps, "paid" | "now" | "log" | "cfg">,
): Pick<MoveDeps, "confirmSweep" | "onSweepSigned"> {
    return {
        confirmSweep: (c, move, landed) => confirmSweep(c, d, move, landed),
        onSweepSigned,
    };
}
