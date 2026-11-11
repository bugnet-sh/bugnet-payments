import type { RpcTransport } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { epochAt } from "../../testing/fake-rpc.ts";
import type { Status } from "./absence.ts";
import { RpcRouterError } from "./errors.ts";
import { isObject } from "./payload.ts";
import type { RpcSettings } from "./settings.ts";
import {
    type FakeEndpoint,
    type FakeHandler,
    fakeEndpoint,
    httpFail,
    netFail,
    rpcFail,
    rpcOk,
    signatureStatus as S,
    stall,
    statusesAnswer,
    testDeps,
    type TestDeps,
    testRpcSettings,
} from "./testing.ts";
import {
    createRouterTransport,
    type EndpointSnapshot,
    type RouterDeps,
    type RouterTransport,
    setCheckState,
} from "./transport.ts";

const LABELS = ["a", "b", "c", "d"];
const TX = {
    slot: 900n,
    blockTime: null,
    meta: { err: null, fee: 5000n, preTokenBalances: [], postTokenBalances: [] },
    transaction: ["AAAA", "base64"],
};
const ONE_DOMAIN = ["https://one.x.example/", "https://two.x.example/", "https://c.example/"];

// Faster than the router's projection of 450 ms a slot, so a caught-up node never lags
function slotAt(ms: number): bigint {
    return 1_000n + BigInt(Math.floor(ms / 400));
}

// A caught-up node: every answer at the clock's slot, some methods answered otherwise
function chain(clock: { ms: number }, over: Record<string, FakeHandler> = {}): FakeHandler {
    return (method, params, payload) => {
        const own = over[method];
        if (own !== undefined) return own(method, params, payload);
        const slot = slotAt(clock.ms);
        switch (method) {
            case "getSlot":
                return rpcOk(slot);
            case "getBlockHeight":
                return rpcOk(slot - 100n);
            case "getEpochInfo":
                return rpcOk(epochAt(slot - 100n, slot));
            case "getBlockTime":
                return rpcOk(1_700_000_000n);
            case "getTransaction":
                return rpcOk(TX);
            case "getSignaturesForAddress":
                return rpcOk([]);
            case "getVoteAccounts":
                return rpcOk({ current: [], delinquent: [] });
            default:
                return rpcOk({ context: { slot }, value: 5n });
        }
    };
}

interface Setup extends TestDeps {
    router: RouterTransport;
    a: FakeEndpoint;
    b: FakeEndpoint;
    c: FakeEndpoint;
    d: FakeEndpoint;
}

function setup(
    n: number,
    over: Partial<RpcSettings> = {},
    more: Partial<RouterDeps> & { urls?: string[] } = {},
): Setup {
    const eps = LABELS.slice(0, n).map((label) => fakeEndpoint(label));
    const deps = testDeps(eps, more);
    for (const ep of eps) ep.answer(chain(deps.clock));
    const router = createRouterTransport(testRpcSettings(over), deps.urls, deps);
    const at = (i: number) => eps[i] ?? fakeEndpoint(`unused ${LABELS[i]}`);
    return { ...deps, router, a: at(0), b: at(1), c: at(2), d: at(3) };
}

function payload(method: string, params: unknown[] = []): Record<string, unknown> {
    return { jsonrpc: "2.0", id: 1n, method, params };
}

function call(
    t: RpcTransport,
    method: string,
    params: unknown[] = [],
    signal?: AbortSignal,
): Promise<unknown> {
    return t({ payload: payload(method, params), signal });
}

async function rejection(answer: Promise<unknown>): Promise<unknown> {
    try {
        await answer;
    } catch (e) {
        return e;
    }
    throw new Error("The call did not reject");
}

function reasonOf(e: unknown): string {
    expect(e).toBeInstanceOf(RpcRouterError);
    return (e as RpcRouterError).reason;
}

function resultOf(answer: unknown): unknown {
    return (answer as { result: unknown }).result;
}

function snap(router: RouterTransport, name: string): EndpointSnapshot {
    return router.snapshot().endpoints.find((e) => e.name === name)!;
}

function alarms(t: TestDeps): Record<string, unknown>[] {
    return t.log.lines.filter((l) => l.level === "alarm");
}

// A handler that throws what make throws, keeping each thrown object
function throwing(make: () => never): { handler: FakeHandler; errors: unknown[] } {
    const errors: unknown[] = [];
    return {
        errors,
        handler: () => {
            try {
                make();
            } catch (e) {
                errors.push(e);
                throw e;
            }
        },
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 1_000 && !done(); i++) await new Promise((r) => setImmediate(r));
    expect(done()).toBe(true);
}

// Runs fn with every other endpoint unchecked, so only the endpoint at name takes its calls
async function via<T>(t: Setup, name: string, fn: () => Promise<T>): Promise<T> {
    const others = t.router
        .snapshot()
        .endpoints.map((e) => e.name)
        .filter((other) => other !== name);
    for (const other of others) setCheckState(t.router, other, { genesis: "error" });
    try {
        return await fn();
    } finally {
        for (const other of others) setCheckState(t.router, other, { genesis: "ok" });
    }
}

// The endpoint at name answers total - 1 getSlot calls and a 429 in one window, which teaches it
// a limit of floor(0.8 x total) for the whole endpoint
async function teach(t: Setup, fake: FakeEndpoint, name: string, total: number): Promise<void> {
    let n = 0;
    const healthy = chain(t.clock);
    fake.answer((method, params, p) => {
        n += 1;
        return n === total ? httpFail(429) : healthy(method, params, p);
    });
    await via(t, name, async () => {
        for (let i = 0; i < total; i++) await call(t.router, "getSlot").catch(() => undefined);
    });
    fake.answer(healthy);
}

describe("one endpoint", () => {
    it("one endpoint passes the payload through unchanged", async () => {
        const t = setup(1);
        const answer = rpcOk(5n);
        t.a.answer(() => answer);
        expect(t.router.mode).toBe("single");
        const sent = payload("getSlot");
        expect(await t.router({ payload: sent })).toBe(answer);
        expect(t.a.calls[0]!.payload).toBe(sent);
        const again = payload("getSlot");
        expect(await t.router.background({ payload: again })).toBe(answer);
        expect(t.a.calls[1]!.payload).toBe(again);
    });

    it("one endpoint returns errors unchanged", async () => {
        const t = setup(1);
        const answer = rpcFail(-32002, "Transaction simulation failed");
        t.a.answer(() => answer);
        expect(await call(t.router, "simulateTransaction", ["AAAA", {}])).toBe(answer);
        const failing = throwing(() => httpFail(503));
        t.a.answer(failing.handler);
        expect(await rejection(call(t.router, "getSlot"))).toBe(failing.errors[0]);
    });

    it("one endpoint does no retry", async () => {
        const t = setup(1);
        const failing = throwing(() => netFail());
        t.a.answer(failing.handler);
        const e = await rejection(call(t.router, "getSlot"));
        expect(e).toBeInstanceOf(TypeError);
        expect(e).toBe(failing.errors[0]);
        expect(t.a.calls).toHaveLength(1);
    });

    it("one endpoint has no first-attempt timeout", async () => {
        const t = setup(1, { first_attempt_timeouts: { getSlot: 100 } });
        t.a.answer(async () => {
            await delay(300);
            return rpcOk(5n);
        });
        expect(resultOf(await call(t.router, "getSlot"))).toBe(5n);
    });

    it("one endpoint refuses an answer below its minContextSlot", async () => {
        const t = setup(1);
        t.a.answer(() => rpcOk({ context: { slot: 99n }, value: 5n }));
        const e = await rejection(call(t.router, "getBalance", ["addr", { minContextSlot: 100n }]));
        expect(reasonOf(e)).toBe("stale");
    });
});

