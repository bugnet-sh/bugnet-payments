import {
    address,
    appendTransactionMessageInstruction,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    getBase58Decoder,
    getBase64Encoder,
    getTransactionDecoder,
    isSolanaError,
    type KeyPairSigner,
    signature,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from "@solana/kit";
import { getApproveInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usdcAta } from "../solana/accounts.ts";
import { USDC_DECIMALS, USDC_MINT } from "../solana/constants.ts";
import { domainOf, MAINNET_GENESIS, MAINNET_HISTORY_PROBE } from "../solana/router/index.ts";
import { createRpc } from "../solana/rpc.ts";
import { buildSellerPayment, randomSellerMemo, signSellerPayment } from "../x402/build.ts";
import { type FakeChain, startFakeChain } from "./fake-chain.ts";
import { testSigner } from "./keys.ts";

describe("fake chain", () => {
    let chain: FakeChain;
    let owner: KeyPairSigner, payer: KeyPairSigner, other: KeyPairSigner;
    let a: string, b: string;
    beforeEach(async () => {
        chain = await startFakeChain();
        [owner, payer, other] = await Promise.all([testSigner(31), testSigner(32), testSigner(33)]);
        a = await usdcAta(owner.address);
        b = await usdcAta(other.address);
        chain.setTokenAccount({ address: a, owner: owner.address, amount: 1_000_000n });
        chain.setTokenAccount({ address: b, owner: other.address, amount: 0n });
    });
    afterEach(() => chain.close());
    const send = (micros: bigint, extra: Partial<Parameters<FakeChain["transfer"]>[0]> = {}) =>
        chain.transfer({
            authority: owner,
            feePayer: payer,
            source: a,
            destination: b,
            micros,
            ...extra,
        });
    const getTx = (s: string, commitment: "confirmed" | "finalized" = "confirmed") =>
        chain.rpc
            .getTransaction(signature(s), {
                encoding: "base64",
                commitment,
                maxSupportedTransactionVersion: 0,
            })
            .send();

    const transferWire = async (
        micros: bigint,
        lifetime?: { blockhash: string; lastValidBlockHeight: bigint },
    ): Promise<string> => {
        const life = lifetime ?? (await chain.rpc.getLatestBlockhash().send()).value;
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(life as never, m),
            (m) =>
                appendTransactionMessageInstruction(
                    getTransferCheckedInstruction({
                        source: address(a),
                        mint: address(USDC_MINT),
                        destination: address(b),
                        authority: owner,
                        amount: micros,
                        decimals: USDC_DECIMALS,
                    }),
                    m,
                ),
        );
        return getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message));
    };
    const simulate = async (wire: string) =>
        (
            (await chain.rpc.simulateTransaction(wire as never, { encoding: "base64" }).send()) as {
                value: { err: unknown };
            }
        ).value.err;

    it("the fake chain answers getGenesisHash", async () => {
        expect(await chain.rpc.getGenesisHash().send()).toBe(MAINNET_GENESIS);
    });

    it("the fake chain answers getBalance", async () => {
        chain.fundLamports(payer.address, 5n);
        const funded = await chain.rpc.getBalance(payer.address).send();
        expect(funded.value).toBe(5n);
        expect(typeof funded.context.slot).toBe("bigint");
        expect((await chain.rpc.getBalance(other.address).send()).value).toBe(0n);
        expect(chain.lamports(other.address)).toBe(0n);
    });

    it("the fake chain simulates without landing", async () => {
        const fresh = await transferWire(10n);
        expect(await simulate(fresh)).toBeNull();
        expect(chain.submitted()).toHaveLength(0);
        expect(chain.balance(a)).toBe(1_000_000n);
        expect(chain.balance(b)).toBe(0n);

        const life = (await chain.rpc.getLatestBlockhash().send()).value;
        chain.advance(200);
        expect(await simulate(await transferWire(10n, life))).toBe("BlockhashNotFound");
        expect(await simulate(await transferWire(2_000_000n))).toEqual({
            InstructionError: [0n, { Custom: 1n }],
        });
    });

    it("the fake chain knows the mainnet probe", async () => {
        const { value } = await chain.rpc
            .getSignatureStatuses([signature(MAINNET_HISTORY_PROBE.signature)], {
                searchTransactionHistory: true,
            })
            .send();
        expect(value[0]?.confirmationStatus).toBe("finalized");
    });

    it("the fake chain refuses a v0 transaction without the version field", async () => {
        const s = await send(10n);
        await expect(
            chain.rpc.getTransaction(signature(s), { encoding: "base64" }).send(),
        ).rejects.toSatisfy((e: unknown) => isSolanaError(e) && e.context.__code === -32015);
        expect(await getTx(s)).not.toBeNull();
    });

    it("the fake chain refuses a slot above its head", async () => {
        const far = chain.slot() + 1_000_000n;
        const ask = () =>
            chain.rpc
                .getAccountInfo(address(a), { encoding: "jsonParsed", minContextSlot: far })
                .send();
        const refused = (e: unknown) =>
            isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED);
        await expect(ask()).rejects.toSatisfy(refused);
        chain.lagNode(10, { refuse: false });
        await expect(ask()).rejects.toSatisfy(refused);
    });

    it("a signed TransferChecked moves balances and is listed newest first", async () => {
        expect(chain.slot()).toBe(1_000n);
        expect(chain.height()).toBe(900n);
        const s1 = await send(10_000n);
        chain.advance(1);
        const s2 = await send(10_000n);
        expect(chain.balance(a)).toBe(980_000n);
        expect(chain.balance(b)).toBe(20_000n);
        const list = await chain.rpc
            .getSignaturesForAddress(address(a), { commitment: "confirmed" })
            .send();
        expect(list.map((e) => [e.signature, e.slot])).toEqual([
            [s2, 1_001n],
            [s1, 1_000n],
        ]);
        const raw = await getTx(s1);
        expect(raw?.meta?.err).toBeNull();
        expect(raw?.meta?.postTokenBalances).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    mint: USDC_MINT,
                    owner: other.address,
                    uiTokenAmount: expect.objectContaining({ amount: "10000", decimals: 6 }),
                }),
            ]),
        );
    });
    it("honours minContextSlot", async () => {
        const asked = () =>
            chain.rpc
                .getAccountInfo(address(a), {
                    encoding: "jsonParsed",
                    minContextSlot: chain.slot(),
                })
                .send();
        chain.lagNode(10);
        await expect(asked()).rejects.toSatisfy((e) =>
            isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED),
        );
        chain.lagNode(10, { refuse: false });
        expect((await asked()).context.slot).toBe(chain.slot() - 10n);
        chain.lagNode(10, { methods: ["getAccountInfo"] });
        expect((await chain.rpc.getEpochInfo().send()).absoluteSlot).toBe(chain.slot());
        chain.lagNode(0);
        expect((await asked()).context.slot).toBe(chain.slot());
    });
    it("hideFromIndex keeps a landed transaction out of the listing while the balance shows it", async () => {
        const s = await send(10_000n);
        chain.hideFromIndex(s, 60_000);
        const list = await chain.rpc.getSignaturesForAddress(address(a)).send();
        expect(list.map((e) => e.signature)).not.toContain(s);
        const info = await chain.rpc.getTokenAccountBalance(address(a)).send();
        expect(info.value.amount).toBe("990000");
        expect(await getTx(s)).not.toBeNull();
    });
    it("an expired blockhash is refused", async () => {
        const old = (await chain.rpc.getLatestBlockhash().send()).value;
        expect(old.lastValidBlockHeight).toBe(1_050n);
        chain.advance(151);
        await expect(send(10_000n, { lifetime: old })).rejects.toSatisfy((e) =>
            isSolanaError(
                e,
                SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
            ),
        );
        expect(chain.submitted()).toHaveLength(0);
    });
    it("finalized reads wait for finalize", async () => {
        const s = await send(10_000n);
        expect(await getTx(s, "finalized")).toBeNull();
        expect(
            (await chain.rpc.getEpochInfo({ commitment: "finalized" }).send()).absoluteSlot,
        ).toBe(999n);
        chain.finalize();
        expect(await getTx(s, "finalized")).not.toBeNull();
    });
    it("failNext lands with meta.err and moves nothing", async () => {
        chain.failNext();
        const s = await send(10_000n);
        expect((await getTx(s))?.meta?.err).not.toBeNull();
        expect(chain.balance(a)).toBe(1_000_000n);
        expect(chain.submitted()).toEqual([{ signature: s, slot: 1_000n, failed: true }]);
    });
    it("cosignAndSubmit lands a part-signed seller payment", async () => {
        const allowance = await testSigner(11);
        const seller = await testSigner(21);
        const hot = await usdcAta(allowance.address);
        chain.setTokenAccount({ address: hot, owner: allowance.address, amount: 50_000n });
        const { value } = await chain.rpc.getLatestBlockhash().send();
        const tx = buildSellerPayment({
            feePayer: seller.address,
            hotTokenAccount: hot,
            destination: address(b),
            authority: allowance.address,
            amount: 10_000n,
            memo: randomSellerMemo(),
            computeUnitLimit: 20_000,
            computeUnitPriceMicroLamports: 1n,
            blockhash: value.blockhash,
            lastValidBlockHeight: value.lastValidBlockHeight,
        });
        const signed = await signSellerPayment(tx, allowance);
        const s = await chain.cosignAndSubmit(signed.wireBase64, seller);
        const raw = await getTx(s);
        const decoded = getTransactionDecoder().decode(
            getBase64Encoder().encode(raw!.transaction[0]),
        );
        expect(Object.keys(decoded.signatures)[0]).toBe(seller.address);
        expect(getBase58Decoder().decode(Object.values(decoded.signatures)[0]!)).toBe(s);
        expect(chain.balance(hot)).toBe(40_000n);
        expect(chain.balance(b)).toBe(10_000n);
    });
    it("credit, debit and approve are listed for the account", async () => {
        const c1 = chain.credit(a, 5_000n);
        const d1 = chain.debit(a, 2_000n);
        const ap = chain.approve(a, other.address);
        expect(chain.balance(a)).toBe(1_003_000n);
        const list = await chain.rpc.getSignaturesForAddress(address(a)).send();
        expect(list.map((e) => e.signature)).toEqual([ap, d1, c1]);
        const info = await chain.rpc.getAccountInfo(address(a), { encoding: "jsonParsed" }).send();
        expect(
            (info.value?.data as { parsed: { info: { delegate?: string } } }).parsed.info.delegate,
        ).toBe(other.address);
    });
    it("withholdTransaction answers null that many times, and calls() records requests", async () => {
        const s = await send(10_000n);
        chain.withholdTransaction(s, 1);
        expect(await getTx(s)).toBeNull();
        expect(await getTx(s)).not.toBeNull();
        expect(chain.calls().filter((c) => c.method === "getTransaction")).toHaveLength(2);
    });
    it("getSignaturesStatuses reports a landed signature and null for an unknown one", async () => {
        const s = await send(10_000n);
        const unknown = getBase58Decoder().decode(new Uint8Array(64).fill(7));
        const { value } = await chain.rpc
            .getSignatureStatuses([signature(s), signature(unknown)])
            .send();
        expect(value[0]?.err).toBeNull();
        expect(value[0]?.slot).toBe(1_000n);
        expect(value[0]?.confirmationStatus).toBe("confirmed");
        expect(value[1]).toBeNull();
    });
    it("a transaction with a bad signature is rejected", async () => {
        const s = await send(10_000n);
        const raw = Buffer.from((await getTx(s))!.transaction[0], "base64");
        raw[1 + 3] = ~raw[1 + 3]! & 0xff;
        let caught: unknown;
        try {
            await chain.rpc
                .sendTransaction(raw.toString("base64") as never, { encoding: "base64" })
                .send();
        } catch (e) {
            caught = e;
        }
        expect(isSolanaError(caught)).toBe(true);
        expect(chain.submitted()).toHaveLength(1);
    });
    it("a transfer above the balance lands failed and moves nothing", async () => {
        const s = await send(2_000_000n);
        expect((await getTx(s))?.meta?.err).not.toBeNull();
        expect(chain.balance(a)).toBe(1_000_000n);
        expect(chain.balance(b)).toBe(0n);
    });
    it("the same signed transaction sent twice lands once", async () => {
        const s = await send(10_000n);
        const wire = (await getTx(s))!.transaction[0];
        const again = await chain.rpc.sendTransaction(wire as never, { encoding: "base64" }).send();
        expect(again).toBe(s);
        expect(chain.submitted()).toHaveLength(1);
        expect(chain.balance(b)).toBe(10_000n);
    });
    it("only the owner may approve, a delegate may not", async () => {
        chain.approve(a, other.address);
        const { value } = await chain.rpc.getLatestBlockhash().send();
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(value, m),
            (m) =>
                appendTransactionMessageInstruction(
                    getApproveInstruction({
                        source: address(a),
                        delegate: payer.address,
                        owner: other,
                        amount: 1n,
                    }),
                    m,
                ),
        );
        const signed = await signTransactionMessageWithSigners(message);
        const s = await chain.rpc
            .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" })
            .send();
        const tx = await getTx(s);
        expect(tx?.meta?.err).not.toBeNull();
        const info = await chain.rpc.getAccountInfo(address(a), { encoding: "jsonParsed" }).send();
        expect(
            (info.value?.data as { parsed: { info: { delegate?: string } } }).parsed.info.delegate,
        ).toBe(other.address);
    });
    it("a malformed body gets a JSON-RPC error and the server keeps answering", async () => {
        for (const body of ["{not json", "[]", '{"id":1,"method":5}']) {
            const res = await fetch(chain.url, { method: "POST", body });
            const json = (await res.json()) as { error?: { code: number } };
            expect(json.error?.code).toBeLessThan(0);
        }
        expect(await chain.rpc.getSlot().send()).toBe(1_000n);
    });
});

