import { randomBytes } from "node:crypto";
import {
    type Address,
    getBase58Decoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getSignatureFromTransaction,
    getTransactionDecoder,
    type KeyPairSigner,
} from "@solana/kit";
import {
    getSetComputeUnitLimitInstructionDataDecoder,
    getSetComputeUnitPriceInstructionDataDecoder,
} from "@solana-program/compute-budget";
import { getTransferCheckedInstructionDataDecoder } from "@solana-program/token";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { memoryLog } from "../log.ts";
import { findOrder } from "../orders/store.ts";
import type { RouterClient } from "../router/client.ts";
import type { OrderRow } from "../orders/types.ts";
import { usdcAta } from "../solana/accounts.ts";
import { MEMO_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "../solana/constants.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import {
    createFakeRpc,
    type FakeRpc,
    type FakeRpcScript,
    neverAnswers,
    epochAt,
    TEST_BLOCKHASH,
    TEST_LVBH,
} from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { heldRefundId, seedHeldTransfer } from "../testing/deposits.ts";
import { seedOrder, seedPayment, seedSharedPayment, type TestShare } from "../testing/orders.ts";
import { seedAccount, seedFunding } from "../testing/x402.ts";
import { setControls } from "../x402/controls.ts";
import { runCloseJob } from "../x402/close.ts";
import { createAllowanceFunding } from "../x402/funding.ts";
import { findAccount, readPool } from "../x402/ledger.ts";
import { type ChainTx, type MatchDeps, matchInTx } from "../x402/match.ts";
import {
    buildRefundTransaction,
    pauseRefunds,
    type RefundDeps,
    refundsPaused,
    resumeRefunds,
    runRefunds,
} from "./executor.ts";
import {
    findOrderRefund,
    findRefund,
    findRefundById,
    refundGroup,
    type RefundKind,
    type RefundRow,
    requestRefund,
} from "./request.ts";
import { insertDepositRefund } from "./split.ts";

const T0 = new Date("2030-01-01T12:00:00Z");
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const FRESH_BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(2));
const STALL_MS = 100;

let db: TestDb;
let feePayer: KeyPairSigner;
let refundSigner: KeyPairSigner;
let payer: KeyPairSigner;
let SOURCE: Address;
let allowance: KeyPairSigner;
let HOT: Address;
let defaults: Settings["refunds"];
let x402Defaults: Settings["x402"];
let ordersDefaults: Settings["orders"];
let rpcTimeoutMs: number;
let log: ReturnType<typeof memoryLog>;

beforeAll(async () => {
    db = await testDb();
    feePayer = await testSigner(4);
    refundSigner = await testSigner(5);
    payer = await testSigner(6);
    allowance = await testSigner(7);
    HOT = await usdcAta(allowance.address);
    SOURCE = await usdcAta(payer.address);
    const recipient = (await testSigner(1)).address;
    const settings = parseSettings(stringify({ solana: { recipient } }), "test");
    defaults = settings.refunds;
    x402Defaults = settings.x402;
    ordersDefaults = settings.orders;
    rpcTimeoutMs = settings.solana.rpc_timeout;
});
afterAll(async () => {
    await db.close();
});
// The executor scans every refund, so each test starts from an empty table and running refunds
beforeEach(async () => {
    await db.pool.query("truncate orders cascade");
    await db.pool.query("truncate x402_refund_days, x402_chain_txs");
    await db.pool.query("update x402_pool set committed_micros = 0, unpaid_micros = 0");
    await db.pool.query(
        "update x402_controls set disabled = false, paused = false, refunds_held = false",
    );
    await db.pool.query("update x402_tail set verified_slot = 0");
    await resumeRefunds(db.pool);
    log = memoryLog();
});

function later(ms: number): Date {
    return new Date(T0.getTime() + ms);
}

function deps(rpc: FakeRpc, at: Date = T0, cfg: Partial<Settings["refunds"]> = {}): RefundDeps {
    return {
        pool: db.pool,
        rpc,
        feePayer,
        refundSigner,
        allowanceSigner: allowance,
        x402: x402Defaults,
        hotTokenAccount: HOT,
        cfg: { ...defaults, ...cfg },
        rpcTimeoutMs,
        log,
        now: () => at,
    };
}

function tokenAccount(over: { state?: string; owner?: string; mint?: string; program?: string }) {
    return {
        value: {
            owner: over.program ?? TOKEN_PROGRAM,
            lamports: 2_039_280n,
            executable: false,
            rentEpoch: 0n,
            space: 165n,
            data: {
                program: "spl-token",
                space: 165n,
                parsed: {
                    type: "account",
                    info: {
                        mint: over.mint ?? USDC_MINT,
                        owner: over.owner ?? payer.address,
                        state: over.state ?? "initialized",
                        isNative: false,
                        tokenAmount: {
                            amount: "0",
                            decimals: 6,
                            uiAmount: 0,
                            uiAmountString: "0",
                        },
                    },
                },
            },
        },
    };
}

function okRpc(script: Partial<FakeRpcScript> = {}): FakeRpc {
    return createFakeRpc({ getAccountInfo: () => tokenAccount({}), ...script });
}

const notFound = () => ({ value: [null] });
const CONFIRMED = { confirmationStatus: "confirmed", err: null, slot: 1n, confirmations: 1n };
const LANDED_FAILED = {
    confirmationStatus: "confirmed",
    err: { InstructionError: [2, { Custom: 1 }] },
    slot: 1n,
};

function usdcBalance(micros: number) {
    return {
        value: { amount: String(micros), decimals: 6, uiAmount: micros / 1e6, uiAmountString: "" },
    };
}

// Holds each caller until n have arrived or ms passed, so racing runners overlap when they can
function meetOrTimeOut<T>(n: number, ms: number, answer: () => T): () => Promise<T> {
    let arrived = 0;
    let open = () => {};
    const met = new Promise<void>((resolve) => {
        open = resolve;
    });
    return async () => {
        arrived++;
        if (arrived === n) open();
        await Promise.race([met, new Promise((resolve) => setTimeout(resolve, ms))]);
        return answer();
    };
}

function signatureOf(wire: string): string {
    return getSignatureFromTransaction(
        getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
    );
}

function sendRecorder(): {
    sends: { wire: string; config: unknown }[];
    sendTransaction: (wire: string, config: unknown) => string;
} {
    const sends: { wire: string; config: unknown }[] = [];
    return {
        sends,
        sendTransaction: (wire, config) => {
            sends.push({ wire, config });
            return signatureOf(wire);
        },
    };
}

function decodeMessage(wire: string) {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (msg.version !== 0) throw new Error(`expected a v0 message, got ${msg.version}`);
    return msg;
}

type Message = ReturnType<typeof decodeMessage>;

function programsOf(msg: Message): (string | undefined)[] {
    return msg.instructions.map((i) => msg.staticAccounts[i.programAddressIndex]);
}

function transferOf(msg: Message) {
    const ix = msg.instructions.find(
        (i) => msg.staticAccounts[i.programAddressIndex] === TOKEN_PROGRAM,
    )!;
    const [source, mint, destination, authority] = ix.accountIndices!.map(
        (n) => msg.staticAccounts[n],
    );
    const data = getTransferCheckedInstructionDataDecoder().decode(ix.data!);
    return { source, mint, destination, authority, amount: data.amount, decimals: data.decimals };
}

function alarms(name: string): Record<string, unknown>[] {
    return log.lines.filter((l) => l.alarm === name);
}

function levels(level: string): Record<string, unknown>[] {
    return log.lines.filter((l) => l.level === level);
}

async function pendingRefund(amountMicros = 10_000): Promise<OrderRow> {
    const { order } = await seedOrder(db.pool, {
        state: "paid",
        amountMicros,
        payer: payer.address,
    });
    await seedPayment(db.pool, order.id, {
        status: "confirmed",
        payer: payer.address,
        sourceTokenAccount: SOURCE,
    });
    expect(await requestRefund(db.pool, order.id, "unredeemed")).toBe("created");
    return order;
}

async function sentRefund(
    cfg: Partial<Settings["refunds"]> = {},
): Promise<{ order: OrderRow; refund: RefundRow }> {
    const order = await pendingRefund();
    expect((await runRefunds(deps(okRpc(), T0, cfg), "refund")).sent).toBe(1);
    const refund = (await findOrderRefund(db.pool, order.id))!;
    expect(refund).toMatchObject({ state: "sent", attempts: 1, sentAt: T0 });
    return { order, refund };
}

describe("buildRefundTransaction", () => {
    it("builds a two-signature TransferChecked to the payment source, nothing else", async () => {
        const d = deps(okRpc());
        const hint = { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: TEST_LVBH };
        const built = await buildRefundTransaction(
            d,
            { destination: SOURCE, amountMicros: 10_000, source: refundSigner, memo: null },
            hint,
        );
        const msg = decodeMessage(built.wire);
        expect(msg.version).toBe(0);
        expect(msg.staticAccounts[0]).toBe(d.feePayer.address);
        expect(msg.header.numSignerAccounts).toBe(2);
        expect(msg.lifetimeToken).toBe(TEST_BLOCKHASH);
        expect(programsOf(msg)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, TOKEN_PROGRAM]);
        expect(transferOf(msg)).toMatchObject({
            source: await usdcAta(refundSigner.address),
            mint: USDC_MINT,
            destination: SOURCE,
            authority: refundSigner.address,
            amount: 10_000n,
            decimals: 6,
        });
        const [limit, price] = msg.instructions;
        expect(getSetComputeUnitLimitInstructionDataDecoder().decode(limit!.data!).units).toBe(
            20_000,
        );
        expect(
            getSetComputeUnitPriceInstructionDataDecoder().decode(price!.data!).microLamports,
        ).toBe(10_000n);
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(built.wire));
        expect(Object.keys(tx.signatures).sort()).toEqual(
            [feePayer.address, refundSigner.address].sort(),
        );
        expect(Object.values(tx.signatures).every((s) => s !== null)).toBe(true);
        expect(built.signature).toBe(signatureOf(built.wire));
        expect(built.lastValidBlockHeight).toBe(TEST_LVBH);
    });
});

