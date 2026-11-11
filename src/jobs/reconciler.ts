import { signature } from "@solana/kit";
import type pg from "pg";
import { withTx } from "../db/pool.ts";
import type { Settings } from "../config.ts";
import { lockDeposit, updateDeposit } from "../deposits/store.ts";
import type { Log } from "../log.ts";
import {
    archivePayment,
    confirmPayment,
    lockOrder,
    lockPayment,
    setOrderState,
    setPaymentLandedSlot,
} from "../orders/store.ts";
import { type Landing, readLanding } from "../solana/landing.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { movePool } from "../x402/ledger.ts";
import { onOrderPaid, type PaidDeps } from "../x402/paid.ts";

export interface ReconcileDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    rpcTimeoutMs: number;
    log: Log;
    now: () => Date;
    paid: PaidDeps | null;
    x402: Settings["x402"];
    deposits: Pick<Settings["deposits"], "expire_hard_after">;
}

export interface ReconcileReport {
    paid: number;
    reverted: number;
    waiting: number;
    changed: number;
}

interface Candidate {
    orderId: string;
    txSignature: string;
    lastValidBlockHeight: bigint;
}

type Verdict = Exclude<Landing, "processed" | "not_found"> | "waiting";

type Outcome =
    { kind: "paid" } | { kind: "reverted"; state: "unpaid" | "expired" } | { kind: "changed" };

const reportedMalformed = new Set<string>();

export async function reconcileSettling(d: ReconcileDeps): Promise<ReconcileReport> {
    const report: ReconcileReport = { paid: 0, reverted: 0, waiting: 0, changed: 0 };
    for (const p of await candidates(d.pool, d.now())) {
        if (!wellFormed(p.txSignature)) {
            // Only an operator can repair a stored signature, so one error line per order is enough
            if (!reportedMalformed.has(p.orderId)) {
                reportedMalformed.add(p.orderId);
                d.log.error("stored payment signature is malformed, order left settling", {
                    orderId: p.orderId,
                });
            }
            report.waiting++;
            continue;
        }
        let verdict: Verdict;
        let slot: bigint | null = null;
        try {
            ({ verdict, slot } = await verdictFor(d, p));
        } catch (err) {
            d.log.warn("signature status unavailable, retrying next run", {
                orderId: p.orderId,
                err,
            });
            verdict = "waiting";
        }
        if (verdict === "waiting") {
            report.waiting++;
            continue;
        }
        let outcome: Outcome;
        try {
            outcome = await apply(d, p, verdict, slot);
        } catch (err) {
            d.log.error("reconcile step failed, retrying next run", { orderId: p.orderId, err });
            report.waiting++;
            continue;
        }
        const fields = { orderId: p.orderId, signature: p.txSignature };
        switch (outcome.kind) {
            case "paid":
                report.paid++;
                d.log.info("settling payment landed, order paid", fields);
                break;
            case "reverted":
                report.reverted++;
                d.log.info("settling payment did not land", {
                    ...fields,
                    reason: verdict,
                    state: outcome.state,
                });
                break;
            case "changed":
                report.changed++;
                d.log.info("settling order changed while its status was read, left as is", fields);
                break;
        }
    }
    return report;
}

async function candidates(db: pg.Pool, now: Date): Promise<Candidate[]> {
    // Longer than the facilitator's 30 s confirmation wait, so a live payOrder finishes its own
    const res = await db.query<{
        order_id: string;
        tx_signature: string;
        last_valid_block_height: string;
    }>(
        `select p.order_id, p.tx_signature, p.last_valid_block_height
         from payments p join orders o on o.id = p.order_id
         where o.state = 'settling' and p.created_at < $1::timestamptz - interval '45 seconds'
            and o.paid_via is distinct from 'transfer'
         order by p.created_at, p.order_id`,
        [now],
    );
    return res.rows.map((r) => ({
        orderId: r.order_id,
        txSignature: r.tx_signature,
        lastValidBlockHeight: BigInt(r.last_valid_block_height),
    }));
}

function wellFormed(txSignature: string): boolean {
    try {
        signature(txSignature);
        return true;
    } catch {
        return false;
    }
}

async function verdictFor(
    d: ReconcileDeps,
    p: Candidate,
): Promise<{ verdict: Verdict; slot: bigint | null }> {
    const read = await readLanding(d.rpc, p.txSignature, p.lastValidBlockHeight, d.rpcTimeoutMs);
    const { landing } = read;
    return {
        verdict: landing === "processed" || landing === "not_found" ? "waiting" : landing,
        slot: read.landing === "landed" ? read.slot : null,
    };
}

async function apply(
    d: ReconcileDeps,
    p: Candidate,
    verdict: Exclude<Verdict, "waiting">,
    slot: bigint | null,
): Promise<Outcome> {
    return withTx(d.pool, async (c) => {
        // Payment row before order row, the order payOrder's confirmation locks them in
        const payment = await lockPayment(c, p.orderId);
        const order = await lockOrder(c, p.orderId);
        if (order?.state !== "settling" || payment?.txSignature !== p.txSignature) {
            return { kind: "changed" };
        }
        const now = d.now();
        if (verdict === "landed") {
            await confirmPayment(c, p.orderId, now);
            if (order.payInto === "allowance" && slot !== null) {
                await setPaymentLandedSlot(c, p.orderId, slot);
            }
            const paidAt = payment.createdAt;
            await setOrderState(c, p.orderId, "settling", "paid", { paidAt });
            if (order.payInto === "allowance") {
                if (d.paid === null) throw new Error(`hot order ${p.orderId} needs PaidDeps`);
                await onOrderPaid(
                    c,
                    d.paid,
                    { ...order, state: "paid", paidAt },
                    { ...payment, status: "confirmed" },
                    now,
                );
            }
            return { kind: "paid" };
        }
        if (!(await archivePayment(c, p.orderId, verdict))) {
            throw new Error(`payment of order ${p.orderId} is ${payment.status}, not settling`);
        }
        const late = now.getTime() >= order.expiresAt.getTime();
        // A deposit's on-time money must not go back as unpaid before the job's pinned checks
        // ran, so the deposit job or the sweeper's hard stop expires the order instead
        const deposit = late ? await lockDeposit(c, p.orderId) : null;
        const live = deposit !== null && deposit.state !== "done";
        const state = late && !live ? "expired" : "unpaid";
        await setOrderState(c, p.orderId, "settling", state);
        if (live) {
            await updateDeposit(c, p.orderId, {
                hardStopAt: new Date(now.getTime() + d.deposits.expire_hard_after),
            });
        }
        if (state === "expired" && order.allowanceMicros > 0) {
            await movePool(c, { unpaid: -order.allowanceMicros }, d.x402, d.log);
        }
        return { kind: "reverted", state };
    });
}
