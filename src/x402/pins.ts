import { address } from "@solana/kit";
import { isCanonicalAddress } from "../solana/base58.ts";
import { inspectTokenAccount, usdcAta } from "../solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "../solana/constants.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";
import type { IndexCopy } from "./index-file.ts";
import { serviceIdFor } from "./ids.ts";
import { checkEntry, type SellerRules } from "./seller.ts";
import type { Listed, PinReason, X402ServicePin } from "./types.ts";

export interface PinDeps {
    index: IndexCopy;
    rpc: SolanaRpc;
    rules: SellerRules;
    rpcTimeoutMs: number;
}

export type PinCheck =
    | { ok: true; listed: Listed; paidPath: string | null }
    | { ok: false; pinReason: PinReason }
    // an RPC error at the token-account check: 503, nothing charged
    | { ok: false; unavailable: true; cause: string };

type Decidable = Pick<X402ServicePin, "method" | "host" | "prefix" | "payTo" | "url" | "listed">;

export function decideListed(
    pin: Decidable,
    index: IndexCopy,
): { listed: Listed; paidPath: string | null } {
    const listed = pin.listed === "indexed" && index.lists(pin) ? "indexed" : "unlisted";
    return { listed, paidPath: listed === "unlisted" ? new URL(pin.url).pathname : null };
}

export async function checkPin(pin: X402ServicePin, d: PinDeps): Promise<PinCheck> {
    const refuse = (pinReason: PinReason): PinCheck => ({ ok: false, pinReason });
    if (serviceIdFor(pin.method, pin.host, pin.prefix) !== pin.serviceId) {
        return refuse("service_id_mismatch");
    }
    if (!isCanonicalAddress(pin.payTo) || d.rules.bugnet.has(pin.payTo)) {
        return refuse("payee_refused");
    }
    const { probe } = pin;
    if (pin.pinnedFrom === "probe") {
        if (probe.status !== 402) return refuse("no_402");
        const r = checkEntry(probe.accepted, JSON.stringify(probe.accepted), d.rules);
        if (!r.ok) return refuse(r.code);
        if (r.entry.payTo !== pin.payTo) return refuse("payee_refused");
    } else if (probe.status === 402 || probe.accepted !== null || !d.index.lists(pin)) {
        return refuse("index_mismatch");
    }
    if (pin.listed === "indexed" && !d.index.lists(pin)) return refuse("index_mismatch");
    try {
        const info = await inspectTokenAccount(
            d.rpc,
            await usdcAta(address(pin.payTo)),
            deadline(d.rpcTimeoutMs),
        );
        if (
            info === null ||
            info.programOwner !== TOKEN_PROGRAM ||
            info.mint !== USDC_MINT ||
            info.owner !== pin.payTo ||
            info.state !== "initialized"
        ) {
            return refuse("payee_no_usdc_account");
        }
    } catch (err) {
        // Class name only: an RPC error message can carry the URL and its API key
        return { ok: false, unavailable: true, cause: err instanceof Error ? err.name : "unknown" };
    }
    return { ok: true, ...decideListed(pin, d.index) };
}
