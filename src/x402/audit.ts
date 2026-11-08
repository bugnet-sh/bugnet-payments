import { signature as toSignature, type Address } from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import type { Log } from "../log.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";
import { readPool } from "./ledger.ts";
import { bugnetMoneyAt, liabilitiesAt, unsettledColdTransfersAt } from "./liabilities.ts";
import { parseChainTx } from "./match.ts";
import { readTail } from "./tail.ts";

const CHECKPOINT = "x402_audit";
const BASE_FEE_LAMPORTS = 5_000n;

export interface X402AuditDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    hotTokenAccount: Address;
    x402: Settings["x402"];
    rpcTimeoutMs: number;
    log: Log;
    now: () => Date;
}

export interface X402AuditReport {
    checked: number;
    mismatches: string[];
    driftMicros: number;
}

// A hot refund or cold transfer is two signatures (our fee payer and the allowance wallet), plus
// the priority fee at the configured compute budget.
export function hotFeeLamports(refunds: Settings["refunds"]): bigint {
    const priority =
        BigInt(refunds.compute_unit_limit) * BigInt(refunds.compute_unit_price_micro_lamports);
    return BASE_FEE_LAMPORTS * 2n + (priority + 999_999n) / 1_000_000n;
}

interface AuditRow {
    kind: "payment" | "refund" | "cold";
    id: string;
    signature: string;
    landedSlot: bigint;
    amount: bigint;
    payee: string | null;
}

export async function auditX402(d: X402AuditDeps): Promise<X402AuditReport> {
    const tail = await readTail(d.pool);
    const report: X402AuditReport = { checked: 0, mismatches: [], driftMicros: 0 };
    const v = tail.verifiedSlot;

    const checkpoint = await loadCheckpoint(d.pool, tail.openingSlot);
    for (const row of await rowsOnChain(d.pool, checkpoint, v)) {
        report.checked++;
        if (await onChain(d, row)) continue;
        report.mismatches.push(`${row.kind} ${row.id}`);
        d.log.alarm("x402_audit_mismatch", {
            kind: row.kind,
            id: row.id,
            signature: row.signature,
        });
    }
    if (v > checkpoint) await saveCheckpoint(d.pool, v, d.now());

    if (tail.tokenAccount !== null && tail.verifiedAt !== null) {
        const chain = await chainBalanceAt(d.pool, v, tail.openingBalanceMicros, tail.openingSlot);
        const ledger =
            (await liabilitiesAt(d.pool, v, tail)) +
            (await bugnetMoneyAt(d.pool, v, tail)) +
            (await unsettledColdTransfersAt(d.pool, v)) +
            (await ledgerAdjustments(d.pool, v, tail.openingSlot, tail.openedAt!));
        if (chain !== ledger) {
            report.mismatches.push(`balance ${chain} != ${ledger}`);
            d.log.alarm("x402_audit_mismatch", {
                kind: "balance",
                chainMicros: chain,
                ledgerMicros: ledger,
                verifiedSlot: v,
            });
        }
    }

    const stored = (await readPool(d.pool)).committedMicros;
    const recomputed = await recomputeCommitted(d.pool);
    report.driftMicros = stored - recomputed;
    if (report.driftMicros !== 0) {
        d.log.alarm("x402_pool_drift", { storedMicros: stored, recomputedMicros: recomputed });
    }
    return report;
}

async function rowsOnChain(db: pg.Pool, from: bigint, to: bigint): Promise<AuditRow[]> {
    const res = await db.query<{
        kind: AuditRow["kind"];
        id: string;
        signature: string;
        landed_slot: string;
        amount: string;
        payee: string | null;
    }>(
        `select kind, id, signature, landed_slot, amount, payee from (
            select 'payment' as kind, id, tx_signature as signature, landed_slot,
                amount_micros as amount, pay_to_token_account as payee
            from x402_payments where state = 'confirmed'
            union all
            select 'refund', id::text, tx_signature, landed_slot, amount_micros, destination
            from refunds where from_wallet = 'allowance' and state = 'confirmed'
            union all
            select 'cold', id::text, tx_signature, landed_slot, amount_micros, null
            from x402_cold_transfers where state = 'confirmed'
         ) t
         where signature is not null and landed_slot > $1 and landed_slot <= $2
         order by landed_slot, kind, id`,
        [from.toString(), to.toString()],
    );
    return res.rows.map((r) => ({
        kind: r.kind,
        id: r.id,
        signature: r.signature,
        landedSlot: BigInt(r.landed_slot),
        amount: BigInt(r.amount),
        payee: r.payee,
    }));
}