describe("priority and failover", () => {
    it("every endpoint starts with its checks passed and consistent", () => {
        const t = setup(2);
        const s = t.router.snapshot();
        expect(s).toMatchObject({
            mode: "routed",
            serving: "rpc1",
            domains: 2,
            absenceQuorum: 2,
            sendFanout: 1,
        });
        expect(s.endpoints[0]).toMatchObject({
            name: "rpc1",
            roles: ["read", "history", "send"],
            state: "ok",
            consistent: "yes",
            checks: { genesis: "ok", history: "ok", pinnedAccounts: "ok", pinnedSignatures: "ok" },
        });
        setCheckState(t.router, "rpc1", { history: "missing", consistent: "no" });
        expect(snap(t.router, "rpc1")).toMatchObject({
            roles: ["read", "send"],
            consistent: "no",
            checks: { history: "missing" },
        });
    });

    it("the first URL serves while it is healthy", async () => {
        const t = setup(2);
        const slow = chain(t.clock);
        t.a.answer((method, params, p) => {
            t.clock.ms += 300;
            return slow(method, params, p);
        });
        t.b.answer((method, params, p) => {
            t.clock.ms += 10;
            return slow(method, params, p);
        });
        for (let i = 0; i < 20; i++) await call(t.router, "getSlot");
        expect(t.a.calls).toHaveLength(20);
        expect(t.b.calls).toHaveLength(0);
    });

    it("a failed read moves to the next endpoint", async () => {
        const t = setup(2);
        t.a.answer(() => netFail());
        t.b.answer(() => rpcOk(5n));
        expect(resultOf(await call(t.router, "getSlot"))).toBe(5n);
        expect(t.a.calls).toHaveLength(1);
        expect(t.b.calls).toHaveLength(1);
    });

    it("a failover logs the endpoint, method and outcome, and counts the outcome", async () => {
        const t = setup(2);
        t.a.answer(() => netFail());
        await call(t.router, "getSlot");
        expect(t.log.lines).toContainEqual({
            level: "warn",
            msg: "rpc attempt failed",
            endpoint: "rpc1",
            method: "getSlot",
            outcome: "network",
        });
        expect(snap(t.router, "rpc1").outcomes).toEqual({ getSlot: { network: 1 } });
        expect(snap(t.router, "rpc2").outcomes).toEqual({ getSlot: { ok: 1 } });
        expect(snap(t.router, "rpc1").lastError).toEqual({
            at: 0,
            err: "TypeError",
            cause: "ECONNRESET",
        });
    });

    it("a 429 cools the endpoint and the read moves on", async () => {
        const t = setup(2);
        const healthy = chain(t.clock);
        t.a.answer((method, params, p) =>
            t.clock.ms === 0 ? httpFail(429, { "retry-after": "10" }) : healthy(method, params, p),
        );
        expect(resultOf(await call(t.router, "getSlot"))).toBe(1_000n);
        expect(t.b.calls).toHaveLength(1);
        t.clock.ms = 5_000;
        await call(t.router, "getSlot");
        await call(t.router, "getBalance", ["addr"]);
        expect(t.a.calls).toHaveLength(1);
        expect(t.b.calls.map((c) => c.method)).toEqual(["getSlot", "getSlot", "getBalance"]);
        t.clock.ms = 11_000;
        await call(t.router, "getSlot");
        expect(t.a.calls).toHaveLength(2);
    });

    it("a learned limit spills to the next URL", async () => {
        const t = setup(2);
        let n = 0;
        const healthy = chain(t.clock);
        t.a.answer((method, params, p) => {
            n += 1;
            return n === 11 ? httpFail(429) : healthy(method, params, p);
        });
        for (let i = 0; i < 11; i++) await call(t.router, "getSlot");
        expect(t.a.calls).toHaveLength(11);
        expect(t.b.calls).toHaveLength(1);
        t.clock.ms = 11_000;
        for (let i = 0; i < 8; i++) await call(t.router, "getSlot");
        expect(t.a.calls).toHaveLength(19);
        expect(t.b.calls).toHaveLength(1);
        await call(t.router, "getSlot");
        expect(t.a.calls).toHaveLength(19);
        expect(t.b.calls).toHaveLength(2);
        expect(snap(t.router, "rpc1").limits).toEqual({ "*": 8 });
    });

    it("Retry-After far ahead cools for at most 60 s, then probation", async () => {
        const aYearAhead = new Date(365 * 24 * 3_600_000).toUTCString();
        for (const fail of [
            () => httpFail(429, { "retry-after": "3600" }),
            () => httpFail(429, { "retry-after": aYearAhead }),
            () => httpFail(503, { "retry-after": "3600" }),
        ]) {
            const t = setup(2);
            t.a.answer(fail);
            await call(t.router, "getSlot");
            t.clock.ms = 59_999;
            expect(snap(t.router, "rpc1").state).toBe("cooling");
            await call(t.router, "getSlot");
            expect(t.a.calls).toHaveLength(1);
            expect(t.b.calls).toHaveLength(2);
            t.clock.ms = 60_000;
            expect(snap(t.router, "rpc1").state).toBe("probation");
            await call(t.router, "getSlot");
            expect(t.a.calls).toHaveLength(1);
        }
    });

    it("an open endpoint stays out until its probation passes", async () => {
        const t = setup(2);
        t.a.answer(() => netFail());
        for (let i = 0; i < 5; i++) await call(t.router, "getSlot");
        expect(t.a.calls).toHaveLength(5);
        for (let i = 0; i < 20; i++) await call(t.router, "getSlot");
        expect(t.a.calls).toHaveLength(5);
        expect(t.b.calls).toHaveLength(25);
        t.clock.ms = 30_000;
        expect(snap(t.router, "rpc1").state).toBe("probation");
        await call(t.router, "getSlot");
        expect(t.a.calls).toHaveLength(5);
    });

    it("a breaker opened by strikes alarms once", async () => {
        const t = setup(2);
        t.a.answer(() => httpFail(502));
        for (let i = 0; i < 5; i++) await call(t.router, "getSlot");
        expect(snap(t.router, "rpc1").state).toBe("open");
        expect(alarms(t)).toEqual([
            {
                level: "alarm",
                msg: "rpc_endpoint_down",
                alarm: "rpc_endpoint_down",
                endpoint: "rpc1",
                reason: "errors",
                status: 502,
            },
        ]);
        await call(t.router, "getSlot");
        expect(alarms(t)).toHaveLength(1);
    });

    it("a 522 fails over with a strike", async () => {
        const t = setup(2);
        t.a.answer(() => httpFail(522));
        expect(resultOf(await call(t.router, "getSlot"))).toBe(1_000n);
        expect(snap(t.router, "rpc1").errorRate).toBeGreaterThan(0);
    });

    it("a 402 opens the endpoint and alarms", async () => {
        const t = setup(2);
        t.a.answer(() => httpFail(402));
        expect(resultOf(await call(t.router, "getSlot"))).toBe(1_000n);
        expect(alarms(t)).toEqual([
            expect.objectContaining({
                alarm: "rpc_endpoint_down",
                endpoint: "rpc1",
                reason: "http_402",
                status: 402,
            }),
        ]);
        await call(t.router, "getSlot");
        expect(t.a.calls).toHaveLength(1);
        expect(t.b.calls).toHaveLength(2);
    });

    it("401 opens the endpoint and alarms", async () => {
        const t = setup(2);
        t.a.answer(() => httpFail(401));
        await call(t.router, "getSlot");
        expect(alarms(t)).toEqual([
            expect.objectContaining({
                alarm: "rpc_endpoint_down",
                endpoint: "rpc1",
                reason: "auth",
                status: 401,
            }),
        ]);
        expect(snap(t.router, "rpc1").state).toBe("open");
    });

    it("a 403 opens the endpoint and alarms", async () => {
        const t = setup(2);
        t.a.answer(() => httpFail(403));
        expect(resultOf(await call(t.router, "getSlot"))).toBe(1_000n);
        expect(alarms(t)).toEqual([
            expect.objectContaining({
                alarm: "rpc_endpoint_down",
                endpoint: "rpc1",
                reason: "http_403",
                status: 403,
            }),
        ]);
        await call(t.router, "getBalance", ["addr"]);
        expect(t.a.calls).toHaveLength(1);
        expect(t.b.calls.map((c) => c.method)).toEqual(["getSlot", "getBalance"]);
    });

    it("a 400 that another endpoint serves is a strike", async () => {
        const t = setup(2);
        t.a.answer(() => httpFail(400));
        expect(resultOf(await call(t.router, "getSlot"))).toBe(1_000n);
        expect(snap(t.router, "rpc1").errorRate).toBe(1);
        for (let i = 0; i < 3; i++) await call(t.router, "getSlot");
        expect(snap(t.router, "rpc1").state).toBe("ok");
        await call(t.router, "getSlot");
        expect(snap(t.router, "rpc1").state).toBe("open");

        const both = setup(2);
        both.a.answer(() => httpFail(400));
        const failing = throwing(() => httpFail(400));
        both.b.answer(failing.handler);
        expect(await rejection(call(both.router, "getSlot"))).toBe(failing.errors[0]);
        expect(snap(both.router, "rpc1").errorRate).toBe(0);
        expect(snap(both.router, "rpc2").errorRate).toBe(0);
    });

    it("a proxy's own code fails over with a strike", async () => {
        const t = setup(2);
        t.a.answer(() => rpcFail(35, "m"));
        expect(resultOf(await call(t.router, "getSlot"))).toBe(1_000n);
        expect(snap(t.router, "rpc1").errorRate).toBe(1);
        expect(snap(t.router, "rpc1").state).toBe("ok");
    });

    it("an answer without its context slot is refused", async () => {
        const t = setup(2);
        t.a.answer(() => rpcOk(5n));
        const answer = rpcOk({ context: { slot: 120n }, value: 5n });
        t.b.answer(() => answer);
        expect(await call(t.router, "getBalance", ["addr"])).toBe(answer);
        expect(snap(t.router, "rpc1").errorRate).toBe(1);
    });

    it("an answer no endpoint could prove is never returned", async () => {
        const t = setup(2);
        for (const ep of [t.a, t.b]) ep.answer(() => ({ jsonrpc: "2.0", id: 1n }));
        expect(reasonOf(await rejection(call(t.router, "getSlot")))).toBe("no_endpoint");
        const bare = setup(2);
        for (const ep of [bare.a, bare.b]) ep.answer(() => rpcOk(5n));
        expect(reasonOf(await rejection(call(bare.router, "getBalance", ["addr"])))).toBe("stale");
    });

    it("getBlockTime fails over when a node lacks the slot", async () => {
        const t = setup(2);
        t.a.answer(() => rpcFail(-32004, "Block not available for slot"));
        t.b.answer(() => rpcOk(1_700_000_000n));
        expect(resultOf(await call(t.router, "getBlockTime", [100n]))).toBe(1_700_000_000n);
    });

    it("an unknown method is tried once", async () => {
        const t = setup(2);
        t.a.answer(() => netFail());
        expect(await rejection(call(t.router, "getVoteAccounts"))).toBeInstanceOf(TypeError);
        expect(t.b.calls).toHaveLength(0);
    });

    it("a send is tried once, on the money lane only", async () => {
        const t = setup(2);
        const send = ["AAAA", { encoding: "base64", preflightCommitment: "confirmed" }];
        t.a.answer(() => netFail());
        expect(await rejection(call(t.router, "sendTransaction", send))).toBeInstanceOf(TypeError);
        const refusal = rpcFail(-32002, "Transaction simulation failed", {
            err: "AlreadyProcessed",
        });
        t.a.answer(() => refusal);
        expect(await call(t.router, "sendTransaction", send)).toBe(refusal);
        const e = await rejection(call(t.router.background, "sendTransaction", send));
        expect(reasonOf(e)).toBe("no_endpoint");
        expect(t.a.calls).toHaveLength(2);
        expect(t.b.calls).toHaveLength(0);
    });

    it("-32601 turns the method off on that endpoint", async () => {
        const t = setup(2);
        t.a.answer(() => rpcFail(-32601, "Method not found"));
        expect(resultOf(await call(t.router, "getSlot"))).toBe(1_000n);
        await call(t.router, "getSlot");
        expect(t.a.calls).toHaveLength(1);
        expect(t.b.calls).toHaveLength(2);
    });

    it("max_attempts bounds the tries", async () => {
        const t = setup(4);
        const failing = [t.a, t.b, t.c, t.d].map((ep) => {
            const f = throwing(() => netFail());
            ep.answer(f.handler);
            return f;
        });
        const e = await rejection(call(t.router, "getSlot"));
        expect(e).toBe(failing[2]!.errors[0]);
        expect([t.a, t.b, t.c, t.d].map((ep) => ep.calls.length)).toEqual([1, 1, 1, 0]);
    });

    it("the last JSON-RPC error is returned when all fail", async () => {
        const t = setup(2);
        t.a.answer(() => rpcFail(-32005, "Node is unhealthy"));
        const last = rpcFail(-32603, "Internal error");
        t.b.answer(() => last);
        expect(await call(t.router, "getSlot")).toBe(last);
    });

    it("cooldowns are never cut short", async () => {
        const t = setup(2);
        for (const ep of [t.a, t.b]) ep.answer(() => httpFail(429, { "retry-after": "10" }));
        await rejection(call(t.router, "getSlot"));
        const e = await rejection(call(t.router, "getSlot", [], AbortSignal.timeout(3_000)));
        expect(reasonOf(e)).toBe("no_endpoint");
        expect(t.clock.ms).toBe(0);
        expect(t.a.calls).toHaveLength(1);
        expect(t.b.calls).toHaveLength(1);
    });

    it("every breaker open: probation first, then the soonest to close", async () => {
        const t = setup(2);
        t.b.answer(() => netFail());
        await via(t, "rpc2", async () => {
            for (let i = 0; i < 5; i++) await rejection(call(t.router, "getSlot"));
        });
        t.clock.ms = 1_000;
        t.a.answer(() => netFail());
        for (let i = 0; i < 5; i++) await rejection(call(t.router, "getSlot"));
        expect(snap(t.router, "rpc1").state).toBe("open");
        expect(snap(t.router, "rpc2").state).toBe("open");
        t.b.answer(chain(t.clock));
        t.clock.ms = 2_000;
        const tried = t.b.calls.length;
        await call(t.router, "getSlot");
        expect(t.b.calls).toHaveLength(tried + 1);
        expect(t.a.calls).toHaveLength(5);
    });

    it("a closed endpoint free within 1 s is waited for before an open one is tried", async () => {
        const t = setup(2);
        t.b.answer(() => netFail());
        await via(t, "rpc2", async () => {
            for (let i = 0; i < 5; i++) await rejection(call(t.router, "getSlot"));
        });
        // Four answers early in the window, so the limit the 429 teaches frees within 1 s
        for (let i = 0; i < 4; i++) await call(t.router, "getSlot");
        t.clock.ms = 9_000;
        const healthy = chain(t.clock);
        let refuse = true;
        t.a.answer((method, params, p) => {
            if (!refuse) return healthy(method, params, p);
            refuse = false;
            return httpFail(429);
        });
        await rejection(call(t.router, "getSlot"));
        const tried = t.b.calls.length;
        expect(resultOf(await call(t.router, "getSlot"))).toBe(slotAt(10_000));
        expect(t.clock.ms).toBe(10_000);
        expect(t.a.calls).toHaveLength(6);
        expect(t.b.calls).toHaveLength(tried);
    });

    it("the router refuses a bad list", () => {
        const deps = testDeps([fakeEndpoint("a"), fakeEndpoint("b")]);
        expect(() =>
            createRouterTransport(
                testRpcSettings(),
                ["https://a.example/", "https://a.example"],
                deps,
            ),
        ).toThrow("rpc2 is the same URL as rpc1");
        expect(() =>
            createRouterTransport(
                testRpcSettings({ absence_quorum: 2 }),
                ONE_DOMAIN.slice(0, 2),
                deps,
            ),
        ).toThrow("found 1");
    });

    it("requests are counted per attempt", async () => {
        const t = setup(2);
        t.a.answer(() => netFail());
        await call(t.router, "getSlot");
        expect(snap(t.router, "rpc1")).toMatchObject({
            monthRequests: 1,
            hourRequests: 1,
            laneRequests: { money: 1, background: 0 },
        });
        expect(snap(t.router, "rpc2")).toMatchObject({ monthRequests: 1, hourRequests: 1 });
    });
});

