import {
    address,
    getBase58Decoder,
    getBase64Encoder,
    getTransactionDecoder,
    isSolanaError,
    type KeyPairSigner,
    signature,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usdcAta } from "../solana/accounts.ts";
import { USDC_MINT } from "../solana/constants.ts";
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
});
