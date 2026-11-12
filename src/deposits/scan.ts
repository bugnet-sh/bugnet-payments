/**
 * The deposit scanner (spec 6.1, 6.2, 6.6): balance reads in batches, the read trail, the history
 * listing with its completeness proof, the explanation of each read interval, the process-wide
 * transaction cache and the balance invariant.
 *
 * Every function takes the rpc its caller chooses: the job passes its background lane to the
 * balance batch and the scans, the move executor's re-sign proof passes the money lane (spec 6.5,
 * R7).
 */
import {
    type Address,
    address,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    isSolanaError,
    signature as toSignature,
} from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import { type Queryable, withTx } from "../db/pool.ts";
import { isRecord } from "../is-record.ts";
import type { Log } from "../log.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "../solana/constants.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";
import { parseChainTx, type TokenAccountChange, usdcHeldBy } from "../x402/match.ts";
import { depositLedger, insertTransfers, lockDeposit, moveCursor, updateDeposit } from "./store.ts";
import type {
    DepositRow,
    MoveRow,
    MoveState,
    NewTransfer,
    TransferRow,
    WriteOffRow,
} from "./types.ts";

export interface AccountRead {
    exists: boolean;
    micros: bigint;
    contextSlot: bigint;
}

const BATCH = 100;
const MISSING = { exists: false, micros: 0n } as const;

// Spec 5: only a USDC account under the Token program is the deposit's token account. Lamports
// sent to the address before it is created leave a system account there. A frozen account is still
// an initialized one, so its balance is never misread as zero.
function usdcAccount(v: unknown): { exists: boolean; micros: bigint } {
    if (!isRecord(v) || v.owner !== TOKEN_PROGRAM || !isRecord(v.data)) return MISSING;
    const parsed = v.data.parsed;
    if (!isRecord(parsed) || parsed.type !== "account" || !isRecord(parsed.info)) return MISSING;
    const { info } = parsed;
    if (info.mint !== USDC_MINT || (info.state !== "initialized" && info.state !== "frozen")) {
        return MISSING;
    }
    const amount = isRecord(info.tokenAmount) ? info.tokenAmount.amount : undefined;
    if (typeof amount !== "string") return MISSING;
    return { exists: true, micros: BigInt(amount) };
}

export async function readDepositBalances(
    rpc: SolanaRpc,
    accounts: readonly Address[],
    o: { timeoutMs: number; minContextSlot?: bigint },
): Promise<Map<string, AccountRead>> {
    const out = new Map<string, AccountRead>();
    for (let i = 0; i < accounts.length; i += BATCH) {
        const chunk = accounts.slice(i, i + BATCH);
        const { context, value } = await rpc
            .getMultipleAccounts(chunk, {
                encoding: "jsonParsed",
                commitment: "confirmed",
                ...(o.minContextSlot === undefined ? {} : { minContextSlot: o.minContextSlot }),
            })
            .send(deadline(o.timeoutMs));
        const contextSlot = BigInt(context.slot);
        chunk.forEach((a, j) => out.set(a, { ...usdcAccount(value[j]), contextSlot }));
    }
    return out;
}

// The anchor is one of the 64 entries
const TRAIL_MAX = 64;

/**
 * The reads taken since the last held read. The anchor is (checked_slot, balance_micros); a
 * deposit never held starts at the empty account, (0, 0). When full, the read ending the oldest
 * interval after the anchor is dropped, which merges that interval with the next one.
 */
export class ReadTrail {
    #anchor: { slot: bigint; micros: bigint };
    #reads: AccountRead[] = [];

    constructor(anchor: { slot: bigint; micros: bigint } | null) {
        this.#anchor = anchor ?? { slot: 0n, micros: 0n };
    }

    anchor(): { slot: bigint; micros: bigint } {
        return this.#anchor;
    }

    latest(): AccountRead | null {
        return this.#reads.at(-1) ?? null;
    }

    // A read no newer than the last one describes a moment the trail already holds
    push(r: AccountRead): void {
        const last = this.#reads.at(-1)?.contextSlot ?? this.#anchor.slot;
        if (r.contextSlot <= last) return;
        this.#reads.push(r);
        if (this.#reads.length > TRAIL_MAX - 1) this.#reads.splice(0, 1);
    }

    intervals(): readonly { from: { slot: bigint; micros: bigint }; to: AccountRead }[] {
        let from = this.#anchor;
        return this.#reads.map((to) => {
            const iv = { from, to };
            from = { slot: to.contextSlot, micros: to.micros };
            return iv;
        });
    }

    reanchor(slot: bigint, micros: bigint): void {
        this.#anchor = { slot, micros };
        this.#reads = this.#reads.filter((r) => r.contextSlot > slot);
    }
}

