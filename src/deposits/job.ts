/**
 * The deposit job (spec 6.4 to 6.6): one paced, single-runner tick that marks expiries, advances
 * moves, reads every due deposit in one batch, plans what needs no scan, scans the rest from a
 * fair, time-boxed queue, plans those, and lets the hard stop wait for a scan that is catching up.
 *
 * Every RPC call goes through the job's own queue: moves, settles and move proofs on `rpc`, the
 * money lane, and balance reads, the expiry pin and scans on `backgroundRpc`. The queue caps the
 * job's calls per second over both lanes and per UTC day (moves excluded), and past 80 % and
 * 100 % of the day the tick falls back to fewer reads and scans while moves and settles go on.
 *
 * The viewer map, the read trails, the early CheckPayer answers and the scan progress live in
 * memory, with the DepositWatch. A restart keeps what the database holds: the anchors, the stored
 * viewer keys that the rented caps count, and every deposit row.
 */
import { address, isSolanaError } from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { type IpKey, viewerHash } from "../http/ipkey.ts";
import { expireUnpaidOrder } from "../jobs/sweeper.ts";
import type { Log } from "../log.ts";
import { findOrder, lockOrder } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { RpcUnavailable } from "../refunds/executor.ts";
import type { PayerCheck } from "../router/client.ts";
import { countingRpc, rpcCounter } from "../solana/budget.ts";
import { deadline, rpcErrorFields, type SolanaRpc } from "../solana/rpc.ts";
import { chainOrder, coverage, type Held } from "./coverage.ts";
import { advanceMoves, moveFeeLamports, type MoveDeps, type MoveTick } from "./moves.ts";
import { createAndCloseLamports, type Plan, type PlanInput, planDeposit } from "./plan.ts";
import {
    type AccountRead,
    expectedBalanceAt,
    needsScan,
    readDepositBalances,
    ReadTrail,
    recordRead,
    type ScanDeps,
    type ScanResult,
    scanStep,
} from "./scan.ts";
import { type SettleDeps, settleDeposit, targetOf } from "./settle.ts";
import {
    clearHolds,
    depositLedger,
    insertMove,
    lockDeposit,
    meteredLamports,
    ownerReturns,
    rentedBy,
    rentHolding,
    setTransferOutcomes,
    unpaidCreateLamports,
    updateDeposit,
    watchedDeposits,
} from "./store.ts";
import type { DepositRow, DepositState, OwnerHoldReason, TransferRow } from "./types.ts";

export interface ViewerFacts {
    state: DepositState;
    expiresAtMs: number;
    needsCreate: boolean;
}

export interface DepositWatch {
    // Notes nothing unless facts.state is 'open' and nowMs < facts.expiresAtMs. Calls wake.run
    // itself on the order's first poll within viewer_ttl when needsCreate, at most once per
    // busy_every across all orders.
    noteViewer(orderId: string, ip: IpKey, nowMs: number, facts: ViewerFacts): { first: boolean };
    viewerSeen(orderId: string, nowMs: number): boolean;
    // The latest viewer's key, for viewer_key
    viewerOf(orderId: string): IpKey | null;
    anyViewer(nowMs: number): boolean;
    wake: { run: (() => void) | null };
    // At most 10,000 entries
    size(): number;
}

export type DepositPurpose = "deposits.move" | "deposits.read" | "deposits.scan";

export interface DepositRpcQueue {
    // deposits.move on lanes.rpc, deposits.read and deposits.scan on lanes.backgroundRpc
    rpc(purpose: DepositPurpose): SolanaRpc;
    // The day's calls, moves excluded, and their fraction of rpc_calls_per_day
    dayUsed(): { calls: number; fraction: number };
}

export interface DepositJobDeps extends MoveDeps, Omit<SettleDeps, keyof MoveDeps | "routerCalls"> {
    watch: DepositWatch;
    bugnetOwners: ReadonlySet<string>;
    // BUGNET_DEPOSIT_SEED, the key of viewerHash
    seed: Buffer;
    queue: DepositRpcQueue;
}

export interface DepositTick {
    read: number;
    scanned: number;
    settled: number;
    held: number;
    expired: number;
    drained: number;
    blockedEarly: number;
    hardStopPushed: number;
    moves: MoveTick;
}

type Cfg = Settings["deposits"];
type PlanRead = PlanInput["read"];
type Ledger = NonNullable<Awaited<ReturnType<typeof depositLedger>>>;
type HourlyAlarm = "deposit_capacity" | "deposit_create_churn" | "deposit_fee_budget";

const MAX_VIEWERS = 10_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const STEPS_PER_TICK = 4;
const IN_FLIGHT: ReadonlySet<string> = new Set(["pending", "signed", "sent"]);
const RPC_ERROR_NAMES: ReadonlySet<string> = new Set([
    "RpcRouterError",
    "TimeoutError",
    "AbortError",
]);
const SLOW_DAY = 0.8;
const FULL_DAY = 1;
const RANK: Record<DepositPurpose, number> = {
    "deposits.move": 0,
    "deposits.read": 1,
    "deposits.scan": 2,
};

