import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { encodePaymentResponseHeader } from "@x402/core/http";
import type pg from "pg";
import { sendFont } from "../checkout/fonts.ts";
import { CHECKOUT_CSP, renderCheckout, renderNotFound } from "../checkout/page.ts";
import type { Log } from "../log.ts";
import { isOrderId } from "../orders/ids.ts";
import { type PayDeps, type PayOutcome, payOrder } from "../orders/pay.ts";
import { findOrder } from "../orders/store.ts";
import type { OrderRow, OrderState } from "../orders/types.ts";
import type { RateLimiter } from "../ratelimit.ts";
import type { BlockhashCache } from "../solana/blockhash.ts";
import { decodeCursor } from "../stats/cursor.ts";
import { statsPayments } from "../stats/payments.ts";
import { SOLANA_MAINNET } from "../solana/constants.ts";
import {
    type ChallengeContext,
    challengeFor,
    paymentRequiredHeaders,
    payUrlFor,
} from "../x402/challenge.ts";
import { PaymentRefusal, parsePaymentHeader } from "../x402/decode.ts";
import {
    BodyTooLarge,
    type Handler,
    drainBody,
    hangupSignal,
    paidVia,
    requestPath,
    sendJson,
} from "./server.ts";

export type PublicState = "unpaid" | "settling" | "paid" | "expired" | "refunded" | "review";

export interface PublicDeps {
    pool: pg.Pool;
    challenge: ChallengeContext;
    hints: BlockhashCache;
    pay: PayDeps;
    perIp: RateLimiter;
    statusPerIp: RateLimiter;
    trustedProxies: readonly string[];
    maxBodyBytes: number;
    checkoutJsPath: string;
    log: Log;
    now: () => Date;
}

const ORDER_PATH = /^\/o\/([^/]+)(\/status)?$/;
const STATS_PAYMENTS = "/api/stats/payments";

function unreachable(state: never): never {
    throw new Error(`unhandled order state ${String(state)}`);
}

export function publicState(o: OrderRow, now: Date): PublicState {
    const state: OrderState = o.state;
    switch (state) {
        case "unpaid":
            return now.getTime() >= o.expiresAt.getTime() ? "expired" : "unpaid";
        case "settling":
            return "settling";
        case "paid":
        case "redeemed":
            return "paid";
        case "expired":
            return "expired";
        case "refunding":
        case "refunded":
            return "refunded";
        case "manual":
            return "review";
        default:
            return unreachable(state);
    }
}

function closedAnswer(
    order: OrderRow,
    state: PublicState,
): { status: 410; body: Record<string, string> } | undefined {
    switch (state) {
        case "expired":
            return { status: 410, body: { error: "order_expired", orderId: order.id } };
        case "refunded":
        case "review":
            return { status: 410, body: { error: "order_closed", orderId: order.id, state } };
        case "unpaid":
        case "settling":
        case "paid":
            return undefined;
        default:
            return unreachable(state);
    }
}

function unmapped(address: string | undefined): string {
    const rest = (address ?? "").replace(/^::ffff:/i, "");
    return isIP(rest) === 4 ? rest : (address ?? "");
}

export function clientIp(req: IncomingMessage, trusted: readonly string[]): string {
    const socket = unmapped(req.socket.remoteAddress);
    if (!trusted.includes(socket)) return socket;
    const forwarded = req.headers["x-forwarded-for"];
    const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)
        ?.split(",")
        .at(-1)
        ?.trim();
    return last ? unmapped(last) : socket;
}

function paymentHeader(req: IncomingMessage): string | undefined {
    for (const name of ["payment-signature", "x-payment"]) {
        const v = req.headers[name];
        if (typeof v === "string" && v !== "") return v;
    }
    return undefined;
}

function wantsHtml(req: IncomingMessage): boolean {
    return /\btext\/html\b/i.test(req.headers.accept ?? "");
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(html)),
        "Content-Security-Policy": CHECKOUT_CSP,
        "Cache-Control": "no-store",
    });
    res.end(html);
}

async function sendCheckout(
    res: ServerResponse,
    d: PublicDeps,
    order: OrderRow | null,
): Promise<void> {
    if (order === null) {
        sendHtml(res, 404, renderNotFound());
        return;
    }
    const state = publicState(order, d.now());
    const html = await renderCheckout({
        orderId: order.id,
        description: order.description,
        amountMicros: order.amountMicros,
        state,
        pageUrl: payUrlFor(d.challenge.publicUrl, order.id),
        origin: new URL(d.challenge.publicUrl).origin,
    });
    sendHtml(res, closedAnswer(order, state)?.status ?? 200, html);
}

async function sendScript(res: ServerResponse, file: string): Promise<void> {
    const body = await readFile(file);
    res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
    });
    res.end(body);
}

function settlementHeaders(transaction: string, payer: string): Record<string, string> {
    const value = encodePaymentResponseHeader({
        success: true,
        transaction,
        network: SOLANA_MAINNET,
        payer,
    });
    return { "PAYMENT-RESPONSE": value, "X-PAYMENT-RESPONSE": value };
}

