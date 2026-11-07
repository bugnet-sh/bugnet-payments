import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import {
    create,
    get,
    post,
    terms,
    testApp,
    type TestApp,
    until,
    withHints,
} from "../testing/app.ts";
import { seedAllowanceOrder, seedOrder, seedPayment } from "../testing/orders.ts";
import { signedPayment } from "../testing/payment.ts";
import { agentPin, seedAccount, seedFunding, seedService } from "../testing/x402.ts";
import { setControls } from "../x402/controls.ts";
import { readPool } from "../x402/ledger.ts";
import type { OrderRequest } from "./types.ts";
import { claimHash, newClaim, sealClaim } from "./claim.ts";
import { newOrderId } from "./ids.ts";
import { abandonOrder } from "./service.ts";
import { findOrder, insertOrder, lockOrder, setOrderState } from "./store.ts";
import type { OrderRow } from "./types.ts";

const KEY = "toolu_01ABCDEFGHIJKLMNOPQRSTUV";
const HANDLE = "6e84ff9f1b031bc128494c91a9e0286578046eb6499d6e4e89a970813b2982a5";
const START = new Date("2030-01-01T00:00:00Z");

let app: TestApp;

beforeAll(async () => {
    app = await testApp({ now: START });
});
afterAll(async () => {
    await app.close();
});
beforeEach(() => {
    app.now.set(START);
});

function after(ms: number): Date {
    return new Date(app.now.get().getTime() + ms);
}

// seedOrder's own times follow the wall clock, which is years before the frozen app clock
function seed(over: Partial<OrderRow> = {}): Promise<{ order: OrderRow; claim: string }> {
    return seedOrder(app.pool, {
        createdAt: app.now.get(),
        expiresAt: after(15 * 60_000),
        ...over,
    });
}

function seedPaid(over: Partial<OrderRow> = {}): Promise<{ order: OrderRow; claim: string }> {
    return seed({ state: "paid", paidAt: app.now.get(), payer: "P", ...over });
}

async function stateOf(id: string) {
    return (await findOrder(app.pool, id))!.state;
}

function lateLines(orderId: string): Record<string, unknown>[] {
    return app.log.lines.filter(
        (l) => l.msg === "impossible late payment" && l.orderId === orderId,
    );
}

