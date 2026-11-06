import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryLog } from "../log.ts";
import { newOrderId } from "../orders/ids.ts";
import { findOrder } from "../orders/store.ts";
import { create, now, post, testApp, type TestApp } from "../testing/app.ts";
import { seedOrder } from "../testing/orders.ts";
import { bearerOk, startServer } from "./server.ts";

let app: TestApp;

beforeAll(async () => {
    app = await testApp();
});
afterAll(async () => {
    await app.close();
});

function raw(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${app.internalUrl}${path}`, init);
}

async function orderCount(): Promise<number> {
    return (await app.pool.query("select count(*)::int as n from orders")).rows[0].n;
}

describe("internal API", () => {
    it("rejects a bad bearer and a malformed body", async () => {
        const before = await orderCount();
        for (const authorization of [
            undefined,
            "Bearer wrong",
            `Basic ${app.secrets.paymentsToken}`,
        ]) {
            const r = await raw("/v1/orders", {
                method: "POST",
                headers: authorization === undefined ? {} : { authorization },
                body: JSON.stringify(create()),
            });
            expect(r.status).toBe(401);
            expect(await r.json()).toEqual({ status: "refused", reason: "unauthorized" });
        }
        const bad = await raw("/v1/orders", {
            method: "POST",
            headers: { authorization: `Bearer ${app.secrets.paymentsToken}` },
            body: "{not json",
        });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({ status: "refused", reason: "bad_request" });
        const invalid = await post(app, "/v1/orders", create({ amountMicros: 0 }));
        expect(invalid.status).toBe(400);
        expect(invalid.body).toEqual({ status: "refused", reason: "bad_request" });
        expect(await orderCount()).toBe(before);
    });

    it("accepts the bearer scheme in any case", async () => {
        const r = await raw("/v1/orders", {
            method: "POST",
            headers: { authorization: `bearer ${app.secrets.paymentsToken}` },
            body: JSON.stringify(create()),
        });
        expect(r.status).toBe(200);
        expect((await r.json()).status).toBe("payment_required");
    });

    it("refuses a body over the limit with 413", async () => {
        const r = await post(app, "/v1/orders", {
            ...create(),
            pad: "x".repeat(app.settings.http.max_body_bytes),
        });
        expect(r.status).toBe(413);
        expect(r.body).toEqual({ status: "refused", reason: "bad_request" });
    });

    it("records an abandon hint without changing state", async () => {
        const { order } = await seedOrder(app.pool, {
            state: "redeemed",
            paidAt: now(),
            payer: "P",
            redeemedAt: now(),
            tokenExpiresAt: new Date(now().getTime() + 600_000),
        });
        const r = await post(app, `/v1/orders/${order.id}/abandon`, { reason: "denied" });
        expect(r.status).toBe(204);
        expect(r.body).toBeUndefined();
        expect(await findOrder(app.pool, order.id)).toMatchObject({
            state: "redeemed",
            abandonReason: "denied",
            abandonAt: now(),
        });
        const unknown = await post(app, `/v1/orders/${newOrderId()}/abandon`, { reason: "denied" });
        expect(unknown.status).toBe(404);
        expect(unknown.body).toEqual({ status: "refused", reason: "order_unknown" });
        const malformed = await post(app, "/v1/orders/ord_X/abandon", { reason: "denied" });
        expect(malformed.status).toBe(404);
        expect(malformed.body).toEqual({ status: "refused", reason: "order_unknown" });
    });

    it("refuses an abandon without a reason", async () => {
        const { order } = await seedOrder(app.pool);
        for (const body of [{}, { reason: "" }, { reason: 3 }, { reason: "a\nb" }]) {
            const r = await post(app, `/v1/orders/${order.id}/abandon`, body);
            expect(r.status).toBe(400);
            expect(r.body).toEqual({ status: "refused", reason: "bad_request" });
        }
        expect((await findOrder(app.pool, order.id))!.abandonAt).toBeNull();
    });

    it("requires the bearer for abandon", async () => {
        const { order } = await seedOrder(app.pool);
        const r = await raw(`/v1/orders/${order.id}/abandon`, {
            method: "POST",
            body: JSON.stringify({ reason: "denied" }),
        });
        expect(r.status).toBe(401);
        expect((await findOrder(app.pool, order.id))!.abandonAt).toBeNull();
    });

    it("answers healthz without a bearer", async () => {
        const r = await raw("/healthz", { method: "GET" });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ ok: true });
    });

    it("answers 503 for events when no event handler is wired", async () => {
        const r = await raw("/v1/events", { method: "POST", body: "{}" });
        expect(r.status).toBe(503);
        expect(await r.json()).toEqual({ error: "events_disabled" });
    });

    it("answers 404 for an unknown route", async () => {
        const r = await post(app, "/v1/nothing", {});
        expect(r.status).toBe(404);
        expect(r.body).toEqual({ error: "not_found" });
    });

    it("never logs a claim", async () => {
        const r = await post(app, "/v1/orders", create());
        expect(r.body.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(JSON.stringify(app.log.lines)).not.toContain(r.body.claim);
    });

    it("writes an access log line with method, path, status, ms and IP only", async () => {
        await post(app, "/v1/orders?x=1", create());
        const line = app.log.lines.findLast((l) => l.msg === "request")!;
        expect(Object.keys(line).sort()).toEqual(
            ["ip", "level", "method", "ms", "msg", "path", "service", "status", "t"].sort(),
        );
        expect(line).toMatchObject({ method: "POST", path: "/v1/orders", status: 200 });
        expect(line.ip).toMatch(/127\.0\.0\.1$/);
        expect(typeof line.ms).toBe("number");
    });
});

describe("server", () => {
    it("answers 500 internal when a handler throws", async () => {
        const log = memoryLog();
        const s = await startServer(
            "127.0.0.1:0",
            async () => {
                throw new Error("boom");
            },
            log,
        );
        try {
            const r = await fetch(`http://127.0.0.1:${s.port}/x`);
            expect(r.status).toBe(500);
            expect(await r.json()).toEqual({ error: "internal" });
            expect(log.lines.map((l) => l.msg)).toEqual(["handler failed", "request"]);
        } finally {
            await s.close();
        }
    });

    it("checks a bearer token", () => {
        expect(bearerOk("Bearer s3cret", "s3cret")).toBe(true);
        expect(bearerOk("Bearer s3cret ", "s3cret")).toBe(false);
        expect(bearerOk("Bearer s3cre", "s3cret")).toBe(false);
        expect(bearerOk("s3cret", "s3cret")).toBe(false);
        expect(bearerOk(undefined, "s3cret")).toBe(false);
        expect(bearerOk("Bearer ", "")).toBe(false);
    });
});