export interface CachedTx {
    signature: string;
    slot: bigint;
    blockTime: Date | null;
    failed: boolean;
    feePayer: string | null;
    signers: readonly string[];
    tokenAccounts: ReadonlyMap<string, TokenAccountChange>;
    // For an undecodable answer only: each owner's USDC change and its USDC before, from the meta's
    // token balances, which name owners but need the message to name accounts
    ownerDeltas: ReadonlyMap<string, bigint>;
    ownerBefore: ReadonlyMap<string, bigint>;
    undecodable: boolean;
    // meta null, or no token balance arrays (spec 6.1)
    noMeta: boolean;
}

// Process-wide, the newest getTransaction answers, so a padding transaction naming many deposits
// is fetched once
export class TxCache {
    readonly #max: number;
    readonly #txs = new Map<string, CachedTx>();

    constructor(max: number) {
        this.#max = max;
    }

    get(signature: string): CachedTx | undefined {
        return this.#txs.get(signature);
    }

    // An answer with no usable meta may be one backend's mistake, so it is asked again
    put(tx: CachedTx): void {
        if (tx.noMeta) return;
        this.#txs.delete(tx.signature);
        this.#txs.set(tx.signature, tx);
        for (const oldest of this.#txs.keys()) {
            if (this.#txs.size <= this.#max) break;
            this.#txs.delete(oldest);
        }
    }

    drop(signatures: readonly string[]): void {
        for (const s of signatures) this.#txs.delete(s);
    }

    size(): number {
        return this.#txs.size;
    }
}

const NO_TOKEN_ACCOUNTS: ReadonlyMap<string, TokenAccountChange> = new Map();
const NO_OWNER_DELTAS: ReadonlyMap<string, bigint> = new Map();
// Codes a node gives for a slot it has no block time for yet (spec 6.5, R5)
const NO_BLOCK_TIME: ReadonlySet<number> = new Set([-32004, -32009, -32014, -32019]);

function secondsToDate(v: unknown): Date | null {
    if (typeof v !== "number" && typeof v !== "bigint") return null;
    return new Date(Number(v) * 1_000);
}

async function blockTimeOf(rpc: SolanaRpc, slot: bigint, timeoutMs: number): Promise<Date | null> {
    try {
        return secondsToDate(await rpc.getBlockTime(slot).send(deadline(timeoutMs)));
    } catch (err) {
        if (isSolanaError(err) && NO_BLOCK_TIME.has(Number(err.context.__code))) return null;
        throw err;
    }
}

// A message that does not decode (a version 1 transaction, for example) still has usable meta
function decodable(raw: Record<string, unknown>): boolean {
    const t = raw.transaction;
    if (!Array.isArray(t) || t[1] !== "base64" || typeof t[0] !== "string") return false;
    try {
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(t[0]));
        return getCompiledTransactionMessageDecoder().decode(tx.messageBytes).version !== 1;
    } catch {
        return false;
    }
}

function ownerBalancesOf(
    raw: unknown,
    meta: Record<string, unknown>,
): { deltas: Map<string, bigint>; before: Map<string, bigint> } {
    const owners = new Set<string>();
    for (const list of [meta.preTokenBalances, meta.postTokenBalances] as unknown[][]) {
        for (const b of list) {
            if (isRecord(b) && b.mint === USDC_MINT && typeof b.owner === "string") {
                owners.add(b.owner);
            }
        }
    }
    const deltas = new Map<string, bigint>();
    const before = new Map<string, bigint>();
    for (const owner of owners) {
        const held = usdcHeldBy(raw, owner) ?? { pre: 0n, post: 0n };
        if (held.post !== held.pre) deltas.set(owner, held.post - held.pre);
        before.set(owner, held.pre);
    }
    return { deltas, before };
}

function compact(signature: string, slot: bigint, raw: unknown, blockTime: Date): CachedTx {
    const meta = isRecord(raw) ? raw.meta : null;
    const base = {
        signature,
        slot,
        blockTime,
        feePayer: null,
        signers: [],
        tokenAccounts: NO_TOKEN_ACCOUNTS,
        ownerDeltas: NO_OWNER_DELTAS,
        ownerBefore: NO_OWNER_DELTAS,
        undecodable: false,
        noMeta: false,
    };
    if (
        !isRecord(raw) ||
        !isRecord(meta) ||
        !Array.isArray(meta.preTokenBalances) ||
        !Array.isArray(meta.postTokenBalances)
    ) {
        return { ...base, failed: false, noMeta: true };
    }
    const failed = meta.err !== null && meta.err !== undefined;
    if (!decodable(raw)) {
        const owners = ownerBalancesOf(raw, meta);
        return {
            ...base,
            failed,
            undecodable: true,
            ownerDeltas: owners.deltas,
            ownerBefore: owners.before,
        };
    }
    const tx = parseChainTx(signature, slot, raw, "");
    return {
        ...base,
        failed: tx.failed,
        feePayer: tx.feePayer,
        signers: tx.signers,
        tokenAccounts: tx.tokenAccounts,
    };
}