export function createDepositWatch(viewerTtlMs: number, busyEveryMs: number): DepositWatch {
    // Oldest first: an entry moves to the end each time its order is polled
    const viewers = new Map<string, { seenMs: number; ip: IpKey }>();
    let latestMs = Number.NEGATIVE_INFINITY;
    let wokenMs = Number.NEGATIVE_INFINITY;
    const fresh = (seenMs: number, nowMs: number) => nowMs - seenMs < viewerTtlMs;
    const watch: DepositWatch = {
        wake: { run: null },
        noteViewer(orderId, ip, nowMs, facts) {
            if (facts.state !== "open" || nowMs >= facts.expiresAtMs) return { first: false };
            const prev = viewers.get(orderId);
            const first = prev === undefined || !fresh(prev.seenMs, nowMs);
            viewers.delete(orderId);
            for (const [id, v] of viewers) {
                if (viewers.size < MAX_VIEWERS && fresh(v.seenMs, nowMs)) break;
                viewers.delete(id);
            }
            viewers.set(orderId, { seenMs: nowMs, ip });
            latestMs = Math.max(latestMs, nowMs);
            // A flood of polls adds no RPC calls: only a new viewer that needs an account wakes
            // the job, and at most once per busy_every
            const run = watch.wake.run;
            if (first && facts.needsCreate && run !== null && nowMs - wokenMs >= busyEveryMs) {
                wokenMs = nowMs;
                run();
            }
            return { first };
        },
        viewerSeen(orderId, nowMs) {
            const v = viewers.get(orderId);
            return v !== undefined && fresh(v.seenMs, nowMs);
        },
        viewerOf(orderId) {
            return viewers.get(orderId)?.ip ?? null;
        },
        anyViewer(nowMs) {
            return fresh(latestMs, nowMs);
        },
        size() {
            return viewers.size;
        },
    };
    return watch;
}

export function depositInterval(busy: boolean, cfg: Cfg): number {
    return busy ? cfg.busy_every : cfg.idle_every;
}

/**
 * One queue per process over both lanes. Within rpc_calls_per_second it serves moves, then reads,
 * then scans; nothing is ever refused, the day's count only tells the tick to fall back. `sleep`
 * waits for room in the window; tests that drive `now` pass one that moves their clock.
 */
export function depositRpcQueue(
    lanes: { rpc: SolanaRpc; backgroundRpc: SolanaRpc },
    o: {
        perSecond: number;
        perDay: number;
        now: () => number;
        log: Log;
        sleep?: (ms: number) => Promise<void>;
    },
): DepositRpcQueue {
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const started: number[] = [];
    const waiting: { rank: number; seq: number; go: () => void }[] = [];
    let seq = 0;
    let pumping = false;
    let day = Number.NaN;
    let calls = 0;
    let alarmed = 0;

    const countDay = () => {
        const today = Math.floor(o.now() / DAY_MS);
        if (today !== day) {
            day = today;
            calls = 0;
            alarmed = 0;
        }
        calls++;
        for (const [level, mark] of [SLOW_DAY, FULL_DAY].entries()) {
            if (alarmed > level || calls < o.perDay * mark) continue;
            alarmed = level + 1;
            o.log.alarm("deposit_rpc_budget", { callsToday: calls, perDay: o.perDay, mark });
        }
    };
    const pump = async () => {
        if (pumping) return;
        pumping = true;
        try {
            while (waiting.length > 0) {
                const now = o.now();
                while (started.length > 0 && now - started[0]! >= 1_000) started.shift();
                if (started.length >= o.perSecond) {
                    await sleep(started[0]! + 1_000 - now);
                    continue;
                }
                let best = 0;
                for (let i = 1; i < waiting.length; i++) {
                    const a = waiting[i]!;
                    const b = waiting[best]!;
                    if (a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq)) best = i;
                }
                const [next] = waiting.splice(best, 1);
                started.push(now);
                next!.go();
            }
        } finally {
            pumping = false;
        }
    };
    const acquire = (purpose: DepositPurpose): Promise<void> => {
        if (purpose !== "deposits.move") countDay();
        return new Promise<void>((go) => {
            waiting.push({ rank: RANK[purpose], seq: seq++, go });
            void pump();
        });
    };
    const wrap = (lane: SolanaRpc, purpose: DepositPurpose): SolanaRpc =>
        new Proxy(lane, {
            get(target, prop, receiver) {
                const value: unknown = Reflect.get(target, prop, receiver);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                    const pending: unknown = (value as (...a: unknown[]) => unknown).apply(
                        target,
                        args,
                    );
                    if (
                        pending === null ||
                        typeof pending !== "object" ||
                        typeof (pending as { send?: unknown }).send !== "function"
                    ) {
                        return pending;
                    }
                    const send = (pending as { send: (...a: unknown[]) => Promise<unknown> }).send;
                    return {
                        ...pending,
                        send: async (...sendArgs: unknown[]) => {
                            await acquire(purpose);
                            return await send.apply(pending, sendArgs);
                        },
                    };
                };
            },
        });
    const clients: Record<DepositPurpose, SolanaRpc> = {
        "deposits.move": wrap(lanes.rpc, "deposits.move"),
        "deposits.read": wrap(lanes.backgroundRpc, "deposits.read"),
        "deposits.scan": wrap(lanes.backgroundRpc, "deposits.scan"),
    };
    return {
        rpc: (purpose) => clients[purpose],
        dayUsed: () => {
            const today = Math.floor(o.now() / DAY_MS);
            const n = today === day ? calls : 0;
            return { calls: n, fraction: n / o.perDay };
        },
    };
}

// Both lanes count into one hourly anomaly counter of their own, never x402_rpc_budget's
export function countedLanes(
    lanes: { rpc: SolanaRpc; backgroundRpc: SolanaRpc },
    o: { limitPerHour: number; log: Log; now: () => number },
): { rpc: SolanaRpc; backgroundRpc: SolanaRpc } {
    const counter = rpcCounter({ ...o, alarm: "deposit_rpc_budget" });
    return {
        rpc: countingRpc(lanes.rpc, counter),
        backgroundRpc: countingRpc(lanes.backgroundRpc, counter),
    };
}

