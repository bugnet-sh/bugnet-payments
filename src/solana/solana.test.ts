import {
    address,
    appendTransactionMessageInstruction,
    createSolanaRpcFromTransport,
    createTransactionMessage,
    getBase58Decoder,
    getBase58Encoder,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    pipe,
    type RpcTransportMainnet,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
    SolanaError,
    signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { describe, expect, it } from "vitest";
import {
    createFakeRpc,
    epochAt,
    TEST_BLOCKHASH,
    TEST_LVBH,
    TEST_SLOT,
} from "../testing/fake-rpc.ts";
import { memoryLog } from "../log.ts";
import { testSigner } from "../testing/keys.ts";
import { BlockhashCache } from "./blockhash.ts";
import { inspectTokenAccount, ownedUsdcAccount } from "./accounts.ts";
import { MEMO_PROGRAM, SOLANA_MAINNET, TOKEN_PROGRAM, USDC_MINT } from "./constants.ts";
import { generateExportableKeypair, loadKeypair } from "./keys.ts";
import { readLanding } from "./landing.ts";
import { createRouterRpc, createRpc, rpcErrorFields, type SolanaRpc } from "./rpc.ts";
import { countingRpc, rpcCounter } from "./budget.ts";
import type { Status } from "./router/absence.ts";
import { RpcRouterError } from "./router/errors.ts";
import {
    type FakeEndpoint,
    type FakeHandler,
    fakeEndpoint,
    netFail,
    passAll,
    rpcOk,
    signatureStatus,
    statusesAnswer,
    testDeps,
    testRpcSettings,
} from "./router/testing.ts";
import { createRouterTransport, type RouterTransport, setCheckState } from "./router/transport.ts";

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
            message: "https://rpc1.example/?api-key=secret",
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
    it("rpcErrorFields names a router error", () => {
        expect(rpcErrorFields(new RpcRouterError("stale"))).toEqual({
            err: "RpcRouterError",
            reason: "stale",
        });
        const partial = { value: [null] };
        expect(rpcErrorFields(new RpcRouterError("absence_unconfirmed", "rpc2", partial))).toEqual({
            err: "RpcRouterError",
            reason: "absence_unconfirmed",
        });
        const refused = Object.assign(new Error("connect https://a.example/?api-key=k1"), {
            code: "ECONNREFUSED",
        });
        const fields = rpcErrorFields(new TypeError("fetch failed", { cause: refused }));
        expect(fields).toEqual({ err: "TypeError", cause: "ECONNREFUSED" });
        expect(JSON.stringify(fields)).not.toContain("a.example");
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

    it("an expired blockhash carries the status answer's context slot", async () => {
        const rpc = createFakeRpc({
            getEpochInfo: () => epochAt(1_001n, TEST_SLOT),
            getSignatureStatuses: () => ({ context: { slot: TEST_SLOT + 7n }, value: [null] }),
        });
        expect(await readLanding(rpc, sig, 1_000n, 10_000)).toEqual({
            landing: "blockhash_expired",
            slot: TEST_SLOT + 7n,
        });
    });

    it.each([
        ["landed", [null, entry("confirmed")], { landing: "landed", signature: earlier, slot: 1n }],
        [
            "finalized after a failed current attempt",
            [entry("confirmed", failed), entry("finalized")],
            { landing: "landed", signature: earlier, slot: 1n },
        ],
        ["processed only", [null, entry("processed")], { landing: "processed" }],
        [
            "failed",
            [null, entry("confirmed", failed)],
            { landing: "blockhash_expired", slot: TEST_SLOT },
        ],
        ["missing", [null, null], { landing: "blockhash_expired", slot: TEST_SLOT }],
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

describe("createRouterRpc", () => {
    function routedRpc() {
        const eps = ["a", "b"].map((label) => fakeEndpoint(label));
        const deps = testDeps(eps);
        const routed = createRouterRpc(testRpcSettings(), deps.urls, deps);
        passAll(routed.router);
        return { routed, eps };
    }
    const slotOnly =
        (slot: bigint): FakeHandler =>
        (method) =>
            method === "getSlot" ? rpcOk(slot) : netFail();

    it("createRouterRpc gives a SolanaRpc", async () => {
        const { routed, eps } = routedRpc();
        eps[0]!.answer(slotOnly(5n));
        eps[1]!.answer(slotOnly(9n));
        expect(await routed.rpc.getSlot().send()).toBe(5n);
        expect(await routed.backgroundRpc.getSlot().send()).toBe(5n);
    });

    it("countingRpc counts logical calls over both lanes", async () => {
        const { routed, eps } = routedRpc();
        eps[0]!.answer(() => netFail());
        eps[1]!.answer(slotOnly(9n));
        const log = memoryLog();
        const counter = rpcCounter({ limitPerHour: 1, log, now: () => 0 });
        await countingRpc(routed.rpc, counter).getSlot().send();
        await countingRpc(routed.backgroundRpc, counter).getSlot().send();
        expect(log.lines.filter((l) => l.alarm === "x402_rpc_budget")).toHaveLength(1);
        const http = routed.router
            .snapshot()
            .endpoints.reduce(
                (sum, e) => sum + e.laneRequests.money + e.laneRequests.background,
                0,
            );
        expect(http).toBe(4);
    });

    it("the settler's x402 map still works", async () => {
        const { routed, eps } = routedRpc();
        const blockhash = getBase58Decoder().decode(new Uint8Array(32).fill(3));
        eps[0]!.answer((method) =>
            method === "getLatestBlockhash"
                ? rpcOk({
                      context: { slot: 5_000n },
                      value: { blockhash, lastValidBlockHeight: 4_000n },
                  })
                : netFail(),
        );
        eps[1]!.answer(() => netFail());
        const signer = toFacilitatorSvmSigner(await testSigner(1), {
            [SOLANA_MAINNET]: routed.rpc,
        });
        const latest = (
            signer as unknown as {
                getLatestBlockhash(network: string): Promise<{ blockhash: string }>;
            }
        ).getLatestBlockhash(SOLANA_MAINNET);
        expect((await latest).blockhash).toBe(blockhash);
        expect(eps[0]!.calls.some((c) => c.method === "getLatestBlockhash")).toBe(true);
    });
});

describe("readLanding over the router", () => {
    const SIG = getBase58Decoder().decode(new Uint8Array(64).fill(7));
    const NEW = SIG;
    const OLD = getBase58Decoder().decode(new Uint8Array(64).fill(8));
    const statuses = (value: Status[], slot = 5_000n) => statusesAnswer(slot, value);

    // Fakes a, b, c at rpc1, rpc2, rpc3, each on its own domain
    function routed(n: number): { rpc: SolanaRpc; router: RouterTransport; eps: FakeEndpoint[] } {
        const eps = ["a", "b", "c"].slice(0, n).map((label) => fakeEndpoint(label));
        const deps = testDeps(eps);
        const router = createRouterTransport(testRpcSettings(), deps.urls, deps);
        passAll(router);
        // The router serves mainnet only: its boot check refuses any other genesis
        const rpc = createSolanaRpcFromTransport(router as unknown as RpcTransportMainnet);
        return { rpc, router, eps };
    }

    function node(epoch: unknown, answer: unknown): FakeHandler {
        return (method) => {
            if (method === "getEpochInfo") return rpcOk(epoch);
            if (method === "getSignatureStatuses") return answer;
            throw new Error(`No answer for ${method}`);
        };
    }

    it("readLanding gives not_found while the blockhash is valid", async () => {
        const { rpc, eps } = routed(2);
        eps[0]!.answer(node(epochAt(900n, 5_000n), statuses([null])));
        eps[1]!.answer(() => netFail());
        expect(await readLanding(rpc, SIG, 1_000n, 10_000)).toEqual({ landing: "not_found" });
    });

    it("readLanding waits on an unproven null past the blockhash", async () => {
        const { rpc, eps } = routed(2);
        eps[0]!.answer(node(epochAt(2_000n, 5_000n), statuses([null])));
        eps[1]!.answer(() => netFail());
        const e = await readLanding(rpc, SIG, 1_000n, 10_000).catch((err: unknown) => err);
        expect(e).toBeInstanceOf(RpcRouterError);
        expect((e as RpcRouterError).reason).toBe("absence_unconfirmed");
    });

    it("readLanding finds a re-signed transaction landed while an endpoint is down", async () => {
        const landed = routed(2);
        const finalized = statuses([signatureStatus(4_990n, "finalized"), null]);
        landed.eps[0]!.answer(node(epochAt(2_000n, 5_000n), finalized));
        landed.eps[1]!.answer(() => netFail());
        expect(await readLanding(landed.rpc, NEW, 1_000n, 10_000, [OLD])).toEqual({
            landing: "landed",
            signature: NEW,
            slot: 4_990n,
        });

        const processed = routed(2);
        const seen = statuses([signatureStatus(4_990n, "processed"), null]);
        processed.eps[0]!.answer(node(epochAt(2_000n, 5_000n), seen));
        processed.eps[1]!.answer(() => netFail());
        expect(await readLanding(processed.rpc, NEW, 1_000n, 10_000, [OLD])).toEqual({
            landing: "processed",
        });
    });

    it("readLanding never decides expiry from an inconsistent endpoint's null", async () => {
        const { rpc, router, eps } = routed(3);
        setCheckState(router, "rpc1", { consistent: "no" });
        eps[0]!.answer(node(epochAt(2_000n, 5_000n), statuses([null])));
        eps[1]!.answer(node(epochAt(2_000n, 5_000n), statuses([null])));
        eps[2]!.answer(() => netFail());
        const e = await readLanding(rpc, SIG, 1_000n, 10_000).catch((err: unknown) => err);
        expect(e).toBeInstanceOf(RpcRouterError);
        expect((e as RpcRouterError).reason).toBe("absence_unconfirmed");
    });

    it("readLanding sees landed through a history-less endpoint", async () => {
        const { rpc, eps } = routed(2);
        eps[0]!.answer(node(epochAt(2_000n, 5_000n), statuses([null])));
        const found = statuses([signatureStatus(4_990n, "finalized")], 5_001n);
        eps[1]!.answer(node(epochAt(2_000n, 5_000n), found));
        expect(await readLanding(rpc, SIG, 1_000n, 10_000)).toEqual({
            landing: "landed",
            signature: SIG,
            slot: 4_990n,
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

describe("ownedUsdcAccount", () => {
    it.each([
        ["an initialized USDC account of the owner", {}, "O", true],
        ["another owner", {}, "P", false],
        ["a frozen account", { state: "frozen" }, "O", false],
        ["another mint", { mint: "So11111111111111111111111111111111111111112" }, "O", false],
    ])("accepts only %s", async (_n, info, owner, want) => {
        const rpc = createFakeRpc({ getAccountInfo: parsed(info) });
        expect(await ownedUsdcAccount(rpc, ACCOUNT, owner, 10_000)).toBe(want);
    });

    it("refuses an account under another program and a missing account", async () => {
        const other = () => ({ ...parsed({})(), value: { ...parsed({})().value, owner: "X" } });
        expect(
            await ownedUsdcAccount(createFakeRpc({ getAccountInfo: other }), ACCOUNT, "O", 1),
        ).toBe(false);
        const missing = createFakeRpc({ getAccountInfo: () => ({ value: null }) });
        expect(await ownedUsdcAccount(missing, ACCOUNT, "O", 10_000)).toBe(false);
    });
});
