import { create } from "@bufbuild/protobuf";
import { DurationSchema, TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
    AccountRole,
    getBase64Encoder,
    getSignatureFromTransaction,
    getTransactionDecoder,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PayerVerdict } from "../gen/bugnet/router/v1/payments_pb.ts";
import { memoryLog, silentLog } from "../log.ts";
import { RateLimiter } from "../ratelimit.ts";
import { stringify } from "smol-toml";
import { parseSettings } from "../config.ts";
import { createRouterClient, type RouterClient } from "../router/client.ts";
import { usdcAta } from "../solana/accounts.ts";
import { BlockhashCache } from "../solana/blockhash.ts";
import { LIGHTHOUSE_PROGRAM, SOLANA_MAINNET, TOKEN_PROGRAM } from "../solana/constants.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import {
    createFakeRpc,
    epochAt,
    type FakeRpc,
    neverAnswers,
    TEST_BLOCKHASH,
    TEST_LVBH,
} from "../testing/fake-rpc.ts";
import { type FakeRouter, startFakeRouter } from "../testing/fake-router.ts";
import { testSigner } from "../testing/keys.ts";
import { seedAllowanceOrder, seedOrder, seedPayment } from "../testing/orders.ts";
import { signedPayment } from "../testing/payment.ts";
import { setControls } from "../x402/controls.ts";
import { seedAccount } from "../testing/x402.ts";
import { randomBytes } from "node:crypto";
import { type ChallengeContext, requirementsFor } from "../x402/challenge.ts";
import { decodePayment } from "../x402/decode.ts";
import { reconcileSettling } from "../jobs/reconciler.ts";
import { readPool } from "../x402/ledger.ts";
import { createAllowanceFunding } from "../x402/funding.ts";
import { createSettler, type Settler } from "../x402/settler.ts";
import { createPayDeps, type PayDeps, payOrder } from "./pay.ts";
import {
    archivePayment,
    confirmPayment,
    findOrder,
    findPaymentByOrder,
    setOrderState,
} from "./store.ts";
import type { OrderRow } from "./types.ts";

const payer = await testSigner(3);
const payer2 = await testSigner(4);
const feePayer = await testSigner(5);
const FEE_PAYER = feePayer.address;
const challenge: ChallengeContext = {
    publicUrl: "https://pay.bugnet.sh",
    recipient: (await testSigner(1)).address,
    allowanceWallet: (await testSigner(11)).address,
    feePayer: FEE_PAYER,
    transactionVersions: [0],
};
const X = parseSettings(stringify({ solana: { recipient: challenge.recipient } }), "t").x402;
const paidDeps = {
    funding: createAllowanceFunding({ x402: X, log: silentLog }),
    x402: X,
    log: silentLog,
};
const open = { x402: X, signer: { open: () => true }, paid: paidDeps };
const caps = {
    maxComputeUnits: 50_000,
    maxPriorityFeeMicroLamports: 10_000,
    maxRequiredSignatures: 2,
};
const NOW = new Date("2030-01-01T00:05:00Z");
const EXPIRES = new Date("2030-01-01T00:10:00Z");
const BLOCKED_UNTIL = "2030-01-02T00:00:00.000Z";

const hints = new BlockhashCache(createFakeRpc(), 8_000);
await hints.latest();

const sig = () => AbortSignal.timeout(5_000);

type Verdict = PayerVerdict | "invalid" | "unavailable";

function withHints(r: PaymentRequirements): PaymentRequirements {
    return {
        ...r,
        extra: {
            ...r.extra,
            recentBlockhash: TEST_BLOCKHASH,
            lastValidBlockHeight: String(TEST_LVBH),
        },
    };
}

function settlerOn(rpc: FakeRpc, cache: BlockhashCache = hints, rpcTimeoutMs = 10_000): Settler {
    return createSettler({
        feePayer,
        rpc,
        hints: cache,
        caps,
        transactionVersions: [0],
        rpcTimeoutMs,
        log: silentLog,
    });
}

function clientFor(fake: FakeRouter, checkPayer = true): RouterClient {
    return createRouterClient({
        url: fake.url,
        token: "rt",
        timeoutMs: 1_000,
        checkPayer,
        getOrder: false,
        log: silentLog,
    });
}

const routers: FakeRouter[] = [];

async function startRouter(verdict: Verdict): Promise<FakeRouter> {
    const fake = await startFakeRouter({
        checkPayer: () => {
            if (verdict === "invalid") throw new ConnectError("bad payer", Code.InvalidArgument);
            return {
                verdict: verdict === "unavailable" ? PayerVerdict.OK : verdict,
                retryAfter: create(DurationSchema, { seconds: 7n }),
                blockedUntil: create(TimestampSchema, {
                    seconds: BigInt(Date.parse(BLOCKED_UNTIL) / 1000),
                }),
            };
        },
    });
    if (verdict === "unavailable") await fake.close();
    else routers.push(fake);
    return fake;
}

let db: TestDb;
let rpc: FakeRpc;
let order: OrderRow;
let req: PaymentRequirements;
let p: PaymentPayload;
let router: FakeRouter;
let d: PayDeps;

async function dWithRouter(verdict: Verdict): Promise<PayDeps> {
    return { ...d, router: clientFor(await startRouter(verdict)) };
}

