import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Log } from "../log.ts";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export class BodyTooLarge extends Error {
    constructor() {
        super("request body too large");
        this.name = "BodyTooLarge";
    }
}

function splitListen(listen: string): { host: string; port: number } {
    const at = listen.lastIndexOf(":");
    return {
        host: listen.slice(0, at).replace(/^\[|\]$/g, ""),
        port: Number(listen.slice(at + 1)),
    };
}

function fail(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    sendJson(res, status, body);
}

export async function startServer(
    listen: string,
    handler: Handler,
    log: Log,
): Promise<{ port: number; close(): Promise<void> }> {
    const server = createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => {
        const started = performance.now();
        res.once("close", () => {
            log.info("request", {
                method: req.method,
                path: new URL(req.url ?? "/", "http://local").pathname,
                status: res.statusCode,
                ms: Math.round(performance.now() - started),
                ip: req.socket.remoteAddress,
            });
        });
        handler(req, res).catch((err: unknown) => {
            if (err instanceof BodyTooLarge) {
                fail(res, 413, { error: "body_too_large" });
                return;
            }
            log.error("handler failed", { err });
            fail(res, 500, { error: "internal" });
        });
    });
    const { host, port } = splitListen(listen);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        port: (server.address() as AddressInfo).port,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
                server.closeAllConnections();
            }),
    };
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        if (Number(req.headers["content-length"]) > maxBytes) {
            req.resume();
            reject(new BodyTooLarge());
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let over = false;
        req.on("data", (chunk: Buffer) => {
            if (over) return;
            size += chunk.length;
            if (size > maxBytes) {
                over = true;
                chunks.length = 0;
                reject(new BodyTooLarge());
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
        req.on("close", () => reject(new Error("request closed before its body ended")));
    });
}

export function sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(text)),
        ...headers,
    });
    res.end(text);
}

// Both sides are hashed first so the comparison takes the same time whatever the lengths
export function bearerOk(header: string | undefined, token: string): boolean {
    if (header === undefined || token === "") return false;
    const m = /^Bearer (.+)$/i.exec(header);
    if (m === null) return false;
    const digest = (s: string) => createHash("sha256").update(s).digest();
    return timingSafeEqual(digest(m[1]!), digest(token));
}
