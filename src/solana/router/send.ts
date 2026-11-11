/**
 * The send and simulation rules of spec 8.6. The router never changes a transaction: a copy
 * carries the caller's own wire and config.
 */
import { isObject } from "./payload.ts";

// A copy goes out only after another endpoint accepted the transaction, so its own preflight
// could only refuse it as already processed, and without preflight its commitment means nothing
export function copyPayload(payload: { params: readonly unknown[] }): unknown {
    const [wire, options] = payload.params;
    const config = Object.fromEntries(
        Object.entries(isObject(options) ? options : {}).filter(
            ([key]) => key !== "preflightCommitment",
        ),
    );
    return { ...payload, params: [wire, { ...config, skipPreflight: true }] };
}

// A node that has not seen the payer's fresh blockhash yet would refuse a valid payment
export function isMissingBlockhashSimulation(answer: unknown): boolean {
    if (!isObject(answer) || "error" in answer || !isObject(answer.result)) return false;
    const { value } = answer.result;
    return isObject(value) && value.err === "BlockhashNotFound";
}