async function paymentFor(o: OrderRow, who = payer): Promise<PaymentPayload> {
    return signedPayment(withHints(requirementsFor(o, challenge)), who);
}

async function stateOf(id: string) {
    return (await findOrder(db.pool, id))!.state;
}

function quietConsole() {
    return vi.spyOn(console, "error").mockImplementation(() => {});
}

const CONFIRMED = {
    value: [{ confirmationStatus: "confirmed", err: null, slot: 1n, confirmations: 1n }],
};

// Runs fn inside the settler's first confirmation poll, after the settling commit
function confirmingAfter(fn: () => Promise<void>): FakeRpc {
    let first = true;
    return createFakeRpc({
        getSignatureStatuses: async () => {
            if (first) {
                first = false;
                await fn();
            }
            return CONFIRMED;
        },
    });
}

function landedRpc(): FakeRpc {
    return createFakeRpc({
        getSignatureStatuses: () => CONFIRMED,
        getEpochInfo: () => epochAt(900n),
    });
}

function sentSignature(r: FakeRpc): string {
    return getSignatureFromTransaction(
        getTransactionDecoder().decode(getBase64Encoder().encode(r.sent[0]!)),
    );
}

async function markPaidByReconciler(id: string): Promise<void> {
    const payment = (await findPaymentByOrder(db.pool, id))!;
    await confirmPayment(db.pool, id, NOW);
    await setOrderState(db.pool, id, "settling", "paid", { paidAt: payment.createdAt });
}

function within<T>(ms: number, p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

beforeEach(async () => {
    rpc = createFakeRpc();
    ({ order } = await seedOrder(db.pool, { expiresAt: EXPIRES }));
    req = withHints(requirementsFor(order, challenge));
    p = await signedPayment(req, payer);
    router = await startRouter(PayerVerdict.OK);
    d = createPayDeps({
        pool: db.pool,
        settler: settlerOn(rpc),
        router: clientFor(router),
        attempts: new RateLimiter(5, 60_000, () => 0),
        challenge,
        x402: open,
        log: silentLog,
        now: () => NOW,
    });
});
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(routers.splice(0).map((r) => r.close()));
});

