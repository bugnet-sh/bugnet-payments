import { signature as toSignature } from "@solana/kit";
import type { Settings } from "../config.ts";
import type { Queryable } from "../db/pool.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";
import { readTail } from "./tail.ts";

export type ResignProof = "absent" | "landed" | "wait";

// 7.10: a payment may be signed again only when none of its signatures can still land.
// (a) our mirror has read every slot that could hold one past the height the payment expired at;
// (b) a node that has seen that height has no successful record of any of them.
// A signature stored with meta.err needs neither: a failed transaction can never succeed.
export async function resignProof(
    db: Queryable,
    rpc: SolanaRpc,
    row: { signatures: readonly string[]; expirySeenSlot: bigint | null },
    x402: Settings["x402"],
    rpcTimeoutMs: number,
): Promise<ResignProof> {
    const stored = await db.query<{ signature: string; failed: boolean }>(
        "select signature, failed from x402_chain_txs where signature = any($1::text[])",
        [row.signatures],
    );
    if (stored.rows.some((r) => !r.failed)) return "landed";
    const failed = new Set(stored.rows.map((r) => r.signature));
    const remaining = row.signatures.filter((s) => !failed.has(s));
    if (remaining.length === 0) return "absent";

    if (row.expirySeenSlot === null) return "wait";
    const { verifiedSlot } = await readTail(db);
    if (verifiedSlot < row.expirySeenSlot + BigInt(x402.mirror_rescan_slots)) return "wait";

    try {
        const { context, value } = await rpc
            .getSignatureStatuses(remaining.map(toSignature), { searchTransactionHistory: true })
            .send(deadline(rpcTimeoutMs));
        if (context.slot < row.expirySeenSlot) return "wait";
        if (value.length !== remaining.length) return "wait";
        const unproven = remaining.some((_, i) => {
            const status = value[i] ?? null;
            return status !== null && status.err === null;
        });
        return unproven ? "wait" : "absent";
    } catch {
        return "wait";
    }
}
