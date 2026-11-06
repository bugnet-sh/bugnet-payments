import {
    type Address,
    AccountRole,
    address,
    appendTransactionMessageInstructions,
    blockhash,
    compileTransaction,
    compressTransactionMessageUsingAddressLookupTables,
    createNoopSigner,
    createTransactionMessage,
    decompileTransactionMessage,
    getBase64EncodedWireTransaction,
    getCompiledTransactionMessageDecoder,
    getCompiledTransactionMessageEncoder,
    type Instruction,
    type KeyPairSigner,
    partiallySignTransaction,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type Transaction,
    type TransactionVersion,
    type TransactionWithBlockhashLifetime,
} from "@solana/kit";
import {
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    parseSetComputeUnitLimitInstruction,
    parseSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
    getApproveCheckedInstruction,
    getTransferCheckedInstruction,
    getTransferInstruction,
    parseTransferCheckedInstruction,
} from "@solana-program/token";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { decodeTransactionFromPayload, transactionMessageHash } from "@x402/svm";
import { describe, expect, it } from "vitest";
import { usdcAta } from "../solana/accounts.ts";
import { LIGHTHOUSE_PROGRAM, MEMO_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "../solana/constants.ts";
import { TEST_BLOCKHASH, TEST_LVBH } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { signedPayment } from "../testing/payment.ts";
import { buildPaymentTransaction } from "./build.ts";
import { type ChallengeContext, requirementsFor } from "./challenge.ts";
import { decodePayment, parsePaymentHeader } from "./decode.ts";

const RECIPIENT = (await testSigner(1)).address;
const FEE_PAYER = (await testSigner(5)).address;
const ctx: ChallengeContext = {
    publicUrl: "https://pay.bugnet.sh",
    recipient: RECIPIENT,
    feePayer: FEE_PAYER,
    transactionVersions: [0],
};
const order = { id: "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", amountMicros: 10_000 };
const bare = requirementsFor(order, ctx);
const reqWithHints: PaymentRequirements = {
    ...bare,
    extra: {
        ...bare.extra,
        recentBlockhash: TEST_BLOCKHASH,
        lastValidBlockHeight: String(TEST_LVBH),
    },
};
const lifetime = { blockhash: blockhash(TEST_BLOCKHASH), lastValidBlockHeight: TEST_LVBH };
const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function signerInstruction(signer: Address): Instruction {
    return {
        programAddress: LIGHTHOUSE_PROGRAM,
        accounts: [{ address: signer, role: AccountRole.READONLY_SIGNER }],
        data: new Uint8Array([9]),
    };
}

async function builtInstructions(payer: Address): Promise<readonly Instruction[]> {
    const tx = await buildPaymentTransaction(reqWithHints, payer);
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    return decompileTransactionMessage(compiled).instructions;
}

function message(version: TransactionVersion, instructions: readonly Instruction[]) {
    return pipe(
        // Typed as v0 so one helper serves every version, kit builds the version it is given
        createTransactionMessage({ version: version as 0 }),
        (m) => setTransactionMessageFeePayer(FEE_PAYER, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
    );
}

function wirePayload(wire: Uint8Array): PaymentPayload {
    return {
        x402Version: 2,
        accepted: reqWithHints,
        payload: { transaction: Buffer.from(wire).toString("base64") },
    };
}

function payloadOf(tx: Transaction): PaymentPayload {
    return {
        x402Version: 2,
        accepted: reqWithHints,
        payload: { transaction: getBase64EncodedWireTransaction(tx) },
    };
}

async function signedBy(payer: KeyPairSigner, tx: Transaction): Promise<PaymentPayload> {
    return payloadOf(await partiallySignTransaction([payer.keyPair], tx));
}

async function variantPayment(variant: string | { x402Version: number }): Promise<PaymentPayload> {
    const payer = await testSigner(2);
    if (typeof variant !== "string") return signedPayment(reqWithHints, payer, variant);
    const ixs = [...(await builtInstructions(payer.address))];
    switch (variant) {
        case "other-fee-payer": {
            const feePayer = (await testSigner(7)).address;
            return signedPayment(
                { ...reqWithHints, extra: { ...reqWithHints.extra, feePayer } },
                payer,
            );
        }
        case "third-signer": {
            const third = signerInstruction((await testSigner(6)).address);
            return signedPayment(reqWithHints, payer, { extraInstructions: [third] });
        }
        case "unsigned":
            return payloadOf(await buildPaymentTransaction(reqWithHints, payer.address));
        case "legacy-message":
            return signedBy(payer, compileTransaction(message("legacy", ixs)));
        case "v1-message":
            // A v1 message carries its compute budget in the header, not as instructions
            return signedBy(payer, compileTransaction(message(1, ixs.slice(2))));
        case "v2-message": {
            const p = await signedPayment(reqWithHints, payer);
            const wire = Buffer.from((p.payload as { transaction: string }).transaction, "base64");
            // The version prefix follows the signature count and the signatures
            wire[1 + 64 * wire[0]!] = 0x82;
            return wirePayload(wire);
        }
        case "alt": {
            const table = (await testSigner(8)).address;
            const msg = compressTransactionMessageUsingAddressLookupTables(message(0, ixs), {
                [table]: [USDC_MINT],
            });
            return signedBy(payer, compileTransaction(msg));
        }
        case "plain-transfer":
            ixs[2] = getTransferInstruction({
                source: await usdcAta(payer.address),
                destination: await usdcAta(RECIPIENT),
                authority: createNoopSigner(payer.address),
                amount: 10_000n,
            });
            return signedBy(payer, compileTransaction(message(0, ixs)));
        case "approve-checked":
            ixs[2] = getApproveCheckedInstruction({
                source: await usdcAta(payer.address),
                mint: USDC_MINT,
                delegate: RECIPIENT,
                owner: createNoopSigner(payer.address),
                amount: 10_000n,
                decimals: 6,
            });
            return signedBy(payer, compileTransaction(message(0, ixs)));
        case "token-2022":
            ixs[2] = { ...ixs[2]!, programAddress: TOKEN_2022_PROGRAM };
            return signedBy(payer, compileTransaction(message(0, ixs)));
        case "unsigned-authority": {
            const other = (await testSigner(6)).address;
            ixs[2] = getTransferCheckedInstruction({
                source: await usdcAta(other),
                mint: USDC_MINT,
                destination: await usdcAta(RECIPIENT),
                authority: other,
                amount: 10_000n,
                decimals: 6,
            });
            ixs.push(signerInstruction(payer.address));
            return signedBy(payer, compileTransaction(message(0, ixs)));
        }
        case "fee-payer-authority": {
            const tx = await buildPaymentTransaction(reqWithHints, FEE_PAYER, {
                extraInstructions: [signerInstruction(payer.address)],
            });
            return signedBy(payer, tx);
        }
        case "fee-payer-twice": {
            const tx = await buildPaymentTransaction(reqWithHints, payer.address);
            const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
            const staticAccounts = compiled.staticAccounts.map((a) =>
                a === payer.address ? FEE_PAYER : a,
            );
            const bytes = getCompiledTransactionMessageEncoder().encode({
                ...compiled,
                staticAccounts,
            });
            // Two empty signature slots, then the message
            return wirePayload(new Uint8Array([2, ...new Uint8Array(128), ...bytes]));
        }
    }
    throw new Error(`unknown variant ${variant}`);
}

describe("buildPaymentTransaction", () => {
    it("builds budget, transfer and memo on the challenge's fee payer and lifetime", async () => {
        const payer = (await testSigner(2)).address;
        const tx = await buildPaymentTransaction(reqWithHints, payer);
        expect((tx as Transaction & TransactionWithBlockhashLifetime).lifetimeConstraint).toEqual({
            blockhash: TEST_BLOCKHASH,
            lastValidBlockHeight: TEST_LVBH,
        });
        const msg = decompileTransactionMessage(
            getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
        );
        expect(msg.version).toBe(0);
        expect(msg.feePayer.address).toBe(FEE_PAYER);
        const [limit, price, transfer, memo, ...rest] = msg.instructions as Required<Instruction>[];
        expect(rest).toEqual([]);
        expect(limit!.programAddress).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
        expect(parseSetComputeUnitLimitInstruction(limit!).data.units).toBe(20_000);
        expect(price!.programAddress).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
        expect(parseSetComputeUnitPriceInstruction(price!).data.microLamports).toBe(1n);
        expect(transfer!.programAddress).toBe(TOKEN_PROGRAM);
        const parsed = parseTransferCheckedInstruction(transfer!);
        expect(parsed.data).toMatchObject({ amount: 10_000n, decimals: 6 });
        expect(parsed.accounts.source.address).toBe(await usdcAta(payer));
        expect(parsed.accounts.mint.address).toBe(USDC_MINT);
        expect(parsed.accounts.destination.address).toBe(await usdcAta(RECIPIENT));
        expect(parsed.accounts.authority).toEqual({
            address: payer,
            role: AccountRole.READONLY_SIGNER,
        });
        expect(memo!.programAddress).toBe(MEMO_PROGRAM);
        expect(new TextDecoder().decode(memo!.data)).toBe(order.id);
    });

    it("applies the budget, memo and extra instruction options", async () => {
        const payer = (await testSigner(2)).address;
        const tx = await buildPaymentTransaction(reqWithHints, payer, {
            computeUnitLimit: 30_000,
            computeUnitPriceMicroLamports: 5n,
            memo: "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb",
            extraInstructions: [signerInstruction(payer)],
        });
        const ixs = decompileTransactionMessage(
            getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
        ).instructions as Required<Instruction>[];
        expect(parseSetComputeUnitLimitInstruction(ixs[0]!).data.units).toBe(30_000);
        expect(parseSetComputeUnitPriceInstruction(ixs[1]!).data.microLamports).toBe(5n);
        expect(new TextDecoder().decode(ixs[3]!.data)).toBe("ord_bbbbbbbbbbbbbbbbbbbbbbbbbb");
        expect(ixs[4]!.programAddress).toBe(LIGHTHOUSE_PROGRAM);
        expect(ixs).toHaveLength(5);
    });

    it("throws without blockhash hints", async () => {
        const payer = (await testSigner(2)).address;
        await expect(buildPaymentTransaction(bare, payer)).rejects.toThrow(
            "challenge has no blockhash",
        );
        const noHeight = { ...bare, extra: { ...bare.extra, recentBlockhash: TEST_BLOCKHASH } };
        await expect(buildPaymentTransaction(noHeight, payer)).rejects.toThrow(
            "challenge has no blockhash",
        );
    });
});

describe("decodePayment", () => {
    it("decodes payer, source, hash and blockhash", async () => {
        const payer = await testSigner(2);
        const p = await signedPayment(reqWithHints, payer);
        const d = decodePayment(p, { feePayer: FEE_PAYER, transactionVersions: [0] });
        expect(d.payer).toBe(payer.address);
        expect(d.sourceTokenAccount).toBe(await usdcAta(payer.address));
        expect(d.messageHash).toBe(
            transactionMessageHash(
                decodeTransactionFromPayload(p.payload as { transaction: string }),
            ),
        );
        expect(d.blockhash).toBe(TEST_BLOCKHASH);
        expect(d.memoOrderId).toBe("ord_aaaaaaaaaaaaaaaaaaaaaaaaaa");
        expect(d.payload).toBe(p);
    });

    it("accepts trailing Lighthouse instructions that leave the fee payer out", async () => {
        const lighthouse = {
            programAddress: LIGHTHOUSE_PROGRAM,
            accounts: [],
            data: new Uint8Array([9]),
        };
        const p = await signedPayment(reqWithHints, await testSigner(2), {
            extraInstructions: [lighthouse],
        });
        expect(() => decodePayment(p, ctx)).not.toThrow();
    });

    it("leaves memoOrderId undefined when the accepted memo is not an order id", async () => {
        const accepted = { ...reqWithHints, extra: { ...reqWithHints.extra, memo: "hello" } };
        const p = await signedPayment(reqWithHints, await testSigner(2), { accepted });
        expect(decodePayment(p, ctx).memoOrderId).toBeUndefined();
    });

    it.each([
        ["v1 envelope", { x402Version: 1 }, "invalid_x402_version"],
        ["fee payer not first", "other-fee-payer", "invalid_exact_svm_fee_payer_mismatch"],
        ["three signers", "third-signer", "invalid_exact_svm_payload_excessive_signers"],
        ["missing payer signature", "unsigned", "payer_signature_missing"],
        ["version 1 message", "v1-message", "unsupported_transaction_version"],
        ["version 2 message", "v2-message", "unsupported_transaction_version"],
        ["legacy message", "legacy-message", "unsupported_transaction_version"],
        ["lookup table", "alt", "address_lookup_tables_refused"],
        ["plain Transfer", "plain-transfer", "invalid_exact_svm_payload_no_transfer_instruction"],
        ["ApproveChecked", "approve-checked", "invalid_exact_svm_payload_no_transfer_instruction"],
        [
            "Token-2022 TransferChecked",
            "token-2022",
            "invalid_exact_svm_payload_no_transfer_instruction",
        ],
        ["an authority that does not sign", "unsigned-authority", "payer_mismatch"],
        ["fee payer as authority", "fee-payer-authority", "payer_mismatch"],
        ["fee payer in the payer slot", "fee-payer-twice", "payer_mismatch"],
    ])("refuses %s", async (_n, variant, code) => {
        const p = await variantPayment(variant);
        expect(() => decodePayment(p, ctx)).toThrow(
            expect.objectContaining({ reason: "payment_invalid", code }),
        );
    });

    it("never reads a version 1 message as version 0, even when allowed", async () => {
        const p = await variantPayment("v1-message");
        expect(() =>
            decodePayment(p, { feePayer: FEE_PAYER, transactionVersions: [0, 1] }),
        ).toThrow(
            expect.objectContaining({
                reason: "payment_invalid",
                code: "unsupported_transaction_version",
            }),
        );
    });

    it.each([null, "x", { junk: 1 }])("refuses %o as an unknown x402 version", (raw) => {
        expect(() => decodePayment(raw, ctx)).toThrow(
            expect.objectContaining({ reason: "payment_invalid", code: "invalid_x402_version" }),
        );
    });

    it("refuses a payment without accepted terms or transaction string", async () => {
        const p = await signedPayment(reqWithHints, await testSigner(2));
        for (const raw of [
            { ...p, accepted: undefined },
            { ...p, accepted: "terms" },
            { ...p, payload: {} },
            { ...p, payload: { transaction: 5 } },
        ]) {
            expect(() => decodePayment(raw, ctx)).toThrow(
                expect.objectContaining({ reason: "payment_malformed" }),
            );
        }
    });

    it("refuses bytes that do not decode as a transaction as malformed", async () => {
        const p = await signedPayment(reqWithHints, await testSigner(2));
        const wire = (p.payload as { transaction: string }).transaction;
        const truncated = Buffer.from(wire, "base64").subarray(0, 100).toString("base64");
        for (const transaction of [truncated, "not base64!"]) {
            expect(() => decodePayment({ ...p, payload: { transaction } }, ctx)).toThrow(
                expect.objectContaining({ reason: "payment_malformed" }),
            );
        }
    });

    it("refuses a transfer whose source index points past the static accounts", async () => {
        const payer = await testSigner(2);
        const tx = await buildPaymentTransaction(reqWithHints, payer.address);
        const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
        if (compiled.version !== 0) throw new Error("expected a v0 message");
        const instructions = compiled.instructions.map((ix, i) =>
            i === 2 ? { ...ix, accountIndices: [99, ...ix.accountIndices!.slice(1)] } : ix,
        );
        const bytes = getCompiledTransactionMessageEncoder().encode({ ...compiled, instructions });
        const p = await signedBy(payer, {
            ...tx,
            messageBytes: bytes as Transaction["messageBytes"],
        });
        expect(() => decodePayment(p, ctx)).toThrow(
            expect.objectContaining({ reason: "payment_malformed" }),
        );
    });
});

describe("parsePaymentHeader", () => {
    it("parses a payment signature header", async () => {
        const p = await signedPayment(reqWithHints, await testSigner(2));
        expect(parsePaymentHeader(encodePaymentSignatureHeader(p))).toEqual(p);
    });

    it("refuses a header that is not base64 JSON", () => {
        expect(() => parsePaymentHeader("not base64!")).toThrow(
            expect.objectContaining({ reason: "payment_malformed" }),
        );
    });
});
