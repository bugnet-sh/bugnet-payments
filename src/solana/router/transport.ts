/**
 * The router transport (spec 3.3). Each request goes to the first eligible endpoint in list order
 * and fails over down the list inside the caller's signal; an answer the router cannot prove
 * fresh is never returned. With one URL it is a pass-through (spec 3.4). Logs, alarms and the
 * snapshot name endpoints by position only.
 */
import {
    isSolanaError,
    type RpcTransport,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { hasNull, mergeStatuses, statusesOf, type StatusesAnswer } from "./absence.ts";
import { CursorBook } from "./affinity.ts";
import { classifyAnswer, classifyThrown, mayHaveDelivered, type Outcome } from "./classify.ts";
import {
    type Consistency,
    ConsistencyBook,
    type DisagreeReason,
    IdentityBook,
    type Verdict,
    type VerdictRow,
    type VerdictStore,
} from "./consistency.ts";
import { RpcRouterError } from "./errors.ts";
import { EndpointHealth, type Lane } from "./health.ts";
import { LearnedLimits } from "./limits.ts";
import { UNKNOWN_METHOD } from "./methods.ts";
import { contextSlotOf, isObject, readRequest, type RouterRequest, rpcErrorOf } from "./payload.ts";
import {
    CHECK_PARTS,
    CHECK_TOTAL_MS,
    type CheckPart,
    type CheckReport,
    checkEndpoint,
    type EndpointCheck,
    type HistoryProbe,
} from "./probe.ts";
import { choose, type EndpointView } from "./select.ts";
import { copyPayload, isMissingBlockhashSimulation } from "./send.ts";
import {
    checkRpcList,
    domainOf,
    endpointName,
    parseRpcUrls,
    resolveRpcList,
    ROLES,
    type Role,
    type RpcSettings,
} from "./settings.ts";
import { observationsOf, SlotBook } from "./slots.ts";
import {
    AlarmBook,
    type AlarmView,
    type Counters,
    type SnapshotStore,
    UsageBook,
    type UsageStore,
} from "./usage.ts";

// A wait for a cooldown or for room is at most this long in all, inside the caller's signal
export const MAX_WAIT_MS = 1_000;

const TICK_MS = 5_000;
const ENDPOINT_SCOPE = "*";
// Transaction history is not available from this node
const NO_HISTORY = -32011;
const ATTEMPT_FAILED = "rpc attempt failed";
const COPY_FAILED = "rpc send copy failed";

export type RouterAlarm =
    "rpc_endpoint_down" | "rpc_all_endpoints_down" | "rpc_endpoint_lag" | "rpc_absence_unconfirmed";

export interface RouterLog {
    info(msg: string, f?: Record<string, unknown>): void;
    warn(msg: string, f?: Record<string, unknown>): void;
    alarm(name: RouterAlarm, f?: Record<string, unknown>): void;
}

export interface RouterDeps {
    log: RouterLog;
    now: () => number;
    random: () => number;
    // name: "rpc1", "rpc2", ... in list order
    transportFor: (name: string, url: string) => RpcTransport;
    // The waits for room or a cooldown; the signal ends one
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    // Payments' own history for the checks; the mainnet probe without one (spec 9)
    historyProbe?: () => Promise<HistoryProbe | null>;
    // Consistency verdicts across restarts and processes (spec 8.10)
    verdicts?: VerdictStore;
    // With verdicts: an HMAC of the URL, never the URL
    fingerprint?: (url: string) => string;
    // The month's requests per position, loaded at start and flushed on the tick and at stop
    usage?: UsageStore;
    // The health snapshot the CLI reads, written on the tick
    snapshots?: SnapshotStore;
}

// Calling the router itself is the money lane
export interface RouterTransport extends RpcTransport {
    readonly mode: "single" | "routed";
    readonly background: RpcTransport;
    // timers: the service's 5 s tick; without it (the CLI) the whole check run is awaited
    start(o: { timers: boolean }): Promise<CheckReport>;
    check(): Promise<CheckReport>;
    tick(): Promise<void>;
    snapshot(): RouterSnapshot;
    stop(): Promise<void>;
}

// The per-endpoint check results of spec 9
export interface CheckState {
    // "ok", "wrong", or "error" with what failed, such as "error http_400"
    genesis: string;
    // "ok", "missing", "error" or "unchecked"
    history: string;
    // "ok", "ignored", "error" or "unchecked"
    pinnedAccounts: string;
    pinnedSignatures: string;
}

export interface EndpointSnapshot {
    name: string;
    // Earned: history only while its check passed
    roles: Role[];
    state: "ok" | "probation" | "cooling" | "open" | "lagging" | "unchecked" | "wrong_network";
    untilMs: number | null;
    latencyMs: number;
    errorRate: number;
    inflight: number;
    confirmedSlot: string | null;
    lag: number | null;
    consistent: Consistency;
    // Per 10 s; "*" is the whole endpoint
    limits: Record<string, number>;
    monthRequests: number;
    monthBackground: number;
    hourRequests: number;
    // This hour
    laneRequests: { money: number; background: number };
    // Method, then outcome, then count, this hour
    outcomes: Record<string, Record<string, number>>;
    checks: CheckState;
    lastError: {
        at: number;
        err: string;
        code?: number;
        status?: number;
        reason?: string;
        cause?: string;
    } | null;
}

export interface RouterSnapshot {
    at: number;
    mode: "single" | "routed";
    // The first endpoint that takes reads now
    serving: string | null;
    // Counts only, never a domain
    domains: number;
    absenceQuorum: number;
    sendFanout: number;
    endpoints: EndpointSnapshot[];
}

type ErrorSnapshot = Omit<NonNullable<EndpointSnapshot["lastError"]>, "at">;

// The code or status an alarm carries
interface ErrorCode {
    code?: number;
    status?: number;
}

interface Endpoint {
    readonly name: string;
    // Never logged, stored or shown
    readonly domain: string;
    readonly fingerprint: string | null;
    readonly transport: RpcTransport;
    readonly health: EndpointHealth;
    readonly limits: LearnedLimits;
    // The last result of each check, as shown
    checks: CheckState;
    // Whether each check passed: an error keeps the last value, which at start is false
    passed: Record<keyof CheckState, boolean>;
    // The warns and alarms of a check's current failure, so each is raised once
    readonly alerted: Set<"unreachable" | "history" | "pinned">;
    // At most one check run and one probe at a time
    checking: Promise<EndpointCheck> | null;
    probing: boolean;
    // The checks that ended in an error run again at `at`, and each failure doubles the wait
    retry: { parts: ReadonlySet<CheckPart>; at: number; step: number } | null;
    // The next run of the history and pinned checks
    hourlyAt: number | null;
    // The pin of its last -32016 or answer below a pin, tried last for pins at or above it
    behindPin: { slot: bigint; at: number } | null;
    lastError: EndpointSnapshot["lastError"];
    readonly counters: Counters;
}

type Attempt =
    | { readonly kind: "answer"; readonly answer: unknown; readonly elapsed: number }
    | {
          readonly kind: "thrown";
          readonly err: unknown;
          readonly elapsed: number;
          readonly callerAborted: boolean;
          readonly timedOut: boolean;
      };

// One request's attempts
interface Run {
    readonly tried: Set<string>;
    attempts: number;
    waited: number;
    // A first attempt cut at its first-attempt timeout is a strike only when the next attempt
    // answers in less time than the cut (spec 6.4)
    cut: { ep: Endpoint; ms: number } | null;
    // A 400 is a strike only once another endpoint serves the same request
    badRequests: { ep: Endpoint; ms: number }[];
    errorAnswer: { answer: unknown } | null;
    thrown: { err: unknown } | null;
    // The last endpoint whose answer was refused for its slot
    stale: string | null;
    // An endpoint was passed over because it could not prove the page's cursor
    unproven: boolean;
    // An attempt of this send may have delivered it, so no later refusal is a clean one
    delivered: boolean;
    // A simulation that missed the payer's blockhash, returned if no other endpoint answers
    missed: { answer: unknown } | null;
    // The warn of a failed attempt
    readonly failure: string;
}

// A listing's before cursor (spec 8.5)
interface Cursor {
    // The endpoint whose page ended with the cursor, which needs no check
    readonly producer: string | null;
    // Any other endpoint gets this call first, and runs the page only when proves accepts it
    readonly check: unknown;
    readonly checkRequest: RouterRequest;
    readonly proves: (answer: unknown) => boolean;
    // Endpoints whose check passed in this request, which take the page with no further check
    readonly proven: Set<string>;
}

type Step =
    | { kind: "answer"; answer: unknown; ok: boolean }
    | { kind: "throw"; err: unknown }
    | { kind: "next" };

type Choice =
    | { kind: "try"; ep: Endpoint }
    | { kind: "wait"; ms: number }
    | { kind: "stop"; blocked: boolean };

type Config = Readonly<{ payload: unknown; signal?: AbortSignal }>;

const CHECK_KEYS = ["genesis", "history", "pinnedAccounts", "pinnedSignatures"] as const;
const UNCHECKED: CheckState = {
    genesis: "unchecked",
    history: "unchecked",
    pinnedAccounts: "unchecked",
    pinnedSignatures: "unchecked",
};
// The parts an hourly run repeats; the genesis and first slot reads are the boot run's
const HOURLY: readonly CheckPart[] = ["identity", "pinnedAccounts", "pinnedSignatures", "history"];
const RETRIED = ["genesis", "pinnedAccounts", "pinnedSignatures", "history"] as const;
const EPOCH_PAYLOAD = {
    jsonrpc: "2.0",
    id: 0,
    method: "getEpochInfo",
    params: [{ commitment: "confirmed" }],
} as const;
const EPOCH_REQUEST = readRequest(EPOCH_PAYLOAD)!;
const WITH_HISTORY: ReadonlySet<Role> = new Set(ROLES);
const WITHOUT_HISTORY: ReadonlySet<Role> = new Set(ROLES.filter((r) => r !== "history"));
const SERVING_REQUEST = readRequest({
    jsonrpc: "2.0",
    id: 0,
    method: "getSlot",
    params: [{ commitment: "confirmed" }],
})!;
// What the all-down alarm asks of each role (spec 10.2)
const ROLE_REQUESTS: Readonly<Record<Role, RouterRequest>> = {
    read: SERVING_REQUEST,
    history: readRequest({
        jsonrpc: "2.0",
        id: 0,
        method: "getTransaction",
        params: ["", { commitment: "confirmed" }],
    })!,
    send: readRequest({
        jsonrpc: "2.0",
        id: 0,
        method: "sendTransaction",
        params: ["", { encoding: "base64" }],
    })!,
};
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
// A result that is not what the method returns, like a 200 that is not JSON
const UNFIT: Outcome = {
    kind: "failover",
    strike: true,
    history: false,
    retryAfterMs: null,
    ambiguous: true,
};

const ROUTERS = new WeakMap<RpcTransport, Router>();

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal!.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

// A payload the router cannot read gets one attempt and no checks, like an unknown method
function opaqueRequest(payload: unknown): RouterRequest {
    return {
        method: isObject(payload) && typeof payload.method === "string" ? payload.method : "",
        spec: UNKNOWN_METHOD,
        params: [],
        commitment: "finalized",
        minContextSlot: null,
        searchHistory: false,
        needsHistory: false,
        before: null,
        until: null,
        accounts: 0,
        signatures: [],
    };
}

function codeLabel(code: number): string {
    return Number.isInteger(code) ? `code_${code}` : "code_invalid";
}

function thrownLabel(err: unknown): string {
    if (isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
        return `http_${err.context.statusCode}`;
    }
    return err instanceof TypeError ? "network" : "error";
}

// The error's name, HTTP status and system code only: a message can carry the URL's key
function thrownError(err: unknown): ErrorSnapshot {
    if (isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
        return { err: err.name, status: err.context.statusCode };
    }
    if (!(err instanceof Error)) return { err: "error" };
    const { cause } = err;
    const code = isObject(cause) && typeof cause.code === "string" ? cause.code : null;
    return err instanceof TypeError && code !== null && SYSTEM_CODE.test(code)
        ? { err: err.name, cause: code }
        : { err: err.name };
}

function codeOf(e: ErrorSnapshot): ErrorCode {
    return {
        ...(e.code === undefined ? {} : { code: e.code }),
        ...(e.status === undefined ? {} : { status: e.status }),
    };
}

// A null transaction, or one whose meta cannot explain a token balance (spec 8.3)
function lacksTransaction(answer: unknown): boolean {
    if (!isObject(answer)) return false;
    const { result } = answer;
    if (result === null) return true;
    if (!isObject(result)) return false;
    const { meta } = result;
    return (
        !isObject(meta) ||
        !Array.isArray(meta.preTokenBalances) ||
        !Array.isArray(meta.postTokenBalances)
    );
}

// A cursor's predecessor with limit 1 must give back the cursor and nothing else
function isOnly(answer: unknown, signature: string): boolean {
    if (!isObject(answer) || !Array.isArray(answer.result) || answer.result.length !== 1) {
        return false;
    }
    const [first] = answer.result;
    return isObject(first) && first.signature === signature;
}

// R8: a caller reads a missing entry as null, so statuses that are not one per signature asked
// could turn a landed transaction into a missing one
function unfitStatuses(req: RouterRequest, answer: unknown): boolean {
    if (req.method !== "getSignatureStatuses" || req.signatures.length === 0) return false;
    return statusesOf(answer)?.result.value.length !== req.signatures.length;
}

function hasStatus(answer: unknown): boolean {
    const value = statusesOf(answer)?.result.value;
    return value?.length === 1 && value[0] !== null;
}

function newRun(failure = ATTEMPT_FAILED): Run {
    return {
        tried: new Set(),
        attempts: 0,
        waited: 0,
        cut: null,
        badRequests: [],
        errorAnswer: null,
        thrown: null,
        stale: null,
        unproven: false,
        delivered: false,
        missed: null,
        failure,
    };
}

function pageOf(answer: unknown): { signature: string }[] | null {
    if (!isObject(answer) || !Array.isArray(answer.result)) return null;
    const page: unknown[] = answer.result;
    return page.every((e) => isObject(e) && typeof e.signature === "string")
        ? (page as { signature: string }[])
        : null;
}

function erroredParts(c: EndpointCheck): Set<CheckPart> {
    return new Set<CheckPart>(RETRIED.filter((part) => c[part] === "error"));
}

// A rerun's results over the first run's, for the parts the rerun asked
function merged(first: EndpointCheck, again: EndpointCheck): EndpointCheck {
    const genesis = again.genesis === "unchecked" ? first : again;
    const history = again.history === "unchecked" ? first : again;
    return {
        name: first.name,
        genesis: genesis.genesis,
        genesisError: genesis.genesisError,
        pinnedAccounts:
            again.pinnedAccounts === "unchecked" ? first.pinnedAccounts : again.pinnedAccounts,
        pinnedSignatures:
            again.pinnedSignatures === "unchecked"
                ? first.pinnedSignatures
                : again.pinnedSignatures,
        history: history.history,
        repeatsAgree: history.repeatsAgree,
        identity: again.identity ?? first.identity,
        slot: again.slot ?? first.slot,
        latencyMs: again.slot === null ? first.latencyMs : again.latencyMs,
    };
}

// The status or code a genesis failure names, for its alarm
function failureCode(label: string | null): ErrorCode {
    const m = /^(http|code)_(-?\d+)$/.exec(label ?? "");
    if (m === null) return {};
    return m[1] === "http" ? { status: Number(m[2]) } : { code: Number(m[2]) };
}

class Router {
    readonly mode: "single" | "routed";
    private readonly endpoints: Endpoint[];
    private readonly byName: Map<string, Endpoint>;
    private readonly slots: SlotBook;
    private readonly book: ConsistencyBook;
    private readonly cursors = new CursorBook();
    private readonly identities = new IdentityBook();
    private readonly list: { domains: number; absenceQuorum: number; sendFanout: number };
    private readonly usage: UsageBook;
    private readonly alarms: AlarmBook;
    // Ends every check run and probe at stop
    private readonly stopper = new AbortController();
    private readonly runs = new Set<Promise<unknown>>();
    private verdictsRead: Promise<void> | null = null;
    // Verdicts are written one after another, in the order they changed
    private saving: Promise<void> = Promise.resolve();
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly s: RpcSettings,
        urls: readonly string[],
        private readonly deps: RouterDeps,
    ) {
        this.mode = urls.length === 1 ? "single" : "routed";
        this.list = resolveRpcList(s, urls);
        const stored = deps.verdicts !== undefined ? deps.fingerprint : undefined;
        this.usage = new UsageBook(
            s,
            urls.map((_, i) => endpointName(i)),
            deps,
        );
        this.alarms = new AlarmBook(s, deps.log);
        this.endpoints = urls.map((url, i) => {
            const name = endpointName(i);
            return {
                name,
                domain: domainOf(url),
                fingerprint: stored === undefined ? null : stored(url),
                transport: deps.transportFor(name, url),
                health: new EndpointHealth(s, deps.now, deps.random),
                limits: new LearnedLimits(s, deps.now, deps.random),
                checks: { ...UNCHECKED },
                passed: {
                    genesis: false,
                    history: false,
                    pinnedAccounts: false,
                    pinnedSignatures: false,
                },
                alerted: new Set(),
                checking: null,
                probing: false,
                retry: null,
                hourlyAt: null,
                behindPin: null,
                lastError: null,
                counters: this.usage.of(name),
            };
        });
        this.byName = new Map(this.endpoints.map((ep) => [ep.name, ep]));
        this.slots = new SlotBook({
            now: deps.now,
            isReference: (name) => {
                const ep = this.byName.get(name);
                return (
                    ep !== undefined &&
                    ep.health.breaker() === "closed" &&
                    ep.limits.endpointCoolingUntil() === 0
                );
            },
            sampleMaxAgeMs: 2 * s.probe_every,
            maxSlotLag: s.max_slot_lag,
            onDrop: (name) => this.disagree(name, "slot_went_back"),
        });
        this.book = new ConsistencyBook({ now: deps.now, clearAfterMs: s.history_check_every });
        this.book.onChange((name, v) => this.saveVerdict(name, v));
    }

    async request(config: Config, lane: Lane): Promise<unknown> {
        if (this.mode === "single") return this.single(config, lane);
        const { payload, signal } = config;
        const req = readRequest(payload) ?? opaqueRequest(payload);
        const maxAttempts = req.spec.retry ? this.s.max_attempts : 1;
        const send = req.spec.kind === "send";
        const run = newRun();
        const cursor = this.cursorOf(req, payload);
        // The checks keep their own 400s and never end the page's first-attempt cut (spec 7.2)
        const checks = newRun();
        for (;;) {
            if (signal?.aborted) throw signal.reason;
            if (run.attempts >= maxAttempts) break;
            const next = this.pick(req, lane, run, undefined, cursor);
            if (next.kind === "wait") {
                await this.wait(next.ms, signal);
                run.waited += next.ms;
                continue;
            }
            if (next.kind === "stop") {
                // The endpoints left are only busy, and the router does not wait longer
                if (next.blocked) return this.end(run, true);
                break;
            }
            const { ep } = next;
            // R6: a page with a cursor runs only where the cursor came from or was proven
            if (cursor !== null && !this.holdsCursor(ep, cursor)) {
                run.tried.add(ep.name);
                if (await this.proveCursor(ep, cursor, signal, lane, checks)) {
                    cursor.proven.add(ep.name);
                    run.tried.delete(ep.name);
                } else {
                    run.unproven = true;
                }
                // Other calls may have taken the room while the check ran, so the page is picked
                // again: its room is then checked in the same run that records it (spec 6.3)
                continue;
            }
            const firsts = this.s.first_attempt_timeouts;
            const cutMs =
                run.attempts === 0 && Object.hasOwn(firsts, req.method)
                    ? firsts[req.method]!
                    : null;
            run.tried.add(ep.name);
            run.attempts += 1;
            const timeoutMs = cutMs ?? this.s.attempt_timeout;
            const a = await this.attempt(ep, req, payload, signal, lane, timeoutMs);
            let step = this.settle(ep, req, a, run, cutMs, timeoutMs, signal);
            if (send) step = this.sendStep(req, a, step, run);
            if (step.kind === "throw") throw step.err;
            if (step.kind === "answer") {
                // Spec 8.6: one more endpoint is asked, and its answer is returned whatever it says
                if (
                    step.ok &&
                    req.method === "simulateTransaction" &&
                    run.missed === null &&
                    isMissingBlockhashSimulation(step.answer)
                ) {
                    run.missed = { answer: step.answer };
                    continue;
                }
                if (step.ok && send) this.copySend(ep, payload, run);
                if (step.ok && req.spec.nullRetry && lacksTransaction(step.answer)) {
                    return this.askAgain(ep, step.answer, req, payload, signal, lane, run);
                }
                if (step.ok && req.method === "getSignatureStatuses" && req.searchHistory) {
                    return this.confirmAbsence(ep, step.answer, req, payload, signal, lane, run);
                }
                if (step.ok && req.method === "getSignaturesForAddress") {
                    this.rememberPage(ep, req, step.answer);
                }
                return step.answer;
            }
        }
        return this.end(run, false);
    }

    snapshot(): RouterSnapshot {
        const now = this.deps.now();
        return {
            at: now,
            mode: this.mode,
            serving: this.serving(now),
            domains: this.list.domains,
            absenceQuorum: this.list.absenceQuorum,
            sendFanout: this.list.sendFanout,
            endpoints: this.endpoints.map((ep) => this.endpointSnapshot(ep)),
        };
    }

    // Each check given counts as passed exactly when it is "ok"
    setCheckState(name: string, state: Partial<CheckState> & { consistent?: "yes" | "no" }): void {
        const ep = this.endpoint(name);
        for (const key of CHECK_KEYS) {
            const value = state[key];
            if (value === undefined) continue;
            ep.checks[key] = value;
            ep.passed[key] = value === "ok";
        }
        if (state.consistent === "no") this.book.disagree(name, "check_disagreed");
        // A yes follows the book's own rule: a "no" clears only an hour after its mark
        else if (state.consistent === "yes") this.book.checkRun(name, true, this.deps.now());
    }

    // Spec 9: the stored verdicts and the month's counts first, then the checks; a wrong genesis
    // refuses the start
    async start(o: { timers: boolean }): Promise<CheckReport> {
        await Promise.all([this.readVerdicts(), this.usage.load()]);
        let report: CheckReport;
        if (this.mode === "single") report = await this.startSingle();
        else report = o.timers ? await this.boot() : await this.checkAll(true);
        const wrong = report.endpoints.find((c) => c.genesis === "wrong");
        if (wrong !== undefined) throw new RpcRouterError("wrong_network", wrong.name);
        if (o.timers) this.startTimer();
        return report;
    }

    // Every check once, in either mode; a wrong genesis is reported, not thrown
    async check(): Promise<CheckReport> {
        await this.readVerdicts();
        return this.checkAll(false);
    }

    // The alarms, the usage flush and the snapshot (spec 10) read the state before this tick's
    // calls; then the probes of spec 6.2 and 6.5 and the reruns of spec 9, which single mode has
    // none of
    async tick(): Promise<void> {
        const now = this.deps.now();
        if (this.mode === "routed") this.alarms.evaluate(now, this.alarmView(now));
        const work: Promise<unknown>[] = [this.usage.tick(() => this.snapshot())];
        if (this.mode === "single") {
            await Promise.all(work);
            return;
        }
        const due: { ep: Endpoint; parts: Set<CheckPart> }[] = [];
        for (const ep of this.endpoints) {
            if (ep.checks.genesis === "wrong") continue;
            const parts = this.dueParts(ep, now);
            if (parts !== null) due.push({ ep, parts });
            // A probe waits out a Retry-After like any call
            if (ep.probing || ep.limits.coolingUntil(EPOCH_REQUEST.method) !== 0) continue;
            if (ep.health.probeDue()) {
                work.push(this.recover(ep));
            } else if (this.marksStale(ep, now)) {
                work.push(this.probeEpoch(ep, this.s.attempt_timeout));
            }
        }
        if (due.length > 0) {
            const probe = this.historyProbe();
            for (const { ep, parts } of due) {
                work.push(this.runChecks(ep, parts, probe, this.stopper.signal));
            }
        }
        await Promise.all(work);
    }

    async stop(): Promise<void> {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        this.stopper.abort();
        await Promise.allSettled([...this.runs]);
        await this.usage.stop();
        await this.saving;
    }

    private startTimer(): void {
        if (this.timer !== null) return;
        this.timer = setInterval(() => {
            this.tick().catch((err: unknown) => this.deps.log.warn("rpc tick failed", { err }));
        }, TICK_MS);
        this.timer.unref();
    }

    // Spec 3.4: one genesis call; only a wrong network stops the start
    private async startSingle(): Promise<CheckReport> {
        const ep = this.endpoints[0]!;
        const c = await this.runChecks(ep, new Set(["genesis"]), null, this.stopper.signal);
        if (c.genesis === "error") {
            this.deps.log.warn("rpc genesis check failed", {
                endpoint: ep.name,
                outcome: c.genesisError,
            });
        }
        return { endpoints: [c] };
    }

    // The service waits for each endpoint's genesis and slot reads only, and the rest of each
    // run goes on in the background, so a stalled history call cannot hold the start (spec 9)
    private async boot(): Promise<CheckReport> {
        const probe = this.historyProbe();
        const parts = new Set(CHECK_PARTS);
        const booted = this.endpoints.map(
            (ep) =>
                new Promise<EndpointCheck>((resolve, reject) => {
                    const run = this.runChecks(ep, parts, probe, this.stopper.signal, resolve);
                    run.then(resolve, reject);
                }),
        );
        return { endpoints: await Promise.all(booted) };
    }

    // The CLI and the probe command: whole runs, at most CHECK_TOTAL_MS; with rerun, each check
    // that ended in an error runs once more within that time
    private async checkAll(rerun: boolean): Promise<CheckReport> {
        const cap = new AbortController();
        const timer = setTimeout(() => cap.abort(), CHECK_TOTAL_MS);
        const signal = AbortSignal.any([this.stopper.signal, cap.signal]);
        try {
            const probe = this.historyProbe();
            const all = new Set(CHECK_PARTS);
            const checks = this.endpoints.map(async (ep) => {
                const first = await this.runChecks(ep, all, probe, signal);
                const again = erroredParts(first);
                if (!rerun || again.size === 0 || signal.aborted) return first;
                return merged(first, await this.runChecks(ep, this.runParts(again), probe, signal));
            });
            return { endpoints: await Promise.all(checks) };
        } finally {
            clearTimeout(timer);
        }
    }

    private runChecks(
        ep: Endpoint,
        parts: ReadonlySet<CheckPart>,
        probe: Promise<HistoryProbe | null> | null,
        signal: AbortSignal,
        onBoot?: (c: EndpointCheck) => void,
    ): Promise<EndpointCheck> {
        // A run dates from its start: a disagreeing one marks from it, a passing one clears only
        // an hour after the mark (spec 8.10)
        const startedAt = this.deps.now();
        const run = (async () => {
            const c = await checkEndpoint(this.checkTransport(ep), ep.name, await probe, {
                timeoutMs: this.s.attempt_timeout,
                now: this.deps.now,
                genesisOnly: false,
                parts,
                slot: this.slots.highWater("confirmed", "slot"),
                signal,
                onBoot:
                    onBoot &&
                    ((partial) => {
                        this.applyChecks(ep, partial, startedAt);
                        onBoot(partial);
                    }),
            });
            this.applyChecks(ep, c, startedAt);
            if (this.mode === "routed") this.schedule(ep, c, parts, startedAt);
            return c;
        })();
        ep.checking = run;
        const done = (): void => {
            if (ep.checking === run) ep.checking = null;
        };
        this.track(run.then(done, done));
        return run;
    }

    private track(work: Promise<unknown>): void {
        this.runs.add(work);
        const done = (): void => void this.runs.delete(work);
        work.then(done, done);
    }

    // Every run asks the node's identity (spec 8.10); the slot read comes with a genesis check,
    // and otherwise only when no slot is known for the pinned checks
    private runParts(parts: Iterable<CheckPart>): Set<CheckPart> {
        const set = new Set<CheckPart>(["identity", ...parts]);
        const pinned = set.has("pinnedAccounts") || set.has("pinnedSignatures");
        if (set.has("genesis") || (pinned && this.slots.highWater("confirmed", "slot") === null)) {
            set.add("slot");
        }
        return set;
    }

    // The hourly run brings the errored checks along; before it, only they run (spec 9)
    private dueParts(ep: Endpoint, now: number): Set<CheckPart> | null {
        if (ep.checking !== null) return null;
        const hourly = ep.hourlyAt !== null && now >= ep.hourlyAt;
        const retry = ep.retry !== null && now >= ep.retry.at;
        if (!hourly && !retry) return null;
        return this.runParts([...(hourly ? HOURLY : []), ...(ep.retry?.parts ?? [])]);
    }

    private schedule(
        ep: Endpoint,
        c: EndpointCheck,
        parts: ReadonlySet<CheckPart>,
        startedAt: number,
    ): void {
        const errored = erroredParts(c);
        if (errored.size === 0) {
            ep.retry = null;
        } else {
            // probe_every, then twice as long each time, at most history_check_every
            const step = ep.retry?.step ?? 0;
            const wait = Math.min(this.s.probe_every * 2 ** step, this.s.history_check_every);
            ep.retry = { parts: errored, at: startedAt + wait, step: step + 1 };
        }
        if (HOURLY.every((part) => parts.has(part))) {
            ep.hourlyAt = startedAt + this.s.history_check_every;
        }
    }

    // An error keeps what the endpoint had; at start that is "not passed" (spec 9)
    private applyChecks(ep: Endpoint, c: EndpointCheck, startedAt: number): void {
        const routed = this.mode === "routed";
        if (c.genesis !== "unchecked") {
            const failed = c.genesis === "error";
            ep.checks.genesis =
                failed && c.genesisError !== null ? `error ${c.genesisError}` : c.genesis;
            if (!failed) ep.passed.genesis = c.genesis === "ok";
            if (c.genesis === "ok") ep.alerted.delete("unreachable");
            if (failed && routed && !ep.alerted.has("unreachable")) {
                ep.alerted.add("unreachable");
                this.deps.log.alarm("rpc_endpoint_down", {
                    endpoint: ep.name,
                    reason: "unreachable",
                    ...failureCode(c.genesisError),
                });
            }
        }
        if (c.identity !== null) this.sawIdentity(ep, c.identity);
        for (const key of ["pinnedAccounts", "pinnedSignatures"] as const) {
            const result = c[key];
            if (result === "unchecked") continue;
            ep.checks[key] = result;
            if (result !== "error") ep.passed[key] = result === "ok";
        }
        if (c.history !== "unchecked") {
            ep.checks.history = c.history;
            if (c.history === "ok") {
                ep.passed.history = true;
                ep.alerted.delete("history");
                this.book.passHistory(ep.name);
            } else if (c.history === "missing") {
                ep.passed.history = false;
            }
        }
        // A run whose repeats did not all answer decides nothing (spec 8.10)
        if (c.repeatsAgree !== null) {
            const before = this.book.state(ep.name);
            this.book.checkRun(ep.name, c.repeatsAgree, startedAt);
            if (routed) this.marked(ep.name, before, "check_disagreed");
        }
        if (routed) this.alertChecks(ep, c);
    }

    // After the run's consistency verdict, which decides the pinned alarm
    private alertChecks(ep: Endpoint, c: EndpointCheck): void {
        if (c.history === "missing" && !ep.alerted.has("history")) {
            ep.alerted.add("history");
            // A history that passed before and is gone now is a provider that cut its retention
            if (this.book.historyPassed(ep.name)) {
                this.deps.log.alarm("rpc_endpoint_down", {
                    endpoint: ep.name,
                    reason: "history_missing",
                });
            } else {
                this.deps.log.warn("rpc endpoint has no history", { endpoint: ep.name });
            }
        }
        const pinned = [c.pinnedAccounts, c.pinnedSignatures];
        if (pinned.every((result) => result === "ok")) {
            ep.alerted.delete("pinned");
        } else if (
            pinned.includes("ignored") &&
            this.book.state(ep.name) === "yes" &&
            !ep.alerted.has("pinned")
        ) {
            // An inconsistent endpoint gets no listings anyway
            ep.alerted.add("pinned");
            this.deps.log.alarm("rpc_endpoint_down", {
                endpoint: ep.name,
                reason: "min_context_slot_ignored",
            });
        }
    }

    // Two endpoints that ever reported one node count as one domain from then on (spec 8.10)
    private sawIdentity(ep: Endpoint, identity: string): void {
        const at = (name: string) => this.endpoints.findIndex((e) => e.name === name);
        for (const other of this.identities.saw(ep.name, identity)) {
            const endpoints = [ep.name, other].toSorted((x, y) => at(x) - at(y));
            this.deps.log.warn("rpc endpoints share a node", { endpoints });
        }
    }

    // Spec 6.5: an endpoint without a confirmed slot and height in probe_every
    private marksStale(ep: Endpoint, now: number): boolean {
        if (!ep.passed.genesis || ep.health.breaker() !== "closed") return false;
        return (["slot", "height"] as const).some((kind) => {
            const mark = this.slots.mark(ep.name, "confirmed", kind);
            return mark === null || now - mark.lastSeen >= this.s.probe_every;
        });
    }

    // Spec 6.2: good is an answer within the first-attempt timeout, at or above the floor, with
    // a lag of at most half the bound
    private async recover(ep: Endpoint): Promise<void> {
        const firsts = this.s.first_attempt_timeouts;
        const timeoutMs = Object.hasOwn(firsts, EPOCH_REQUEST.method)
            ? firsts[EPOCH_REQUEST.method]!
            : this.s.attempt_timeout;
        const floors = this.floorsOf(EPOCH_REQUEST);
        const sentAt = this.deps.now();
        const a = await this.probeEpoch(ep, timeoutMs);
        const good =
            a !== null &&
            a.elapsed <= timeoutMs &&
            rpcErrorOf(a.answer) === null &&
            observationsOf(EPOCH_REQUEST, a.answer).length > 0 &&
            this.refusalOf(EPOCH_REQUEST, a.answer, floors) === null &&
            (this.slots.lag(ep.name) ?? 0) <= this.s.max_slot_lag / 2;
        const before = ep.health.breaker();
        ep.health.probeResult(good, sentAt);
        if (before !== "closed" && ep.health.breaker() === "closed") {
            this.deps.log.info("rpc endpoint back", { endpoint: ep.name });
        }
    }

    // Null when it got no answer in time
    private async probeEpoch(
        ep: Endpoint,
        timeoutMs: number,
    ): Promise<{ answer: unknown; elapsed: number } | null> {
        ep.probing = true;
        const started = this.deps.now();
        const signal = AbortSignal.any([this.stopper.signal, AbortSignal.timeout(timeoutMs)]);
        const sent = this.checkTransport(ep)({ payload: EPOCH_PAYLOAD, signal });
        this.track(sent);
        try {
            const answer = await sent;
            return { answer, elapsed: this.deps.now() - started };
        } catch {
            return null;
        } finally {
            ep.probing = false;
        }
    }

    // A check or probe call is counted and observed like traffic, but it never strikes, never
    // fails over and logs nothing: its result is the check's
    private checkTransport(ep: Endpoint): RpcTransport {
        return (async ({ payload, signal }: Config) => {
            const req = readRequest(payload) ?? opaqueRequest(payload);
            ep.limits.record(req.method, "background");
            ep.counters.count("background");
            ep.health.begin();
            const started = this.deps.now();
            try {
                const answer = await ep.transport({ payload, signal });
                ep.health.sample(this.deps.now() - started);
                // Any answer, not only a result, says the endpoint is not rate limiting
                ep.limits.succeeded(req.method);
                this.observe(ep, req, answer);
                const error = rpcErrorOf(answer);
                ep.counters.outcome(req.method, error === null ? "ok" : codeLabel(error.code));
                return answer;
            } catch (err) {
                if (signal?.aborted) {
                    ep.counters.outcome(req.method, "timeout");
                } else {
                    ep.counters.outcome(req.method, thrownLabel(err));
                    ep.lastError = { at: this.deps.now(), ...thrownError(err) };
                    this.cool(ep, req.method, classifyThrown(err, false, this.deps.now()));
                }
                throw err;
            } finally {
                ep.health.end();
            }
        }) as RpcTransport;
    }

    private historyProbe(): Promise<HistoryProbe | null> {
        const read = this.deps.historyProbe;
        if (read === undefined) return Promise.resolve(null);
        // The mainnet probe is older than any payment, so it still proves a history
        return read().catch((err: unknown) => {
            this.deps.log.warn("rpc history probe not read", { err });
            return null;
        });
    }

    // A row only ever adds a mark or a passed check (spec 8.10)
    private readVerdicts(): Promise<void> {
        this.verdictsRead ??= (async () => {
            const store = this.deps.verdicts;
            if (store === undefined || this.endpoints.every((ep) => ep.fingerprint === null)) {
                return;
            }
            let rows: VerdictRow[];
            try {
                rows = await store.load();
            } catch (err) {
                this.deps.log.warn("rpc verdicts not loaded", { err });
                return;
            }
            for (const ep of this.endpoints) {
                const row = rows.find((r) => r.fingerprint === ep.fingerprint);
                if (row !== undefined) this.book.load(ep.name, row);
            }
        })();
        return this.verdictsRead;
    }

    private saveVerdict(name: string, v: Verdict): void {
        const store = this.deps.verdicts;
        const fingerprint = this.byName.get(name)?.fingerprint ?? null;
        if (store === undefined || fingerprint === null) return;
        const row: VerdictRow = { fingerprint, endpoint: name, ...v };
        this.saving = this.saving
            .then(() => store.save(row))
            .catch((err: unknown) => {
                this.deps.log.warn("rpc verdict not stored", { endpoint: name, err });
            });
    }

    // Spec 3.4: the caller's payload and signal, once, and the answer or error unchanged
    private async single(config: Config, lane: Lane): Promise<unknown> {
        const ep = this.endpoints[0]!;
        const req = readRequest(config.payload);
        const method = (req ?? opaqueRequest(config.payload)).method;
        ep.counters.count(lane);
        const started = this.deps.now();
        let answer: unknown;
        try {
            answer = await ep.transport(config);
        } catch (err) {
            if (config.signal?.aborted) {
                ep.counters.outcome(method, "aborted");
            } else {
                ep.counters.outcome(method, thrownLabel(err));
                ep.lastError = { at: this.deps.now(), ...thrownError(err) };
            }
            throw err;
        }
        ep.health.sample(this.deps.now() - started);
        const error = rpcErrorOf(answer);
        ep.counters.outcome(method, error === null ? "ok" : codeLabel(error.code));
        if (req !== null && req.spec.slot === "context" && req.minContextSlot !== null) {
            const slot = contextSlotOf(answer);
            if (slot !== null && slot < req.minContextSlot) {
                throw new RpcRouterError("stale", ep.name);
            }
        }
        return answer;
    }

    private async attempt(
        ep: Endpoint,
        req: RouterRequest,
        payload: unknown,
        signal: AbortSignal | undefined,
        lane: Lane,
        timeoutMs: number,
    ): Promise<Attempt> {
        ep.limits.record(req.method, lane);
        ep.counters.count(lane);
        ep.health.begin();
        const timer = AbortSignal.timeout(timeoutMs);
        const started = this.deps.now();
        try {
            const answer = await ep.transport({
                payload,
                signal: signal === undefined ? timer : AbortSignal.any([signal, timer]),
            });
            return { kind: "answer", answer, elapsed: this.deps.now() - started };
        } catch (err) {
            const callerAborted = signal?.aborted === true;
            return {
                kind: "thrown",
                err,
                elapsed: this.deps.now() - started,
                callerAborted,
                timedOut: !callerAborted && timer.aborted,
            };
        } finally {
            ep.health.end();
        }
    }

    private settle(
        ep: Endpoint,
        req: RouterRequest,
        a: Attempt,
        run: Run,
        cutMs: number | null,
        timeoutMs: number,
        signal: AbortSignal | undefined,
    ): Step {
        const cut = run.cut;
        run.cut = null;
        if (a.kind === "thrown") {
            if (a.callerAborted) {
                ep.health.callerAborted(a.elapsed);
                ep.counters.outcome(req.method, "aborted");
                return { kind: "throw", err: signal!.reason };
            }
            run.thrown = { err: a.err };
            if (a.timedOut) {
                if (cutMs === null) {
                    this.strike(ep, timeoutMs, {});
                } else {
                    ep.health.sample(cutMs);
                    run.cut = { ep, ms: cutMs };
                }
                this.failed(run, ep, req.method, "timeout", thrownError(a.err));
                return { kind: "next" };
            }
            const o = classifyThrown(a.err, false, this.deps.now());
            const error = thrownError(a.err);
            if (o.kind === "return") {
                ep.counters.outcome(req.method, thrownLabel(a.err));
                return { kind: "throw", err: a.err };
            }
            this.react(ep, req, o, a.elapsed, codeOf(error), run);
            this.failed(run, ep, req.method, thrownLabel(a.err), error);
            return { kind: "next" };
        }

        const { answer } = a;
        const floors = this.floorsOf(req);
        this.observe(ep, req, answer);
        this.remember(ep, req, answer);
        const classified = classifyAnswer(req.method, answer);
        const unfit = classified.kind === "ok" && unfitStatuses(req, answer);
        const o = unfit ? UNFIT : classified;
        const error = rpcErrorOf(answer);
        if (o.kind === "ok") {
            ep.health.succeed(a.elapsed);
            ep.limits.succeeded(req.method);
            if (cut !== null && a.elapsed < cut.ms) this.strike(cut.ep, cut.ms, {});
            for (const bad of run.badRequests) this.strike(bad.ep, bad.ms, { status: 400 });
            run.badRequests = [];
            const refused = this.refusalOf(req, answer, floors);
            if (refused === null) {
                ep.counters.outcome(req.method, "ok");
                return { kind: "answer", answer, ok: true };
            }
            // R2 treats an answer below the request's own pin as -32016
            if (refused === "pin") this.behind(ep, req);
            run.stale = ep.name;
            this.failed(run, ep, req.method, "stale", { err: "RpcRouterError", reason: "stale" });
            return { kind: "next" };
        }
        if (o.kind === "return" || o.kind === "refused" || o.kind === "processed") {
            ep.counters.outcome(req.method, error === null ? "ok" : codeLabel(error.code));
            return { kind: "answer", answer, ok: false };
        }
        if (error !== null) {
            run.errorAnswer = { answer };
            const code = Number.isInteger(error.code) ? { code: error.code } : {};
            this.react(ep, req, o, a.elapsed, code, run);
            this.failed(run, ep, req.method, codeLabel(error.code), {
                err: "SolanaError",
                ...code,
            });
        } else if (unfit || !isObject(answer) || !("result" in answer)) {
            this.react(ep, req, o, a.elapsed, {}, run);
            this.failed(run, ep, req.method, "invalid", { err: "invalid_answer" });
        } else {
            // R2: a context method's result without its slot could skip every slot check
            run.stale = ep.name;
            this.react(ep, req, o, a.elapsed, {}, run);
            this.failed(run, ep, req.method, "no_context", {
                err: "RpcRouterError",
                reason: "stale",
            });
        }
        return { kind: "next" };
    }

    // What a failed attempt does to its endpoint (spec 6.3, 6.4, 7.2)
    private react(
        ep: Endpoint,
        req: RouterRequest,
        o: Outcome,
        elapsed: number,
        code: ErrorCode,
        run: Run,
    ): void {
        switch (o.kind) {
            case "failover":
                if (o.strike) this.strike(ep, elapsed, code);
                this.cool(ep, req.method, o);
                return;
            case "cooldown":
                this.cool(ep, req.method, o);
                return;
            case "auth":
                ep.health.authFailed();
                this.down(ep, "auth", code);
                return;
            case "down":
                ep.health.endpointDown();
                this.down(ep, `http_${o.status}`, code);
                return;
            case "bad_request":
                run.badRequests.push({ ep, ms: elapsed });
                return;
            case "unsupported":
                ep.health.disableMethod(req.method);
                return;
            case "behind":
                this.behind(ep, req);
                return;
            case "unhealthy":
                if (o.slotsBehind !== null) {
                    this.slots.reportLag(ep.name, Number(o.slotsBehind));
                    this.checkLag(ep);
                }
                this.strike(ep, elapsed, code);
                return;
            case "ok":
            case "return":
            case "aborted":
            case "refused":
            case "processed":
                return;
        }
    }

    // A 429, or a 5xx with Retry-After (spec 6.3, 7.2)
    private cool(ep: Endpoint, method: string, o: Outcome): void {
        if (o.kind === "cooldown") {
            const { scope, capped } = ep.limits.hit429(method, o.retryAfterMs);
            // An endpoint-wide cooldown cut by the cap ends in probation, so probes decide
            if (capped && scope === ENDPOINT_SCOPE) {
                ep.health.probationAt(ep.limits.endpointCoolingUntil());
            }
        } else if (o.kind === "failover" && o.retryAfterMs !== null) {
            const { capped } = ep.limits.coolEndpoint(o.retryAfterMs);
            if (capped) ep.health.probationAt(ep.limits.endpointCoolingUntil());
        }
    }

    // Spec 8.6 step 3: a refusal or error returns as it is only while no attempt of this send may
    // have delivered it, because a later one can be caused by that delivery
    private sendStep(req: RouterRequest, a: Attempt, step: Step, run: Run): Step {
        const o =
            a.kind === "thrown"
                ? classifyThrown(a.err, a.callerAborted, this.deps.now())
                : classifyAnswer(req.method, a.answer);
        if (mayHaveDelivered(o)) run.delivered = true;
        if (step.kind === "next" || (step.kind === "answer" && step.ok)) return step;
        // AlreadyProcessed: a node already holds the transaction
        if (o.kind !== "processed" && (o.kind === "aborted" || !run.delivered)) return step;
        return { kind: "throw", err: new RpcRouterError("send_unconfirmed") };
    }

    // Spec 8.6 step 4: detached copies to send_fanout endpoints on other domains, never to one
    // this send already tried
    private copySend(accepted: Endpoint, payload: unknown, run: Run): void {
        const fanout = this.list.sendFanout;
        if (fanout === 0) return;
        // readRequest read this payload as a send, so it holds its params array
        const copy = copyPayload(payload as { params: readonly unknown[] });
        const req = readRequest(copy)!;
        const used = [accepted];
        const now = this.deps.now();
        for (const v of choose(req, this.views(req, "money"), { now, lane: "money" })) {
            if (used.length > fanout) return;
            const ep = this.endpoint(v.name);
            if (
                run.tried.has(ep.name) ||
                v.breaker !== "closed" ||
                used.some((u) => this.sameSource(u, ep))
            ) {
                continue;
            }
            used.push(ep);
            // A detached copy must never become an unhandled rejection
            this.copy(ep, req, copy).catch(() => undefined);
        }
    }

    // A copy's answer is counted and logged by position, and never reaches the caller
    private async copy(ep: Endpoint, req: RouterRequest, payload: unknown): Promise<void> {
        const run = newRun(COPY_FAILED);
        const timeoutMs = this.s.attempt_timeout;
        const a = await this.attempt(ep, req, payload, undefined, "money", timeoutMs);
        const step = this.settle(ep, req, a, run, null, timeoutMs, undefined);
        if (step.kind === "next" || (step.kind === "answer" && step.ok)) return;
        // An answer settle would hand a caller, so it gave no warn
        const outcome =
            step.kind === "throw"
                ? thrownLabel(step.err)
                : codeLabel(rpcErrorOf(step.answer)?.code ?? Number.NaN);
        this.deps.log.warn(run.failure, { endpoint: ep.name, method: req.method, outcome });
    }

    // The getTransaction null path of spec 8.3: one more ask on another domain, a consistent
    // endpoint while one is eligible, and its answer is returned whatever it holds
    private async askAgain(
        first: Endpoint,
        firstAnswer: unknown,
        req: RouterRequest,
        payload: unknown,
        signal: AbortSignal | undefined,
        lane: Lane,
        run: Run,
    ): Promise<unknown> {
        const now = this.deps.now();
        const others = choose(req, this.views(req, lane), { now, lane }).filter(
            (v) => !run.tried.has(v.name) && this.endpoint(v.name).domain !== first.domain,
        );
        const view = others.find((v) => v.consistent) ?? others[0];
        if (view === undefined) return firstAnswer;
        const ep = this.endpoint(view.name);
        run.tried.add(ep.name);
        const timeoutMs = this.s.attempt_timeout;
        const a = await this.attempt(ep, req, payload, signal, lane, timeoutMs);
        const step = this.settle(ep, req, a, run, null, timeoutMs, signal);
        if (signal?.aborted) throw signal.reason;
        return step.kind === "answer" && step.ok ? step.answer : firstAnswer;
    }

    // Spec 8.5. The cursor is looked up under the request's own address only, so a predecessor
    // never comes from another address's listing that ended with the same signature
    private cursorOf(req: RouterRequest, payload: unknown): Cursor | null {
        const { before } = req;
        if (req.method !== "getSignaturesForAddress" || before === null) return null;
        const address = req.params[0];
        const entry =
            typeof address === "string" ? this.cursors.entryOf(address, before) : undefined;
        const id = isObject(payload) ? payload.id : null;
        if (entry === undefined || entry.predecessor === null) {
            // A cursor never seen, or one that ended a first page alone: the status index is all
            // that can be checked, and the caller's own completeness proof carries the rest
            const check = {
                jsonrpc: "2.0",
                id,
                method: "getSignatureStatuses",
                params: [[before], { searchTransactionHistory: true }],
            };
            return {
                producer: entry?.endpoint ?? null,
                check,
                checkRequest: readRequest(check)!,
                proves: hasStatus,
                proven: new Set(),
            };
        }
        const options = isObject(req.params[1]) ? req.params[1] : {};
        const pin = Object.fromEntries(
            ["commitment", "minContextSlot"]
                .filter((key) => Object.hasOwn(options, key))
                .map((key) => [key, options[key]]),
        );
        const check = {
            jsonrpc: "2.0",
            id,
            method: "getSignaturesForAddress",
            params: [address, { ...pin, before: entry.predecessor, limit: 1 }],
        };
        return {
            producer: entry.endpoint,
            check,
            checkRequest: readRequest(check)!,
            proves: (answer) => isOnly(answer, before),
            proven: new Set(),
        };
    }

    // One extra attempt outside max_attempts (spec 7.1); a failed or refused check proves nothing
    private async proveCursor(
        ep: Endpoint,
        cursor: Cursor,
        signal: AbortSignal | undefined,
        lane: Lane,
        checks: Run,
    ): Promise<boolean> {
        const req = cursor.checkRequest;
        const timeoutMs = this.s.attempt_timeout;
        const a = await this.attempt(ep, req, cursor.check, signal, lane, timeoutMs);
        const step = this.settle(ep, req, a, checks, null, timeoutMs, signal);
        if (step.kind === "throw") throw step.err;
        return step.kind === "answer" && step.ok && cursor.proves(step.answer);
    }

    private holdsCursor(ep: Endpoint, cursor: Cursor): boolean {
        return ep.name === cursor.producer || cursor.proven.has(ep.name);
    }

    private rememberPage(ep: Endpoint, req: RouterRequest, answer: unknown): void {
        const address = req.params[0];
        const page = pageOf(answer);
        if (typeof address !== "string" || page === null) return;
        this.cursors.remember(address, page, req.before, ep.name);
    }

    // Spec 8.4: a null counts only once consistent endpoints on absence_quorum domains returned
    // it. A status found by any endpoint decides its entry, an inconsistent one's too
    private async confirmAbsence(
        first: Endpoint,
        firstAnswer: unknown,
        req: RouterRequest,
        payload: unknown,
        signal: AbortSignal | undefined,
        lane: Lane,
        run: Run,
    ): Promise<unknown> {
        let merged = statusesOf(firstAnswer);
        if (merged === null || !hasNull(merged)) return firstAnswer;
        const received = [{ name: first.name, answer: merged }];
        // One vote per domain, and endpoints that reported one node are one domain (spec 8.10)
        const counted: Endpoint[] = [];
        const independent = (ep: Endpoint) => !counted.some((c) => this.sameSource(c, ep));
        if (this.votes(first)) counted.push(first);
        const voter = (v: EndpointView) => v.consistent && independent(this.endpoint(v.name));
        while (counted.length < this.list.absenceQuorum && hasNull(merged)) {
            const ep = await this.nextVoter(req, lane, run, voter, signal);
            if (ep === null) throw this.unconfirmed(counted.length, merged);
            run.tried.add(ep.name);
            const timeoutMs = this.s.attempt_timeout;
            const a = await this.attempt(ep, req, payload, signal, lane, timeoutMs);
            const step = this.settle(ep, req, a, run, null, timeoutMs, signal);
            const answer = step.kind === "answer" && step.ok ? statusesOf(step.answer) : null;
            if (answer === null) continue;
            const both = mergeStatuses(merged, answer);
            if (both === "conflict") {
                const other = received.find((r) => mergeStatuses(r.answer, answer) === "conflict");
                this.deps.log.warn("rpc endpoints disagree on a status", {
                    endpoints: [other?.name ?? first.name, ep.name],
                });
                throw new RpcRouterError("status_conflict");
            }
            merged = both;
            received.push({ name: ep.name, answer });
            if (this.votes(ep) && independent(ep)) counted.push(ep);
        }
        return merged;
    }

    // The caller's abort ends the search: what answered so far is the unconfirmed absence
    private async nextVoter(
        req: RouterRequest,
        lane: Lane,
        run: Run,
        fits: (v: EndpointView) => boolean,
        signal: AbortSignal | undefined,
    ): Promise<Endpoint | null> {
        for (;;) {
            if (signal?.aborted) return null;
            const next = this.pick(req, lane, run, fits);
            if (next.kind === "try") return next.ep;
            if (next.kind === "stop") return null;
            try {
                await this.wait(next.ms, signal);
            } catch (err) {
                if (signal?.aborted) return null;
                throw err;
            }
            run.waited += next.ms;
        }
    }

    private votes(ep: Endpoint): boolean {
        return this.book.state(ep.name) === "yes";
    }

    private sameSource(a: Endpoint, b: Endpoint): boolean {
        return a.domain === b.domain || this.identities.shares(a.name, b.name);
    }

    private unconfirmed(domainsAnswered: number, partial: StatusesAnswer): RpcRouterError {
        this.alarms.absenceUnconfirmed(this.deps.now(), domainsAnswered);
        return new RpcRouterError("absence_unconfirmed", undefined, partial);
    }

    // A request that ends without an answer to return, after the rules of spec 8.5 and 8.6
    private end(run: Run, blocked: boolean): unknown {
        if (run.missed !== null) return run.missed.answer;
        if (run.delivered) throw new RpcRouterError("send_unconfirmed");
        if (blocked) throw new RpcRouterError("no_endpoint");
        // An unproven cursor's page could read as "history ended", so it is never run elsewhere
        if (run.unproven) throw new RpcRouterError("cursor_unverified");
        return this.fail(run);
    }

    // Spec 7.4: the last JSON-RPC error answer, else a refusal for its slot, else the last
    // thrown error
    private fail(run: Run): unknown {
        if (run.errorAnswer !== null) return run.errorAnswer.answer;
        if (run.stale !== null) throw new RpcRouterError("stale", run.stale);
        if (run.thrown !== null) throw run.thrown.err;
        throw new RpcRouterError("no_endpoint");
    }

    private pick(
        req: RouterRequest,
        lane: Lane,
        run: Run,
        fits: (v: EndpointView) => boolean = () => true,
        cursor: Cursor | null = null,
    ): Choice {
        const now = this.deps.now();
        const views = this.views(req, lane, cursor);
        const untried = (list: EndpointView[]) =>
            list.filter((v) => !run.tried.has(v.name) && fits(v));
        const listed = untried(choose(req, views, { now, lane }));
        // The cursor's producer is taken first while it is eligible, ahead of the list order. Next
        // comes an endpoint that proved it, relaxed or not, since its page runs there (spec 8.5)
        const first =
            listed.find((v) => v.name === cursor?.producer && v.breaker === "closed") ??
            listed.find((v) => cursor?.proven.has(v.name)) ??
            listed[0];
        if (first?.breaker === "closed") return { kind: "try", ep: this.endpoint(first.name) };
        // A healthy endpoint that is free within the wait is better than one whose breaker is
        // open or in probation
        let soonest = Infinity;
        views.forEach((v, i) => {
            if (run.tried.has(v.name)) return;
            const ep = this.endpoints[i]!;
            const ms = this.busyFor(ep, this.sends(ep, req, cursor), lane, now);
            if (!(ms > 0 && ms < soonest)) return;
            const freed = views.with(i, { ...v, coolingUntil: 0, room: true });
            if (untried(choose(req, freed, { now, lane }))[0]?.breaker === "closed") soonest = ms;
        });
        if (soonest <= MAX_WAIT_MS - run.waited) return { kind: "wait", ms: soonest };
        if (first !== undefined) return { kind: "try", ep: this.endpoint(first.name) };
        const free = views.map((v) => ({ ...v, coolingUntil: 0, room: true }));
        return { kind: "stop", blocked: untried(choose(req, free, { now, lane })).length > 0 };
    }

    // How long until these methods' cooldowns end and the window has room for all of them
    private busyFor(ep: Endpoint, methods: readonly string[], lane: Lane, now: number): number {
        const cooling = Math.max(0, ...methods.map((m) => ep.limits.coolingUntil(m) - now));
        return Math.max(cooling, ep.limits.msUntilRoom(methods, lane));
    }

    // A cursor check goes out before the page on an endpoint that does not hold the cursor
    private sends(ep: Endpoint, req: RouterRequest, cursor: Cursor | null): string[] {
        return cursor === null || this.holdsCursor(ep, cursor)
            ? [req.method]
            : [cursor.checkRequest.method, req.method];
    }

    private views(req: RouterRequest, lane: Lane, cursor: Cursor | null = null): EndpointView[] {
        return this.endpoints.map((ep) => {
            const sends = this.sends(ep, req, cursor);
            return {
                name: ep.name,
                roles: ep.passed.history ? WITH_HISTORY : WITHOUT_HISTORY,
                checked: ep.passed.genesis,
                consistent: this.book.state(ep.name) === "yes",
                pinnedSignatures: ep.passed.pinnedSignatures,
                breaker: ep.health.breaker(),
                openUntil: ep.health.openUntil(),
                lastProbeGood: ep.health.lastProbeGood(),
                inflight: ep.health.inflight(),
                lagging: this.lagging(ep),
                coolingUntil: Math.max(...sends.map((m) => ep.limits.coolingUntil(m))),
                room: ep.limits.hasRoom(sends, lane),
                rateLimited: ep.limits.rateLimited(),
                backgroundOut: ep.limits.backgroundOut(sends),
                behindPin: ep.behindPin,
                methodsOff: ep.health.methodsOff(),
            };
        });
    }

    private async wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
        const sleep = this.deps.sleep ?? sleepFor;
        try {
            await sleep(ms, signal);
        } catch (err) {
            if (signal?.aborted) throw signal.reason;
            throw err;
        }
    }

    // Read before the answer is observed, so the answer cannot raise its own floor
    private floorsOf(req: RouterRequest): { slot: bigint | null; height: bigint | null } {
        const lag = this.s.max_slot_lag;
        return {
            slot: this.slots.floor(req.commitment, "slot", lag),
            height: this.slots.floor(req.commitment, "height", lag),
        };
    }

    // "pin" below the request's minContextSlot (R2), "floor" below the freshness floor (R3)
    private refusalOf(
        req: RouterRequest,
        answer: unknown,
        floors: { slot: bigint | null; height: bigint | null },
    ): "pin" | "floor" | null {
        for (const o of observationsOf(req, answer)) {
            if (o.slot !== undefined) {
                const pin = req.spec.slot === "context" ? req.minContextSlot : null;
                if (pin !== null && o.slot < pin) return "pin";
                if (floors.slot !== null && o.slot < floors.slot) return "floor";
            }
            if (o.height !== undefined && floors.height !== null && o.height < floors.height) {
                return "floor";
            }
        }
        return null;
    }

    // Every answer updates the marks, a refused one too, so a lagging endpoint shows as one
    private observe(ep: Endpoint, req: RouterRequest, answer: unknown): void {
        const seen = observationsOf(req, answer);
        for (const o of seen) this.slots.observe(ep.name, o);
        if (seen.length > 0) this.checkLag(ep);
    }

    private lagging(ep: Endpoint): boolean {
        return (this.slots.lag(ep.name) ?? 0) > this.s.max_slot_lag;
    }

    private checkLag(ep: Endpoint): void {
        if (this.lagging(ep)) ep.health.lagged();
    }

    private behind(ep: Endpoint, req: RouterRequest): void {
        if (req.minContextSlot !== null) {
            ep.behindPin = { slot: req.minContextSlot, at: this.deps.now() };
        }
    }

    private strike(ep: Endpoint, ms: number, code: ErrorCode): void {
        const before = ep.health.breaker();
        ep.health.strike(ms);
        if (before === "closed" && ep.health.breaker() === "open") this.down(ep, "errors", code);
    }

    private down(ep: Endpoint, reason: string, code: ErrorCode): void {
        this.deps.log.alarm("rpc_endpoint_down", { endpoint: ep.name, reason, ...code });
    }

    private disagree(name: string, reason: DisagreeReason): void {
        const before = this.book.state(name);
        this.book.disagree(name, reason);
        this.marked(name, before, reason);
    }

    // Spec 8.10: a confirmed or finalized answer is remembered, and a later null or -32011 of a
    // history read for the same signature marks the endpoint, whose null then is no vote
    private remember(ep: Endpoint, req: RouterRequest, answer: unknown): void {
        const signatures = req.signatures;
        if (signatures.length === 0) return;
        const transaction = req.method === "getTransaction";
        if (rpcErrorOf(answer)?.code === NO_HISTORY) {
            if (transaction || req.searchHistory) this.missing(ep, signatures);
            return;
        }
        if (transaction) {
            if (!isObject(answer) || !("result" in answer)) return;
            if (answer.result !== null) this.book.found(ep.name, signatures[0]!);
            // A finalized read of a transaction that is only confirmed so far is null by right
            else if (req.commitment === "confirmed") this.missing(ep, signatures);
            return;
        }
        const statuses = statusesOf(answer);
        if (statuses === null) return;
        const nulls: string[] = [];
        statuses.result.value.forEach((status, i) => {
            const signature = signatures[i];
            if (signature === undefined) return;
            if (status === null) {
                if (req.searchHistory) nulls.push(signature);
            } else if (
                status.confirmationStatus === "confirmed" ||
                status.confirmationStatus === "finalized"
            ) {
                this.book.found(ep.name, signature);
            }
        });
        this.missing(ep, nulls);
    }

    private missing(ep: Endpoint, signatures: readonly string[]): void {
        const before = this.book.state(ep.name);
        for (const signature of signatures) this.book.nullFor(ep.name, signature);
        this.marked(ep.name, before, "found_then_missing");
    }

    // One warn when an endpoint becomes inconsistent, not on every later contradiction
    private marked(name: string, before: Consistency, reason: DisagreeReason): void {
        if (before !== "no" && this.book.state(name) === "no") {
            this.deps.log.warn("rpc endpoint answers inconsistently", { endpoint: name, reason });
        }
    }

    private failed(
        run: Run,
        ep: Endpoint,
        method: string,
        outcome: string,
        error: ErrorSnapshot,
    ): void {
        ep.counters.outcome(method, outcome);
        ep.lastError = { at: this.deps.now(), ...error };
        this.deps.log.warn(run.failure, { endpoint: ep.name, method, outcome });
    }

    // A role is down when no endpoint is eligible for it without relaxing a breaker (spec 6.1)
    private alarmView(now: number): AlarmView {
        const down = new Set(
            ROLES.filter((role) => {
                const req = ROLE_REQUESTS[role];
                const listed = choose(req, this.views(req, "money"), { now, lane: "money" });
                return !listed.some((v) => v.breaker === "closed");
            }),
        );
        return {
            down,
            endpoints: this.endpoints.map((ep) => ({
                name: ep.name,
                state: this.stateOf(ep).state,
                lag: this.slots.lag(ep.name),
                rateLimited: ep.limits.rateLimited(),
            })),
        };
    }

    private serving(now: number): string | null {
        if (this.mode === "single") return this.endpoints[0]!.name;
        const views = this.views(SERVING_REQUEST, "money");
        return choose(SERVING_REQUEST, views, { now, lane: "money" })[0]?.name ?? null;
    }

    private stateOf(ep: Endpoint): Pick<EndpointSnapshot, "state" | "untilMs"> {
        if (ep.checks.genesis === "wrong") return { state: "wrong_network", untilMs: null };
        if (!ep.passed.genesis) return { state: "unchecked", untilMs: null };
        const breaker = ep.health.breaker();
        if (breaker === "open") return { state: "open", untilMs: ep.health.openUntil() };
        if (this.lagging(ep)) return { state: "lagging", untilMs: null };
        if (breaker === "probation") return { state: "probation", untilMs: null };
        const cooling = ep.limits.endpointCoolingUntil();
        if (cooling > 0) return { state: "cooling", untilMs: cooling };
        return { state: "ok", untilMs: null };
    }

    private endpointSnapshot(ep: Endpoint): EndpointSnapshot {
        const month = ep.counters.monthCounts();
        const hour = ep.counters.hourCounts();
        const mark = this.slots.mark(ep.name, "confirmed", "slot");
        return {
            name: ep.name,
            roles: ROLES.filter((r) => r !== "history" || ep.passed.history),
            ...this.stateOf(ep),
            latencyMs: ep.health.latencyMs(),
            errorRate: ep.health.errorRate(),
            inflight: ep.health.inflight(),
            confirmedSlot: mark === null ? null : mark.value.toString(),
            lag: this.slots.lag(ep.name),
            consistent: this.book.state(ep.name),
            limits: ep.limits.limits(),
            monthRequests: month.requests,
            monthBackground: month.background,
            hourRequests: hour.money + hour.background,
            laneRequests: { money: hour.money, background: hour.background },
            outcomes: hour.outcomes,
            checks: { ...ep.checks },
            lastError: ep.lastError === null ? null : { ...ep.lastError },
        };
    }

    private endpoint(name: string): Endpoint {
        const ep = this.byName.get(name);
        if (ep === undefined) throw new Error(`No endpoint ${name}`);
        return ep;
    }
}

