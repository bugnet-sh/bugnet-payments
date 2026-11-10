import {
    address,
    appendTransactionMessageInstruction,
    createTransactionMessage,
    getBase58Decoder,
    getBase58Encoder,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
    SolanaError,
    signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import {
    createFakeRpc,
    epochAt,
    TEST_BLOCKHASH,
    TEST_LVBH,
    TEST_SLOT,
} from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { BlockhashCache } from "./blockhash.ts";
import { inspectTokenAccount } from "./accounts.ts";
import { MEMO_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "./constants.ts";
import { generateExportableKeypair, loadKeypair } from "./keys.ts";
import { readLanding } from "./landing.ts";
import { createRpc, rpcErrorFields } from "./rpc.ts";

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

describe("rpcErrorFields", () => {
    it("keeps the code and HTTP status of an RPC error, never its message", () => {
        const err = new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
            headers: new Headers(),
            message: "https://mainnet.helius-rpc.com/?api-key=secret",
            statusCode: 429,
        });
        const fields = rpcErrorFields(err);
        expect(fields).toEqual({ err: "SolanaError", code: 8100002, status: 429 });
        expect(JSON.stringify(fields)).not.toContain("secret");
    });
    it("keeps the code of a JSON-RPC server error", () => {
        const err = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, {
            numSlotsBehind: 5,
        });
        expect(rpcErrorFields(err)).toEqual({
            err: "SolanaError",
            code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
        });
    });
    it("names any other error", () => {
        expect(rpcErrorFields(new DOMException("t", "TimeoutError"))).toEqual({
            err: "TimeoutError",
        });
        expect(rpcErrorFields("x")).toEqual({ err: "error" });
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
    const earlier = getBase58Decoder().decode(new Uint8Array(64).fill(8));
    const entry = (confirmationStatus: string, err: unknown = null) => ({
        confirmationStatus,
        err,
        slot: 1n,
        confirmations: 1n,
    });
    const status =
        (confirmationStatus: string, err: unknown = null) =>
        () => ({ value: [entry(confirmationStatus, err)] });
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
        const rpc = createFakeRpc({ getSignatureStatuses, getEpochInfo: () => epochAt(height) });
        expect((await readLanding(rpc, sig, 1_000n, 10_000)).landing).toBe(want);
    });

    it("reads the finalized height and slot in one call, before the signature status", async () => {
        const reads: unknown[][] = [];
        const rpc = createFakeRpc({
            getEpochInfo: (...args: unknown[]) => {
                reads.push(["epoch", ...args]);
                return epochAt(1_000n);
            },
            getSignatureStatuses: (...args: unknown[]) => {
                reads.push(["status", ...args]);
                return missing();
            },
        });
        await readLanding(rpc, sig, 1_000n, 10_000);
        expect(reads).toEqual([
            ["epoch", { commitment: "finalized" }],
            ["status", [sig], { searchTransactionHistory: true }],
        ]);
        expect(rpc.calls.getBlockHeight).toBe(0);
    });

    it.each([
        ["behind the finalized slot", TEST_SLOT - 1n, "not_found"],
        ["at the finalized slot", TEST_SLOT, "blockhash_expired"],
    ])("trusts a missing status only from a node %s", async (_n, slot, want) => {
        const rpc = createFakeRpc({
            getEpochInfo: () => epochAt(1_001n, TEST_SLOT),
            getSignatureStatuses: () => ({ context: { slot }, value: [null] }),
        });
        expect((await readLanding(rpc, sig, 1_000n, 10_000)).landing).toBe(want);
    });

    it.each([
        ["landed", [null, entry("confirmed")], { landing: "landed", signature: earlier, slot: 1n }],
        [
            "finalized after a failed current attempt",
            [entry("confirmed", failed), entry("finalized")],
            { landing: "landed", signature: earlier, slot: 1n },
        ],
        ["processed only", [null, entry("processed")], { landing: "processed" }],
        ["failed", [null, entry("confirmed", failed)], { landing: "blockhash_expired" }],
        ["missing", [null, null], { landing: "blockhash_expired" }],
    ])("counts an earlier attempt that is %s", async (_n, value, want) => {
        const reads: unknown[] = [];
        const rpc = createFakeRpc({
            getEpochInfo: () => epochAt(1_001n),
            getSignatureStatuses: (sigs: unknown) => {
                reads.push(sigs);
                return { value };
            },
        });
        expect(await readLanding(rpc, sig, 1_000n, 10_000, [earlier])).toEqual(want);
        expect(reads).toEqual([[sig, earlier]]);
    });

    it("names the signature that landed, the current one first", async () => {
        const third = getBase58Decoder().decode(new Uint8Array(64).fill(9));
        const read = (value: unknown[]) =>
            readLanding(
                createFakeRpc({
                    getEpochInfo: () => epochAt(1_001n),
                    getSignatureStatuses: () => ({ value }),
                }),
                sig,
                1_000n,
                10_000,
                [earlier, third],
            );
        expect(await read([entry("confirmed"), null, null])).toEqual({
            landing: "landed",
            signature: sig,
            slot: 1n,
        });
        expect(await read([null, entry("processed"), entry("finalized")])).toEqual({
            landing: "landed",
            signature: third,
            slot: 1n,
        });
    });

    it("returns the status slot with landed and onchain_failed", async () => {
        const at = (err: unknown) => () => ({
            value: [{ confirmationStatus: "finalized", err, slot: 555n, confirmations: null }],
        });
        const read = (s: () => unknown) =>
            readLanding(createFakeRpc({ getSignatureStatuses: s }), sig, 1_000n, 10_000);
        expect(await read(at(null))).toEqual({ landing: "landed", signature: sig, slot: 555n });
        expect(await read(at(failed))).toEqual({ landing: "onchain_failed", slot: 555n });
        expect(await read(missing)).toEqual({ landing: "not_found" });
    });

    it("gives the slot of the earlier signature that landed", async () => {
        const rpc = createFakeRpc({
            getEpochInfo: () => epochAt(1_001n),
            getSignatureStatuses: () => ({
                value: [
                    null,
                    { confirmationStatus: "confirmed", err: null, slot: 777n, confirmations: 1n },
                ],
            }),
        });
        expect(await readLanding(rpc, sig, 1_000n, 10_000, [earlier])).toEqual({
            landing: "landed",
            signature: earlier,
            slot: 777n,
        });
    });
});

