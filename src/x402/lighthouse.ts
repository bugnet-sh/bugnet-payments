// Phantom adds Lighthouse assertions when it signs, before and after the transfer, and on a public
// site they can name the fee payer. Lighthouse only reads the accounts it asserts on, so after the
// two compute budget instructions they may reference the fee payer; any other instruction is refused
import {
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
} from "@solana/kit";
import { LIGHTHOUSE_PROGRAM } from "../solana/constants.ts";

// The compute unit limit and price, which always come first
const BUDGET_INSTRUCTIONS = 2;

export const FEE_PAYER_IN_ACCOUNTS =
    "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts";

// True when every instruction naming the fee payer is a trailing Lighthouse assertion
export function feePayerOnlyInLighthouse(transaction: unknown, feePayer: string): boolean {
    if (typeof transaction !== "string") return false;
    let message;
    try {
        const { messageBytes } = getTransactionDecoder().decode(
            getBase64Encoder().encode(transaction),
        );
        message = getCompiledTransactionMessageDecoder().decode(messageBytes);
    } catch {
        return false;
    }
    // Payments builds version 0 messages only, so any other shape keeps the refusal
    if (!("instructions" in message)) return false;
    const accounts = message.staticAccounts;
    const feePayerIndex = accounts.indexOf(feePayer as (typeof accounts)[number]);
    if (feePayerIndex === -1) return false;
    let named = false;
    for (const [position, ix] of message.instructions.entries()) {
        const program = accounts[ix.programAddressIndex];
        const names =
            ix.programAddressIndex === feePayerIndex ||
            (ix.accountIndices ?? []).includes(feePayerIndex);
        if (!names) continue;
        if (position < BUDGET_INSTRUCTIONS || program !== LIGHTHOUSE_PROGRAM) return false;
        named = true;
    }
    return named;
}

export interface InstructionView {
    program: string;
    accounts: string[];
    data: string;
}

// What a refused payment carried, for the log: the transaction lacks the fee payer's signature,
// so nobody can broadcast it from the log, and it shows what a wallet added
export function describePayment(raw: unknown): {
    refusedTransaction?: string;
    version?: string;
    instructions?: InstructionView[];
} {
    const payload = (raw as { payload?: { transaction?: unknown } } | null)?.payload;
    const transaction = payload?.transaction;
    if (typeof transaction !== "string") return {};
    // The log hides a field named transaction, so the copy goes under its own name
    const refusedTransaction = transaction;
    try {
        const { messageBytes } = getTransactionDecoder().decode(
            getBase64Encoder().encode(transaction),
        );
        const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
        if (!("instructions" in message)) {
            return { refusedTransaction, version: String(message.version) };
        }
        const accounts = message.staticAccounts;
        return {
            refusedTransaction,
            version: String(message.version),
            instructions: message.instructions.map((ix) => ({
                program: accounts[ix.programAddressIndex] ?? `#${ix.programAddressIndex}`,
                accounts: (ix.accountIndices ?? []).map((i) => accounts[i] ?? `#${i}`),
                data: Buffer.from(ix.data ?? new Uint8Array()).toString("hex"),
            })),
        };
    } catch {
        return { refusedTransaction };
    }
}
