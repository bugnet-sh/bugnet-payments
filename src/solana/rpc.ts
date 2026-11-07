import { createSolanaRpc, mainnet, type RpcMainnet, type SolanaRpcApiMainnet } from "@solana/kit";

export type SolanaRpc = RpcMainnet<SolanaRpcApiMainnet>;

export function createRpc(url: string): SolanaRpc {
    return createSolanaRpc(mainnet(url));
}

// A fresh signal per call, so a stalled RPC fails like an unavailable one
export function deadline(timeoutMs: number): { abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(timeoutMs) };
}