describe("payOrder", () => {
    it("pays an unpaid order", async () => {
        const out = await payOrder(d, order.id, await signedPayment(req, payer), sig());
        expect(out).toMatchObject({ kind: "paid", orderId: order.id, payer: payer.address });
        const payment = (await findPaymentByOrder(db.pool, order.id))!;
        expect(payment).toMatchObject({
            status: "confirmed",
            amountMicros: 10_000,
            sourceTokenAccount: await usdcAta(payer.address),
            payer: payer.address,
            blockhash: TEST_BLOCKHASH,
            lastValidBlockHeight: TEST_LVBH,
        });
        expect(out).toEqual({
            kind: "paid",
            orderId: order.id,
            payer: payer.address,
            signature: payment.txSignature,
        });
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "paid",
            paidAt: payment.createdAt,
            payer: payer.address,
        });
        expect(rpc.calls.sendTransaction).toBe(1);
        expect(router.headers).toHaveLength(1);
    });

    it("stamps the payment and paid_at from the injected clock", async () => {
        d.now = () => new Date("2030-01-01T00:00:00Z");
        const out = await payOrder(d, order.id, await signedPayment(req, payer), sig());
        expect(out.kind).toBe("paid");
        expect((await findPaymentByOrder(db.pool, order.id))!.createdAt).toEqual(
            new Date("2030-01-01T00:00:00Z"),
        );
        expect((await findOrder(db.pool, order.id))!.paidAt).toEqual(
            new Date("2030-01-01T00:00:00Z"),
        );
    });

    it("pays without asking the router when CheckPayer is off", async () => {
        const out = await payOrder({ ...d, router: clientFor(router, false) }, order.id, p, sig());
        expect(out.kind).toBe("paid");
        expect(router.headers).toHaveLength(0);
    });

    it("answers unknown and expired orders before any RPC", async () => {
        const { order: expired } = await seedOrder(db.pool, {
            state: "expired",
            expiresAt: new Date("2030-01-01T00:00:00Z"),
        });
        const { order: lapsed } = await seedOrder(db.pool, { expiresAt: NOW });
        expect(await payOrder(d, "ord_zzzzzzzzzzzzzzzzzzzzzzzzzz", p, sig())).toEqual({
            kind: "refused",
            orderId: "ord_zzzzzzzzzzzzzzzzzzzzzzzzzz",
            httpStatus: 404,
            reason: "order_unknown",
        });
        expect(await payOrder(d, expired.id, p, sig())).toMatchObject({
            kind: "refused",
            httpStatus: 410,
            reason: "order_expired",
        });
        expect(await payOrder(d, lapsed.id, p, sig())).toMatchObject({
            kind: "refused",
            httpStatus: 410,
            reason: "order_expired",
        });
        expect(Object.values(rpc.calls).reduce((a, b) => a + b, 0)).toBe(0);
        expect(router.headers).toHaveLength(0);
        expect(await stateOf(lapsed.id)).toBe("unpaid");
    });

    it.each(["refunding", "refunded", "manual"] as const)(
        "answers order_closed for a %s order",
        async (state) => {
            const { order: closed } = await seedOrder(db.pool, { state, expiresAt: EXPIRES });
            expect(await payOrder(d, closed.id, p, sig())).toEqual({
                kind: "refused",
                orderId: closed.id,
                httpStatus: 410,
                reason: "order_closed",
            });
            expect(Object.values(rpc.calls).reduce((a, b) => a + b, 0)).toBe(0);
        },
    );

    it("never settles a paid or settling order", async () => {
        const { order: paid } = await seedOrder(db.pool, {
            state: "paid",
            expiresAt: EXPIRES,
            paidAt: NOW,
            payer: payer2.address,
        });
        await seedPayment(db.pool, paid.id, { status: "confirmed", payer: payer2.address });
        const { order: redeemed } = await seedOrder(db.pool, {
            state: "redeemed",
            expiresAt: EXPIRES,
        });
        await seedPayment(db.pool, redeemed.id, { status: "confirmed" });
        const { order: settling } = await seedOrder(db.pool, {
            state: "settling",
            expiresAt: EXPIRES,
        });
        await seedPayment(db.pool, settling.id);

        expect(await payOrder(d, paid.id, p, sig())).toEqual({
            kind: "already_paid",
            orderId: paid.id,
            samePayment: false,
        });
        expect(await payOrder(d, paid.id, { junk: 1 }, sig())).toEqual({
            kind: "already_paid",
            orderId: paid.id,
            samePayment: false,
        });
        expect(await payOrder(d, redeemed.id, p, sig())).toMatchObject({
            kind: "already_paid",
            samePayment: false,
        });
        expect(await payOrder(d, settling.id, p, sig())).toEqual({
            kind: "settling",
            orderId: settling.id,
        });
        expect(rpc.calls.sendTransaction ?? 0).toBe(0);
        expect(router.headers).toHaveLength(0);
    });

    it.each([
        ["blocked", PayerVerdict.BLOCKED, 403, "payer_blocked", { blockedUntil: BLOCKED_UNTIL }],
        ["busy", PayerVerdict.BUSY, 429, "payer_busy", { retryAfterSeconds: 7 }],
        [
            "rate limited",
            PayerVerdict.RATE_LIMITED,
            429,
            "payer_rate_limited",
            { retryAfterSeconds: 7 },
        ],
        ["invalid", "invalid", 422, "payer_invalid", {}],
        ["router closed", "unavailable", 503, "router_unavailable", {}],
    ] as const)(
        "CheckPayer %s refuses with no charge",
        async (_n, verdict, status, reason, more) => {
            expect(await payOrder(await dWithRouter(verdict), order.id, p, sig())).toEqual({
                kind: "refused",
                orderId: order.id,
                httpStatus: status,
                reason,
                ...more,
            });
            expect(rpc.calls.simulateTransaction ?? 0).toBe(0);
            expect(rpc.calls.sendTransaction).toBe(0);
            expect(await stateOf(order.id)).toBe("unpaid");
            expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
        },
    );

    it("refuses the sixth attempt in a minute", async () => {
        const busyRouter = await startRouter(PayerVerdict.BUSY);
        const busy = { ...d, router: clientFor(busyRouter) };
        for (let i = 0; i < 5; i++) {
            expect(await payOrder(busy, order.id, p, sig())).toMatchObject({
                httpStatus: 429,
                reason: "payer_busy",
            });
        }
        expect(await payOrder(busy, order.id, p, sig())).toEqual({
            kind: "refused",
            orderId: order.id,
            httpStatus: 429,
            reason: "too_many_attempts",
            retryAfterSeconds: 60,
        });
        expect(busyRouter.headers).toHaveLength(5);
        expect(
            await payOrder(busy, order.id, await signedPayment(req, payer2), sig()),
        ).toMatchObject({ reason: "payer_busy" });
        expect(busyRouter.headers).toHaveLength(6);
    });

    it("lets the real payer settle after junk headers", async () => {
        for (let i = 0; i < 10; i++) {
            expect(await payOrder(d, order.id, { junk: i }, sig())).toMatchObject({
                kind: "refused",
                reason: "payment_invalid",
            });
        }
        expect(await payOrder(d, order.id, await signedPayment(req, payer), sig())).toMatchObject({
            kind: "paid",
        });
    });

    it("refuses malformed payments with 400", async () => {
        const raw = { x402Version: 2, accepted: {}, payload: {} };
        expect(await payOrder(d, order.id, raw, sig())).toEqual({
            kind: "refused",
            orderId: order.id,
            httpStatus: 400,
            reason: "payment_malformed",
        });
    });

    it("refuses payments for another order without spending the payer's attempts", async () => {
        const { order: other } = await seedOrder(db.pool, { expiresAt: EXPIRES });
        const forOther = await paymentFor(other);
        for (let i = 0; i < 6; i++) {
            expect(await payOrder(d, order.id, forOther, sig())).toEqual({
                kind: "refused",
                orderId: order.id,
                httpStatus: 422,
                reason: "payment_order_mismatch",
            });
        }
        expect(router.headers).toHaveLength(0);
        expect(await payOrder(d, order.id, p, sig())).toMatchObject({ kind: "paid" });
    });

    it("refuses accepted terms that differ from the order", async () => {
        const p2 = await signedPayment(req, payer, { accepted: { ...req, amount: "9999" } });
        expect(await payOrder(d, order.id, p2, sig())).toMatchObject({
            httpStatus: 422,
            reason: "payment_invalid",
            code: "accepted_mismatch",
        });
        expect(router.headers).toHaveLength(0);
        expect(rpc.calls.simulateTransaction).toBe(0);
    });

    it("refuses a Lighthouse instruction that references the fee payer", async () => {
        const lh = {
            programAddress: LIGHTHOUSE_PROGRAM,
            accounts: [{ address: FEE_PAYER, role: AccountRole.READONLY }],
            data: new Uint8Array([0]),
        };
        const out = await payOrder(
            d,
            order.id,
            await signedPayment(req, payer, { extraInstructions: [lh] }),
            sig(),
        );
        expect(out).toMatchObject({
            httpStatus: 422,
            reason: "payment_invalid",
            code: "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts",
        });
        expect(rpc.calls.simulateTransaction ?? 0).toBe(0);
        expect(router.headers).toHaveLength(0);
    });

    it("refuses with the facilitator's reason when verification fails", async () => {
        const failing = createFakeRpc({
            simulateTransaction: () => ({
                value: { err: "InsufficientFundsForFee", logs: [], unitsConsumed: 0n },
            }),
            getAccountInfo: () => ({ value: { owner: TOKEN_PROGRAM } }),
        });
        const out = await payOrder({ ...d, settler: settlerOn(failing) }, order.id, p, sig());
        expect(out).toEqual({
            kind: "refused",
            orderId: order.id,
            httpStatus: 422,
            reason: "payment_invalid",
            code: "invalid_exact_svm_transaction_simulation_failed",
        });
        expect(failing.calls.sendTransaction).toBe(0);
        expect(await stateOf(order.id)).toBe("unpaid");
        expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
    });

    it("refuses a message hash already recorded for another order", async () => {
        const consoleError = quietConsole();
        const { order: other } = await seedOrder(db.pool, { state: "paid", expiresAt: EXPIRES });
        await seedPayment(db.pool, other.id, {
            status: "confirmed",
            messageHash: decodePayment(p, challenge).messageHash,
        });
        expect(await payOrder(d, order.id, p, sig())).toEqual({
            kind: "refused",
            orderId: order.id,
            httpStatus: 409,
            reason: "payment_replayed",
        });
        expect(rpc.calls.sendTransaction).toBe(0);
        expect(await stateOf(order.id)).toBe("unpaid");
        expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
        expect(consoleError).toHaveBeenCalledWith(
            "Failed to send transaction:",
            new Error("commit_conflict"),
        );
    });

    it("settles once under concurrent payments", async () => {
        const p1 = p;
        const p2 = await signedPayment(req, payer2);
        const [a, b] = await Promise.all([
            payOrder(d, order.id, p1, sig()),
            payOrder(d, order.id, p2, sig()),
        ]);
        // The loser wakes on the winner's settling commit, or later on its paid commit
        expect([a.kind, b.kind]).toContain("paid");
        expect(a.kind === "paid" ? b.kind : a.kind).toMatch(/^(settling|already_paid)$/);
        expect(rpc.calls.sendTransaction).toBe(1);
        const winner = a.kind === "paid" ? payer : payer2;
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            payer: winner.address,
            status: "confirmed",
        });
    });

    it("answers already_paid to a second payment after the first returned", async () => {
        const p1 = p;
        const p2 = await signedPayment(req, payer2);
        const key = "toolu_01SETTLINGREQUESTKEY";
        const first = await payOrder(d, order.id, p1, sig(), key);
        expect(first).toMatchObject({ kind: "paid" });
        expect(await payOrder(d, order.id, p2, sig(), key)).toEqual({
            kind: "already_paid",
            orderId: order.id,
            samePayment: false,
        });
        const same = {
            kind: "already_paid",
            orderId: order.id,
            samePayment: true,
            signature: first.kind === "paid" ? first.signature : "",
            payer: payer.address,
        };
        expect(await payOrder(d, order.id, p1, sig(), key)).toEqual({ ...same, sameKey: true });
        expect(await payOrder(d, order.id, p1, sig())).toEqual({ ...same, sameKey: false });
        expect(await payOrder(d, order.id, p1, sig(), key + "x")).toEqual({
            ...same,
            sameKey: false,
        });
        expect(rpc.calls.sendTransaction).toBe(1);
    });

    it("answers paid when another worker marked the order paid during the confirmation wait", async () => {
        const racing = confirmingAfter(() => markPaidByReconciler(order.id));
        const out = await payOrder({ ...d, settler: settlerOn(racing) }, order.id, p, sig());
        expect(out).toEqual({
            kind: "paid",
            orderId: order.id,
            payer: payer.address,
            signature: sentSignature(racing),
        });
        expect(racing.calls.sendTransaction).toBe(1);
        expect(await stateOf(order.id)).toBe("paid");
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            status: "confirmed",
            confirmedAt: NOW,
        });
    });

    it("answers paid when the order was marked paid while its payment was still settling", async () => {
        const racing = confirmingAfter(() =>
            setOrderState(db.pool, order.id, "settling", "paid", { paidAt: NOW }),
        );
        const out = await payOrder({ ...d, settler: settlerOn(racing) }, order.id, p, sig());
        expect(out).toEqual({
            kind: "paid",
            orderId: order.id,
            payer: payer.address,
            signature: sentSignature(racing),
        });
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({ status: "settling" });
    });

    it("answers settling when the order left settling for another state during the wait", async () => {
        const racing = confirmingAfter(() =>
            setOrderState(db.pool, order.id, "settling", "expired"),
        );
        const out = await payOrder({ ...d, settler: settlerOn(racing) }, order.id, p, sig());
        expect(out).toEqual({ kind: "settling", orderId: order.id });
        expect(await stateOf(order.id)).toBe("expired");
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            status: "settling",
            confirmedAt: null,
        });
    });

    it("answers settling and leaves the order settling when the payment left settling", async () => {
        const log = memoryLog();
        const racing = confirmingAfter(async () => {
            await archivePayment(db.pool, order.id, "blockhash_expired");
        });
        const out = await payOrder({ ...d, settler: settlerOn(racing), log }, order.id, p, sig());
        expect(out).toEqual({ kind: "settling", orderId: order.id });
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "settling",
            paidAt: null,
        });
        expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
        expect(log.lines).toContainEqual(
            expect.objectContaining({
                level: "error",
                orderId: order.id,
                signature: sentSignature(racing),
            }),
        );
    });

    it("answers settling when writing paid fails after the settling commit", async () => {
        const log = memoryLog();
        let connects = 0;
        const pool = {
            connect: () =>
                ++connects === 1 ? db.pool.connect() : Promise.reject(new Error("db down")),
            query: db.pool.query.bind(db.pool),
        } as unknown as pg.Pool;
        const out = await payOrder({ ...d, pool, log }, order.id, p, sig());
        expect(out).toEqual({ kind: "settling", orderId: order.id });
        expect(connects).toBe(2);
        expect(rpc.calls.sendTransaction).toBe(1);
        expect(await stateOf(order.id)).toBe("settling");
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({ status: "settling" });
        expect(log.lines).toContainEqual(
            expect.objectContaining({ level: "error", msg: "marking the order paid failed" }),
        );
    });

    it("answers settling when the re-read after a lost race fails", async () => {
        const log = memoryLog();
        const pool = {
            connect: db.pool.connect.bind(db.pool),
            query: () => Promise.reject(new Error("db down")),
        } as unknown as pg.Pool;
        const racing = confirmingAfter(() => markPaidByReconciler(order.id));
        const out = await payOrder(
            { ...d, pool, settler: settlerOn(racing), log },
            order.id,
            p,
            sig(),
        );
        expect(out).toEqual({ kind: "settling", orderId: order.id });
        expect(await stateOf(order.id)).toBe("paid");
        expect(log.lines).toContainEqual(
            expect.objectContaining({ level: "error", msg: "re-reading the order failed" }),
        );
    });

    it("stamps confirmed_at when confirmation returns and paid_at with the record time", async () => {
        const LATER = new Date("2030-01-01T00:05:20Z");
        let clock = NOW;
        const slow = confirmingAfter(async () => {
            clock = LATER;
        });
        const out = await payOrder(
            { ...d, settler: settlerOn(slow), now: () => clock },
            order.id,
            p,
            sig(),
        );
        expect(out.kind).toBe("paid");
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            status: "confirmed",
            createdAt: NOW,
            confirmedAt: LATER,
        });
        expect((await findOrder(db.pool, order.id))!.paidAt).toEqual(NOW);
    });

    it("frees its pool client while waiting for confirmation", async () => {
        const small = new pg.Pool({ connectionString: db.url, max: 2 });
        let release = () => {};
        const held = new Promise<void>((r) => (release = r));
        let waiting = 0;
        let bothWaiting = () => {};
        const both = new Promise<void>((r) => (bothWaiting = r));
        const slow = createFakeRpc({
            getSignatureStatuses: async () => {
                if (++waiting === 2) bothWaiting();
                await held;
                return CONFIRMED;
            },
        });
        const { order: second } = await seedOrder(db.pool, { expiresAt: EXPIRES });
        const pd = { ...d, pool: small, settler: settlerOn(slow) };
        try {
            const payments = Promise.all([
                payOrder(pd, order.id, p, sig()),
                payOrder(pd, second.id, await paymentFor(second, payer2), sig()),
            ]);
            await within(5_000, both);
            expect(await within(1_000, small.query("select 1 as one"))).toMatchObject({
                rows: [{ one: 1 }],
            });
            release();
            expect((await payments).map((o) => o.kind)).toEqual(["paid", "paid"]);
            expect(await stateOf(second.id)).toBe("paid");
        } finally {
            release();
            await small.end();
        }
    });

    it("refuses with 503 and sends nothing when block height is unavailable at record time", async () => {
        const consoleError = quietConsole();
        const down = createFakeRpc({
            getBlockHeight: () => {
                throw new Error("rpc down");
            },
        });
        const unhinted = new BlockhashCache(down, 8_000);
        const out = await payOrder(
            { ...d, settler: settlerOn(down, unhinted) },
            order.id,
            p,
            sig(),
        );
        expect(out).toEqual({
            kind: "refused",
            orderId: order.id,
            httpStatus: 503,
            reason: "rpc_unavailable",
        });
        expect(down.calls.getBlockHeight).toBe(1);
        expect(down.calls.sendTransaction).toBe(0);
        expect(await stateOf(order.id)).toBe("unpaid");
        expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
        expect(consoleError).toHaveBeenCalledWith(
            "Failed to send transaction:",
            new Error("block_height_unavailable"),
        );
        expect(await payOrder(d, order.id, p, sig())).toMatchObject({ kind: "paid" });
    });

    it.each(["simulateTransaction", "getBlockHeight"] as const)(
        "gives up on a stalled %s before the broadcast with 503 and frees the order",
        async (method) => {
            quietConsole();
            const stalled = createFakeRpc({ [method]: neverAnswers });
            const unhinted = new BlockhashCache(stalled, 8_000);
            const started = performance.now();
            const out = await payOrder(
                { ...d, settler: settlerOn(stalled, unhinted, 300) },
                order.id,
                p,
                sig(),
            );
            expect(performance.now() - started).toBeLessThan(2_000);
            expect(out).toEqual({
                kind: "refused",
                orderId: order.id,
                httpStatus: 503,
                reason: "rpc_unavailable",
            });
            expect(stalled.calls.sendTransaction).toBe(0);
            expect(await stateOf(order.id)).toBe("unpaid");
            expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
            expect(await within(1_000, payOrder(d, order.id, p, sig()))).toMatchObject({
                kind: "paid",
            });
        },
    );

    it("leaves the order settling when confirmation is pending", async () => {
        const consoleError = quietConsole();
        const pending = createFakeRpc({
            getSignatureStatuses: () => {
                throw new Error("rpc down");
            },
        });
        const out = await payOrder({ ...d, settler: settlerOn(pending) }, order.id, p, sig());
        expect(out).toEqual({ kind: "settling", orderId: order.id });
        const sent = getSignatureFromTransaction(
            getTransactionDecoder().decode(getBase64Encoder().encode(pending.sent[0]!)),
        );
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "settling",
            payer: payer.address,
            paidAt: null,
        });
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            status: "settling",
            txSignature: sent,
            createdAt: NOW,
        });
        expect(consoleError).toHaveBeenCalledWith(
            "Failed to confirm transaction:",
            expect.any(Error),
        );
    });

    it("answers settling when the settler throws after the settling commit", async () => {
        const throwing: Settler = {
            feePayer: FEE_PAYER,
            transactionVersions: [0],
            async settle(attempt) {
                await attempt.commit({
                    messageHash: attempt.messageHash,
                    signature: "signature-test",
                    blockhash: TEST_BLOCKHASH,
                    lastValidBlockHeight: TEST_LVBH,
                });
                attempt.committed = true;
                throw new Error("facilitator crashed");
            },
        };
        expect(await payOrder({ ...d, settler: throwing }, order.id, p, sig())).toEqual({
            kind: "settling",
            orderId: order.id,
        });
        expect(await stateOf(order.id)).toBe("settling");
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            status: "settling",
            txSignature: "signature-test",
        });
    });

    it("throws on a second commit and writes nothing the second time", async () => {
        let second: unknown;
        const twice: Settler = {
            feePayer: FEE_PAYER,
            transactionVersions: [0],
            async settle(attempt) {
                const r = {
                    messageHash: attempt.messageHash,
                    signature: "signature-twice",
                    blockhash: TEST_BLOCKHASH,
                    lastValidBlockHeight: TEST_LVBH,
                };
                await attempt.commit(r);
                attempt.committed = true;
                second = await attempt
                    .commit({ ...r, signature: "signature-twice-2" })
                    .catch((e) => e);
                throw new Error("stop");
            },
        };
        await payOrder({ ...d, settler: twice }, order.id, p, sig());
        expect(second).toEqual(new Error("attempt already committed"));
        expect(await findPaymentByOrder(db.pool, order.id)).toMatchObject({
            txSignature: "signature-twice",
        });
    });

    it("refuses with 503 and records nothing when the settler throws before the commit", async () => {
        const throwing: Settler = {
            feePayer: FEE_PAYER,
            transactionVersions: [0],
            async settle() {
                throw new Error("facilitator crashed");
            },
        };
        expect(await payOrder({ ...d, settler: throwing }, order.id, p, sig())).toEqual({
            kind: "refused",
            orderId: order.id,
            httpStatus: 503,
            reason: "settlement_unavailable",
        });
        expect(await stateOf(order.id)).toBe("unpaid");
        expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
        expect(await payOrder(d, order.id, p, sig())).toMatchObject({ kind: "paid" });
    });

    it("refuses a settlement the facilitator already saw with 409", async () => {
        const dup: Settler = {
            feePayer: FEE_PAYER,
            transactionVersions: [0],
            async settle() {
                return {
                    success: false,
                    errorReason: "duplicate_settlement",
                    transaction: "",
                    network: SOLANA_MAINNET,
                };
            },
        };
        expect(await payOrder({ ...d, settler: dup }, order.id, p, sig())).toEqual({
            kind: "refused",
            orderId: order.id,
            httpStatus: 409,
            reason: "payment_replayed",
        });
        expect(await stateOf(order.id)).toBe("unpaid");
        expect(await findPaymentByOrder(db.pool, order.id)).toBeNull();
    });
});