async function fetchCounted(
    rpc: SolanaRpc,
    cache: TxCache,
    signature: string,
    slot: bigint,
    timeoutMs: number,
): Promise<{ tx: CachedTx | null; calls: number }> {
    const hit = cache.get(signature);
    if (hit !== undefined) return { tx: hit, calls: 0 };
    const raw: unknown = await rpc
        .getTransaction(toSignature(signature), {
            encoding: "base64",
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        })
        .send(deadline(timeoutMs));
    if (raw === null) return { tx: null, calls: 1 };
    let calls = 1;
    let blockTime = secondsToDate(isRecord(raw) ? raw.blockTime : null);
    if (blockTime === null) {
        calls++;
        blockTime = await blockTimeOf(rpc, slot, timeoutMs);
        // A transfer is never recorded without a block time, so the deadline never falls back
        // to the moment Payments saw the money
        if (blockTime === null) return { tx: null, calls };
    }
    const tx = compact(signature, slot, raw, blockTime);
    cache.put(tx);
    return { tx, calls };
}

// Null when the node has no answer or no block time yet: the caller waits. An answer with no
// usable meta is returned but never cached.
export async function fetchTx(
    rpc: SolanaRpc,
    cache: TxCache,
    signature: string,
    slot: bigint,
    timeoutMs: number,
): Promise<CachedTx | null> {
    return (await fetchCounted(rpc, cache, signature, slot, timeoutMs)).tx;
}

export type ScanItem =
    | { kind: "transfer"; row: NewTransfer }
    // recorded as review/unreadable
    | { kind: "unreadable"; row: NewTransfer }
    | { kind: "ours"; moveId: number; slot: bigint }
    | { kind: "no_effect" }
    | { kind: "unknown_debit"; signature: string; micros: bigint };

const change = (e: TokenAccountChange | undefined): bigint =>
    e === undefined ? 0n : (e.post ?? 0n) - (e.pre ?? 0n);

export function classifyTx(
    tx: CachedTx,
    deposit: Pick<DepositRow, "orderId" | "tokenAccount" | "address">,
    seenAt: Date,
    seq: number,
): ScanItem {
    if (tx.noMeta) throw new Error(`transaction ${tx.signature} has no usable meta`);
    if (tx.failed) return { kind: "no_effect" };
    const delta = tx.undecodable
        ? (tx.ownerDeltas.get(deposit.address) ?? 0n)
        : change(tx.tokenAccounts.get(deposit.tokenAccount));
    if (delta === 0n) return { kind: "no_effect" };
    if (delta < 0n) return { kind: "unknown_debit", signature: tx.signature, micros: -delta };
    if (tx.blockTime === null) throw new Error(`transaction ${tx.signature} has no block time`);
    const row = {
        orderId: deposit.orderId,
        signature: tx.signature,
        slot: tx.slot,
        seq,
        blockTime: tx.blockTime,
        seenAt,
        amountMicros: Number(delta),
        sourceTokenAccount: null,
        sourceOwner: null,
        sourceBalanceMicros: null,
    };
    if (tx.undecodable) return { kind: "unreadable", row };
    // A pool vault, a multisig or a delegate moves money its owner did not sign for: no source
    let source: { account: string; owner: string; fell: bigint; post: bigint } | null = null;
    for (const [account, e] of tx.tokenAccounts) {
        if (account === deposit.tokenAccount || e.owner === null) continue;
        if (!tx.signers.includes(e.owner)) continue;
        const fell = (e.pre ?? 0n) - (e.post ?? 0n);
        if (fell > 0n && (source === null || fell > source.fell)) {
            source = { account, owner: e.owner, fell, post: e.post ?? 0n };
        }
    }
    if (source === null) return { kind: "transfer", row };
    return {
        kind: "transfer",
        row: {
            ...row,
            sourceTokenAccount: source.account,
            sourceOwner: source.owner,
            sourceBalanceMicros: source.post,
        },
    };
}

// The deposit's USDC just before the transaction, from its meta (spec 23.1)
export function balanceBefore(
    tx: CachedTx,
    deposit: Pick<DepositRow, "tokenAccount" | "address">,
): bigint {
    if (tx.noMeta) throw new Error(`transaction ${tx.signature} has no usable meta`);
    if (tx.undecodable) return tx.ownerBefore.get(deposit.address) ?? 0n;
    return tx.tokenAccounts.get(deposit.tokenAccount)?.pre ?? 0n;
}

