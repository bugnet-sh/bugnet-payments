import type { Address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { USDC_MINT, TOKEN_PROGRAM } from "./constants.ts";
import type { SolanaRpc } from "./rpc.ts";

export async function usdcAta(owner: Address): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({
        owner,
        mint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM,
    });
    return ata;
}

export interface TokenAccountInfo {
    programOwner: string;
    mint: string;
    owner: string;
    state: "initialized" | "frozen" | "uninitialized";
    amount: bigint;
    delegate: string | null;
    closeAuthority: string | null;
    contextSlot: bigint;
}

interface ParsedTokenAccount {
    owner: string;
    data: {
        parsed?: {
            info?: {
                mint?: string;
                owner?: string;
                delegate?: string;
                closeAuthority?: string;
                state?: string;
                tokenAmount?: { amount?: string };
            };
        };
    };
}

export async function inspectTokenAccount(
    rpc: SolanaRpc,
    account: Address,
    o: {
        commitment?: "confirmed" | "finalized";
        minContextSlot?: bigint;
        abortSignal?: AbortSignal;
    } = {},
): Promise<TokenAccountInfo | null> {
    const { context, value } = await rpc
        .getAccountInfo(account, {
            encoding: "jsonParsed",
            commitment: o.commitment ?? "confirmed",
            ...(o.minContextSlot === undefined ? {} : { minContextSlot: o.minContextSlot }),
        })
        .send({ abortSignal: o.abortSignal });
    if (value === null) return null;
    const acct = value as unknown as ParsedTokenAccount;
    const info = acct.data?.parsed?.info;
    const state = info?.state;
    return {
        programOwner: acct.owner,
        mint: info?.mint ?? "",
        owner: info?.owner ?? "",
        state: state === "initialized" || state === "frozen" ? state : "uninitialized",
        amount: BigInt(info?.tokenAmount?.amount ?? "0"),
        delegate: info?.delegate ?? null,
        closeAuthority: info?.closeAuthority ?? null,
        contextSlot: BigInt(context.slot),
    };
}
