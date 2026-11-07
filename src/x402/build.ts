import {
    type Address,
    address,
    appendTransactionMessageInstructions,
    blockhash,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    getBase64Decoder,
    getBase64EncodedWireTransaction,
    type Instruction,
    type KeyPairSigner,
    partiallySignTransaction,
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

export type HintedRequirements = PaymentRequirements & {
    extra: { recentBlockhash: string; lastValidBlockHeight: string };
};

export function hasBlockhashHints(req: PaymentRequirements): req is HintedRequirements {
    const { recentBlockhash, lastValidBlockHeight } = req.extra;
    return typeof recentBlockhash === "string" && typeof lastValidBlockHeight === "string";
}

export async function buildPaymentTransaction(
    req: PaymentRequirements,
    payer: Address,
    opts: BuildOptions = {},
): Promise<Transaction> {
    if (!hasBlockhashHints(req)) throw new Error("challenge has no blockhash");
    const { feePayer, memo, recentBlockhash, lastValidBlockHeight } = req.extra;
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

export interface SellerPaymentParts {
    feePayer: Address;
    hotTokenAccount: Address;
    destination: Address;
    authority: Address;
    amount: bigint;
    memo: Uint8Array;
    computeUnitLimit: number;
    computeUnitPriceMicroLamports: bigint;
    blockhash: string;
    lastValidBlockHeight: bigint;
}

export function buildSellerPayment(p: SellerPaymentParts): Transaction {
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        // An address, not a signer: the seller's facilitator signs the fee payer slot later
        (m) => setTransactionMessageFeePayer(p.feePayer, m),
        (m) =>
            setTransactionMessageLifetimeUsingBlockhash(
                {
                    blockhash: blockhash(p.blockhash),
                    lastValidBlockHeight: p.lastValidBlockHeight,
                },
                m,
            ),
        (m) =>
            appendTransactionMessageInstructions(
                [
                    getSetComputeUnitLimitInstruction({ units: p.computeUnitLimit }),
                    getSetComputeUnitPriceInstruction({
                        microLamports: p.computeUnitPriceMicroLamports,
                    }),
                    getTransferCheckedInstruction({
                        source: p.hotTokenAccount,
                        mint: USDC_MINT,
                        destination: p.destination,
                        authority: createNoopSigner(p.authority),
                        amount: p.amount,
                        decimals: USDC_DECIMALS,
                    }),
                    { programAddress: MEMO_PROGRAM, data: p.memo },
                ],
                m,
            ),
    );
    return compileTransaction(message);
}

// Same value as transactionMessageHash in @x402/svm, which cannot be imported here: it drags
// the whole x402 client into the browser checkout bundle
async function messageHash(tx: Transaction): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(tx.messageBytes));
    return getBase64Decoder().decode(new Uint8Array(digest));
}

export async function signSellerPayment(
    tx: Transaction,
    allowance: KeyPairSigner,
): Promise<{ wireBase64: string; signature: Uint8Array; messageHash: string }> {
    const signed = await partiallySignTransaction([allowance.keyPair], tx);
    return {
        wireBase64: getBase64EncodedWireTransaction(signed),
        signature: signed.signatures[allowance.address] as Uint8Array,
        messageHash: await messageHash(signed),
    };
}

export function randomSellerMemo(): Uint8Array {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return new TextEncoder().encode(hex);
}
