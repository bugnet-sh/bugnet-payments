import { signature } from "@solana/kit";
import type pg from "pg";
import { withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import {
    archivePayment,
    confirmPayment,
    lockOrder,
    lockPayment,
    setOrderState,
} from "../orders/store.ts";
import type { SolanaRpc } from "../solana/rpc.ts";

export interface ReconcileDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    log: Log;
    now: () => Date;
}

export interface ReconcileReport {
    paid: number;
    reverted: number;
    waiting: number;
}

interface Candidate {
    orderId: string;
    txSignature: string;
    lastValidBlockHeight: bigint;
}

type Verdict = "landed" | "onchain_failed" | "blockhash_expired" | "waiting";

type Outcome =
    { kind: "paid" } | { kind: "reverted"; state: "unpaid" | "expired" } | { kind: "changed" };

export async function reconcileSettling(d: ReconcileDeps): Promise<ReconcileReport> {
    const report: ReconcileReport = { paid: 0, reverted: 0, waiting: 0 };
    for (const p of await candidates(d.pool, d.now())) {
        let verdict: Verdict;
        try {
            verdict = await verdictFor(d.rpc, p);
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
            outcome = await apply(d, p, verdict);
        } catch (err) {
            d.log.error("reconcile step failed, retrying next run", { orderId: p.orderId, err });
            report.waiting++;
            continue;
        }
        const fields = { orderId: p.orderId, signature: p.txSignature };
        if (outcome.kind === "paid") {
            report.paid++;
            d.log.info("settling payment landed, order paid", fields);
        } else if (outcome.kind === "reverted") {
            report.reverted++;
            d.log.info("settling payment did not land", {
                ...fields,
                reason: verdict,
                state: outcome.state,
            });
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
         order by p.created_at, p.order_id`,
        [now],
    );
    return res.rows.map((r) => ({
        orderId: r.order_id,
        txSignature: r.tx_signature,
        lastValidBlockHeight: BigInt(r.last_valid_block_height),
    }));
}

async function verdictFor(rpc: SolanaRpc, p: Candidate): Promise<Verdict> {
    // Read before the status, so a transaction that landed before expiry is final when it is read
    const height = await rpc.getBlockHeight({ commitment: "finalized" }).send();
    const {
        value: [status],
    } = await rpc
        .getSignatureStatuses([signature(p.txSignature)], { searchTransactionHistory: true })
        .send();
    if (status) {
        // A processed-only result can still be dropped with its fork, so it decides nothing
        if (
            status.confirmationStatus !== "confirmed" &&
            status.confirmationStatus !== "finalized"
        ) {
            return "waiting";
        }
        return status.err === null ? "landed" : "onchain_failed";
    }
    return height > p.lastValidBlockHeight ? "blockhash_expired" : "waiting";
}

async function apply(
    d: ReconcileDeps,
    p: Candidate,
    verdict: Exclude<Verdict, "waiting">,
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
            await setOrderState(c, p.orderId, "settling", "paid", { paidAt: payment.createdAt });
            return { kind: "paid" };
        }
        if (!(await archivePayment(c, p.orderId, verdict))) {
            throw new Error(`payment of order ${p.orderId} is ${payment.status}, not settling`);
        }
        const state = now.getTime() >= order.expiresAt.getTime() ? "expired" : "unpaid";
        await setOrderState(c, p.orderId, "settling", state);
        return { kind: "reverted", state };
    });
}