describe("fake chain endpoints", () => {
    let chain: FakeChain;
    let owner: KeyPairSigner, payer: KeyPairSigner, other: KeyPairSigner;
    let a: string, b: string;
    beforeEach(async () => {
        chain = await startFakeChain();
        [owner, payer, other] = await Promise.all([testSigner(31), testSigner(32), testSigner(33)]);
        a = await usdcAta(owner.address);
        b = await usdcAta(other.address);
        chain.setTokenAccount({ address: a, owner: owner.address, amount: 1_000_000n });
        chain.setTokenAccount({ address: b, owner: other.address, amount: 0n });
    });
    afterEach(() => chain.close());
    const landed = () =>
        chain.transfer({
            authority: owner,
            feePayer: payer,
            source: a,
            destination: b,
            micros: 10n,
        });
    const statuses = (url: string, sig: string) =>
        createRpc(url)
            .getSignatureStatuses([signature(sig)], { searchTransactionHistory: true })
            .send();
    const code = (e: unknown) => (isSolanaError(e) ? e.context.__code : null);

    it("an unknown before cursor gives an empty page", async () => {
        const ep = await chain.addEndpoint();
        await landed();
        // A new blockhash, so the same transfer is another transaction
        chain.advance(1);
        await landed();
        const rpc = createRpc(ep.url);
        const list = (o: { before?: string } = {}) =>
            rpc
                .getSignaturesForAddress(address(b), {
                    commitment: "confirmed",
                    ...(o.before === undefined ? {} : { before: signature(o.before) }),
                })
                .send();
        const all = await list();
        expect(all).toHaveLength(2);
        expect(await list({ before: all[0]!.signature })).toHaveLength(1);
        const unknown = getBase58Decoder().decode(new Uint8Array(64).fill(9));
        expect(await list({ before: unknown })).toEqual([]);
    });

    it("a lagging endpoint misses a blockhash newer than its slot", async () => {
        const ep = await chain.addEndpoint();
        ep.setLag(30, { refuse: false });
        const life = (await chain.rpc.getLatestBlockhash().send()).value;
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(life, m),
            (m) =>
                appendTransactionMessageInstruction(
                    getTransferCheckedInstruction({
                        source: address(a),
                        mint: address(USDC_MINT),
                        destination: address(b),
                        authority: owner,
                        amount: 10n,
                        decimals: USDC_DECIMALS,
                    }),
                    m,
                ),
        );
        const wire = getBase64EncodedWireTransaction(
            await signTransactionMessageWithSigners(message),
        );
        const rpc = createRpc(ep.url);
        const simulated = (await rpc
            .simulateTransaction(wire as never, { encoding: "base64" })
            .send()) as { value: { err: unknown } };
        expect(simulated.value.err).toBe("BlockhashNotFound");
        const before = chain.submitted().length;
        await expect(
            rpc.sendTransaction(wire as never, { encoding: "base64" }).send(),
        ).rejects.toSatisfy(
            (e) =>
                code(e) === SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
        );
        expect(chain.submitted()).toHaveLength(before);
        // Without a preflight the node only forwards it
        await rpc
            .sendTransaction(wire as never, { encoding: "base64", skipPreflight: true })
            .send();
        expect(chain.submitted()).toHaveLength(before + 1);
    });

    it("endpoints share one chain", async () => {
        const ep = await chain.addEndpoint();
        await landed();
        const { value } = await createRpc(ep.url).getTokenAccountBalance(address(b)).send();
        expect(value.amount).toBe("10");
    });

    it("a history-less endpoint answers -32011", async () => {
        const ep = await chain.addEndpoint({ history: false });
        const sig = await landed();
        const rpc = createRpc(ep.url);
        await expect(statuses(ep.url, sig)).rejects.toSatisfy((e) => code(e) === -32011);
        await expect(
            rpc
                .getTransaction(signature(sig), {
                    encoding: "base64",
                    maxSupportedTransactionVersion: 0,
                })
                .send(),
        ).rejects.toSatisfy((e) => code(e) === -32011);
        await expect(rpc.getSignaturesForAddress(address(b)).send()).rejects.toSatisfy(
            (e) => code(e) === -32011,
        );
    });

    it("a short-history endpoint answers null at a current slot", async () => {
        const ep = await chain.addEndpoint({ history: "short" });
        const sig = await landed();
        const r = await statuses(ep.url, sig);
        expect(r.value).toEqual([null]);
        expect(r.context.slot).toBe(chain.slot());
    });

    it("rate limits answer 429 with Retry-After", async () => {
        const ep = await chain.addEndpoint();
        ep.rateLimit(1, 10);
        const err = await createRpc(ep.url)
            .getSlot()
            .send()
            .catch((e: unknown) => e);
        expect(code(err)).toBe(8100002);
        const ctx = (err as { context: { statusCode?: number; headers?: Headers } }).context;
        expect(ctx.statusCode).toBe(429);
        expect(ctx.headers?.get("retry-after")).toBe("10");
        expect(await createRpc(ep.url).getSlot().send()).toBe(chain.slot());

        ep.rateLimit(1);
        const bare = await createRpc(ep.url)
            .getSlot()
            .send()
            .catch((e: unknown) => e);
        const headers = (bare as { context: { headers?: Headers } }).context.headers;
        expect(headers?.get("retry-after") ?? null).toBeNull();
    });

    it("a frozen endpoint keeps its slot", async () => {
        const ep = await chain.addEndpoint();
        const before = await createRpc(ep.url).getSlot().send();
        ep.freeze(true);
        chain.advance(100);
        expect(await createRpc(ep.url).getSlot().send()).toBe(before);
        expect(await chain.rpc.getSlot().send()).toBe(before + 100n);
    });

    it("an endpoint can ignore an unreachable minContextSlot", async () => {
        const ep = await chain.addEndpoint({ ignoreMinContextSlot: true });
        const far = chain.slot() + 1_000_000n;
        const info = await createRpc(ep.url)
            .getAccountInfo(address(a), { encoding: "jsonParsed", minContextSlot: far })
            .send();
        expect(info.value).not.toBeNull();
    });

    it("history can be turned off after start", async () => {
        const ep = await chain.addEndpoint();
        const sig = await landed();
        expect((await statuses(ep.url, sig)).value[0]).not.toBeNull();
        ep.setHistory("short");
        expect((await statuses(ep.url, sig)).value).toEqual([null]);
        ep.setHistory(false);
        await expect(statuses(ep.url, sig)).rejects.toSatisfy((e) => code(e) === -32011);
    });

    it("an alternating endpoint flips its history answers", async () => {
        const ep = await chain.addEndpoint();
        const sig = await landed();
        ep.setHistory("alternate");
        const seen: boolean[] = [];
        for (let i = 0; i < 4; i++) seen.push((await statuses(ep.url, sig)).value[0] !== null);
        expect(seen).toEqual([true, false, true, false]);
    });

    it("each endpoint is its own domain", async () => {
        const [e1, e2] = await Promise.all([chain.addEndpoint(), chain.addEndpoint()]);
        expect(domainOf(e1.url)).not.toBe(domainOf(e2.url));
    });
});