describe("runRefunds", () => {
    it("persists the signed refund before sending it", async () => {
        const order = await pendingRefund();
        const rpc = createFakeRpc({
            getAccountInfo: () => tokenAccount({}),
            sendTransaction: async (wire: string, config: unknown) => {
                const row = (await findOrderRefund(db.pool, order.id))!;
                expect(row).toMatchObject({
                    state: "signed",
                    wireTx: wire,
                    signedAt: T0,
                    sentAt: null,
                    attempts: 1,
                    lastValidBlockHeight: TEST_LVBH,
                });
                expect(config).toEqual({ encoding: "base64", preflightCommitment: "confirmed" });
                return row.txSignature;
            },
        });
        const tick = await runRefunds(deps(rpc), "refund");
        expect(tick).toEqual({
            sent: 1,
            resent: 0,
            resigned: 0,
            confirmed: 0,
            manual: 0,
            paused: null,
        });
        const row = (await findOrderRefund(db.pool, order.id))!;
        expect(row).toMatchObject({ state: "sent", sentAt: T0 });
        expect(row.txSignature).toBe(signatureOf(row.wireTx!));
        expect(rpc.calls.sendTransaction).toBe(1);
    });

    it("takes the refund in the same tick after a deadlock re-run", async () => {
        const order = await pendingRefund();
        let connects = 0;
        const pool = new Proxy(db.pool, {
            get(target, prop) {
                if (prop !== "connect") {
                    const v = Reflect.get(target, prop, target);
                    return typeof v === "function" ? v.bind(target) : v;
                }
                return async () => {
                    const client = await target.connect();
                    if (++connects !== 1) return client;
                    // The first transaction takes the refund row, then deadlocks on its next query
                    let queries = 0;
                    const query = client.query.bind(client) as (...a: unknown[]) => unknown;
                    client.query = ((...a: unknown[]) =>
                        ++queries === 3
                            ? Promise.reject(
                                  Object.assign(new Error("deadlock"), { code: "40P01" }),
                              )
                            : query(...a)) as typeof client.query;
                    return client;
                };
            },
        });
        const rpc = createFakeRpc({ getAccountInfo: () => tokenAccount({}) });
        const tick = await runRefunds({ ...deps(rpc), pool }, "refund");
        expect(tick.sent).toBe(1);
        expect(connects).toBeGreaterThanOrEqual(3);
        expect((await findOrderRefund(db.pool, order.id))!.state).toBe("sent");
    });

    it("confirms and marks the order refunded", async () => {
        const { order } = await sentRefund();
        const tick = await runRefunds(deps(okRpc(), later(30_000)), "refund");
        expect(tick.confirmed).toBe(1);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "confirmed",
            confirmedAt: later(30_000),
        });
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunded");
    });

    it("waits while the refund is only processed", async () => {
        const { order } = await sentRefund();
        const rpc = okRpc({
            getSignatureStatuses: () => ({
                value: [{ confirmationStatus: "processed", err: null, slot: 1n }],
            }),
        });
        await runRefunds(deps(rpc, later(30_000)), "refund");
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "sent",
            attempts: 1,
        });
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
    });

    it("leaves a just-sent refund alone for 20 s", async () => {
        await sentRefund();
        const rpc = okRpc();
        await runRefunds(deps(rpc, later(10_000)), "refund");
        await runRefunds(deps(rpc, later(19_999)), "refund");
        expect(rpc.calls.getSignatureStatuses).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
        await runRefunds(deps(rpc, later(20_000)), "refund");
        expect(rpc.calls.getSignatureStatuses).toBe(1);
    });

    it("resends the same bytes while the blockhash is valid", async () => {
        const { order, refund } = await sentRefund();
        const recorder = sendRecorder();
        const rpc = okRpc({
            getSignatureStatuses: notFound,
            getEpochInfo: () => epochAt(TEST_LVBH),
            sendTransaction: recorder.sendTransaction,
        });
        const tick = await runRefunds(deps(rpc, later(30_000)), "refund");
        expect(tick.resent).toBe(1);
        expect(recorder.sends).toEqual([
            {
                wire: refund.wireTx,
                config: { encoding: "base64", skipPreflight: true, maxRetries: 0n },
            },
        ]);
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "sent",
            attempts: 1,
            txSignature: refund.txSignature,
            sentAt: T0,
            previousSignatures: [],
        });
    });

    it("re-signs only after expiry and not found", async () => {
        const { order, refund: first } = await sentRefund();
        const recorder = sendRecorder();
        const rpc = okRpc({
            getSignatureStatuses: notFound,
            getEpochInfo: () => epochAt(TEST_LVBH + 1n),
            getLatestBlockhash: () => ({
                value: { blockhash: FRESH_BLOCKHASH, lastValidBlockHeight: 2_000n },
            }),
            sendTransaction: recorder.sendTransaction,
        });
        const tick = await runRefunds(deps(rpc, later(30_000)), "refund");
        expect(tick.resigned).toBe(1);
        const after = (await findOrderRefund(db.pool, order.id))!;
        expect(after.txSignature).not.toBe(first.txSignature);
        expect(after.txSignature).toBe(signatureOf(after.wireTx!));
        expect(after).toMatchObject({
            state: "sent",
            attempts: 2,
            previousSignatures: [first.txSignature],
            lastValidBlockHeight: 2_000n,
            signedAt: later(30_000),
            sentAt: later(30_000),
        });
        expect(decodeMessage(after.wireTx!).lifetimeToken).toBe(FRESH_BLOCKHASH);
        expect(recorder.sends).toEqual([
            {
                wire: after.wireTx,
                config: { encoding: "base64", preflightCommitment: "confirmed" },
            },
        ]);
    });

    it("never re-signs a refund that lands between the height and status reads", async () => {
        const { order, refund } = await sentRefund();
        // The refund lands in the last valid block, so a status read before the height sees nothing
        let landed = false;
        const rpc = okRpc({
            getEpochInfo: () => {
                landed = true;
                return epochAt(TEST_LVBH + 1n);
            },
            getSignatureStatuses: () => ({ value: [landed ? CONFIRMED : null] }),
        });
        const tick = await runRefunds(deps(rpc, later(30_000)), "refund");
        expect(tick).toMatchObject({ confirmed: 1, resigned: 0, resent: 0 });
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "confirmed",
            attempts: 1,
            txSignature: refund.txSignature,
            previousSignatures: [],
        });
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunded");
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
    });

    it("confirms rather than signs again when an earlier attempt landed late", async () => {
        const { order, refund: first } = await sentRefund();
        const reads: unknown[] = [];
        let firstLanded = false;
        const rpc = okRpc({
            getSignatureStatuses: (sigs: string[]) => {
                reads.push(sigs);
                return {
                    value: sigs.map((s) =>
                        firstLanded && s === first.txSignature ? CONFIRMED : null,
                    ),
                };
            },
            getEpochInfo: () => epochAt(TEST_LVBH + 1n),
            getLatestBlockhash: () => ({
                value: { blockhash: FRESH_BLOCKHASH, lastValidBlockHeight: 2_000n },
            }),
        });
        expect((await runRefunds(deps(rpc, later(30_000)), "refund")).resigned).toBe(1);
        const second = (await findOrderRefund(db.pool, order.id))!;
        expect(second.previousSignatures).toEqual([first.txSignature]);

        firstLanded = true;
        const tick = await runRefunds(deps(rpc, later(60_000)), "refund");
        expect(tick).toMatchObject({ confirmed: 1, resigned: 0, resent: 0 });
        expect(reads.at(-1)).toEqual([second.txSignature, first.txSignature]);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "confirmed",
            attempts: 2,
            txSignature: first.txSignature,
            previousSignatures: [second.txSignature],
        });
        expect(
            log.lines.filter((l) => l.msg === "refund confirmed").map((l) => l.signature),
        ).toEqual([first.txSignature]);
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunded");
        expect(rpc.calls.getLatestBlockhash).toBe(1);
    });

    it("keeps the signatures that never landed when the second of three attempts lands", async () => {
        const { order, refund: first } = await sentRefund({ max_attempts: 3 });
        let signs = 0;
        let landed: string | null = null;
        const rpc = okRpc({
            getSignatureStatuses: (sigs: string[]) => ({
                value: sigs.map((s) => (s === landed ? CONFIRMED : null)),
            }),
            getEpochInfo: () => epochAt(3_000n),
            getLatestBlockhash: () => ({
                value: {
                    blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(10 + ++signs)),
                    lastValidBlockHeight: 2_000n,
                },
            }),
        });
        await runRefunds(deps(rpc, later(30_000)), "refund");
        const second = (await findOrderRefund(db.pool, order.id))!;
        await runRefunds(deps(rpc, later(60_000)), "refund");
        const third = (await findOrderRefund(db.pool, order.id))!;
        expect(third.previousSignatures).toEqual([first.txSignature, second.txSignature]);

        landed = second.txSignature;
        expect((await runRefunds(deps(rpc, later(90_000)), "refund")).confirmed).toBe(1);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "confirmed",
            attempts: 3,
            txSignature: second.txSignature,
            previousSignatures: [first.txSignature, third.txSignature],
        });
    });

    it("never re-signs on a missing status from a node behind the finalized slot", async () => {
        const { order, refund } = await sentRefund();
        const rpc = okRpc({
            getEpochInfo: () => epochAt(TEST_LVBH + 1n, 10_000n),
            getSignatureStatuses: () => ({ context: { slot: 9_967n }, value: [null] }),
        });
        const tick = await runRefunds(deps(rpc, later(30_000)), "refund");
        expect(tick).toMatchObject({ resigned: 0, resent: 1 });
        expect(rpc.sent).toEqual([refund.wireTx]);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            attempts: 1,
            txSignature: refund.txSignature,
            previousSignatures: [],
        });
        expect(rpc.calls.getLatestBlockhash).toBe(0);
    });

    it("queues a refund that expired max_attempts times for an operator", async () => {
        const { order } = await sentRefund({ max_attempts: 1 });
        const rpc = okRpc({
            getSignatureStatuses: notFound,
            getEpochInfo: () => epochAt(TEST_LVBH + 1n),
        });
        const tick = await runRefunds(deps(rpc, later(30_000), { max_attempts: 1 }), "refund");
        expect(tick.manual).toBe(1);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_expired_repeatedly",
            attempts: 1,
        });
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_expired_repeatedly",
        });
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
        expect(alarms("manual_queue")).toEqual([
            expect.objectContaining({ orderId: order.id, reason: "refund_expired_repeatedly" }),
        ]);
    });

    it("keeps a signed refund whose send failed and resends it on a later tick", async () => {
        const order = await pendingRefund();
        const failing = okRpc({
            sendTransaction: () => {
                throw new Error("503");
            },
        });
        expect((await runRefunds(deps(failing), "refund")).sent).toBe(0);
        const signed = (await findOrderRefund(db.pool, order.id))!;
        expect(signed).toMatchObject({ state: "signed", attempts: 1, sentAt: null });
        expect(alarms("manual_queue")).toEqual([]);

        const rpc = okRpc({
            getSignatureStatuses: notFound,
            getEpochInfo: () => epochAt(TEST_LVBH),
        });
        expect((await runRefunds(deps(rpc, later(30_000)), "refund")).resent).toBe(1);
        expect(rpc.sent).toEqual([signed.wireTx]);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "sent",
            attempts: 1,
            txSignature: signed.txSignature,
            sentAt: later(30_000),
        });
    });

    it("leaves the refund pending on an RPC error", async () => {
        const order = await pendingRefund();
        const rpc = createFakeRpc({
            getAccountInfo: () => {
                throw new Error("429");
            },
        });
        await runRefunds(deps(rpc), "refund");
        expect((await findOrderRefund(db.pool, order.id))!.state).toBe("pending");
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
        expect(log.lines.some((l) => l.level === "alarm")).toBe(false);
        expect(rpc.calls.sendTransaction ?? 0).toBe(0);
        expect(levels("warn")).toEqual([
            expect.objectContaining({
                msg: "refund rpc call failed, retrying next tick",
                orderId: order.id,
                err: { name: "Error", message: "429" },
            }),
        ]);
        expect(levels("error")).toEqual([]);
    });

    it("logs a failure that is not an RPC error at error level", async () => {
        const { order } = await seedOrder(db.pool, { state: "refunding", payer: payer.address });
        await seedPayment(db.pool, order.id, { payer: payer.address, sourceTokenAccount: SOURCE });
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                signed_at)
             values ($1, 'full', 'late', 10000, $2, $3, 'sent', $4)`,
            [order.id, SOURCE, payer.address, later(-60_000)],
        );
        const rpc = okRpc();
        await runRefunds(deps(rpc), "refund");
        expect(levels("error")).toEqual([
            expect.objectContaining({
                msg: "refund step failed, retrying next tick",
                orderId: order.id,
                err: expect.objectContaining({
                    message: expect.stringContaining("without a stored transaction"),
                }),
            }),
        ]);
        expect(levels("warn")).toEqual([]);
        expect(rpc.calls.getSignatureStatuses).toBe(0);
        expect((await findOrderRefund(db.pool, order.id))!.state).toBe("sent");
    });

    it.each(["getTokenAccountBalance", "getLatestBlockhash"] as const)(
        "leaves the refund pending when %s fails",
        async (method) => {
            const order = await pendingRefund();
            const rpc = okRpc({
                [method]: () => {
                    throw new Error("429");
                },
            });
            await runRefunds(deps(rpc), "refund");
            expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
                state: "pending",
                attempts: 0,
                txSignature: null,
            });
            expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
            expect(log.lines.some((l) => l.level === "alarm")).toBe(false);
            expect(rpc.calls.sendTransaction).toBe(0);
        },
    );

    it.each([
        ["getSignatureStatuses", {}],
        ["getEpochInfo", { getSignatureStatuses: notFound }],
    ] as const)("leaves a sent refund unchanged when %s fails", async (method, script) => {
        const { order, refund } = await sentRefund();
        const rpc = okRpc({
            ...script,
            [method]: () => {
                throw new Error("429");
            },
        });
        await runRefunds(deps(rpc, later(30_000)), "refund");
        expect(await findOrderRefund(db.pool, order.id)).toEqual(refund);
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
        expect(log.lines.some((l) => l.level === "alarm")).toBe(false);
        expect(rpc.calls.sendTransaction).toBe(0);
        expect(levels("warn")).toHaveLength(1);
        expect(levels("error")).toEqual([]);
    });

    it("queues a landed failure for an operator", async () => {
        const { order } = await sentRefund();
        const rpc = okRpc({ getSignatureStatuses: () => ({ value: [LANDED_FAILED] }) });
        const tick = await runRefunds(deps(rpc, later(30_000)), "refund");
        expect(tick.manual).toBe(1);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_failed_onchain",
        });
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_failed_onchain",
        });
        expect(rpc.calls.sendTransaction).toBe(0);
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(alarms("manual_queue")).toEqual([
            expect.objectContaining({ orderId: order.id, reason: "refund_failed_onchain" }),
        ]);
    });

    it.each([
        ["closed", () => ({ value: null })],
        ["frozen", () => tokenAccount({ state: "frozen" })],
        ["handed to another owner", () => tokenAccount({ owner: "SomeoneElse" })],
        ["not a USDC account", () => tokenAccount({ mint: TEST_BLOCKHASH })],
        ["owned by another program", () => tokenAccount({ program: COMPUTE_BUDGET })],
    ])("sends nothing when the source account is %s", async (_n, getAccountInfo) => {
        const order = await pendingRefund();
        const rpc = createFakeRpc({ getAccountInfo });
        const tick = await runRefunds(deps(rpc), "refund");
        expect(tick.manual).toBe(1);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_destination_invalid",
        });
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_destination_invalid",
        });
        expect(rpc.calls.sendTransaction ?? 0).toBe(0);
        expect(alarms("manual_queue")).toEqual([
            expect.objectContaining({ orderId: order.id, reason: "refund_destination_invalid" }),
        ]);
    });

    it("sends nothing to a destination that is not an address", async () => {
        const { order } = await seedOrder(db.pool, { state: "refunding", payer: payer.address });
        await seedPayment(db.pool, order.id, { payer: payer.address });
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state)
             values ($1, 'full', 'late', 10000, 'not-an-address', $2, 'pending')`,
            [order.id, payer.address],
        );
        const rpc = okRpc();
        await runRefunds(deps(rpc), "refund");
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_destination_invalid",
        });
        expect(rpc.calls.getAccountInfo).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
    });

    it("queues a refund larger than the daily cap for an operator and keeps refunding", async () => {
        const large = await pendingRefund(25_000);
        const small = await pendingRefund(10_000);
        const rpc = okRpc();
        const tick = await runRefunds(deps(rpc, T0, { daily_cap_micros: 20_000 }), "refund");
        expect(tick).toMatchObject({ sent: 1, manual: 1, paused: null });
        expect(await findOrderRefund(db.pool, large.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_exceeds_cap",
            txSignature: null,
        });
        expect(await findOrder(db.pool, large.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_exceeds_cap",
        });
        expect((await findOrderRefund(db.pool, small.id))!.state).toBe("sent");
        expect(await refundsPaused(db.pool)).toBeNull();
        expect(alarms("manual_queue")).toEqual([
            expect.objectContaining({ orderId: large.id, reason: "refund_exceeds_cap" }),
        ]);
    });

    it("pauses at the daily cap", async () => {
        const yesterday = await pendingRefund(15_000);
        await db.pool.query(
            "update refunds set state = 'confirmed', signed_at = $2 where order_id = $1",
            [yesterday.id, new Date(T0.getTime() - 86_400_000)],
        );
        const first = await pendingRefund(15_000);
        const second = await pendingRefund(15_000);
        const rpc = okRpc();
        const tick = await runRefunds(deps(rpc, T0, { daily_cap_micros: 20_000 }), "refund");
        expect(tick).toMatchObject({ sent: 1, paused: "daily_cap" });
        expect((await findOrderRefund(db.pool, first.id))!.state).toBe("sent");
        expect((await findOrderRefund(db.pool, second.id))!.state).toBe("pending");
        expect(await refundsPaused(db.pool)).toBe("daily_cap");
        expect(alarms("refunds_paused")).toEqual([
            expect.objectContaining({ reason: "daily_cap" }),
        ]);

        const again = await runRefunds(
            deps(rpc, later(60_000), { daily_cap_micros: 20_000 }),
            "refund",
        );
        expect(again).toEqual({
            sent: 0,
            resent: 0,
            resigned: 0,
            confirmed: 1,
            manual: 0,
            paused: "daily_cap",
        });
        expect((await findOrderRefund(db.pool, first.id))!.state).toBe("confirmed");
        expect((await findOrderRefund(db.pool, second.id))!.state).toBe("pending");
        expect(rpc.calls.sendTransaction).toBe(1);
        expect(rpc.calls.getLatestBlockhash).toBe(1);
        expect(alarms("refunds_paused")).toHaveLength(1);
    });

    it.each([
        ["daily cap", { daily_cap_micros: 20_000 }, "daily_cap"],
        ["hourly rate", { max_per_hour: 1 }, "hourly_rate"],
    ] as const)("checks the %s of two racing runners one at a time", async (_n, cfg, reason) => {
        const first = await pendingRefund(15_000);
        const second = await pendingRefund(15_001);
        const rpc = okRpc({ getAccountInfo: meetOrTimeOut(2, 300, () => tokenAccount({})) });
        await Promise.all([
            runRefunds(deps(rpc, T0, cfg), "refund"),
            runRefunds(deps(rpc, T0, cfg), "refund"),
        ]);
        expect(rpc.calls.sendTransaction).toBe(1);
        const states = [
            (await findOrderRefund(db.pool, first.id))!.state,
            (await findOrderRefund(db.pool, second.id))!.state,
        ];
        expect(states.sort()).toEqual(["pending", "sent"]);
        expect(await refundsPaused(db.pool)).toBe(reason);
    });

    it("subtracts refunds signed or sent but not confirmed from the float", async () => {
        const first = await pendingRefund(10_000);
        const second = await pendingRefund(10_001);
        const rpc = okRpc({ getTokenAccountBalance: () => usdcBalance(15_000) });
        const tick = await runRefunds(deps(rpc), "refund");
        expect(tick).toMatchObject({ sent: 1, paused: "float_low" });
        expect((await findOrderRefund(db.pool, first.id))!.state).toBe("sent");
        expect(await findOrderRefund(db.pool, second.id)).toMatchObject({
            state: "pending",
            txSignature: null,
        });
        expect(rpc.calls.sendTransaction).toBe(1);
        expect(alarms("refund_float_low")).toEqual([
            expect.objectContaining({
                orderId: second.id,
                balanceMicros: "15000",
                unconfirmedMicros: 10_000,
                amountMicros: 10_001,
            }),
        ]);
        expect(await refundsPaused(db.pool)).toBe("float_low");
    });

    it("pauses at the hourly rate and on a low float", async () => {
        const first = await pendingRefund();
        const second = await pendingRefund();
        const tick = await runRefunds(deps(okRpc(), T0, { max_per_hour: 1 }), "refund");
        expect(tick).toMatchObject({ sent: 1, paused: "hourly_rate" });
        expect((await findOrderRefund(db.pool, first.id))!.state).toBe("sent");
        expect((await findOrderRefund(db.pool, second.id))!.state).toBe("pending");
        expect(await refundsPaused(db.pool)).toBe("hourly_rate");

        await resumeRefunds(db.pool);
        const low = okRpc({
            getTokenAccountBalance: () => ({
                value: {
                    amount: "9999",
                    decimals: 6,
                    uiAmount: 0.009999,
                    uiAmountString: "0.009999",
                },
            }),
        });
        const later2h = await runRefunds(
            deps(low, later(7_200_000), { max_per_hour: 1 }),
            "refund",
        );
        expect(later2h).toMatchObject({ confirmed: 1, sent: 0, paused: "float_low" });
        expect((await findOrderRefund(db.pool, second.id))!.state).toBe("pending");
        expect(low.calls.sendTransaction).toBe(0);
        expect(await refundsPaused(db.pool)).toBe("float_low");
        expect(alarms("refund_float_low")).toEqual([
            expect.objectContaining({ orderId: second.id, balanceMicros: "9999" }),
        ]);
        expect(alarms("refunds_paused").map((l) => l.reason)).toEqual(["hourly_rate", "float_low"]);
    });

    it("never refunds more than was paid", async () => {
        const { order } = await seedOrder(db.pool, { state: "refunding", payer: payer.address });
        await seedPayment(db.pool, order.id, {
            payer: payer.address,
            sourceTokenAccount: SOURCE,
            amountMicros: 10_000,
        });
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state)
             values ($1, 'partial', 'router_refundable', 10001, $2, $3, 'pending')`,
            [order.id, SOURCE, payer.address],
        );
        const rpc = okRpc();
        const tick = await runRefunds(deps(rpc), "refund");
        expect(tick.manual).toBe(1);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_exceeds_payment",
        });
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_exceeds_payment",
        });
        expect(rpc.calls.getAccountInfo).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
        expect(alarms("manual_queue")).toEqual([
            expect.objectContaining({ orderId: order.id, reason: "refund_exceeds_payment" }),
        ]);
    });

    it("signs one transaction when two runners race", async () => {
        const order = await pendingRefund();
        const rpc = okRpc();
        await Promise.all([runRefunds(deps(rpc), "refund"), runRefunds(deps(rpc), "refund")]);
        expect(new Set(rpc.sent).size).toBe(1);
        expect(rpc.calls.sendTransaction).toBe(1);
        expect((await findOrderRefund(db.pool, order.id))!.attempts).toBe(1);
    });

    it("warns when the RPC answers another signature", async () => {
        const order = await pendingRefund();
        const other = getBase58Decoder().decode(new Uint8Array(64).fill(9));
        const rpc = okRpc({ sendTransaction: () => other });
        expect((await runRefunds(deps(rpc), "refund")).sent).toBe(1);
        const row = (await findOrderRefund(db.pool, order.id))!;
        expect(row).toMatchObject({ state: "sent", txSignature: signatureOf(row.wireTx!) });
        expect(levels("warn")).toEqual([
            expect.objectContaining({
                msg: "rpc answered another signature",
                refundId: row.id,
                orderId: order.id,
                signature: row.txSignature,
                answered: other,
            }),
        ]);
    });

    it("handles at most 5 refunds per tick, oldest first", async () => {
        const orders: OrderRow[] = [];
        for (let i = 0; i < 6; i++) orders.push(await pendingRefund(10_000 + i));
        const tick = await runRefunds(deps(okRpc()), "refund");
        expect(tick.sent).toBe(5);
        const states = [];
        for (const o of orders) states.push((await findOrderRefund(db.pool, o.id))!.state);
        expect(states).toEqual(["sent", "sent", "sent", "sent", "sent", "pending"]);
    });

    it("signs an identical twin refund on a later blockhash", async () => {
        const first = await pendingRefund();
        const twin = await pendingRefund();
        expect((await runRefunds(deps(okRpc()), "refund")).sent).toBe(1);
        expect((await findOrderRefund(db.pool, first.id))!.state).toBe("sent");
        expect((await findOrderRefund(db.pool, twin.id))!.state).toBe("pending");
        expect(log.lines.some((l) => l.level === "alarm")).toBe(false);

        const fresh = okRpc({
            getLatestBlockhash: () => ({
                value: { blockhash: FRESH_BLOCKHASH, lastValidBlockHeight: 2_000n },
            }),
        });
        expect(await runRefunds(deps(fresh, later(30_000)), "refund")).toMatchObject({
            confirmed: 1,
            sent: 1,
        });
        const a = (await findOrderRefund(db.pool, first.id))!;
        const b = (await findOrderRefund(db.pool, twin.id))!;
        expect(b.state).toBe("sent");
        expect(b.txSignature).not.toBe(a.txSignature);
    });
});

describe("runRefunds against a stalled RPC", () => {
    const timedOut = (orderId: string) =>
        expect.objectContaining({
            msg: "refund rpc call failed, retrying next tick",
            orderId,
            err: expect.objectContaining({ name: "TimeoutError" }),
        });

    async function stalledTick(rpc: FakeRpc, at: Date = T0) {
        const started = performance.now();
        const tick = await runRefunds({ ...deps(rpc, at), rpcTimeoutMs: STALL_MS }, "refund");
        expect(performance.now() - started).toBeLessThan(STALL_MS + 900);
        return tick;
    }

    it.each(["getAccountInfo", "getTokenAccountBalance", "getLatestBlockhash"] as const)(
        "gives up on a stalled %s within solana.rpc_timeout and leaves the pending refund",
        async (method) => {
            const order = await pendingRefund();
            const before = await findOrderRefund(db.pool, order.id);
            const rpc = okRpc({ [method]: neverAnswers });

            expect(await stalledTick(rpc)).toMatchObject({ sent: 0, manual: 0, paused: null });
            expect(await findOrderRefund(db.pool, order.id)).toEqual(before);
            expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
            expect(rpc.calls.sendTransaction).toBe(0);
            expect(levels("warn")).toEqual([timedOut(order.id)]);
            expect(levels("error")).toEqual([]);
            expect(log.lines.some((l) => l.level === "alarm")).toBe(false);
        },
    );

    it.each([
        ["getEpochInfo", {}],
        ["getSignatureStatuses", {}],
        [
            "sendTransaction",
            { getSignatureStatuses: notFound, getEpochInfo: () => epochAt(TEST_LVBH) },
        ],
    ] as const)(
        "gives up on a stalled %s within solana.rpc_timeout and leaves the sent refund",
        async (method, script) => {
            const { order, refund } = await sentRefund();
            log = memoryLog();
            const rpc = okRpc({ ...script, [method]: neverAnswers });

            expect(await stalledTick(rpc, later(30_000))).toMatchObject({
                resent: 0,
                resigned: 0,
                confirmed: 0,
                manual: 0,
            });
            expect(await findOrderRefund(db.pool, order.id)).toEqual(refund);
            expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
            expect(levels("warn")).toEqual([timedOut(order.id)]);
            expect(levels("error")).toEqual([]);
        },
    );

    it("keeps a refund signed, not sent, when its first send stalls", async () => {
        const order = await pendingRefund();
        const rpc = okRpc({ sendTransaction: neverAnswers });

        expect((await stalledTick(rpc)).sent).toBe(0);
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "signed",
            attempts: 1,
            signedAt: T0,
            sentAt: null,
        });
        expect(levels("warn")).toEqual([timedOut(order.id)]);
    });
});

describe("runRefunds while refunds are paused", () => {
    it("confirms a sent refund that landed and signs no pending one", async () => {
        const { order: sent } = await sentRefund();
        const pending = await pendingRefund(20_000);
        await pauseRefunds(db.pool, "daily_cap", log);
        const rpc = okRpc();
        const tick = await runRefunds(deps(rpc, later(30_000)), "refund");
        expect(tick).toEqual({
            sent: 0,
            resent: 0,
            resigned: 0,
            confirmed: 1,
            manual: 0,
            paused: "daily_cap",
        });
        expect((await findOrderRefund(db.pool, sent.id))!.state).toBe("confirmed");
        expect((await findOrder(db.pool, sent.id))!.state).toBe("refunded");
        expect(await findOrderRefund(db.pool, pending.id)).toMatchObject({
            state: "pending",
            attempts: 0,
            txSignature: null,
        });
        expect(rpc.calls.getAccountInfo).toBe(0);
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
    });

    it("signs nothing once a pause lands during the tick", async () => {
        await sentRefund();
        const pending = await pendingRefund(20_000);
        const rpc = okRpc({
            getSignatureStatuses: async () => {
                await pauseRefunds(db.pool, "operator", log);
                return { value: [CONFIRMED] };
            },
        });
        const tick = await runRefunds(deps(rpc, later(30_000)), "refund");
        expect(tick).toMatchObject({ confirmed: 1, sent: 0, paused: "operator" });
        expect((await findOrderRefund(db.pool, pending.id))!.state).toBe("pending");
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
    });

    it.each([
        ["not found while its blockhash is valid", TEST_LVBH],
        ["expired and not found", TEST_LVBH + 1n],
    ])("neither resends nor re-signs a refund %s", async (_n, height) => {
        const { order, refund } = await sentRefund();
        await pauseRefunds(db.pool, "hourly_rate", log);
        const rpc = okRpc({ getSignatureStatuses: notFound, getEpochInfo: () => epochAt(height) });
        const tick = await runRefunds(deps(rpc, later(30_000)), "refund");
        expect(tick).toMatchObject({ resent: 0, resigned: 0, paused: "hourly_rate" });
        expect(await findOrderRefund(db.pool, order.id)).toEqual(refund);
        expect(rpc.calls.getSignatureStatuses).toBe(1);
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
    });

    it.each([
        ["landed with an error", { value: [LANDED_FAILED] }, "refund_failed_onchain"],
        ["expired max_attempts times", { value: [null] }, "refund_expired_repeatedly"],
    ])("queues a refund that %s for an operator", async (_n, statuses, reason) => {
        const { order } = await sentRefund({ max_attempts: 1 });
        await pauseRefunds(db.pool, "daily_cap", log);
        const rpc = okRpc({
            getSignatureStatuses: () => statuses,
            getEpochInfo: () => epochAt(TEST_LVBH + 1n),
        });
        const tick = await runRefunds(deps(rpc, later(30_000), { max_attempts: 1 }), "refund");
        expect(tick).toMatchObject({ manual: 1, paused: "daily_cap" });
        expect(await findOrderRefund(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: reason,
        });
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
    });
});

describe("refund controls", () => {
    it("pauses once, alarms once per pause and resumes", async () => {
        expect(await refundsPaused(db.pool)).toBeNull();
        await pauseRefunds(db.pool, "daily_cap", log);
        await pauseRefunds(db.pool, "hourly_rate", log);
        expect(await refundsPaused(db.pool)).toBe("daily_cap");
        expect(alarms("refunds_paused")).toHaveLength(1);
        await resumeRefunds(db.pool);
        expect(await refundsPaused(db.pool)).toBeNull();
        await pauseRefunds(db.pool, "float_low", log);
        expect(await refundsPaused(db.pool)).toBe("float_low");
        expect(alarms("refunds_paused")).toHaveLength(2);
    });
});

function hotRpc(script: Partial<FakeRpcScript> = {}): FakeRpc {
    return okRpc({
        getLatestBlockhash: () => ({
            context: { slot: 777n },
            value: { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: TEST_LVBH },
        }),
        ...script,
    });
}

// A node past the old expiry hands out a new blockhash, so a re-sign is a different transaction
function expiredRpc(statusSlot = 2_000n): FakeRpc {
    return hotRpc({
        getLatestBlockhash: () => ({
            context: { slot: 777n },
            value: { blockhash: FRESH_BLOCKHASH, lastValidBlockHeight: 2_000n },
        }),
        getEpochInfo: () => epochAt(1_000n, statusSlot),
        getSignatureStatuses: () => ({ context: { slot: statusSlot }, value: [null] }),
    });
}

async function hotRow(
    o: {
        kind?: RefundKind;
        amountMicros?: number;
        budgetWaived?: boolean;
        payer?: KeyPairSigner;
    } = {},
): Promise<RefundRow> {
    const kind = o.kind ?? "allowance";
    const funder = o.payer ?? payer;
    const account = await seedAccount(db.pool, {
        state: "open",
        handleSha256: randomBytes(32).toString("hex"),
    });
    const funding = await seedFunding(db.pool, {
        accountId: account.id,
        allowanceMicros: 1_000_000,
        payer: funder.address,
        sourceTokenAccount: SOURCE,
    });
    await db.pool.query("update x402_pool set committed_micros = 1000000");
    let orderId = funding.orderId;
    if (kind !== "allowance") {
        orderId = account.id;
        await seedPayment(db.pool, orderId, {
            status: "confirmed",
            payer: funder.address,
            sourceTokenAccount: SOURCE,
        });
    }
    const res = await db.pool.query<{ id: string }>(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            from_wallet, budget_waived)
         values ($1, $2, $3, $4, $5, $6, 'pending', 'allowance', $7) returning id`,
        [
            orderId,
            kind,
            kind === "allowance"
                ? "x402_unspent"
                : kind === "full"
                  ? "operator"
                  : "router_refundable",
            o.amountMicros ?? 300_000,
            SOURCE,
            funder.address,
            o.budgetWaived ?? false,
        ],
    );
    return (await findRefundById(db.pool, Number(res.rows[0]!.id)))!;
}