// The fee payer of the transaction that created the account: no pre entry and a post entry
export function createdBy(tx: CachedTx, tokenAccount: string): string | null {
    if (tx.failed || tx.noMeta || tx.undecodable) return null;
    const e = tx.tokenAccounts.get(tokenAccount);
    return e !== undefined && e.pre === null && e.post !== null ? tx.feePayer : null;
}

const moved = (m: MoveRow): bigint => BigInt(m.amountMicros + m.keepMicros + m.heldMicros);

// A written-off debit leaves the account at its slot, as a landed move does (spec 23.1)
export type WriteOffs = readonly Pick<WriteOffRow, "slot" | "micros">[];

// (b1 - b0) - recorded transfers in (s0, s1] + (amount + keep + held) of moves landed there
// + write-offs there
export function unexplainedIn(
    interval: { from: { slot: bigint; micros: bigint }; to: AccountRead },
    transfers: readonly TransferRow[],
    moves: readonly MoveRow[],
    writeOffs: WriteOffs,
): bigint {
    const inside = (s: bigint) => s > interval.from.slot && s <= interval.to.contextSlot;
    let u = interval.to.micros - interval.from.micros;
    for (const t of transfers) if (inside(t.slot)) u -= BigInt(t.amountMicros);
    for (const m of moves) if (m.landedSlot !== null && inside(m.landedSlot)) u += moved(m);
    for (const w of writeOffs) if (inside(w.slot)) u += BigInt(w.micros);
    return u;
}

// Transfers with slot <= S minus (amount + keep + held) of moves with landed_slot <= S and
// write-offs with slot <= S
export function expectedBalanceAt(
    transfers: readonly TransferRow[],
    moves: readonly MoveRow[],
    writeOffs: WriteOffs,
    slot: bigint,
): bigint {
    let sum = 0n;
    for (const t of transfers) if (t.slot <= slot) sum += BigInt(t.amountMicros);
    for (const m of moves) if (m.landedSlot !== null && m.landedSlot <= slot) sum -= moved(m);
    for (const w of writeOffs) if (w.slot <= slot) sum -= BigInt(w.micros);
    return sum;
}

const IN_FLIGHT: ReadonlySet<MoveState> = new Set(["pending", "signed", "sent"]);

// A failed move has no landing slot, so one that failed since the last held read counts
export function needsScan(
    deposit: DepositRow,
    read: AccountRead,
    transfers: readonly TransferRow[],
    moves: readonly MoveRow[],
    writeOffs: WriteOffs,
): boolean {
    if (read.micros !== expectedBalanceAt(transfers, moves, writeOffs, read.contextSlot)) {
        return true;
    }
    if (read.micros !== deposit.balanceMicros) return true;
    if (deposit.scanTop !== null) return true;
    if (read.exists && deposit.rentPayer === null) return true;
    return moves.some(
        (m) =>
            IN_FLIGHT.has(m.state) ||
            (m.landedSlot !== null &&
                (deposit.scanSlot === null || m.landedSlot > deposit.scanSlot)) ||
            (m.state === "failed" &&
                m.failedAt !== null &&
                (deposit.checkedAt === null || m.failedAt > deposit.checkedAt)),
    );
}

// held: balance_micros, checked_at, checked_slot and stable_since (spec 6.2); otherwise nothing
export async function recordRead(
    c: Queryable,
    deposit: DepositRow,
    read: AccountRead,
    invariant: "held" | "below" | "above",
    now: Date,
): Promise<void> {
    if (invariant !== "held") return;
    const changed = deposit.stableSince === null || read.micros !== deposit.balanceMicros;
    await updateDeposit(c, deposit.orderId, {
        balanceMicros: read.micros,
        checkedAt: now,
        checkedSlot: read.contextSlot,
        stableSince: changed ? now : deposit.stableSince,
    });
}

export interface ScanDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    rpcTimeoutMs: number;
    cfg: Pick<
        Settings["deposits"],
        "scan_page_size" | "scan_max_pages" | "scan_max_transactions" | "index_lag_alarm_after"
    >;
    cache: TxCache;
    log: Log;
    now: () => Date;
}

// Describes the read the scan was pinned to, which the trail may since have passed
export interface ScanResult {
    invariant: "held" | "below" | "above";
    complete: boolean;
    read: AccountRead;
}

// fetched counts the answers to fetches inside an interval not yet explained: a padded interval
// records nothing until it reaches the money, yet the scan is moving (spec 6.1, 6.6)
export type ScanStep =
    | { calls: number; fetched: number; done: false }
    | { calls: number; fetched: number; done: true; result: ScanResult };

interface Entry {
    signature: string;
    slot: bigint;
    failed: boolean;
}

interface Listing {
    // The read that started the scan: only entries at or below its slot count
    read: AccountRead;
    until: string | null;
    // newest first
    entries: Entry[];
    seen: Set<string>;
    top: string | null;
    listed: boolean;
    proof: "due" | "held" | "failed";
}

