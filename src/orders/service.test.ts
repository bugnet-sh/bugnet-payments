import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    create,
    now,
    post,
    terms,
    testApp,
    type TestApp,
    until,
    withHints,
} from "../testing/app.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import { signedPayment } from "../testing/payment.ts";
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
    return new Date(now().getTime() + ms);
}

// seedOrder's own times follow the wall clock, which is years before the frozen app clock
function seed(over: Partial<OrderRow> = {}): Promise<{ order: OrderRow; claim: string }> {
    return seedOrder(app.pool, { createdAt: now(), expiresAt: after(15 * 60_000), ...over });
}

function seedPaid(over: Partial<OrderRow> = {}): Promise<{ order: OrderRow; claim: string }> {
    return seed({ state: "paid", paidAt: now(), payer: "P", ...over });
}

async function stateOf(id: string) {
    return (await findOrder(app.pool, id))!.state;
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
            expires_at: new Date(now().getTime() + 600_000).toISOString(),
        });
        expect(await findOrder(app.pool, order.id)).toMatchObject({
            state: "redeemed",
            redeemedAt: now(),
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
        await setOrderState(app.pool, a.body.orderId, "settling", "paid", { paidAt: now() });
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
        const t0 = new Date(now().getTime() - 60_000);
        const { order, claim } = await seedPaid({
            expiresAt: t0,
            paidAt: new Date(t0.getTime() + 1_000),
        });
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.body).toEqual({ status: "refused", orderId: order.id, reason: "payment_late" });
        expect(await stateOf(order.id)).toBe("paid");
    });

    it("redeems a payment recorded exactly at expiry", async () => {
        const t0 = new Date(now().getTime() - 60_000);
        const { order, claim } = await seedPaid({ expiresAt: t0, paidAt: t0 });
        const r = await post(app, "/v1/orders", { orderId: order.id, claim });
        expect(r.body.status).toBe("paid");
    });

    it("refuses a redeem after the token expired", async () => {
        const { order, claim } = await seedPaid({
            state: "redeemed",
            redeemedAt: new Date(now().getTime() - 600_000),
            tokenExpiresAt: new Date(now().getTime() - 1_000),
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
        const first = await post(app, "/v1/orders", create({ payment: p }));
        const second = await post(app, "/v1/orders", create({ payment: p }));
        expect(first.body.status).toBe("paid");
        expect(second.body.status).toBe("paid");
        expect(second.body.orderToken).toBe(first.body.orderToken);
        expect(second.body.paymentResponse).toEqual(first.body.paymentResponse);
        expect(app.rpc.calls.sendTransaction! - sentBefore).toBe(1);
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
        expect(await abandonOrder(app.pool, order.id, "denied", now())).toBe("recorded");
        expect(await findOrder(app.pool, order.id)).toMatchObject({
            state: "redeemed",
            abandonReason: "denied",
            abandonAt: now(),
        });
    });

    it("answers unknown for a missing or malformed id", async () => {
        expect(await abandonOrder(app.pool, newOrderId(), "denied", now())).toBe("unknown");
        expect(await abandonOrder(app.pool, "ord_X", "denied", now())).toBe("unknown");
    });
});
