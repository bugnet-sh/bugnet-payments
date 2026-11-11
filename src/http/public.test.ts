import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import { create as protoCreate } from "@bufbuild/protobuf";
import {
    decodePaymentRequiredHeader,
    decodePaymentResponseHeader,
    encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSettings } from "../config.ts";
import { CheckPayerResponseSchema, PayerVerdict } from "../gen/bugnet/router/v1/payments_pb.ts";
import { newOrderId } from "../orders/ids.ts";
import { findPaymentByOrder } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { usdcAta } from "../solana/accounts.ts";
import { create, get, post, testApp, type TestApp, totalCalls, withHints } from "../testing/app.ts";
import { testSigner } from "../testing/keys.ts";
import { seedAllowanceOrder, seedOrder } from "../testing/orders.ts";
import { signedPayment } from "../testing/payment.ts";
import { seedAccount } from "../testing/x402.ts";
import { setControls } from "../x402/controls.ts";
import { requirementsFor } from "../x402/challenge.ts";
import { publicState } from "./public.ts";
import { clientIp } from "./server.ts";

let app: TestApp;
let order: OrderRow;

function inFuture(ms: number): Date {
    return new Date(app.now.get().getTime() + ms);
}

async function unpaid(over: Partial<OrderRow> = {}): Promise<OrderRow> {
    return (await seedOrder(app.pool, { expiresAt: inFuture(15 * 60_000), ...over })).order;
}

function requirementsOf(o: OrderRow): PaymentRequirements {
    return withHints(
        requirementsFor(o, {
            publicUrl: app.settings.http.public_url,
            recipient: app.settings.solana.recipient,
            allowanceWallet: app.allowance.address,
            feePayer: app.feePayer.address,
            transactionVersions: app.settings.solana.transaction_versions,
        }),
    );
}

async function headerFor(o: OrderRow, who = app.payer): Promise<string> {
    return encodePaymentSignatureHeader(await signedPayment(requirementsOf(o), who));
}

let ipSeq = 0;

