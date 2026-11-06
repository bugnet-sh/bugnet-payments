import { createSolanaRpc, mainnet, type RpcMainnet, type SolanaRpcApiMainnet } from "@solana/kit";

export type SolanaRpc = RpcMainnet<SolanaRpcApiMainnet>;

export function createRpc(url: string): SolanaRpc {
    return createSolanaRpc(mainnet(url));
}
