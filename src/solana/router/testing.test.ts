import {
    createSolanaRpcFromTransport,
    isSolanaError,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { classifyThrown } from "./classify.ts";
import { domainOf, rpcSettingsSchema } from "./settings.ts";
import {
    fakeEndpoint,
    httpFail,
    netFail,
    rpcFail,
    rpcOk,
    stall,
    testRpcSettings,
    testUrls,
} from "./testing.ts";

function payload(method: string, params: unknown[] = []): unknown {
    return { jsonrpc: "2.0", id: "1", method, params };
}

async function rejection(answer: Promise<unknown>): Promise<unknown> {
    try {
        await answer;
    } catch (e) {
        return e;
    }
    throw new Error("The call did not reject");
}

describe("fakeEndpoint", () => {
    it("a fake records each payload and answers", async () => {
        const a = fakeEndpoint("a", (method) => (method === "getSlot" ? rpcOk(5n) : null));
        const sent = payload("getSlot", [{ commitment: "confirmed" }]);
        const answer = await a.transport({ payload: sent });
        expect(a.calls).toHaveLength(1);
        expect(a.calls[0]!.method).toBe("getSlot");
        expect(a.calls[0]!.params).toEqual([{ commitment: "confirmed" }]);
        expect(a.calls[0]!.payload).toBe(sent);
        expect(answer).toEqual(rpcOk(5n));
    });

    it("answer replaces the handler", async () => {
        const a = fakeEndpoint("a", () => rpcOk(1n));
        a.answer((_method, params) => rpcOk(params.length));
        expect(await a.transport({ payload: payload("getSlot", [1, 2]) })).toEqual(rpcOk(2));
    });

    it("a fake with no handler refuses the call", async () => {
        const a = fakeEndpoint("a");
        const e = await rejection(a.transport({ payload: payload("getSlot") }));
        expect((e as Error).message).toBe("Fake a has no answer for getSlot");
        expect(a.calls).toHaveLength(1);
    });

    it("kit reads the fake's answers", async () => {
        const a = fakeEndpoint("a", (method) =>
            method === "getSlot" ? rpcOk(5n) : rpcFail(-32005, "Node is behind", { slots: 3n }),
        );
        const rpc = createSolanaRpcFromTransport(a.transport);
        expect(await rpc.getSlot().send()).toBe(5n);
        const e = await rejection(rpc.getBlockHeight().send());
        expect(isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY)).toBe(true);
        expect(a.calls.map((c) => c.method)).toEqual(["getSlot", "getBlockHeight"]);
    });

    it("rpcFail leaves out data it was not given", () => {
        expect(rpcFail(-32601, "Method not found")).toStrictEqual({
            jsonrpc: "2.0",
            id: 1n,
            error: { code: -32601n, message: "Method not found" },
        });
        expect(rpcFail(-32016, "m", { contextSlot: 9n })).toStrictEqual({
            jsonrpc: "2.0",
            id: 1n,
            error: { code: -32016n, message: "m", data: { contextSlot: 9n } },
        });
    });

    it("a stall ends only with the signal", async () => {
        const a = fakeEndpoint("a", () => stall());
        const start = performance.now();
        const e = await rejection(
            a.transport({ payload: payload("getSlot"), signal: AbortSignal.timeout(20) }),
        );
        // Timers count from the event loop's cached time, so one can fire a fraction of a ms early
        expect(performance.now() - start).toBeGreaterThanOrEqual(19);
        expect((e as DOMException).name).toBe("TimeoutError");
    });

    it("the signal ends a slow answer at once", async () => {
        const a = fakeEndpoint(
            "a",
            () => new Promise((resolve) => setTimeout(() => resolve(rpcOk(5n)), 5_000)),
        );
        const controller = new AbortController();
        const answer = rejection(
            a.transport({ payload: payload("getSlot"), signal: controller.signal }),
        );
        const reason = new Error("caller gave up");
        controller.abort(reason);
        expect(await answer).toBe(reason);
    });

    it("a call made with an aborted signal is never sent", async () => {
        const a = fakeEndpoint("a", () => rpcOk(5n));
        const reason = new Error("caller gave up");
        const e = await rejection(
            a.transport({ payload: payload("getSlot"), signal: AbortSignal.abort(reason) }),
        );
        expect(e).toBe(reason);
        expect(a.calls).toEqual([]);
    });

    it("httpFail carries the status and headers", async () => {
        const a = fakeEndpoint("a", () => httpFail(429, { "retry-after": "10" }));
        const e = await rejection(a.transport({ payload: payload("getSlot") }));
        expect(isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)).toBe(true);
        if (!isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return;
        expect(e.context.statusCode).toBe(429);
        expect(e.context.headers.get("retry-after")).toBe("10");
        expect(classifyThrown(e, false, 0)).toEqual({ kind: "cooldown", retryAfterMs: 10_000 });
    });

    it("netFail carries its cause code", async () => {
        const a = fakeEndpoint("a", () => netFail("ECONNREFUSED"));
        const e = await rejection(a.transport({ payload: payload("getSlot") }));
        expect(e).toBeInstanceOf(TypeError);
        expect((e as TypeError).message).toBe("fetch failed");
        expect(((e as TypeError).cause as { code: string }).code).toBe("ECONNREFUSED");
        expect(classifyThrown(e, false, 0)).toMatchObject({ kind: "failover", ambiguous: false });
    });

    it("netFail with no code is a reset connection, which may have delivered", () => {
        let e: unknown;
        try {
            netFail();
        } catch (thrown) {
            e = thrown;
        }
        expect(((e as TypeError).cause as { code: string }).code).toBe("ECONNRESET");
        expect(classifyThrown(e, false, 0)).toMatchObject({ kind: "failover", ambiguous: true });
    });
});

describe("test values", () => {
    it("test URLs are made up and on their own domains", () => {
        const urls = testUrls(3);
        expect(urls).toEqual(["https://a.example/", "https://b.example/", "https://c.example/"]);
        expect(new Set(urls.map(domainOf)).size).toBe(3);
    });

    it("testRpcSettings shortens the attempts and keeps the other defaults", () => {
        const defaults = rpcSettingsSchema.parse({});
        expect(testRpcSettings()).toEqual({
            ...defaults,
            attempt_timeout: 200,
            first_attempt_timeouts: {},
            max_attempts: 3,
        });
        expect(testRpcSettings({ max_attempts: 2, absence_quorum: 1 })).toMatchObject({
            attempt_timeout: 200,
            max_attempts: 2,
            absence_quorum: 1,
        });
    });
});
