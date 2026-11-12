import { signature, type Address } from "@solana/kit";
import type pg from "pg";
import type { Log } from "../log.ts";
import { usdcAta } from "../solana/accounts.ts";
import { MEMO_PROGRAM } from "../solana/constants.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";

const CHECKPOINT = "recipient_inflows";
const PAGE = 1000;
const MIN = 60_000;
const FIRST_RUN_LOOKBACK = 24 * 60 * MIN;
const CONFIRMATION_LAG = 5 * MIN;

export interface AuditReport {
    scanned: number;
    matched: number;
    mismatches: string[];
    missing: string[];
    checkpoint: string | null;
}

export interface AuditDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    recipient: Address;
    rpcTimeoutMs: number;
    log: Log;
    now: () => Date;
}

interface ParsedTx {
    meta: {
        preTokenBalances?: readonly TokenBalance[] | null;
        postTokenBalances?: readonly TokenBalance[] | null;
    } | null;
    transaction: {
        message: {
            accountKeys: readonly { pubkey: unknown }[];
            instructions: readonly { programId: unknown; parsed?: unknown }[];
        };
    };
}

interface TokenBalance {
    accountIndex: number;
    uiTokenAmount: { amount: string };
}

const UNREADABLE_RUNS = 3;
const SCAN_MARGIN = 10 * MIN;

interface SigRow {
    signature: string;
    err: unknown;
    blockTime: number | null;
}

export async function auditInflows(d: AuditDeps): Promise<AuditReport> {
    const now = d.now();
    const ata = await usdcAta(d.recipient);
    const previous = await loadCheckpoint(d.pool);
    const to = new Date(now.getTime() - CONFIRMATION_LAG);
    const from = previous?.updatedAt ?? new Date(to.getTime() - FIRST_RUN_LOOKBACK);
    const report: AuditReport = {
        scanned: 0,
        matched: 0,
        mismatches: [],
        missing: [],
        checkpoint: previous?.signature ?? null,
    };

    const rows = await listSignatures(d, ata, from.getTime() - SCAN_MARGIN);
    const seen = new Set(rows.map((r) => r.signature));
    const stop = rows.findIndex((r) => r.signature === previous?.signature);
    const fresh = stop < 0 ? rows : rows.slice(0, stop);
    for (const row of fresh) {
        if (row.err !== null) continue;
        const tx = (await d.rpc
            .getTransaction(signature(row.signature), {
                encoding: "jsonParsed",
                maxSupportedTransactionVersion: 1,
                commitment: "finalized",
            })
            .send(deadline(d.rpcTimeoutMs))) as ParsedTx | null;
        if (tx === null) {
            await skipUnreadable(d, row.signature, now);
            continue;
        }
        report.scanned++;
        const amount = inflowOf(tx, ata);
        if (amount <= 0n) continue;
        const memos = memosOf(tx);
        if (await matches(d.pool, row.signature, amount, memos)) {
            report.matched++;
            continue;
        }
        report.mismatches.push(row.signature);
        d.log.alarm("inflow_mismatch", {
            signature: row.signature,
            amountMicros: amount.toString(),
            memos,
        });
    }

    for (const p of await confirmedBetween(d.pool, from, to)) {
        if (seen.has(p.signature)) continue;
        report.missing.push(p.orderId);
        d.log.alarm("payment_missing_inflow", { orderId: p.orderId, signature: p.signature });
    }

    const newest = rows[0]?.signature ?? previous?.signature ?? null;
    await saveCheckpoint(d.pool, newest ?? "", to);
    report.checkpoint = newest;
    return report;
}

async function skipUnreadable(d: AuditDeps, sig: string, now: Date): Promise<void> {
    const prefix = `unreadable:${sig}:`;
    const rows = await d.pool.query<{ name: string }>(
        "select name from audit_checkpoints where name like $1",
        [`${prefix}%`],
    );
    if (rows.rows.some((r) => r.name === `${prefix}alarmed`)) return;
    if (rows.rowCount! + 1 < UNREADABLE_RUNS) {
        await saveCheckpoint(d.pool, sig, now, `${prefix}${now.getTime()}`);
        throw new Error(`finalized transaction ${sig} is unavailable`);
    }
    await saveCheckpoint(d.pool, sig, now, `${prefix}alarmed`);
    d.log.alarm("audit_unreadable_tx", { signature: sig, runs: rows.rowCount! + 1 });
}