interface DepositMemory {
    trail: ReadTrail;
    // The read the last plan used, for a tick whose own read failed
    lastRead: PlanRead | null;
    readAtMs: number | null;
    scanDue: boolean;
    // Early CheckPayer answers, kept for the deposit's life in this process (spec 10.1)
    early: Map<string, PayerCheck>;
    earlyAsked: number;
    // What the hard stop's progress rule compares: recorded transfers and the held slot
    seen: { transfers: number; checkedSlot: bigint | null } | null;
    progressAtMs: number | null;
}

interface JobMemory {
    deposits: Map<string, DepositMemory>;
    highestSlot: bigint;
    alarmedAt: Map<HourlyAlarm, number>;
}

// A new DepositWatch is a new process: everything here is rebuilt from the database
const memories = new WeakMap<DepositWatch, JobMemory>();

function jobMemory(watch: DepositWatch): JobMemory {
    let m = memories.get(watch);
    if (m === undefined) {
        m = { deposits: new Map(), highestSlot: 0n, alarmedAt: new Map() };
        memories.set(watch, m);
    }
    return m;
}

function anchorOf(deposit: DepositRow): { slot: bigint; micros: bigint } | null {
    return deposit.checkedSlot === null
        ? null
        : { slot: deposit.checkedSlot, micros: deposit.balanceMicros };
}

function depositMemory(job: JobMemory, deposit: DepositRow): DepositMemory {
    let m = job.deposits.get(deposit.orderId);
    if (m === undefined) {
        m = {
            trail: new ReadTrail(anchorOf(deposit)),
            lastRead: null,
            readAtMs: null,
            scanDue: false,
            early: new Map(),
            earlyAsked: 0,
            seen: null,
            progressAtMs: null,
        };
        job.deposits.set(deposit.orderId, m);
    }
    // A move proof's scan can hold a newer read than this trail's anchor
    const anchor = m.trail.anchor();
    if (deposit.checkedSlot !== null && deposit.checkedSlot > anchor.slot) {
        m.trail.reanchor(deposit.checkedSlot, deposit.balanceMicros);
    }
    return m;
}

// Database conditions of spec 6.4's busy deposit: a move in flight, money the planner has not
// finished with, a hold, or an unpaid order near or past its deadline
async function busyByLedger(pool: pg.Pool, now: Date, cfg: Cfg): Promise<Set<string>> {
    const { rows } = await pool.query<{ order_id: string }>(
        `select d.order_id from deposits d join orders o on o.id = d.order_id
         where d.state in ('open', 'settling', 'draining')
            and (d.hold_reason is not null
                or exists (select 1 from deposit_holds h where h.order_id = d.order_id)
                or exists (select 1 from deposit_moves m where m.order_id = d.order_id
                    and m.state in ('pending', 'signed', 'sent'))
                or exists (select 1 from deposit_transfers t where t.order_id = d.order_id
                    and (t.outcome = 'open'
                        or ((t.outcome = 'return' or (t.outcome = 'paid' and t.reason = 'extra'))
                            and t.applied_micros < t.amount_micros
                            and not exists (select 1 from deposit_moves c
                                where c.id = t.move_id and c.state = 'confirmed'))))
                or (d.state = 'open' and o.state = 'unpaid'
                    and o.expires_at <= $1::timestamptz + make_interval(secs => $2)))`,
        [now, cfg.settle_grace / 1_000],
    );
    return new Set(rows.map((r) => r.order_id));
}

// Unrecorded money or an unfinished scan, which only the job's memory knows
function unsettled(m: DepositMemory | undefined): boolean {
    return (
        m !== undefined && (m.scanDue || (m.lastRead !== null && m.lastRead.invariant !== "held"))
    );
}

export async function depositsBusy(
    pool: pg.Pool,
    watch: DepositWatch,
    now: Date,
    cfg: Cfg,
    dayFraction = 0,
): Promise<boolean> {
    if (dayFraction < SLOW_DAY && watch.anyViewer(now.getTime())) return true;
    for (const m of jobMemory(watch).deposits.values()) if (unsettled(m)) return true;
    return (await busyByLedger(pool, now, cfg)).size > 0;
}

interface TickContext {
    d: DepositJobDeps;
    job: JobMemory;
    tick: DepositTick;
    now: Date;
    nowMs: number;
    cfg: Cfg;
    feeLeft: bigint;
    returnsByOwner: Map<string, number>;
    // New moves to sign before the tick ends
    planned: Set<string>;
}

const ids = (orderId: string) => ({ orderId });
const onTime = (order: Pick<OrderRow, "expiresAt">, t: TransferRow) =>
    t.blockTime.getTime() <= order.expiresAt.getTime();

function rpcWarn(log: Log, msg: string, orderId: string | null, err: unknown): void {
    const cause = err instanceof RpcUnavailable ? err.cause : err;
    log.warn(msg, { ...(orderId === null ? {} : ids(orderId)), ...rpcErrorFields(cause) });
}

// Every RPC failure waits for the next tick (spec 6.5, R8)
function isRpcError(err: unknown): boolean {
    if (err instanceof RpcUnavailable || isSolanaError(err)) return true;
    return err instanceof Error && RPC_ERROR_NAMES.has(err.name);
}

