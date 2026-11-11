import {
    address,
    appendTransactionMessageInstruction,
    appendTransactionMessageInstructions,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    getCompiledTransactionMessageDecoder,
    type Instruction,
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
    SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from "@solana/kit";
import {
    getSetComputeUnitLimitInstruction,
    getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import {
    getApproveInstruction,
    getCloseAccountInstruction,
    getCreateAssociatedTokenInstructionAsync,
    getTransferCheckedInstruction,
} from "@solana-program/token";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FRESH_SEND, RESEND } from "../refunds/executor.ts";
import { usdcAta } from "../solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_DECIMALS, USDC_MINT } from "../solana/constants.ts";
import { domainOf, MAINNET_GENESIS, MAINNET_HISTORY_PROBE } from "../solana/router/index.ts";
import { createRpc } from "../solana/rpc.ts";
import { buildSellerPayment, randomSellerMemo, signSellerPayment } from "../x402/build.ts";
import { type FakeChain, startFakeChain } from "./fake-chain.ts";
import { testSigner } from "./keys.ts";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

interface RawBalance {
    accountIndex: number;
    owner?: string;
    programId?: string;
    uiTokenAmount: { amount: string };
}

const isMinSlot = (e: unknown) =>
    isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED);

const parsedInfo = (account: unknown) =>
    (account as { data: { parsed: { info: { owner: string; tokenAmount: { amount: string } } } } })
        .data.parsed.info;

function staticKeys(wireBase64: string): { keys: string[]; signers: string[] } {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const keys = [...compiled.staticAccounts] as string[];
    return { keys, signers: keys.slice(0, compiled.header.numSignerAccounts) };
}