function memoOf(msg: Message): string {
    const ix = msg.instructions.find(
        (i) => msg.staticAccounts[i.programAddressIndex] === MEMO_PROGRAM,
    )!;
    return new TextDecoder().decode(ix.data!);
}

async function proven(id: number, verified: number): Promise<void> {
    await db.pool.query("update refunds set expiry_seen_slot = 1000 where id = $1", [id]);
    await db.pool.query("update x402_tail set verified_slot = $1", [verified]);
}

async function day(): Promise<{ day: string; micros: number }[]> {
    const res = await db.pool.query(
        "select day::text, micros::int from x402_refund_days order by day",
    );
    return res.rows;
}

describe("buildRefundTransaction hot", () => {
    it("allowance rows are signed by the allowance wallet with the fee payer first", async () => {
        const hint = { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: TEST_LVBH };
        const built = await buildRefundTransaction(
            deps(hotRpc()),
            {
                destination: SOURCE,
                amountMicros: 300_000,
                source: allowance,
                memo: "bugnet-refund 7",
            },
            hint,
        );
        const msg = decodeMessage(built.wire);
        expect(msg.header.numSignerAccounts).toBe(2);
        expect(msg.staticAccounts.slice(0, 2)).toEqual([feePayer.address, allowance.address]);
        expect(programsOf(msg)).toEqual([
            COMPUTE_BUDGET,
            COMPUTE_BUDGET,
            TOKEN_PROGRAM,
            MEMO_PROGRAM,
        ]);
        expect(memoOf(msg)).toBe("bugnet-refund 7");
        expect(msg.instructions[3]!.accountIndices ?? []).toEqual([]);
        expect(transferOf(msg)).toMatchObject({
            source: HOT,
            destination: SOURCE,
            authority: allowance.address,
            amount: 300_000n,
        });
        expect(
            getSetComputeUnitLimitInstructionDataDecoder().decode(msg.instructions[0]!.data!).units,
        ).toBe(20_000);
    });
});

