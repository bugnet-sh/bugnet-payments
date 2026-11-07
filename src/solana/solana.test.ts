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
import { readLanding } from "./landing.ts";
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
    it("refuses a 32-byte value such as a pasted address", async () => {
        await expect(
            loadKeypair("Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw", "BUGNET_FEE_PAYER_KEY"),
        ).rejects.toThrow("BUGNET_FEE_PAYER_KEY: expected 64 bytes, got 32");
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
    it("fails a hung fetch after the timeout and retries on the next call", async () => {
        let hang = true;
        const rpc = createFakeRpc({
            getLatestBlockhash: () =>
                hang
                    ? new Promise(() => {})
                    : { value: { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: TEST_LVBH } },
        });
        const cache = new BlockhashCache(rpc, 8_000, Date.now, 20);
        await expect(Promise.all([cache.latest(), cache.latest()])).rejects.toBeDefined();
        expect(rpc.calls.getLatestBlockhash).toBe(1);
        hang = false;
        await expect(cache.latest()).resolves.toMatchObject({ blockhash: TEST_BLOCKHASH });
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

describe("readLanding", () => {
    const sig = getBase58Decoder().decode(new Uint8Array(64).fill(7));
    const status =
        (confirmationStatus: string, err: unknown = null) =>
        () => ({
            value: [{ confirmationStatus, err, slot: 1n, confirmations: 1n }],
        });
    const missing = () => ({ value: [null] });
    const failed = { InstructionError: [2, { Custom: 1 }] };

    it.each([
        ["finalized", status("finalized"), 1_001n, "landed"],
        ["confirmed", status("confirmed"), 1_000n, "landed"],
        ["a confirmed failure", status("confirmed", failed), 1_000n, "onchain_failed"],
        ["processed only, even past expiry", status("processed", failed), 1_001n, "processed"],
        ["missing while the blockhash is valid", missing, 1_000n, "not_found"],
        ["missing past the last valid height", missing, 1_001n, "blockhash_expired"],
    ])("answers %s", async (_n, getSignatureStatuses, height, want) => {
        const rpc = createFakeRpc({ getSignatureStatuses, getBlockHeight: () => height });
        expect(await readLanding(rpc, sig, 1_000n)).toBe(want);
    });

    it("reads the finalized height before the signature status", async () => {
        const reads: unknown[][] = [];
        const rpc = createFakeRpc({
            getBlockHeight: (...args: unknown[]) => {
                reads.push(["height", ...args]);
                return 1_000n;
            },
            getSignatureStatuses: (...args: unknown[]) => {
                reads.push(["status", ...args]);
                return missing();
            },
        });
        await readLanding(rpc, sig, 1_000n);
        expect(reads).toEqual([
            ["height", { commitment: "finalized" }],
            ["status", [sig], { searchTransactionHistory: true }],
        ]);
    });
});
