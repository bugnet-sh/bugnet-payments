/**
 * The merge of real getSignatureStatuses answers (spec 8.4), the only answer the router builds.
 * A status beats null, and the merged context slot is the lowest, so a caller's own slot check
 * stays conservative.
 */
import { bigintOf, type Commitment, isObject } from "./payload.ts";

export type Status = {
    slot: bigint;
    confirmations: bigint | null;
    err: unknown;
    confirmationStatus: Commitment | null;
} | null;

export interface StatusesAnswer {
    jsonrpc: "2.0";
    id: unknown;
    result: { context: { slot: bigint }; value: Status[] };
}

const SETTLED: Readonly<Record<Commitment, number>> = { processed: 1, confirmed: 2, finalized: 3 };

function rank(s: NonNullable<Status>): number {
    return s.confirmationStatus === null ? 0 : (SETTLED[s.confirmationStatus] ?? 0);
}

function failed(s: NonNullable<Status>): boolean {
    return s.err !== null && s.err !== undefined;
}

// null when the answer holds no context slot or no list of entries, so it decides nothing
export function statusesOf(answer: unknown): StatusesAnswer | null {
    if (!isObject(answer) || "error" in answer) return null;
    const { result } = answer;
    if (!isObject(result) || !isObject(result.context) || !Array.isArray(result.value)) {
        return null;
    }
    if (bigintOf(result.context.slot) === null) return null;
    if (!result.value.every((v) => v === null || isObject(v))) return null;
    return answer as unknown as StatusesAnswer;
}

export function hasNull(a: StatusesAnswer): boolean {
    return a.result.value.includes(null);
}

// Only success against failure is a conflict: two failures are both a failed landing
export function mergeStatuses(a: StatusesAnswer, b: StatusesAnswer): StatusesAnswer | "conflict" {
    const left = a.result.value;
    const right = b.result.value;
    if (left.length !== right.length) return "conflict";
    const value: Status[] = [];
    for (let i = 0; i < left.length; i++) {
        const x = left[i] ?? null;
        const y = right[i] ?? null;
        if (x === null || y === null) {
            value.push(x ?? y);
            continue;
        }
        if (failed(x) !== failed(y)) return "conflict";
        value.push(rank(y) > rank(x) ? y : x);
    }
    const lower = bigintOf(b.result.context.slot)! < bigintOf(a.result.context.slot)! ? b : a;
    return { jsonrpc: "2.0", id: a.id, result: { context: lower.result.context, value } };
}
