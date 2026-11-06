import {
    type Address,
    address,
    appendTransactionMessageInstructions,
    blockhash,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    type Instruction,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type Transaction,
} from "@solana/kit";
import {
    getSetComputeUnitLimitInstruction,
    getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getTransferCheckedInstruction } from "@solana-program/token";
import type { PaymentRequirements } from "@x402/core/types";
import { usdcAta } from "../solana/accounts.ts";
import { MEMO_PROGRAM, USDC_DECIMALS, USDC_MINT } from "../solana/constants.ts";

export interface BuildOptions {
    computeUnitLimit?: number;
    computeUnitPriceMicroLamports?: bigint;
    memo?: string;
    extraInstructions?: readonly Instruction[];
}

export async function buildPaymentTransaction(
    req: PaymentRequirements,
    payer: Address,
    opts: BuildOptions = {},
): Promise<Transaction> {
    const { feePayer, memo, recentBlockhash, lastValidBlockHeight } = req.extra;
    if (typeof recentBlockhash !== "string" || typeof lastValidBlockHeight !== "string") {
        throw new Error("challenge has no blockhash");
    }
    const transfer = getTransferCheckedInstruction({
        source: await usdcAta(payer),
        mint: USDC_MINT,
        destination: await usdcAta(address(req.payTo)),
        // A bare address would compile as a non-signer, the noop signer only marks the role
        authority: createNoopSigner(payer),
        amount: BigInt(req.amount),
        decimals: USDC_DECIMALS,
    });
    const memoInstruction: Instruction = {
        programAddress: MEMO_PROGRAM,
        data: new TextEncoder().encode(opts.memo ?? (memo as string)),
    };
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(feePayer as string), m),
        (m) =>
            setTransactionMessageLifetimeUsingBlockhash(
                {
                    blockhash: blockhash(recentBlockhash),
                    lastValidBlockHeight: BigInt(lastValidBlockHeight),
                },
                m,
            ),
        (m) =>
            appendTransactionMessageInstructions(
                [
                    getSetComputeUnitLimitInstruction({ units: opts.computeUnitLimit ?? 20_000 }),
                    getSetComputeUnitPriceInstruction({
                        microLamports: opts.computeUnitPriceMicroLamports ?? 1n,
                    }),
                    transfer,
                    memoInstruction,
                    ...(opts.extraInstructions ?? []),
                ],
                m,
            ),
    );
    return compileTransaction(message);
}