// One scan from its first step to done, so each answer is asked once per run
interface Run {
    pages: number;
    fetches: number;
    answers: Map<string, CachedTx | null>;
}

// Per deposit and in memory: a restart keeps only the anchor, as for the trail
interface Memory {
    listing: Listing | null;
    run: Run | null;
    waitingSince: Date | null;
    lagAlarmed: boolean;
    stuckSince: Date | null;
    droppedAt: Date | null;
    // The first and the latest of the fetches in a row that answered with no meta. A run keeps its
    // answer, so the clock alone could pass index_lag_alarm_after on a single fetch.
    noMeta: Map<string, { first: Date; last: Date }>;
    debitsAlarmed: Set<string>;
}

const memories = new WeakMap<ReadTrail, Memory>();

function memoryOf(trail: ReadTrail): Memory {
    let m = memories.get(trail);
    if (m === undefined) {
        m = {
            listing: null,
            run: null,
            waitingSince: null,
            lagAlarmed: false,
            stuckSince: null,
            droppedAt: null,
            noMeta: new Map(),
            debitsAlarmed: new Set(),
        };
        memories.set(trail, m);
    }
    return m;
}

interface Step {
    d: ScanDeps;
    m: Memory;
    trail: ReadTrail;
    listing: Listing;
    run: Run;
    deposit: DepositRow;
    transfers: TransferRow[];
    moves: MoveRow[];
    writeOffs: readonly WriteOffRow[];
    now: Date;
    fetched: number;
}

// pages and fetches end a run at a bound and keep the listing for the next one
type End = "done" | "wait" | "unproven" | "pages" | "fetches";

type Next =
    | { kind: "call"; call: () => Promise<number> }
    | { kind: "end"; end: End; explained: number; creatorPending: boolean };

const lagMs = (s: Step) => s.d.cfg.index_lag_alarm_after;
const since = (s: Step, t: Date) => s.now.getTime() - t.getTime();

function answerOf(s: Step, signature: string): CachedTx | null | undefined {
    return s.run.answers.has(signature)
        ? (s.run.answers.get(signature) ?? null)
        : s.d.cache.get(signature);
}

async function listPage(s: Step): Promise<number> {
    const { listing, d } = s;
    const page = await d.rpc
        .getSignaturesForAddress(address(s.deposit.tokenAccount), {
            commitment: "confirmed",
            minContextSlot: listing.read.contextSlot,
            limit: d.cfg.scan_page_size,
            ...(listing.until === null ? {} : { until: toSignature(listing.until) }),
            ...(listing.entries.length === 0
                ? {}
                : { before: toSignature(listing.entries.at(-1)!.signature) }),
        })
        .send(deadline(d.rpcTimeoutMs));
    s.run.pages++;
    if (listing.top === null && page[0] !== undefined) listing.top = page[0].signature;
    for (const e of page) {
        if (listing.seen.has(e.signature)) continue;
        listing.seen.add(e.signature);
        listing.entries.push({
            signature: e.signature,
            slot: BigInt(e.slot),
            failed: e.err !== null,
        });
    }
    if (page.length < d.cfg.scan_page_size) listing.listed = true;
    return 1;
}

// The listing reached the cursor only if the entry just below its oldest one is the cursor itself
async function prove(s: Step): Promise<number> {
    const { listing, d } = s;
    const oldest = listing.entries.at(-1);
    const page = await d.rpc
        .getSignaturesForAddress(address(s.deposit.tokenAccount), {
            commitment: "confirmed",
            minContextSlot: listing.read.contextSlot,
            limit: 1,
            ...(oldest === undefined ? {} : { before: toSignature(oldest.signature) }),
        })
        .send(deadline(d.rpcTimeoutMs));
    listing.proof = page[0]?.signature === listing.until ? "held" : "failed";
    return 1;
}

function fetchNext(s: Step, e: Entry, unexplained = false): Next | "bound" {
    if (s.run.fetches >= s.d.cfg.scan_max_transactions) return "bound";
    return {
        kind: "call",
        call: async () => {
            const { tx, calls } = await fetchCounted(
                s.d.rpc,
                s.d.cache,
                e.signature,
                e.slot,
                s.d.rpcTimeoutMs,
            );
            if (calls > 0) s.run.fetches++;
            if (calls > 0 && tx !== null && unexplained) s.fetched++;
            s.run.answers.set(e.signature, tx);
            if (tx?.noMeta !== true) s.m.noMeta.delete(e.signature);
            else {
                const first = s.m.noMeta.get(e.signature)?.first ?? s.now;
                s.m.noMeta.set(e.signature, { first, last: s.now });
            }
            return calls;
        },
    };
}

