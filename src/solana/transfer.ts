import {
    type Address,
    appendTransactionMessageInstructions,
    blockhash,
    createTransactionMessage,
    type Instruction,
    type KeyPairSigner,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
} from "@solana/kit";
import {
    getSetComputeUnitLimitInstruction,
    getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { usdcAta } from "./accounts.ts";
import { USDC_DECIMALS, USDC_MINT } from "./constants.ts";

/** USDC moves out of the authority's own associated token account. */
export async function usdcTransferChecked(
    authority: KeyPairSigner,
    destination: Address,
    amount: bigint,
): Promise<Instruction> {
    return getTransferCheckedInstruction({
        source: await usdcAta(authority.address),
        mint: USDC_MINT,
        destination,
        authority,
        amount,
        decimals: USDC_DECIMALS,
    });
}

/** Signs a v0 transaction with a blockhash lifetime and the compute budget set first. */
export async function signV0Transaction(o: {
    feePayer: KeyPairSigner;
    blockhash: string;
    lastValidBlockHeight: bigint;
    computeUnitLimit: number;
    computeUnitPrice: bigint | number;
    instructions: readonly Instruction[];
}) {
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(o.feePayer, m),
        (m) =>
            setTransactionMessageLifetimeUsingBlockhash(
                {
                    blockhash: blockhash(o.blockhash),
                    lastValidBlockHeight: o.lastValidBlockHeight,
                },
                m,
            ),
        (m) =>
            appendTransactionMessageInstructions(
                [
                    getSetComputeUnitLimitInstruction({ units: o.computeUnitLimit }),
                    getSetComputeUnitPriceInstruction({ microLamports: o.computeUnitPrice }),
                    ...o.instructions,
                ],
                m,
            ),
    );
    return signTransactionMessageWithSigners(message);
}
