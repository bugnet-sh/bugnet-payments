import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Log } from "../log.ts";
import { statsTotals } from "../stats/totals.ts";
import { accountAnswer, configure, RouterUnavailableError } from "../x402/configure.ts";
import { RpcUnavailableError } from "../x402/create.ts";
import { parseHosts, sellerStats } from "../x402/sellers.ts";
import { x402Terms } from "../x402/terms.ts";
import {
    abandonOrder,
    handleOrderRequest,
    type OrderServiceDeps,
    shortText,
} from "../orders/service.ts";
import {
    BodyTooLarge,
    bearerOk,
    type Handler,
    hangupSignal,
    paidVia,
    readBody,
    requestPath,
    sendJson,
} from "./server.ts";

export interface InternalDeps {
    service: OrderServiceDeps;
    token: string;
    // The router's own token, which it presents for the stats totals; empty turns the route off
    routerToken?: string;
    events?: (raw: Buffer, h: IncomingHttpHeaders) => Promise<{ status: number; body: unknown }>;
    maxBodyBytes: number;
    log: Log;
}

const STATS_TOTALS = "/internal/v1/stats/totals";
const ABANDON = /^\/v1\/orders\/([^/]+)\/abandon$/;
const X402_ACCOUNT = /^\/v1\/x402\/accounts\/([^/]+)$/;
const HANDLE = /^[0-9a-f]{64}$/;
const abandonBody = z.object({ reason: shortText(200) });

const BAD_REQUEST = { status: "refused", reason: "bad_request" } as const;

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
    const raw = await readBody(req, maxBytes);
    try {
        return JSON.parse(raw.toString("utf8"));
    } catch {
        return undefined;
    }
}

export function createInternalHandler(d: InternalDeps): Handler {
    const serveX402 = async (
        req: IncomingMessage,
        res: ServerResponse,
        path: string,
        handle: string | undefined,
    ): Promise<void> => {
        if (!bearerOk(req.headers.authorization, d.token)) {
            sendJson(res, 401, { status: "refused", reason: "unauthorized" });
            return;
        }
        const { pool, x402, now } = d.service;
        if (path === "/v1/x402/terms") {
            sendJson(res, 200, await x402Terms(pool, x402));
        } else if (path === "/v1/x402/sellers") {
            const url = new URL(req.url ?? "/", "http://local");
            const hosts = parseHosts(url.searchParams.get("hosts"));
            if (hosts === null) sendJson(res, 400, BAD_REQUEST);
            else sendJson(res, 200, await sellerStats(pool, hosts, now()));
        } else if (path === "/v1/x402/configure") {
            let body: unknown;
            try {
                body = await readJson(req, d.maxBodyBytes);
            } catch (err) {
                if (!(err instanceof BodyTooLarge)) throw err;
                sendJson(res, 413, BAD_REQUEST, { Connection: "close" });
                return;
            }
            const out = await configure(pool, x402, body, hangupSignal(res));
            const bad = out.status === "refused" && out.reason === "bad_request";
            sendJson(res, bad ? 400 : 200, out);
        } else if (handle === undefined || !HANDLE.test(handle)) {
            sendJson(res, 400, BAD_REQUEST);
        } else {
            try {
                sendJson(res, 200, await accountAnswer(pool, x402, handle, hangupSignal(res)));
            } catch (err) {
                if (!(err instanceof RouterUnavailableError)) throw err;
                sendJson(res, 503, { error: "router_unavailable" });
            }
        }
    };
    const serveStatsTotals = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const token = d.routerToken ?? "";
        const noStore = { "Cache-Control": "no-store" };
        if (token === "") {
            sendJson(res, 404, { error: "not_found" }, noStore);
        } else if (req.method !== "GET") {
            sendJson(res, 405, { error: "method_not_allowed" }, { ...noStore, Allow: "GET" });
        } else if (!bearerOk(req.headers.authorization, token)) {
            sendJson(res, 401, { status: "refused", reason: "unauthorized" }, noStore);
        } else {
            const { pool, settings, now } = d.service;
            sendJson(res, 200, await statsTotals(pool, settings, now()), noStore);
        }
    };
    return async (req, res) => {
        const path = requestPath(req.url);
        if (req.method === "GET" && path === "/healthz") {
            sendJson(res, 200, { ok: true });
            return;
        }
        if (path === STATS_TOTALS) {
            await serveStatsTotals(req, res);
            return;
        }
        // The router signs its events and sends no bearer token
        if (req.method === "POST" && path === "/v1/events") {
            if (d.events === undefined) {
                sendJson(res, 503, { error: "events_disabled" });
                return;
            }
            const out = await d.events(await readBody(req, d.maxBodyBytes), req.headers);
            sendJson(res, out.status, out.body);
            return;
        }
        const x402Account = X402_ACCOUNT.exec(path);
        const x402Get =
            req.method === "GET" &&
            (path === "/v1/x402/terms" || path === "/v1/x402/sellers" || x402Account !== null);
        const x402Configure = req.method === "POST" && path === "/v1/x402/configure";
        if (x402Get || x402Configure) {
            await serveX402(req, res, path, x402Account?.[1]);
            return;
        }
        const abandon = ABANDON.exec(path);
        if (req.method !== "POST" || (path !== "/v1/orders" && abandon === null)) {
            sendJson(res, 404, { error: "not_found" });
            return;
        }
        if (!bearerOk(req.headers.authorization, d.token)) {
            sendJson(res, 401, { status: "refused", reason: "unauthorized" });
            return;
        }
        let body: unknown;
        try {
            body = await readJson(req, d.maxBodyBytes);
        } catch (err) {
            if (!(err instanceof BodyTooLarge)) throw err;
            sendJson(res, 413, BAD_REQUEST, { Connection: "close" });
            return;
        }
        if (abandon !== null) {
            const parsed = abandonBody.safeParse(body);
            if (!parsed.success) {
                sendJson(res, 400, BAD_REQUEST);
                return;
            }
            const id = abandon[1]!;
            const { reason } = parsed.data;
            const out = await abandonOrder(d.service.pool, id, reason, d.service.now());
            if (out === "recorded" || out === "ignored") {
                if (out === "recorded") {
                    d.log.info("abandon hint recorded", { orderId: id, reason });
                }
                res.writeHead(204).end();
            } else {
                sendJson(res, 404, { status: "refused", reason: "order_unknown" });
            }
            return;
        }
        if (body === undefined) {
            sendJson(res, 400, BAD_REQUEST);
            return;
        }
        let result;
        try {
            result = await handleOrderRequest(d.service, body, hangupSignal(res), paidVia(req));
        } catch (err) {
            if (!(err instanceof RpcUnavailableError)) throw err;
            d.log.warn("x402 payee check unreachable", { errorClass: err.errorClass });
            sendJson(res, 503, { error: "rpc_unavailable" });
            return;
        }
        const bad = result.status === "refused" && result.reason === "bad_request";
        sendJson(res, bad ? 400 : 200, result);
    };
}