// seq orders the entries of one slot, oldest 0, from their place in the listing
function seqsOf(entries: readonly Entry[]): Map<string, number> {
    const out = new Map<string, number>();
    const perSlot = new Map<bigint, number>();
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!;
        const n = perSlot.get(e.slot) ?? 0;
        out.set(e.signature, n);
        perSlot.set(e.slot, n + 1);
    }
    return out;
}

function ourSignatures(moves: readonly MoveRow[]): Map<string, MoveRow> {
    const out = new Map<string, MoveRow>();
    for (const m of moves) {
        if (m.txSignature !== null) out.set(m.txSignature, m);
        for (const p of m.previousSignatures) out.set(p, m);
    }
    return out;
}

// A failed transaction moved nothing, so only a successful entry gives a move its landing slot
async function markLanded(
    s: Step,
    counted: readonly Entry[],
    ours: ReadonlyMap<string, MoveRow>,
): Promise<void> {
    const landed = new Map<number, bigint>();
    for (const e of counted) {
        const m = ours.get(e.signature);
        if (e.failed || m === undefined || m.landedSlot !== null || m.state === "failed") continue;
        landed.set(m.id, e.slot);
    }
    if (landed.size === 0) return;
    await withTx(s.d.pool, async (c) => {
        await lockDeposit(c, s.deposit.orderId);
        for (const [id, slot] of landed) {
            await c.query(
                `update deposit_moves set landed_slot = $2
                 where id = $1 and landed_slot is null and state <> 'failed'`,
                [id, slot.toString()],
            );
        }
    });
    s.moves = s.moves.map((m) => {
        const slot = landed.get(m.id);
        return slot === undefined ? m : { ...m, landedSlot: slot };
    });
}

async function record(s: Step, row: NewTransfer, review: boolean): Promise<void> {
    const inserted = await withTx(s.d.pool, async (c) => {
        await lockDeposit(c, s.deposit.orderId);
        return await insertTransfers(c, s.deposit.orderId, [
            review ? { ...row, outcome: "review", reason: "unreadable" } : row,
        ]);
    });
    s.transfers.push({
        ...row,
        outcome: review ? "review" : "open",
        appliedMicros: 0,
        reason: review ? "unreadable" : null,
        blockedUntil: null,
        moveId: null,
        refundId: null,
        lostMicros: 0,
    });
    if (review && inserted > 0) {
        s.d.log.alarm("deposit_review", {
            orderId: s.deposit.orderId,
            signature: row.signature,
            reason: "unreadable",
        });
    }
}

async function apply(s: Step, item: ScanItem): Promise<void> {
    if (item.kind === "transfer" || item.kind === "unreadable") {
        await record(s, item.row, item.kind === "unreadable");
        return;
    }
    if (item.kind !== "unknown_debit" || s.m.debitsAlarmed.has(item.signature)) return;
    // Only the deposit key can debit the account, so a debit that is not ours means a leak
    s.d.log.alarm("deposit_unknown_debit", {
        orderId: s.deposit.orderId,
        signature: item.signature,
        micros: item.micros.toString(),
    });
    await withTx(s.d.pool, async (c) => {
        await lockDeposit(c, s.deposit.orderId);
        await updateDeposit(c, s.deposit.orderId, { reviewReason: "unknown_debit" });
    });
    // Spec 17: the operator's review alarm names this reason too
    s.d.log.alarm("deposit_review", {
        orderId: s.deposit.orderId,
        signature: item.signature,
        reason: "unknown_debit",
    });
    s.m.debitsAlarmed.add(item.signature);
}

