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
import { type RpcSettings, rpcSettingsSchema } from "./settings.ts";

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

export function httpFail(statusCode: number, headers: Record<string, string> = {}): never {
    // Most endpoints answer over HTTP/2, which carries no status text
    throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
        headers: new Headers(headers),
        message: "",
        statusCode,
    });
}

// ECONNRESET may have delivered the request; ECONNREFUSED, ENOTFOUND and EAI_AGAIN never did
export function netFail(code = "ECONNRESET"): never {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
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