function sendOutcome(res: ServerResponse, out: PayOutcome): void {
    switch (out.kind) {
        case "paid":
            sendJson(
                res,
                200,
                { paid: true, orderId: out.orderId },
                settlementHeaders(out.signature, out.payer),
            );
            return;
        case "already_paid":
            sendJson(
                res,
                200,
                { paid: true, orderId: out.orderId },
                out.samePayment ? settlementHeaders(out.signature, out.payer) : {},
            );
            return;
        case "settling":
            sendJson(res, 202, { state: "settling", orderId: out.orderId });
            return;
        case "refused": {
            const headers: Record<string, string> = {};
            if (out.httpStatus === 429 || out.httpStatus === 503) {
                headers["Retry-After"] = String(out.retryAfterSeconds ?? 5);
            }
            sendJson(
                res,
                out.httpStatus,
                {
                    refused: out.reason,
                    orderId: out.orderId,
                    code: out.code,
                    charged: out.charged,
                    retryAfterSeconds: out.retryAfterSeconds,
                    blockedUntil: out.blockedUntil,
                },
                headers,
            );
        }
    }
}

async function sendStatsPayments(
    req: IncomingMessage,
    res: ServerResponse,
    d: PublicDeps,
): Promise<void> {
    const common = { "X-Content-Type-Options": "nosniff" };
    const noStore = { ...common, "Cache-Control": "no-store" };
    if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method_not_allowed" }, { ...noStore, Allow: "GET, HEAD" });
        return;
    }
    const raw = URL.parse(req.url ?? "/", "http://local")?.searchParams.get("before") ?? "";
    const before = raw === "" ? null : decodeCursor(raw);
    if (before === null && raw !== "") {
        sendJson(res, 400, { error: "bad_cursor" }, noStore);
        return;
    }
    const page = await statsPayments(d.pool, before, d.now());
    sendJson(res, 200, page, { ...common, "Cache-Control": "public, max-age=30" });
}

export function createPublicHandler(d: PublicDeps): Handler {
    return async (req, res) => {
        const path = requestPath(req.url);
        if (req.method === "GET" && path === "/healthz") {
            sendJson(res, 200, { ok: true });
            return;
        }
        const route = ORDER_PATH.exec(path);
        const isStatus = route?.[2] !== undefined;
        const header = route === null || isStatus ? undefined : paymentHeader(req);
        const refuse = (status: number, reason: string, headers: Record<string, string> = {}) =>
            sendJson(res, status, header === undefined ? { error: reason } : { refused: reason }, {
                ...headers,
            });
        const limit = (isStatus ? d.statusPerIp : d.perIp).take(clientIp(req, d.trustedProxies));
        // No public route takes a body; it is counted against the cap and discarded
        try {
            if (!(await drainBody(req, d.maxBodyBytes))) {
                d.log.info("client hung up mid-body", { path });
                return;
            }
        } catch (err) {
            if (!(err instanceof BodyTooLarge)) throw err;
            refuse(413, "body_too_large", { Connection: "close" });
            return;
        }
        if (!limit.ok) {
            refuse(429, "too_many_requests", { "Retry-After": String(limit.retryAfterSeconds) });
            return;
        }
        if (path === STATS_PAYMENTS) {
            await sendStatsPayments(req, res, d);
            return;
        }
        if (path.startsWith("/fonts/")) return await sendFont(req, res, path, d.checkoutJsPath);
        if (path === "/checkout.js") {
            if (req.method === "GET") await sendScript(res, d.checkoutJsPath);
            else refuse(405, "method_not_allowed");
            return;
        }
        if (route === null) {
            sendJson(res, 404, { error: "not_found" });
            return;
        }
        const allowed = isStatus
            ? req.method === "GET"
            : req.method === "GET" || req.method === "POST";
        if (!allowed) {
            refuse(405, "method_not_allowed");
            return;
        }
        const id = route[1] ?? "";
        if (header !== undefined) {
            if (!isOrderId(id)) {
                sendJson(res, 404, { refused: "order_unknown" });
                return;
            }
            let payment: unknown;
            try {
                payment = parsePaymentHeader(header);
            } catch (err) {
                if (!(err instanceof PaymentRefusal)) throw err;
                sendJson(res, 400, { refused: err.reason, orderId: id });
                return;
            }
            sendOutcome(
                res,
                await payOrder(d.pay, id, payment, hangupSignal(res), null, paidVia(req)),
            );
            return;
        }
        const order = isOrderId(id) ? await findOrder(d.pool, id) : null;
        if (!isStatus && wantsHtml(req)) {
            await sendCheckout(res, d, order);
            return;
        }
        if (order === null) {
            sendJson(res, 404, { error: "order_unknown" });
            return;
        }
        const state = publicState(order, d.now());
        if (isStatus) {
            sendJson(res, 200, {
                orderId: order.id,
                state,
                expiresAt: order.expiresAt.toISOString(),
            });
            return;
        }
        const closed = closedAnswer(order, state);
        if (closed !== undefined) {
            sendJson(res, closed.status, closed.body);
            return;
        }
        switch (state) {
            case "paid":
                sendJson(res, 200, { paid: true, orderId: order.id });
                return;
            case "settling":
                sendJson(res, 202, { state: "settling", orderId: order.id });
                return;
            case "unpaid": {
                const pr = await challengeFor(order, d.challenge, d.hints, d.log);
                sendJson(res, 402, pr, paymentRequiredHeaders(pr));
                return;
            }
            case "expired":
            case "refunded":
            case "review":
                break;
            default:
                unreachable(state);
        }
        d.log.error("order state left without an answer", { orderId: order.id, state });
        sendJson(res, 500, { error: "internal" });
    };
}
