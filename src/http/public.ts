import { readFile } from "node:fs/promises";
import type { Settings } from "../config.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { encodePaymentResponseHeader } from "@x402/core/http";
import type pg from "pg";
import { sendFont } from "../checkout/fonts.ts";
import {
    CHECKOUT_CSP,
    decimalAmount,
    qrSvg,
    renderCheckout,
    renderNotFound,
} from "../checkout/page.ts";
import type { DepositWatch } from "../deposits/job.ts";
import type { DepositKeys } from "../deposits/keys.ts";
import { depositLedger, ensureDeposit } from "../deposits/store.ts";
import type { DepositView } from "../deposits/types.ts";
import {
    depositLapsed,
    depositSummary,
    depositView,
    type DepositSummary,
} from "../deposits/view.ts";
import type { Log } from "../log.ts";
import { isOrderId } from "../orders/ids.ts";
import { type PayDeps, type PayOutcome, payOrder } from "../orders/pay.ts";
import { findOrder } from "../orders/store.ts";
import type { OrderRow, OrderState } from "../orders/types.ts";
import type { IpLimiter, RateLimiter } from "../ratelimit.ts";
import { readTokenAccount, usdcAta } from "../solana/accounts.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";
import type { BlockhashCache } from "../solana/blockhash.ts";
import { decodeCursor } from "../stats/cursor.ts";
import { statsPayments } from "../stats/payments.ts";
import { SOLANA_MAINNET, USDC_MINT } from "../solana/constants.ts";
import { address, isAddress } from "@solana/kit";
import { type IpKey, ipKey } from "./ipkey.ts";
import {
    type ChallengeContext,
    challengeFor,
    paymentRequiredHeaders,
    payUrlFor,
} from "../x402/challenge.ts";
import { PaymentRefusal, parsePaymentHeader } from "../x402/decode.ts";
import {
    BodyTooLarge,
    clientIp,
    type Handler,
    drainBody,
    hangupSignal,
    paidVia,
    readBody,
    requestPath,
    sendJson,
} from "./server.ts";

export type PublicState = "unpaid" | "settling" | "paid" | "expired" | "refunded" | "review";

export interface PublicDeps {
    pool: pg.Pool;
    challenge: ChallengeContext;
    hints: BlockhashCache;
    pay: PayDeps;
    perIp: IpLimiter;
    statusPerIp: IpLimiter;
    trustedProxies: readonly string[];
    maxBodyBytes: number;
    checkoutJsPath: string;
    // What the page shows about returns and how long it keeps checking past the deadline
    depositSettings: Settings["deposits"];
    // null only without a deposit seed; enabled false keeps existing deposits but makes none
    deposits: PublicDeposits | null;
    // The balance route's reads, on the router's background lane once it is merged (spec 13.1)
    backgroundRpc: SolanaRpc;
    balancePerIp: IpLimiter;
    // Process-wide: every balance read, key "all"
    balanceRpc: RateLimiter;
    reportPerIp: IpLimiter;
    rpcTimeoutMs: number;
    log: Log;
    now: () => Date;
}

export interface PublicDeposits {
    keys: DepositKeys;
    watch: DepositWatch;
    enabled: boolean;
    salt?: () => Buffer;
}

export interface BalanceAnswer {
    owner: string;
    usdcMicros: number;
    needMicros: number;
}

const ORDER_PATH = /^\/o\/([^/]+)(?:\/(status|balance|report|qr\.svg))?$/;
const REPORT_MAX_BYTES = 2_048;
const REPORT_STAGES = new Set(["connect", "balance", "challenge", "sign", "submit", "status"]);
const BALANCE_CACHE_MS = 15_000;
const BALANCE_CACHE_SIZE = 1_000;
const STATS_PAYMENTS = "/api/stats/payments";

function unreachable(state: never): never {
    throw new Error(`unhandled order state ${String(state)}`);
}