describe("deadlines", () => {
    it("the caller's abort ends the call at once", async () => {
        const t = setup(2);
        t.a.answer(() => stall());
        const controller = new AbortController();
        const reason = new Error("caller gave up");
        setTimeout(() => controller.abort(reason), 10);
        expect(await rejection(call(t.router, "getSlot", [], controller.signal))).toBe(reason);
        expect(t.b.calls).toHaveLength(0);
    });

    it("a long caller abort is a latency sample", async () => {
        for (const [ms, latency] of [
            [1_100, 1_100],
            [900, 500],
        ] as const) {
            const t = setup(2, { attempt_timeout: 2_000 });
            t.a.answer(() => stall());
            const controller = new AbortController();
            const reason = new Error("caller gave up");
            const answer = rejection(call(t.router, "getSlot", [], controller.signal));
            await until(() => t.a.calls.length === 1);
            t.clock.ms += ms;
            controller.abort(reason);
            expect(await answer).toBe(reason);
            expect(snap(t.router, "rpc1").latencyMs).toBe(latency);
            expect(snap(t.router, "rpc1").errorRate).toBe(0);
        }
    });

    it("an attempt timeout moves to the next endpoint", async () => {
        const t = setup(2);
        t.a.answer(() => stall());
        const started = performance.now();
        expect(resultOf(await call(t.router, "getSlot"))).toBe(1_000n);
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(snap(t.router, "rpc1").errorRate).toBe(1);
        expect(snap(t.router, "rpc1").state).toBe("ok");
    });

    it("a stall fails over within a 3 s caller", async () => {
        const t = setup(2, {
            first_attempt_timeouts: { getLatestBlockhash: 100 },
            attempt_timeout: 300,
        });
        t.a.answer(() => stall());
        const answer = await call(t.router, "getLatestBlockhash", [], AbortSignal.timeout(300));
        expect(resultOf(answer)).toEqual({ context: { slot: 1_000n }, value: 5n });
        expect(snap(t.router, "rpc1").errorRate).toBe(1);
    });

    it("two slow endpoints keep their breakers closed", async () => {
        const t = setup(2, {
            first_attempt_timeouts: { getLatestBlockhash: 100 },
            attempt_timeout: 300,
        });
        const healthy = chain(t.clock);
        for (const ep of [t.a, t.b]) {
            ep.answer(async (method, params, p) => {
                t.clock.ms += 120;
                await delay(120);
                return healthy(method, params, p);
            });
        }
        const answers = await Promise.all(
            Array.from({ length: 20 }, () =>
                call(t.router, "getLatestBlockhash", [], AbortSignal.timeout(300)),
            ),
        );
        expect(answers).toHaveLength(20);
        for (const name of ["rpc1", "rpc2"]) {
            expect(snap(t.router, name)).toMatchObject({ errorRate: 0, state: "ok" });
        }
    });

    it("the caller's abort ends a wait for room", async () => {
        const t = setup(2, {}, { sleep: undefined });
        for (let i = 0; i < 4; i++) await call(t.router, "getSlot");
        t.clock.ms = 9_000;
        for (const ep of [t.a, t.b]) ep.answer(() => httpFail(429));
        await rejection(call(t.router, "getSlot"));
        const controller = new AbortController();
        const reason = new Error("caller gave up");
        setTimeout(() => controller.abort(reason), 20);
        const started = performance.now();
        expect(await rejection(call(t.router, "getSlot", [], controller.signal))).toBe(reason);
        expect(performance.now() - started).toBeLessThan(900);
        expect(t.a.calls).toHaveLength(5);
    });
});

