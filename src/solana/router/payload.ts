/**
 * Reads what the router needs from a request after kit's transformers, and from an answer as
 * the transport returns it: integers are bigints on both sides (spec 3.1).
 */
import { isJsonRpcPayload } from "@solana/kit";
import { methodSpec, type MethodSpec } from "./methods.ts";

export type Commitment = "processed" | "confirmed" | "finalized";

export interface RouterRequest {
    readonly method: string;
    readonly spec: MethodSpec;
    readonly params: readonly unknown[];
    readonly commitment: Commitment;
    readonly minContextSlot: bigint | null;
    readonly searchHistory: boolean;
    readonly needsHistory: boolean;
    readonly before: string | null;
    readonly until: string | null;
    // The keys of a getMultipleAccounts call; 0 for every other method
    readonly accounts: number;
    // The signatures a getSignatureStatuses or getTransaction call asks about
    readonly signatures: readonly string[];
}

const COMMITMENTS: readonly string[] = ["processed", "confirmed", "finalized"];

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bigintOf(value: unknown): bigint | null {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    return null;
}

function stringOf(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function commitmentOf(method: string, options: Record<string, unknown>): Commitment {
    // getSignatureStatuses takes no commitment: its context slot is a processed slot
    if (method === "getSignatureStatuses") return "processed";
    const value = options[method === "sendTransaction" ? "preflightCommitment" : "commitment"];
    // Kit removes "finalized", the server default, so a missing commitment means finalized
    return typeof value === "string" && COMMITMENTS.includes(value)
        ? (value as Commitment)
        : "finalized";
}

function signaturesOf(method: string, first: unknown): string[] {
    if (method === "getTransaction") return typeof first === "string" ? [first] : [];
    if (method !== "getSignatureStatuses" || !Array.isArray(first)) return [];
    return first.every((s) => typeof s === "string") ? first : [];
}

// null for anything that is not a JSON-RPC payload with positional params
export function readRequest(payload: unknown): RouterRequest | null {
    if (!isJsonRpcPayload(payload) || !Array.isArray(payload.params)) return null;
    const { method } = payload;
    const params: readonly unknown[] = payload.params;
    const spec = methodSpec(method);
    const at = spec.optionsAt === null ? undefined : params[spec.optionsAt];
    const options = isObject(at) ? at : {};
    const searchHistory = options.searchTransactionHistory === true;
    const needsHistory =
        spec.history === "always" || (spec.history === "when_searching" && searchHistory);
    return {
        method,
        spec,
        params,
        commitment: commitmentOf(method, options),
        minContextSlot: bigintOf(options.minContextSlot),
        searchHistory,
        needsHistory,
        before: stringOf(options.before),
        until: stringOf(options.until),
        accounts:
            method === "getMultipleAccounts" && Array.isArray(params[0]) ? params[0].length : 0,
        signatures: signaturesOf(method, params[0]),
    };
}

export function contextSlotOf(answer: unknown): bigint | null {
    if (!isObject(answer) || "error" in answer) return null;
    const { result } = answer;
    if (!isObject(result) || !isObject(result.context)) return null;
    return bigintOf(result.context.slot);
}

// Kit throws for any answer with an "error" member, so the router reads it the same way. A code
// that is not an integer stays NaN, which no row of spec 7.2 names
export function rpcErrorOf(
    answer: unknown,
): { code: number; message: string; data: unknown } | null {
    if (!isObject(answer) || !("error" in answer)) return null;
    const error = isObject(answer.error) ? answer.error : {};
    const code = bigintOf(error.code);
    return {
        code: code === null ? Number.NaN : Number(code),
        message: stringOf(error.message) ?? "",
        data: error.data,
    };
}