export function createRouterTransport(
    settings: RpcSettings,
    urls: readonly string[],
    deps: RouterDeps,
): RouterTransport {
    const read = parseRpcUrls(urls.join(","));
    // The service checked the attempt bound against its own rpc_timeout already
    const problem =
        read.problems[0] ??
        (read.urls.length === urls.length
            ? checkRpcList(settings, Infinity, read.urls)[0]
            : "holds an empty item or a comma inside a URL");
    if (problem !== undefined) throw new Error(`rpc router: ${problem}`);
    const router = new Router(settings, read.urls, deps);
    const background = ((config: Config) => router.request(config, "background")) as RpcTransport;
    const money: RouterTransport = Object.assign(
        ((config: Config) => router.request(config, "money")) as RpcTransport,
        {
            mode: router.mode,
            background,
            start: (o: { timers: boolean }) => router.start(o),
            check: () => router.check(),
            tick: () => router.tick(),
            snapshot: () => router.snapshot(),
            stop: () => router.stop(),
        },
    );
    ROUTERS.set(money, router);
    return money;
}

// The boot checks and the probes write their results through this; tests set them directly
export function setCheckState(
    router: RouterTransport,
    name: string,
    state: Partial<CheckState> & { consistent?: "yes" | "no" },
): void {
    const r = ROUTERS.get(router);
    if (r === undefined) throw new Error("Not a router transport");
    r.setCheckState(name, state);
}
