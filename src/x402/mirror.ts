import { type Address, signature as toSignature } from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx, type Queryable } from "../db/pool.ts";
import type { Log } from "../log.ts";
import { setPaymentLandedSlot } from "../orders/store.ts";
import { readTokenAccount, type TokenAccountInfo } from "../solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "../solana/constants.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";
import { recordIncident, type IncidentFact } from "./incidents.ts";
import { liabilitiesAt } from "./liabilities.ts";
import { alarmUnresolved, applyExpiry, parseChainTx, matchInTx, type MatchDeps } from "./match.ts";
import type { SignerGate } from "./listener.ts";
import {
    advanceVerified,
    raiseFinalizedHeight,
    readTail,
    setMismatchSince,
    type Tail,
} from "./tail.ts";

export interface MirrorDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    allowanceWallet: Address;
    hotTokenAccount: Address;
    coldTokenAccount: Address;
    x402: Settings["x402"];
    gate: SignerGate;
    log: Log;
    now: () => Date;
    rpcTimeoutMs: number;
}

export interface MirrorRun {
    verified: boolean;
    c0: bigint;
    h0: bigint;
    c: bigint;
    stored: number;
    reason?: "backlog" | "balance" | "known_missing" | "rpc" | "token_account";
}

class RpcFailure extends Error {}

let lagAlarmed = false;

const MAX_LIST_PAGES = 10;

interface Segment {
    before?: string;
    until?: string;
}

// Where listing stopped when a run spent its pages; held in memory, so a restart lists afresh
interface Cursor {
    openingSlot: bigint;
    newest: string | null;
    segments: Segment[];
    // Every signature listed so far this cycle, so the run that completes the listing still knows
    // the ones listed by earlier runs
    seen: Set<string>;
}

let cursor: Cursor | null = null;

export function resetMirrorState(): void {
    lagAlarmed = false;
    cursor = null;
}

async function rpcCall<T>(
    d: MirrorDeps,
    call: (abort: { abortSignal: AbortSignal }) => Promise<T>,
) {
    try {
        return await call(deadline(d.rpcTimeoutMs));
    } catch (err) {
        d.log.warn("x402 mirror rpc call failed", {
            err: err instanceof Error ? err.name : "error",
        });
        throw new RpcFailure();
    }
}

const raise = (d: MirrorDeps, f: IncidentFact) =>
    withTx(d.pool, (c) => recordIncident(c, f, d.log, d.now()), d.log);

// Live check 5 (7.3): the field that fails, or null
function tokenAccountProblem(info: TokenAccountInfo, d: MirrorDeps): string | null {
    if (info.programOwner !== TOKEN_PROGRAM) return "programOwner";
    if (info.mint !== USDC_MINT) return "mint";
    if (info.state !== "initialized") return "state";
    if (info.owner !== d.allowanceWallet) return "owner";
    if (info.delegate !== null) return "delegate";
    if (info.closeAuthority !== null) return "closeAuthority";
    return null;
}

async function reportTokenAccount(d: MirrorDeps, problem: string): Promise<void> {
    await raise(d, {
        kind: "token_account_changed",
        subject: "token_account_changed",
        detail: { tokenAccount: d.hotTokenAccount, problem },
    });
    d.gate.record("token_account", "fail", problem);
}

interface Window {
    from: bigint;
    to: bigint | null;
}

// The rows whose transactions the mirror must see: signed payments, and allowance refunds and
// cold transfers signed or sent. A row without a signing_slot is left out.
async function openWindows(db: Queryable): Promise<Window[]> {
    const res = await db.query<{ signing_slot: string; expiry_seen_slot: string | null }>(
        `select signing_slot, expiry_seen_slot from x402_payments
            where state = 'signed' and signing_slot is not null
         union all
         select signing_slot, expiry_seen_slot from refunds
            where from_wallet = 'allowance' and state in ('signed', 'sent')
              and signing_slot is not null
         union all
         select signing_slot, expiry_seen_slot from x402_cold_transfers
            where state in ('signed', 'sent') and signing_slot is not null`,
    );
    return res.rows.map((r) => ({
        from: BigInt(r.signing_slot),
        to: r.expiry_seen_slot === null ? null : BigInt(r.expiry_seen_slot),
    }));
}