// dep is the order's deposit summary. Past the deadline the deposit job may still settle the
// order, so it reads settling until a pinned read decided it; and an expired order whose deposit
// took money must not read expired, which the bridge words as "nothing was charged" (spec 8.4).
export function publicState(o: OrderRow, now: Date, dep?: DepositSummary): PublicState {
    const state: OrderState = o.state;
    switch (state) {
        case "unpaid":
            if (now.getTime() < o.expiresAt.getTime()) return "unpaid";
            return depositLapsed(o.expiresAt, now, dep ?? null) ? "expired" : "settling";
        case "settling":
            return "settling";
        case "paid":
        case "redeemed":
            return "paid";
        case "expired":
            if (dep !== undefined && dep.returnedOrReturningMicros + dep.keptMicros > 0) {
                return "refunded";
            }
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
    const now = d.now();
    let deposit: DepositView | null = null;
    if (d.deposits !== null) {
        // The page makes the order's address; the job creates its account once a viewer polls
        if (d.deposits.enabled)
            await ensureDeposit(d.pool, d.deposits.keys, order, now, d.deposits.salt);
        deposit = await depositView(d.pool, order, now, d.depositSettings);
    }
    const state = publicState(order, now);
    const html = await renderCheckout({
        orderId: order.id,
        description: order.description,
        amountMicros: order.amountMicros,
        state,
        pageUrl: payUrlFor(d.challenge.publicUrl, order.id),
        origin: new URL(d.challenge.publicUrl).origin,
        expiresAt: order.expiresAt,
        now,
        kind: order.kind,
        deposit,
        // An existing address still shows when new ones are off
        depositsOffered: deposit !== null,
        refundMinMicros: d.depositSettings.refund_min_micros,
        settleGraceMs: d.depositSettings.settle_grace,
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
    // Each owner's balance for 15 s, so repeated checks of one wallet cost one read
    const balances = new Map<string, { at: number; micros: number }>();
    return async (req, res) => {
        const path = requestPath(req.url);
        if (req.method === "GET" && path === "/healthz") {
            sendJson(res, 200, { ok: true });
            return;
        }
        const route = ORDER_PATH.exec(path);
        const sub = route?.[2];
        const isStatus = sub === "status";
        const header = route === null || sub !== undefined ? undefined : paymentHeader(req);
        const ip = ipKey(clientIp(req, d.trustedProxies));
        const refuse = (status: number, reason: string, headers: Record<string, string> = {}) =>
            sendJson(res, status, header === undefined ? { error: reason } : { refused: reason }, {
                ...headers,
            });
        const limit = (isStatus ? d.statusPerIp : d.perIp).take(ip);
        // Only the report route takes a body; every other one is counted against the cap and
        // discarded
        let body = "";
        try {
            if (sub === "report") {
                body = (await readBody(req, REPORT_MAX_BYTES)).toString("utf8");
            } else if (!(await drainBody(req, d.maxBodyBytes))) {
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
        const allowed =
            sub === "report"
                ? req.method === "POST"
                : sub !== undefined
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
        if (sub === undefined && wantsHtml(req)) {
            await sendCheckout(res, d, order);
            return;
        }
        if (order === null) {
            sendJson(res, 404, { error: "order_unknown" });
            return;
        }
        if (sub === "report") return sendReport(res, d, order, ip, body);
        if (sub === "balance") return sendBalance(req, res, d, order, ip, balances);
        if (sub === "qr.svg") return sendQr(res, d, order);
        if (isStatus) return sendStatus(req, res, d, order, ip);
        const state = publicState(order, d.now());
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

async function orderDeposit(d: PublicDeps, order: OrderRow, now: Date) {
    const ledger = await depositLedger(d.pool, order.id);
    return {
        view: ledger === null ? null : await depositView(d.pool, order, now, d.depositSettings),
        summary:
            ledger === null
                ? undefined
                : depositSummary(order, ledger, d.depositSettings.settle_grace),
        row: ledger?.deposit ?? null,
    };
}

async function sendStatus(
    req: IncomingMessage,
    res: ServerResponse,
    d: PublicDeps,
    order: OrderRow,
    ip: IpKey,
): Promise<void> {
    const now = d.now();
    const dep = await orderDeposit(d, order, now);
    // The checkout page's poll marks a viewer, which keeps the deposit job busy for this order
    if (d.deposits !== null && dep.row !== null && req.headers["bugnet-client"] === "checkout") {
        d.deposits.watch.noteViewer(order.id, ip, now.getTime(), {
            state: dep.row.state,
            expiresAtMs: order.expiresAt.getTime(),
            needsCreate: dep.row.readyAt === null,
        });
    }
    sendJson(
        res,
        200,
        {
            orderId: order.id,
            state: publicState(order, now, dep.summary),
            expiresAt: order.expiresAt.toISOString(),
            now: now.toISOString(),
            amountMicros: order.amountMicros,
            kind: order.kind,
            deposit: dep.view,
        },
        { "Cache-Control": "no-store" },
    );
}

// The page's pre-check before a wallet signs (spec 13.1): reads are cached per owner and capped
// for the whole process, so random owners cannot spend Bugnet's RPC
async function sendBalance(
    req: IncomingMessage,
    res: ServerResponse,
    d: PublicDeps,
    order: OrderRow,
    ip: IpKey,
    cache: Map<string, { at: number; micros: number }>,
): Promise<void> {
    const limit = d.balancePerIp.take(ip);
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
    const owner = new URL(req.url ?? "/", "http://x").searchParams.get("owner") ?? "";
    if (!isAddress(owner)) {
        sendJson(res, 400, { error: "bad_owner" });
        return;
    }
    const now = d.now();
    if (order.state !== "unpaid" || now.getTime() >= order.expiresAt.getTime()) {
        sendJson(res, 409, { error: "order_not_payable" });
        return;
    }
    const answer = (micros: number): BalanceAnswer => ({
        owner,
        usdcMicros: micros,
        needMicros: order.amountMicros,
    });
    const hit = cache.get(owner);
    if (hit !== undefined && now.getTime() - hit.at < BALANCE_CACHE_MS) {
        sendJson(res, 200, answer(hit.micros));
        return;
    }
    if (!d.balanceRpc.take("all").ok) {
        sendJson(res, 503, { error: "rpc_unavailable" });
        return;
    }
    let micros: number;
    try {
        const read = await readTokenAccount(d.backgroundRpc, await usdcAta(address(owner)), {
            commitment: "confirmed",
            ...deadline(d.rpcTimeoutMs),
        });
        micros = Number(read.info?.amount ?? 0n);
    } catch {
        sendJson(res, 503, { error: "rpc_unavailable" });
        return;
    }
    if (cache.size >= BALANCE_CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(owner, { at: now.getTime(), micros });
    sendJson(res, 200, answer(micros));
}

export function cleanReport(
    body: unknown,
): { stage: string; wallet: string; code: number | null; message: string } | null {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    const allowed = new Set(["stage", "wallet", "code", "message"]);
    if (Object.keys(body).some((k) => !allowed.has(k))) return null;
    const b = body as Record<string, unknown>;
    if (typeof b.stage !== "string" || !REPORT_STAGES.has(b.stage)) return null;
    if (typeof b.wallet !== "string" || typeof b.message !== "string") return null;
    if (b.code !== null && (typeof b.code !== "number" || !Number.isFinite(b.code))) return null;
    // eslint-disable-next-line no-control-regex
    const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
    return {
        stage: b.stage,
        wallet: clean(b.wallet, 40),
        code: b.code as number | null,
        message: clean(b.message, 200),
    };
}

// The page's own account of a wallet error (spec 13.3): the wallet's text goes to the log only
function sendReport(
    res: ServerResponse,
    d: PublicDeps,
    order: OrderRow,
    ip: IpKey,
    body: string,
): void {
    const limit = d.reportPerIp.take(ip);
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
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        parsed = null;
    }
    const report = cleanReport(parsed);
    if (report === null) {
        sendJson(res, 400, { error: "bad_report" });
        return;
    }
    d.log.warn("checkout wallet error", { orderId: order.id, ...report, ip: ip.key });
    res.writeHead(204);
    res.end();
}

// A Solana Pay transfer request for what the order still lacks (spec 15.1)
export function solanaPayUrl(address: string, amountMicros: number, description: string): string {
    return (
        `solana:${address}?amount=${decimalAmount(amountMicros)}&spl-token=${USDC_MINT}` +
        `&label=Bugnet&message=${encodeURIComponent(description)}`
    );
}

async function sendQr(res: ServerResponse, d: PublicDeps, order: OrderRow): Promise<void> {
    const now = d.now();
    const view =
        order.state === "unpaid" && now.getTime() < order.expiresAt.getTime()
            ? await depositView(d.pool, order, now, d.depositSettings)
            : null;
    if (view === null || view.remainingMicros <= 0) {
        sendJson(res, 404, { error: "not_found" });
        return;
    }
    const svg = await qrSvg(solanaPayUrl(view.address, view.remainingMicros, order.description));
    res.writeHead(200, {
        "Content-Type": "image/svg+xml",
        "Content-Length": String(Buffer.byteLength(svg)),
        "Content-Security-Policy": "default-src 'none'",
        "Cache-Control": "no-store",
    });
    res.end(svg);
}
