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
import { memoryLog } from "../log.ts";
import { findOrder } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { usdcAta } from "../solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "../solana/constants.ts";
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
import { seedOrder, seedPayment } from "../testing/orders.ts";
import {
    buildRefundTransaction,
    pauseRefunds,
    type RefundDeps,
    refundsPaused,
    resumeRefunds,
    runRefunds,
} from "./executor.ts";
import { findRefund, type RefundRow, requestRefund } from "./request.ts";

const T0 = new Date("2030-01-01T12:00:00Z");
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const FRESH_BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(2));
const STALL_MS = 100;

let db: TestDb;
let feePayer: KeyPairSigner;
let refundSigner: KeyPairSigner;
let payer: KeyPairSigner;
let SOURCE: Address;
let defaults: Settings["refunds"];
let rpcTimeoutMs: number;
let log: ReturnType<typeof memoryLog>;

beforeAll(async () => {
    db = await testDb();
    feePayer = await testSigner(4);
    refundSigner = await testSigner(5);
    payer = await testSigner(6);
    SOURCE = await usdcAta(payer.address);
    const recipient = (await testSigner(1)).address;
    const settings = parseSettings(stringify({ solana: { recipient } }), "test");
    defaults = settings.refunds;
    rpcTimeoutMs = settings.solana.rpc_timeout;
});
afterAll(async () => {
    await db.close();
});
// The executor scans every refund, so each test starts from an empty table and running refunds
beforeEach(async () => {
    await db.pool.query("truncate orders cascade");
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
    expect((await runRefunds(deps(okRpc(), T0, cfg))).sent).toBe(1);
    const refund = (await findRefund(db.pool, order.id))!;
    expect(refund).toMatchObject({ state: "sent", attempts: 1, sentAt: T0 });
    return { order, refund };
}

describe("buildRefundTransaction", () => {
    it("builds a two-signature TransferChecked to the payment source, nothing else", async () => {
        const d = deps(okRpc());
        const hint = { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: TEST_LVBH };
        const built = await buildRefundTransaction(
            d,
            { destination: SOURCE, amountMicros: 10_000 },
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
                const row = (await findRefund(db.pool, order.id))!;
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
        const tick = await runRefunds(deps(rpc));
        expect(tick).toEqual({
            sent: 1,
            resent: 0,
            resigned: 0,
            confirmed: 0,
            manual: 0,
            paused: null,
        });
        const row = (await findRefund(db.pool, order.id))!;
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
        const tick = await runRefunds({ ...deps(rpc), pool });
        expect(tick.sent).toBe(1);
        expect(connects).toBeGreaterThanOrEqual(3);
        expect((await findRefund(db.pool, order.id))!.state).toBe("sent");
    });

    it("confirms and marks the order refunded", async () => {
        const { order } = await sentRefund();
        const tick = await runRefunds(deps(okRpc(), later(30_000)));
        expect(tick.confirmed).toBe(1);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        await runRefunds(deps(rpc, later(30_000)));
        expect(await findRefund(db.pool, order.id)).toMatchObject({ state: "sent", attempts: 1 });
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
    });

    it("leaves a just-sent refund alone for 20 s", async () => {
        await sentRefund();
        const rpc = okRpc();
        await runRefunds(deps(rpc, later(10_000)));
        await runRefunds(deps(rpc, later(19_999)));
        expect(rpc.calls.getSignatureStatuses).toBe(0);
        expect(rpc.calls.sendTransaction).toBe(0);
        await runRefunds(deps(rpc, later(20_000)));
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
        const tick = await runRefunds(deps(rpc, later(30_000)));
        expect(tick.resent).toBe(1);
        expect(recorder.sends).toEqual([
            {
                wire: refund.wireTx,
                config: { encoding: "base64", skipPreflight: true, maxRetries: 0n },
            },
        ]);
        expect(rpc.calls.getLatestBlockhash).toBe(0);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        const tick = await runRefunds(deps(rpc, later(30_000)));
        expect(tick.resigned).toBe(1);
        const after = (await findRefund(db.pool, order.id))!;
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
        const tick = await runRefunds(deps(rpc, later(30_000)));
        expect(tick).toMatchObject({ confirmed: 1, resigned: 0, resent: 0 });
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        expect((await runRefunds(deps(rpc, later(30_000)))).resigned).toBe(1);
        const second = (await findRefund(db.pool, order.id))!;
        expect(second.previousSignatures).toEqual([first.txSignature]);

        firstLanded = true;
        const tick = await runRefunds(deps(rpc, later(60_000)));
        expect(tick).toMatchObject({ confirmed: 1, resigned: 0, resent: 0 });
        expect(reads.at(-1)).toEqual([second.txSignature, first.txSignature]);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        await runRefunds(deps(rpc, later(30_000)));
        const second = (await findRefund(db.pool, order.id))!;
        await runRefunds(deps(rpc, later(60_000)));
        const third = (await findRefund(db.pool, order.id))!;
        expect(third.previousSignatures).toEqual([first.txSignature, second.txSignature]);

        landed = second.txSignature;
        expect((await runRefunds(deps(rpc, later(90_000)))).confirmed).toBe(1);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        const tick = await runRefunds(deps(rpc, later(30_000)));
        expect(tick).toMatchObject({ resigned: 0, resent: 1 });
        expect(rpc.sent).toEqual([refund.wireTx]);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        const tick = await runRefunds(deps(rpc, later(30_000), { max_attempts: 1 }));
        expect(tick.manual).toBe(1);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        expect((await runRefunds(deps(failing))).sent).toBe(0);
        const signed = (await findRefund(db.pool, order.id))!;
        expect(signed).toMatchObject({ state: "signed", attempts: 1, sentAt: null });
        expect(alarms("manual_queue")).toEqual([]);

        const rpc = okRpc({
            getSignatureStatuses: notFound,
            getEpochInfo: () => epochAt(TEST_LVBH),
        });
        expect((await runRefunds(deps(rpc, later(30_000)))).resent).toBe(1);
        expect(rpc.sent).toEqual([signed.wireTx]);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        await runRefunds(deps(rpc));
        expect((await findRefund(db.pool, order.id))!.state).toBe("pending");
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
        await runRefunds(deps(rpc));
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
        expect((await findRefund(db.pool, order.id))!.state).toBe("sent");
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
            await runRefunds(deps(rpc));
            expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        await runRefunds(deps(rpc, later(30_000)));
        expect(await findRefund(db.pool, order.id)).toEqual(refund);
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
        expect(log.lines.some((l) => l.level === "alarm")).toBe(false);
        expect(rpc.calls.sendTransaction).toBe(0);
        expect(levels("warn")).toHaveLength(1);
        expect(levels("error")).toEqual([]);
    });

    it("queues a landed failure for an operator", async () => {
        const { order } = await sentRefund();
        const rpc = okRpc({ getSignatureStatuses: () => ({ value: [LANDED_FAILED] }) });
        const tick = await runRefunds(deps(rpc, later(30_000)));
        expect(tick.manual).toBe(1);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        const tick = await runRefunds(deps(rpc));
        expect(tick.manual).toBe(1);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        await runRefunds(deps(rpc));
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        const tick = await runRefunds(deps(rpc, T0, { daily_cap_micros: 20_000 }));
        expect(tick).toMatchObject({ sent: 1, manual: 1, paused: null });
        expect(await findRefund(db.pool, large.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_exceeds_cap",
            txSignature: null,
        });
        expect(await findOrder(db.pool, large.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_exceeds_cap",
        });
        expect((await findRefund(db.pool, small.id))!.state).toBe("sent");
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
        const tick = await runRefunds(deps(rpc, T0, { daily_cap_micros: 20_000 }));
        expect(tick).toMatchObject({ sent: 1, paused: "daily_cap" });
        expect((await findRefund(db.pool, first.id))!.state).toBe("sent");
        expect((await findRefund(db.pool, second.id))!.state).toBe("pending");
        expect(await refundsPaused(db.pool)).toBe("daily_cap");
        expect(alarms("refunds_paused")).toEqual([
            expect.objectContaining({ reason: "daily_cap" }),
        ]);

        const again = await runRefunds(deps(rpc, later(60_000), { daily_cap_micros: 20_000 }));
        expect(again).toEqual({
            sent: 0,
            resent: 0,
            resigned: 0,
            confirmed: 1,
            manual: 0,
            paused: "daily_cap",
        });
        expect((await findRefund(db.pool, first.id))!.state).toBe("confirmed");
        expect((await findRefund(db.pool, second.id))!.state).toBe("pending");
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
        await Promise.all([runRefunds(deps(rpc, T0, cfg)), runRefunds(deps(rpc, T0, cfg))]);
        expect(rpc.calls.sendTransaction).toBe(1);
        const states = [
            (await findRefund(db.pool, first.id))!.state,
            (await findRefund(db.pool, second.id))!.state,
        ];
        expect(states.sort()).toEqual(["pending", "sent"]);
        expect(await refundsPaused(db.pool)).toBe(reason);
    });

    it("subtracts refunds signed or sent but not confirmed from the float", async () => {
        const first = await pendingRefund(10_000);
        const second = await pendingRefund(10_001);
        const rpc = okRpc({ getTokenAccountBalance: () => usdcBalance(15_000) });
        const tick = await runRefunds(deps(rpc));
        expect(tick).toMatchObject({ sent: 1, paused: "float_low" });
        expect((await findRefund(db.pool, first.id))!.state).toBe("sent");
        expect(await findRefund(db.pool, second.id)).toMatchObject({
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
        const tick = await runRefunds(deps(okRpc(), T0, { max_per_hour: 1 }));
        expect(tick).toMatchObject({ sent: 1, paused: "hourly_rate" });
        expect((await findRefund(db.pool, first.id))!.state).toBe("sent");
        expect((await findRefund(db.pool, second.id))!.state).toBe("pending");
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
        const later2h = await runRefunds(deps(low, later(7_200_000), { max_per_hour: 1 }));
        expect(later2h).toMatchObject({ confirmed: 1, sent: 0, paused: "float_low" });
        expect((await findRefund(db.pool, second.id))!.state).toBe("pending");
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
        const tick = await runRefunds(deps(rpc));
        expect(tick.manual).toBe(1);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        await Promise.all([runRefunds(deps(rpc)), runRefunds(deps(rpc))]);
        expect(new Set(rpc.sent).size).toBe(1);
        expect(rpc.calls.sendTransaction).toBe(1);
        expect((await findRefund(db.pool, order.id))!.attempts).toBe(1);
    });

    it("warns when the RPC answers another signature", async () => {
        const order = await pendingRefund();
        const other = getBase58Decoder().decode(new Uint8Array(64).fill(9));
        const rpc = okRpc({ sendTransaction: () => other });
        expect((await runRefunds(deps(rpc))).sent).toBe(1);
        const row = (await findRefund(db.pool, order.id))!;
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
        const tick = await runRefunds(deps(okRpc()));
        expect(tick.sent).toBe(5);
        const states = [];
        for (const o of orders) states.push((await findRefund(db.pool, o.id))!.state);
        expect(states).toEqual(["sent", "sent", "sent", "sent", "sent", "pending"]);
    });

    it("signs an identical twin refund on a later blockhash", async () => {
        const first = await pendingRefund();
        const twin = await pendingRefund();
        expect((await runRefunds(deps(okRpc()))).sent).toBe(1);
        expect((await findRefund(db.pool, first.id))!.state).toBe("sent");
        expect((await findRefund(db.pool, twin.id))!.state).toBe("pending");
        expect(log.lines.some((l) => l.level === "alarm")).toBe(false);

        const fresh = okRpc({
            getLatestBlockhash: () => ({
                value: { blockhash: FRESH_BLOCKHASH, lastValidBlockHeight: 2_000n },
            }),
        });
        expect(await runRefunds(deps(fresh, later(30_000)))).toMatchObject({
            confirmed: 1,
            sent: 1,
        });
        const a = (await findRefund(db.pool, first.id))!;
        const b = (await findRefund(db.pool, twin.id))!;
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
        const tick = await runRefunds({ ...deps(rpc, at), rpcTimeoutMs: STALL_MS });
        expect(performance.now() - started).toBeLessThan(STALL_MS + 900);
        return tick;
    }

    it.each(["getAccountInfo", "getTokenAccountBalance", "getLatestBlockhash"] as const)(
        "gives up on a stalled %s within solana.rpc_timeout and leaves the pending refund",
        async (method) => {
            const order = await pendingRefund();
            const before = await findRefund(db.pool, order.id);
            const rpc = okRpc({ [method]: neverAnswers });

            expect(await stalledTick(rpc)).toMatchObject({ sent: 0, manual: 0, paused: null });
            expect(await findRefund(db.pool, order.id)).toEqual(before);
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
            expect(await findRefund(db.pool, order.id)).toEqual(refund);
            expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
            expect(levels("warn")).toEqual([timedOut(order.id)]);
            expect(levels("error")).toEqual([]);
        },
    );

    it("keeps a refund signed, not sent, when its first send stalls", async () => {
        const order = await pendingRefund();
        const rpc = okRpc({ sendTransaction: neverAnswers });

        expect((await stalledTick(rpc)).sent).toBe(0);
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
        const tick = await runRefunds(deps(rpc, later(30_000)));
        expect(tick).toEqual({
            sent: 0,
            resent: 0,
            resigned: 0,
            confirmed: 1,
            manual: 0,
            paused: "daily_cap",
        });
        expect((await findRefund(db.pool, sent.id))!.state).toBe("confirmed");
        expect((await findOrder(db.pool, sent.id))!.state).toBe("refunded");
        expect(await findRefund(db.pool, pending.id)).toMatchObject({
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
        const tick = await runRefunds(deps(rpc, later(30_000)));
        expect(tick).toMatchObject({ confirmed: 1, sent: 0, paused: "operator" });
        expect((await findRefund(db.pool, pending.id))!.state).toBe("pending");
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
        const tick = await runRefunds(deps(rpc, later(30_000)));
        expect(tick).toMatchObject({ resent: 0, resigned: 0, paused: "hourly_rate" });
        expect(await findRefund(db.pool, order.id)).toEqual(refund);
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
        const tick = await runRefunds(deps(rpc, later(30_000), { max_attempts: 1 }));
        expect(tick).toMatchObject({ manual: 1, paused: "daily_cap" });
        expect(await findRefund(db.pool, order.id)).toMatchObject({
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
