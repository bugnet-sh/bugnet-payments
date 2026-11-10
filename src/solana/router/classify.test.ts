import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
    classifyAnswer,
    classifyThrown,
    mayHaveDelivered,
    type Outcome,
    parseRetryAfter,
} from "./classify.ts";

function http(statusCode: number, h: Record<string, string> = {}): SolanaError {
    return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
        headers: new Headers(h),
        message: "x",
        statusCode,
    });
}

function network(code: string): TypeError {
    return new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code }) });
}

function rpcError(code: bigint, data?: unknown): unknown {
    return { jsonrpc: "2.0", id: 1n, error: { code, message: "m", data } };
}

function status(code: number, h: Record<string, string> = {}): Outcome {
    return classifyThrown(http(code, h), false, 0);
}

function failover(more: Partial<Extract<Outcome, { kind: "failover" }>> = {}): Outcome {
    return {
        kind: "failover",
        strike: true,
        history: false,
        retryAfterMs: null,
        ambiguous: true,
        ...more,
    };
}

describe("classifyThrown", () => {
    it("HTTP 429 cools down for Retry-After seconds", () => {
        expect(status(429, { "retry-after": "10" })).toEqual({
            kind: "cooldown",
            retryAfterMs: 10000,
        });
    });

    it("HTTP 429 without Retry-After", () => {
        expect(status(429)).toEqual({ kind: "cooldown", retryAfterMs: null });
    });

    it("HTTP 401 is auth", () => {
        expect(status(401)).toEqual({ kind: "auth" });
    });

    it("endpoint-wide HTTP errors are down", () => {
        for (const code of [402, 403, 404, 405, 410]) {
            expect(status(code)).toEqual({ kind: "down", status: code });
        }
    });

    it("HTTP 400 is a bad request", () => {
        expect(status(400)).toEqual({ kind: "bad_request" });
        expect(mayHaveDelivered(status(400))).toBe(false);
    });

    it("every 5xx fails over with a strike and may have delivered", () => {
        for (const code of [500, 502, 503, 504, 520, 521, 522, 523, 525, 526, 530]) {
            expect(status(code)).toEqual(failover());
            expect(mayHaveDelivered(status(code))).toBe(true);
        }
        for (const code of [503, 529]) {
            expect(status(code, { "retry-after": "30" })).toEqual(
                failover({ retryAfterMs: 30000 }),
            );
        }
    });

    it("request-level HTTP errors return", () => {
        for (const code of [413, 414, 431]) {
            expect(status(code)).toEqual({ kind: "return" });
        }
    });

    it("HTTP 408 fails over and may have delivered", () => {
        expect(status(408)).toEqual(failover({ strike: true, ambiguous: true }));
        expect(mayHaveDelivered(status(408))).toBe(true);
    });

    it("another 4xx fails over without delivery", () => {
        expect(status(418)).toEqual(failover({ strike: true, ambiguous: false }));
        expect(mayHaveDelivered(status(418))).toBe(false);
    });

    it("a status outside 4xx and 5xx fails over and may have delivered", () => {
        expect(status(304)).toEqual(failover());
    });

    it("a refused connection was never delivered", () => {
        for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
            const o = classifyThrown(network(code), false, 0);
            expect(o).toEqual(failover({ strike: true, ambiguous: false }));
            expect(mayHaveDelivered(o)).toBe(false);
        }
    });

    it("any other network error may have delivered", () => {
        const errors = [
            network("ECONNRESET"),
            new TypeError("fetch failed"),
            network("UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
        ];
        for (const err of errors) {
            expect(classifyThrown(err, false, 0)).toEqual(
                failover({ strike: true, ambiguous: true }),
            );
        }
    });

    it("a non-JSON answer fails over with a strike", () => {
        expect(classifyThrown(new SyntaxError("x"), false, 0)).toEqual(
            failover({ ambiguous: true }),
        );
    });

    it("the caller's abort is aborted", () => {
        const o = classifyThrown(new DOMException("t", "TimeoutError"), true, 0);
        expect(o).toEqual({ kind: "aborted" });
        expect(mayHaveDelivered(o)).toBe(true);
    });

    it("an attempt timeout fails over with a strike", () => {
        expect(classifyThrown(new DOMException("t", "TimeoutError"), false, 0)).toEqual(
            failover({ strike: true, ambiguous: true }),
        );
    });
});