describe("runRefunds allowance", () => {
    it("refund-wallet rows are unchanged", async () => {
        const order = await pendingRefund();
        await hotRow();
        expect((await runRefunds(deps(okRpc()), "refund")).sent).toBe(1);
        expect(
            (
                await db.pool.query(
                    "select 1 from refunds where from_wallet = 'allowance' and state <> 'pending'",
                )
            ).rowCount,
        ).toBe(0);
        expect((await runRefunds(deps(hotRpc()), "allowance")).sent).toBe(1);
        expect((await findOrderRefund(db.pool, order.id))!.state).toBe("sent");
    });

    it("refuses to run without the allowance wallet", async () => {
        await expect(
            runRefunds({ ...deps(hotRpc()), allowanceSigner: null }, "allowance"),
        ).rejects.toThrow("hot refunds need the allowance wallet");
    });

    it("11 allowance refunds in an hour never pause order refunds", async () => {
        for (let i = 0; i < 11; i++) await hotRow();
        let sent = 0;
        for (let i = 0; i < 3; i++) {
            sent += (await runRefunds(deps(hotRpc(), T0, { max_per_hour: 10 }), "allowance")).sent;
        }
        expect(sent).toBe(11);
        expect(await refundsPaused(db.pool)).toBeNull();
        await pendingRefund();
        expect((await runRefunds(deps(okRpc(), T0, { max_per_hour: 10 }), "refund")).sent).toBe(1);
    });

    it("the pause and the kill switch never stop them", async () => {
        await hotRow();
        await setControls(db.pool, { paused: true, disabled: true }, "test", T0);
        await pauseRefunds(db.pool, "daily_cap", log);
        expect((await runRefunds(deps(hotRpc()), "allowance")).sent).toBe(1);
    });

    it("refunds_held stops signing; a signed row is still confirmed", async () => {
        const a = await hotRow();
        expect((await runRefunds(deps(hotRpc()), "allowance")).sent).toBe(1);
        const b = await hotRow();
        await setControls(db.pool, { refundsHeld: true }, "leak", T0);
        const tick = await runRefunds(deps(hotRpc(), later(30_000)), "allowance");
        expect(tick).toMatchObject({ sent: 0, confirmed: 1, paused: "refunds_held" });
        expect((await findRefundById(db.pool, a.id))!.state).toBe("confirmed");
        expect((await findRefundById(db.pool, b.id))!.state).toBe("pending");
    });

    it("a held row is resent with its own bytes, and returned to pending once proven absent", async () => {
        const a = await hotRow();
        await runRefunds(deps(hotRpc()), "allowance");
        const signed = (await findRefundById(db.pool, a.id))!;
        await setControls(db.pool, { refundsHeld: true }, "leak", T0);
        const live = hotRpc({
            getSignatureStatuses: () => ({ context: { slot: 900n }, value: [null] }),
            getEpochInfo: () => epochAt(800n),
        });
        await runRefunds(deps(live, later(30_000)), "allowance");
        expect(live.sent.at(-1)).toBe(signed.wireTx);
        await proven(a.id, 1_300);
        await runRefunds(deps(expiredRpc(), later(60_000)), "allowance");
        expect(await findRefundById(db.pool, a.id)).toMatchObject({
            state: "pending",
            txSignature: signed.txSignature,
            attempts: 1,
        });
    });

    it("the daily budget sends the rest to manual", async () => {
        await db.pool.query("insert into x402_refund_days values ('2030-01-01', 49995000)");
        const over = await hotRow({ amountMicros: 10_000 });
        const tick = await runRefunds(deps(hotRpc()), "allowance");
        expect(tick).toMatchObject({ sent: 0, manual: 1 });
        expect(await findRefundById(db.pool, over.id)).toMatchObject({
            state: "manual",
            manualReason: "x402_refund_budget",
        });
        expect(alarms("x402_refund_budget")).toHaveLength(1);
        expect(alarms("manual_queue")).toHaveLength(0);
        const waived = await hotRow({ amountMicros: 10_000, budgetWaived: true });
        expect((await runRefunds(deps(hotRpc()), "allowance")).sent).toBe(1);
        expect((await findRefundById(db.pool, waived.id))!.state).toBe("sent");
        expect(await day()).toEqual([{ day: "2030-01-01", micros: 50_005_000 }]);
    });

    it("a re-sign never counts again", async () => {
        const a = await hotRow();
        await runRefunds(deps(hotRpc()), "allowance");
        const first = (await findRefundById(db.pool, a.id))!;
        await proven(a.id, 1_300);
        const next = new Date("2030-01-02T00:00:30Z");
        expect((await runRefunds(deps(expiredRpc(), next), "allowance")).resigned).toBe(1);
        expect(await findRefundById(db.pool, a.id)).toMatchObject({
            attempts: 2,
            previousSignatures: [first.txSignature],
            signingSlot: 777n,
            expirySeenSlot: null,
        });
        expect(await day()).toEqual([{ day: "2030-01-01", micros: 300_000 }]);
    });

    it("a closed destination goes to manual with nothing signed", async () => {
        const answers = [
            () => ({ value: null }),
            () => tokenAccount({ state: "frozen" }),
            () => tokenAccount({ owner: feePayer.address }),
        ];
        for (const answer of answers) {
            const r = await hotRow();
            const rpc = hotRpc({ getAccountInfo: answer });
            await runRefunds(deps(rpc), "allowance");
            expect(await findRefundById(db.pool, r.id)).toMatchObject({
                state: "manual",
                manualReason: "refund_destination_invalid",
            });
            expect(rpc.calls.sendTransaction ?? 0).toBe(0);
        }
        expect(await day()).toEqual([]);
        expect(alarms("manual_queue")).toHaveLength(3);
    });

    it("two funders: the closed destination goes manual, the other is sent, the account closes", async () => {
        const p2 = await testSigner(8);
        const S2 = await usdcAta(p2.address);
        const a = await seedAccount(db.pool, {
            state: "closing",
            closingAt: T0,
        });
        await seedFunding(db.pool, {
            accountId: a.id,
            orderId: a.id,
            allowanceMicros: 1_000_000,
            payer: payer.address,
            sourceTokenAccount: SOURCE,
            createdAt: T0,
        });
        await seedFunding(db.pool, {
            accountId: a.id,
            allowanceMicros: 500_000,
            payer: p2.address,
            sourceTokenAccount: S2,
            createdAt: later(1),
        });
        await db.pool.query("update x402_pool set committed_micros = 1500000");
        const close = {
            pool: db.pool,
            router: {} as RouterClient,
            funding: createAllowanceFunding({ x402: x402Defaults, log }),
            x402: x402Defaults,
            orders: ordersDefaults,
            log,
        };
        await runCloseJob({ ...close, now: () => T0 });
        const rpc = hotRpc({
            getAccountInfo: (addr: string) =>
                addr === SOURCE
                    ? tokenAccount({ state: "frozen" })
                    : tokenAccount({ owner: p2.address }),
        });
        expect(await runRefunds(deps(rpc), "allowance")).toMatchObject({ sent: 1, manual: 1 });
        expect((await findRefund(db.pool, a.id, "allowance"))!.wireTx).toBeNull();
        expect((await runRefunds(deps(rpc, later(30_000)), "allowance")).confirmed).toBe(1);
        await runCloseJob({ ...close, now: () => later(35_000) });
        expect(await findAccount(db.pool, a.id)).toMatchObject({
            state: "closed",
            closedAt: later(35_000),
        });
    });

    it("a short hot balance goes to manual", async () => {
        const r = await hotRow();
        const asked: string[] = [];
        const rpc = hotRpc({
            getTokenAccountBalance: (addr: string) => (asked.push(addr), usdcBalance(299_999)),
        });
        await runRefunds(deps(rpc), "allowance");
        expect(asked).toEqual([HOT]);
        expect(await findRefundById(db.pool, r.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_balance_short",
        });
        expect(alarms("manual_queue")).toHaveLength(1);
    });

    it("two refunds in one tick cannot both pass on a balance that covers one", async () => {
        const [a, b] = [await hotRow(), await hotRow()];
        const rpc = hotRpc({ getTokenAccountBalance: () => usdcBalance(400_000) });
        expect(await runRefunds(deps(rpc), "allowance")).toMatchObject({ sent: 1, manual: 1 });
        expect((await findRefundById(db.pool, a.id))!.state).toBe("sent");
        expect(await findRefundById(db.pool, b.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_balance_short",
        });
    });

    it("a cold transfer in flight is taken off the hot balance", async () => {
        await db.pool.query(
            "insert into x402_cold_transfers (amount_micros, state) values (200000, 'sent')",
        );
        const r = await hotRow();
        const rpc = hotRpc({ getTokenAccountBalance: () => usdcBalance(400_000) });
        await runRefunds(deps(rpc), "allowance");
        expect(await findRefundById(db.pool, r.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_balance_short",
        });
    });

    it("a hot row that landed with an error goes to manual", async () => {
        const r = await hotRow();
        await runRefunds(deps(hotRpc()), "allowance");
        const rpc = hotRpc({ getSignatureStatuses: () => ({ value: [LANDED_FAILED] }) });
        expect(await runRefunds(deps(rpc, later(30_000)), "allowance")).toMatchObject({
            manual: 1,
        });
        expect(await findRefundById(db.pool, r.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_failed_onchain",
        });
        expect(rpc.calls.sendTransaction ?? 0).toBe(0);
    });

    it("a hot row that is only processed waits", async () => {
        const r = await hotRow();
        await runRefunds(deps(hotRpc()), "allowance");
        const rpc = hotRpc({
            getSignatureStatuses: () => ({
                value: [{ confirmationStatus: "processed", err: null, slot: 1n }],
            }),
        });
        await runRefunds(deps(rpc, later(30_000)), "allowance");
        expect(await findRefundById(db.pool, r.id)).toMatchObject({ state: "sent", attempts: 1 });
        expect(rpc.calls.sendTransaction ?? 0).toBe(0);
        expect(rpc.calls.getLatestBlockhash ?? 0).toBe(0);
    });

    it("two hot refunds of one amount to one payer with one blockhash build two messages", async () => {
        const [a, b] = [await hotRow(), await hotRow()];
        expect((await runRefunds(deps(hotRpc()), "allowance")).sent).toBe(2);
        const ra = (await findRefundById(db.pool, a.id))!;
        const rb = (await findRefundById(db.pool, b.id))!;
        expect(ra.txSignature).not.toBe(rb.txSignature);
        expect(memoOf(decodeMessage(ra.wireTx!))).toBe(`bugnet-refund ${a.id}`);
        expect(memoOf(decodeMessage(rb.wireTx!))).toBe(`bugnet-refund ${b.id}`);
    });

    it("a re-sign waits for the proof and alarms after 10 minutes", async () => {
        const r = await hotRow();
        await runRefunds(deps(hotRpc()), "allowance");
        await proven(r.id, 1_299);
        const rpc = expiredRpc();
        await runRefunds(deps(rpc, later(30_000)), "allowance");
        await runRefunds(deps(rpc, later(630_000)), "allowance");
        expect(alarms("x402_resign_waiting")).toHaveLength(0);
        await runRefunds(deps(rpc, later(630_001)), "allowance");
        await runRefunds(deps(rpc, later(630_002)), "allowance");
        expect(alarms("x402_resign_waiting")).toEqual([
            expect.objectContaining({ refundId: r.id }),
        ]);
        expect(rpc.calls.sendTransaction ?? 0).toBe(0);
        expect((await findRefundById(db.pool, r.id))!.attempts).toBe(1);
    });

    it("an RPC error during a refund check leaves the row as it was", async () => {
        const r = await hotRow();
        const rpc = hotRpc({
            getAccountInfo: () => {
                throw new Error("429");
            },
        });
        expect(await runRefunds(deps(rpc), "allowance")).toMatchObject({ sent: 0, manual: 0 });
        expect(await findRefundById(db.pool, r.id)).toMatchObject({
            state: "pending",
            attempts: 0,
            txSignature: null,
        });
        expect(await day()).toEqual([]);
    });

    it("guards send an oversized row to manual", async () => {
        const big = await hotRow({ amountMicros: 1_000_001 });
        const part = await hotRow({ kind: "partial", amountMicros: 13_001 });
        await runRefunds(deps(hotRpc()), "allowance");
        for (const r of [big, part]) {
            expect(await findRefundById(db.pool, r.id)).toMatchObject({
                state: "manual",
                manualReason: "refund_exceeds_payment",
            });
        }
        expect((await findOrder(db.pool, part.orderId))!.state).toBe("redeemed");
    });

    it("an earlier signature that landed confirms the row with that signature", async () => {
        const r = await hotRow();
        await runRefunds(deps(hotRpc()), "allowance");
        const first = (await findRefundById(db.pool, r.id))!;
        await proven(r.id, 1_300);
        await runRefunds(deps(expiredRpc(), later(30_000)), "allowance");
        const second = (await findRefundById(db.pool, r.id))!;
        expect(second.previousSignatures).toEqual([first.txSignature]);
        const rpc = hotRpc({
            getSignatureStatuses: () => ({ value: [null, { ...CONFIRMED, slot: 4_000n }] }),
        });
        expect((await runRefunds(deps(rpc, later(60_000)), "allowance")).confirmed).toBe(1);
        expect(await findRefundById(db.pool, r.id)).toMatchObject({
            state: "confirmed",
            txSignature: first.txSignature,
            previousSignatures: [second.txSignature],
            landedSlot: 4_000n,
        });
    });

    it("a hot row above the [refunds] daily cap is sent, never parked refund_exceeds_cap", async () => {
        const r = await hotRow({ amountMicros: 300_000 });
        expect(
            (await runRefunds(deps(hotRpc(), T0, { daily_cap_micros: 100_000 }), "allowance")).sent,
        ).toBe(1);
        expect((await findRefundById(db.pool, r.id))!.state).toBe("sent");
    });

    it("the confirm path stores landed_slot from the status slot", async () => {
        const r = await hotRow();
        await runRefunds(deps(hotRpc()), "allowance");
        const rpc = hotRpc({
            getSignatureStatuses: () => ({ value: [{ ...CONFIRMED, slot: 4_321n }] }),
        });
        expect((await runRefunds(deps(rpc, later(30_000)), "allowance")).confirmed).toBe(1);
        expect(await findRefundById(db.pool, r.id)).toMatchObject({
            state: "confirmed",
            landedSlot: 4_321n,
        });
        expect((await readPool(db.pool)).committedMicros).toBe(700_000);
    });
});

