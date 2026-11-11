// Its own module so accounts.ts, which the browser checkout bundles, can use it without rpc.ts
// and the router behind it

// A fresh signal per call, so a stalled RPC fails like an unavailable one
export function deadline(timeoutMs: number): { abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(timeoutMs) };
}
