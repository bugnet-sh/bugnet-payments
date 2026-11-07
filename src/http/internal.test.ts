import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryLog } from "../log.ts";
import { newOrderId } from "../orders/ids.ts";
import { findOrder } from "../orders/store.ts";
import { create, post, testApp, type TestApp, until } from "../testing/app.ts";
import { seedAllowanceOrder, seedOrder } from "../testing/orders.ts";
import { agentPin, seedAccount, seedFunding } from "../testing/x402.ts";
import { readPool } from "../x402/ledger.ts";
import type { OrderServiceDeps } from "../orders/service.ts";
import { createInternalHandler } from "./internal.ts";
import { bearerOk, startServer } from "./server.ts";

let app: TestApp;
let lookup: "unknown" | "error" = "unknown";

beforeAll(async () => {
    app = await testApp({
        routerImpl: {
            lookupPlacement: () => {
                throw new ConnectError(
                    lookup === "error" ? "down" : "HANDLE_UNKNOWN",
                    lookup === "error" ? Code.Unavailable : Code.NotFound,
                );
            },
        },
    });
});
afterAll(async () => {
    await app.close();
});

function raw(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${app.internalUrl}${path}`, init);
}

// fetch cannot send a request target that URL rejects, so these go over a bare socket
function rawRequestLine(target: string): Promise<string> {
    const { port } = new URL(app.internalUrl);
    return new Promise((resolve, reject) => {
        let out = "";
        const sock = connect(Number(port), "127.0.0.1", () => {
            sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        });
        sock.setEncoding("utf8");
        sock.on("data", (chunk: string) => (out += chunk));
        sock.on("error", reject);
        sock.on("close", () => resolve(out.split("\r\n", 1)[0]!));
    });
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

    it("answers 413 and closes the connection when a chunked body passes the limit", async () => {
        const { port } = new URL(app.internalUrl);
        const max = app.settings.http.max_body_bytes;
        const out = await new Promise<string>((resolve, reject) => {
            let text = "";
            const sock = connect(Number(port), "127.0.0.1", () => {
                sock.write(
                    "POST /v1/orders HTTP/1.1\r\nHost: x\r\n" +
                        `Authorization: Bearer ${app.secrets.paymentsToken}\r\n` +
                        "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
                );
                const chunk = "x".repeat(max + 1);
                sock.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
            });
            sock.setEncoding("utf8");
            sock.on("data", (c: string) => (text += c));
            sock.on("error", (err: NodeJS.ErrnoException) =>
                err.code === "ECONNRESET" ? resolve(text) : reject(err),
            );
            sock.on("close", () => resolve(text));
        });
        expect(out.split("\r\n", 1)[0]).toBe("HTTP/1.1 413 Payload Too Large");
        expect(out.toLowerCase()).toContain("connection: close");
        expect(out).toContain('"reason":"bad_request"');
    });

    it("records an abandon hint without changing state", async () => {
        const { order } = await seedOrder(app.pool, {
            state: "redeemed",
            paidAt: app.now.get(),
            payer: "P",
            redeemedAt: app.now.get(),
            tokenExpiresAt: new Date(app.now.get().getTime() + 600_000),
        });
        const r = await post(app, `/v1/orders/${order.id}/abandon`, { reason: "denied" });
        expect(r.status).toBe(204);
        expect(r.body).toBeUndefined();
        expect(await findOrder(app.pool, order.id)).toMatchObject({
            state: "redeemed",
            abandonReason: "denied",
            abandonAt: app.now.get(),
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

    it.each(["//[", "http://a:99999/"])(
        "answers 404 to the request target %s that URL rejects and keeps serving",
        async (target) => {
            expect(await rawRequestLine(target)).toBe("HTTP/1.1 404 Not Found");
            await until(async () => app.log.lines.some((l) => l.path === target), 2_000);
            const line = app.log.lines.findLast((l) => l.path === target)!;
            expect(line).toMatchObject({ msg: "request", method: "GET", status: 404 });
            const r = await raw("/healthz", { method: "GET" });
            expect(r.status).toBe(200);
        },
    );

    it("answers 503 for events when no event handler is wired", async () => {
        const s = await startServer(
            "127.0.0.1:0",
            createInternalHandler({
                service: {} as OrderServiceDeps,
                token: "t",
                maxBodyBytes: 1024,
                log: memoryLog(),
            }),
            memoryLog(),
        );
        try {
            const r = await fetch(`http://127.0.0.1:${s.port}/v1/events`, {
                method: "POST",
                body: "{}",
            });
            expect(r.status).toBe(503);
            expect(await r.json()).toEqual({ error: "events_disabled" });
        } finally {
            await s.close();
        }
    });

    it("takes events without a bearer token and refuses an unsigned one", async () => {
        const r = await raw("/v1/events", { method: "POST", body: "{}" });
        expect(r.status).toBe(401);
        expect(await r.json()).toEqual({ error: "bad_signature" });
    });

    it("answers 404 for an unknown route", async () => {
        const r = await post(app, "/v1/nothing", {});
        expect(r.status).toBe(404);
        expect(r.body).toEqual({ error: "not_found" });
    });

    it("never logs a claim", async () => {
        const r = await post(app, "/v1/orders", create());
        expect(r.body.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const key = "toolu_01NEVERLOGCLAIMREPLAY0001";
        const first = await post(app, "/v1/orders", create({ idempotencyKey: key }));
        const replay = await post(app, "/v1/orders", create({ idempotencyKey: key }));
        expect(replay.body.claim).toBe(first.body.claim);
        const paid = await seedOrder(app.pool, {
            state: "paid",
            createdAt: app.now.get(),
            expiresAt: new Date(app.now.get().getTime() + 900_000),
            paidAt: app.now.get(),
            payer: "P",
        });
        const redeemed = await post(app, "/v1/orders", {
            orderId: paid.order.id,
            claim: paid.claim,
        });
        expect(redeemed.body.status).toBe("paid");
        const text = JSON.stringify(app.log.lines);
        for (const claim of [r.body.claim, first.body.claim, paid.claim]) {
            expect(text).not.toContain(claim);
        }
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
    it("logs 499 when the client hangs up before any answer", async () => {
        const log = memoryLog();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const s = await startServer(
            "127.0.0.1:0",
            async () => {
                await gate;
            },
            log,
        );
        try {
            const sock = connect(s.port, "127.0.0.1", () => {
                sock.write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n");
                setTimeout(() => sock.destroy(), 50);
            });
            await until(async () => log.lines.some((l) => l.msg === "request"), 2_000);
            expect(log.lines.find((l) => l.msg === "request")).toMatchObject({ status: 499 });
        } finally {
            release();
            await s.close();
        }
    });

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

describe("internal API with x402", () => {
    it("answers 503 rpc_unavailable when a pin cannot be checked, and creates nothing", async () => {
        const down = await testApp({
            rpc: {
                getAccountInfo: () => {
                    throw new Error("rpc down");
                },
            },
        });
        try {
            const a = await seedAccount(down.pool, { handleSha256: "77".repeat(32) });
            const r = await post(down, "/v1/orders", {
                kind: "allowance",
                packageId: "x402-allowance",
                handleSha256: a.handleSha256,
                amountMicros: 1_003_000,
                allowanceMicros: 1_000_000,
                feeMicros: 3_000,
                description: "ignored",
                x402: { services: [agentPin()] },
            });
            expect(r.status).toBe(503);
            expect(r.body).toEqual({ error: "rpc_unavailable" });
            const warned = down.log.lines.filter((l) => l.msg === "x402 payee check unreachable");
            expect(warned).toHaveLength(1);
            expect(warned[0]).toMatchObject({ level: "warn", errorClass: "Error" });
            expect(JSON.stringify(warned[0])).not.toContain("rpc down");
            const orders = await down.pool.query("select id from orders");
            expect(orders.rows).toEqual([{ id: a.id }]);
            expect(await readPool(down.pool)).toEqual({ committedMicros: 0, unpaidMicros: 0 });
        } finally {
            await down.close();
        }
    });
});

it("abandon on an allowance order answers 204 and records nothing", async () => {
    const { order } = await seedAllowanceOrder(app.pool, {
        handleSha256: randomBytes(32).toString("hex"),
        state: "redeemed",
    });
    const r = await post(app, `/v1/orders/${order.id}/abandon`, { reason: "denied" });
    expect(r.status).toBe(204);
    expect(await findOrder(app.pool, order.id)).toMatchObject({
        abandonAt: null,
        abandonReason: null,
    });
});

describe("x402 routes", () => {
    const iget = (path: string, auth = true) =>
        fetch(`${app.internalUrl}${path}`, {
            headers: auth ? { authorization: `Bearer ${app.secrets.paymentsToken}` } : {},
        });

    it("every route needs the bearer token", async () => {
        for (const p of [
            "/v1/x402/terms",
            `/v1/x402/accounts/${"ab".repeat(32)}`,
            "/v1/x402/sellers?hosts=a.example",
        ]) {
            const r = await iget(p, false);
            expect(r.status).toBe(401);
            expect(await r.json()).toEqual({ status: "refused", reason: "unauthorized" });
        }
        const r = await fetch(`${app.internalUrl}/v1/x402/configure`, {
            method: "POST",
            body: "{}",
        });
        expect(r.status).toBe(401);
    });

    it("the account route answers 200 and never 404", async () => {
        lookup = "unknown";
        try {
            const none = await iget(`/v1/x402/accounts/${"cd".repeat(32)}`);
            expect(none.status).toBe(200);
            expect(await none.json()).toEqual({ x402: null, feeDue: true });
            const handle = randomBytes(32).toString("hex");
            const { order: start } = await seedOrder(app.pool, {
                kind: "start",
                payInto: "allowance",
                amountMicros: 1_013_000,
                allowanceMicros: 1_000_000,
                feeMicros: 3_000,
                state: "redeemed",
            });
            await seedAccount(app.pool, {
                id: start.id,
                handleSha256: handle,
                fundedMicros: 1_000_000,
            });
            await seedFunding(app.pool, {
                accountId: start.id,
                orderId: start.id,
                allowanceMicros: 1_000_000,
            });
            const found = await (await iget(`/v1/x402/accounts/${handle}`)).json();
            expect(found).toMatchObject({ x402: { state: "open" }, feeDue: false });
            lookup = "error";
            const down = await iget(`/v1/x402/accounts/${"ef".repeat(32)}`);
            expect(down.status).toBe(503);
            expect(await down.json()).toEqual({ error: "router_unavailable" });
            const bad = await iget("/v1/x402/accounts/ABC");
            expect(bad.status).toBe(400);
            expect(await bad.json()).toEqual({ status: "refused", reason: "bad_request" });
        } finally {
            lookup = "unknown";
        }
    });

    it("serves terms, configure and sellers", async () => {
        expect((await (await iget("/v1/x402/terms")).json()).bugnetAddresses).toHaveLength(4);
        const bad = await post(app, "/v1/x402/configure", {
            handleSha256: "ab".repeat(32),
            requestId: "short",
        });
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ status: "refused", reason: "bad_request" });
        const noAccount = await post(app, "/v1/x402/configure", {
            handleSha256: "ab".repeat(32),
            requestId: "req_0123456789abcdef",
        });
        expect(noAccount.status).toBe(200);
        expect(noAccount.body).toEqual({ status: "refused", reason: "no_account" });
        const hosts = Array.from({ length: 21 }, (_, i) => `h${i}.example`).join(",");
        expect((await iget(`/v1/x402/sellers?hosts=${hosts}`)).status).toBe(400);
        expect(await (await iget("/v1/x402/sellers?hosts=a.example")).json()).toEqual({
            "a.example": { paidCalls30d: 0, failedPaid30d: 0 },
        });
        expect((await iget("/v1/x402/nothing")).status).toBe(404);
    });
});