function hourly(c: TickContext, alarm: HourlyAlarm, fields: Record<string, unknown>): void {
    const last = c.job.alarmedAt.get(alarm);
    if (last !== undefined && c.nowMs - last < HOUR_MS) return;
    c.job.alarmedAt.set(alarm, c.nowMs);
    c.d.log.alarm(alarm, fields);
}

export async function runDepositTick(d: DepositJobDeps): Promise<DepositTick> {
    const now = d.now();
    const cfg = d.cfg;
    const job = jobMemory(d.watch);
    const tick: DepositTick = {
        read: 0,
        scanned: 0,
        settled: 0,
        held: 0,
        expired: 0,
        drained: 0,
        blockedEarly: 0,
        hardStopPushed: 0,
        moves: {
            signed: 0,
            resent: 0,
            resigned: 0,
            confirmed: 0,
            failed: 0,
            manual: 0,
            dropped: 0,
            waitingProof: 0,
        },
    };
    await markExpiryDue(d.pool, now, cfg);
    const moveDeps: MoveDeps = { ...d, rpc: d.queue.rpc("deposits.move") };
    addMoves(tick.moves, await advanceMoves(moveDeps));

    const hourAgo = new Date(now.getTime() - HOUR_MS);
    const c: TickContext = {
        d,
        job,
        tick,
        now,
        nowMs: now.getTime(),
        cfg,
        feeLeft:
            BigInt(cfg.free_moves_lamports_per_hour) -
            (await meteredLamports(d.pool, hourAgo, d.feePayer.address, cfg)),
        returnsByOwner: await ownerReturns(d.pool, hourAgo, d.feePayer.address),
        planned: new Set(),
    };

    const watched = await watchedDeposits(d.pool, now, cfg.closed_every);
    pruneMemory(c, watched);
    await storeViewers(c, watched);
    const due = await dueDeposits(c, watched);
    const { reads, failed } = await readBalances(c, due);

    // Step 3 of spec 6.4: plan what needs no scan, queue the rest
    for (const deposit of due) {
        const m = depositMemory(job, deposit);
        const read = reads.get(deposit.orderId);
        try {
            if (read !== undefined) {
                m.trail.push(read);
                const ledger = await depositLedger(d.pool, deposit.orderId);
                if (ledger === null) continue;
                noteProgress(m, ledger, c.nowMs);
                if (needsScan(ledger.deposit, read, ledger.transfers, ledger.moves)) {
                    m.scanDue = true;
                    continue;
                }
                await withDeposit(c, deposit.orderId, (tx, locked) =>
                    recordRead(tx, locked, read, "held", now),
                );
                m.trail.reanchor(read.contextSlot, read.micros);
                m.lastRead = { ...read, invariant: "held" };
                m.scanDue = false;
                await planAndApply(c, deposit.orderId, m.lastRead);
            } else if (failed && m.lastRead !== null && !m.scanDue) {
                await planAndApply(c, deposit.orderId, m.lastRead);
            }
        } catch (err) {
            depositFailed(d.log, deposit.orderId, err);
        }
    }
    await signPlanned(c, moveDeps);

    const scanned = await runScans(c, watched);
    for (const [orderId, result] of scanned) {
        const m = job.deposits.get(orderId)!;
        m.lastRead = { ...result.read, invariant: result.invariant };
        try {
            await planAndApply(c, orderId, m.lastRead);
        } catch (err) {
            depositFailed(d.log, orderId, err);
        }
    }
    await signPlanned(c, moveDeps);
    await pushHardStops(c, watched);
    return tick;
}

function addMoves(into: MoveTick, from: MoveTick): void {
    for (const k of Object.keys(into) as (keyof MoveTick)[]) into[k] += from[k];
}

function depositFailed(log: Log, orderId: string, err: unknown): void {
    if (isRpcError(err)) rpcWarn(log, "deposit rpc call failed, retrying next tick", orderId, err);
    else log.error("deposit step failed, retrying next tick", { orderId, err });
}

// Spec 6.6: a database write only, so the hard stop's clock starts even while the RPC is down
async function markExpiryDue(pool: pg.Pool, now: Date, cfg: Cfg): Promise<void> {
    await pool.query(
        `update deposits d
         set expiry_due_at = $1,
            hard_stop_at = coalesce(d.hard_stop_at, $1::timestamptz + make_interval(secs => $3))
         from orders o
         where o.id = d.order_id and o.state = 'unpaid' and d.expiry_due_at is null
            and d.state in ('open', 'settling', 'draining')
            and o.expires_at + make_interval(secs => $2) <= $1`,
        [now, cfg.settle_grace / 1_000, cfg.expire_hard_after / 1_000],
    );
}

function pruneMemory(c: TickContext, watched: readonly DepositRow[]): void {
    const live = new Set(watched.map((w) => w.orderId));
    const stale = 2 * c.cfg.closed_every;
    for (const [orderId, m] of c.job.deposits) {
        if (live.has(orderId)) continue;
        if (m.readAtMs === null || c.nowMs - m.readAtMs > stale) c.job.deposits.delete(orderId);
    }
}

// Spec 5: the first tick that sees a viewer keeps its keys, hashed, so the rented caps count
// from the database and survive a restart
async function storeViewers(c: TickContext, watched: readonly DepositRow[]): Promise<void> {
    for (const deposit of watched) {
        if (deposit.state !== "open" || deposit.viewerKey !== null) continue;
        if (!c.d.watch.viewerSeen(deposit.orderId, c.nowMs)) continue;
        const ip = c.d.watch.viewerOf(deposit.orderId)!;
        const viewerKey = viewerHash(c.d.seed, ip.key);
        const viewerBlock = ip.block === null ? null : viewerHash(c.d.seed, ip.block);
        await updateDeposit(c.d.pool, deposit.orderId, { viewerKey, viewerBlock });
        deposit.viewerKey = viewerKey;
        deposit.viewerBlock = viewerBlock;
    }
}