describe("slots and floors", () => {
    it("-32016 moves to an endpoint at the slot", async () => {
        const t = setup(2);
        t.a.answer(() =>
            rpcFail(-32016, "Minimum context slot has not been reached", { contextSlot: 90n }),
        );
        const answer = rpcOk({ context: { slot: 120n }, value: 5n });
        t.b.answer(() => answer);
        expect(
            await call(t.router, "getBalance", [
                "addr",
                { commitment: "confirmed", minContextSlot: 100n },
            ]),
        ).toBe(answer);
        expect(snap(t.router, "rpc1").confirmedSlot).toBe("90");
    });

    it("a pinned read reaches an endpoint probed 50 s ago", async () => {
        const t = setup(2);
        const epoch = await via(t, "rpc2", () =>
            call(t.router, "getEpochInfo", [{ commitment: "confirmed" }]),
        );
        expect(resultOf(epoch)).toEqual(epochAt(900n, 1_000n));
        t.clock.ms = 50_000;
        expect(resultOf(await call(t.router, "getSlot", [{ commitment: "confirmed" }]))).toBe(
            1_125n,
        );
        t.a.answer(chain(t.clock, { getMultipleAccounts: () => netFail() }));
        const answer = rpcOk({ context: { slot: 1_126n }, value: [null] });
        t.b.answer(chain(t.clock, { getMultipleAccounts: () => answer }));
        const read = call(t.router, "getMultipleAccounts", [
            ["key1"],
            { commitment: "confirmed", minContextSlot: 1_125n },
        ]);
        expect(await read).toBe(answer);
    });

    it("a stale answer is never returned", async () => {
        for (const bFails of [false, true]) {
            const t = setup(2);
            await via(t, "rpc2", () => call(t.router, "getSlot", [{ commitment: "confirmed" }]));
            t.a.answer(() => rpcOk({ context: { slot: 940n }, value: 1n }));
            if (bFails) t.b.answer(() => netFail());
            const read = call(t.router, "getBalance", ["addr", { commitment: "confirmed" }]);
            if (bFails) {
                expect(reasonOf(await rejection(read))).toBe("stale");
            } else {
                expect(await read).toEqual(rpcOk({ context: { slot: 1_000n }, value: 5n }));
            }
        }
    });

    it("getBlockHeight below the height floor moves on", async () => {
        const t = setup(2);
        t.b.answer(() => rpcOk(5_000n));
        await via(t, "rpc2", () => call(t.router, "getBlockHeight", [{ commitment: "confirmed" }]));
        t.a.answer(() => rpcOk(4_940n));
        t.b.answer(() => rpcOk(5_001n));
        const answer = await call(t.router, "getBlockHeight", [{ commitment: "confirmed" }]);
        expect(resultOf(answer)).toBe(5_001n);
        expect(t.a.calls).toHaveLength(1);
    });

    it("a frozen first endpoint's height is refused", async () => {
        const t = setup(2);
        const epoch = () => rpcOk(epochAt(4_900n, 5_000n));
        t.a.answer(chain(t.clock, { getEpochInfo: epoch, getBlockHeight: () => rpcOk(4_900n) }));
        t.b.answer(chain(t.clock, { getEpochInfo: epoch, getBlockHeight: () => rpcOk(5_060n) }));
        const confirmed = [{ commitment: "confirmed" }];
        await call(t.router, "getEpochInfo", confirmed);
        await via(t, "rpc2", () => call(t.router, "getEpochInfo", confirmed));
        t.clock.ms = 30_000;
        expect(resultOf(await call(t.router, "getBlockHeight", confirmed))).toBe(5_060n);
        expect(t.a.calls.map((c) => c.method)).toEqual(["getEpochInfo", "getBlockHeight"]);
        expect(snap(t.router, "rpc1").state).toBe("lagging");
    });

    it("a dead endpoint never makes the live one lag", async () => {
        const t = setup(2);
        const confirmed = [{ commitment: "confirmed" }];
        t.a.answer(() => rpcOk(1_000n));
        expect(resultOf(await call(t.router, "getSlot", confirmed))).toBe(1_000n);
        t.a.answer(() => netFail());
        t.b.answer(() => rpcOk(1_000n + BigInt(Math.floor(t.clock.ms / 420))));
        for (let ms = 5_000; ms <= 30 * 60_000; ms += 5_000) {
            t.clock.ms = ms;
            const answer = await call(t.router, "getSlot", confirmed);
            expect(resultOf(answer)).toBe(1_000n + BigInt(Math.floor(ms / 420)));
            expect(snap(t.router, "rpc2").lag).toBe(0);
        }
    });

    it("the floor is per commitment", async () => {
        // A lag of 20 puts the confirmed floor above the finalized high water
        const t = setup(2, { max_slot_lag: 20 });
        t.b.answer((_method, params) =>
            rpcOk(isObject(params[0]) && params[0].commitment === "confirmed" ? 1_000n : 970n),
        );
        await via(t, "rpc2", () => call(t.router, "getSlot", [{ commitment: "confirmed" }]));
        await via(t, "rpc2", () => call(t.router, "getSlot"));
        const answer = rpcOk({ context: { slot: 970n }, value: null });
        t.a.answer(() => answer);
        expect(await call(t.router, "getAccountInfo", ["addr", { encoding: "base64" }])).toBe(
            answer,
        );
    });

    it("a slot that goes back marks the endpoint inconsistent", async () => {
        const t = setup(2);
        const confirmed = [{ commitment: "confirmed" }];
        t.a.answer(() => rpcOk(1_000n));
        await call(t.router, "getSlot", confirmed);
        t.a.answer(() => rpcOk(900n));
        expect(resultOf(await call(t.router, "getSlot", confirmed))).toBe(1_000n);
        expect(snap(t.router, "rpc1").consistent).toBe("no");
        expect(t.log.lines.filter((l) => l.msg === "rpc endpoint answers inconsistently")).toEqual([
            {
                level: "warn",
                msg: "rpc endpoint answers inconsistently",
                endpoint: "rpc1",
                reason: "slot_went_back",
            },
        ]);
    });
});