async function onChain(d: X402AuditDeps, row: AuditRow): Promise<boolean> {
    const raw = await d.rpc
        .getTransaction(toSignature(row.signature), {
            commitment: "finalized",
            encoding: "base64",
            maxSupportedTransactionVersion: 0,
        })
        .send(deadline(d.rpcTimeoutMs));
    if (raw === null) return false;
    const tx = parseChainTx(row.signature, row.landedSlot, raw, d.hotTokenAccount);
    if (tx.failed || tx.tokenDeltas.get(d.hotTokenAccount) !== -row.amount) return false;
    return row.payee === null || tx.tokenDeltas.get(row.payee) === row.amount;
}

async function chainBalanceAt(
    db: pg.Pool,
    v: bigint,
    opening: bigint,
    openingSlot: bigint,
): Promise<bigint> {
    const res = await db.query<{ micros: string }>(
        `select coalesce(sum(delta_micros), 0) as micros from x402_chain_txs
         where slot > $1 and slot <= $2 and not failed`,
        [openingSlot.toString(), v.toString()],
    );
    return opening + BigInt(res.rows[0]!.micros);
}

// What the stored history holds that the ledger functions do not: late order inflows and dust
// received, hand-resolved hot refunds, and losses already booked as incidents.
async function ledgerAdjustments(
    db: pg.Pool,
    v: bigint,
    openingSlot: bigint,
    openedAt: Date,
): Promise<bigint> {
    const res = await db.query<{ micros: string }>(
        `select
            (select coalesce(sum(t.delta_micros), 0) from x402_chain_txs t
                where t.slot > $1 and t.slot <= $2 and not t.failed and t.matched = 'order'
                  and not exists (select 1 from payments p
                        where p.tx_signature = t.signature and p.status = 'confirmed'))
            + (select coalesce(sum(delta_micros), 0) from x402_chain_txs
                where slot > $1 and slot <= $2 and not failed and matched = 'inflow')
            + (select coalesce(sum(amount_micros), 0) from refunds
                where from_wallet = 'allowance' and manual_reason = 'resolved_by_hand'
                  and confirmed_at >= $3)
            - (select coalesce(sum(loss_micros), 0) from x402_incidents where created_at >= $3)
            as micros`,
        [openingSlot.toString(), v.toString(), openedAt],
    );
    return BigInt(res.rows[0]!.micros);
}

async function recomputeCommitted(db: pg.Pool): Promise<number> {
    const res = await db.query<{ micros: string }>(
        `select
            (select coalesce(sum(funded_micros - spent_micros - refunded_micros - kept_micros), 0)
                from x402_accounts where state <> 'closed')
            + (select coalesce(sum(amount_micros), 0) from refunds
                where kind = 'allowance' and state <> 'confirmed'
                  and manual_reason is distinct from 'resolved_by_hand')
            as micros`,
    );
    return Number(res.rows[0]!.micros);
}

async function loadCheckpoint(db: pg.Pool, openingSlot: bigint): Promise<bigint> {
    const res = await db.query<{ signature: string }>(
        "select signature from audit_checkpoints where name = $1",
        [CHECKPOINT],
    );
    const text = res.rows[0]?.signature;
    return text === undefined || text === "" ? openingSlot : BigInt(text);
}

async function saveCheckpoint(db: pg.Pool, slot: bigint, at: Date): Promise<void> {
    await db.query(
        `insert into audit_checkpoints (name, signature, updated_at) values ($1, $2, $3)
         on conflict (name) do update set signature = $2, updated_at = $3`,
        [CHECKPOINT, slot.toString(), at],
    );
}