async function dueDeposits(c: TickContext, watched: readonly DepositRow[]): Promise<DepositRow[]> {
    const busy = await busyByLedger(c.d.pool, c.now, c.cfg);
    const { fraction } = c.d.queue.dayUsed();
    return watched.filter((deposit) => {
        // watchedDeposits returns a closed deposit only once closed_every has passed
        if (deposit.state === "closed") return true;
        const m = c.job.deposits.get(deposit.orderId);
        const idleDue =
            m === undefined || m.readAtMs === null || c.nowMs - m.readAtMs >= c.cfg.idle_every;
        if (fraction >= FULL_DAY) return idleDue;
        const viewed =
            fraction < SLOW_DAY &&
            deposit.state === "open" &&
            c.d.watch.viewerSeen(deposit.orderId, c.nowMs);
        return idleDue || viewed || busy.has(deposit.orderId) || unsettled(m);
    });
}

// One pinned batch: no read is older than one the job already relied on (spec 6.1)
async function readBalances(
    c: TickContext,
    due: readonly DepositRow[],
): Promise<{ reads: Map<string, AccountRead>; failed: boolean }> {
    if (due.length === 0) return { reads: new Map(), failed: false };
    let pin = 0n;
    for (const deposit of due) {
        const latest = c.job.deposits.get(deposit.orderId)?.trail.latest()?.contextSlot ?? 0n;
        for (const s of [deposit.checkedSlot, deposit.expiryMinSlot, latest]) {
            if (s !== null && s > pin) pin = s;
        }
    }
    try {
        const byAccount = await readDepositBalances(
            c.d.queue.rpc("deposits.read"),
            due.map((deposit) => address(deposit.tokenAccount)),
            { timeoutMs: c.d.rpcTimeoutMs, ...(pin > 0n ? { minContextSlot: pin } : {}) },
        );
        const reads = new Map<string, AccountRead>();
        for (const deposit of due) {
            const read = byAccount.get(deposit.tokenAccount)!;
            reads.set(deposit.orderId, read);
            if (read.contextSlot > c.job.highestSlot) c.job.highestSlot = read.contextSlot;
            depositMemory(c.job, deposit).readAtMs = c.nowMs;
        }
        c.tick.read += reads.size;
        return { reads, failed: false };
    } catch (err) {
        rpcWarn(c.d.log, "deposit balance read failed, retrying next tick", null, err);
        return { reads: new Map(), failed: true };
    }
}

// Scans recorded a transfer or a held read moved the anchor (spec 6.6)
function noteProgress(m: DepositMemory, ledger: Ledger, nowMs: number): void {
    const now = { transfers: ledger.transfers.length, checkedSlot: ledger.deposit.checkedSlot };
    const before = m.seen;
    m.seen = now;
    if (before === null) return;
    const slotMoved =
        now.checkedSlot !== null &&
        (before.checkedSlot === null || now.checkedSlot > before.checkedSlot);
    if (now.transfers > before.transfers || slotMoved) m.progressAtMs = nowMs;
}

/**
 * Spec 6.4 steps 4 and 5: unpaid deposits before their grace ends first, earliest deadline first,
 * then the rest; one scan call per deposit per round, until every scan is done or the tick has
 * spent scan_time_box. A scan that stops keeps its listing and goes on next tick. Past the day's
 * budget only unpaid deposits before their grace ends are scanned.
 */
async function runScans(
    c: TickContext,
    watched: readonly DepositRow[],
): Promise<Map<string, ScanResult>> {
    const { d, cfg } = c;
    const { fraction } = d.queue.dayUsed();
    const queue: { deposit: DepositRow; order: OrderRow; first: boolean }[] = [];
    for (const deposit of watched) {
        const m = c.job.deposits.get(deposit.orderId);
        if (m === undefined || !m.scanDue || m.trail.latest() === null) continue;
        const order = await findOrder(c.d.pool, deposit.orderId);
        if (order === null) continue;
        const first =
            order.state === "unpaid" && c.nowMs < order.expiresAt.getTime() + cfg.settle_grace;
        if (fraction >= FULL_DAY && !first) continue;
        queue.push({ deposit, order, first });
    }
    queue.sort((a, b) => {
        if (a.first !== b.first) return a.first ? -1 : 1;
        return a.order.expiresAt.getTime() - b.order.expiresAt.getTime();
    });
    const scanDeps: ScanDeps = {
        pool: d.pool,
        rpc: d.queue.rpc("deposits.scan"),
        rpcTimeoutMs: d.rpcTimeoutMs,
        cfg,
        cache: d.cache,
        log: d.log,
        now: d.now,
    };
    const results = new Map<string, ScanResult>();
    const stepped = new Set<string>();
    const start = d.now().getTime();
    let active = queue;
    rounds: while (active.length > 0) {
        const next: typeof active = [];
        for (const item of active) {
            if (d.now().getTime() - start >= cfg.scan_time_box) break rounds;
            const { orderId } = item.deposit;
            const m = c.job.deposits.get(orderId)!;
            stepped.add(orderId);
            try {
                const step = await scanStep(scanDeps, item.deposit, m.trail);
                if (!step.done) {
                    next.push(item);
                    continue;
                }
                m.scanDue = false;
                results.set(orderId, step.result);
                c.tick.scanned++;
            } catch (err) {
                if (isRpcError(err)) rpcWarn(d.log, "deposit scan rpc call failed", orderId, err);
                else d.log.error("deposit scan failed, retrying next tick", { orderId, err });
            }
        }
        active = next;
    }
    for (const orderId of stepped) {
        const ledger = await depositLedger(d.pool, orderId);
        if (ledger !== null) noteProgress(c.job.deposits.get(orderId)!, ledger, c.nowMs);
    }
    return results;
}

