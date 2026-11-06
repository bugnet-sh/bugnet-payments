import {
    appendTransactionMessageInstruction,
    createTransactionMessage,
    getBase58Decoder,
    getBase58Encoder,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { createFakeRpc, TEST_BLOCKHASH, TEST_LVBH } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { BlockhashCache } from "./blockhash.ts";
import { MEMO_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "./constants.ts";
import { generateExportableKeypair, loadKeypair } from "./keys.ts";
import { createRpc } from "./rpc.ts";

describe("constants", () => {
    it("pins the program addresses", () => {
        expect(USDC_MINT).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        expect(MEMO_PROGRAM).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
        expect(TOKEN_PROGRAM).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    });
    it("builds an rpc without connecting", () => {
        expect(createRpc("https://rpc.invalid")).toBeDefined();
    });
});

describe("loadKeypair", () => {
    it("loads base58 and JSON array keys to the same address", async () => {
        const { signer, secretBase58 } = await generateExportableKeypair();
        const json = JSON.stringify([...getBase58Encoder().encode(secretBase58)]);
        expect((await loadKeypair(secretBase58, "K")).address).toBe(signer.address);
        expect((await loadKeypair(json, "K")).address).toBe(signer.address);
    });
    it("names the variable, not the value, on a bad key", async () => {
        const err = await loadKeypair("abc", "BUGNET_FEE_PAYER_KEY").catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/BUGNET_FEE_PAYER_KEY/);
        expect((err as Error).message).not.toMatch(/abc/);
    });
    it("refuses a 64-byte key whose public half is another key's", async () => {
        const a = await generateExportableKeypair();
        const b = await generateExportableKeypair();
        const mixed = getBase58Decoder().decode(
            new Uint8Array([
                ...getBase58Encoder().encode(a.secretBase58).slice(0, 32),
                ...getBase58Encoder().encode(b.secretBase58).slice(32),
            ]),
        );
        await expect(loadKeypair(mixed, "BUGNET_RECIPIENT_KEY")).rejects.toThrow(
            /BUGNET_RECIPIENT_KEY: public half/,
        );
    });
});

describe("BlockhashCache", () => {
    it("shares one blockhash fetch and refreshes after the TTL", async () => {
        let t = 0;
        const rpc = createFakeRpc();
        const cache = new BlockhashCache(rpc, 8_000, () => t);
        await Promise.all([cache.latest(), cache.latest()]);
        expect(rpc.calls.getLatestBlockhash).toBe(1);
        t = 8_001;
        await cache.latest();
        expect(rpc.calls.getLatestBlockhash).toBe(2);
    });
    it("remembers the last valid block height of hints it served", async () => {
        const cache = new BlockhashCache(createFakeRpc(), 8_000);
        await cache.latest();
        expect(cache.lastValidBlockHeightOf(TEST_BLOCKHASH)).toBe(TEST_LVBH);
        expect(cache.lastValidBlockHeightOf("BH2")).toBeUndefined();
    });
    it("forgets hints older than 300 s", async () => {
        let t = 0;
        const cache = new BlockhashCache(createFakeRpc(), 8_000, () => t);
        await cache.latest();
        t = 300_001;
        expect(cache.lastValidBlockHeightOf(TEST_BLOCKHASH)).toBeUndefined();
    });
});

describe("fake rpc", () => {
    it("sendTransaction returns the wire's own signature", async () => {
        const rpc = createFakeRpc();
        const payer = await testSigner(1);
        const dest = (await testSigner(2)).address;
        const tx = await pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(payer, m),
            (m) =>
                setTransactionMessageLifetimeUsingBlockhash(
                    {
                        blockhash: TEST_BLOCKHASH as never,
                        lastValidBlockHeight: TEST_LVBH,
                    },
                    m,
                ),
            (m) =>
                appendTransactionMessageInstruction(
                    getTransferSolInstruction({ source: payer, destination: dest, amount: 1n }),
                    m,
                ),
            signTransactionMessageWithSigners,
        );
        const wire = getBase64EncodedWireTransaction(tx);
        const sig = await rpc.sendTransaction(wire as never).send();
        expect(sig).toBe(getSignatureFromTransaction(tx));
        expect(rpc.sent[0]).toBe(wire);
    });
});