// Each call gets its own client address behind the trusted proxy, so the per-IP limiters never
// depend on test order
function freshIp(): string {
    ipSeq += 1;
    return `10.200.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

function pub(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return get(app, path, { "x-forwarded-for": freshIp(), ...headers });
}

beforeAll(async () => {
    app = await testApp();
});
afterAll(async () => {
    await app.close();
});

beforeEach(async () => {
    order = await unpaid();
    for (const k of Object.keys(app.rpc.calls)) app.rpc.calls[k] = 0;
    app.log.lines.length = 0;
});

describe("publicState", () => {
    const at = new Date("2030-01-01T00:00:00Z");
    const row = (state: OrderRow["state"], expiresAt = new Date(at.getTime() + 1)) =>
        ({ state, expiresAt }) as OrderRow;

    it.each([
        ["unpaid", "unpaid"],
        ["settling", "settling"],
        ["paid", "paid"],
        ["redeemed", "paid"],
        ["expired", "expired"],
        ["refunding", "refunded"],
        ["refunded", "refunded"],
        ["manual", "review"],
    ] as const)("maps %s to %s", (state, out) => {
        expect(publicState(row(state), at)).toBe(out);
    });

    it("maps unpaid at or past expiry to expired but keeps settling", () => {
        expect(publicState(row("unpaid", at), at)).toBe("expired");
        expect(publicState(row("settling", at), at)).toBe("settling");
    });
});

describe("clientIp", () => {
    const fake = (remote: string, xff?: string) =>
        ({
            socket: { remoteAddress: remote },
            headers: xff === undefined ? {} : { "x-forwarded-for": xff },
        }) as unknown as IncomingMessage;

    it("takes the last forwarded entry only from a trusted socket", () => {
        expect(clientIp(fake("127.0.0.1", "6.6.6.6, 1.2.3.4"), ["127.0.0.1"])).toBe("1.2.3.4");
        expect(clientIp(fake("::ffff:127.0.0.1", "1.2.3.4"), ["127.0.0.1"])).toBe("1.2.3.4");
        expect(clientIp(fake("9.9.9.9", "1.2.3.4"), ["127.0.0.1"])).toBe("9.9.9.9");
        expect(clientIp(fake("127.0.0.1"), ["127.0.0.1"])).toBe("127.0.0.1");
    });

    it("matches an IPv4-mapped trusted entry against the plain socket address", () => {
        const { trusted_proxies } = parseSettings(
            `[http]\ntrusted_proxies = ["::ffff:127.0.0.1"]\n[solana]\nrecipient = "${app.settings.solana.recipient}"\n`,
            "t",
        ).http;
        expect(trusted_proxies).toEqual(["127.0.0.1"]);
        expect(clientIp(fake("127.0.0.1", "1.2.3.4"), trusted_proxies)).toBe("1.2.3.4");
    });

    it("keeps a valid IPv6 trusted entry that merely starts with ::ffff:", () => {
        const { trusted_proxies } = parseSettings(
            `[http]\ntrusted_proxies = ["::ffff:7f00:1"]\n[solana]\nrecipient = "${app.settings.solana.recipient}"\n`,
            "t",
        ).http;
        expect(trusted_proxies).toEqual(["::ffff:7f00:1"]);
    });

    it("puts a mapped and a plain forwarded address in one bucket", () => {
        const trusted = ["127.0.0.1"];
        expect(clientIp(fake("127.0.0.1", "::ffff:1.2.3.4"), trusted)).toBe("1.2.3.4");
        expect(clientIp(fake("127.0.0.1", "1.2.3.4"), trusted)).toBe("1.2.3.4");
    });

    it("refuses an invalid trusted proxy entry at config load", () => {
        expect(() =>
            parseSettings(
                `[http]\ntrusted_proxies = ["127.0.0.1", "proxy.local"]\n[solana]\nrecipient = "${app.settings.solana.recipient}"\n`,
                "t",
            ),
        ).toThrow(/proxy\.local/);
    });
});

describe("public order routes", () => {
    it("answers unknown 404 and expired 410 without RPC", async () => {
        const expired = await unpaid({ expiresAt: inFuture(-1_000) });
        const marked = await unpaid({ state: "expired" });
        expect((await pub(`/o/${newOrderId()}`)).status).toBe(404);
        expect((await pub("/o/not-an-id")).status).toBe(404);
        const r = await pub(`/o/${expired.id}`);
        expect(r.status).toBe(410);
        expect(await r.json()).toEqual({ error: "order_expired", orderId: expired.id });
        expect((await pub(`/o/${marked.id}`)).status).toBe(410);
        expect(totalCalls(app.rpc)).toBe(0);
    });

    it("answers 410 order_closed with the public state for refunding, refunded and manual", async () => {
        for (const [state, shown] of [
            ["refunding", "refunded"],
            ["refunded", "refunded"],
            ["manual", "review"],
        ] as const) {
            const o = await unpaid({ state });
            const r = await pub(`/o/${o.id}`);
            expect(r.status).toBe(410);
            expect(await r.json()).toEqual({ error: "order_closed", orderId: o.id, state: shown });
        }
        expect(totalCalls(app.rpc)).toBe(0);
    });

    it("answers a paid POST /o/{id} with a refused funding with 410 and its code", async () => {
        const { order: closed } = await seedAllowanceOrder(app.pool, {
            state: "refunding",
            x402Refusal: "allowance_ceiling",
            expiresAt: inFuture(5 * 60_000),
        });
        const r = await pub(`/o/${closed.id}`, { "payment-signature": await headerFor(closed) });
        expect(r.status).toBe(410);
        expect(await r.json()).toEqual({
            refused: "order_closed",
            orderId: closed.id,
            code: "allowance_ceiling",
        });
    });

    it("answers a settle refusal with charged false and Retry-After", async () => {
        const handleSha256 = randomBytes(32).toString("hex");
        await seedAccount(app.pool, { handleSha256 });
        const { order: hot } = await seedAllowanceOrder(app.pool, {
            handleSha256,
            expiresAt: inFuture(5 * 60_000),
        });
        await setControls(app.pool, { paused: true }, "test", app.now.get());
        try {
            const r = await pub(`/o/${hot.id}`, { "payment-signature": await headerFor(hot) });
            expect(r.status).toBe(503);
            expect(r.headers.get("retry-after")).toBe("30");
            expect(await r.json()).toEqual({
                refused: "x402_paused",
                orderId: hot.id,
                charged: false,
                retryAfterSeconds: 30,
            });
        } finally {
            await setControls(app.pool, { paused: false }, "test", app.now.get());
        }
    });

    it("answers the same 410 in the HTML page and in JSON for every closed state", async () => {
        const past = inFuture(-1_000);
        for (const o of [
            await unpaid({ expiresAt: past }),
            await unpaid({ state: "expired" }),
            await unpaid({ state: "refunding" }),
            await unpaid({ state: "refunded" }),
            await unpaid({ state: "manual" }),
        ]) {
            const json = await pub(`/o/${o.id}`, { accept: "application/json" });
            const html = await pub(`/o/${o.id}`, { accept: "text/html" });
            expect(json.status).toBe(410);
            expect(html.status).toBe(410);
            expect(html.headers.get("content-type")).toMatch(/text\/html/);
        }
    });

    it("challenges an unpaid order with the public URL", async () => {
        const r = await pub(`/o/${order.id}`, { accept: "application/json" });
        expect(r.status).toBe(402);
        const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!);
        expect(pr.resource.url).toBe(`${app.settings.http.public_url}/o/${order.id}`);
        expect(pr.resource.description).toBe(order.description);
        expect(r.headers.get("cache-control")).toBe("no-store");
        expect(await r.json()).toEqual(pr);
    });

    it("answers paid 200 and settling 202", async () => {
        for (const state of ["paid", "redeemed"] as const) {
            const o = await unpaid({ state });
            const r = await pub(`/o/${o.id}`);
            expect(r.status).toBe(200);
            expect(await r.json()).toEqual({ paid: true, orderId: o.id });
        }
        const s = await unpaid({ state: "settling" });
        const r = await pub(`/o/${s.id}`);
        expect(r.status).toBe(202);
        expect(await r.json()).toEqual({ state: "settling", orderId: s.id });
    });

    it("settles a payment and returns the settlement headers", async () => {
        const r = await pub(`/o/${order.id}`, {
            "payment-signature": await headerFor(order),
        });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ paid: true, orderId: order.id });
        const settled = decodePaymentResponseHeader(r.headers.get("payment-response")!);
        expect(settled).toMatchObject({
            success: true,
            payer: app.payer.address,
            transaction: (await findPaymentByOrder(app.pool, order.id))!.txSignature,
        });
        expect(r.headers.get("x-payment-response")).toBe(r.headers.get("payment-response"));
    });

    it("accepts the X-PAYMENT header name and POST", async () => {
        const r = await fetch(`${app.publicOrigin}/o/${order.id}`, {
            method: "POST",
            headers: { "x-payment": await headerFor(order), "x-forwarded-for": freshIp() },
            body: "ignored",
        });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ paid: true, orderId: order.id });
        expect(r.headers.get("payment-response")).not.toBeNull();
    });

    it("repeats the settlement headers for the same payment and omits them for another", async () => {
        const h = await headerFor(order);
        const first = await pub(`/o/${order.id}`, { "payment-signature": h });
        const again = await pub(`/o/${order.id}`, { "payment-signature": h });
        expect(again.status).toBe(200);
        expect(again.headers.get("payment-response")).toBe(first.headers.get("payment-response"));
        const other = await pub(`/o/${order.id}`, {
            "payment-signature": await headerFor(order, await testSigner(4)),
        });
        expect(other.status).toBe(200);
        expect(await other.json()).toEqual({ paid: true, orderId: order.id });
        expect(other.headers.get("payment-response")).toBeNull();
    });

    it("takes the payment path when a payment comes with Accept: text/html", async () => {
        const r = await pub(`/o/${order.id}`, {
            accept: "text/html",
            "payment-signature": await headerFor(order),
        });
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toMatch(/application\/json/);
        expect(await r.json()).toEqual({ paid: true, orderId: order.id });
    });

    it("broadcasts once for two concurrent payments to /o/{id}", async () => {
        const [a, b] = await Promise.all([
            pub(`/o/${order.id}`, { "payment-signature": await headerFor(order) }),
            pub(`/o/${order.id}`, {
                "payment-signature": await headerFor(order, await testSigner(4)),
            }),
        ]);
        expect([a.status, b.status]).toContain(200);
        for (const s of [a.status, b.status]) expect([200, 202]).toContain(s);
        expect([a, b].filter((r) => r.headers.get("payment-response")).length).toBe(1);
        expect(app.rpc.calls.sendTransaction).toBe(1);
    });

    it("a stranger pays and the creator redeems", async () => {
        const created = (await post(app, "/v1/orders", create())).body;
        const stranger = await testSigner(4);
        const p = await signedPayment(withHints(created.paymentRequired.accepts[0]), stranger);
        const paid = await pub(`/o/${created.orderId}`, {
            "payment-signature": encodePaymentSignatureHeader(p),
        });
        expect(paid.status).toBe(200);
        const r = await post(app, "/v1/orders", { orderId: created.orderId, claim: created.claim });
        expect(r.body).toMatchObject({ status: "paid", payer: stranger.address });
        expect((await findPaymentByOrder(app.pool, created.orderId))!.sourceTokenAccount).toBe(
            await usdcAta(stranger.address),
        );
    });

    it("answers 202 with the settling body for a payment on a settling order", async () => {
        const o = await unpaid({ state: "settling" });
        const r = await pub(`/o/${o.id}`, { "payment-signature": await headerFor(o) });
        expect(r.status).toBe(202);
        expect(await r.json()).toEqual({ state: "settling", orderId: o.id });
    });

    it("defaults Retry-After to 5 on a 503 refusal without retryAfterSeconds", async () => {
        const down = await testApp({
            checkPayer: true,
            routerImpl: {
                checkPayer: () => {
                    throw new Error("router down");
                },
            },
        });
        try {
            const o = (await seedOrder(down.pool, { expiresAt: inFuture(15 * 60_000) })).order;
            const h = encodePaymentSignatureHeader(
                await signedPayment(requirementsOf(o), down.payer),
            );
            const r = await get(down, `/o/${o.id}`, { "payment-signature": h });
            expect(r.status).toBe(503);
            expect(r.headers.get("retry-after")).toBe("5");
        } finally {
            await down.close();
        }
    });

    it("prefers PAYMENT-SIGNATURE over X-PAYMENT when both are sent", async () => {
        const good = await headerFor(order);
        const r = await pub(`/o/${order.id}`, {
            "payment-signature": good,
            "x-payment": "%%% not base64 json",
        });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ paid: true, orderId: order.id });
    });

    it("limits status polling to 240 a minute per client IP", async () => {
        const ip = freshIp();
        const poll = () => get(app, `/o/${order.id}/status`, { "x-forwarded-for": ip });
        for (let i = 0; i < 240; i++) expect((await poll()).status).toBe(200);
        expect((await poll()).status).toBe(429);
    });

    it("answers 413 with Connection: close for a body over the limit", async () => {
        const r = await fetch(`${app.publicOrigin}/o/${order.id}`, {
            method: "POST",
            headers: { "x-forwarded-for": freshIp() },
            body: "x".repeat(app.settings.http.max_body_bytes + 1),
        });
        expect(r.status).toBe(413);
        expect(r.headers.get("connection")).toBe("close");
        expect(await r.json()).toEqual({ error: "body_too_large" });
    });

    it("counts a request with an oversized body on the per-IP limiter", async () => {
        const ip = freshIp();
        const big = await fetch(`${app.publicOrigin}/o/${order.id}`, {
            method: "POST",
            headers: { "x-forwarded-for": ip },
            body: "x".repeat(app.settings.http.max_body_bytes + 1),
        });
        expect(big.status).toBe(413);
        const limit = app.settings.limits.public_per_ip_per_minute;
        for (let i = 0; i < limit - 1; i++) {
            expect((await get(app, `/o/${order.id}`, { "x-forwarded-for": ip })).status).toBe(402);
        }
        expect((await get(app, `/o/${order.id}`, { "x-forwarded-for": ip })).status).toBe(429);
    });

    it("ends quietly when the client hangs up mid-body", async () => {
        const port = new URL(app.publicOrigin).port;
        const sock = connect(Number(port), "127.0.0.1");
        await new Promise((resolve) => sock.once("connect", resolve));
        sock.write(
            `POST /o/${order.id} HTTP/1.1\r\nHost: x\r\nx-forwarded-for: ${freshIp()}\r\n` +
                "Content-Length: 100\r\n\r\nabc",
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        sock.destroy();
        await vi.waitFor(() => {
            expect(app.log.lines.some((l) => l["msg"] === "client hung up mid-body")).toBe(true);
        });
        expect(app.log.lines.filter((l) => l["level"] === "error")).toEqual([]);
    });

    it("answers the refusal shape for 413, 405 and 429 on the payment path", async () => {
        const h = await headerFor(order);
        const big = await fetch(`${app.publicOrigin}/o/${order.id}`, {
            method: "POST",
            headers: { "x-forwarded-for": freshIp(), "payment-signature": h },
            body: "x".repeat(app.settings.http.max_body_bytes + 1),
        });
        expect(big.status).toBe(413);
        expect(await big.json()).toEqual({ refused: "body_too_large" });

        const put = await fetch(`${app.publicOrigin}/o/${order.id}`, {
            method: "PUT",
            headers: { "x-forwarded-for": freshIp(), "payment-signature": h },
        });
        expect(put.status).toBe(405);
        expect(await put.json()).toEqual({ refused: "method_not_allowed" });

        const ip = freshIp();
        const limit = app.settings.limits.public_per_ip_per_minute;
        for (let i = 0; i < limit; i++) {
            await get(app, "/o/not-an-id", { "x-forwarded-for": ip, "payment-signature": h });
        }
        const limited = await get(app, "/o/not-an-id", {
            "x-forwarded-for": ip,
            "payment-signature": h,
        });
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
        expect(await limited.json()).toEqual({ refused: "too_many_requests" });
    });

    it("answers a malformed id on the payment path with the refusal shape", async () => {
        const r = await pub("/o/not-an-id", { "payment-signature": await headerFor(order) });
        expect(r.status).toBe(404);
        expect(await r.json()).toEqual({ refused: "order_unknown" });
        const plain = await pub("/o/not-an-id");
        expect(await plain.json()).toEqual({ error: "order_unknown" });
    });

    it("answers an undecodable payment header 400 payment_malformed", async () => {
        const r = await pub(`/o/${order.id}`, { "payment-signature": "%%% not base64 json" });
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ refused: "payment_malformed", orderId: order.id });
    });

    it("answers healthz without counting it against the per-IP limit", async () => {
        for (let i = 0; i < 70; i++) {
            const r = await pub("/healthz", { "x-forwarded-for": "10.1.1.1" });
            expect(r.status).toBe(200);
            expect(await r.json()).toEqual({ ok: true });
        }
        expect((await pub("/o/not-an-id", { "x-forwarded-for": "10.1.1.1" })).status).toBe(404);
    });

    it("never limits checkout status polling at 100 calls a minute from one IP", async () => {
        for (let i = 0; i < 100; i++) {
            const r = await pub(`/o/${order.id}/status`, { "x-forwarded-for": "10.2.2.2" });
            expect(r.status).toBe(200);
        }
    });

    it("never answers 402 once a payment is presented", async () => {
        const wrongMemo = await headerFor(await unpaid());
        const expired = await unpaid({ expiresAt: inFuture(-1_000) });
        const cases: [string, string, number, string][] = [
            [order.id, "%%% not base64 json", 400, "payment_malformed"],
            [order.id, wrongMemo, 422, "payment_order_mismatch"],
            [expired.id, await headerFor(expired), 410, "order_expired"],
            [newOrderId(), await headerFor(order), 404, "order_unknown"],
        ];
        for (const [id, h, status, refused] of cases) {
            const r = await pub(`/o/${id}`, { "payment-signature": h });
            expect(r.status).toBe(status);
            expect(await r.json()).toMatchObject({ refused, orderId: id });
        }
    });

    it("refuses a blocked payer, then limits repeated attempts with Retry-After", async () => {
        const blocked = await testApp({
            checkPayer: true,
            routerImpl: {
                checkPayer: () =>
                    protoCreate(CheckPayerResponseSchema, { verdict: PayerVerdict.BLOCKED }),
            },
        });
        try {
            const o = (await seedOrder(blocked.pool, { expiresAt: inFuture(15 * 60_000) })).order;
            const h = encodePaymentSignatureHeader(
                await signedPayment(requirementsOf(o), blocked.payer),
            );
            for (let i = 0; i < 5; i++) {
                const r = await get(blocked, `/o/${o.id}`, {
                    "payment-signature": h,
                    "x-forwarded-for": `10.3.3.${i}`,
                });
                expect(r.status).toBe(403);
                expect(await r.json()).toMatchObject({ refused: "payer_blocked", orderId: o.id });
            }
            const last = await get(blocked, `/o/${o.id}`, { "payment-signature": h });
            expect(last.status).toBe(429);
            expect(await last.json()).toMatchObject({ refused: "too_many_attempts" });
            expect(last.headers.get("retry-after")).toMatch(/^\d+$/);
            expect(blocked.rpc.calls.sendTransaction).toBe(0);
        } finally {
            await blocked.close();
        }
    });

    it("serves a status without RPC", async () => {
        const r = await pub(`/o/${order.id}/status`);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({
            orderId: order.id,
            state: "unpaid",
            expiresAt: order.expiresAt.toISOString(),
            now: app.now.get().toISOString(),
            amountMicros: order.amountMicros,
            kind: order.kind,
            deposit: null,
        });
        const lapsed = await unpaid({ expiresAt: inFuture(-1_000) });
        expect(
            ((await (await pub(`/o/${lapsed.id}/status`)).json()) as { state: string }).state,
        ).toBe("expired");
        expect((await pub(`/o/${newOrderId()}/status`)).status).toBe(404);
        expect(totalCalls(app.rpc)).toBe(0);
    });

    it("limits requests per client IP, trusting X-Forwarded-For only from proxies", async () => {
        const probe = (ip: string) => pub(`/o/${newOrderId()}`, { "x-forwarded-for": ip });
        for (let i = 0; i < 60; i++) expect((await probe("10.4.4.4")).status).toBe(404);
        const limited = await probe("10.4.4.4");
        expect(limited.status).toBe(429);
        expect(await limited.json()).toEqual({ error: "too_many_requests" });
        expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
        expect((await probe("10.5.5.5")).status).toBe(404);

        const untrusted = await testApp({ trustedProxies: ["10.0.0.1"] });
        try {
            for (let i = 0; i < 60; i++) {
                const r = await get(untrusted, `/o/${newOrderId()}`, {
                    "x-forwarded-for": `10.6.6.${i}`,
                });
                expect(r.status).toBe(404);
            }
            const r = await get(untrusted, `/o/${newOrderId()}`, { "x-forwarded-for": "10.6.7.1" });
            expect(r.status).toBe(429);
        } finally {
            await untrusted.close();
        }
    });

    it("answers unknown paths 404 and wrong methods 405", async () => {
        expect((await pub("/nope", { "x-forwarded-for": "10.7.7.7" })).status).toBe(404);
        const r = await fetch(`${app.publicOrigin}/o/${order.id}/status`, {
            method: "POST",
            headers: { "x-forwarded-for": freshIp() },
        });
        expect(r.status).toBe(405);
    });

    it("never logs a payment header", async () => {
        const h = await headerFor(order);
        await pub(`/o/${order.id}`, { "payment-signature": h });
        expect(app.log.lines.length).toBeGreaterThan(0);
        expect(JSON.stringify(app.log.lines)).not.toContain(h.slice(0, 40));
    });
});

describe("paid_via", () => {
    async function paidVia(id: string): Promise<string | null> {
        const r = await app.pool.query("select paid_via from orders where id = $1", [id]);
        return r.rows[0].paid_via;
    }

    function internalPay(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
        return fetch(`${app.internalUrl}/v1/orders`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.secrets.paymentsToken}`,
                "content-type": "application/json",
                ...headers,
            },
            body: JSON.stringify(body),
        });
    }

    it("stores checkout for a payment to /o/{id} with Bugnet-Client: checkout", async () => {
        const r = await pub(`/o/${order.id}`, {
            "payment-signature": await headerFor(order),
            "Bugnet-Client": "checkout",
        });
        expect(r.status).toBe(200);
        expect(await paidVia(order.id)).toBe("checkout");
    });

    it("stores pay_cli without the header or with any other value", async () => {
        const r = await pub(`/o/${order.id}`, { "payment-signature": await headerFor(order) });
        expect(r.status).toBe(200);
        expect(await paidVia(order.id)).toBe("pay_cli");
        const other = await unpaid();
        const o = await pub(`/o/${other.id}`, {
            "payment-signature": await headerFor(other),
            "bugnet-client": "Checkout",
        });
        expect(o.status).toBe(200);
        expect(await paidVia(other.id)).toBe("pay_cli");
    });

    it("leaves unpaid orders without a value", async () => {
        expect(await paidVia(order.id)).toBeNull();
    });

    it("never overwrites the value when a paid order is paid again", async () => {
        const h = await headerFor(order);
        await pub(`/o/${order.id}`, { "payment-signature": h, "bugnet-client": "checkout" });
        const again = await pub(`/o/${order.id}`, { "payment-signature": h });
        expect(again.status).toBe(200);
        expect(await paidVia(order.id)).toBe("checkout");
        const other = await unpaid();
        await pub(`/o/${other.id}`, { "payment-signature": await headerFor(other) });
        const retry = await pub(`/o/${other.id}`, {
            "payment-signature": await headerFor(other),
            "bugnet-client": "checkout",
        });
        expect(retry.status).toBe(200);
        expect(await paidVia(other.id)).toBe("pay_cli");
    });

    it("stores pay_cli for a paid retry on POST /v1/orders, checkout only with the header", async () => {
        for (const [headers, want] of [
            [{}, "pay_cli"],
            [{ "bugnet-client": "checkout" }, "checkout"],
        ] as const) {
            const created = await (await internalPay(create())).json();
            const p = await signedPayment(withHints(created.paymentRequired.accepts[0]), app.payer);
            const r = await internalPay(create({ payment: p }), headers);
            expect((await r.json()).status).toBe("paid");
            expect(await paidVia(created.orderId)).toBe(want);
        }
    });
});

