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

let db: TestDb;
let feePayer: KeyPairSigner;
let refundSigner: KeyPairSigner;
let payer: KeyPairSigner;
let SOURCE: Address;
let defaults: Settings["refunds"];
let log: ReturnType<typeof memoryLog>;

beforeAll(async () => {
    db = await testDb();
    feePayer = await testSigner(4);
    refundSigner = await testSigner(5);
    payer = await testSigner(6);
    SOURCE = await usdcAta(payer.address);
    const recipient = (await testSigner(1)).address;
    defaults = parseSettings(stringify({ solana: { recipient } }), "test").refunds;
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
        expect(rpc.calls.getBlockHeight).toBe(0);
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
            getBlockHeight: () => TEST_LVBH,
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
            getBlockHeight: () => TEST_LVBH + 1n,
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

    it("queues a refund that expired max_attempts times for an operator", async () => {
        const { order } = await sentRefund({ max_attempts: 1 });
        const rpc = okRpc({ getSignatureStatuses: notFound, getBlockHeight: () => TEST_LVBH + 1n });
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

        const rpc = okRpc({ getSignatureStatuses: notFound, getBlockHeight: () => TEST_LVBH });
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
        ["getBlockHeight", { getSignatureStatuses: notFound }],
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
    });

    it("queues a landed failure for an operator", async () => {
        const { order } = await sentRefund();
        const rpc = okRpc({
            getSignatureStatuses: () => ({
                value: [
                    {
                        confirmationStatus: "confirmed",
                        err: { InstructionError: [2, { Custom: 1 }] },
                        slot: 1n,
                    },
                ],
            }),
        });
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
            confirmed: 0,
            manual: 0,
            paused: "daily_cap",
        });
        expect(rpc.calls.sendTransaction).toBe(1);
        expect(rpc.calls.getSignatureStatuses).toBe(0);
        expect(alarms("refunds_paused")).toHaveLength(1);
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