interface Listed {
    signature: string;
    slot: bigint;
}

interface Listing {
    listed: Listed[];
    listedEver: ReadonlySet<string>;
    complete: boolean;
}

// Newest first, at most MAX_LIST_PAGES pages per run. An unfinished run leaves the older part
// (and, next time, the newer part since the newest signature seen) as segments to continue.
async function listSignatures(
    d: MirrorDeps,
    tail: Tail,
    c: bigint,
    lower: bigint,
): Promise<Listing> {
    const limit = d.x402.mirror_page_size;
    const cur = cursor !== null && cursor.openingSlot === tail.openingSlot ? cursor : null;
    const queue: Segment[] = [cur?.newest ? { until: cur.newest } : {}, ...(cur?.segments ?? [])];
    const out: Listed[] = [];
    const seen = new Set(cur?.seen);
    let newest = cur?.newest ?? null;
    for (let pages = 0; queue.length > 0 && pages < MAX_LIST_PAGES; pages++) {
        const seg = queue[0]!;
        const page = await rpcCall(d, (abort) =>
            d.rpc
                .getSignaturesForAddress(d.hotTokenAccount, {
                    commitment: "finalized",
                    minContextSlot: c,
                    limit,
                    ...(seg.before === undefined ? {} : { before: toSignature(seg.before) }),
                    ...(seg.until === undefined ? {} : { until: toSignature(seg.until) }),
                })
                .send(abort),
        );
        if (pages === 0 && page[0] !== undefined) newest = page[0].signature;
        for (const e of page) {
            out.push({ signature: e.signature, slot: e.slot });
            seen.add(e.signature);
        }
        const last = page[page.length - 1];
        if (page.length < limit || last === undefined || last.slot < lower) queue.shift();
        else queue[0] = { ...seg, before: last.signature };
    }
    const complete = queue.length === 0;
    cursor = complete ? null : { openingSlot: tail.openingSlot, newest, segments: queue, seen };
    return { listed: out, listedEver: seen, complete };
}

async function storedSignatures(
    db: Queryable,
    signatures: readonly string[],
): Promise<Set<string>> {
    if (signatures.length === 0) return new Set();
    const res = await db.query<{ signature: string }>(
        "select signature from x402_chain_txs where signature = any($1::text[])",
        [signatures],
    );
    return new Set(res.rows.map((r) => r.signature));
}

interface Known {
    signatures: string[];
    landedSlot: bigint | null;
    confirmedAt: Date;
    orderId?: string;
    refundId?: number;
    coldTransferId?: number;
}

async function knownTransactions(db: Queryable, openedAt: Date): Promise<Known[]> {
    const payments = await db.query<{
        order_id: string;
        tx_signature: string;
        landed_slot: string | null;
        confirmed_at: Date;
    }>(
        `select p.order_id, p.tx_signature, p.landed_slot, p.confirmed_at
         from payments p join orders o on o.id = p.order_id
         where o.pay_into = 'allowance' and p.status = 'confirmed' and p.confirmed_at > $1`,
        [openedAt],
    );
    const refunds = await db.query<{
        id: string;
        tx_signature: string;
        previous_signatures: string[];
        landed_slot: string | null;
        confirmed_at: Date;
    }>(
        `select id, tx_signature, previous_signatures, landed_slot, confirmed_at from refunds
         where from_wallet = 'allowance' and state = 'confirmed' and confirmed_at > $1`,
        [openedAt],
    );
    const cold = await db.query<{
        id: string;
        tx_signature: string;
        previous_signatures: string[];
        landed_slot: string | null;
        confirmed_at: Date;
    }>(
        `select id, tx_signature, previous_signatures, landed_slot, confirmed_at
         from x402_cold_transfers where state = 'confirmed' and confirmed_at > $1`,
        [openedAt],
    );
    const slot = (v: string | null) => (v === null ? null : BigInt(v));
    return [
        ...payments.rows.map((r) => ({
            signatures: [r.tx_signature],
            landedSlot: slot(r.landed_slot),
            confirmedAt: r.confirmed_at,
            orderId: r.order_id,
        })),
        ...refunds.rows.map((r) => ({
            signatures: [...r.previous_signatures, r.tx_signature],
            landedSlot: slot(r.landed_slot),
            confirmedAt: r.confirmed_at,
            refundId: Number(r.id),
        })),
        ...cold.rows.map((r) => ({
            signatures: [...r.previous_signatures, r.tx_signature],
            landedSlot: slot(r.landed_slot),
            confirmedAt: r.confirmed_at,
            coldTransferId: Number(r.id),
        })),
    ];
}