describe("public payment list", () => {
    const PATH = "/api/stats/payments";

    async function paidThroughRoute(): Promise<OrderRow> {
        const o = await unpaid();
        const r = await pub(`/o/${o.id}`, {
            "payment-signature": await headerFor(o),
            "bugnet-client": "checkout",
        });
        expect(r.status).toBe(200);
        return o;
    }

    it("answers the page without a token, cacheable for 30 s", async () => {
        const o = await paidThroughRoute();
        const r = await pub(PATH);
        expect(r.status).toBe(200);
        expect(r.headers.get("cache-control")).toBe("public, max-age=30");
        expect(r.headers.get("content-type")).toBe("application/json");
        expect(r.headers.get("x-content-type-options")).toBe("nosniff");
        const body = await r.json();
        expect(Object.keys(body)).toEqual(["items", "next"]);
        const payment = (await findPaymentByOrder(app.pool, o.id))!;
        expect(body.items).toContainEqual({
            at: app.now.get().toISOString(),
            kind: "sandbox",
            amountMicros: o.amountMicros,
            method: "checkout",
            wallet: app.payer.address,
            tx: payment.txSignature,
        });
    });

    it("answers HEAD with the same headers and no body", async () => {
        const r = await fetch(`${app.publicOrigin}${PATH}`, {
            method: "HEAD",
            headers: { "x-forwarded-for": freshIp() },
        });
        expect(r.status).toBe(200);
        expect(r.headers.get("cache-control")).toBe("public, max-age=30");
        expect(await r.text()).toBe("");
    });

    it("pages with before and ignores every other query parameter", async () => {
        const first = await (await pub(PATH)).json();
        const again = await (await pub(`${PATH}?limit=1&after=x&before=`)).json();
        expect(again).toEqual(first);
    });

    it("answers 400 bad_cursor for a cursor that does not decode or is too long", async () => {
        // The last one has at 8.7e15, past the largest Date
        const pastDates = "eyJhdCI6ODcwMDAwMDAwMDAwMDAwMCwia2luZCI6InNhbmRib3giLCJpZCI6IngifQ";
        for (const before of ["nope!", "e30", "a".repeat(201), pastDates]) {
            const r = await pub(`${PATH}?before=${before}`);
            expect(r.status).toBe(400);
            expect(r.headers.get("cache-control")).toBe("no-store");
            expect(await r.json()).toEqual({ error: "bad_cursor" });
        }
    });

    it("answers 405 with Allow to any method but GET and HEAD", async () => {
        for (const method of ["POST", "PUT", "DELETE"]) {
            const r = await fetch(`${app.publicOrigin}${PATH}`, {
                method,
                headers: { "x-forwarded-for": freshIp() },
            });
            expect(r.status).toBe(405);
            expect(r.headers.get("allow")).toBe("GET, HEAD");
            expect(await r.json()).toEqual({ error: "method_not_allowed" });
        }
    });

    it("counts against the per-IP limit of the other public routes", async () => {
        for (let i = 0; i < 60; i++) {
            expect((await pub(PATH, { "x-forwarded-for": "10.9.9.9" })).status).toBe(200);
        }
        const limited = await pub(PATH, { "x-forwarded-for": "10.9.9.9" });
        expect(limited.status).toBe(429);
    });
});
