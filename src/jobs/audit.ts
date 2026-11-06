import { signature, type Address } from "@solana/kit";
import type pg from "pg";
import type { Log } from "../log.ts";
import { usdcAta } from "../solana/accounts.ts";
import { MEMO_PROGRAM } from "../solana/constants.ts";
import type { SolanaRpc } from "../solana/rpc.ts";

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

export async function auditInflows(d: AuditDeps): Promise<AuditReport> {
    const now = d.now();
    const ata = await usdcAta(d.recipient);
    const previous = await loadCheckpoint(d.pool);
    const report: AuditReport = {
        scanned: 0,
        matched: 0,
        mismatches: [],
        missing: [],
        checkpoint: previous?.signature ?? null,
    };

    const rows = await listSignatures(d.rpc, ata, previous?.signature ?? null);
    const seen = new Set(rows.map((r) => r.signature));
    for (const row of rows) {
        if (row.err !== null) continue;
        const tx = (await d.rpc
            .getTransaction(signature(row.signature), {
                encoding: "jsonParsed",
                maxSupportedTransactionVersion: 1,
                commitment: "finalized",
            })
            .send()) as ParsedTx | null;
        if (tx === null) {
            throw new Error(`finalized transaction ${row.signature} is unavailable`);
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

    const from = previous?.updatedAt ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK);
    const to = new Date(now.getTime() - CONFIRMATION_LAG);
    for (const p of await confirmedBetween(d.pool, from, to)) {
        if (seen.has(p.signature)) continue;
        report.missing.push(p.orderId);
        d.log.alarm("payment_missing_inflow", { orderId: p.orderId, signature: p.signature });
    }

    const newest = rows[0]?.signature ?? previous?.signature ?? null;
    if (newest !== null) {
        await saveCheckpoint(d.pool, newest, now);
    }
    report.checkpoint = newest;
    return report;
}

async function listSignatures(
    rpc: SolanaRpc,
    ata: Address,
    until: string | null,
): Promise<{ signature: string; err: unknown }[]> {
    const out: { signature: string; err: unknown }[] = [];
    const seen = new Set<string>();
    let before: string | null = null;
    for (;;) {
        const page = await rpc
            .getSignaturesForAddress(ata, {
                limit: PAGE,
                commitment: "finalized",
                ...(before === null ? {} : { before: signature(before) }),
                ...(until === null ? {} : { until: signature(until) }),
            })
            .send();
        for (const r of page) {
            if (seen.has(r.signature)) continue;
            seen.add(r.signature);
            out.push({ signature: r.signature, err: r.err });
        }
        if (page.length < PAGE || until === null) return out;
        before = page[page.length - 1]!.signature;
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
         where tx_signature = $1 and amount_micros = $2 and order_id = any($3::text[])`,
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
        `select order_id, tx_signature from payments
         where status = 'confirmed' and confirmed_at >= $1 and confirmed_at < $2
         order by confirmed_at, order_id`,
        [from, to],
    );
    return res.rows.map((r) => ({ orderId: r.order_id, signature: r.tx_signature }));
}

async function loadCheckpoint(db: pg.Pool): Promise<{ signature: string; updatedAt: Date } | null> {
    const res = await db.query<{ signature: string; updated_at: Date }>(
        "select signature, updated_at from audit_checkpoints where name = $1",
        [CHECKPOINT],
    );
    const row = res.rows[0];
    return row ? { signature: row.signature, updatedAt: row.updated_at } : null;
}

async function saveCheckpoint(db: pg.Pool, sig: string, now: Date): Promise<void> {
    await db.query(
        `insert into audit_checkpoints (name, signature, updated_at) values ($1, $2, $3)
         on conflict (name) do update set signature = $2, updated_at = $3`,
        [CHECKPOINT, sig, now],
    );
}