describe("history and transactions", () => {
    const getTransaction = ["sig1", { commitment: "confirmed", encoding: "json" }];

    it("history reads skip an endpoint without history", async () => {
        const t = setup(2);
        setCheckState(t.router, "rpc1", { history: "missing" });
        expect(resultOf(await call(t.router, "getTransaction", getTransaction))).toEqual(TX);
        expect(t.a.calls).toHaveLength(0);
        expect(t.b.calls).toHaveLength(1);
    });

    it("a null transaction is asked once of another domain", async () => {
        const found = setup(3);
        found.a.answer(() => rpcOk(null));
        expect(resultOf(await call(found.router, "getTransaction", getTransaction))).toEqual(TX);
        expect(found.b.calls).toHaveLength(1);

        const none = setup(3);
        for (const ep of [none.a, none.b]) ep.answer(() => rpcOk(null));
        expect(resultOf(await call(none.router, "getTransaction", getTransaction))).toBeNull();
        expect(none.b.calls).toHaveLength(1);
        expect(none.c.calls).toHaveLength(0);

        const shared = setup(3, {}, { urls: ONE_DOMAIN });
        shared.a.answer(() => rpcOk(null));
        expect(resultOf(await call(shared.router, "getTransaction", getTransaction))).toEqual(TX);
        expect(shared.b.calls).toHaveLength(0);
        expect(shared.c.calls).toHaveLength(1);
    });

    it("a transaction without meta is asked once of another domain", async () => {
        const withoutPre = { err: null, fee: 5000n, postTokenBalances: [] };
        for (const first of [
            { ...TX, meta: null },
            { ...TX, meta: withoutPre },
        ]) {
            const t = setup(2);
            t.a.answer(() => rpcOk(first));
            expect(resultOf(await call(t.router, "getTransaction", getTransaction))).toEqual(TX);
            expect(t.b.calls).toHaveLength(1);
        }
        const full = setup(2);
        await call(full.router, "getTransaction", getTransaction);
        expect(full.b.calls).toHaveLength(0);
    });

    it("an inconsistent endpoint's null transaction is asked of a consistent one", async () => {
        const t = setup(3);
        setCheckState(t.router, "rpc1", { consistent: "no" });
        setCheckState(t.router, "rpc2", { consistent: "no" });
        t.a.answer(() => rpcOk(null));
        expect(resultOf(await call(t.router, "getTransaction", getTransaction))).toEqual(TX);
        expect(t.b.calls).toHaveLength(0);
        expect(t.c.calls).toHaveLength(1);
    });
});

describe("limits and lanes", () => {
    it("a short wait for room", async () => {
        const t = setup(2);
        await teach(t, t.b, "rpc2", 7);
        await teach(t, t.a, "rpc1", 7);
        expect(snap(t.router, "rpc1").limits).toEqual({ "*": 5 });
        expect(snap(t.router, "rpc2").limits).toEqual({ "*": 5 });
        t.clock.ms = 11_000;
        for (let i = 0; i < 5; i++) await call(t.router, "getSlot");
        t.clock.ms = 11_100;
        for (let i = 0; i < 5; i++) await call(t.router, "getSlot");
        const before = [t.a.calls.length, t.b.calls.length];
        t.clock.ms = 20_500;
        await call(t.router, "getSlot");
        expect(t.clock.ms).toBe(21_000);
        expect([t.a.calls.length, t.b.calls.length]).toEqual([before[0]! + 1, before[1]]);
    });

    it("background at its share still leaves room for getLatestBlockhash", async () => {
        const t = setup(2);
        await teach(t, t.b, "rpc2", 13);
        await teach(t, t.a, "rpc1", 13);
        expect(snap(t.router, "rpc1").limits).toEqual({ "*": 10 });
        t.clock.ms = 11_000;
        for (let i = 0; i < 6; i++) await call(t.router.background, "getSlot");
        const before = t.a.calls.length;
        await call(t.router, "getLatestBlockhash");
        expect(t.a.calls).toHaveLength(before + 1);
        expect(t.clock.ms).toBe(11_000);
    });

    it("a busy rpc1 keeps background reads off rpc2", async () => {
        const t = setup(2);
        await teach(t, t.b, "rpc2", 13);
        await teach(t, t.a, "rpc1", 13);
        t.clock.ms = 11_000;
        for (let i = 0; i < 6; i++) await call(t.router.background, "getSlot");
        const bCalls = t.b.calls.length;
        const e = await rejection(call(t.router.background, "getSlot"));
        expect(reasonOf(e)).toBe("no_endpoint");
        expect(t.clock.ms - 11_000).toBeLessThanOrEqual(1_000);
        expect(t.b.calls).toHaveLength(bCalls);

        // Two listings in the window first: a 429 on a window of one would teach a limit of 1,
        // whose background share rounds to 0 and puts rpc1 out for background listings
        t.clock.ms = 22_000;
        const listing = ["addr", { commitment: "confirmed", limit: 10 }];
        for (let i = 0; i < 2; i++) await call(t.router, "getSignaturesForAddress", listing);
        const healthy = chain(t.clock);
        t.a.answer((method, params, p) =>
            method === "getSignaturesForAddress"
                ? httpFail(429, { "retry-after": "30" })
                : healthy(method, params, p),
        );
        const refused = await rejection(
            call(t.router.background, "getSignaturesForAddress", listing),
        );
        expect(reasonOf(refused)).toBe("no_endpoint");
        expect(t.clock.ms - 22_000).toBeLessThanOrEqual(1_000);
        expect(t.b.calls).toHaveLength(bCalls);
        await call(t.router, "getSignaturesForAddress", listing);
        expect(t.b.calls).toHaveLength(bCalls + 1);
        expect(t.b.calls.at(-1)!.method).toBe("getSignaturesForAddress");
    });

    it("a rate limited rpc1 sends background listings to rpc2", async () => {
        const pinned = ["addr", { commitment: "confirmed", minContextSlot: 1_000n, limit: 10 }];
        const limited = setup(2);
        limited.a.answer(() => httpFail(429));
        for (let minute = 0; minute <= 5; minute++) {
            limited.clock.ms = minute * 60_000;
            await call(limited.router, "getSlot");
            expect(limited.a.calls).toHaveLength(minute + 1);
            expect(limited.b.calls).toHaveLength(minute + 1);
        }
        await call(limited.router.background, "getSignaturesForAddress", pinned);
        expect(limited.a.calls).toHaveLength(6);
        expect(limited.b.calls.at(-1)!.method).toBe("getSignaturesForAddress");

        const open = setup(2);
        open.a.answer(() => netFail());
        for (let i = 0; i < 5; i++) await call(open.router, "getSlot");
        expect(snap(open.router, "rpc1").state).toBe("open");
        await call(open.router.background, "getSignaturesForAddress", pinned);
        expect(open.clock.ms).toBe(0);
        expect(open.a.calls).toHaveLength(5);
        expect(open.b.calls.at(-1)!.method).toBe("getSignaturesForAddress");
    });
});