const balanceFor = (list: unknown, index: number) =>
    (list as RawBalance[]).find((b) => b.accountIndex === index);

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

    async function signedWire(feePayer: KeyPairSigner, instructions: Instruction[]) {
        const { value } = await chain.rpc.getLatestBlockhash().send();
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(feePayer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(value, m),
            (m) => appendTransactionMessageInstructions(instructions, m),
        );
        return getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message));
    }
    const sendWire = (wire: string, config: object = { encoding: "base64" }) =>
        chain.rpc.sendTransaction(wire as never, config as never).send();
    const listing = (account: string, config: object = {}) =>
        chain.rpc
            .getSignaturesForAddress(address(account), { commitment: "confirmed", ...config })
            .send();
    const transferIx = (micros: bigint) =>
        getTransferCheckedInstruction({
            source: address(a),
            mint: USDC_MINT,
            destination: address(b),
            authority: owner,
            amount: micros,
            decimals: USDC_DECIMALS,
        });
    async function closable(micros: bigint) {
        const closer = await testSigner(48);
        const account = await usdcAta(closer.address);
        chain.setTokenAccount({ address: account, owner: closer.address, amount: micros });
        const close = getCloseAccountInstruction({
            account: address(account),
            destination: other.address,
            owner: closer,
        });
        return { account, close };
    }

    it("getMultipleAccounts answers present, missing and system accounts", async () => {
        const present = await usdcAta((await testSigner(41)).address);
        chain.setTokenAccount({ address: present, owner: other.address, amount: 7_000n });
        const missing = await usdcAta((await testSigner(42)).address);
        const system = (await testSigner(43)).address;
        chain.fundLamports(system, 890_880n);
        const { value } = await chain.rpc
            .getMultipleAccounts([address(present), address(missing), system], {
                encoding: "jsonParsed",
            })
            .send();
        expect(parsedInfo(value[0]).tokenAmount.amount).toBe("7000");
        expect(value[1]).toBeNull();
        expect(value[2]?.owner).toBe(SYSTEM_PROGRAM);
        expect(value[2]?.lamports).toBe(890_880n);
    });
    it("minContextSlot past the view is refused", async () => {
        chain.lagNode(5);
        await expect(
            chain.rpc
                .getMultipleAccounts([address(a)], {
                    encoding: "jsonParsed",
                    minContextSlot: chain.slot(),
                })
                .send(),
        ).rejects.toSatisfy(isMinSlot);
        await expect(listing(a, { minContextSlot: chain.slot() })).rejects.toSatisfy(isMinSlot);
        const { context } = await chain.rpc
            .getMultipleAccounts([address(a)], { encoding: "jsonParsed" })
            .send();
        expect(context.slot).toBe(chain.slot() - 5n);
    });
    it("CreateIdempotent creates an empty account and repeats as a no-op", async () => {
        const fresh = await testSigner(44);
        const ata = await usdcAta(fresh.address);
        expect(chain.accountExists(ata)).toBe(false);
        const s1 = await chain.createAta({ owner: fresh.address, payer });
        expect(chain.accountExists(ata)).toBe(true);
        expect(chain.balance(ata)).toBe(0n);
        const info = await chain.rpc
            .getAccountInfo(address(ata), { encoding: "jsonParsed" })
            .send();
        expect(info.value?.owner).toBe(TOKEN_PROGRAM);
        expect(parsedInfo(info.value).owner).toBe(fresh.address);
        const s2 = await chain.createAta({ owner: fresh.address, payer });
        expect(s2).not.toBe(s1);
        expect(chain.submitted()).toEqual([
            { signature: s1, slot: 1_000n, failed: false },
            { signature: s2, slot: 1_000n, failed: false },
        ]);
        expect(chain.balance(ata)).toBe(0n);

        const create = await getCreateAssociatedTokenInstructionAsync({
            payer,
            owner: fresh.address,
            mint: USDC_MINT,
        });
        const s3 = await sendWire(await signedWire(payer, [create]));
        expect(chain.submitted().find((t) => t.signature === s3)?.failed).toBe(true);
        expect(chain.accountExists(ata)).toBe(true);
    });
    it("CreateIdempotent works over a prefunded address", async () => {
        const fresh = await testSigner(44);
        const ata = await usdcAta(fresh.address);
        chain.fundLamports(ata, 890_880n);
        expect(chain.accountExists(ata)).toBe(false);
        await chain.createAta({ owner: fresh.address, payer });
        expect(chain.accountExists(ata)).toBe(true);
        expect(chain.lamports(ata)).toBe(2_039_280n);
        const { value } = await chain.rpc
            .getMultipleAccounts([address(ata)], { encoding: "jsonParsed" })
            .send();
        expect(value[0]?.owner).toBe(TOKEN_PROGRAM);
        expect(parsedInfo(value[0]).owner).toBe(fresh.address);
    });
    it("the creating transaction has no pre balance for the new account", async () => {
        const fresh = await testSigner(44);
        const ata = await usdcAta(fresh.address);
        const s = await chain.createAta({ owner: fresh.address, payer });
        const raw = (await getTx(s))!;
        const index = staticKeys(raw.transaction[0]).keys.indexOf(ata);
        expect(index).toBeGreaterThan(0);
        expect(balanceFor(raw.meta?.preTokenBalances, index)).toBeUndefined();
        expect(balanceFor(raw.meta?.postTokenBalances, index)).toEqual(
            expect.objectContaining({
                owner: fresh.address,
                programId: TOKEN_PROGRAM,
                uiTokenAmount: expect.objectContaining({ amount: "0" }),
            }),
        );
    });
    it("CloseAccount with money fails and moves nothing", async () => {
        const { account, close } = await closable(1n);
        const before = chain.lamports(other.address);
        const s = await sendWire(await signedWire(payer, [close]));
        expect((await getTx(s))?.meta?.err).not.toBeNull();
        expect(chain.accountExists(account)).toBe(true);
        expect(chain.balance(account)).toBe(1n);
        expect(chain.lamports(other.address)).toBe(before);
    });
    it("CloseAccount at zero removes the account and pays its rent", async () => {
        const { account, close } = await closable(0n);
        const before = chain.lamports(other.address);
        const s = await sendWire(await signedWire(payer, [close]));
        const raw = (await getTx(s))!;
        expect(raw.meta?.err).toBeNull();
        const index = staticKeys(raw.transaction[0]).keys.indexOf(account);
        expect(balanceFor(raw.meta?.preTokenBalances, index)).toBeDefined();
        expect(balanceFor(raw.meta?.postTokenBalances, index)).toBeUndefined();
        expect(chain.accountExists(account)).toBe(false);
        const info = await chain.rpc
            .getAccountInfo(address(account), { encoding: "jsonParsed" })
            .send();
        expect(info.value).toBeNull();
        const { value } = await chain.rpc
            .getMultipleAccounts([address(account)], { encoding: "jsonParsed" })
            .send();
        expect(value[0]).toBeNull();
        expect(chain.lamports(other.address) - before).toBe(2_039_280n);
    });
    it("preflight refuses a failing close without landing it", async () => {
        const { account, close } = await closable(1n);
        const wire = await signedWire(payer, [
            getSetComputeUnitLimitInstruction({ units: 40_000 }),
            getSetComputeUnitPriceInstruction({ microLamports: 10_000n }),
            close,
        ]);
        chain.preflight(true);
        let caught: unknown;
        try {
            await sendWire(wire, FRESH_SEND);
        } catch (e) {
            caught = e;
        }
        expect(
            isSolanaError(
                caught,
                SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
            ),
        ).toBe(true);
        const cause = (caught as { cause?: unknown }).cause;
        expect(isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)).toBe(true);
        expect((cause as { context: { index: number } }).context.index).toBe(2);
        expect(chain.submitted()).toEqual([]);

        const s = await sendWire(wire, RESEND);
        expect(chain.submitted()).toEqual([{ signature: s, slot: 1_000n, failed: true }]);
        expect(chain.accountExists(account)).toBe(true);
    });
    it("transferMany credits two accounts in one signature", async () => {
        const c = await usdcAta((await testSigner(41)).address);
        chain.setTokenAccount({ address: c, owner: other.address, amount: 0n });
        const s = await chain.transferMany({
            from: owner,
            to: [
                { tokenAccount: b, micros: 30_000n },
                { tokenAccount: c, micros: 20_000n },
            ],
        });
        expect(chain.balance(b)).toBe(30_000n);
        expect(chain.balance(c)).toBe(20_000n);
        expect(chain.balance(a)).toBe(950_000n);
        expect((await listing(b)).map((e) => e.signature)).toEqual([s]);
        expect((await listing(c)).map((e) => e.signature)).toEqual([s]);
        expect(staticKeys((await getTx(s))!.transaction[0]).signers).toEqual([owner.address]);
    });
    it("noOp names many accounts and moves nothing", async () => {
        const c = await usdcAta((await testSigner(41)).address);
        chain.setTokenAccount({ address: c, owner: other.address, amount: 5n });
        const s = await chain.noOp({ touching: [a, b, c], signer: payer });
        for (const account of [a, b, c]) {
            const list = await listing(account);
            expect(list.map((e) => [e.signature, e.err])).toEqual([[s, null]]);
        }
        expect([chain.balance(a), chain.balance(b), chain.balance(c)]).toEqual([
            1_000_000n,
            0n,
            5n,
        ]);
        const failed = await chain.noOp({ touching: c, signer: payer, fail: true });
        expect(failed).not.toBe(s);
        expect((await listing(c))[0]?.err).not.toBeNull();
        expect(chain.balance(c)).toBe(5n);
    });
    it("vaultTransfer debits an account whose owner did not sign", async () => {
        const s = await chain.vaultTransfer({ vault: a, to: b, micros: 5_000n, signer: payer });
        expect(chain.balance(a)).toBe(995_000n);
        expect(chain.balance(b)).toBe(5_000n);
        const raw = (await getTx(s))!;
        expect(raw.meta?.err).toBeNull();
        const { keys, signers } = staticKeys(raw.transaction[0]);
        expect(signers).toEqual([payer.address]);
        expect(signers).not.toContain(owner.address);
        expect(balanceFor(raw.meta?.postTokenBalances, keys.indexOf(a))).toEqual(
            expect.objectContaining({
                owner: owner.address,
                uiTokenAmount: expect.objectContaining({ amount: "995000" }),
            }),
        );
    });
    it("System Transfer and getBalance", async () => {
        const sender = await testSigner(45);
        const to = (await testSigner(46)).address;
        chain.fundLamports(sender.address, 5_000_000n);
        const transferSol = (amount: bigint) =>
            getTransferSolInstruction({ source: sender, destination: to, amount });
        const s = await sendWire(await signedWire(payer, [transferSol(1_000_000n)]));
        expect((await getTx(s))?.meta?.err).toBeNull();
        expect((await chain.rpc.getBalance(to).send()).value).toBe(1_000_000n);
        expect(chain.lamports(sender.address)).toBe(4_000_000n);

        const tooMuch = await sendWire(await signedWire(payer, [transferSol(10_000_000n)]));
        expect((await getTx(tooMuch))?.meta?.err).not.toBeNull();
        expect(chain.lamports(to)).toBe(1_000_000n);
    });
    it("setBlockTime and getBlockTime", async () => {
        chain.setBlockTime(1_893_456_299);
        const s = await send(10_000n);
        const [row] = await listing(b);
        expect(row?.blockTime).toBe(1_893_456_299n);
        expect((await getTx(s))?.blockTime).toBe(1_893_456_299n);
        const at = row!.slot;
        expect(await chain.rpc.getBlockTime(at).send()).toBe(1_893_456_299n);

        chain.setBlockTime(null);
        chain.advance(1);
        const s2 = await send(10_000n);
        const [row2] = await listing(b);
        expect(row2?.signature).toBe(s2);
        expect(row2?.blockTime).toBeNull();
        expect((await getTx(s2))?.blockTime).toBeNull();

        chain.withholdBlockTime(at, 1);
        await expect(chain.rpc.getBlockTime(at).send()).rejects.toSatisfy((e) =>
            isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE),
        );
        expect(await chain.rpc.getBlockTime(at).send()).toBe(1_893_456_299n);

        chain.withholdBlockTime(at, 1);
        expect((await getTx(s))?.blockTime).toBeNull();
        expect((await getTx(s))?.blockTime).toBe(1_893_456_299n);

        chain.lagNode(5);
        await expect(chain.rpc.getBlockTime(chain.slot()).send()).rejects.toSatisfy((e) =>
            isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE),
        );
        chain.lagNode(0);

        const res = await fetch(chain.url, {
            method: "POST",
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getBlockTime",
                params: [Number(at), { commitment: "confirmed" }],
            }),
        });
        expect(((await res.json()) as { error?: { code: number } }).error?.code).toBe(-32602);
    });
    it("getLatestBlockhash honours minContextSlot", async () => {
        chain.lagNode(5);
        await expect(
            chain.rpc.getLatestBlockhash({ minContextSlot: chain.slot() }).send(),
        ).rejects.toSatisfy(isMinSlot);
    });
    it("a confirmed-pinned FRESH_SEND lands on a chain without autoFinalize", async () => {
        const pinned = { ...FRESH_SEND, minContextSlot: chain.slot() };
        const s = await sendWire(await signedWire(payer, [transferIx(10_000n)]), pinned);
        expect(chain.submitted().map((t) => t.signature)).toEqual([s]);

        chain.lagNode(5);
        const lagging = await signedWire(payer, [transferIx(20_000n)]);
        await expect(sendWire(lagging, pinned)).rejects.toSatisfy(isMinSlot);
        chain.lagNode(0);

        const resend = { ...RESEND, minContextSlot: chain.slot() };
        const s2 = await sendWire(await signedWire(payer, [transferIx(30_000n)]), resend);
        expect(chain.submitted().map((t) => t.signature)).toEqual([s, s2]);
        expect(chain.balance(b)).toBe(40_000n);
    });
    it("pruneHistoryBefore hides older entries", async () => {
        const sigs: string[] = [];
        for (const micros of [1n, 2n, 3n]) {
            chain.advance(10);
            sigs.push(await send(micros));
        }
        expect((await listing(b)).map((e) => e.slot)).toEqual([1_030n, 1_020n, 1_010n]);
        chain.pruneHistoryBefore(1_025n);
        expect((await listing(b)).map((e) => e.signature)).toEqual([sigs[2]]);
        expect(await listing(b, { before: signature(sigs[2]!), limit: 1 })).toEqual([]);
        expect(await listing(b, { before: signature(sigs[1]!) })).toEqual([]);
        chain.pruneHistoryBefore(null);
        expect((await listing(b)).map((e) => e.signature)).toEqual([...sigs].reverse());
    });
    it("undecodable keeps the meta", async () => {
        const s = await send(5_000n);
        const keys = staticKeys((await getTx(s))!.transaction[0]).keys;
        chain.undecodable(s);
        const raw = (await getTx(s))!;
        expect(() => staticKeys(raw.transaction[0])).toThrow();
        expect(balanceFor(raw.meta?.postTokenBalances, keys.indexOf(b))).toEqual(
            expect.objectContaining({ uiTokenAmount: expect.objectContaining({ amount: "5000" }) }),
        );
    });
    it("badAnswer strips the meta for a number of answers", async () => {
        const s = await send(5_000n);
        chain.badAnswer(s, 1, { meta: "null" });
        expect((await getTx(s))?.meta).toBeNull();
        const whole = (await getTx(s))!;
        expect(whole.meta?.postTokenBalances).toHaveLength(2);
        const index = staticKeys(whole.transaction[0]).keys.indexOf(b);

        chain.badAnswer(s, 1, { dropTokenEntryFor: b });
        const dropped = (await getTx(s))!;
        expect(balanceFor(dropped.meta?.preTokenBalances, index)).toBeUndefined();
        expect(balanceFor(dropped.meta?.postTokenBalances, index)).toBeUndefined();
        expect(dropped.meta?.postTokenBalances).toHaveLength(1);
        expect((await getTx(s))?.meta?.postTokenBalances).toHaveLength(2);
    });
    it("transfer with createDestinationFor creates and credits", async () => {
        const fresh = await testSigner(47);
        const destination = await usdcAta(fresh.address);
        const s = await send(6_000n, { destination, createDestinationFor: fresh.address });
        expect(chain.accountExists(destination)).toBe(true);
        expect(chain.balance(destination)).toBe(6_000n);
        const raw = (await getTx(s))!;
        expect(raw.meta?.err).toBeNull();
        const index = staticKeys(raw.transaction[0]).keys.indexOf(destination);
        expect(balanceFor(raw.meta?.preTokenBalances, index)).toBeUndefined();
        expect(balanceFor(raw.meta?.postTokenBalances, index)).toEqual(
            expect.objectContaining({
                owner: fresh.address,
                uiTokenAmount: expect.objectContaining({ amount: "6000" }),
            }),
        );
    });
    it("hideFromStatus answers null for a landed signature", async () => {
        const s = await send(10_000n);
        chain.hideFromStatus(s);
        const { value } = await chain.rpc.getSignatureStatuses([signature(s)]).send();
        expect(value[0]).toBeNull();
        expect(await getTx(s)).not.toBeNull();
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
