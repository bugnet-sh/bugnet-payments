import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { z } from "zod";
import type { Log } from "../log.ts";
import { RpcUnavailableError } from "../x402/create.ts";
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
    readBody,
    requestPath,
    sendJson,
} from "./server.ts";

export interface InternalDeps {
    service: OrderServiceDeps;
    token: string;
    events?: (raw: Buffer, h: IncomingHttpHeaders) => Promise<{ status: number; body: unknown }>;
    maxBodyBytes: number;
    log: Log;
}

const ABANDON = /^\/v1\/orders\/([^/]+)\/abandon$/;
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
    return async (req, res) => {
        const path = requestPath(req.url);
        if (req.method === "GET" && path === "/healthz") {
            sendJson(res, 200, { ok: true });
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
            result = await handleOrderRequest(d.service, body, hangupSignal(res));
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