describe("runRefunds on refund groups", () => {
    let owners: KeyPairSigner[];
    let sources: Address[];
    let OTHER_B: Address;
    const owner = new Map<string, string>();

    beforeAll(async () => {
        owners = [payer, await testSigner(12), await testSigner(13), await testSigner(14)];
        sources = [SOURCE];
        for (const o of owners.slice(1)) sources.push(await usdcAta(o.address));
        // A second account of owner B, so a wrong destination still passes the on-chain check
        OTHER_B = (await testSigner(15)).address;
        owners.forEach((o, i) => owner.set(sources[i]!, o.address));
        owner.set(OTHER_B, owners[1]!.address);
    });

    function shares(...applied: number[]): TestShare[] {
        return applied.map((appliedMicros, i) => ({
            owner: owners[i]!.address,
            sourceTokenAccount: sources[i]!,
            appliedMicros,
        }));
    }

    // Each owner's account answers as its own; a closed one answers nothing
    function groupRpc(closed: readonly string[] = [], script: Partial<FakeRpcScript> = {}) {
        return okRpc({
            getAccountInfo: (addr: string) =>
                closed.includes(addr) || !owner.has(addr)
                    ? { value: null }
                    : tokenAccount({ owner: owner.get(addr)! }),
            ...script,
        });
    }

    async function sharedOrder(
        applied: number[] = [30_000, 20_000],
        state: OrderRow["state"] = "paid",
    ): Promise<OrderRow> {
        const amountMicros = applied.reduce((sum, a) => sum + a, 0);
        const { order } = await seedOrder(db.pool, { state, amountMicros });
        await seedSharedPayment(db.pool, order.id, { shares: shares(...applied) });
        return order;
    }

    async function sharedRefund(applied?: number[]): Promise<OrderRow> {
        const order = await sharedOrder(applied);
        expect(await requestRefund(db.pool, order.id, "unredeemed")).toBe("created");
        return order;
    }

    async function handRow(
        orderId: string,
        r: { kind: RefundKind; part: number; amountMicros: number; destination?: string },
    ): Promise<number> {
        const res = await db.pool.query<{ id: string }>(
            `insert into refunds (order_id, kind, part, reason, amount_micros, destination, payer,
                state, created_at)
             values ($1, $2, $3, 'operator', $4, $5, $6, 'pending', $7) returning id`,
            [
                orderId,
                r.kind,
                r.part,
                r.amountMicros,
                r.destination ?? sources[r.part]!,
                owners[r.part]!.address,
                T0,
            ],
        );
        return Number(res.rows[0]!.id);
    }

    const states = async (orderId: string, kind: RefundKind = "full") =>
        (await refundGroup(db.pool, orderId, kind)).map((r) => [r.state, r.manualReason]);

    it("one bad destination stops only its own part", async () => {
        const order = await sharedRefund();
        const rpc = groupRpc([sources[1]!]);
        expect(await runRefunds(deps(rpc), "refund")).toMatchObject({ sent: 1, manual: 1 });
        expect(await states(order.id)).toEqual([
            ["sent", null],
            ["manual", "refund_destination_invalid"],
        ]);
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_destination_invalid",
        });
        const [part0] = await refundGroup(db.pool, order.id, "full");
        expect(transferOf(decodeMessage(rpc.sent[0]!))).toMatchObject({
            destination: sources[0],
            amount: 30_000n,
        });
        expect((await runRefunds(deps(rpc, later(30_000)), "refund")).confirmed).toBe(1);
        expect((await findRefundById(db.pool, part0!.id))!.state).toBe("confirmed");
        expect((await findOrder(db.pool, order.id))!.state).toBe("manual");
    });

    it("a group above the payment goes to manual", async () => {
        const over = await sharedOrder([30_000, 20_000], "refunding");
        await handRow(over.id, { kind: "full", part: 0, amountMicros: 30_000 });
        await handRow(over.id, { kind: "full", part: 1, amountMicros: 30_000 });
        const both = await sharedOrder([30_000, 20_000], "refunding");
        await handRow(both.id, { kind: "full", part: 0, amountMicros: 30_000 });
        await handRow(both.id, { kind: "full", part: 1, amountMicros: 20_000 });
        await handRow(both.id, { kind: "partial", part: 0, amountMicros: 12_000 });
        await handRow(both.id, { kind: "partial", part: 1, amountMicros: 8_000 });
        const rpc = groupRpc();
        await runRefunds(deps(rpc), "refund");
        await runRefunds(deps(rpc), "refund");
        expect(rpc.calls.sendTransaction).toBe(0);
        const manual = ["manual", "refund_exceeds_payment"];
        expect(await states(over.id)).toEqual([manual, manual]);
        expect(await states(both.id)).toEqual([manual, manual]);
        expect(await states(both.id, "partial")).toEqual([manual, manual]);
        expect((await findOrder(db.pool, over.id))!.state).toBe("manual");
    });

    it("a part to a wrong destination goes to manual", async () => {
        const order = await sharedOrder([30_000, 20_000], "refunding");
        await handRow(order.id, { kind: "full", part: 0, amountMicros: 30_000 });
        await handRow(order.id, {
            kind: "full",
            part: 1,
            amountMicros: 20_000,
            destination: OTHER_B,
        });
        const rpc = groupRpc();
        expect(await runRefunds(deps(rpc), "refund")).toMatchObject({ sent: 1, manual: 1 });
        expect(await states(order.id)).toEqual([
            ["sent", null],
            ["manual", "refund_destination_invalid"],
        ]);
        expect(rpc.sent.map((w) => transferOf(decodeMessage(w)).destination)).toEqual([sources[0]]);
    });

    it("the order is refunded only when every part landed", async () => {
        const order = await sharedRefund();
        expect((await runRefunds(deps(groupRpc()), "refund")).sent).toBe(2);
        const [p0, p1] = await refundGroup(db.pool, order.id, "full");
        const landed = new Set<string>([p0!.txSignature!]);
        const rpc = groupRpc([], {
            getSignatureStatuses: (sigs: string[]) => ({
                value: [
                    landed.has(sigs[0]!)
                        ? CONFIRMED
                        : { confirmationStatus: "processed", err: null, slot: 1n },
                ],
            }),
        });
        expect((await runRefunds(deps(rpc, later(30_000)), "refund")).confirmed).toBe(1);
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
        landed.add(p1!.txSignature!);
        expect((await runRefunds(deps(rpc, later(60_000)), "refund")).confirmed).toBe(1);
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunded");
    });

    it("a group counts once toward the hourly rate", async () => {
        // Distinct amounts, so no part is the twin of another group's part
        const groups = [];
        for (let i = 0; i < 3; i++) {
            groups.push(await sharedRefund([20_000 + i, 15_000 + i, 10_000 + i, 5_000 + i]));
        }
        const cfg = { max_per_hour: 2 };
        await runRefunds(deps(groupRpc(), T0, cfg), "refund");
        const second = await runRefunds(deps(groupRpc(), later(1_000), cfg), "refund");
        expect(second.paused).toBe("hourly_rate");
        for (const g of groups.slice(0, 2)) {
            expect((await states(g.id)).map(([state]) => state)).toEqual(Array(4).fill("sent"));
        }
        expect((await states(groups[2]!.id)).map(([state]) => state)).toEqual(
            Array(4).fill("pending"),
        );
        expect(await refundsPaused(db.pool)).toBe("hourly_rate");
    });

    it("deposit refund rows", async () => {
        const { order } = await seedOrder(db.pool, { state: "refunding", amountMicros: 50_000 });
        const first = await seedHeldTransfer(db.pool, order.id, { amountMicros: 7_000 });
        const second = await seedHeldTransfer(db.pool, order.id, {
            amountMicros: 9_000,
            appliedMicros: 1_000,
        });
        const returnTo = (signature: string) =>
            withTx(db.pool, (c) =>
                insertDepositRefund(c, {
                    orderId: order.id,
                    signature,
                    destination: SOURCE,
                    payer: payer.address,
                    at: T0,
                }),
            );
        const a = (await returnTo(first.signature)) as { id: number };
        expect(await findRefundById(db.pool, a.id)).toMatchObject({
            kind: "deposit",
            part: 0,
            fromWallet: "refund",
            amountMicros: 7_000,
            reason: "deposit_held",
            depositSignature: first.signature,
            state: "pending",
        });
        expect(await heldRefundId(db.pool, order.id, first.signature)).toBe(a.id);
        const b = (await returnTo(second.signature)) as { id: number };
        expect(await findRefundById(db.pool, b.id)).toMatchObject({ part: 1, amountMicros: 8_000 });
        await db.pool.query("update refunds set amount_micros = 8001 where id = $1", [b.id]);

        const rpc = groupRpc();
        expect(await runRefunds(deps(rpc), "refund")).toMatchObject({ sent: 1, manual: 1 });
        expect(transferOf(decodeMessage(rpc.sent[0]!))).toMatchObject({
            source: await usdcAta(refundSigner.address),
            destination: SOURCE,
            amount: 7_000n,
        });
        expect(await findRefundById(db.pool, b.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_exceeds_payment",
        });
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
        expect((await runRefunds(deps(rpc, later(30_000)), "refund")).confirmed).toBe(1);
        expect((await findRefundById(db.pool, a.id))!.state).toBe("confirmed");
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");

        // With every deposit row confirmed the order still stays: those rows never move it
        await db.pool.query(
            `update refunds set amount_micros = 8000, state = 'pending', manual_reason = null
             where id = $1`,
            [b.id],
        );
        expect((await runRefunds(deps(rpc, later(60_000)), "refund")).sent).toBe(1);
        expect((await runRefunds(deps(rpc, later(90_000)), "refund")).confirmed).toBe(1);
        expect((await findRefundById(db.pool, b.id))!.state).toBe("confirmed");
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
    });
});