describe("absence quorum", () => {
    const SIG = "sig1";
    const searching = [[SIG], { searchTransactionHistory: true }];
    const failed = { InstructionError: [2n, { Custom: 1n }] };

    // Statuses at the clock's slot, or at slot when given; every other method as a caught-up node
    function statuses(t: Setup, value: Status[], slot?: bigint): FakeHandler {
        return chain(t.clock, {
            getSignatureStatuses: () => statusesAnswer(slot ?? slotAt(t.clock.ms), value),
        });
    }

    function valueOf(answer: unknown): unknown {
        return (resultOf(answer) as { value: unknown }).value;
    }

    function absenceAlarms(t: TestDeps): Record<string, unknown>[] {
        return alarms(t).filter((l) => l.alarm === "rpc_absence_unconfirmed");
    }

    it("a null is confirmed by a second domain", async () => {
        const t = setup(2);
        t.a.answer(statuses(t, [null], 1_000n));
        t.b.answer(statuses(t, [null], 999n));
        const answer = await call(t.router, "getSignatureStatuses", searching);
        expect(valueOf(answer)).toEqual([null]);
        expect((resultOf(answer) as { context: { slot: bigint } }).context.slot).toBe(999n);
        expect(t.b.calls).toHaveLength(1);
    });

    it("a status found by the second domain wins", async () => {
        const t = setup(2);
        t.a.answer(statuses(t, [null]));
        t.b.answer(statuses(t, [S(7n, "confirmed")]));
        const answer = await call(t.router, "getSignatureStatuses", searching);
        expect((valueOf(answer) as Status[])[0]?.confirmationStatus).toBe("confirmed");
    });

    it("same-domain endpoints do not make a quorum", async () => {
        const t = setup(3, {}, { urls: ONE_DOMAIN });
        t.a.answer(statuses(t, [null]));
        t.b.answer(statuses(t, [null]));
        t.c.answer(() => netFail());
        const e = await rejection(call(t.router, "getSignatureStatuses", searching));
        expect(reasonOf(e)).toBe("absence_unconfirmed");
        expect(t.b.calls).toHaveLength(0);
        expect(absenceAlarms(t)).toEqual([
            {
                level: "alarm",
                msg: "rpc_absence_unconfirmed",
                alarm: "rpc_absence_unconfirmed",
                count: 1,
                domainsAnswered: 1,
            },
        ]);
    });

    it("no second domain fails closed", async () => {
        const t = setup(2);
        t.a.answer(statuses(t, [null]));
        t.b.answer(() => netFail());
        const e = await rejection(call(t.router, "getSignatureStatuses", searching));
        expect(reasonOf(e)).toBe("absence_unconfirmed");
    });

    it("an inconsistent endpoint's null never counts", async () => {
        const t = setup(3);
        setCheckState(t.router, "rpc1", { consistent: "no" });
        for (const ep of [t.a, t.b, t.c]) ep.answer(statuses(t, [null]));
        expect(valueOf(await call(t.router, "getSignatureStatuses", searching))).toEqual([null]);
        for (const ep of [t.a, t.b, t.c]) expect(ep.calls).toHaveLength(1);

        const down = setup(3);
        setCheckState(down.router, "rpc1", { consistent: "no" });
        down.a.answer(statuses(down, [null]));
        down.b.answer(statuses(down, [null]));
        down.c.answer(() => netFail());
        const e = await rejection(call(down.router, "getSignatureStatuses", searching));
        expect(reasonOf(e)).toBe("absence_unconfirmed");
        expect(absenceAlarms(down).at(-1)).toMatchObject({ domainsAnswered: 1 });
    });

    it("an inconsistent endpoint's status still decides its entry", async () => {
        const t = setup(3);
        setCheckState(t.router, "rpc1", { consistent: "no" });
        const found = statusesAnswer(slotAt(0), [S(7n, "finalized")]);
        t.a.answer(chain(t.clock, { getSignatureStatuses: () => found }));
        expect(await call(t.router, "getSignatureStatuses", searching)).toBe(found);
        expect(t.b.calls).toHaveLength(0);
    });

    it("quorum 1 still needs a consistent endpoint", async () => {
        const t = setup(3, { absence_quorum: 1 });
        setCheckState(t.router, "rpc1", { consistent: "no" });
        for (const ep of [t.a, t.b, t.c]) ep.answer(statuses(t, [null]));
        expect(valueOf(await call(t.router, "getSignatureStatuses", searching))).toEqual([null]);
        expect(t.b.calls).toHaveLength(1);
        expect(t.c.calls).toHaveLength(0);
    });

    it("a null after a found answer marks the endpoint", async () => {
        const t = setup(3);
        t.a.answer(statuses(t, [S(7n, "finalized")]));
        await call(t.router, "getSignatureStatuses", searching);
        expect(t.b.calls).toHaveLength(0);
        for (const ep of [t.a, t.b, t.c]) ep.answer(statuses(t, [null]));
        expect(valueOf(await call(t.router, "getSignatureStatuses", searching))).toEqual([null]);
        expect(t.log.lines.filter((l) => l.msg === "rpc endpoint answers inconsistently")).toEqual([
            {
                level: "warn",
                msg: "rpc endpoint answers inconsistently",
                endpoint: "rpc1",
                reason: "found_then_missing",
            },
        ]);
        expect(snap(t.router, "rpc1").consistent).toBe("no");
        expect(t.b.calls).toHaveLength(1);
        expect(t.c.calls).toHaveLength(1);
    });

    it("-32011 after a found answer marks the endpoint", async () => {
        const t = setup(3);
        t.a.answer(statuses(t, [S(7n, "confirmed")]));
        await call(t.router, "getSignatureStatuses", searching);
        t.a.answer(() => rpcFail(-32011, "Transaction history is not available from this node"));
        t.b.answer(statuses(t, [S(7n, "finalized")]));
        await call(t.router, "getSignatureStatuses", searching);
        expect(snap(t.router, "rpc1").consistent).toBe("no");
    });

    it("a transaction found at confirmed and later null marks the endpoint", async () => {
        const confirmed = [SIG, { commitment: "confirmed", encoding: "json" }];
        const finalized = [SIG, { encoding: "json" }];
        const t = setup(2);
        await call(t.router, "getTransaction", confirmed);
        t.a.answer(() => rpcOk(null));
        // Null at finalized is a confirmed transaction that has not finalized yet
        await call(t.router, "getTransaction", finalized);
        expect(snap(t.router, "rpc1").consistent).toBe("yes");
        await call(t.router, "getTransaction", confirmed);
        expect(snap(t.router, "rpc1").consistent).toBe("no");
    });

    it("the alarm repeats at most every 10 minutes", async () => {
        const t = setup(2);
        t.a.answer(statuses(t, [null]));
        t.b.answer(() => netFail());
        for (const ms of [0, 150_000, 300_000]) {
            t.clock.ms = ms;
            await rejection(call(t.router, "getSignatureStatuses", searching));
        }
        expect(absenceAlarms(t)).toHaveLength(1);
        t.clock.ms = 660_000;
        await rejection(call(t.router, "getSignatureStatuses", searching));
        expect(absenceAlarms(t)).toHaveLength(2);
        expect(absenceAlarms(t)[1]).toMatchObject({ count: 3, domainsAnswered: 1 });
    });

    it("no null, no second call", async () => {
        const t = setup(2);
        t.a.answer(statuses(t, [S(5n, "finalized")]));
        await call(t.router, "getSignatureStatuses", searching);
        expect(t.b.calls).toHaveLength(0);
    });

    it("statuses without history are never confirmed", async () => {
        const t = setup(2);
        t.a.answer(statuses(t, [null]));
        expect(valueOf(await call(t.router, "getSignatureStatuses", [[SIG]]))).toEqual([null]);
        expect(t.b.calls).toHaveLength(0);
    });

    it("quorum 1 keeps one answer", async () => {
        const t = setup(2, { absence_quorum: 1 });
        const missing = statusesAnswer(slotAt(0), [null]);
        t.a.answer(chain(t.clock, { getSignatureStatuses: () => missing }));
        expect(await call(t.router, "getSignatureStatuses", searching)).toBe(missing);
        expect(t.b.calls).toHaveLength(0);
    });

    it("a conflict throws", async () => {
        const t = setup(2);
        t.a.answer(statuses(t, [S(5n, "confirmed"), null]));
        t.b.answer(statuses(t, [S(5n, "confirmed", failed), null]));
        const e = await rejection(
            call(t.router, "getSignatureStatuses", [[SIG, "sig2"], searching[1]]),
        );
        expect(reasonOf(e)).toBe("status_conflict");
        expect(t.log.lines.filter((l) => l.msg === "rpc endpoints disagree on a status")).toEqual([
            {
                level: "warn",
                msg: "rpc endpoints disagree on a status",
                endpoints: ["rpc1", "rpc2"],
            },
        ]);
    });

    it("an unconfirmed absence carries the answers received", async () => {
        const t = setup(2);
        const value = [S(5n, "confirmed"), null];
        t.a.answer(statuses(t, value, 10n));
        t.b.answer(() => netFail());
        const e = await rejection(
            call(t.router, "getSignatureStatuses", [[SIG, "sig2"], searching[1]]),
        );
        expect(reasonOf(e)).toBe("absence_unconfirmed");
        expect((e as RpcRouterError).partial).toMatchObject({ result: { context: { slot: 10n } } });
        expect(valueOf((e as RpcRouterError).partial)).toEqual(value);
    });

    it("the caller's abort ends the quorum ask as an unconfirmed absence", async () => {
        const t = setup(2);
        t.a.answer(statuses(t, [S(5n, "confirmed"), null]));
        t.b.answer(() => stall());
        const caller = new AbortController();
        const answer = call(
            t.router,
            "getSignatureStatuses",
            [[SIG, "sig2"], searching[1]],
            caller.signal,
        );
        await until(() => t.b.calls.length === 1);
        caller.abort(new Error("caller gave up"));
        const e = await rejection(answer);
        expect(reasonOf(e)).toBe("absence_unconfirmed");
        expect(valueOf((e as RpcRouterError).partial)).toEqual([S(5n, "confirmed"), null]);
    });
});

