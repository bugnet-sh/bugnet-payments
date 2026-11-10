import {
    createSolanaRpc,
    isSolanaError,
    mainnet,
    type RpcMainnet,
    type SolanaRpcApiMainnet,
} from "@solana/kit";

export type SolanaRpc = RpcMainnet<SolanaRpcApiMainnet>;

export function createRpc(url: string): SolanaRpc {
    return createSolanaRpc(mainnet(url));
}

// A fresh signal per call, so a stalled RPC fails like an unavailable one
export function deadline(timeoutMs: number): { abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(timeoutMs) };
}

// Only the numeric code and HTTP status: an error's message or cause can carry the RPC URL's key
export function rpcErrorFields(err: unknown): { err: string; code?: number; status?: number } {
    if (!isSolanaError(err)) return { err: err instanceof Error ? err.name : "error" };
    const status = (err.context as { statusCode?: unknown }).statusCode;
    return {
        err: err.name,
        code: err.context.__code,
        ...(typeof status === "number" ? { status } : {}),
    };
}