// Fetches the interval's unrecorded entries newest first until it is explained. The interval
// waits on a missing answer; one left unexplained after every entry answered drops its entries
// from the cache, at most once per index_lag_alarm_after, so one backend's wrong answer is asked
// again instead of read from the cache until a restart.
async function explain(
    s: Step,
    iv: { from: { slot: bigint; micros: bigint }; to: AccountRead },
    counted: readonly Entry[],
    ours: ReadonlyMap<string, MoveRow>,
    seqs: ReadonlyMap<string, number>,
): Promise<"explained" | "waiting" | "bound" | Next> {
    for (;;) {
        let u = unexplainedIn(iv, s.transfers, s.moves, s.writeOffs);
        if (u === 0n) return "explained";
        // A written-off debit is recorded too, so no scan flags it again (spec 23.1)
        const recorded = new Set([
            ...s.transfers.map((t) => t.signature),
            ...s.writeOffs.map((w) => w.signature),
        ]);
        const candidates = counted.filter(
            (e) =>
                e.slot > iv.from.slot &&
                e.slot <= iv.to.contextSlot &&
                !e.failed &&
                !ours.has(e.signature) &&
                !recorded.has(e.signature),
        );
        const noMeta: { entry: Entry; tx: CachedTx }[] = [];
        for (const e of candidates) {
            const tx = answerOf(s, e.signature);
            if (tx === undefined) return fetchNext(s, e, true);
            if (tx === null) return "waiting";
            if (tx.noMeta) {
                noMeta.push({ entry: e, tx });
                continue;
            }
            await apply(s, classifyTx(tx, s.deposit, s.now, seqs.get(e.signature) ?? 0));
            u = unexplainedIn(iv, s.transfers, s.moves, s.writeOffs);
            if (u === 0n) return "explained";
        }
        if (noMeta.length > 0) {
            const only = noMeta.length === 1 ? noMeta[0]! : null;
            const fetched = only === null ? undefined : s.m.noMeta.get(only.entry.signature);
            if (
                only === null ||
                u < 0n ||
                fetched === undefined ||
                fetched.last.getTime() - fetched.first.getTime() < lagMs(s)
            ) {
                return "waiting";
            }
            // Two fetches 30 s apart with no meta: the remainder is held for a person to check
            await record(
                s,
                {
                    orderId: s.deposit.orderId,
                    signature: only.entry.signature,
                    slot: only.entry.slot,
                    seq: seqs.get(only.entry.signature) ?? 0,
                    blockTime: only.tx.blockTime!,
                    seenAt: s.now,
                    amountMicros: Number(u),
                    sourceTokenAccount: null,
                    sourceOwner: null,
                    sourceBalanceMicros: null,
                },
                true,
            );
            s.m.noMeta.delete(only.entry.signature);
            continue;
        }
        s.m.stuckSince ??= s.now;
        const from = Math.max(s.m.stuckSince.getTime(), s.m.droppedAt?.getTime() ?? 0);
        if (s.now.getTime() - from < lagMs(s)) return "waiting";
        const stale = candidates.map((e) => e.signature).filter((sig) => !s.run.answers.has(sig));
        s.m.droppedAt = s.now;
        if (stale.length === 0) return "waiting";
        s.d.cache.drop(stale);
    }
}

// Oldest first, our own entries included, until the transaction that created the account
async function findCreator(
    s: Step,
    counted: readonly Entry[],
): Promise<"none" | "found" | "waiting" | "bound" | Next> {
    if (!s.listing.read.exists || s.deposit.rentPayer !== null) return "none";
    for (let i = counted.length - 1; i >= 0; i--) {
        const e = counted[i]!;
        if (e.failed) continue;
        const tx = answerOf(s, e.signature);
        if (tx === undefined) return fetchNext(s, e);
        if (tx === null || tx.noMeta) return "waiting";
        const creator = createdBy(tx, s.deposit.tokenAccount);
        if (creator === null) continue;
        await withTx(s.d.pool, async (c) => {
            const locked = await lockDeposit(c, s.deposit.orderId);
            if (locked?.rentPayer === null) {
                await updateDeposit(c, s.deposit.orderId, { rentPayer: creator });
            }
        });
        s.deposit = { ...s.deposit, rentPayer: creator };
        return "found";
    }
    return "none";
}

async function advance(s: Step): Promise<Next> {
    const { listing, run, d } = s;
    const ended = (end: End, explained = 0, creatorPending = true): Next => ({
        kind: "end",
        end,
        explained,
        creatorPending,
    });
    if (!listing.listed) {
        if (run.pages >= d.cfg.scan_max_pages) return ended("pages");
        return { kind: "call", call: () => listPage(s) };
    }
    if (listing.proof === "due") return { kind: "call", call: () => prove(s) };
    if (listing.proof === "failed") return ended("unproven");

    const readSlot = listing.read.contextSlot;
    const counted = listing.entries.filter((e) => e.slot <= readSlot);
    const seqs = seqsOf(listing.entries);
    const ours = ourSignatures(s.moves);
    await markLanded(s, counted, ours);

    let explained = 0;
    let leading = true;
    let waiting = false;
    for (const iv of s.trail.intervals()) {
        if (iv.to.contextSlot > readSlot) break;
        const r = await explain(s, iv, counted, ours, seqs);
        if (r === "bound") return ended("fetches", explained);
        if (typeof r === "object") return r;
        if (r === "explained" && leading) explained++;
        else {
            leading = false;
            waiting = true;
        }
    }
    const creator = await findCreator(s, counted);
    if (creator === "bound") return ended("fetches", explained);
    if (typeof creator === "object") return creator;
    const creatorPending = creator === "waiting";
    return ended(waiting || creatorPending ? "wait" : "done", explained, creatorPending);
}

