import { signature } from "@solana/kit";
import { RpcRouterError } from "./router/errors.ts";
import { deadline, type SolanaRpc } from "./rpc.ts";

export type Landing = "landed" | "onchain_failed" | "processed" | "not_found" | "blockhash_expired";

export type LandingRead =
    | { landing: "landed"; signature: string; slot: bigint }
    | { landing: "onchain_failed"; slot: bigint }
    // slot: the status answer's context slot, from a node that has seen the expiry
    | { landing: "blockhash_expired"; slot: bigint }
    | { landing: "processed" | "not_found" };

type Status = {
    confirmationStatus: string | null;
    err: unknown;
    slot: bigint;
} | null;

interface Statuses {
    context: { slot: bigint };
    value: readonly Status[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

// The real statuses that answered before the router could prove an absence: their positive
// entries decide as from any answer, their nulls are unproven
function partialOf(err: unknown): Statuses | null {
    if (!(err instanceof RpcRouterError) || err.reason !== "absence_unconfirmed") return null;
    const result = isRecord(err.partial) ? err.partial.result : undefined;
    if (!isRecord(result) || !isRecord(result.context)) return null;
    const { value } = result;
    if (typeof result.context.slot !== "bigint" || !Array.isArray(value)) return null;
    const entries: unknown[] = value;
    if (!entries.every((s) => s === null || (isRecord(s) && typeof s.slot === "bigint"))) {
        return null;
    }
    return { context: { slot: result.context.slot }, value: entries as Status[] };
}

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
 * the signature that landed, with that status's slot; onchain_failed carries the slot of
 * txSignature's status.
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
    let answer: Statuses;
    let unproven: RpcRouterError | null = null;
    try {
        answer = await rpc
            .getSignatureStatuses(signatures.map(signature), { searchTransactionHistory: true })
            .send(deadline(timeoutMs));
    } catch (err) {
        const partial = partialOf(err);
        if (partial === null) throw err;
        answer = partial;
        unproven = err as RpcRouterError;
    }
    const { context, value } = answer;
    const statuses: Status[] = signatures.map((_, i) => value[i] ?? null);
    const landed = statuses.findIndex((s) => settled(s) && s.err === null);
    if (landed !== -1)
        return { landing: "landed", signature: signatures[landed]!, slot: statuses[landed]!.slot };
    const [status = null, ...earlierStatuses] = statuses;
    if (settled(status)) return { landing: "onchain_failed", slot: status.slot };
    if (status !== null || earlierStatuses.some((s) => s !== null && !settled(s))) {
        return { landing: "processed" };
    }
    // An unproven null may only lead to a wait or a resend of the same bytes, never to a re-sign
    if (unproven !== null) {
        if (epoch.blockHeight <= lastValidBlockHeight) return { landing: "not_found" };
        throw unproven;
    }
    const expired = epoch.blockHeight > lastValidBlockHeight && context.slot >= epoch.absoluteSlot;
    return expired
        ? { landing: "blockhash_expired", slot: context.slot }
        : { landing: "not_found" };
}
