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

// nginx's status for a client that hung up before any answer
const CLIENT_CLOSED = 499;

export function splitListen(listen: string): { host: string; port: number } {
    const at = listen.lastIndexOf(":");
    return {
        host: listen.slice(0, at).replace(/^\[|\]$/g, ""),
        port: Number(listen.slice(at + 1)),
    };
}

// Node's parser accepts targets that URL rejects, such as "//[" or a port over 65535; a throw here
// would escape the access log's close listener and stop the process
export function requestPath(target: string | undefined): string {
    const raw = target ?? "/";
    return URL.parse(raw, "http://local")?.pathname ?? raw.split("?", 1)[0]!;
}

function fail(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
): void {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    sendJson(res, status, body, headers);
}

// The pay path's CheckPayer call stops when the caller hangs up
export function hangupSignal(res: ServerResponse): AbortSignal {
    const ac = new AbortController();
    res.once("close", () => {
        if (!res.writableFinished) ac.abort();
    });
    return ac.signal;
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
                path: requestPath(req.url),
                status: res.writableFinished ? res.statusCode : CLIENT_CLOSED,
                ms: Math.round(performance.now() - started),
                ip: req.socket.remoteAddress,
            });
        });
        handler(req, res).catch((err: unknown) => {
            if (err instanceof BodyTooLarge) {
                fail(res, 413, { error: "body_too_large" }, { Connection: "close" });
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
                // Stop reading: with Connection: close the socket ends once the 413 is flushed
                req.pause();
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

// Counts the body without buffering it; false means the client hung up before the body ended
export function drainBody(req: IncomingMessage, maxBytes: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
        if (Number(req.headers["content-length"]) > maxBytes) {
            req.resume();
            reject(new BodyTooLarge());
            return;
        }
        let size = 0;
        let settled = false;
        const finish = (done: () => void) => {
            if (settled) return;
            settled = true;
            done();
        };
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
                // Stop reading: with Connection: close the socket ends once the 413 is flushed
                req.pause();
                finish(() => reject(new BodyTooLarge()));
            }
        });
        req.on("end", () => finish(() => resolve(true)));
        req.on("error", () => finish(() => resolve(false)));
        req.on("close", () => finish(() => resolve(false)));
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
