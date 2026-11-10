import {
    address,
    appendTransactionMessageInstructions,
    blockhash,
    compileTransaction,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    type KeyPairSigner,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    signature as toSignature,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { memoryLog } from "../log.ts";
import { findPaymentByOrder } from "../orders/store.ts";
import { findRefundById } from "../refunds/request.ts";
import { usdcAta } from "../solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_DECIMALS, USDC_MINT } from "../solana/constants.ts";
import { startFakeChain, type FakeChain } from "../testing/fake-chain.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { testSigner } from "../testing/keys.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import {
    hotOrderPaidWith,
    landPayment,
    resetLedger,
    seedAccount,
    seedFunding,
    signedRow,
    TEST_PAYTO,
} from "../testing/x402.ts";
import { readControls } from "./controls.ts";
import { findAccount } from "./ledger.ts";
import {
    alarmUnresolved,
    applyExpiry,
    confirmColdTransfer,
    parseChainTx,
    matchInTx,
    storeAndMatch,
    usdcDeltaFor,
    type ChainTx,
    type MatchDeps,
} from "./match.ts";
import { findX402Payment } from "./reserve.ts";
import { resignProof } from "./resign.ts";

const NOW = new Date("2030-01-01T12:00:00Z");
const DAY = "2030-01-01";
const FAR = 1_000_000n;

let db: TestDb;
let chain: FakeChain;
let deps: MatchDeps;
let log: ReturnType<typeof memoryLog>;
let x402: Settings["x402"];
let hot: string;
let payToAta: string;
let cold: string;
let allowance: Awaited<ReturnType<typeof testSigner>>;
let seller: Awaited<ReturnType<typeof testSigner>>;
let feePayer: Awaited<ReturnType<typeof testSigner>>;

beforeAll(async () => {
    db = await testDb();
    x402 = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t").x402;
    allowance = await testSigner(11);
    seller = await testSigner(21);
    feePayer = await testSigner(22);
    hot = await usdcAta(allowance.address);
    payToAta = await usdcAta(address(TEST_PAYTO));
    cold = await usdcAta((await testSigner(23)).address);
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await resetLedger(db.pool);
    await db.pool.query(
        `truncate x402_chain_txs, x402_incidents, x402_cold_transfers, x402_payto_days,
            x402_unlisted_days, x402_outflow_days cascade`,
    );
    chain = await startFakeChain();
    chain.setTokenAccount({ address: hot, owner: allowance.address, amount: 1_000_000n });
    chain.setTokenAccount({ address: payToAta, owner: TEST_PAYTO, amount: 0n });
    chain.setTokenAccount({ address: cold, owner: (await testSigner(23)).address, amount: 0n });
    log = memoryLog();
    deps = {
        x402,
        hotTokenAccount: hot,
        coldTokenAccount: cold,
        log,
        now: () => NOW,
        rpcTimeoutMs: 2_000,
    };
});
afterEach(async () => {
    await chain.close();
});

async function readTx(sig: string): Promise<ChainTx> {
    const raw = await chain.rpc
        .getTransaction(toSignature(sig), {
            encoding: "base64",
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        })
        .send();
    return parseChainTx(sig, raw!.slot, raw, hot);
}

const match = (tx: ChainTx) => matchInTx(db.pool, tx, deps);
const paymentRow = async (id: string) => (await findX402Payment(db.pool, id))!;
const chainRow = async (sig: string) =>
    (await db.pool.query("select * from x402_chain_txs where signature = $1", [sig])).rows[0];
const incidents = async () =>
    (await db.pool.query("select * from x402_incidents order by id")).rows;
const resolvedRows = async () =>
    (
        await db.pool.query(
            "select ref, payload from x402_router_events where kind = 'x402_resolved' order by id",
        )
    ).rows;
const dayMicros = async (table: string, day: string) =>
    Number(
        (await db.pool.query(`select micros from ${table} where day = $1::date`, [day])).rows[0]
            .micros,
    );
const alarms = (name: string) => log.lines.filter((l) => l.alarm === name);

async function hotOrderWithFailedPayment(sig: string) {
    const { order } = await seedOrder(db.pool, {
        kind: "start",
        state: "unpaid",
        payInto: "allowance",
        allowanceMicros: 1_000_000,
        feeMicros: 3_000,
        amountMicros: 1_013_000,
    });
    await db.pool.query(
        `insert into failed_payments (order_id, tx_signature, message_hash, payer, amount_micros,
            reason) values ($1, $2, 'mh', 'payer-test', 1013000, 'blockhash_expired')`,
        [order.id, sig],
    );
    return order;
}

async function allowanceRefund(o: {
    amountMicros: number;
    destination: string;
    state: "signed" | "sent";
    txSignature: string;
    previousSignatures?: string[];
    expirySeenSlot?: bigint;
    lastValidBlockHeight?: bigint;
}) {
    const account = await seedAccount(db.pool, {});
    await seedPayment(db.pool, account.id, {
        status: "confirmed",
        payer: "payer-1",
        sourceTokenAccount: "src-1",
    });
    await db.pool.query("update x402_pool set committed_micros = 1000000 where id = 1");
    await seedFunding(db.pool, { accountId: account.id, orderId: account.id });
    const res = await db.pool.query<{ id: string }>(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            from_wallet, tx_signature, previous_signatures, expiry_seen_slot,
            last_valid_block_height, created_at)
         values ($1, 'allowance', 'x402_unspent', $2, $3, 'payer-1', $4, 'allowance', $5, $6, $7,
            $8, $9) returning id`,
        [
            account.id,
            o.amountMicros,
            o.destination,
            o.state,
            o.txSignature,
            o.previousSignatures ?? [],
            o.expirySeenSlot?.toString() ?? null,
            o.lastValidBlockHeight?.toString() ?? null,
            NOW,
        ],
    );
    return { id: Number(res.rows[0]!.id), accountId: account.id };
}

async function coldRow(o: {
    amountMicros: number;
    state: "signed" | "sent";
    txSignature: string;
    lastValidBlockHeight?: bigint;
}): Promise<number> {
    const res = await db.pool.query<{ id: string }>(
        `insert into x402_cold_transfers (amount_micros, state, tx_signature, last_valid_block_height)
         values ($1, $2, $3, $4) returning id`,
        [o.amountMicros, o.state, o.txSignature, o.lastValidBlockHeight?.toString() ?? null],
    );
    return Number(res.rows[0]!.id);
}

describe("parseChainTx", () => {
    it("reads signatures in order, deltas and token instructions", async () => {
        const p = await landPayment(chain, db.pool, {});
        const tx = await readTx(p.txSignature);
        expect(tx.signatures[0]).toBe(p.txSignature);
        expect(tx.signatures).toHaveLength(2);
        expect(tx.messageHash).toBe(p.messageHash);
        expect(tx.deltaMicros).toBe(-10_000n);
        expect(tx.tokenDeltas.get(payToAta)).toBe(10_000n);
        expect(tx.tokenInstructions).toEqual([
            { name: "TransferChecked", writable: [hot, payToAta] },
        ]);
        expect(tx.failed).toBe(false);
    });

    it("throws when the encoding is not base64", async () => {
        const p = await landPayment(chain, db.pool, {});
        const raw = await chain.rpc
            .getTransaction(toSignature(p.txSignature), {
                encoding: "base64",
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
            })
            .send();
        const json = { ...raw!, transaction: [raw!.transaction[0], "base58"] };
        expect(() => parseChainTx(p.txSignature, raw!.slot, json, hot)).toThrow(/base64/);
    });

    it("throws when the signature is not the transaction's first signature", async () => {
        const p = await landPayment(chain, db.pool, {});
        const other = await landPayment(chain, db.pool, {});
        const raw = await chain.rpc
            .getTransaction(toSignature(p.txSignature), {
                encoding: "base64",
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
            })
            .send();
        expect(() => parseChainTx(other.txSignature, raw!.slot, raw, hot)).toThrow(/signature/);
    });

    it("reads a legacy transaction that moves USDC into the hot account", async () => {
        const message = pipe(
            createTransactionMessage({ version: "legacy" }),
            (m) => setTransactionMessageFeePayer(seller.address, m),
            (m) =>
                setTransactionMessageLifetimeUsingBlockhash(
                    {
                        blockhash: blockhash("11111111111111111111111111111111"),
                        lastValidBlockHeight: 1n,
                    },
                    m,
                ),
            (m) =>
                appendTransactionMessageInstructions(
                    [
                        getTransferCheckedInstruction({
                            source: address(payToAta),
                            mint: address(USDC_MINT),
                            destination: address(hot),
                            authority: seller.address,
                            amount: 7n,
                            decimals: USDC_DECIMALS,
                        }),
                    ],
                    m,
                ),
        );
        const wire = getBase64EncodedWireTransaction(compileTransaction(message));
        const balance = (accountIndex: number, amount: string) => ({
            accountIndex,
            mint: USDC_MINT,
            uiTokenAmount: { amount },
        });
        const sig = "1".repeat(64);
        const tx = parseChainTx(
            sig,
            9n,
            {
                transaction: [wire, "base64"],
                meta: {
                    err: null,
                    loadedAddresses: { writable: [], readonly: [] },
                    preTokenBalances: [balance(1, "0"), balance(2, "100")],
                    postTokenBalances: [balance(1, "7"), balance(2, "93")],
                },
            },
            hot,
        );
        expect(tx.signatures).toHaveLength(1);
        expect(tx.deltaMicros).toBe(7n);
        expect(tx.tokenDeltas.get(payToAta)).toBe(-7n);
        expect(tx.tokenInstructions).toEqual([
            { name: "TransferChecked", writable: expect.arrayContaining([payToAta, hot]) },
        ]);
    });
});

describe("parseChainTx: owners, signers and the fee payer", () => {
    const DEPOSIT = "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley";
    const DEPOSIT_ATA = "D2mAKdUVEHvizHThmG57bTCiASiiYj5gQbMeMoyWtQo1";
    const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
    let payer: KeyPairSigner;
    let payerAta: string;

    beforeEach(async () => {
        payer = await testSigner(31);
        payerAta = await usdcAta(payer.address);
        chain.setTokenAccount({ address: payerAta, owner: payer.address, amount: 100_000n });
    });

    const send = (micros: bigint, o: { createDestinationFor?: string } = {}) =>
        chain.transfer({
            authority: payer,
            feePayer,
            source: payerAta,
            destination: DEPOSIT_ATA,
            micros,
            ...o,
        });
    const rawTx = async (sig: string) =>
        (await chain.rpc
            .getTransaction(toSignature(sig), {
                encoding: "base64",
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
            })
            .send())!;
    type Entry = { accountIndex: number; owner?: string; uiTokenAmount: { amount: string } };
    type Edit = (list: readonly Entry[]) => unknown[];
    const editBalances = (raw: unknown, pre: Edit, post: Edit) => {
        const r = raw as { meta: { preTokenBalances: Entry[]; postTokenBalances: Entry[] } };
        return {
            ...r,
            meta: {
                ...r.meta,
                preTokenBalances: pre(r.meta.preTokenBalances),
                postTokenBalances: post(r.meta.postTokenBalances),
            },
        };
    };
    // The fee payer's index: a key with no USDC entry, so an added entry stands alone
    const addedEntry = (o: { mint: string; programId: string; amount: string }) => ({
        accountIndex: 0,
        mint: o.mint,
        owner: feePayer.address,
        programId: o.programId,
        uiTokenAmount: { amount: o.amount },
    });

    it("parseChainTx keeps owners, balances, signers and the fee payer", async () => {
        chain.setTokenAccount({ address: DEPOSIT_ATA, owner: DEPOSIT, amount: 0n });
        const tx = await readTx(await send(6_000n));
        expect(tx.feePayer).toBe(feePayer.address);
        expect(tx.signers[0]).toBe(feePayer.address);
        expect(tx.signers).toHaveLength(2);
        expect(tx.signers).toEqual(expect.arrayContaining([feePayer.address, payer.address]));
        expect(tx.tokenAccounts.get(payerAta)).toEqual({
            owner: payer.address,
            pre: 100_000n,
            post: 94_000n,
        });
        expect(tx.tokenAccounts.get(DEPOSIT_ATA)).toEqual({
            owner: DEPOSIT,
            pre: 0n,
            post: 6_000n,
        });
        expect(tx.tokenAccounts.size).toBe(2);
    });

    it("an account created in the transaction has pre null", async () => {
        const tx = await readTx(await send(6_000n, { createDestinationFor: DEPOSIT }));
        expect(tx.tokenAccounts.get(DEPOSIT_ATA)!.pre).toBeNull();
        expect(tx.tokenAccounts.get(DEPOSIT_ATA)).toEqual({
            owner: DEPOSIT,
            pre: null,
            post: 6_000n,
        });
    });

    it("entries of other mints are left out", async () => {
        chain.setTokenAccount({ address: DEPOSIT_ATA, owner: DEPOSIT, amount: 0n });
        const sig = await send(6_000n);
        const raw = await rawTx(sig);
        const edited = editBalances(
            raw,
            (l) => [...l, addedEntry({ mint: WRAPPED_SOL, programId: TOKEN_PROGRAM, amount: "0" })],
            (l) => [...l, addedEntry({ mint: WRAPPED_SOL, programId: TOKEN_PROGRAM, amount: "5" })],
        );
        const tx = parseChainTx(sig, raw.slot, edited, hot);
        expect(tx.tokenAccounts.has(feePayer.address)).toBe(false);
        expect([...tx.tokenAccounts.keys()].sort()).toEqual([payerAta, DEPOSIT_ATA].sort());
        expect(usdcDeltaFor(edited, feePayer.address)).toBe(0n);
    });

    it("entries under another token program are left out", async () => {
        chain.setTokenAccount({ address: DEPOSIT_ATA, owner: DEPOSIT, amount: 0n });
        const sig = await send(6_000n);
        const raw = await rawTx(sig);
        const edited = editBalances(
            raw,
            (l) => [...l, addedEntry({ mint: USDC_MINT, programId: TOKEN_2022, amount: "0" })],
            (l) => [...l, addedEntry({ mint: USDC_MINT, programId: TOKEN_2022, amount: "5" })],
        );
        const tx = parseChainTx(sig, raw.slot, edited, hot);
        expect(tx.tokenAccounts.has(feePayer.address)).toBe(false);
        expect(tx.tokenAccounts.size).toBe(2);
        expect(usdcDeltaFor(edited, feePayer.address)).toBe(0n);
    });

    it("an owner that changes inside the transaction is null", async () => {
        chain.setTokenAccount({ address: DEPOSIT_ATA, owner: DEPOSIT, amount: 0n });
        const sig = await send(6_000n);
        const raw = await rawTx(sig);
        const edited = editBalances(
            raw,
            (l) => [...l],
            (l) => l.map((e) => (e.owner === payer.address ? { ...e, owner: seller.address } : e)),
        );
        const tx = parseChainTx(sig, raw.slot, edited, hot);
        expect(tx.tokenAccounts.get(payerAta)).toEqual({
            owner: null,
            pre: 100_000n,
            post: 94_000n,
        });
        expect(usdcDeltaFor(edited, payer.address)).toBe(-100_000n);
        expect(usdcDeltaFor(edited, seller.address)).toBe(94_000n);
    });

    it("usdcDeltaFor reads an undecodable transaction", async () => {
        chain.setTokenAccount({ address: DEPOSIT_ATA, owner: DEPOSIT, amount: 0n });
        const sig = await send(5_000n);
        chain.undecodable(sig);
        const raw = await rawTx(sig);
        expect(() => parseChainTx(sig, raw.slot, raw, hot)).toThrow();
        expect(usdcDeltaFor(raw, DEPOSIT)).toBe(5_000n);
        expect(usdcDeltaFor(raw, payer.address)).toBe(-5_000n);
        expect(usdcDeltaFor(raw, seller.address)).toBe(0n);

        chain.badAnswer(sig, 1, { meta: "null" });
        expect(usdcDeltaFor(await rawTx(sig), DEPOSIT)).toBeNull();
        const noArrays = { ...raw, meta: { ...raw.meta, preTokenBalances: undefined } };
        expect(usdcDeltaFor(noArrays, DEPOSIT)).toBeNull();
        expect(usdcDeltaFor(null, DEPOSIT)).toBeNull();
    });
});

describe("storeAndMatch: payments", () => {
    it("a payment match confirms by our signature, the message hash and exact amounts (R5)", async () => {
        const p = await landPayment(chain, db.pool, {});
        const row = await signedRow(db.pool, {
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
        });
        const tx = await readTx(p.txSignature);
        expect(await match(tx)).toBe("payment");
        expect(await paymentRow(row.id)).toMatchObject({
            state: "confirmed",
            landedSlot: tx.slot,
            txSignature: p.txSignature,
        });
        expect(await findAccount(db.pool, row.accountId)).toMatchObject({
            spentMicros: 10_000,
            heldMicros: 0,
        });
        expect(await resolvedRows()).toEqual([
            expect.objectContaining({
                ref: row.ref,
                payload: expect.objectContaining({ status: "paid", tx: p.txSignature }),
            }),
        ]);
        expect(await chainRow(p.txSignature)).toMatchObject({
            matched: "payment",
            matched_id: row.id,
            failed: false,
            delta_micros: "-10000",
        });
    });

    it("found with an error becomes failed_onchain", async () => {
        chain.failNext();
        const p = await landPayment(chain, db.pool, {});
        const row = await signedRow(db.pool, {
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
        });
        expect(await match(await readTx(p.txSignature))).toBe("payment");
        expect((await paymentRow(row.id)).state).toBe("failed_onchain");
        expect(await findAccount(db.pool, row.accountId)).toMatchObject({
            spentMicros: 0,
            heldMicros: 0,
        });
        expect((await resolvedRows())[0]!.payload).toMatchObject({ status: "released", tx: "" });
        expect(await incidents()).toEqual([]);
    });

    it("a failed R5 check is an unknown change", async () => {
        const p = await landPayment(chain, db.pool, { amount: 10_001n });
        const row = await signedRow(db.pool, {
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
        });
        expect(await match(await readTx(p.txSignature))).toBe("unknown");
        expect((await paymentRow(row.id)).state).toBe("signed");
        expect(await incidents()).toEqual([
            expect.objectContaining({
                kind: "unknown_change",
                subject: p.txSignature,
                loss_micros: "10001",
                payment_id: row.id,
            }),
        ]);
        expect((await readControls(db.pool)).paused).toBe(true);
    });

    it("a row that fails R5 is not released by a later expiry", async () => {
        const p = await landPayment(chain, db.pool, { amount: 10_001n });
        const row = await signedRow(db.pool, {
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
            lastValidBlockHeight: 1_200n,
        });
        await match(await readTx(p.txSignature));
        await applyExpiry(
            db.pool,
            chain.rpc,
            { h0: 1_201n, c0: 1_000n, verifiedSlot: 1_000n },
            deps,
        );
        const run = { h0: 1_400n, c0: 1_300n, verifiedSlot: 1_300n };
        expect(await applyExpiry(db.pool, chain.rpc, run, deps)).toEqual({ seen: 0, expired: 0 });
        expect((await paymentRow(row.id)).state).toBe("signed");
    });

    it("memo collisions never match", async () => {
        const memo = new TextEncoder().encode("abc");
        const p1 = await landPayment(chain, db.pool, { memo });
        const p2 = await landPayment(chain, db.pool, { memo, amount: 20_000n, land: false });
        const r1 = await signedRow(db.pool, {
            ourSignatureSha256: p1.ourHash,
            messageHash: p1.messageHash,
        });
        const r2 = await signedRow(db.pool, {
            ourSignatureSha256: p2.ourHash,
            messageHash: p2.messageHash,
            amountMicros: 20_000,
        });
        await match(await readTx(p1.txSignature));
        expect((await paymentRow(r1.id)).state).toBe("confirmed");
        expect((await paymentRow(r2.id)).state).toBe("signed");
    });

    it("a late landing is confirmed, not charged, and an incident", async () => {
        const p = await landPayment(chain, db.pool, {});
        const row = await signedRow(db.pool, {
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
            state: "expired_unlanded",
        });
        expect(await dayMicros("x402_outflow_days", DAY)).toBe(0);
        expect(await match(await readTx(p.txSignature))).toBe("payment");
        expect(await paymentRow(row.id)).toMatchObject({ state: "confirmed", lateLanded: true });
        expect(await findAccount(db.pool, row.accountId)).toMatchObject({
            spentMicros: 0,
            heldMicros: 0,
        });
        expect(await dayMicros("x402_outflow_days", DAY)).toBe(10_000);
        expect(await dayMicros("x402_payto_days", DAY)).toBe(10_000);
        expect(await incidents()).toEqual([
            expect.objectContaining({
                kind: "late_landing",
                loss_micros: "10000",
                payment_id: row.id,
                detail: expect.objectContaining({ deltaMicros: "-10000" }),
            }),
        ]);
        expect(await resolvedRows()).toEqual([]);
    });

    it("a late landing of an unlisted payee also counts the unlisted day", async () => {
        const p = await landPayment(chain, db.pool, {});
        await signedRow(db.pool, {
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
            state: "expired_unlanded",
            listed: "unlisted",
        });
        await db.pool.query("insert into x402_unlisted_days (day, micros) values ($1::date, 0)", [
            DAY,
        ]);
        await match(await readTx(p.txSignature));
        expect(await dayMicros("x402_unlisted_days", DAY)).toBe(10_000);
    });
});

describe("storeAndMatch: orders", () => {
    it("an order inflow stores payments.landed_slot", async () => {
        const s = chain.credit(hot, 1_013_000n);
        const order = await hotOrderPaidWith(db.pool, s);
        const tx = await readTx(s);
        expect(await match(tx)).toBe("order");
        expect((await findPaymentByOrder(db.pool, order.id))!.landedSlot).toBe(tx.slot);
        expect(await chainRow(s)).toMatchObject({ matched: "order", matched_id: order.id });
    });

    it("a late order inflow", async () => {
        const s = chain.credit(hot, 1_013_000n);
        const order = await hotOrderWithFailedPayment(s);
        expect(await match(await readTx(s))).toBe("order");
        expect(alarms("inflow_mismatch")).toEqual([expect.objectContaining({ orderId: order.id })]);
    });
});

describe("storeAndMatch: refunds and cold transfers", () => {
    it("a refund landing records landed_slot and confirms through the one path", async () => {
        const dest = await usdcAta(address(TEST_PAYTO));
        const s = await chain.transfer({
            authority: allowance,
            feePayer,
            source: hot,
            destination: dest,
            micros: 300_000n,
            memo: "bugnet-refund 1",
        });
        const r = await allowanceRefund({
            amountMicros: 300_000,
            destination: dest,
            state: "sent",
            txSignature: s,
        });
        const tx = await readTx(s);
        expect(await match(tx)).toBe("refund");
        expect(await findRefundById(db.pool, r.id)).toMatchObject({
            state: "confirmed",
            landedSlot: tx.slot,
        });
        expect(await chainRow(s)).toMatchObject({ matched: "refund", matched_id: String(r.id) });
    });

    it("a refund transaction with meta.err is recorded and blocks nothing", async () => {
        chain.failNext();
        const s = await chain.transfer({
            authority: allowance,
            feePayer,
            source: hot,
            destination: payToAta,
            micros: 300_000n,
        });
        const r = await allowanceRefund({
            amountMicros: 300_000,
            destination: payToAta,
            state: "sent",
            txSignature: s,
            expirySeenSlot: 1_000n,
        });
        expect(await match(await readTx(s))).toBe("refund");
        expect((await findRefundById(db.pool, r.id))!.state).toBe("sent");
        expect(await chainRow(s)).toMatchObject({ failed: true });
        expect(
            await resignProof(
                db.pool,
                chain.rpc,
                { signatures: [s], expirySeenSlot: 1_000n },
                x402,
                2_000,
            ),
        ).toBe("absent");
        expect(await incidents()).toEqual([]);
    });

    it("a second landed transaction for one refund is double_transfer", async () => {
        const send = () =>
            chain.transfer({
                authority: allowance,
                feePayer,
                source: hot,
                destination: payToAta,
                micros: 300_000n,
                memo: "bugnet-refund 1",
            });
        const s1 = await send();
        chain.advance(1);
        const s2 = await send();
        const r = await allowanceRefund({
            amountMicros: 300_000,
            destination: payToAta,
            state: "sent",
            txSignature: s2,
            previousSignatures: [s1],
        });
        expect(await match(await readTx(s1))).toBe("refund");
        expect(await match(await readTx(s2))).toBe("refund");
        expect(await incidents()).toEqual([
            expect.objectContaining({
                kind: "double_transfer",
                loss_micros: "300000",
                refund_id: String(r.id),
            }),
        ]);
    });

    it("a refund that moved another amount is an unknown change and stays sent", async () => {
        const s = await chain.transfer({
            authority: allowance,
            feePayer,
            source: hot,
            destination: payToAta,
            micros: 200_000n,
        });
        const r = await allowanceRefund({
            amountMicros: 300_000,
            destination: payToAta,
            state: "sent",
            txSignature: s,
        });
        expect(await match(await readTx(s))).toBe("unknown");
        expect((await findRefundById(db.pool, r.id))!.state).toBe("sent");
        expect(await incidents()).toEqual([
            expect.objectContaining({
                kind: "unknown_change",
                loss_micros: "200000",
                refund_id: String(r.id),
            }),
        ]);
    });

    it("a transfer to cold landing confirms it", async () => {
        const s = await chain.transfer({
            authority: allowance,
            feePayer,
            source: hot,
            destination: cold,
            micros: 20_000n,
            memo: "bugnet-cold 1",
        });
        const id = await coldRow({ amountMicros: 20_000, state: "sent", txSignature: s });
        const tx = await readTx(s);
        expect(await match(tx)).toBe("cold_transfer");
        expect(
            (
                await db.pool.query(
                    "select state, landed_slot from x402_cold_transfers where id = $1",
                    [id],
                )
            ).rows[0],
        ).toEqual({ state: "confirmed", landed_slot: String(tx.slot) });
    });

    it("confirmColdTransfer swaps in the landed signature and confirms only signed or sent", async () => {
        const id = await coldRow({ amountMicros: 20_000, state: "signed", txSignature: "sigA" });
        const landed = { slot: 7n, signature: "sigB" };
        const confirm = () => withTx(db.pool, (c) => confirmColdTransfer(c, id, landed, NOW));
        expect(await confirm()).toBe(true);
        expect(
            (
                await db.pool.query(
                    "select state, tx_signature, previous_signatures from x402_cold_transfers where id = $1",
                    [id],
                )
            ).rows[0],
        ).toEqual({ state: "confirmed", tx_signature: "sigB", previous_signatures: ["sigA"] });
        expect(await confirm()).toBe(false);
    });
});

describe("storeAndMatch: unmatched changes", () => {
    it("no_effect: an error with zero delta", async () => {
        chain.failNext();
        const s = chain.credit(hot, 5_000n);
        expect(await match(await readTx(s))).toBe("no_effect");
    });

    it("dust under refund_min_micros is silent; 10_000 or more fires inflow_mismatch", async () => {
        expect(await match(await readTx(chain.credit(hot, 9_999n)))).toBe("inflow");
        expect(alarms("inflow_mismatch")).toHaveLength(0);
        expect(await match(await readTx(chain.credit(hot, 10_000n)))).toBe("inflow");
        expect(alarms("inflow_mismatch")).toHaveLength(1);
    });

    it("a zero-amount credit into the hot account is no_effect: no incident, no pause", async () => {
        const s = chain.credit(hot, 0n);
        expect(await match(await readTx(s))).toBe("no_effect");
        expect(await chainRow(s)).toMatchObject({ matched: "no_effect", delta_micros: "0" });
        expect(await incidents()).toEqual([]);
        expect((await readControls(db.pool)).paused).toBe(false);
        expect(alarms("inflow_mismatch")).toHaveLength(0);
        expect(
            log.lines.filter((l) => l.level === "info" && String(l.msg).includes("zero-amount")),
        ).toHaveLength(1);
    });

    it("a positive unsolicited inflow stays an inflow", async () => {
        expect(await match(await readTx(chain.credit(hot, 5_000n)))).toBe("inflow");
        expect(await incidents()).toEqual([]);
    });

    it("inflow_mismatch fires only after the transaction committed", async () => {
        const tx = await readTx(chain.credit(hot, 10_000n));
        const afterCommit: (() => void)[] = [];
        await withTx(db.pool, async (c) => {
            await storeAndMatch(c, tx, deps, afterCommit);
            expect(alarms("inflow_mismatch")).toHaveLength(0);
        });
        expect(afterCommit).toHaveLength(1);
        expect(alarms("inflow_mismatch")).toHaveLength(0);
        afterCommit[0]!();
        expect(alarms("inflow_mismatch")).toHaveLength(1);
    });

    it("a debit that matches nothing pauses at once", async () => {
        const s = chain.debit(hot, 5_000n);
        expect(await match(await readTx(s))).toBe("unknown");
        expect(await incidents()).toEqual([
            expect.objectContaining({ kind: "unknown_change", loss_micros: "5000" }),
        ]);
        expect((await readControls(db.pool)).paused).toBe(true);
    });

    it("an Approve on the account pauses", async () => {
        expect(await match(await readTx(chain.approve(hot, TEST_PAYTO)))).toBe("unknown");
        expect(await incidents()).toEqual([
            expect.objectContaining({ kind: "unknown_change", loss_micros: "0" }),
        ]);
    });

    it("storing the same transaction twice changes nothing", async () => {
        const tx = await readTx(chain.credit(hot, 10_000n));
        await match(tx);
        expect(await match(tx)).toBe("inflow");
        expect(alarms("inflow_mismatch")).toHaveLength(1);
        expect(
            (
                await db.pool.query("select 1 from x402_chain_txs where signature = $1", [
                    tx.signature,
                ])
            ).rowCount,
        ).toBe(1);
    });
});

describe("applyExpiry", () => {
    it("expires only after the height passed, the mirror verified through expiry_seen_slot + 300 and nothing found", async () => {
        const row = await signedRow(db.pool, { lastValidBlockHeight: 1_200n });
        expect(
            await applyExpiry(
                db.pool,
                chain.rpc,
                { h0: 1_201n, c0: 1_000n, verifiedSlot: 1_000n },
                deps,
            ),
        ).toEqual({ seen: 1, expired: 0 });
        expect(await paymentRow(row.id)).toMatchObject({ state: "signed", expirySeenSlot: 1_000n });
        await applyExpiry(
            db.pool,
            chain.rpc,
            { h0: 1_300n, c0: 1_100n, verifiedSlot: 1_299n },
            deps,
        );
        expect(await paymentRow(row.id)).toMatchObject({ state: "signed", expirySeenSlot: 1_000n });
        expect(
            await applyExpiry(
                db.pool,
                chain.rpc,
                { h0: 1_400n, c0: 1_300n, verifiedSlot: 1_300n },
                deps,
            ),
        ).toEqual({ seen: 0, expired: 1 });
        expect((await paymentRow(row.id)).state).toBe("expired_unlanded");
        expect(await findAccount(db.pool, row.accountId)).toMatchObject({
            heldMicros: 0,
            spentMicros: 0,
        });
        expect(await dayMicros("x402_outflow_days", DAY)).toBe(0);
        expect((await resolvedRows())[0]!.payload).toMatchObject({ status: "released", tx: "" });
    });

    it("a signed payment whose signature belongs to another stored transaction alarms once", async () => {
        const sig = "3".repeat(63) + "4";
        await db.pool.query(
            `insert into x402_chain_txs (signature, slot, delta_micros, failed, matched, matched_id)
             values ($1, 5, 0, false, 'no_effect', null)`,
            [sig],
        );
        const row = await signedRow(db.pool, {
            lastValidBlockHeight: 1_200n,
            txSignature: sig,
            landedSlot: 5n,
        });
        const run = { h0: 2_000n, c0: 1_000n, verifiedSlot: FAR };
        await applyExpiry(db.pool, chain.rpc, run, deps);
        await applyExpiry(db.pool, chain.rpc, run, deps);
        expect(alarms("x402_incident")).toEqual([
            expect.objectContaining({ kind: "unknown_change", paymentId: row.id }),
        ]);
        expect((await paymentRow(row.id)).state).toBe("signed");
    });

    it("a hint failure row is never released by applyExpiry", async () => {
        const row = await signedRow(db.pool, { lastValidBlockHeight: 10_000n, hint: "failure" });
        const run = { h0: 2_000n, c0: 2_000n, verifiedSlot: 5_000n };
        expect(await applyExpiry(db.pool, chain.rpc, run, deps)).toEqual({ seen: 0, expired: 0 });
        expect(await paymentRow(row.id)).toMatchObject({ state: "signed", hint: "failure" });
    });

    it("never marks a payment whose height has not passed", async () => {
        const row = await signedRow(db.pool, { lastValidBlockHeight: 1_200n });
        expect(
            await applyExpiry(
                db.pool,
                chain.rpc,
                { h0: 1_200n, c0: 1_000n, verifiedSlot: FAR },
                deps,
            ),
        ).toEqual({ seen: 0, expired: 0 });
        expect((await paymentRow(row.id)).expirySeenSlot).toBeNull();
    });

    it("hot refunds and cold transfers get expiry_seen_slot and never expire here", async () => {
        const refund = await allowanceRefund({
            amountMicros: 300_000,
            destination: payToAta,
            state: "sent",
            txSignature: "1".repeat(63) + "2",
            lastValidBlockHeight: 1_200n,
        });
        const coldId = await coldRow({
            amountMicros: 20_000,
            state: "signed",
            txSignature: "cold-sig",
            lastValidBlockHeight: 1_200n,
        });
        expect(
            await applyExpiry(
                db.pool,
                chain.rpc,
                { h0: 1_201n, c0: 1_000n, verifiedSlot: 2_000n },
                deps,
            ),
        ).toEqual({ seen: 2, expired: 0 });
        const refundRow = await findRefundById(db.pool, refund.id);
        expect(refundRow).toMatchObject({ state: "sent", expirySeenSlot: 1_000n });
        const coldRowNow = (
            await db.pool.query(
                "select state, expiry_seen_slot from x402_cold_transfers where id = $1",
                [coldId],
            )
        ).rows[0];
        expect(coldRowNow).toEqual({ state: "signed", expiry_seen_slot: "1000" });
    });

    it("a row with landed_slot expires only on a dropped block", async () => {
        const statuses = (slot: bigint) => () => ({ context: { slot }, value: [null] });
        const row = await signedRow(db.pool, {
            lastValidBlockHeight: 1_200n,
            landedSlot: 1_050n,
            txSignature: "1".repeat(63) + "2",
            expirySeenSlot: 1_000n,
        });
        const run = { h0: 1_400n, c0: 1_300n, verifiedSlot: 1_400n };
        await applyExpiry(
            db.pool,
            createFakeRpc({ getSignatureStatuses: statuses(1_349n) }),
            run,
            deps,
        );
        expect(await paymentRow(row.id)).toMatchObject({ state: "signed", landedSlot: 1_050n });
        await applyExpiry(
            db.pool,
            createFakeRpc({ getSignatureStatuses: statuses(1_350n) }),
            run,
            deps,
        );
        expect(await paymentRow(row.id)).toMatchObject({
            state: "expired_unlanded",
            landedSlot: null,
            txSignature: null,
        });
    });

    it("a row with landed_slot whose transaction is found is matched, not expired", async () => {
        const p = await landPayment(chain, db.pool, {});
        const row = await signedRow(db.pool, {
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
            lastValidBlockHeight: 1_200n,
            landedSlot: 1_000n,
            txSignature: p.txSignature,
            expirySeenSlot: 1_000n,
        });
        chain.finalize();
        const run = { h0: 1_400n, c0: 1_300n, verifiedSlot: 1_400n };
        expect(await applyExpiry(db.pool, chain.rpc, run, deps)).toEqual({ seen: 0, expired: 0 });
        expect((await paymentRow(row.id)).state).toBe("confirmed");
    });

    it("an RPC error leaves a landed row signed", async () => {
        const row = await signedRow(db.pool, {
            lastValidBlockHeight: 1_200n,
            landedSlot: 1_050n,
            txSignature: "1".repeat(63) + "2",
            expirySeenSlot: 1_000n,
        });
        const broken = createFakeRpc({
            getTransaction: () => {
                throw new Error("rpc down");
            },
        });
        const run = { h0: 1_400n, c0: 1_300n, verifiedSlot: 1_400n };
        expect(await applyExpiry(db.pool, broken, run, deps)).toEqual({ seen: 0, expired: 0 });
        expect((await paymentRow(row.id)).state).toBe("signed");
    });
});

describe("alarmUnresolved", () => {
    it("fires for a signed row 10 minutes after signing, once", async () => {
        const old = await signedRow(db.pool, { signedAt: new Date(NOW.getTime() - 600_001) });
        await signedRow(db.pool, { signedAt: new Date(NOW.getTime() - 599_000) });
        expect(await alarmUnresolved(db.pool, deps)).toBe(1);
        expect(await alarmUnresolved(db.pool, deps)).toBe(0);
        expect(alarms("x402_unresolved")).toEqual([expect.objectContaining({ paymentId: old.id })]);
    });
});
