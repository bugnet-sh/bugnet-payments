import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { encodePaymentResponseHeader } from "@x402/core/http";
import type pg from "pg";
import { CHECKOUT_CSP, renderCheckout, renderNotFound } from "../checkout/page.ts";
import type { Log } from "../log.ts";
import { isOrderId } from "../orders/ids.ts";
import { type PayDeps, type PayOutcome, payOrder } from "../orders/pay.ts";
import { findOrder } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import type { RateLimiter } from "../ratelimit.ts";
import type { BlockhashCache } from "../solana/blockhash.ts";
import { SOLANA_MAINNET } from "../solana/constants.ts";
import {
    type ChallengeContext,
    challengeFor,
    paymentRequiredHeaders,
    payUrlFor,
} from "../x402/challenge.ts";
import { parsePaymentHeader } from "../x402/decode.ts";
import { type Handler, hangupSignal, requestPath, sendJson } from "./server.ts";

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

export function publicState(o: OrderRow, now: Date): PublicState {
    switch (o.state) {
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
    }
}

function unmapped(address: string | undefined): string {
    return (address ?? "").replace(/^::ffff:/i, "");
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

// A header that does not decode still takes the payment path: it must come back as a refusal,
// never as a fresh 402. An object with no payload decodes to payment_malformed there.
function paymentFrom(header: string): unknown {
    try {
        return parsePaymentHeader(header);
    } catch {
        return { x402Version: 2 };
    }
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
    const closed = state === "expired" || state === "refunded" || state === "review";
    sendHtml(res, closed ? 410 : 200, html);
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

function sendOutcome(res: Parameters<Handler>[1], out: PayOutcome): void {
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
                out.samePayment ? settlementHeaders(out.signature!, out.payer!) : {},
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
                    retryAfterSeconds: out.retryAfterSeconds,
                    blockedUntil: out.blockedUntil,
                },
                headers,
            );
        }
    }
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
        const limit = (isStatus ? d.statusPerIp : d.perIp).take(clientIp(req, d.trustedProxies));
        if (!limit.ok) {
            sendJson(
                res,
                429,
                { error: "too_many_requests" },
                {
                    "Retry-After": String(limit.retryAfterSeconds),
                },
            );
            return;
        }
        if (path === "/checkout.js") {
            if (req.method === "GET") await sendScript(res, d.checkoutJsPath);
            else sendJson(res, 405, { error: "method_not_allowed" });
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
            sendJson(res, 405, { error: "method_not_allowed" });
            return;
        }
        // Bodies are never used, and an unread one would hold the connection open
        req.resume();
        const id = route[1]!;
        const header = isStatus ? undefined : paymentHeader(req);
        if (header !== undefined) {
            if (!isOrderId(id)) {
                sendJson(res, 404, { error: "order_unknown" });
                return;
            }
            sendOutcome(res, await payOrder(d.pay, id, paymentFrom(header), hangupSignal(res)));
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
        switch (state) {
            case "expired":
                sendJson(res, 410, { error: "order_expired", orderId: order.id });
                return;
            case "refunded":
            case "review":
                sendJson(res, 410, { error: "order_closed", orderId: order.id, state });
                return;
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
        }
    };
}