// The tick plans again after each applied step, up to four steps a deposit
async function planAndApply(c: TickContext, orderId: string, read: PlanRead): Promise<void> {
    const routerCalls = { left: c.cfg.max_split_owners + 1 };
    for (let step = 0; step < STEPS_PER_TICK; step++) {
        const order = await findOrder(c.d.pool, orderId);
        let ledger = await depositLedger(c.d.pool, orderId);
        if (order === null || ledger === null) return;
        if (step === 0 && (await earlyChecks(c, order, ledger, routerCalls))) {
            ledger = (await depositLedger(c.d.pool, orderId))!;
        }
        const plan = planDeposit(await planInput(c, order, ledger, read));
        if (plan.kind === "wait" && c.feeLeft <= 0n && owesMoney(ledger)) {
            hourly(c, "deposit_fee_budget", { limitLamports: c.cfg.free_moves_lamports_per_hour });
        }
        if (!(await apply(c, order, ledger, plan, read, routerCalls))) return;
    }
}

async function planInput(
    c: TickContext,
    order: OrderRow,
    ledger: Ledger,
    read: PlanRead,
): Promise<PlanInput> {
    const { d, cfg } = c;
    const { deposit } = ledger;
    const viewer = { seen: false, ipRented: 0, blockRented: 0 };
    let rented = 0;
    let unpaidCreateLeft = 0n;
    const wantsCreate =
        deposit.state === "open" &&
        deposit.readyAt === null &&
        !read.exists &&
        c.nowMs < order.expiresAt.getTime() &&
        d.watch.viewerSeen(order.id, c.nowMs);
    if (wantsCreate) {
        viewer.seen = true;
        Object.assign(
            viewer,
            await rentedBy(d.pool, deposit.viewerKey, deposit.viewerBlock, d.feePayer.address),
        );
        rented = await rentHolding(d.pool, d.feePayer.address);
        unpaidCreateLeft =
            BigInt(cfg.unpaid_create_lamports_per_hour) -
            (await unpaidCreateLamports(d.pool, new Date(c.nowMs - HOUR_MS)));
        const failedCreates = ledger.moves.filter(
            (m) => m.kind === "create" && m.state === "failed",
        ).length;
        if (rented >= cfg.max_open) {
            hourly(c, "deposit_capacity", { rentHolding: rented, maxOpen: cfg.max_open });
        } else if (
            viewer.ipRented < cfg.rented_per_ip &&
            viewer.blockRented < cfg.rented_per_block &&
            failedCreates < cfg.max_attempts &&
            unpaidCreateLeft < createAndCloseLamports(cfg)
        ) {
            hourly(c, "deposit_create_churn", {
                orderId: order.id,
                limitLamports: cfg.unpaid_create_lamports_per_hour,
            });
        }
    }
    return {
        order,
        deposit,
        read,
        expectedMicros: expectedBalanceAt(ledger.transfers, ledger.moves, read.contextSlot),
        transfers: ledger.transfers,
        moves: ledger.moves,
        holds: ledger.holds,
        bugnetOwners: d.bugnetOwners,
        viewer,
        rentHolding: rented,
        unpaidCreateLeft,
        feeBudgetLeft: c.feeLeft,
        ownerReturns: c.returnsByOwner,
        feePayer: d.feePayer.address,
        now: c.now,
        cfg,
    };
}

/**
 * Spec 10.1, early blocked check: an owner whose on-time open money reaches refund_min_micros is
 * checked once, the first max_split_owners + 1 such owners by first transfer, within the tick's
 * router calls for the deposit. Only a block is acted on, at once and for every later transfer
 * of that owner, so a blocked owner's money never counts as received.
 */