function gapIncident(k: Known, detail: Record<string, unknown>): IncidentFact {
    const signature = k.signatures[k.signatures.length - 1]!;
    return {
        kind: "mirror_gap",
        subject: signature,
        ...(k.refundId === undefined ? {} : { refundId: k.refundId }),
        ...(k.coldTransferId === undefined ? {} : { coldTransferId: k.coldTransferId }),
        detail: { signature, ...detail },
    };
}

// True while a known transaction is not yet in the stored history. Only a transaction that is
// neither stored nor listed, after listing reached the tip, is a gap: a listed one is waiting in
// the backlog.
async function checkKnown(
    d: MirrorDeps,
    tail: Tail,
    c: bigint,
    listed: ReadonlySet<string>,
    complete: boolean,
): Promise<boolean> {
    const known = await knownTransactions(d.pool, tail.openedAt ?? new Date(0));
    const after = d.x402.balance_mismatch_after;
    const rescan = BigInt(d.x402.mirror_rescan_slots);
    let missing = false;
    const due: Known[] = [];
    for (const k of known) {
        if (k.landedSlot === null && k.orderId !== undefined) {
            const sig = k.signatures[0]!;
            const statuses = await rpcCall(d, (abort) =>
                d.rpc
                    .getSignatureStatuses([toSignature(sig)], { searchTransactionHistory: true })
                    .send(abort),
            );
            const found = statuses.value[0];
            const status = found?.confirmationStatus;
            if (
                found === null ||
                found === undefined ||
                !(status === "confirmed" || status === "finalized")
            ) {
                missing = true;
                if (d.now().getTime() - k.confirmedAt.getTime() > after) {
                    await raise(
                        d,
                        gapIncident(k, { orderId: k.orderId, problem: "status_not_found" }),
                    );
                }
                continue;
            }
            await setPaymentLandedSlot(d.pool, k.orderId, found.slot);
            k.landedSlot = found.slot;
        }
        if (k.landedSlot === null) continue;
        if (k.landedSlot <= tail.openingSlot || k.landedSlot > c) continue;
        due.push(k);
    }
    if (due.length === 0) return missing;
    const unstored = await unstoredIndexes(d.pool, due);
    for (const i of unstored) {
        const k = due[i]!;
        missing = true;
        if (!complete || k.signatures.some((s) => listed.has(s))) continue;
        if (k.landedSlot! <= c - rescan) {
            await raise(
                d,
                gapIncident(k, { landedSlot: k.landedSlot!.toString(), problem: "unstored" }),
            );
        }
    }
    return missing;
}

// The positions in `known` none of whose signatures is stored
async function unstoredIndexes(db: Queryable, known: readonly Known[]): Promise<number[]> {
    const positions: number[] = [];
    const signatures: string[] = [];
    known.forEach((k, i) => {
        for (const s of k.signatures) {
            positions.push(i);
            signatures.push(s);
        }
    });
    const res = await db.query<{ i: number }>(
        `select k.i from generate_series(0, $3::int - 1) as k(i)
         where not exists (
            select 1 from unnest($1::int[], $2::text[]) as s(i, sig)
            join x402_chain_txs t on t.signature = s.sig where s.i = k.i)
         order by k.i`,
        [positions, signatures, known.length],
    );
    return res.rows.map((r) => r.i);
}