async function finish(s: Step, next: Extract<Next, { kind: "end" }>): Promise<ScanResult> {
    const { d, m, listing, trail, now } = s;
    const { end } = next;
    const read = listing.read;
    const orderId = s.deposit.orderId;
    const intervals = trail.intervals().filter((iv) => iv.to.contextSlot <= read.contextSlot);
    const through = next.explained > 0 ? intervals[next.explained - 1]!.to : null;
    // A move in flight has an unknown effect, and an equal unknown credit could hide behind it
    const inFlight = s.moves.some((mv) => IN_FLIGHT.has(mv.state));
    let held = false;
    if (
        listing.proof === "held" &&
        !inFlight &&
        through !== null &&
        through.micros === expectedBalanceAt(s.transfers, s.moves, s.writeOffs, through.contextSlot)
    ) {
        const cursor = listing.entries.find((e) => e.slot <= through.contextSlot);
        await withTx(d.pool, async (c) => {
            const locked = await lockDeposit(c, orderId);
            if (locked === null) throw new Error(`no deposit for ${orderId}`);
            if (!next.creatorPending) {
                await moveCursor(
                    c,
                    orderId,
                    cursor === undefined
                        ? null
                        : { signature: cursor.signature, slot: cursor.slot },
                    { top: null, before: null },
                );
            }
            await recordRead(c, locked, through, "held", now);
        });
        trail.reanchor(through.contextSlot, through.micros);
        held = through.contextSlot === read.contextSlot;
    } else if (end === "pages") {
        const before = listing.entries.at(-1)?.signature ?? null;
        await withTx(d.pool, (c) => moveCursor(c, orderId, null, { top: listing.top, before }));
    } else if (s.deposit.scanTop !== null && end !== "fetches") {
        await withTx(d.pool, (c) => moveCursor(c, orderId, null, { top: null, before: null }));
    }

    if (end === "wait" || end === "unproven") {
        m.waitingSince ??= now;
        if (!m.lagAlarmed && since(s, m.waitingSince) >= lagMs(s)) {
            d.log.alarm("deposit_index_lag", { orderId });
            m.lagAlarmed = true;
        }
    } else if (end === "done") {
        m.waitingSince = null;
        m.lagAlarmed = false;
        m.stuckSince = null;
        m.droppedAt = null;
    }
    if (end !== "pages" && end !== "fetches") m.listing = null;
    m.run = null;

    const expected = expectedBalanceAt(s.transfers, s.moves, s.writeOffs, read.contextSlot);
    return {
        invariant: held ? "held" : read.micros < expected ? "below" : "above",
        complete: end === "done",
        read,
    };
}

const inTrail = (trail: ReadTrail, read: AccountRead): boolean =>
    trail.intervals().some((iv) => iv.to.contextSlot === read.contextSlot);

/**
 * One RPC call of this deposit's scan (a listing page, the completeness call or one fetch), so the
 * job's queue can interleave deposits. Done once every interval up to the pinned read is explained
 * or the scan must wait; a run that hit scan_max_pages or scan_max_transactions keeps its listing
 * and goes on in the next run.
 */
export async function scanStep(
    d: ScanDeps,
    deposit: DepositRow,
    trail: ReadTrail,
): Promise<ScanStep> {
    const m = memoryOf(trail);
    const ledger = await depositLedger(d.pool, deposit.orderId);
    if (ledger === null) throw new Error(`no deposit for ${deposit.orderId}`);
    const current = ledger.deposit;
    if (
        m.listing !== null &&
        (m.listing.until !== current.lastSignature || !inTrail(trail, m.listing.read))
    ) {
        m.listing = null;
    }
    if (m.listing === null) {
        const read = trail.latest();
        if (read === null) throw new Error(`no read to scan for ${deposit.orderId}`);
        m.listing = {
            read,
            until: current.lastSignature,
            entries: [],
            seen: new Set(),
            top: null,
            listed: false,
            proof: current.lastSignature === null ? "held" : "due",
        };
    }
    m.run ??= { pages: 0, fetches: 0, answers: new Map() };
    const s: Step = {
        d,
        m,
        trail,
        listing: m.listing,
        run: m.run,
        deposit: current,
        transfers: [...ledger.transfers],
        moves: [...ledger.moves],
        writeOffs: ledger.writeOffs,
        now: d.now(),
        fetched: 0,
    };
    let calls = 0;
    for (;;) {
        const next = await advance(s);
        if (next.kind === "end") {
            const result = await finish(s, next);
            return { calls, fetched: s.fetched, done: true, result };
        }
        if (calls > 0) return { calls, fetched: s.fetched, done: false };
        calls += await next.call();
    }
}

// scanStep until done; the tests' entry point
export async function scanDeposit(
    d: ScanDeps,
    deposit: DepositRow,
    trail: ReadTrail,
): Promise<ScanResult> {
    for (;;) {
        const step = await scanStep(d, deposit, trail);
        if (step.done) return step.result;
    }
}