async function earlyChecks(
    c: TickContext,
    order: OrderRow,
    ledger: Ledger,
    routerCalls: { left: number },
): Promise<boolean> {
    const { d, cfg } = c;
    const { deposit } = ledger;
    if (order.state !== "unpaid" || deposit.state !== "open" || deposit.settledAt !== null) {
        return false;
    }
    const m = depositMemory(c.job, deposit);
    const open = [...ledger.transfers]
        .sort(chainOrder)
        .filter(
            (t) =>
                t.outcome === "open" &&
                t.sourceOwner !== null &&
                t.sourceTokenAccount !== null &&
                onTime(order, t) &&
                !d.bugnetOwners.has(t.sourceOwner),
        );
    const sums = new Map<string, number>();
    for (const t of open)
        sums.set(t.sourceOwner!, (sums.get(t.sourceOwner!) ?? 0) + t.amountMicros);
    let target: Awaited<ReturnType<typeof targetOf>> | undefined;
    for (const [owner, sum] of sums) {
        if (m.early.has(owner) || sum < cfg.refund_min_micros) continue;
        if (m.earlyAsked >= cfg.max_split_owners + 1 || routerCalls.left <= 0) break;
        target ??= await targetOf(d, order);
        if (target === null) break;
        routerCalls.left--;
        m.earlyAsked++;
        const check = await d.router.checkPayer(
            { payer: owner, feePayer: d.challengeFeePayer, ...target },
            AbortSignal.timeout(d.rpcTimeoutMs),
        );
        m.early.set(owner, check);
    }
    const rows = open.flatMap((t) => {
        const check = m.early.get(t.sourceOwner!);
        if (check?.verdict !== "blocked") return [];
        return [
            {
                signature: t.signature,
                outcome: "return" as const,
                reason: "payer_blocked" as const,
                blockedUntil:
                    check.blockedUntil === undefined ? null : new Date(check.blockedUntil),
            },
        ];
    });
    if (rows.length === 0) return false;
    await withTx(
        d.pool,
        async (tx) => {
            await lockDeposit(tx, order.id);
            const { rows: still } = await tx.query<{ signature: string }>(
                `select signature from deposit_transfers
                 where order_id = $1 and outcome = 'open' and signature = any($2::text[])`,
                [order.id, rows.map((r) => r.signature)],
            );
            const stillOpen = new Set(still.map((r) => r.signature));
            await setTransferOutcomes(
                tx,
                order.id,
                rows.filter((r) => stillOpen.has(r.signature)),
            );
        },
        d.log,
    );
    c.tick.blockedEarly += rows.length;
    d.log.info("deposit money of a blocked payer goes back", {
        orderId: order.id,
        signatures: rows.map((r) => r.signature),
    });
    return true;
}

// Applies one plan step; true when the tick should plan this deposit again
async function apply(
    c: TickContext,
    order: OrderRow,
    ledger: Ledger,
    plan: Plan,
    read: PlanRead,
    routerCalls: { left: number },
): Promise<boolean> {
    const { d } = c;
    const orderId = order.id;
    switch (plan.kind) {
        case "wait":
            return false;
        case "done":
            await withDeposit(c, orderId, (tx) => updateDeposit(tx, orderId, { state: "done" }));
            return false;
        case "closed":
            await withDeposit(c, orderId, (tx) =>
                updateDeposit(tx, orderId, {
                    state: "closed",
                    closedAt: c.now,
                    watchUntil: new Date(c.nowMs + c.cfg.watch_after_close),
                    rentPayer: null,
                }),
            );
            return false;
        case "drain":
            await withDeposit(c, orderId, async (tx, deposit) => {
                if (deposit.state !== "open") return;
                await updateDeposit(tx, orderId, { state: "draining" });
            });
            c.tick.drained++;
            return true;
        case "ready":
            await withDeposit(c, orderId, (tx) => updateDeposit(tx, orderId, { readyAt: c.now }));
            return true;
        case "assign":
            await assign(c, orderId, plan);
            return true;
        case "need_slot":
            return await pinExpirySlot(c, order);
        case "expire":
            if (await expire(c, order)) c.tick.expired++;
            return true;
        case "move":
            await storeMove(c, ledger.deposit, plan);
            return false;
        case "settle": {
            const settleDeps: SettleDeps = { ...d, rpc: d.queue.rpc("deposits.move"), routerCalls };
            const outcome = await settleDeposit(
                settleDeps,
                orderId,
                plan,
                read.contextSlot,
                AbortSignal.timeout(d.rpcTimeoutMs),
            );
            if (outcome === "settling") c.tick.settled++;
            if (outcome === "held") c.tick.held++;
            return outcome === "returned" || outcome === "held" || outcome === "changed";
        }
    }
}

async function withDeposit(
    c: TickContext,
    orderId: string,
    fn: (tx: pg.PoolClient, deposit: DepositRow) => Promise<void>,
): Promise<void> {
    await withTx(
        c.d.pool,
        async (tx) => {
            const deposit = await lockDeposit(tx, orderId);
            if (deposit === null) throw new Error(`no deposit for ${orderId}`);
            await fn(tx, deposit);
        },
        c.d.log,
    );
}

async function assign(c: TickContext, orderId: string, plan: Extract<Plan, { kind: "assign" }>) {
    await withDeposit(c, orderId, async (tx) => {
        await setTransferOutcomes(tx, orderId, plan.rows);
        if (plan.review !== undefined) {
            await updateDeposit(tx, orderId, { reviewReason: plan.review });
        }
        if (plan.clearHolds) {
            await updateDeposit(tx, orderId, { holdReason: null, recheckAt: null });
            await clearHolds(tx, orderId);
        }
    });
    if (plan.review !== undefined) {
        c.d.log.alarm("deposit_review", { orderId, reason: plan.review });
    }
    for (const r of plan.rows) {
        if (r.outcome !== "review") continue;
        c.d.log.alarm("deposit_review", { orderId, signature: r.signature, reason: r.reason });
    }
}

/**
 * Spec 6.6: the higher of getSlot and the highest context slot the job has seen, kept only when
 * its block time is past the deadline, so a lagging node cannot pin a slot from before a transfer
 * made at the last second. Otherwise the next tick tries again.
 */
async function pinExpirySlot(c: TickContext, order: OrderRow): Promise<boolean> {
    const rpc = c.d.queue.rpc("deposits.read");
    try {
        const head = await rpc
            .getSlot({ commitment: "confirmed" })
            .send(deadline(c.d.rpcTimeoutMs));
        const slot = head > c.job.highestSlot ? head : c.job.highestSlot;
        const seconds = await rpc.getBlockTime(slot).send(deadline(c.d.rpcTimeoutMs));
        if (seconds === null || Number(seconds) * 1_000 <= order.expiresAt.getTime()) return false;
        await withDeposit(c, order.id, async (tx, deposit) => {
            if (deposit.expiryMinSlot === null) {
                await updateDeposit(tx, order.id, { expiryMinSlot: slot });
            }
        });
        return true;
    } catch (err) {
        rpcWarn(c.d.log, "deposit expiry pin failed, retrying next tick", order.id, err);
        return false;
    }
}

