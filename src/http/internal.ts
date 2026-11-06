import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Log } from "../log.ts";
import {
    abandonOrder,
    handleOrderRequest,
    type OrderServiceDeps,
    shortText,
} from "../orders/service.ts";
import { BodyTooLarge, bearerOk, type Handler, readBody, sendJson } from "./server.ts";

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

// The pay path's CheckPayer call stops when the caller hangs up
function hangupSignal(res: ServerResponse): AbortSignal {
    const ac = new AbortController();
    res.once("close", () => {
        if (!res.writableFinished) ac.abort();
    });
    return ac.signal;
}

export function createInternalHandler(d: InternalDeps): Handler {
    return async (req, res) => {
        const path = new URL(req.url ?? "/", "http://internal").pathname;
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
            sendJson(res, 413, BAD_REQUEST);
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
            if (out === "recorded") {
                d.log.info("abandon hint recorded", { orderId: id, reason });
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
        const result = await handleOrderRequest(d.service, body, hangupSignal(res));
        const bad = result.status === "refused" && result.reason === "bad_request";
        sendJson(res, bad ? 400 : 200, result);
    };
}