async function ledgerBalance(db: Queryable, tail: Tail, c: bigint): Promise<bigint> {
    const res = await db.query<{ sum: string }>(
        `select coalesce(sum(delta_micros), 0) as sum from x402_chain_txs
         where slot > $1 and slot <= $2`,
        [tail.openingSlot.toString(), c.toString()],
    );
    return tail.openingBalanceMicros + BigInt(res.rows[0]!.sum);
}

async function noteLag(d: MirrorDeps, tail: Tail): Promise<void> {
    if (lagAlarmed || tail.verifiedAt === null) return;
    const lagMs = d.now().getTime() - tail.verifiedAt.getTime();
    if (lagMs <= d.x402.tail_lag_alarm_after) return;
    lagAlarmed = true;
    d.log.alarm("x402_tail_lag", { verifiedAt: tail.verifiedAt.toISOString(), lagMs });
}

interface Progress {
    h0: bigint;
    c0: bigint;
    c: bigint;
    stored: number;
}

async function mirror(d: MirrorDeps, md: MatchDeps, tail: Tail, p: Progress): Promise<MirrorRun> {
    const hot = d.hotTokenAccount;
    const epoch = await rpcCall(d, (abort) =>
        d.rpc.getEpochInfo({ commitment: "finalized" }).send(abort),
    );
    p.h0 = epoch.blockHeight;
    p.c0 = epoch.absoluteSlot;
    await raiseFinalizedHeight(d.pool, p.h0);

    let read;
    try {
        read = await rpcCall(d, (abort) =>
            readTokenAccount(d.rpc, hot, {
                commitment: "finalized",
                minContextSlot: p.c0,
                abortSignal: abort.abortSignal,
            }),
        );
    } catch (err) {
        d.gate.record("token_account", "error");
        throw err;
    }
    if (read.contextSlot === null || read.contextSlot < p.c0) throw new RpcFailure();
    const info = read.info;
    if (info === null) {
        await reportTokenAccount(d, "missing");
        return { verified: false, ...p, reason: "token_account" };
    }
    const problem = tokenAccountProblem(info, d);
    if (problem === null) d.gate.record("token_account", "pass");
    else await reportTokenAccount(d, problem);
    p.c = info.contextSlot;

    const windows = await openWindows(d.pool);
    const floor = tail.verifiedSlot - BigInt(d.x402.mirror_rescan_slots);
    const lowest = windows.reduce((m, w) => (w.from < m ? w.from : m), floor);
    const lower = lowest > tail.openingSlot + 1n ? lowest : tail.openingSlot + 1n;
    const { listed, listedEver, complete } = await listSignatures(d, tail, p.c, lower);
    const inRange = listed.filter((e) => e.slot >= lower && e.slot <= p.c);
    const have = await storedSignatures(
        d.pool,
        inRange.map((e) => e.signature),
    );
    const kept = inRange.filter((e) => !have.has(e.signature));

    const inside = (e: Listed) => windows.some((w) => e.slot >= w.from && e.slot <= (w.to ?? p.c));
    const order = [...kept.filter(inside), ...kept.filter((e) => !inside(e)).reverse()].slice(
        0,
        d.x402.mirror_page_size,
    );
    for (const e of order) {
        const raw = await rpcCall(d, (abort) =>
            d.rpc
                .getTransaction(toSignature(e.signature), {
                    commitment: "finalized",
                    encoding: "base64",
                    maxSupportedTransactionVersion: 0,
                })
                .send(abort),
        );
        if (raw === null) continue;
        const tx = parseChainTx(e.signature, raw.slot, raw, hot);
        await matchInTx(d.pool, tx, md);
        p.stored++;
    }
    const backlog = !complete || kept.length > p.stored;

    const knownMissing = await checkKnown(d, tail, p.c, listedEver, complete);
    const ledger = await ledgerBalance(d.pool, tail, p.c);
    const differs = ledger !== info.amount;

    if (!backlog && !knownMissing && !differs) {
        await advanceVerified(d.pool, p.c, d.now());
        if (tail.mismatchSince !== null) await setMismatchSince(d.pool, null);
        await applyExpiry(d.pool, d.rpc, { h0: p.h0, c0: p.c0, verifiedSlot: p.c }, md);
        const owed = await liabilitiesAt(d.pool, p.c, tail);
        if (owed > info.amount) {
            await raise(d, {
                kind: "balance_short",
                subject: "balance_short",
                lossMicros: Number(owed - info.amount),
                detail: {
                    slot: p.c.toString(),
                    balanceMicros: info.amount.toString(),
                    liabilitiesMicros: owed.toString(),
                },
            });
        }
        lagAlarmed = false;
        return { verified: true, ...p };
    }

    if (!backlog) {
        if (differs) {
            const since = tail.mismatchSince ?? d.now();
            if (tail.mismatchSince === null) await setMismatchSince(d.pool, since);
            if (d.now().getTime() - since.getTime() >= d.x402.balance_mismatch_after) {
                await raise(d, {
                    kind: "balance_mismatch",
                    subject: "balance_mismatch",
                    detail: {
                        slot: p.c.toString(),
                        chainMicros: info.amount.toString(),
                        ledgerMicros: ledger.toString(),
                    },
                });
            }
        } else if (tail.mismatchSince !== null) {
            await setMismatchSince(d.pool, null);
        }
    }
    const reason = backlog ? "backlog" : knownMissing ? "known_missing" : "balance";
    return { verified: false, ...p, reason };
}

