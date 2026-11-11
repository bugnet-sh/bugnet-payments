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
import { classifyAnswer, classifyThrown, type Outcome } from "./classify.ts";
import { type Consistency, ConsistencyBook, type DisagreeReason } from "./consistency.ts";
import { RpcRouterError } from "./errors.ts";
import { EndpointHealth, type Lane, monthOf } from "./health.ts";
import { LearnedLimits } from "./limits.ts";
import { UNKNOWN_METHOD } from "./methods.ts";
import { contextSlotOf, isObject, readRequest, type RouterRequest, rpcErrorOf } from "./payload.ts";
import { choose, type EndpointView } from "./select.ts";
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

// A wait for a cooldown or for room is at most this long in all, inside the caller's signal
export const MAX_WAIT_MS = 1_000;

const HOUR_MS = 3_600_000;
const ENDPOINT_SCOPE = "*";
const ABSENCE_ALARM_EVERY_MS = 600_000;
// Transaction history is not available from this node
const NO_HISTORY = -32011;

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
}

// Calling the router itself is the money lane
export interface RouterTransport extends RpcTransport {
    readonly mode: "single" | "routed";
    readonly background: RpcTransport;
    snapshot(): RouterSnapshot;
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

interface Hour {
    key: number;
    money: number;
    background: number;
    outcomes: Map<string, Map<string, number>>;
}

interface Endpoint {
    readonly name: string;
    // Never logged, stored or shown
    readonly domain: string;
    readonly transport: RpcTransport;
    readonly health: EndpointHealth;
    readonly limits: LearnedLimits;
    checks: CheckState;
    // The pin of its last -32016 or answer below a pin, tried last for pins at or above it
    behindPin: { slot: bigint; at: number } | null;
    lastError: EndpointSnapshot["lastError"];
    month: { key: string; requests: number; background: number };
    hour: Hour;
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
}

// A listing's before cursor (spec 8.5)
interface Cursor {
    // The endpoint whose page ended with the cursor, which needs no check
    readonly producer: string | null;
    // Any other endpoint gets this call first, and runs the page only when proves accepts it
    readonly check: unknown;
    readonly checkRequest: RouterRequest;
    readonly proves: (answer: unknown) => boolean;
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
const PASSED: CheckState = {
    genesis: "ok",
    history: "ok",
    pinnedAccounts: "ok",
    pinnedSignatures: "ok",
};
const WITH_HISTORY: ReadonlySet<Role> = new Set(ROLES);
const WITHOUT_HISTORY: ReadonlySet<Role> = new Set(ROLES.filter((r) => r !== "history"));
const SERVING_REQUEST = readRequest({
    jsonrpc: "2.0",
    id: 0,
    method: "getSlot",
    params: [{ commitment: "confirmed" }],
})!;
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

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

function freshHour(now: number): Hour {
    return {
        key: Math.floor(now / HOUR_MS),
        money: 0,
        background: 0,
        outcomes: new Map(),
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

function hasStatus(answer: unknown): boolean {
    const value = statusesOf(answer)?.result.value;
    return value?.length === 1 && value[0] !== null;
}

function newRun(): Run {
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
    };
}

function pageOf(answer: unknown): { signature: string }[] | null {
    if (!isObject(answer) || !Array.isArray(answer.result)) return null;
    const page: unknown[] = answer.result;
    return page.every((e) => isObject(e) && typeof e.signature === "string")
        ? (page as { signature: string }[])
        : null;
}

class Router {
    readonly mode: "single" | "routed";
    private readonly endpoints: Endpoint[];
    private readonly byName: Map<string, Endpoint>;
    private readonly slots: SlotBook;
    private readonly book: ConsistencyBook;
    private readonly cursors = new CursorBook();
    private readonly list: { domains: number; absenceQuorum: number; sendFanout: number };
    // Unconfirmed absences since the last rpc_absence_unconfirmed alarm
    private absenceAlarm: { at: number | null; count: number } = { at: null, count: 0 };

    constructor(
        private readonly s: RpcSettings,
        urls: readonly string[],
        private readonly deps: RouterDeps,
    ) {
        this.mode = urls.length === 1 ? "single" : "routed";
        this.list = resolveRpcList(s, urls);
        const now = deps.now();
        this.endpoints = urls.map((url, i) => {
            const name = endpointName(i);
            return {
                name,
                domain: domainOf(url),
                transport: deps.transportFor(name, url),
                health: new EndpointHealth(s, deps.now, deps.random),
                limits: new LearnedLimits(s, deps.now, deps.random),
                checks: { ...PASSED },
                behindPin: null,
                lastError: null,
                month: { key: monthOf(now), requests: 0, background: 0 },
                hour: freshHour(now),
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
        // No check runs yet, so every endpoint starts as if its checks had passed
        for (const ep of this.endpoints) this.book.checkRun(ep.name, true, now);
    }

    async request(config: Config, lane: Lane): Promise<unknown> {
        if (this.mode === "single") return this.single(config, lane);
        const { payload, signal } = config;
        const req = readRequest(payload) ?? opaqueRequest(payload);
        // A refusal after a send attempt that may have been delivered must never reach the caller
        // as a clean one (spec 8.6), so a send gets one attempt here
        const maxAttempts = req.spec.retry && req.spec.kind !== "send" ? this.s.max_attempts : 1;
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
                if (next.blocked) throw new RpcRouterError("no_endpoint");
                break;
            }
            const { ep } = next;
            // R6: a page with a cursor runs only where the cursor came from or was proven
            if (cursor !== null && ep.name !== cursor.producer) {
                run.tried.add(ep.name);
                if (!(await this.proveCursor(ep, cursor, signal, lane, checks))) {
                    run.unproven = true;
                    continue;
                }
                // The page needs its own room after the check, here where the proof holds
                await this.roomAfterCheck(ep, req, lane, run, signal);
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
            const step = this.settle(ep, req, a, run, cutMs, timeoutMs, signal);
            if (step.kind === "throw") throw step.err;
            if (step.kind === "answer") {
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
        // An unproven cursor's page could read as "history ended", so it is never run elsewhere
        if (run.unproven) throw new RpcRouterError("cursor_unverified");
        return this.fail(run);
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
            endpoints: this.endpoints.map((ep) => this.endpointSnapshot(ep, now)),
        };
    }

    setCheckState(name: string, state: Partial<CheckState> & { consistent?: "yes" | "no" }): void {
        const ep = this.endpoint(name);
        for (const key of CHECK_KEYS) {
            const value = state[key];
            if (value !== undefined) ep.checks[key] = value;
        }
        if (state.consistent === "no") this.book.disagree(name, "check_disagreed");
        // A yes follows the book's own rule: a "no" clears only an hour after its mark
        else if (state.consistent === "yes") this.book.checkRun(name, true, this.deps.now());
    }

    // Spec 3.4: the caller's payload and signal, once, and the answer or error unchanged
    private async single(config: Config, lane: Lane): Promise<unknown> {
        const ep = this.endpoints[0]!;
        const req = readRequest(config.payload);
        const method = (req ?? opaqueRequest(config.payload)).method;
        this.count(ep, lane);
        const started = this.deps.now();
        let answer: unknown;
        try {
            answer = await ep.transport(config);
        } catch (err) {
            if (config.signal?.aborted) {
                this.outcome(ep, method, "aborted");
            } else {
                this.outcome(ep, method, thrownLabel(err));
                ep.lastError = { at: this.deps.now(), ...thrownError(err) };
            }
            throw err;
        }
        ep.health.sample(this.deps.now() - started);
        const error = rpcErrorOf(answer);
        this.outcome(ep, method, error === null ? "ok" : codeLabel(error.code));
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
        this.count(ep, lane);
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
                this.outcome(ep, req.method, "aborted");
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
                this.failed(ep, req.method, "timeout", thrownError(a.err));
                return { kind: "next" };
            }
            const o = classifyThrown(a.err, false, this.deps.now());
            const error = thrownError(a.err);
            if (o.kind === "return") {
                this.outcome(ep, req.method, thrownLabel(a.err));
                return { kind: "throw", err: a.err };
            }
            this.react(ep, req, o, a.elapsed, codeOf(error), run);
            this.failed(ep, req.method, thrownLabel(a.err), error);
            return { kind: "next" };
        }

        const { answer } = a;
        const floors = this.floorsOf(req);
        this.observe(ep, req, answer);
        this.remember(ep, req, answer);
        const o = classifyAnswer(req.method, answer);
        const error = rpcErrorOf(answer);
        if (o.kind === "ok") {
            ep.health.succeed(a.elapsed);
            ep.limits.succeeded(req.method);
            if (cut !== null && a.elapsed < cut.ms) this.strike(cut.ep, cut.ms, {});
            for (const bad of run.badRequests) this.strike(bad.ep, bad.ms, { status: 400 });
            run.badRequests = [];
            const refused = this.refusalOf(req, answer, floors);
            if (refused === null) {
                this.outcome(ep, req.method, "ok");
                return { kind: "answer", answer, ok: true };
            }
            // R2 treats an answer below the request's own pin as -32016
            if (refused === "pin") this.behind(ep, req);
            run.stale = ep.name;
            this.failed(ep, req.method, "stale", { err: "RpcRouterError", reason: "stale" });
            return { kind: "next" };
        }
        if (o.kind === "return" || o.kind === "refused" || o.kind === "processed") {
            this.outcome(ep, req.method, error === null ? "ok" : codeLabel(error.code));
            return { kind: "answer", answer, ok: false };
        }
        if (error !== null) {
            run.errorAnswer = { answer };
            const code = Number.isInteger(error.code) ? { code: error.code } : {};
            this.react(ep, req, o, a.elapsed, code, run);
            this.failed(ep, req.method, codeLabel(error.code), { err: "SolanaError", ...code });
        } else if (isObject(answer) && "result" in answer) {
            // R2: a context method's result without its slot could skip every slot check
            run.stale = ep.name;
            this.react(ep, req, o, a.elapsed, {}, run);
            this.failed(ep, req.method, "no_context", { err: "RpcRouterError", reason: "stale" });
        } else {
            this.react(ep, req, o, a.elapsed, {}, run);
            this.failed(ep, req.method, "invalid", { err: "invalid_answer" });
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
                if (o.retryAfterMs !== null) {
                    const { capped } = ep.limits.coolEndpoint(o.retryAfterMs);
                    if (capped) ep.health.probationAt(ep.limits.endpointCoolingUntil());
                }
                return;
            case "cooldown": {
                const { scope, capped } = ep.limits.hit429(req.method, o.retryAfterMs);
                // An endpoint-wide cooldown cut by the cap ends in probation, so probes decide
                if (capped && scope === ENDPOINT_SCOPE) {
                    ep.health.probationAt(ep.limits.endpointCoolingUntil());
                }
                return;
            }
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

    // Other requests may have filled the window while the check ran (spec 6.3)
    private async roomAfterCheck(
        ep: Endpoint,
        req: RouterRequest,
        lane: Lane,
        run: Run,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        for (;;) {
            const ms = this.busyFor(ep, [req.method], lane, this.deps.now());
            if (ms === 0) return;
            if (ms > MAX_WAIT_MS - run.waited) throw new RpcRouterError("no_endpoint");
            await this.wait(ms, signal);
            run.waited += ms;
        }
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
        const counted = new Set<string>();
        if (this.votes(first)) counted.add(first.domain);
        const voter = (v: EndpointView) =>
            v.consistent && !counted.has(this.endpoint(v.name).domain);
        while (counted.size < this.list.absenceQuorum && hasNull(merged)) {
            const ep = await this.nextVoter(req, lane, run, voter, signal);
            if (ep === null) throw this.unconfirmed(counted.size, merged);
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
            if (this.votes(ep)) counted.add(ep.domain);
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

    // At most one alarm per 10 min, counting the unconfirmed absences since the last one
    private unconfirmed(domainsAnswered: number, partial: StatusesAnswer): RpcRouterError {
        const now = this.deps.now();
        this.absenceAlarm.count += 1;
        const { at, count } = this.absenceAlarm;
        if (at === null || now - at >= ABSENCE_ALARM_EVERY_MS) {
            this.deps.log.alarm("rpc_absence_unconfirmed", { count, domainsAnswered });
            this.absenceAlarm = { at: now, count: 0 };
        }
        return new RpcRouterError("absence_unconfirmed", undefined, partial);
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
        // The cursor's producer is taken first while it is eligible, ahead of the list order
        const prefer = cursor?.producer ?? null;
        const first = listed.find((v) => v.name === prefer && v.breaker === "closed") ?? listed[0];
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

    // How long until these methods' cooldowns end and the window has room for each of them
    private busyFor(ep: Endpoint, methods: readonly string[], lane: Lane, now: number): number {
        let ms = 0;
        for (const m of methods) {
            const cooling = Math.max(0, ep.limits.coolingUntil(m) - now);
            ms = Math.max(ms, cooling, ep.limits.msUntilRoom(m, lane));
        }
        return ms;
    }

    // A cursor check goes out before the page everywhere but on the cursor's producer
    private sends(ep: Endpoint, req: RouterRequest, cursor: Cursor | null): string[] {
        return cursor === null || ep.name === cursor.producer
            ? [req.method]
            : [cursor.checkRequest.method, req.method];
    }

    private views(req: RouterRequest, lane: Lane, cursor: Cursor | null = null): EndpointView[] {
        return this.endpoints.map((ep) => {
            const sends = this.sends(ep, req, cursor);
            return {
                name: ep.name,
                roles: ep.checks.history === "ok" ? WITH_HISTORY : WITHOUT_HISTORY,
                checked: ep.checks.genesis === "ok",
                consistent: this.book.state(ep.name) === "yes",
                pinnedSignatures: ep.checks.pinnedSignatures === "ok",
                breaker: ep.health.breaker(),
                openUntil: ep.health.openUntil(),
                lastProbeGood: ep.health.lastProbeGood(),
                inflight: ep.health.inflight(),
                lagging: this.lagging(ep),
                coolingUntil: Math.max(...sends.map((m) => ep.limits.coolingUntil(m))),
                room: sends.every((m) => ep.limits.hasRoom(m, lane)),
                rateLimited: ep.limits.rateLimited(),
                backgroundOut: sends.some((m) => ep.limits.backgroundOut(m)),
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

    private failed(ep: Endpoint, method: string, outcome: string, error: ErrorSnapshot): void {
        this.outcome(ep, method, outcome);
        ep.lastError = { at: this.deps.now(), ...error };
        this.deps.log.warn("rpc attempt failed", { endpoint: ep.name, method, outcome });
    }

    // Every real HTTP request counts, per position and lane
    private count(ep: Endpoint, lane: Lane): void {
        const now = this.deps.now();
        const month = monthOf(now);
        if (ep.month.key !== month) ep.month = { key: month, requests: 0, background: 0 };
        ep.month.requests += 1;
        if (lane === "background") ep.month.background += 1;
        this.hourOf(ep, now)[lane] += 1;
    }

    private outcome(ep: Endpoint, method: string, outcome: string): void {
        const { outcomes } = this.hourOf(ep, this.deps.now());
        let counts = outcomes.get(method);
        if (counts === undefined) {
            counts = new Map();
            outcomes.set(method, counts);
        }
        counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }

    private hourOf(ep: Endpoint, now: number): Hour {
        if (ep.hour.key !== Math.floor(now / HOUR_MS)) ep.hour = freshHour(now);
        return ep.hour;
    }

    private serving(now: number): string | null {
        if (this.mode === "single") return this.endpoints[0]!.name;
        const views = this.views(SERVING_REQUEST, "money");
        return choose(SERVING_REQUEST, views, { now, lane: "money" })[0]?.name ?? null;
    }

    private stateOf(ep: Endpoint): Pick<EndpointSnapshot, "state" | "untilMs"> {
        if (ep.checks.genesis === "wrong") return { state: "wrong_network", untilMs: null };
        if (ep.checks.genesis !== "ok") return { state: "unchecked", untilMs: null };
        const breaker = ep.health.breaker();
        if (breaker === "open") return { state: "open", untilMs: ep.health.openUntil() };
        if (this.lagging(ep)) return { state: "lagging", untilMs: null };
        if (breaker === "probation") return { state: "probation", untilMs: null };
        const cooling = ep.limits.endpointCoolingUntil();
        if (cooling > 0) return { state: "cooling", untilMs: cooling };
        return { state: "ok", untilMs: null };
    }

    private endpointSnapshot(ep: Endpoint, now: number): EndpointSnapshot {
        const month = ep.month.key === monthOf(now) ? ep.month : null;
        const hour = this.hourOf(ep, now);
        const mark = this.slots.mark(ep.name, "confirmed", "slot");
        return {
            name: ep.name,
            roles: ROLES.filter((r) => r !== "history" || ep.checks.history === "ok"),
            ...this.stateOf(ep),
            latencyMs: ep.health.latencyMs(),
            errorRate: ep.health.errorRate(),
            inflight: ep.health.inflight(),
            confirmedSlot: mark === null ? null : mark.value.toString(),
            lag: this.slots.lag(ep.name),
            consistent: this.book.state(ep.name),
            limits: ep.limits.limits(),
            monthRequests: month?.requests ?? 0,
            monthBackground: month?.background ?? 0,
            hourRequests: hour.money + hour.background,
            laneRequests: { money: hour.money, background: hour.background },
            outcomes: Object.fromEntries(
                [...hour.outcomes].map(([method, counts]) => [method, Object.fromEntries(counts)]),
            ),
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
        { mode: router.mode, background, snapshot: () => router.snapshot() },
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
