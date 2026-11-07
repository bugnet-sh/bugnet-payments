import { signature } from "@solana/kit";
import type { SolanaRpc } from "./rpc.ts";

export type Landing = "landed" | "onchain_failed" | "processed" | "not_found" | "blockhash_expired";

// Height before status, so a transaction that lands between the reads is found, never expired
export async function readLanding(
    rpc: SolanaRpc,
    txSignature: string,
    lastValidBlockHeight: bigint,
): Promise<Landing> {
    const height = await rpc.getBlockHeight({ commitment: "finalized" }).send();
    const {
        value: [status],
    } = await rpc
        .getSignatureStatuses([signature(txSignature)], { searchTransactionHistory: true })
        .send();
    if (status) {
        // A processed-only result can still be dropped with its fork, so it decides nothing
        if (
            status.confirmationStatus !== "confirmed" &&
            status.confirmationStatus !== "finalized"
        ) {
            return "processed";
        }
        return status.err === null ? "landed" : "onchain_failed";
    }
    return height > lastValidBlockHeight ? "blockhash_expired" : "not_found";
}