async function expire(c: TickContext, order: OrderRow): Promise<boolean> {
    const { d } = c;
    const expired = await withTx(
        d.pool,
        async (tx) => {
            const current = await lockOrder(tx, order.id);
            if (current === null || current.state !== "unpaid") return false;
            if (current.expiresAt.getTime() > c.nowMs) return false;
            await lockDeposit(tx, order.id);
            await expireUnpaidOrder(tx, current, d.x402.x402, d.log);
            return true;
        },
        d.log,
    );
    if (expired) d.log.info("deposit order expired", ids(order.id));
    return expired;
}

// As rule 11 counts it: an owner held until a later recheck is left out
function heldOf(ledger: Ledger, nowMs: number): Held {
    const owners = new Map<string, OwnerHoldReason>();
    let shared = false;
    for (const h of ledger.holds) {
        if (h.recheckAt.getTime() <= nowMs) continue;
        if (h.owner === "") shared = true;
        else owners.set(h.owner, h.reason);
    }
    return { owners, shared };
}

// A metered move spends the tick's budget at once, so later deposits of the tick see it
async function storeMove(
    c: TickContext,
    deposit: DepositRow,
    plan: Extract<Plan, { kind: "move" }>,
): Promise<void> {
    const { orderId } = deposit;
    await withDeposit(c, orderId, async (tx, current) => {
        await insertMove(tx, plan.move, plan.transfers, c.now);
        if (plan.lateReturn === true && current.state === "closed") {
            await updateDeposit(tx, orderId, {
                state: "draining",
                lateReturns: current.lateReturns + 1,
            });
        }
    });
    c.planned.add(orderId);
    if (!plan.metered) return;
    c.feeLeft -= moveFeeLamports({ kind: plan.move.kind, preflightRefusedAt: null }, c.cfg);
    const payer = plan.move.payer;
    if (payer !== null) c.returnsByOwner.set(payer, (c.returnsByOwner.get(payer) ?? 0) + 1);
}

// Money owed back with nothing in flight: past the budget, its metered move is what waits
function owesMoney(ledger: Ledger): boolean {
    const confirmed = new Set(ledger.moves.filter((m) => m.state === "confirmed").map((m) => m.id));
    if (ledger.moves.some((m) => IN_FLIGHT.has(m.state))) return false;
    return ledger.transfers.some(
        (t) =>
            (t.outcome === "return" || (t.outcome === "paid" && t.reason === "extra")) &&
            t.appliedMicros < t.amountMicros &&
            (t.moveId === null || !confirmed.has(t.moveId)),
    );
}

// A new viewer's create, and every move planned this tick, is signed before the tick ends
async function signPlanned(c: TickContext, moveDeps: MoveDeps): Promise<void> {
    if (c.planned.size === 0) return;
    const orderIds = [...c.planned];
    c.planned.clear();
    addMoves(c.tick.moves, await advanceMoves(moveDeps, orderIds));
}

/**
 * Spec 6.6: the hard stop waits for a scan that is catching up. Near the stop, it moves to
 * now + expire_hard_after when the latest read is above the ledger by at least what the price
 * still lacks, the scan made progress within expire_hard_after, and the new stop stays within
 * expire_hard_max of the first time the job saw the grace pass.
 */
async function pushHardStops(c: TickContext, watched: readonly DepositRow[]): Promise<void> {
    const { d, cfg } = c;
    for (const w of watched) {
        if (w.state !== "open") continue;
        const m = c.job.deposits.get(w.orderId);
        const progressAt = m?.progressAtMs ?? null;
        if (progressAt === null || c.nowMs - progressAt > cfg.expire_hard_after) continue;
        const latest = m!.trail.latest();
        if (latest === null) continue;
        const ledger = await depositLedger(d.pool, w.orderId);
        const order = await findOrder(d.pool, w.orderId);
        if (ledger === null || order === null || order.state !== "unpaid") continue;
        if (ledger.deposit.state !== "open") continue;
        const { expiryDueAt, hardStopAt } = ledger.deposit;
        if (expiryDueAt === null || hardStopAt === null) continue;
        if (c.nowMs < hardStopAt.getTime() - cfg.busy_every) continue;
        const pushed = c.nowMs + cfg.expire_hard_after;
        if (pushed > expiryDueAt.getTime() + cfg.expire_hard_max) continue;
        const unrecorded =
            latest.micros - expectedBalanceAt(ledger.transfers, ledger.moves, latest.contextSlot);
        const cov = coverage(
            order.amountMicros,
            ledger.transfers,
            order.expiresAt,
            heldOf(ledger, c.nowMs),
            cfg,
        );
        const lacking = BigInt(order.amountMicros - cov.countedMicros);
        if (lacking <= 0n || unrecorded < lacking) continue;
        const at = new Date(pushed);
        await withDeposit(c, w.orderId, (tx) => updateDeposit(tx, w.orderId, { hardStopAt: at }));
        c.tick.hardStopPushed++;
        d.log.alarm("deposit_index_lag", { orderId: w.orderId, hardStopAt: at.toISOString() });
    }
}
