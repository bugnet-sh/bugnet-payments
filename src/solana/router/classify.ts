/**
 * What an endpoint's answer or failure means (spec 7.2). HTTP status comes first, because
 * providers reuse JSON-RPC codes. No outcome depends on which provider answered.
 */
import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";
import { methodSpec } from "./methods.ts";
import { bigintOf, contextSlotOf, isObject, rpcErrorOf } from "./payload.ts";

export type Outcome =
    | { kind: "ok" }
    | { kind: "return" }
    | { kind: "aborted" }
    | {
          kind: "failover";
          strike: boolean;
          history: boolean;
          retryAfterMs: number | null;
          // sendTransaction only: the endpoint may have forwarded the transaction
          ambiguous: boolean;
      }
    | { kind: "cooldown"; retryAfterMs: number | null }
    | { kind: "auth" }
    | { kind: "down"; status: number }
    // Fail over; a strike only once another endpoint serves the same request (spec 6.4)
    | { kind: "bad_request" }
    | { kind: "unsupported" }
    | { kind: "behind"; contextSlot: bigint | null }
    | { kind: "unhealthy"; slotsBehind: bigint | null }
    // A preflight refusal of a send
    | { kind: "refused" }
    // AlreadyProcessed on a send: a node already holds the transaction (spec 8.6)
    | { kind: "processed" };

// About the URL, not one method: a spent balance, a refused key, plan or IP, a deleted endpoint
const DOWN_STATUSES: ReadonlySet<number> = new Set([402, 403, 404, 405, 410]);
const REQUEST_STATUSES: ReadonlySet<number> = new Set([413, 414, 431]);
// A node that lacks the history or the slot asked; -32020 also comes from minContextSlot with
// an until cursor on some endpoints, a quirk rather than a sick endpoint, so none is a strike
const HISTORY_CODES: ReadonlySet<number> = new Set([
    -32001, -32004, -32009, -32011, -32014, -32019, -32020,
]);
// Only a connection that never opened surely did not deliver a send
const NEVER_CONNECTED: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function failover(
    strike: boolean,
    ambiguous: boolean,
    more: { history?: boolean; retryAfterMs?: number | null } = {},
): Outcome {
    return {
        kind: "failover",
        strike,
        history: more.history ?? false,
        retryAfterMs: more.retryAfterMs ?? null,
        ambiguous,
    };
}

// The header's own value in ms: the 60 s cap belongs to the learned limits
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
    if (value === null) return null;
    const text = value.trim();
    if (/^\d+$/.test(text)) return Number(text) * 1000;
    // Every HTTP date names its day or month; V8 would read a bare "1.5" as a date in 2001
    if (!/[A-Za-z]/.test(text)) return null;
    const at = Date.parse(text);
    return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

function classifyStatus(status: number, headers: Headers, nowMs: number): Outcome {
    const retryAfterMs = () => parseRetryAfter(headers.get("retry-after"), nowMs);
    if (status === 429) return { kind: "cooldown", retryAfterMs: retryAfterMs() };
    if (status === 401) return { kind: "auth" };
    if (DOWN_STATUSES.has(status)) return { kind: "down", status };
    // Kit reads no body of a non-2xx answer, so a proxy's own code inside a 400 is not visible
    if (status === 400) return { kind: "bad_request" };
    if (REQUEST_STATUSES.has(status)) return { kind: "return" };
    if (status >= 500 && status <= 599)
        return failover(true, true, { retryAfterMs: retryAfterMs() });
    if (status === 408) return failover(true, true);
    if (status >= 400 && status <= 499) return failover(true, false);
    // Fetch follows redirects, so any other status is an answer no row names: assume the worst
    return failover(true, true);
}

function causeCodeOf(err: TypeError): string | null {
    const { cause } = err;
    return isObject(cause) && typeof cause.code === "string" ? cause.code : null;
}

export function classifyThrown(err: unknown, callerAborted: boolean, nowMs: number): Outcome {
    if (callerAborted) return { kind: "aborted" };
    if (isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
        return classifyStatus(err.context.statusCode, err.context.headers, nowMs);
    }
    if (err instanceof TypeError) {
        const code = causeCodeOf(err);
        return failover(true, code === null || !NEVER_CONNECTED.has(code));
    }
    // A 200 that is not JSON, an attempt timeout, or anything else the endpoint's transport threw
    return failover(true, true);
}

function classifyPreflight(data: unknown): Outcome {
    const err = isObject(data) ? data.err : undefined;
    // A node answered, so a retry inside that URL may already have forwarded it (spec 8.9)
    if (err === "BlockhashNotFound") return failover(false, true);
    if (err === "AlreadyProcessed") return { kind: "processed" };
    return { kind: "refused" };
}

function classifyCode(send: boolean, code: number, data: unknown): Outcome {
    const field = (name: string) => (isObject(data) ? bigintOf(data[name]) : null);
    if (code === 429) return { kind: "cooldown", retryAfterMs: null };
    if (code === -32005) return { kind: "unhealthy", slotsBehind: field("numSlotsBehind") };
    if (code === -32016) return { kind: "behind", contextSlot: field("contextSlot") };
    if (HISTORY_CODES.has(code)) return failover(false, false, { history: true });
    if (code === -32603) return failover(true, true);
    if (code === -32601) return { kind: "unsupported" };
    if (code === -32002) return send ? classifyPreflight(data) : { kind: "return" };
    // Agave's codes are all negative, so a positive one comes from a proxy in front of the node
    if (code > 0) return failover(true, true);
    return { kind: "return" };
}

// A context method's result without context.slot fails over with a strike; only the routed
// mode acts on it
export function classifyAnswer(method: string, answer: unknown): Outcome {
    const spec = methodSpec(method);
    const error = rpcErrorOf(answer);
    if (error !== null) return classifyCode(spec.kind === "send", error.code, error.data);
    // Kit would hand the caller an undefined result, so it is treated as a 200 that is not JSON
    if (!isObject(answer) || !("result" in answer)) return failover(true, true);
    if (spec.slot === "context" && contextSlotOf(answer) === null) return failover(true, false);
    return { kind: "ok" };
}

// Spec 7.2's last column, for sendTransaction: whether the endpoint may have forwarded it
export function mayHaveDelivered(o: Outcome): boolean {
    switch (o.kind) {
        case "ok":
        case "aborted":
        case "processed":
        case "cooldown":
        case "behind":
        case "unhealthy":
            return true;
        case "failover":
            return o.ambiguous;
        case "return":
        case "auth":
        case "down":
        case "bad_request":
        case "unsupported":
        case "refused":
            return false;
    }
}