async function lockWaiters(): Promise<number> {
    const res = await app.pool.query(
        `select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
    );
    return res.rows[0].n;
}

function tokenClaims(token: string): unknown {
    return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
}

describe("create and replay", () => {
    it("creates an order with a claim and a challenge", async () => {
        const r = await post(app, "/v1/orders", create());
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
            status: "payment_required",
            orderId: expect.stringMatching(/^ord_[a-z2-7]{26}$/),
            claim: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        });
        expect(r.body.payUrl).toBe(`${app.settings.http.public_url}/o/${r.body.orderId}`);
        expect(r.body.paymentRequired.accepts[0].extra.memo).toBe(r.body.orderId);
        expect(r.body.paymentRequired.resource.description).toBe(
            "Bugnet sandbox 2 vCPU / 2 GiB, 10 min",
        );
        const stored = (await findOrder(app.pool, r.body.orderId))!;
        expect(stored).toMatchObject({
            state: "unpaid",
            kind: "start",
            packageId: "pkg-test",
            amountMicros: 10_000,
            handleSha256: null,
            idempotencyKey: null,
            expiresAt: after(15 * 60_000),
        });
        expect(stored.claimSha256).toEqual(claimHash(r.body.claim));
        expect(stored.claimBox).not.toBeNull();
    });

    it("replays a create with the same key and terms, including the claim", async () => {
        const a = await post(app, "/v1/orders", create({ idempotencyKey: KEY + "a" }));
        const b = await post(app, "/v1/orders", create({ idempotencyKey: KEY + "a" }));
        expect(b.body.status).toBe("payment_required");
        expect(b.body.orderId).toBe(a.body.orderId);
        expect(b.body.claim).toBe(a.body.claim);
    });

    it("never returns the claim to an orderId lookup or another idempotency key", async () => {
        const a = await post(app, "/v1/orders", create({ idempotencyKey: KEY + "b" }));
        const byId = await post(app, "/v1/orders", { ...create(), orderId: a.body.orderId });
        expect(byId.body).toMatchObject({ status: "payment_required", orderId: a.body.orderId });
        expect(byId.body).not.toHaveProperty("claim");
        const otherKey = await post(app, "/v1/orders", {
            ...create({ idempotencyKey: "toolu_01ZZZZZZZZZZZZZZZZZZZZZZZZ" }),
            orderId: a.body.orderId,
        });
        expect(otherKey.body).toMatchObject({ status: "payment_required" });
        expect(otherKey.body).not.toHaveProperty("claim");
        expect(JSON.stringify([byId.body, otherKey.body])).not.toContain(a.body.claim);
    });

    it("creates one order for concurrent creates with one key", async () => {
        const [a, b] = await Promise.all([
            post(app, "/v1/orders", create({ idempotencyKey: KEY + "c" })),
            post(app, "/v1/orders", create({ idempotencyKey: KEY + "c" })),
        ]);
        expect(a!.body.status).toBe("payment_required");
        expect(b!.body.orderId).toBe(a!.body.orderId);
        expect(b!.body.claim).toBe(a!.body.claim);
        const n = await app.pool.query(
            "select count(*)::int as n from orders where idempotency_key = $1",
            [KEY + "c"],
        );
        expect(n.rows[0].n).toBe(1);
    });

    it("answers a create that lost the insert race on its key as a replay", async () => {
        const id = newOrderId();
        const claim = newClaim();
        const other = await app.pool.connect();
        try {
            await other.query("begin");
            await insertOrder(other, {
                id,
                kind: "start",
                packageId: "pkg-test",
                amountMicros: 10_000,
                handleSha256: null,
                description: "Bugnet sandbox 2 vCPU / 2 GiB, 10 min",
                claimSha256: claimHash(claim)!,
                claimBox: sealClaim(app.secrets.claimKey, id, claim),
                idempotencyKey: KEY + "d",
                expiresAt: after(15 * 60_000),
                payInto: "cold",
                allowanceMicros: 0,
                feeMicros: 0,
                x402Setup: null,
            });
            const racing = post(app, "/v1/orders", create({ idempotencyKey: KEY + "d" }));
            // The create must wait on the uncommitted key, or the unique violation is not reached
            await until(async () => (await lockWaiters()) === 1, 5_000);
            await other.query("commit");
            const r = await racing;
            expect(r.body).toMatchObject({ status: "payment_required", orderId: id, claim });
        } finally {
            other.release();
        }
    });

    it("refuses the same key with different terms", async () => {
        const a = await post(app, "/v1/orders", create({ idempotencyKey: KEY + "e" }));
        const b = await post(
            app,
            "/v1/orders",
            create({ idempotencyKey: KEY + "e", amountMicros: 10_001 }),
        );
        expect(b.status).toBe(200);
        expect(b.body).toEqual({
            status: "refused",
            orderId: a.body.orderId,
            reason: "idempotency_conflict",
        });
    });

    it("ignores a key shorter than 16 characters", async () => {
        const a = await post(app, "/v1/orders", create({ idempotencyKey: "k1" }));
        const b = await post(app, "/v1/orders", create({ idempotencyKey: "k1" }));
        expect(a.body.status).toBe("payment_required");
        expect(b.body.status).toBe("payment_required");
        expect(b.body.orderId).not.toBe(a.body.orderId);
        expect((await findOrder(app.pool, a.body.orderId))!.idempotencyKey).toBeNull();
    });

    it("answers order_expired once an unpaid order reaches its expiry", async () => {
        const a = await post(app, "/v1/orders", create({ idempotencyKey: KEY + "f" }));
        app.now.set(after(15 * 60_000));
        const replay = await post(app, "/v1/orders", create({ idempotencyKey: KEY + "f" }));
        expect(replay.body).toEqual({
            status: "refused",
            orderId: a.body.orderId,
            reason: "order_expired",
        });
        const byClaim = await post(app, "/v1/orders", {
            orderId: a.body.orderId,
            claim: a.body.claim,
        });
        expect(byClaim.body).toEqual({
            status: "refused",
            orderId: a.body.orderId,
            reason: "order_expired",
        });
    });

    it("refuses an unknown or malformed orderId", async () => {
        const unknown = newOrderId();
        expect((await post(app, "/v1/orders", { ...create(), orderId: unknown })).body).toEqual({
            status: "refused",
            orderId: unknown,
            reason: "order_unknown",
        });
        expect((await post(app, "/v1/orders", { ...create(), orderId: "ord_X" })).body).toEqual({
            status: "refused",
            reason: "order_unknown",
        });
    });
});

describe("validation", () => {
    it.each([
        ["a missing kind", { kind: undefined }],
        ["an unknown kind", { kind: "stop" }],
        ["a missing package", { packageId: undefined }],
        ["a package with a slash", { packageId: "pkg/test" }],
        ["a package of 65 characters", { packageId: "p".repeat(65) }],
        ["a missing amount", { amountMicros: undefined }],
        ["a zero amount", { amountMicros: 0 }],
        ["a fractional amount", { amountMicros: 1.5 }],
        ["an amount above the maximum", { amountMicros: 100_000_001 }],
        ["a missing description", { description: undefined }],
        ["an empty description", { description: "" }],
        ["a description of 201 characters", { description: "d".repeat(201) }],
        ["a description with a newline", { description: "Bugnet\nsandbox" }],
        ["a start with a handle", { handleSha256: HANDLE }],
        ["an extend without a handle", { kind: "extend" }],
        [
            "an extend with an upper-case handle",
            { kind: "extend", handleSha256: HANDLE.toUpperCase() },
        ],
        ["a malformed claim", { claim: "short" }],
        ["a key of 201 characters", { idempotencyKey: "k".repeat(201) }],
        ["an orderId that is not a string", { orderId: 7 }],
    ])("refuses %s as bad_request", async (_n, over) => {
        const r = await post(app, "/v1/orders", { ...create(), ...over });
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ status: "refused", reason: "bad_request" });
    });

    it("refuses a body that is not an object", async () => {
        for (const body of [null, [], "order", 3]) {
            const r = await post(app, "/v1/orders", body);
            expect(r.status).toBe(400);
            expect(r.body).toEqual({ status: "refused", reason: "bad_request" });
        }
    });

    it("validates the optional terms of a redeem", async () => {
        const { order, claim } = await seedPaid();
        const r = await post(app, "/v1/orders", { orderId: order.id, claim, amountMicros: -1 });
        expect(r.status).toBe(400);
        expect(await stateOf(order.id)).toBe("paid");
    });
});

describe("redeem", () => {
    it("redeems a paid order for the claim holder from stored terms", async () => {
        const { order, claim } = await seedPaid();
        const r = await post(app, "/v1/orders", { ...terms(order), orderId: order.id, claim });
        expect(r.body).toMatchObject({
            status: "paid",
            orderId: order.id,
            payer: "P",
            kind: "start",
            packageId: "pkg-test",
            amountMicros: 10_000,
        });
        expect(r.body).not.toHaveProperty("handleSha256");
        expect(tokenClaims(r.body.orderToken)).toEqual({
            order_id: order.id,
            kind: "start",
            package_id: "pkg-test",
            amount_micros: 10_000,
            expires_at: new Date(app.now.get().getTime() + 600_000).toISOString(),
        });
        expect(await findOrder(app.pool, order.id)).toMatchObject({
            state: "redeemed",
            redeemedAt: app.now.get(),
            tokenExpiresAt: after(600_000),
        });
        app.now.set(after(60_000));
        const again = await post(app, "/v1/orders", { ...terms(order), orderId: order.id, claim });
        expect(again.body.orderToken).toBe(r.body.orderToken);
    });

    it("redeems with orderId and claim alone", async () => {
        const { order, claim } = await seedPaid({
            kind: "extend",
            packageId: "ext-10m",
            handleSha256: HANDLE,
        });
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.body).toMatchObject({
            status: "paid",
            kind: "extend",
            packageId: "ext-10m",
            amountMicros: 10_000,
            handleSha256: HANDLE,
        });
        expect(tokenClaims(r.body.orderToken)).toMatchObject({ handle_sha256: HANDLE });
    });

    it("puts allowance_micros in the token only when allowance_claim is on", async () => {
        const flag = app.settings.router;
        const was = flag.allowance_claim;
        try {
            for (const on of [true, false]) {
                flag.allowance_claim = on;
                const { order, claim } = await seedPaid({
                    allowanceMicros: 500_000,
                    feeMicros: 3_000,
                    amountMicros: 503_000,
                    payInto: "allowance",
                });
                const r = await post(app, "/v1/orders", { orderId: order.id, claim });
                expect(r.body.status).toBe("paid");
                const claims = tokenClaims(r.body.orderToken) as Record<string, unknown>;
                if (on) expect(claims.allowance_micros).toBe(500_000);
                else expect(claims).not.toHaveProperty("allowance_micros");
            }
        } finally {
            flag.allowance_claim = was;
        }
    });

    it("refuses to issue a token for an allowance order, whatever its payer", async () => {
        const { order, claim } = await seedAllowanceOrder(app.pool, {
            state: "paid",
            paidAt: app.now.get(),
            createdAt: app.now.get(),
            expiresAt: after(15 * 60_000),
            payer: null,
        });
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.status).toBe(500);
        expect(
            app.log.lines.some(
                (l) =>
                    l.msg === "handler failed" &&
                    (l.err as { message?: string }).message === "allowance orders carry no token",
            ),
        ).toBe(true);
    });

    it("carries the payment response when the order has a payment", async () => {
        const { order, claim } = await seedPaid();
        const payment = await seedPayment(app.pool, order.id, { payer: "P" });
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.body.paymentResponse).toEqual({
            success: true,
            transaction: payment.txSignature,
            network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            payer: "P",
        });
    });

    it("refuses a present but different handleSha256", async () => {
        const { order, claim } = await seedPaid({
            kind: "extend",
            packageId: "ext-10m",
            handleSha256: HANDLE,
        });
        const r = await post(app, "/v1/orders", {
            orderId: order.id,
            claim,
            handleSha256: "0".repeat(64),
        });
        expect(r.body).toEqual({ status: "refused", orderId: order.id, reason: "terms_mismatch" });
        expect(await stateOf(order.id)).toBe("paid");
    });

    it.each([
        ["wrong claim", { claim: newClaim() }, { status: "refused", reason: "claim_mismatch" }],
        [
            "no claim on a paid order",
            { claim: undefined },
            { status: "refused", reason: "paid_claim_required" },
        ],
        [
            "changed amount",
            { amountMicros: 10_001 },
            { status: "refused", reason: "terms_mismatch" },
        ],
    ])("refuses %s", async (_n, over, want) => {
        const { order, claim } = await seedPaid();
        const r = await post(app, "/v1/orders", {
            ...terms(order),
            orderId: order.id,
            claim,
            ...over,
        });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ...want, orderId: order.id });
        expect(await stateOf(order.id)).toBe("paid");
    });

    it("refuses a redeem that waited on the lock while the order went to refunding", async () => {
        const { order, claim } = await seedPaid();
        await seedPayment(app.pool, order.id);
        const a = await app.pool.connect();
        try {
            await a.query("begin");
            await lockOrder(a, order.id);
            const redeem = post(app, "/v1/orders", { orderId: order.id, claim });
            // The redeem must wait on the row lock before A commits, or the race is not exercised
            await until(async () => (await lockWaiters()) === 1, 5_000);
            await setOrderState(a, order.id, "paid", "refunding");
            await a.query("commit");
            const r = await redeem;
            expect(r.body).toEqual({
                status: "refused",
                orderId: order.id,
                reason: "order_closed",
            });
            expect(r.body).not.toHaveProperty("orderToken");
            expect(await findOrder(app.pool, order.id)).toMatchObject({
                state: "refunding",
                tokenExpiresAt: null,
            });
        } finally {
            a.release();
        }
    });

    it("never answers payment_required for a paid order", async () => {
        const a = await post(app, "/v1/orders", create({ idempotencyKey: KEY + "g" }));
        await setOrderState(app.pool, a.body.orderId, "unpaid", "settling", { payer: "P" });
        await setOrderState(app.pool, a.body.orderId, "settling", "paid", {
            paidAt: app.now.get(),
        });
        const replay = await post(app, "/v1/orders", create({ idempotencyKey: KEY + "g" }));
        expect(replay.body).toEqual({
            status: "refused",
            orderId: a.body.orderId,
            reason: "paid_claim_required",
        });
        const byId = await post(app, "/v1/orders", { ...create(), orderId: a.body.orderId });
        expect(byId.body.reason).toBe("paid_claim_required");
    });

    it("answers settling to a claim holder while settling", async () => {
        const { order, claim } = await seed({ state: "settling", payer: "P" });
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.body).toEqual({ status: "refused", orderId: order.id, reason: "settling" });
        const stranger = await post(app, "/v1/orders", { ...terms(order), orderId: order.id });
        expect(stranger.body.reason).toBe("paid_claim_required");
    });

    it("answers an unpaid order's claim holder with payment_required and no claim", async () => {
        const { order, claim } = await seed();
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.body).toMatchObject({ status: "payment_required", orderId: order.id });
        expect(r.body).not.toHaveProperty("claim");
    });

    it("refuses a redeem when the payment was recorded after expiry", async () => {
        const t0 = new Date(app.now.get().getTime() - 60_000);
        const { order, claim } = await seedPaid({
            expiresAt: t0,
            paidAt: new Date(t0.getTime() + 1_000),
        });
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.body).toEqual({ status: "refused", orderId: order.id, reason: "payment_late" });
        expect(await stateOf(order.id)).toBe("paid");
        expect(lateLines(order.id)).toEqual([expect.objectContaining({ level: "error" })]);
    });

    it("redeems a payment recorded exactly at expiry", async () => {
        const t0 = new Date(app.now.get().getTime() - 60_000);
        const { order, claim } = await seedPaid({ expiresAt: t0, paidAt: t0 });
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.body.status).toBe("paid");
        expect(lateLines(order.id)).toEqual([]);
    });

    it("refuses a redeem after the token expired", async () => {
        const { order, claim } = await seedPaid({
            state: "redeemed",
            redeemedAt: new Date(app.now.get().getTime() - 600_000),
            tokenExpiresAt: new Date(app.now.get().getTime() - 1_000),
        });
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.body).toEqual({ status: "refused", orderId: order.id, reason: "token_expired" });
        expect(await stateOf(order.id)).toBe("redeemed");
    });

    it.each([
        ["refunding", "order_closed"],
        ["refunded", "order_closed"],
        ["manual", "order_closed"],
        ["expired", "order_expired"],
    ] as const)("refuses a claim holder of a %s order", async (state, reason) => {
        const { order, claim } = await seedPaid({ state });
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.body).toEqual({ status: "refused", orderId: order.id, reason });
        const stranger = await post(app, "/v1/orders", { ...terms(order), orderId: order.id });
        expect(stranger.body).toEqual({ status: "refused", orderId: order.id, reason });
    });
});

describe("x402 payment from _meta", () => {
    it("settles an x402 payload from _meta without an orderId", async () => {
        const created = (await post(app, "/v1/orders", create())).body;
        const p = await signedPayment(withHints(created.paymentRequired.accepts[0]), app.payer);
        const r = await post(app, "/v1/orders", create({ payment: p }));
        expect(r.body).toMatchObject({
            status: "paid",
            orderId: created.orderId,
            payer: app.payer.address,
            paymentResponse: { success: true, payer: app.payer.address },
        });
        expect(r.body).not.toHaveProperty("claim");
        expect(await stateOf(created.orderId)).toBe("redeemed");
    });

    it("answers a retried _meta payment after paid with the identical token", async () => {
        const created = (await post(app, "/v1/orders", create())).body;
        const p = await signedPayment(withHints(created.paymentRequired.accepts[0]), app.payer);
        const sentBefore = app.rpc.calls.sendTransaction!;
        const first = await post(app, "/v1/orders", create({ payment: p, idempotencyKey: KEY }));
        const second = await post(app, "/v1/orders", create({ payment: p, idempotencyKey: KEY }));
        expect(first.body.status).toBe("paid");
        expect(second.body.status).toBe("paid");
        expect(second.body.orderToken).toBe(first.body.orderToken);
        expect(second.body.paymentResponse).toEqual(first.body.paymentResponse);
        expect(app.rpc.calls.sendTransaction! - sentBefore).toBe(1);
    });

    it.each([
        ["no idempotency key", {}],
        ["another idempotency key", { idempotencyKey: KEY + "x" }],
    ])("never hands the token to a settled payment replayed with %s", async (_n, over) => {
        const created = (await post(app, "/v1/orders", create())).body;
        const p = await signedPayment(withHints(created.paymentRequired.accepts[0]), app.payer);
        const first = await post(app, "/v1/orders", create({ payment: p, idempotencyKey: KEY }));
        expect(first.body.status).toBe("paid");
        const replay = await post(app, "/v1/orders", { ...create({ payment: p }), ...over });
        expect(replay.body).toEqual({
            status: "refused",
            orderId: created.orderId,
            reason: "paid_claim_required",
        });
    });

    it("never redeems a link-paid order for whoever replays its public transaction", async () => {
        const created = (await post(app, "/v1/orders", create())).body;
        const p = await signedPayment(withHints(created.paymentRequired.accepts[0]), app.payer);
        const paid = await get(app, `/o/${created.orderId}`, {
            "payment-signature": encodePaymentSignatureHeader(p),
        });
        expect(paid.status).toBe(200);
        const replay = await post(app, "/v1/orders", create({ payment: p, idempotencyKey: KEY }));
        expect(replay.body).toEqual({
            status: "refused",
            orderId: created.orderId,
            reason: "paid_claim_required",
        });
        expect(await stateOf(created.orderId)).toBe("paid");
        const owner = await post(app, "/v1/orders", {
            orderId: created.orderId,
            claim: created.claim,
        });
        expect(owner.body.status).toBe("paid");
    });

    it("does not authorize a different payment for a paid order", async () => {
        const created = (await post(app, "/v1/orders", create())).body;
        const req = withHints(created.paymentRequired.accepts[0]);
        await post(app, "/v1/orders", create({ payment: await signedPayment(req, app.payer) }));
        const other = await signedPayment(req, app.payer, { computeUnitPriceMicroLamports: 2n });
        const r = await post(app, "/v1/orders", create({ payment: other }));
        expect(r.body).toEqual({
            status: "refused",
            orderId: created.orderId,
            reason: "paid_claim_required",
        });
    });

    it("passes a payment refusal through with its reason", async () => {
        const created = (await post(app, "/v1/orders", create())).body;
        const p = await signedPayment(
            withHints({ ...created.paymentRequired.accepts[0], amount: "9999" }),
            app.payer,
        );
        const r = await post(app, "/v1/orders", create({ payment: p }));
        expect(r.body).toMatchObject({
            status: "refused",
            orderId: created.orderId,
            reason: "payment_invalid",
        });
        expect(await stateOf(created.orderId)).toBe("unpaid");
    });
});

describe("abandonOrder", () => {
    it("records the hint without changing state", async () => {
        const { order } = await seedPaid({ state: "redeemed" });
        expect(await abandonOrder(app.pool, order.id, "denied", app.now.get())).toBe("recorded");
        expect(await findOrder(app.pool, order.id)).toMatchObject({
            state: "redeemed",
            abandonReason: "denied",
            abandonAt: app.now.get(),
        });
    });

    it("answers unknown for a missing or malformed id", async () => {
        expect(await abandonOrder(app.pool, newOrderId(), "denied", app.now.get())).toBe("unknown");
        expect(await abandonOrder(app.pool, "ord_X", "denied", app.now.get())).toBe("unknown");
    });
});

describe("x402 orders", () => {
    const randomHandle = () => randomBytes(32).toString("hex");

    function topUp(handleSha256: string, over: Partial<OrderRequest> = {}): OrderRequest {
        return {
            kind: "allowance",
            packageId: "x402-allowance",
            handleSha256,
            amountMicros: 1_003_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            description: "ignored: Payments writes it",
            ...over,
        };
    }

    async function account(over: Parameters<typeof seedAccount>[1] = {}) {
        const handleSha256 = randomHandle();
        const a = await seedAccount(app.pool, { handleSha256, ...over });
        return { ...a, handleSha256 };
    }

    async function orderCount(): Promise<number> {
        return (await app.pool.query("select count(*)::int as n from orders")).rows[0].n;
    }

    beforeEach(async () => {
        await app.pool.query("update x402_pool set unpaid_micros = 0 where id = 1");
    });

    it("stores each row of the 7.2 table", async () => {
        const plain = await post(app, "/v1/orders", create());
        expect(await findOrder(app.pool, plain.body.orderId)).toMatchObject({
            payInto: "cold",
            allowanceMicros: 0,
            feeMicros: 0,
            x402Setup: null,
        });
        const hotStart = await post(
            app,
            "/v1/orders",
            create({ amountMicros: 1_013_000, allowanceMicros: 1_000_000, feeMicros: 3_000 }),
        );
        expect(hotStart.body.status).toBe("payment_required");
        expect(await findOrder(app.pool, hotStart.body.orderId)).toMatchObject({
            kind: "start",
            payInto: "allowance",
            amountMicros: 1_013_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            x402Setup: { services: [], disable: [], spendPerMinuteMicros: null },
        });
        const h = await account();
        const due = await post(app, "/v1/orders", topUp(h.handleSha256));
        expect(due.body.status).toBe("payment_required");
        expect(await findOrder(app.pool, due.body.orderId)).toMatchObject({
            kind: "allowance",
            payInto: "allowance",
            handleSha256: h.handleSha256,
            amountMicros: 1_003_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
        });
        const paid = await account();
        await seedFunding(app.pool, { accountId: paid.id, orderId: paid.id });
        const noFee = await post(
            app,
            "/v1/orders",
            topUp(paid.handleSha256, { amountMicros: 1_000_000, feeMicros: 0 }),
        );
        expect(noFee.body.status).toBe("payment_required");
        expect(await findOrder(app.pool, noFee.body.orderId)).toMatchObject({
            payInto: "allowance",
            amountMicros: 1_000_000,
            allowanceMicros: 1_000_000,
            feeMicros: 0,
        });
        const extend = await post(
            app,
            "/v1/orders",
            create({ kind: "extend", handleSha256: h.handleSha256 }),
        );
        expect(await findOrder(app.pool, extend.body.orderId)).toMatchObject({
            payInto: "cold",
            allowanceMicros: 0,
            feeMicros: 0,
        });
    });

    it("skips every check for orders without allowance money", async () => {
        const off = await testApp({ x402: { enabled: false } });
        try {
            const r = await post(off, "/v1/orders", create());
            expect(r.body.status).toBe("payment_required");
            const h = await seedAccount(off.pool, { handleSha256: randomHandle() });
            const t = await post(off, "/v1/orders", topUp(h.handleSha256!));
            expect(t.status).toBe(200);
            expect(t.body).toEqual({ status: "refused", reason: "x402_disabled" });
        } finally {
            await off.close();
        }
    });

    it("answers a refusal with nothing created and the pool untouched", async () => {
        const h = await account();
        const before = await orderCount();
        const r = await post(
            app,
            "/v1/orders",
            topUp(h.handleSha256, { feeMicros: 0, amountMicros: 1_000_000 }),
        );
        expect(r.body).toEqual({ status: "refused", reason: "fee_mismatch" });
        expect(await orderCount()).toBe(before);
        expect(await readPool(app.pool)).toEqual({ committedMicros: 0, unpaidMicros: 0 });
    });

    it("reserves the pool for the allowance of a created order", async () => {
        const h = await account();
        const r = await post(app, "/v1/orders", topUp(h.handleSha256));
        expect(r.body.status).toBe("payment_required");
        expect(await readPool(app.pool)).toEqual({ committedMicros: 0, unpaidMicros: 1_000_000 });
    });

    it("reserves the pool under concurrent creates", async () => {
        const tight = await testApp({ x402: { pool_unpaid_max_micros: 5_000_000 } });
        try {
            const h = await seedAccount(tight.pool, { handleSha256: "77".repeat(32) });
            const r = await Promise.all(
                [1, 2].map(() =>
                    post(
                        tight,
                        "/v1/orders",
                        topUp(h.handleSha256!, {
                            allowanceMicros: 3_000_000,
                            amountMicros: 3_003_000,
                        }),
                    ),
                ),
            );
            expect(
                r.map((x) => (x.body.status === "refused" ? x.body.reason : x.body.status)).sort(),
            ).toEqual(["allowance_pool_full", "payment_required"]);
            expect(await readPool(tight.pool)).toEqual({
                committedMicros: 0,
                unpaidMicros: 3_000_000,
            });
        } finally {
            await tight.close();
        }
    });

    it("refuses a full pool and creates nothing", async () => {
        const h = await account();
        await app.pool.query("update x402_pool set unpaid_micros = 9_500_000 where id = 1");
        const before = await orderCount();
        const r = await post(app, "/v1/orders", topUp(h.handleSha256));
        expect(r.body).toEqual({ status: "refused", reason: "allowance_pool_full" });
        expect(await orderCount()).toBe(before);
        expect(await readPool(app.pool)).toEqual({ committedMicros: 0, unpaidMicros: 9_500_000 });
    });

    it("names the hot wallet as payTo in an allowance order's challenge", async () => {
        const h = await account();
        const r = await post(app, "/v1/orders", topUp(h.handleSha256));
        expect(r.body.paymentRequired.accepts[0].payTo).toBe(app.allowance.address);
    });

    it("expires an unpaid allowance order after 5 minutes", async () => {
        const h = await account();
        const r = await post(app, "/v1/orders", topUp(h.handleSha256));
        expect((await findOrder(app.pool, r.body.orderId))!.expiresAt).toEqual(
            new Date(START.getTime() + 300_000),
        );
    });

    it("writes the description from the pins and ignores the request's", async () => {
        const h = await account();
        const r = await post(
            app,
            "/v1/orders",
            topUp(h.handleSha256, { description: "mine", x402: { services: [agentPin()] } }),
        );
        const text =
            "Bugnet x402 $1.00 + $0.003 fee: agent402.tools/v1/auto/ up to $0.01 pays 4vJ9...kLKi";
        expect((await findOrder(app.pool, r.body.orderId))!.description).toBe(text);
        expect(r.body.paymentRequired.resource.description).toBe(text);
    });

    it("stores Payments' listed and paid_path, whatever the gateway sent", async () => {
        const h = await account();
        const r = await post(
            app,
            "/v1/orders",
            topUp(h.handleSha256, { x402: { services: [agentPin({ listed: "unlisted" })] } }),
        );
        const stored = (await findOrder(app.pool, r.body.orderId))!;
        expect(stored.x402Setup!.services[0]).toMatchObject({
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
            newPin: true,
        });
    });

    it("keeps held services' listed and paid_path for a re-pin with the same payee", async () => {
        const h = await account();
        await seedService(app.pool, {
            accountId: h.id,
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
        });
        const r = await post(
            app,
            "/v1/orders",
            topUp(h.handleSha256, { x402: { services: [agentPin({ maxPriceMicros: 20_000 })] } }),
        );
        const stored = (await findOrder(app.pool, r.body.orderId))!;
        expect(stored.x402Setup!.services[0]).toMatchObject({
            maxPriceMicros: 20_000,
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
            newPin: false,
        });
        expect(stored.description).toBe("Bugnet x402 $1.00 + $0.003 fee");
    });

    it("keeps probe.accepted unchanged through the schema", async () => {
        const h = await account();
        const base = agentPin();
        const accepted = { ...(base.probe.accepted as object), future: [1, "x", { y: null }] };
        const r = await post(
            app,
            "/v1/orders",
            topUp(h.handleSha256, {
                x402: { services: [{ ...base, probe: { ...base.probe, accepted } }] },
            }),
        );
        expect(r.body.status).toBe("payment_required");
        const stored = (await findOrder(app.pool, r.body.orderId))!;
        expect(stored.x402Setup!.services[0]!.probe.accepted).toEqual(accepted);
    });

    it("answers pin_refused with the service and the reason", async () => {
        const h = await account();
        const pin = agentPin({ probe: { at: "x", status: 200, accepted: null } });
        const r = await post(
            app,
            "/v1/orders",
            topUp(h.handleSha256, { x402: { services: [pin] } }),
        );
        expect(r.status).toBe(200);
        expect(r.body).toEqual({
            status: "refused",
            reason: "pin_refused",
            serviceId: pin.serviceId,
            pinReason: "no_402",
        });
    });

    it("replays a key hit and refuses the same key with another allowance", async () => {
        const h = await account();
        const body = topUp(h.handleSha256, { idempotencyKey: KEY });
        const first = await post(app, "/v1/orders", body);
        const again = await post(app, "/v1/orders", body);
        expect(again.body.orderId).toBe(first.body.orderId);
        const other = await post(app, "/v1/orders", {
            ...body,
            allowanceMicros: 500_000,
            amountMicros: 503_000,
        });
        expect(other.body).toMatchObject({
            status: "refused",
            reason: "idempotency_conflict",
            orderId: first.body.orderId,
        });
        const pinned = await post(app, "/v1/orders", {
            ...body,
            x402: { services: [agentPin()] },
        });
        expect(pinned.body).toMatchObject({ status: "refused", reason: "idempotency_conflict" });
    });

    it("refuses a start retry that changes only the allowance as terms_mismatch", async () => {
        const first = await post(
            app,
            "/v1/orders",
            create({ amountMicros: 1_013_000, allowanceMicros: 1_000_000, feeMicros: 3_000 }),
        );
        expect(first.body.status).toBe("payment_required");
        const r = await post(app, "/v1/orders", {
            orderId: first.body.orderId,
            claim: first.body.claim,
            allowanceMicros: 500_000,
        });
        expect(r.body).toEqual({
            status: "refused",
            orderId: first.body.orderId,
            reason: "terms_mismatch",
        });
    });

    it.each([
        ["an allowance order without a handle", { handleSha256: undefined }],
        ["a start order with allowance and a handle", { kind: "start", packageId: "cpu-small" }],
        ["an amount that is not allowance plus fee", { amountMicros: 1_003_001 }],
        ["another package id", { packageId: "pkg-test" }],
        ["a zero allowance", { allowanceMicros: 0, feeMicros: 0, amountMicros: 0 }],
        [
            "a fee without an allowance",
            { kind: "start", handleSha256: undefined, allowanceMicros: 0 },
        ],
        ["a fractional allowance", { allowanceMicros: 1.5 }],
        ["a negative fee", { feeMicros: -1 }],
        [
            "pins on a zero allowance",
            {
                kind: "start",
                handleSha256: undefined,
                allowanceMicros: 0,
                feeMicros: 0,
                amountMicros: 10_000,
                x402: { disable: [] },
            },
        ],
        ["an unknown x402 member", { x402: { extra: 1 } }],
        ["an unknown pin member", { x402: { services: [{ ...agentPin(), extra: 1 }] } }],
        ["a pin with a bad service id", { x402: { services: [agentPin({ serviceId: "xs_x" })] } }],
        ["a pin with a zero price", { x402: { services: [agentPin({ maxPriceMicros: 0 })] } }],
        ["a pin prefix without a slash", { x402: { services: [agentPin({ prefix: "v1" })] } }],
        [
            "a pin without probe.accepted",
            { x402: { services: [{ ...agentPin(), probe: { at: "x", status: 402 } }] } },
        ],
        ["a pin url that does not parse", { x402: { services: [agentPin({ url: "not a url" })] } }],
        [
            "a pin url that is not http or https",
            { x402: { services: [agentPin({ url: "ftp://agent402.tools/v1/auto/run" })] } },
        ],
        [
            "a pin url on another host",
            { x402: { services: [agentPin({ url: "https://other.example/v1/auto/run" })] } },
        ],
        ["a duplicate pin", { x402: { services: [agentPin(), agentPin()] } }],
        ["a disable entry that is no service id", { x402: { disable: ["nope"] } }],
        ["a zero minute limit", { x402: { spendPerMinuteMicros: 0 } }],
        ["65 disable entries", { x402: { disable: Array(65).fill("xs_aaaaaaaaaaaaaaaa") } }],
    ])("refuses %s as bad_request", async (_n, over) => {
        const h = await account();
        const body = { ...topUp(h.handleSha256), ...over };
        const r = await post(app, "/v1/orders", body);
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ status: "refused", reason: "bad_request" });
    });

    it("refuses allowance fields on an extend and a start above its amount", async () => {
        const h = await account();
        const extend = await post(app, "/v1/orders", {
            ...create({ kind: "extend", handleSha256: h.handleSha256 }),
            allowanceMicros: 1,
        });
        expect(extend.status).toBe(400);
        expect(extend.body).toEqual({ status: "refused", reason: "bad_request" });
        const start = await post(
            app,
            "/v1/orders",
            create({ amountMicros: 1_000_000, allowanceMicros: 1_000_000, feeMicros: 3_000 }),
        );
        expect(start.body).toEqual({ status: "refused", reason: "bad_request" });
    });
});

describe("x402 settle gate on the paid retry", () => {
    it("gates a paid retry of POST /v1/orders too", async () => {
        const handleSha256 = randomBytes(32).toString("hex");
        await seedAccount(app.pool, { handleSha256 });
        const terms = {
            kind: "allowance",
            packageId: "x402-allowance",
            handleSha256,
            amountMicros: 1_003_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            description: "ignored: Payments writes it",
        };
        const created = await post(app, "/v1/orders", terms);
        expect(created.body.status).toBe("payment_required");
        const p = await signedPayment(
            withHints(created.body.paymentRequired.accepts[0]),
            app.payer,
        );
        await setControls(app.pool, { paused: true }, "test", app.now.get());
        try {
            const r = await post(app, "/v1/orders", { ...terms, payment: p });
            expect(r.body).toEqual({
                status: "refused",
                reason: "x402_paused",
                orderId: created.body.orderId,
                retryAfterSeconds: 30,
            });
            expect(await stateOf(created.body.orderId)).toBe("unpaid");
        } finally {
            await setControls(app.pool, { paused: false }, "test", app.now.get());
        }
    });
});

describe("x402 orders at the paid transaction", () => {
    const randomHandle = () => randomBytes(32).toString("hex");

    function topUp(handleSha256: string, over: Partial<OrderRequest> = {}): OrderRequest {
        return {
            kind: "allowance",
            packageId: "x402-allowance",
            handleSha256,
            amountMicros: 1_003_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            description: "ignored: Payments writes it",
            ...over,
        };
    }

    type Created = Awaited<ReturnType<typeof post>>["body"];

    async function payLink(created: Created, terms: OrderRequest) {
        const p = await signedPayment(withHints(created.paymentRequired.accepts[0]), app.payer);
        // The allowance order answer is Task 26's, so the stored state is what proves the payment
        await post(app, "/v1/orders", { ...terms, payment: p });
        expect(await stateOf(created.orderId)).toBe("redeemed");
    }

    async function fundings(handle: string) {
        const res = await app.pool.query(
            `select f.order_id as "orderId", f.allowance_micros::int as "allowanceMicros",
                f.fee_credited_micros::int as "credit", f.voided_at as "voidedAt"
             from x402_fundings f join x402_accounts a on a.id = f.account_id
             where a.handle_sha256 = $1 order by f.allowance_micros`,
            [handle],
        );
        return res.rows;
    }

    async function refundRow(orderId: string) {
        const res = await app.pool.query(
            `select kind, reason, amount_micros::int as "amountMicros",
                from_wallet as "fromWallet" from refunds where order_id = $1`,
            [orderId],
        );
        return res.rows[0];
    }

    beforeEach(async () => {
        await app.pool.query(
            "update x402_pool set unpaid_micros = 0, committed_micros = 0 where id = 1",
        );
    });

    it("credits the fee on two first orders", async () => {
        const h = await seedAccount(app.pool, { handleSha256: randomHandle() });
        const handle = h.handleSha256!;
        const a = await post(app, "/v1/orders", topUp(handle));
        const b = await post(app, "/v1/orders", topUp(handle));
        await payLink(a.body, topUp(handle));
        await payLink(b.body, topUp(handle));
        expect(await fundings(handle)).toEqual([
            expect.objectContaining({ allowanceMicros: 1_000_000, credit: 0 }),
            expect.objectContaining({ allowanceMicros: 1_003_000, credit: 3_000 }),
        ]);
    });

    it("refunds the second of two unpaid $3 top-ups x402_ceiling", async () => {
        const h = await seedAccount(app.pool, { handleSha256: randomHandle() });
        const handle = h.handleSha256!;
        const terms = topUp(handle, { allowanceMicros: 3_000_000, amountMicros: 3_003_000 });
        const a = await post(app, "/v1/orders", terms);
        const b = await post(app, "/v1/orders", terms);
        await payLink(a.body, terms);
        const second = await signedPayment(withHints(b.body.paymentRequired.accepts[0]), app.payer);
        await post(app, "/v1/orders", { ...terms, payment: second });
        expect(await findOrder(app.pool, b.body.orderId)).toMatchObject({
            state: "refunding",
            x402Refusal: "allowance_ceiling",
        });
        expect(await refundRow(b.body.orderId)).toEqual({
            kind: "full",
            reason: "x402_ceiling",
            amountMicros: 3_003_000,
            fromWallet: "allowance",
        });
        expect(await fundings(handle)).toEqual([
            expect.objectContaining({
                orderId: a.body.orderId,
                allowanceMicros: 3_000_000,
                voidedAt: null,
            }),
        ]);
    });

    it("never moves the pool below zero", async () => {
        const h = await seedAccount(app.pool, { handleSha256: randomHandle() });
        const handle = h.handleSha256!;
        const terms = topUp(handle);
        const a = await post(app, "/v1/orders", terms);
        expect(await readPool(app.pool)).toEqual({ committedMicros: 0, unpaidMicros: 1_000_000 });
        await payLink(a.body, terms);
        expect(await readPool(app.pool)).toEqual({
            committedMicros: 1_000_000,
            unpaidMicros: 0,
        });
        const noFee = { ...terms, feeMicros: 0, amountMicros: 1_000_000 };
        const b = await post(app, "/v1/orders", noFee);
        await app.pool.query("update x402_accounts set state = 'closing' where id = $1", [h.id]);
        const p = await signedPayment(withHints(b.body.paymentRequired.accepts[0]), app.payer);
        await post(app, "/v1/orders", { ...noFee, payment: p });
        expect(await stateOf(b.body.orderId)).toBe("refunding");
        expect(await readPool(app.pool)).toEqual({
            committedMicros: 1_000_000,
            unpaidMicros: 0,
        });
    });
});
