import { signature } from "@solana/kit";
import { deadline, type SolanaRpc } from "./rpc.ts";

export type Landing = "landed" | "onchain_failed" | "processed" | "not_found" | "blockhash_expired";

export type LandingRead =
    { landing: "landed"; signature: string } | { landing: Exclude<Landing, "landed"> };

type Status = {
    confirmationStatus: string | null;
    err: unknown;
} | null;

// A processed-only result can still be dropped with its fork, so it decides nothing
function settled(status: Status): status is NonNullable<Status> {
    return (
        status !== null &&
        (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")
    );
}

/**
 * Behind a load-balanced RPC the two reads can reach different nodes. Height and slot come from
 * one answer, and the status counts as missing only from a node whose bank has reached that
 * finalized slot, so a lagging node never turns a landed transaction into an expired one.
 * `earlier` are signatures of earlier attempts at the same transfer: any of them landing counts
 * as landed, and any of them still processed only keeps the verdict open. A landed verdict names
 * the signature that landed.
 */
export async function readLanding(
    rpc: SolanaRpc,
    txSignature: string,
    lastValidBlockHeight: bigint,
    timeoutMs: number,
    earlier: readonly string[] = [],
): Promise<LandingRead> {
    const epoch = await rpc.getEpochInfo({ commitment: "finalized" }).send(deadline(timeoutMs));
    const signatures = [txSignature, ...earlier];
    const { context, value } = await rpc
        .getSignatureStatuses(signatures.map(signature), { searchTransactionHistory: true })
        .send(deadline(timeoutMs));
    const statuses: Status[] = signatures.map((_, i) => value[i] ?? null);
    const landed = statuses.findIndex((s) => settled(s) && s.err === null);
    if (landed !== -1) return { landing: "landed", signature: signatures[landed]! };
    const [status = null, ...earlierStatuses] = statuses;
    if (settled(status)) return { landing: "onchain_failed" };
    if (status !== null || earlierStatuses.some((s) => s !== null && !settled(s))) {
        return { landing: "processed" };
    }
    const expired = epoch.blockHeight > lastValidBlockHeight && context.slot >= epoch.absoluteSlot;
    return { landing: expired ? "blockhash_expired" : "not_found" };
}