describe("hot refund groups and the mirror", () => {
    const SIG = (n: number) => getBase58Decoder().decode(new Uint8Array(64).fill(n));
    let matchDeps: MatchDeps;
    let matchLog: ReturnType<typeof memoryLog>;
    let SRC_B: Address;
    let COLD: Address;

    beforeAll(async () => {
        SRC_B = await usdcAta((await testSigner(12)).address);
        COLD = await usdcAta((await testSigner(23)).address);
    });
    beforeEach(() => {
        matchLog = memoryLog();
        matchDeps = {
            x402: x402Defaults,
            hotTokenAccount: HOT,
            coldTokenAccount: COLD,
            log: matchLog,
            now: () => later(30_000),
            rpcTimeoutMs,
        };
    });

    // An unspent refund of 10,000 from a funding order paid by two owners, both parts sent
    async function sentAllowanceGroup(sentAt: [Date, Date] = [T0, T0]) {
        const account = await seedAccount(db.pool, {
            state: "closing",
            handleSha256: randomBytes(32).toString("hex"),
        });
        const { order } = await seedOrder(db.pool, {
            kind: "allowance",
            state: "redeemed",
            packageId: "x402-allowance",
            handleSha256: account.handleSha256,
            amountMicros: 50_000,
            allowanceMicros: 50_000,
            payInto: "allowance",
        });
        await seedSharedPayment(db.pool, order.id, {
            shares: [
                { owner: payer.address, sourceTokenAccount: SOURCE, appliedMicros: 30_000 },
                {
                    owner: (await testSigner(12)).address,
                    sourceTokenAccount: SRC_B,
                    appliedMicros: 20_000,
                },
            ],
        });
        await seedFunding(db.pool, {
            accountId: account.id,
            orderId: order.id,
            allowanceMicros: 50_000,
            payer: payer.address,
            sourceTokenAccount: SOURCE,
        });
        const ids: number[] = [];
        for (const [part, amount, dest] of [
            [0, 6_000, SOURCE],
            [1, 4_000, SRC_B],
        ] as const) {
            const res = await db.pool.query<{ id: string }>(
                `insert into refunds (order_id, kind, part, reason, amount_micros, destination,
                    payer, state, from_wallet, tx_signature, wire_tx, last_valid_block_height,
                    signed_at, sent_at, created_at)
                 values ($1, 'allowance', $2, 'x402_unspent', $3, $4, $5, 'sent', 'allowance', $6,
                    'wire', 900, $7, $7, $8) returning id`,
                [
                    order.id,
                    part,
                    amount,
                    dest,
                    part === 0 ? payer.address : (await testSigner(12)).address,
                    SIG(40 + part),
                    sentAt[part],
                    T0,
                ],
            );
            ids.push(Number(res.rows[0]!.id));
        }
        await db.pool.query("update x402_pool set committed_micros = 10000");
        return { orderId: order.id, ids };
    }

    function outgoing(signature: string, destination: string, micros: bigint): ChainTx {
        return {
            signature,
            slot: 4_000n,
            signatures: [signature],
            failed: false,
            deltaMicros: -micros,
            messageHash: "hash",
            tokenDeltas: new Map([
                [HOT, -micros],
                [destination, micros],
            ]),
            tokenInstructions: [],
            feePayer: feePayer.address,
            signers: [feePayer.address, allowance.address],
            tokenAccounts: new Map(),
        };
    }

    const refundedEvents = async (orderId: string) =>
        (
            await db.pool.query(
                `select payload from x402_router_events
                 where order_id = $1 and phase = 'refunded'`,
                [orderId],
            )
        ).rows.map((r) => r.payload as Record<string, unknown>);

    it("the mirror matches a part", async () => {
        const { orderId, ids } = await sentAllowanceGroup();
        expect(await matchInTx(db.pool, outgoing(SIG(41), SRC_B, 4_000n), matchDeps)).toBe(
            "refund",
        );
        const stored = await db.pool.query(
            "select matched, matched_id from x402_chain_txs where signature = $1",
            [SIG(41)],
        );
        expect(stored.rows[0]).toEqual({ matched: "refund", matched_id: String(ids[1]) });
        expect((await findRefundById(db.pool, ids[1]!))!.state).toBe("confirmed");
        expect((await findRefundById(db.pool, ids[0]!))!.state).toBe("sent");
        expect(await refundedEvents(orderId)).toEqual([]);
    });

    it("two parts confirmed at once send the event once", async () => {
        // Part 0 was sent too recently for the executor, so the mirror alone confirms it
        const { orderId } = await sentAllowanceGroup([later(25_000), T0]);
        let reached = () => {};
        const inRpc = new Promise<void>((resolve) => (reached = resolve));
        let release = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        const rpc = hotRpc({
            getSignatureStatuses: async () => {
                reached();
                await gate;
                return { value: [{ ...CONFIRMED, slot: 4_001n }] };
            },
        });
        const executor = runRefunds(deps(rpc, later(30_000)), "allowance");
        await inRpc;
        const mirror = matchInTx(db.pool, outgoing(SIG(40), SOURCE, 6_000n), matchDeps);
        await new Promise((resolve) => setTimeout(resolve, 200));
        release();
        const [tick, matched] = await Promise.all([executor, mirror]);
        expect(tick.confirmed).toBe(1);
        expect(matched).toBe("refund");
        expect((await refundGroup(db.pool, orderId, "allowance")).map((r) => r.state)).toEqual([
            "confirmed",
            "confirmed",
        ]);
        expect(await refundedEvents(orderId)).toEqual([
            expect.objectContaining({ amountMicros: 10_000 }),
        ]);
        expect((await readPool(db.pool)).committedMicros).toBe(0);
        const deadlocks = [...log.lines, ...matchLog.lines].filter((l) =>
            String(l.msg).includes("deadlock"),
        );
        expect(deadlocks).toEqual([]);
        expect(levels("error")).toEqual([]);
    });
});