describe("createPayDeps", () => {
    const deps = (over: Partial<ChallengeContext>): PayDeps => ({
        pool: db.pool,
        settler: settlerOn(createFakeRpc()),
        router: clientFor(router),
        attempts: new RateLimiter(5, 60_000, () => 0),
        challenge: { ...challenge, ...over },
        x402: open,
        log: silentLog,
        now: () => NOW,
    });

    it("accepts a settler and challenge that agree", () => {
        const ok = deps({});
        expect(createPayDeps(ok)).toBe(ok);
    });

    it("refuses a challenge fee payer the settler does not sign for", async () => {
        const other = (await testSigner(6)).address;
        expect(() => createPayDeps(deps({ feePayer: other }))).toThrow(/fee payer/);
    });

    it("refuses transaction versions that differ from the settler's", () => {
        expect(() => createPayDeps(deps({ transactionVersions: [0, 1] }))).toThrow(
            /transaction versions/,
        );
    });
});

function setPool(committed: number, unpaid: number) {
    return db.pool.query(
        "update x402_pool set committed_micros = $1, unpaid_micros = $2 where id = 1",
        [committed, unpaid],
    );
}

async function fundingCount(orderId: string): Promise<number> {
    const res = await db.pool.query<{ n: number }>(
        "select count(*)::int as n from x402_fundings where order_id = $1",
        [orderId],
    );
    return res.rows[0]!.n;
}