const ACCOUNT = address("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi");
const parsed = (info: Record<string, unknown>) => () => ({
    context: { slot: 1234n },
    value: {
        owner: TOKEN_PROGRAM,
        data: {
            parsed: {
                info: {
                    mint: USDC_MINT,
                    owner: "O",
                    state: "initialized",
                    tokenAmount: { amount: "5" },
                    ...info,
                },
            },
        },
    },
});

describe("inspectTokenAccount", () => {
    it("returns delegate, close authority and the context slot", async () => {
        const rpc = createFakeRpc({
            getAccountInfo: parsed({ delegate: "D", closeAuthority: "C" }),
        });
        expect(await inspectTokenAccount(rpc, ACCOUNT)).toEqual({
            programOwner: TOKEN_PROGRAM,
            mint: USDC_MINT,
            owner: "O",
            state: "initialized",
            amount: 5n,
            delegate: "D",
            closeAuthority: "C",
            contextSlot: 1234n,
        });
    });

    it("gives null for an absent delegate and close authority", async () => {
        const rpc = createFakeRpc({ getAccountInfo: parsed({}) });
        expect(await inspectTokenAccount(rpc, ACCOUNT)).toMatchObject({
            delegate: null,
            closeAuthority: null,
        });
    });

    it("passes commitment and minContextSlot", async () => {
        const seen: unknown[] = [];
        const rpc = createFakeRpc({
            getAccountInfo: (_a: unknown, cfg: unknown) => (seen.push(cfg), parsed({})()),
        });
        await inspectTokenAccount(rpc, ACCOUNT, { commitment: "finalized", minContextSlot: 99n });
        await inspectTokenAccount(rpc, ACCOUNT);
        expect(seen).toEqual([
            { encoding: "jsonParsed", commitment: "finalized", minContextSlot: 99n },
            { encoding: "jsonParsed", commitment: "confirmed" },
        ]);
    });

    it("reads the default context slot from the fake RPC", async () => {
        const rpc = createFakeRpc({ getAccountInfo: () => ({ value: parsed({})().value }) });
        expect((await inspectTokenAccount(rpc, ACCOUNT))!.contextSlot).toBe(TEST_SLOT);
    });
});