describe("cursor affinity", () => {
    const ADDRESS = "A";
    const PINNED = { commitment: "confirmed", minContextSlot: 1_000n };
    const LISTING = "getSignaturesForAddress";

    function entry(signature: string): Record<string, unknown> {
        return {
            signature,
            slot: 900n,
            err: null,
            memo: null,
            blockTime: null,
            confirmationStatus: "finalized",
        };
    }

    function optionsOf(params: readonly unknown[]): { before?: string } {
        return (params[1] ?? {}) as { before?: string };
    }

    // Listings by address and before cursor, a first page under ""; any other cursor gets []
    function listings(
        t: Setup,
        byAddress: Record<string, Record<string, string[]>>,
        over: Record<string, FakeHandler> = {},
    ): FakeHandler {
        return chain(t.clock, {
            getSignaturesForAddress: (_method, params) => {
                const pages = byAddress[params[0] as string] ?? {};
                return rpcOk((pages[optionsOf(params).before ?? ""] ?? []).map(entry));
            },
            ...over,
        });
    }

    function pages(
        t: Setup,
        byBefore: Record<string, string[]>,
        over: Record<string, FakeHandler> = {},
    ): FakeHandler {
        return listings(t, { [ADDRESS]: byBefore }, over);
    }

    // The before cursor of each listing the fake received
    function befores(fake: FakeEndpoint): (string | undefined)[] {
        return fake.calls
            .filter((c) => c.method === LISTING)
            .map((c) => optionsOf(c.params).before);
    }

    function methods(fake: FakeEndpoint): string[] {
        return fake.calls.map((c) => c.method);
    }

    function signaturesOf(answer: unknown): string[] {
        return (resultOf(answer) as { signature: string }[]).map((e) => e.signature);
    }

    // Five network failures open the breaker, and no other endpoint sees those calls
    async function open(t: Setup, fake: FakeEndpoint, name: string): Promise<void> {
        fake.answer(() => netFail());
        await via(t, name, async () => {
            for (let i = 0; i < 5; i++) await call(t.router, "getSlot").catch(() => undefined);
        });
        expect(snap(t.router, name).state).toBe("open");
    }

    it("a page continues where its cursor came from", async () => {
        const t = setup(2);
        const listed = pages(t, { "": ["s1", "s2", "s3"], s3: ["s4", "s5"] });
        t.a.answer((method, params, p) =>
            t.clock.ms === 0 ? httpFail(429, { "retry-after": "10" }) : listed(method, params, p),
        );
        t.b.answer(listed);
        const first = await call(t.router, LISTING, [ADDRESS, { limit: 3 }]);
        expect(signaturesOf(first)).toEqual(["s1", "s2", "s3"]);
        t.clock.ms = 11_000;
        expect(snap(t.router, "rpc1").state).toBe("ok");
        const second = await call(t.router, LISTING, [ADDRESS, { before: "s3", limit: 3 }]);
        expect(signaturesOf(second)).toEqual(["s4", "s5"]);
        expect(t.a.calls).toHaveLength(1);
        expect(befores(t.b)).toEqual([undefined, "s3"]);
    });

    it("a cursor on a down endpoint is proven by its predecessor", async () => {
        const t = setup(2);
        t.a.answer(pages(t, { "": ["s1", "s2", "s3"] }));
        t.b.answer(pages(t, { s2: ["s3"], s3: ["s4", "s5"] }));
        await call(t.router, LISTING, [ADDRESS, { ...PINNED, limit: 3 }]);
        await open(t, t.a, "rpc1");
        const answer = await call(t.router, LISTING, [
            ADDRESS,
            { ...PINNED, before: "s3", limit: 3 },
        ]);
        expect(signaturesOf(answer)).toEqual(["s4", "s5"]);
        expect(t.b.calls[0]!.params).toEqual([ADDRESS, { ...PINNED, before: "s2", limit: 1 }]);
        expect(t.b.calls.map((c) => optionsOf(c.params).before)).toEqual(["s2", "s3"]);
    });

    it("the predecessor proof must return exactly the cursor", async () => {
        for (const proof of [[], ["s4"]]) {
            const t = setup(2);
            t.a.answer(pages(t, { "": ["s1", "s2", "s3"] }));
            t.b.answer(pages(t, { s2: proof, s3: ["s4", "s5"] }));
            await call(t.router, LISTING, [ADDRESS, { limit: 3 }]);
            await open(t, t.a, "rpc1");
            const e = await rejection(
                call(t.router, LISTING, [ADDRESS, { before: "s3", limit: 3 }]),
            );
            expect(reasonOf(e)).toBe("cursor_unverified");
            expect(befores(t.b)).toEqual(["s2"]);
        }
    });

    it("a cursor the other endpoint does not know fails closed", async () => {
        const t = setup(3);
        t.a.answer(pages(t, { "": ["s1", "s2", "s3"] }));
        t.b.answer(pages(t, { s3: ["s4"] }));
        t.c.answer(() => netFail());
        await call(t.router, LISTING, [ADDRESS, { limit: 3 }]);
        await open(t, t.a, "rpc1");
        const e = await rejection(call(t.router, LISTING, [ADDRESS, { before: "s3", limit: 3 }]));
        expect(reasonOf(e)).toBe("cursor_unverified");
        expect(befores(t.b)).toEqual(["s2"]);
        expect(befores(t.c)).toEqual(["s2"]);
    });

    it("one signature can end pages of two addresses", async () => {
        const t = setup(2);
        t.a.answer(listings(t, { HOT: { "": ["H1", "PH", "S"] } }));
        t.b.answer(listings(t, { COLD: { "": ["PC", "S"] }, HOT: { PH: ["S"], S: ["H4"] } }));
        await call(t.router, LISTING, ["HOT", { limit: 3 }]);
        await via(t, "rpc2", () => call(t.router, LISTING, ["COLD", { limit: 2 }]));
        await open(t, t.a, "rpc1");
        const answer = await call(t.router, LISTING, ["HOT", { before: "S", limit: 3 }]);
        expect(signaturesOf(answer)).toEqual(["H4"]);
        expect(t.b.calls.map((c) => [c.params[0], optionsOf(c.params).before])).toEqual([
            ["COLD", undefined],
            ["HOT", "PH"],
            ["HOT", "S"],
        ]);
    });

    it("an unknown cursor falls back to the status check", async () => {
        const page = [ADDRESS, { before: "zzz", limit: 3 }];
        const check = [["zzz"], { searchTransactionHistory: true }];
        const withStatus = (t: Setup, status: Status): FakeHandler =>
            pages(
                t,
                { zzz: ["s9"] },
                { getSignatureStatuses: () => statusesAnswer(slotAt(t.clock.ms), [status]) },
            );

        const known = setup(2);
        known.a.answer(withStatus(known, S(900n, "finalized")));
        expect(signaturesOf(await call(known.router, LISTING, page))).toEqual(["s9"]);
        expect(methods(known.a)).toEqual(["getSignatureStatuses", LISTING]);
        expect(known.a.calls[0]!.params).toEqual(check);
        expect(known.b.calls).toHaveLength(0);

        const next = setup(2);
        next.a.answer(withStatus(next, null));
        next.b.answer(withStatus(next, S(900n, "finalized")));
        expect(signaturesOf(await call(next.router, LISTING, page))).toEqual(["s9"]);
        expect(methods(next.a)).toEqual(["getSignatureStatuses"]);
        expect(methods(next.b)).toEqual(["getSignatureStatuses", LISTING]);

        const none = setup(2);
        for (const fake of [none.a, none.b]) fake.answer(withStatus(none, null));
        const e = await rejection(call(none.router, LISTING, page));
        expect(reasonOf(e)).toBe("cursor_unverified");
        expect(methods(none.a)).toEqual(["getSignatureStatuses"]);
        expect(methods(none.b)).toEqual(["getSignatureStatuses"]);
    });

    it("a one-entry first page is checked by its status", async () => {
        const t = setup(2);
        t.a.answer(pages(t, { "": ["s1"] }));
        t.b.answer(
            pages(
                t,
                { s1: ["s0"] },
                {
                    getSignatureStatuses: () =>
                        statusesAnswer(slotAt(t.clock.ms), [S(900n, "finalized")]),
                },
            ),
        );
        await call(t.router, LISTING, [ADDRESS, { limit: 1 }]);
        await open(t, t.a, "rpc1");
        const answer = await call(t.router, LISTING, [ADDRESS, { before: "s1", limit: 1 }]);
        expect(signaturesOf(answer)).toEqual(["s0"]);
        expect(methods(t.b)).toEqual(["getSignatureStatuses", LISTING]);
        expect(t.b.calls[0]!.params).toEqual([["s1"], { searchTransactionHistory: true }]);
    });

    it("until needs no check", async () => {
        const t = setup(2);
        t.a.answer(pages(t, { "": ["s3", "s2"] }));
        await call(t.router, LISTING, [ADDRESS, { until: "s1" }]);
        expect(methods(t.a)).toEqual([LISTING]);
        expect(t.b.calls).toHaveLength(0);
    });

    it("one endpoint pages without a cursor check", async () => {
        const t = setup(1);
        t.a.answer(pages(t, { zzz: ["s9"] }));
        await call(t.router, LISTING, [ADDRESS, { before: "zzz", limit: 3 }]);
        expect(methods(t.a)).toEqual([LISTING]);
    });

    it("an inconsistent endpoint never gets a listing", async () => {
        const t = setup(3);
        setCheckState(t.router, "rpc1", { consistent: "no" });
        const listed = pages(t, { "": ["s1", "s2", "s3"], s2: ["s3"], s3: ["s4", "s5", "s6"] });
        let served = 0;
        t.a.answer(listed);
        t.b.answer((method, params, p) =>
            method === LISTING && ++served > 1 ? netFail() : listed(method, params, p),
        );
        t.c.answer(listed);
        await call(t.router, LISTING, [ADDRESS, { limit: 3 }]);
        const answer = await call(t.router, LISTING, [ADDRESS, { before: "s3", limit: 3 }]);
        expect(signaturesOf(answer)).toEqual(["s4", "s5", "s6"]);
        expect(befores(t.b)).toEqual([undefined, "s3"]);
        expect(befores(t.c)).toEqual(["s2", "s3"]);
        expect(t.a.calls).toHaveLength(0);
    });
});