describe("allowance orders", () => {
    const EXPIRES_AT = EXPIRES;
    let hot: OrderRow;
    let handle: string;

    function hotDeps(over: { x402?: Partial<typeof X>; open?: boolean } = {}): PayDeps {
        return {
            ...d,
            x402: {
                x402: { ...X, enabled: true, ...over.x402 },
                signer: { open: () => over.open ?? true },
                paid: { ...paidDeps, x402: { ...X, enabled: true, ...over.x402 } },
            },
        };
    }

    beforeEach(async () => {
        handle = randomBytes(32).toString("hex");
        await seedAccount(db.pool, { handleSha256: handle, packageId: "cpu-small" });
        hot = (await seedAllowanceOrder(db.pool, { handleSha256: handle, expiresAt: EXPIRES_AT }))
            .order;
        await setPool(0, 5_000_000);
    });
    afterEach(async () => {
        await setControls(db.pool, { paused: false, disabled: false }, "test", NOW);
    });

    async function hotPayment(o: OrderRow = hot) {
        return signedPayment(withHints(requirementsFor(o, challenge)), payer);
    }

    it("refuses an allowance payment while paused, before verify", async () => {
        await setControls(db.pool, { paused: true }, "test", NOW);
        const asked: unknown[] = [];
        const fake = await startFakeRouter({
            checkPayer: (r) => {
                asked.push(r);
                return { verdict: PayerVerdict.OK };
            },
        });
        routers.push(fake);
        const deps = { ...hotDeps(), router: clientFor(fake) };
        const take = vi.spyOn(deps.attempts, "take");
        expect(await payOrder(deps, hot.id, await hotPayment(), sig())).toEqual({
            kind: "refused",
            orderId: hot.id,
            httpStatus: 503,
            reason: "x402_paused",
            charged: false,
            retryAfterSeconds: 30,
        });
        expect(asked).toHaveLength(0);
        expect(take).not.toHaveBeenCalled();
        expect(rpc.calls.sendTransaction).toBe(0);
        expect(rpc.calls.simulateTransaction).toBe(0);
        expect(await stateOf(hot.id)).toBe("unpaid");
        expect(await findPaymentByOrder(db.pool, hot.id)).toBeNull();
    });

    describe("a start order that carries an allowance", () => {
        let start: OrderRow;
        beforeEach(async () => {
            start = (
                await seedAllowanceOrder(db.pool, {
                    kind: "start",
                    packageId: "cpu-small",
                    handleSha256: null,
                    expiresAt: EXPIRES_AT,
                })
            ).order;
        });

        it("is stopped by pause and by the kill switch like an allowance order", async () => {
            await setControls(db.pool, { paused: true }, "test", NOW);
            expect(await payOrder(hotDeps(), start.id, await hotPayment(start), sig())).toEqual({
                kind: "refused",
                orderId: start.id,
                httpStatus: 503,
                reason: "x402_paused",
                charged: false,
                retryAfterSeconds: 30,
            });
            await setControls(db.pool, { paused: false, disabled: true }, "test", NOW);
            expect(await payOrder(hotDeps(), start.id, await hotPayment(start), sig())).toEqual({
                kind: "refused",
                orderId: start.id,
                httpStatus: 403,
                reason: "x402_disabled",
                charged: false,
            });
            expect(await stateOf(start.id)).toBe("unpaid");
        });

        it("keeps CheckPayer kind start", async () => {
            const seen: unknown[] = [];
            const fake = await startFakeRouter({
                checkPayer: (r) => {
                    seen.push(r);
                    return { verdict: PayerVerdict.OK };
                },
            });
            routers.push(fake);
            expect(
                await payOrder(
                    { ...hotDeps(), router: clientFor(fake) },
                    start.id,
                    await hotPayment(start),
                    sig(),
                ),
            ).toMatchObject({ kind: "paid" });
            expect(seen[0]).toMatchObject({ kind: "start", packageId: "cpu-small" });
        });
    });

    it("completes an allowance payment on a pool of one connection", async () => {
        const one = new pg.Pool({ connectionString: db.url, max: 1 });
        try {
            const out = await within(
                10_000,
                payOrder({ ...hotDeps(), pool: one }, hot.id, await hotPayment(), sig()),
            );
            expect(out).toMatchObject({ kind: "paid" });
        } finally {
            await one.end();
        }
    });

    it("answers x402_disabled with 403", async () => {
        const want = {
            kind: "refused",
            orderId: hot.id,
            httpStatus: 403,
            reason: "x402_disabled",
            charged: false,
        };
        await setControls(db.pool, { disabled: true }, "test", NOW);
        expect(await payOrder(hotDeps(), hot.id, await hotPayment(), sig())).toEqual(want);
        await setControls(db.pool, { disabled: false }, "test", NOW);
        expect(
            await payOrder(
                hotDeps({ x402: { enabled: false } }),
                hot.id,
                await hotPayment(),
                sig(),
            ),
        ).toEqual(want);
        expect(await stateOf(hot.id)).toBe("unpaid");
    });

    it("answers x402_unavailable with 503 while the signer is closed", async () => {
        expect(
            await payOrder(hotDeps({ open: false }), hot.id, await hotPayment(), sig()),
        ).toMatchObject({
            httpStatus: 503,
            reason: "x402_unavailable",
            charged: false,
            retryAfterSeconds: 30,
        });
    });

    it("lets package-only orders skip the gate", async () => {
        await setControls(db.pool, { paused: true, disabled: true }, "test", NOW);
        expect(
            await payOrder(hotDeps({ x402: { enabled: false }, open: false }), order.id, p, sig()),
        ).toMatchObject({ kind: "paid" });
    });

    it("asks CheckPayer about an allowance order as an extend of the account's package", async () => {
        const seen: unknown[] = [];
        const fake = await startFakeRouter({
            checkPayer: (req) => {
                seen.push(req);
                return { verdict: PayerVerdict.OK };
            },
        });
        routers.push(fake);
        expect(
            await payOrder(
                { ...hotDeps(), router: clientFor(fake) },
                hot.id,
                await hotPayment(),
                sig(),
            ),
        ).toMatchObject({ kind: "paid" });
        expect(seen[0]).toMatchObject({ kind: "extend", packageId: "cpu-small" });
    });

    it("refuses an allowance order whose account is missing", async () => {
        const log = memoryLog();
        const { order: lone } = await seedAllowanceOrder(db.pool, {
            handleSha256: "ee".repeat(32),
            expiresAt: EXPIRES_AT,
        });
        expect(
            await payOrder({ ...hotDeps(), log }, lone.id, await hotPayment(lone), sig()),
        ).toEqual({
            kind: "refused",
            orderId: lone.id,
            httpStatus: 503,
            reason: "x402_unavailable",
            charged: false,
            retryAfterSeconds: 30,
        });
        expect(log.lines).toContainEqual(
            expect.objectContaining({
                msg: "allowance order has no account",
                orderId: lone.id,
            }),
        );
    });

    it("funds a hot order in markPaid and leaves payments.landed_slot null", async () => {
        expect(await payOrder(hotDeps(), hot.id, await hotPayment(), sig())).toMatchObject({
            kind: "paid",
        });
        expect(await fundingCount(hot.id)).toBe(1);
        expect(await stateOf(hot.id)).toBe("redeemed");
        expect((await findPaymentByOrder(db.pool, hot.id))!.landedSlot).toBeNull();
        expect(await readPool(db.pool)).toEqual({
            committedMicros: 1_000_000,
            unpaidMicros: 4_000_000,
        });
    });

    it("answers settling and rolls back when the funding throws", async () => {
        const broken = hotDeps();
        broken.x402.paid = {
            ...paidDeps,
            funding: { ...paidDeps.funding, fund: () => Promise.reject(new Error("boom")) },
        };
        quietConsole();
        expect(await payOrder(broken, hot.id, await hotPayment(), sig())).toEqual({
            kind: "settling",
            orderId: hot.id,
        });
        expect(await stateOf(hot.id)).toBe("settling");
        expect((await findPaymentByOrder(db.pool, hot.id))!.status).toBe("settling");
        expect(await fundingCount(hot.id)).toBe(0);
    });

    it("answers paid when the reconciler finished the same hot payment first", async () => {
        const r = confirmingAfter(() =>
            reconcileSettling({
                pool: db.pool,
                rpc: landedRpc(),
                rpcTimeoutMs: 1_000,
                log: silentLog,
                now: () => new Date(NOW.getTime() + 60_000),
                paid: paidDeps,
            }).then(() => {}),
        );
        expect(
            await payOrder(
                { ...hotDeps(), settler: settlerOn(r) },
                hot.id,
                await hotPayment(),
                sig(),
            ),
        ).toMatchObject({ kind: "paid" });
        expect(await fundingCount(hot.id)).toBe(1);
    });

    it("answers a refused funding with order_closed and its code", async () => {
        const { order: closed } = await seedAllowanceOrder(db.pool, {
            state: "refunding",
            x402Refusal: "allowance_ceiling",
        });
        expect(await payOrder(hotDeps(), closed.id, await hotPayment(closed), sig())).toEqual({
            kind: "refused",
            orderId: closed.id,
            httpStatus: 410,
            reason: "order_closed",
            code: "allowance_ceiling",
        });
    });
});
