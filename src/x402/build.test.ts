import {
    type Address,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    type KeyPairSigner,
    type SignatureBytes,
    verifySignature,
} from "@solana/kit";
import { getSetComputeUnitLimitInstructionDataDecoder } from "@solana-program/compute-budget";
import { getSetComputeUnitPriceInstructionDataDecoder } from "@solana-program/compute-budget";
import { getTransferCheckedInstructionDataDecoder } from "@solana-program/token";
import { transactionMessageHash } from "@x402/svm";
import { beforeAll, describe, expect, it } from "vitest";
import { usdcAta } from "../solana/accounts.ts";
import { MEMO_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "../solana/constants.ts";
import { TEST_BLOCKHASH, TEST_LVBH } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import {
    buildSellerPayment,
    randomSellerMemo,
    type SellerPaymentParts,
    signSellerPayment,
} from "./build.ts";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
let allowance: KeyPairSigner;
let sellerFeePayer: Address;
let base: SellerPaymentParts;

beforeAll(async () => {
    allowance = await testSigner(7);
    sellerFeePayer = (await testSigner(9)).address;
    base = {
        feePayer: sellerFeePayer,
        hotTokenAccount: await usdcAta(allowance.address),
        destination: await usdcAta((await testSigner(8)).address),
        authority: allowance.address,
        amount: 10_000n,
        memo: new TextEncoder().encode("abc"),
        computeUnitLimit: 20_000,
        computeUnitPriceMicroLamports: 1n,
        blockhash: TEST_BLOCKHASH,
        lastValidBlockHeight: TEST_LVBH,
    };
});

function decode(wire: string) {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (msg.version !== 0) throw new Error("expected a v0 message");
    return { tx, msg };
}

describe("buildSellerPayment", () => {
    it("instructions in the facilitator's order", async () => {
        const { msg } = decode(
            (await signSellerPayment(buildSellerPayment(base), allowance)).wireBase64,
        );
        expect(msg.version).toBe(0);
        expect(msg.lifetimeToken).toBe(TEST_BLOCKHASH);
        expect(msg.instructions.map((i) => msg.staticAccounts[i.programAddressIndex])).toEqual([
            COMPUTE_BUDGET,
            COMPUTE_BUDGET,
            TOKEN_PROGRAM,
            MEMO_PROGRAM,
        ]);
        const [limit, price, , memo] = msg.instructions;
        expect(getSetComputeUnitLimitInstructionDataDecoder().decode(limit!.data!).units).toBe(
            20_000,
        );
        expect(
            getSetComputeUnitPriceInstructionDataDecoder().decode(price!.data!).microLamports,
        ).toBe(1n);
        expect(memo!.accountIndices ?? []).toHaveLength(0);
        expect(new TextDecoder().decode(memo!.data!)).toBe("abc");
    });

    it("TransferChecked from the hot ATA to ATA(payTo) with the allowance wallet as authority", async () => {
        const { msg } = decode(
            (await signSellerPayment(buildSellerPayment(base), allowance)).wireBase64,
        );
        const ix = msg.instructions[2]!;
        const [source, mint, destination, authority] = ix.accountIndices!.map(
            (n) => msg.staticAccounts[n],
        );
        expect({ source, mint, destination, authority }).toEqual({
            source: base.hotTokenAccount,
            mint: USDC_MINT,
            destination: base.destination,
            authority: allowance.address,
        });
        const data = getTransferCheckedInstructionDataDecoder().decode(ix.data!);
        expect({ amount: data.amount, decimals: data.decimals }).toEqual({
            amount: 10_000n,
            decimals: 6,
        });
    });

    it("the fee payer is the seller's and its signature slot stays empty", async () => {
        const s = await signSellerPayment(buildSellerPayment(base), allowance);
        const { tx, msg } = decode(s.wireBase64);
        expect(msg.staticAccounts[0]).toBe(sellerFeePayer);
        expect(msg.staticAccounts[1]).toBe(allowance.address);
        expect(msg.header.numSignerAccounts).toBe(2);
        const bytes = Buffer.from(s.wireBase64, "base64");
        expect(bytes[0]).toBe(2);
        expect(bytes.subarray(1, 65).equals(Buffer.alloc(64))).toBe(true);
        expect(bytes.subarray(65, 129).equals(Buffer.from(s.signature))).toBe(true);
        expect(
            await verifySignature(
                allowance.keyPair.publicKey,
                s.signature as SignatureBytes,
                tx.messageBytes,
            ),
        ).toBe(true);
        expect(s.messageHash).toBe(transactionMessageHash(tx));
    });

    it("the same parts sign the same bytes", async () => {
        const a = await signSellerPayment(buildSellerPayment(base), allowance);
        const b = await signSellerPayment(buildSellerPayment({ ...base }), allowance);
        expect(Buffer.from(b.signature).equals(Buffer.from(a.signature))).toBe(true);
        expect(b.wireBase64).toBe(a.wireBase64);
    });

    it("a price one higher gives another message hash", async () => {
        const a = await signSellerPayment(buildSellerPayment(base), allowance);
        const b = await signSellerPayment(
            buildSellerPayment({ ...base, computeUnitPriceMicroLamports: 2n }),
            allowance,
        );
        expect(b.messageHash).not.toBe(a.messageHash);
    });

    it("randomSellerMemo", () => {
        const memo = randomSellerMemo();
        expect(memo).toHaveLength(32);
        expect(new TextDecoder().decode(memo)).toMatch(/^[0-9a-f]{32}$/);
        expect(new TextDecoder().decode(randomSellerMemo())).not.toBe(
            new TextDecoder().decode(memo),
        );
    });
});
