/**
 * Fake endpoints for the router's tests. A fake answers what its handler returns, or throws what
 * the real HTTP transport throws: a SolanaError 8100002 for an HTTP status, a TypeError("fetch
 * failed") for a network failure, and the signal's reason when the caller aborts.
 */
import {
    type RpcTransport,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
    SolanaError,
} from "@solana/kit";
import type { Status } from "./absence.ts";
import type { Commitment } from "./payload.ts";
import { endpointName, type RpcSettings, rpcSettingsSchema } from "./settings.ts";
import {
    type RouterDeps,
    type RouterLog,
    type RouterTransport,
    setCheckState,
} from "./transport.ts";

export type FakeHandler = (method: string, params: readonly unknown[], payload: unknown) => unknown;

export interface FakeEndpoint {
    // The test's own name for the fake, for its messages; the router names it by position
    readonly label: string;
    readonly transport: RpcTransport;
    readonly calls: { method: string; params: readonly unknown[]; payload: unknown }[];
    answer(handler: FakeHandler): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

// Like fetch: the abort rejects at once with the signal's reason, whatever the answer is doing
function untilAborted(answer: Promise<unknown>, signal: AbortSignal | undefined): Promise<unknown> {
    if (signal === undefined) return answer;
    return new Promise((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

export function fakeEndpoint(label: string, handler?: FakeHandler): FakeEndpoint {
    let current: FakeHandler =
        handler ??
        ((method) => {
            throw new Error(`Fake ${label} has no answer for ${method}`);
        });
    const calls: FakeEndpoint["calls"] = [];
    const transport = (async ({ payload, signal }) => {
        // fetch sends nothing on a signal that is already aborted
        if (signal?.aborted) throw signal.reason;
        const method =
            isRecord(payload) && typeof payload.method === "string" ? payload.method : "";
        const params: readonly unknown[] =
            isRecord(payload) && Array.isArray(payload.params) ? payload.params : [];
        calls.push({ method, params, payload });
        const answer = (async () => current(method, params, payload))();
        return untilAborted(answer, signal);
    }) as RpcTransport;
    return {
        label,
        transport,
        calls,
        answer(next) {
            current = next;
        },
    };
}

export function rpcOk(result: unknown): unknown {
    return { jsonrpc: "2.0", id: 1n, result };
}

// A JSON answer cannot hold undefined, so a missing data is left out
export function rpcFail(code: number, message: string, data?: unknown): unknown {
    const error =
        data === undefined
            ? { code: BigInt(code), message }
            : { code: BigInt(code), message, data };
    return { jsonrpc: "2.0", id: 1n, error };
}

export function signatureStatus(
    slot: bigint,
    confirmationStatus: Commitment,
    err: unknown = null,
): NonNullable<Status> {
    return { slot, confirmations: null, err, confirmationStatus };
}

export function statusesAnswer(slot: bigint, value: readonly Status[]): unknown {
    return rpcOk({ context: { slot }, value });
}

export function httpFail(statusCode: number, headers: Record<string, string> = {}): never {
    // Most endpoints answer over HTTP/2, which carries no status text
    throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
        headers: new Headers(headers),
        message: "",
        statusCode,
    });
}

// ECONNRESET may have delivered the request; ECONNREFUSED, ENOTFOUND and EAI_AGAIN never did.
// Like undici's, the cause names the host, which no log line or snapshot may carry
export function netFail(code = "ECONNRESET"): never {
    const cause = Object.assign(new Error(`getaddrinfo ${code} a.example`), {
        code,
        hostname: "a.example",
        syscall: "getaddrinfo",
    });
    throw new TypeError("fetch failed", { cause });
}

export function stall(): Promise<never> {
    return new Promise<never>(() => {});
}

// The letters a, b, c, ... replace the first one, so the boundary test sees a whole .example URL
const FIRST_TEST_URL = "https://a.example/";

export function testUrls(n: number): string[] {
    if (!Number.isInteger(n) || n < 0 || n > 26) throw new Error("testUrls gives 0 to 26 URLs");
    return Array.from({ length: n }, (_, i) =>
        FIRST_TEST_URL.replace("a", String.fromCharCode(97 + i)),
    );
}

// Short attempts keep the tests fast; no first-attempt cut unless a test asks for one
export function testRpcSettings(over: Partial<RpcSettings> = {}): RpcSettings {
    return {
        ...rpcSettingsSchema.parse({}),
        attempt_timeout: 200,
        first_attempt_timeouts: {},
        max_attempts: 3,
        ...over,
    };
}

// Every endpoint as if its checks had passed and its repeats agreed, for tests of traffic
export function passAll(router: RouterTransport): void {
    for (const { name } of router.snapshot().endpoints) {
        setCheckState(router, name, {
            genesis: "ok",
            history: "ok",
            pinnedAccounts: "ok",
            pinnedSignatures: "ok",
            consistent: "yes",
        });
    }
}

export interface TestLog extends RouterLog {
    readonly lines: Record<string, unknown>[];
}

export type TestDeps = RouterDeps & {
    urls: string[];
    clock: { ms: number };
    log: TestLog;
};

// The fakes in list order, a clock that only the test and sleep move, and jitter of exactly 1
export function testDeps(
    eps: readonly FakeEndpoint[],
    over: Partial<RouterDeps> & { urls?: string[] } = {},
): TestDeps {
    const { urls = testUrls(eps.length), log: outer, ...rest } = over;
    const clock = { ms: 0 };
    const lines: Record<string, unknown>[] = [];
    const line = (level: string, msg: string, f: Record<string, unknown> = {}): void => {
        lines.push({ level, msg, ...f });
    };
    const log: TestLog = {
        lines,
        info(msg, f) {
            line("info", msg, f);
            outer?.info(msg, f);
        },
        warn(msg, f) {
            line("warn", msg, f);
            outer?.warn(msg, f);
        },
        alarm(name, f) {
            line("alarm", name, { alarm: name, ...f });
            outer?.alarm(name, f);
        },
    };
    const byName = new Map(eps.map((ep, i) => [endpointName(i), ep]));
    return {
        urls,
        clock,
        log,
        now: () => clock.ms,
        random: () => 0.5,
        transportFor: (name) => {
            const ep = byName.get(name);
            if (ep === undefined) throw new Error(`No fake endpoint at ${name}`);
            return ep.transport;
        },
        sleep: async (ms, signal) => {
            if (signal?.aborted) throw signal.reason;
            clock.ms += ms;
        },
        ...rest,
    };
}