export async function runMirror(d: MirrorDeps): Promise<MirrorRun> {
    const md: MatchDeps = {
        x402: d.x402,
        hotTokenAccount: d.hotTokenAccount,
        coldTokenAccount: d.coldTokenAccount,
        log: d.log,
        now: d.now,
        rpcTimeoutMs: d.rpcTimeoutMs,
    };
    await alarmUnresolved(d.pool, md);
    const tail = await readTail(d.pool);
    const p: Progress = { h0: 0n, c0: 0n, c: 0n, stored: 0 };
    let run: MirrorRun;
    if (tail.tokenAccount === null || tail.tokenAccount !== d.hotTokenAccount) {
        if (tail.tokenAccount !== null) {
            d.log.warn("x402 mirror: the tail's token account is not the configured hot account", {
                tail: tail.tokenAccount,
                configured: d.hotTokenAccount,
            });
        }
        run = { verified: false, ...p, reason: "token_account" };
    } else {
        try {
            run = await mirror(d, md, tail, p);
        } catch (err) {
            if (!(err instanceof RpcFailure)) {
                await noteLag(d, tail);
                throw err;
            }
            run = { verified: false, ...p, reason: "rpc" };
        }
    }
    if (!run.verified) await noteLag(d, tail);
    return run;
}

// A row reserved or signed, an account closing, a hot order settling, a hot refund or a cold
// transfer signed or sent
export async function mirrorBusy(db: Queryable): Promise<boolean> {
    const res = await db.query<{ busy: boolean }>(
        `select
            exists (select 1 from x402_payments where state in ('reserved', 'signed'))
            or exists (select 1 from x402_accounts where state = 'closing')
            or exists (select 1 from orders where pay_into = 'allowance' and state = 'settling')
            or exists (select 1 from refunds
                where from_wallet = 'allowance' and state in ('signed', 'sent'))
            or exists (select 1 from x402_cold_transfers where state in ('signed', 'sent'))
            as busy`,
    );
    return res.rows[0]!.busy;
}

export function mirrorInterval(busy: boolean, x402: Settings["x402"]): number {
    return busy ? x402.mirror_every : x402.mirror_idle_every;
}