describe("parseRetryAfter", () => {
    it("Retry-After as an HTTP date", () => {
        const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
        expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:10 GMT", now)).toBe(10000);
        expect(parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT", now)).toBe(0);
        expect(parseRetryAfter("abc", now)).toBeNull();
    });

    it("Retry-After stays uncapped here", () => {
        expect(parseRetryAfter("3600", 0)).toBe(3600000);
    });
});

describe("classifyAnswer", () => {
    it("-32016 is behind with the node's slot", () => {
        expect(classifyAnswer("getBalance", rpcError(-32016n, { contextSlot: 77n }))).toEqual({
            kind: "behind",
            contextSlot: 77n,
        });
    });

    it("-32005 is unhealthy", () => {
        expect(classifyAnswer("getBalance", rpcError(-32005n, { numSlotsBehind: 12n }))).toEqual({
            kind: "unhealthy",
            slotsBehind: 12n,
        });
        expect(classifyAnswer("getBalance", rpcError(-32005n))).toEqual({
            kind: "unhealthy",
            slotsBehind: null,
        });
    });

    it("history errors fail over without a strike", () => {
        for (const code of [-32001n, -32004n, -32009n, -32011n, -32014n, -32019n, -32020n]) {
            expect(classifyAnswer("getTransaction", rpcError(code))).toEqual({
                kind: "failover",
                strike: false,
                history: true,
                retryAfterMs: null,
                ambiguous: false,
            });
        }
    });

    it("-32603 fails over with a strike and may have delivered", () => {
        const o = classifyAnswer("sendTransaction", rpcError(-32603n));
        expect(o).toEqual(failover({ strike: true, ambiguous: true }));
        expect(mayHaveDelivered(o)).toBe(true);
    });

    it("-32601 is unsupported", () => {
        expect(classifyAnswer("getBalance", rpcError(-32601n))).toEqual({ kind: "unsupported" });
    });

    it("a missing blockhash fails over on send", () => {
        const answer = {
            error: { code: -32002n, message: "m", data: { err: "BlockhashNotFound" } },
        };
        expect(classifyAnswer("sendTransaction", answer)).toEqual({
            kind: "failover",
            strike: false,
            history: false,
            retryAfterMs: null,
            ambiguous: true,
        });
        expect(classifyAnswer("getBalance", answer)).toEqual({ kind: "return" });
    });

    it("any other preflight refusal is refused", () => {
        const data = { err: { InstructionError: [0, { Custom: 1 }] } };
        expect(classifyAnswer("sendTransaction", rpcError(-32002n, data))).toEqual({
            kind: "refused",
        });
    });

    it("AlreadyProcessed is processed", () => {
        const o = classifyAnswer("sendTransaction", rpcError(-32002n, { err: "AlreadyProcessed" }));
        expect(o).toEqual({ kind: "processed" });
        expect(mayHaveDelivered(o)).toBe(true);
    });

    it("a node's answer on a send may have delivered", () => {
        const send = (code: bigint, data?: unknown) =>
            classifyAnswer("sendTransaction", rpcError(code, data));
        expect(mayHaveDelivered(status(429))).toBe(true);
        expect(mayHaveDelivered(send(-32016n, { contextSlot: 1n }))).toBe(true);
        expect(mayHaveDelivered(send(-32005n))).toBe(true);
        expect(mayHaveDelivered(status(401))).toBe(false);
        expect(mayHaveDelivered(status(403))).toBe(false);
        expect(mayHaveDelivered(status(400))).toBe(false);
        expect(mayHaveDelivered(send(-32601n))).toBe(false);
        expect(mayHaveDelivered(classifyThrown(network("ECONNREFUSED"), false, 0))).toBe(false);
    });

    it("-32015 returns", () => {
        expect(classifyAnswer("getTransaction", rpcError(-32015n))).toEqual({ kind: "return" });
    });

    it("request errors return", () => {
        for (const code of [-32003n, -32600n, -32602n, -32700n]) {
            expect(classifyAnswer("getBalance", rpcError(code))).toEqual({ kind: "return" });
        }
    });

    it("a JSON-RPC 429 cools down", () => {
        expect(classifyAnswer("getBalance", rpcError(429n))).toEqual({
            kind: "cooldown",
            retryAfterMs: null,
        });
    });

    it("a positive code fails over with a strike", () => {
        for (const code of [4n, 35n]) {
            expect(classifyAnswer("getBalance", rpcError(code))).toEqual({
                kind: "failover",
                strike: true,
                history: false,
                retryAfterMs: null,
                ambiguous: true,
            });
        }
    });

    it("a result without its context slot fails over", () => {
        expect(classifyAnswer("getBalance", { result: 5n })).toEqual({
            kind: "failover",
            strike: true,
            history: false,
            retryAfterMs: null,
            ambiguous: false,
        });
        expect(classifyAnswer("getSlot", { result: 5n })).toEqual({ kind: "ok" });
    });

    it("a result is ok", () => {
        expect(classifyAnswer("getSlot", { result: 1n })).toEqual({ kind: "ok" });
        const balance = { result: { context: { slot: 9n }, value: 5n } };
        expect(classifyAnswer("getBalance", balance)).toEqual({ kind: "ok" });
        expect(classifyAnswer("getTransaction", { result: null })).toEqual({ kind: "ok" });
    });

    it("an answer that is not JSON-RPC fails over with a strike", () => {
        expect(classifyAnswer("getSlot", {})).toEqual(failover());
        expect(classifyAnswer("getSlot", "x")).toEqual(failover());
    });
});