describe("secrets", () => {
    it("logs never carry a URL or host", async () => {
        const urls = [
            "https://a.example/?api-key=SECRETSECRETSECRET1",
            "https://b.example/v2/SECRETSECRETSECRET2",
        ];
        const failures: FakeHandler[] = [
            () => netFail(),
            () => netFail("ECONNREFUSED"),
            () => httpFail(429, { "retry-after": "3600" }),
            () => httpFail(401),
            () => httpFail(402),
            () => httpFail(403),
            () => httpFail(400),
            () => httpFail(413),
            () => httpFail(503, { "retry-after": "5" }),
            () => httpFail(522),
            () => rpcFail(-32005, "Node is behind", { numSlotsBehind: 99n }),
            () => rpcFail(-32016, "Minimum context slot", { contextSlot: 10n }),
            () => rpcFail(-32601, "Method not found"),
            () => rpcFail(-32603, "Internal error"),
            () => rpcFail(35, "m"),
            () => rpcFail(-32004, "Block not available"),
            () => rpcOk(5n),
            () => rpcOk({ context: { slot: 1n }, value: 5n }),
            () => ({ jsonrpc: "2.0", id: 1n }),
            () => {
                throw new SyntaxError("Unexpected token in JSON");
            },
            () => stall(),
        ];
        const lines: Record<string, unknown>[] = [];
        const read = ["addr", { commitment: "confirmed", minContextSlot: 500n }];
        for (const fail of failures) {
            const t = setup(2, {}, { urls });
            t.a.answer(fail);
            for (let i = 0; i < 5; i++) await call(t.router, "getBalance", read).catch(() => null);
            t.a.answer(() => rpcOk(2_000n));
            await call(t.router, "getSlot", [{ commitment: "confirmed" }]).catch(() => null);
            t.a.answer(() => rpcOk(1_900n));
            await call(t.router, "getSlot", [{ commitment: "confirmed" }]).catch(() => null);
            lines.push(...t.log.lines);
        }
        expect(lines.some((l) => l.level === "alarm")).toBe(true);
        expect(lines.some((l) => l.msg === "rpc endpoint answers inconsistently")).toBe(true);
        const text = JSON.stringify(lines, (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
        );
        for (const part of ["SECRET", "a.example", "b.example"]) {
            expect(text).not.toContain(part);
        }
    });
});