async function listSignatures(
    d: Pick<AuditDeps, "rpc" | "rpcTimeoutMs">,
    ata: Address,
    oldestMs: number,
): Promise<SigRow[]> {
    const out: SigRow[] = [];
    const seen = new Set<string>();
    let before: string | null = null;
    for (;;) {
        const page: readonly {
            signature: string;
            err: unknown;
            blockTime?: bigint | number | null;
        }[] = await d.rpc
            .getSignaturesForAddress(ata, {
                limit: PAGE,
                commitment: "finalized",
                ...(before === null ? {} : { before: signature(before) }),
            })
            .send(deadline(d.rpcTimeoutMs));
        for (const r of page) {
            if (seen.has(r.signature)) continue;
            seen.add(r.signature);
            out.push({
                signature: r.signature,
                err: r.err,
                blockTime: r.blockTime == null ? null : Number(r.blockTime) * 1000,
            });
        }
        const last = page[page.length - 1];
        if (page.length < PAGE || last === undefined) return out;
        const lastTime = out[out.length - 1]!.blockTime;
        if (lastTime !== null && lastTime < oldestMs) return out;
        before = last.signature;
    }
}

function inflowOf(tx: ParsedTx, ata: Address): bigint {
    const index = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === ata);
    if (index < 0) return 0n;
    const amountAt = (list: readonly TokenBalance[] | null | undefined) => {
        const entry = list?.find((b) => b.accountIndex === index);
        return entry ? BigInt(entry.uiTokenAmount.amount) : 0n;
    };
    return amountAt(tx.meta?.postTokenBalances) - amountAt(tx.meta?.preTokenBalances);
}

function memosOf(tx: ParsedTx): string[] {
    return tx.transaction.message.instructions
        .filter((i) => i.programId === MEMO_PROGRAM && typeof i.parsed === "string")
        .map((i) => i.parsed as string);
}

async function matches(
    db: pg.Pool,
    sig: string,
    amount: bigint,
    memos: string[],
): Promise<boolean> {
    const res = await db.query<{ ok: boolean }>(
        `select true as ok from payments
         where tx_signature = $1 and amount_micros = $2 and order_id = any($3::text[])
         union all
         select true from x402_cold_transfers
         where state <> 'failed' and amount_micros = $2
           and ($1 = tx_signature or $1 = any(previous_signatures))
         union all
         -- Dust a closing deposit move kept for Bugnet lands in the recipient wallet
         select true from deposit_moves
         where state = 'confirmed' and closes and keep_micros = $2
           and ($1 = tx_signature or $1 = any(previous_signatures))`,
        [sig, amount.toString(), memos],
    );
    return res.rowCount === 1;
}

async function confirmedBetween(
    db: pg.Pool,
    from: Date,
    to: Date,
): Promise<{ orderId: string; signature: string }[]> {
    const res = await db.query<{ order_id: string; tx_signature: string }>(
        `select p.order_id, p.tx_signature from payments p
         join orders o on o.id = p.order_id
         where p.status = 'confirmed' and o.pay_into = 'cold'
           and p.confirmed_at >= $1 and p.confirmed_at < $2
         order by p.confirmed_at, p.order_id`,
        [from, to],
    );
    return res.rows.map((r) => ({ orderId: r.order_id, signature: r.tx_signature }));
}

async function loadCheckpoint(
    db: pg.Pool,
): Promise<{ signature: string | null; updatedAt: Date } | null> {
    const res = await db.query<{ signature: string; updated_at: Date }>(
        "select signature, updated_at from audit_checkpoints where name = $1",
        [CHECKPOINT],
    );
    const row = res.rows[0];
    return row
        ? { signature: row.signature === "" ? null : row.signature, updatedAt: row.updated_at }
        : null;
}

async function saveCheckpoint(
    db: pg.Pool,
    sig: string,
    at: Date,
    name = CHECKPOINT,
): Promise<void> {
    await db.query(
        `insert into audit_checkpoints (name, signature, updated_at) values ($1, $2, $3)
         on conflict (name) do update set signature = $2, updated_at = $3`,
        [name, sig, at],
    );
}
