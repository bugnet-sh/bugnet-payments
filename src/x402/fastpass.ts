import { createHash } from "node:crypto";
import { type Address, getBase58Encoder, signature as toSignature } from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import type { Queryable } from "../db/pool.ts";
import type { Log } from "../log.ts";
import { deadline, rpcErrorFields, type SolanaRpc } from "../solana/rpc.ts";
import { parseChainTx } from "./match.ts";

export interface FastPassDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    hotTokenAccount: Address;
    x402: Settings["x402"];
    log: Log;
    now: () => Date;
    rpcTimeoutMs: number;
}

interface OpenRow {
    id: string;
    accountId: string;
    serviceId: string;
    signatureHash: string;
    signingSlot: bigint | null;
    hintTx: string | null;
}

// Hints already read once and found not to carry our signature, so a row's hint is held against
// its service one time only. Bounded: a restart or a clear costs one repeated read.
const JUDGED_LIMIT = 10_000;
const judged = new Set<string>();

// A hint the node does not know yet may simply not have propagated; it is read again only after
// this wait, so the 5 s runs do not hammer the RPC with it.
const NULL_HINT_RETRY_MS = 60_000;
const nullHintReadAt = new Map<string, number>();

const sha256Hex = (signature: string): string =>
    createHash("sha256")
        .update(Buffer.from(getBase58Encoder().encode(signature)))
        .digest("hex");

export async function fastPassNeeded(db: Queryable): Promise<boolean> {
    const res = await db.query<{ needed: boolean }>(
        `select exists (select 1 from x402_payments
            where state = 'signed' and landed_slot is null) as needed`,
    );
    return res.rows[0]!.needed;
}

async function readOpenRows(db: Queryable): Promise<OpenRow[]> {
    const res = await db.query<{
        id: string;
        account_id: string;
        service_id: string;
        sig_hash: string | null;
        signing_slot: string | null;
        hint_tx: string | null;
    }>(
        `select id, account_id, service_id, encode(our_signature_sha256, 'hex') as sig_hash,
            signing_slot, hint_tx
         from x402_payments where state = 'signed' and landed_slot is null order by created_at`,
    );
    return res.rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        serviceId: r.service_id,
        signatureHash: r.sig_hash ?? "",
        signingSlot: r.signing_slot === null ? null : BigInt(r.signing_slot),
        hintTx: r.hint_tx,
    }));
}

// Finds our signed payments on the chain early enough to free their open-payment places. It
// only records where a payment landed; the mirror confirms, expires and releases.
export async function runFastPass(
    d: FastPassDeps,
): Promise<{ landed: number; ignoredHints: number }> {
    if (!(await fastPassNeeded(d.pool))) return { landed: 0, ignoredHints: 0 };
    let open = await readOpenRows(d.pool);
    if (open.length === 0) return { landed: 0, ignoredHints: 0 };

    const listing = await d.rpc
        .getSignaturesForAddress(d.hotTokenAccount, {
            commitment: "confirmed",
            limit: d.x402.fast_pass_limit,
        })
        .send(deadline(d.rpcTimeoutMs));

    const hints = [...new Set(open.map((r) => r.hintTx).filter((h): h is string => h !== null))];
    const hintSet = new Set(hints);
    const windowStart = open.reduce<bigint | null>(
        (low, r) =>
            r.signingSlot !== null && (low === null || r.signingSlot < low) ? r.signingSlot : low,
        null,
    );
    const known = await d.pool.query<{ signature: string }>(
        `select signature from x402_chain_txs where signature = any($1::text[])
         union select tx_signature from x402_payments where tx_signature = any($1::text[])`,
        [listing.map((e) => e.signature)],
    );
    const seen = new Set(known.rows.map((r) => r.signature));
    const fromListing =
        windowStart === null
            ? []
            : listing
                  .filter((e) => e.slot >= windowStart && !seen.has(e.signature))
                  .map((e) => e.signature)
                  .filter((s) => !hintSet.has(s));
    const nowMs = d.now().getTime();
    const candidates = [
        ...hints.filter(
            (h) =>
                !judged.has(h) &&
                nowMs - (nullHintReadAt.get(h) ?? -Infinity) >= NULL_HINT_RETRY_MS,
        ),
        ...fromListing,
    ];

    let landed = 0;
    let ignoredHints = 0;
    for (const sig of candidates) {
        if (open.length === 0) break;
        const isHint = hintSet.has(sig);
        let tx: ReturnType<typeof parseChainTx>;
        try {
            const raw = await d.rpc
                .getTransaction(toSignature(sig), {
                    commitment: "confirmed",
                    encoding: "base64",
                    maxSupportedTransactionVersion: 0,
                })
                .send(deadline(d.rpcTimeoutMs));
            if (raw === null) {
                if (isHint) {
                    if (nullHintReadAt.size >= JUDGED_LIMIT) nullHintReadAt.clear();
                    nullHintReadAt.set(sig, nowMs);
                }
                continue;
            }
            tx = parseChainTx(sig, raw.slot, raw, d.hotTokenAccount);
        } catch (err) {
            d.log.warn("x402 fast pass skipped a transaction it could not read", {
                signature: sig,
                ...rpcErrorFields(err),
            });
            continue;
        }
        const hashes = new Set(tx.signatures.map(sha256Hex));
        const matched = open.filter((r) => hashes.has(r.signatureHash));
        for (const row of matched) {
            const res = await d.pool.query(
                `update x402_payments set landed_slot = $2, tx_signature = $3
                 where id = $1 and state = 'signed' and landed_slot is null`,
                [row.id, tx.slot.toString(), tx.signatures[0]],
            );
            landed += res.rowCount ?? 0;
        }
        const matchedIds = new Set(matched.map((r) => r.id));
        open = open.filter((r) => !matchedIds.has(r.id));
        if (!isHint) continue;
        const naming = [...matched, ...open].filter((r) => r.hintTx === sig);
        if (naming.some((r) => matchedIds.has(r.id))) continue;
        const services = new Map(naming.map((r) => [`${r.accountId}/${r.serviceId}`, r]));
        const client = await d.pool.connect();
        try {
            await client.query("begin");
            for (const row of services.values()) {
                await client.query(
                    `update x402_services set failures = failures + 1
                     where account_id = $1 and service_id = $2`,
                    [row.accountId, row.serviceId],
                );
            }
            await client.query("commit");
        } catch (err) {
            await client.query("rollback").catch(() => undefined);
            throw err;
        } finally {
            client.release();
        }
        nullHintReadAt.delete(sig);
        if (judged.size >= JUDGED_LIMIT) judged.clear();
        judged.add(sig);
        ignoredHints++;
    }
    return { landed, ignoredHints };
}
