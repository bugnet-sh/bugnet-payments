import type { RpcTransport } from "@solana/kit";
import { describe, expect, it, onTestFinished } from "vitest";
import { epochAt } from "../../testing/fake-rpc.ts";
import { RpcRouterError } from "./errors.ts";
import { isObject } from "./payload.ts";
import { MAINNET_GENESIS } from "./probe.ts";
import type { RpcSettings } from "./settings.ts";
import {
    type FakeEndpoint,
    type FakeHandler,
    fakeEndpoint,
    httpFail,
    netFail,
    passAll,
    rpcFail,
    rpcOk,
    signatureStatus as S,
    statusesAnswer,
    testDeps,
    type TestDeps,
    testRpcSettings,
} from "./testing.ts";
import {
    createRouterTransport,
    type EndpointSnapshot,
    type RouterDeps,
    type RouterSnapshot,
    type RouterTransport,
    setCheckState,
} from "./transport.ts";
import type { UsageRow, UsageStore } from "./usage.ts";

// 2026-11-10T00:00:00Z, for the tests that store a month
const NOV = Date.UTC(2026, 10, 10);
const CONFIRMED = [{ commitment: "confirmed" }];
const WIRE = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
const TX = {
    slot: 900n,
    blockTime: null,
    meta: { err: null, fee: 5000n, preTokenBalances: [], postTokenBalances: [] },
    transaction: ["AAAA", "base64"],
};

function slotAt(ms: number): bigint {
    return 1_000n + BigInt(Math.floor(ms / 400));
}

function pinOf(params: readonly unknown[]): bigint | null {
    const last = params.at(-1);
    const pin = isObject(last) ? last.minContextSlot : undefined;
    return typeof pin === "bigint" ? pin : null;
}

// A caught-up mainnet node with history, at the clock's slot; over answers its methods first
function node(clock: { ms: number }, label: string, over: Record<string, FakeHandler> = {}) {
    const handler: FakeHandler = (method, params, payload) => {
        const own = over[method];
        if (own !== undefined) return own(method, params, payload);
        const slot = slotAt(clock.ms);
        const pin = pinOf(params);
        if (pin !== null && pin > slot) {
            return rpcFail(-32016, "Minimum context slot has not been reached", {
                contextSlot: slot,
            });
        }
        switch (method) {
            case "getGenesisHash":
                return rpcOk(MAINNET_GENESIS);
            case "getIdentity":
                return rpcOk({ identity: `node-${label}` });
            case "getSlot":
                return rpcOk(slot);
            case "getBlockHeight":
                return rpcOk(slot - 100n);
            case "getEpochInfo":
                return rpcOk(epochAt(slot - 100n, slot));
            case "getSignatureStatuses":
                return statusesAnswer(
                    slot,
                    (params[0] as string[]).map(() => S(500n, "finalized")),
                );
            case "getTransaction":
                return rpcOk(TX);
            case "getSignaturesForAddress":
                return rpcOk([]);
            case "sendTransaction":
                return rpcOk(`${label}-signature`);
            default:
                return rpcOk({ context: { slot }, value: 5n });
        }
    };
    return handler;
}

interface Setup extends TestDeps {
    router: RouterTransport;
    a: FakeEndpoint;
    b: FakeEndpoint;
}

// Two endpoints on two domains, built at clock `at`; passed: every check as if it had passed
function setup(
    o: {
        at?: number;
        over?: Partial<RpcSettings>;
        more?: Partial<RouterDeps> & { urls?: string[] };
        passed?: boolean;
    } = {},
): Setup {
    const eps = ["a", "b"].map((label) => fakeEndpoint(label));
    const deps = testDeps(eps, o.more);
    deps.clock.ms = o.at ?? 0;
    for (const ep of eps) ep.answer(node(deps.clock, ep.label));
    const router = createRouterTransport(testRpcSettings(o.over), deps.urls, deps);
    onTestFinished(() => router.stop());
    if (o.passed ?? true) passAll(router);
    return { ...deps, router, a: eps[0]!, b: eps[1]! };
}

function call(t: RpcTransport, method: string, params: unknown[] = []): Promise<unknown> {
    return t({ payload: { jsonrpc: "2.0", id: 1n, method, params } });
}

function send(t: Setup): Promise<unknown> {
    const config = { encoding: "base64", preflightCommitment: "confirmed" };
    return call(t.router, "sendTransaction", [WIRE, config]);
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

async function tickAt(t: Setup, ms: number): Promise<void> {
    t.clock.ms = ms;
    await t.router.tick();
}

function snap(t: Setup, name: string): EndpointSnapshot {
    return t.router.snapshot().endpoints.find((e) => e.name === name)!;
}

function lines(t: Setup, level: string, msg: string): Record<string, unknown>[] {
    return t.log.lines.filter((l) => l.level === level && l.msg === msg);
}

function alarms(t: Setup, name: string, more: Record<string, unknown> = {}) {
    return lines(t, "alarm", name).filter((l) =>
        Object.entries(more).every(([key, value]) => l[key] === value),
    );
}

function alarm(name: string, f: Record<string, unknown>): Record<string, unknown> {
    return { level: "alarm", msg: name, alarm: name, ...f };
}

// Runs fn with the other endpoint unchecked, so only the endpoint at name takes its calls
async function via<T>(t: Setup, name: string, fn: () => Promise<T>): Promise<T> {
    const other = name === "rpc1" ? "rpc2" : "rpc1";
    setCheckState(t.router, other, { genesis: "error" });
    try {
        return await fn();
    } finally {
        setCheckState(t.router, other, { genesis: "ok" });
    }
}

// total - 1 getSlot calls and a 429 in one window teach a limit of floor(0.8 x total)
async function teach(t: Setup, fake: FakeEndpoint, name: string, total: number): Promise<void> {
    let n = 0;
    const healthy = node(t.clock, fake.label);
    fake.answer((method, params, p) => {
        n += 1;
        return n === total ? httpFail(429) : healthy(method, params, p);
    });
    await via(t, name, async () => {
        for (let i = 0; i < total; i++) await call(t.router, "getSlot").catch(() => undefined);
    });
    fake.answer(healthy);
}

function memoryUsage(stored: Record<string, { requests: number; background: number }> = {}) {
    const loads: string[] = [];
    const adds: [string, UsageRow[]][] = [];
    const store: UsageStore = {
        load: async (month) => {
            loads.push(month);
            return stored;
        },
        add: async (month, rows) => {
            adds.push([month, rows.map((row) => ({ ...row }))]);
        },
    };
    return { store, loads, adds };
}

describe("alarms", () => {
    it("all endpoints down alarms after 30 s", async () => {
        const t = setup();
        const refuse = () => {
            for (const ep of [t.a, t.b]) ep.answer(() => httpFail(401));
        };
        // A 401 opens an endpoint for 10 min
        refuse();
        await call(t.router, "getSlot").catch(() => undefined);
        const down = () => alarms(t, "rpc_all_endpoints_down");
        await tickAt(t, 0);
        await tickAt(t, 29_000);
        expect(down()).toEqual([]);
        await tickAt(t, 31_000);
        expect(down()).toEqual([
            alarm("rpc_all_endpoints_down", {
                role: "read",
                endpoints: [
                    { name: "rpc1", state: "open" },
                    { name: "rpc2", state: "open" },
                ],
            }),
        ]);
        await tickAt(t, 60_000);
        expect(down()).toHaveLength(1);

        // Three good probes 10 s apart close each breaker; the next tick sees them back
        t.a.answer(node(t.clock, "a"));
        t.b.answer(node(t.clock, "b"));
        for (const ms of [600_000, 610_000, 620_000, 625_000]) await tickAt(t, ms);
        expect(lines(t, "info", "rpc endpoints back")).toEqual([
            { level: "info", msg: "rpc endpoints back", role: "read" },
        ]);

        refuse();
        t.clock.ms = 700_000;
        await call(t.router, "getSlot").catch(() => undefined);
        await tickAt(t, 700_000);
        await tickAt(t, 729_000);
        expect(down()).toHaveLength(1);
        await tickAt(t, 731_000);
        expect(down()).toHaveLength(2);
    });

    it("one role down alone alarms with its name", async () => {
        const t = setup();
        for (const name of ["rpc1", "rpc2"]) setCheckState(t.router, name, { history: "missing" });
        await tickAt(t, 0);
        await tickAt(t, 31_000);
        expect(alarms(t, "rpc_all_endpoints_down")).toEqual([
            alarm("rpc_all_endpoints_down", {
                role: "history",
                endpoints: [
                    { name: "rpc1", state: "ok" },
                    { name: "rpc2", state: "ok" },
                ],
            }),
        ]);
    });

    it("429s without a success alarm rate_limited", async () => {
        const t = setup();
        const limited = () => alarms(t, "rpc_endpoint_down", { reason: "rate_limited" });
        const refuse = () => t.a.answer(() => httpFail(429, { "retry-after": "60" }));
        refuse();
        await call(t.router, "getSlot");
        await tickAt(t, 299_000);
        expect(limited()).toEqual([]);
        await tickAt(t, 301_000);
        expect(limited()).toEqual([
            alarm("rpc_endpoint_down", { endpoint: "rpc1", reason: "rate_limited" }),
        ]);
        for (const ms of [360_000, 420_000, 480_000]) {
            t.clock.ms = ms;
            await call(t.router, "getSlot");
            await t.router.tick();
        }
        expect(limited()).toHaveLength(1);

        // A success re-arms it, and a new run of 5 minutes alarms again
        t.a.answer(node(t.clock, "a"));
        t.clock.ms = 600_000;
        await call(t.router, "getSlot");
        await t.router.tick();
        refuse();
        t.clock.ms = 610_000;
        await call(t.router, "getSlot");
        await tickAt(t, 909_000);
        expect(limited()).toHaveLength(1);
        await tickAt(t, 911_000);
        expect(limited()).toHaveLength(2);
    });

    it("a quiet fallback with a spent cap alarms too", async () => {
        const t = setup();
        t.b.answer(() => httpFail(429));
        for (let ms = 0; ms <= 300_000; ms += 60_000) await tickAt(t, ms);
        await tickAt(t, 301_000);
        expect(t.b.calls.map((c) => c.method)).toEqual(Array(6).fill("getEpochInfo"));
        expect(alarms(t, "rpc_endpoint_down", { reason: "rate_limited" })).toEqual([
            alarm("rpc_endpoint_down", { endpoint: "rpc2", reason: "rate_limited" }),
        ]);
    });

    it("a quiet fallback whose probes answer JSON-RPC 429 alarms too", async () => {
        const t = setup();
        t.b.answer(() => rpcFail(429, "Too many requests"));
        // The service's tick, every 5 s
        for (let ms = 0; ms <= 300_000; ms += 5_000) await tickAt(t, ms);
        await tickAt(t, 301_000);
        expect(alarms(t, "rpc_endpoint_down", { reason: "rate_limited" })).toEqual([
            alarm("rpc_endpoint_down", { endpoint: "rpc2", reason: "rate_limited" }),
        ]);
        expect(snap(t, "rpc2").limits["*"]).toBe(1);
    });

    for (const [status, reason] of [
        [401, "auth"],
        [402, "http_402"],
        [403, "http_403"],
    ] as const) {
        it(`a quiet fallback whose probes get ${status} opens and alarms once`, async () => {
            const t = setup();
            t.b.answer(() => httpFail(status));
            for (let ms = 0; ms <= 600_000; ms += 5_000) await tickAt(t, ms);
            expect(alarms(t, "rpc_endpoint_down", { endpoint: "rpc2" })).toEqual([
                alarm("rpc_endpoint_down", { endpoint: "rpc2", reason, status }),
            ]);
            expect(snap(t, "rpc2").state).toBe("open");
        });
    }

    it("an endpoint whose probes fail is probed once per probe_every", async () => {
        for (const fail of [() => netFail("ECONNREFUSED"), () => httpFail(503)]) {
            const t = setup();
            t.b.answer(fail);
            for (let ms = 0; ms <= 600_000; ms += 5_000) await tickAt(t, ms);
            // At 0, 60 s, ... 600 s, as for an endpoint that answers (spec 13.3)
            expect(t.b.calls).toHaveLength(11);
        }
    });

    it("the lag alarm waits 2 minutes", async () => {
        const t = setup();
        const behind = node(t.clock, "a", {
            getSlot: () => rpcOk(slotAt(t.clock.ms) - 60n),
            getEpochInfo: () => {
                const slot = slotAt(t.clock.ms) - 60n;
                return rpcOk(epochAt(slot - 100n, slot));
            },
        });
        t.a.answer(behind);
        const lag = () => alarms(t, "rpc_endpoint_lag");
        // rpc2 answers first each time, so rpc1's lag has a fresh reference
        const at = async (ms: number) => {
            t.clock.ms = ms;
            await call(t.router, "getSlot", CONFIRMED);
            await t.router.tick();
        };
        await via(t, "rpc2", () => call(t.router, "getSlot", CONFIRMED));
        for (let ms = 0; ms <= 115_000; ms += 5_000) await at(ms);
        expect(snap(t, "rpc1").lag).toBe(60);
        await at(119_000);
        expect(lag()).toEqual([]);
        await at(121_000);
        expect(lag()).toEqual([alarm("rpc_endpoint_lag", { endpoint: "rpc1", lagSlots: 60 })]);
        await at(200_000);
        expect(lag()).toHaveLength(1);
    });

    it("a dead endpoint raises no lag alarm for the live one", async () => {
        const t = setup();
        t.a.answer(() => rpcOk(1_000n));
        await call(t.router, "getSlot", CONFIRMED);
        t.a.answer(() => netFail());
        t.b.answer(() => rpcOk(1_000n + BigInt(Math.floor(t.clock.ms / 420))));
        for (let ms = 5_000; ms <= 30 * 60_000; ms += 5_000) {
            t.clock.ms = ms;
            await call(t.router, "getSlot", CONFIRMED);
            await t.router.tick();
        }
        expect(snap(t, "rpc2").lag).toBe(0);
        expect(alarms(t, "rpc_endpoint_lag", { endpoint: "rpc2" })).toEqual([]);
    });
});

describe("usage", () => {
    it("a failed usage store is one warn", async () => {
        const fail = () => Promise.reject(new Error("relation rpc_usage does not exist"));
        const t = setup({ passed: false, more: { usage: { load: fail, add: fail } } });
        await t.router.start({ timers: false });
        await tickAt(t, 60_000);
        await t.router.stop();
        const warn = { level: "warn", msg: "rpc usage not stored", err: expect.any(Error) };
        expect(lines(t, "warn", "rpc usage not stored")).toEqual([warn, warn, warn]);
        expect(lines(t, "warn", "rpc tick failed")).toEqual([]);
    });

    it("a failed flush keeps its counts for the next one", async () => {
        const { store, adds } = memoryUsage();
        let refuse = true;
        const usage: UsageStore = {
            load: store.load,
            add: (month, rows) =>
                refuse ? Promise.reject(new Error("timeout")) : store.add(month, rows),
        };
        const t = setup({ at: NOV, more: { usage } });
        setCheckState(t.router, "rpc2", { genesis: "error" });
        // Fresh marks on rpc1, so the tick sends no probe
        t.clock.ms = NOV + 30_000;
        await call(t.router, "getEpochInfo", CONFIRMED);
        await tickAt(t, NOV + 60_000);
        expect(lines(t, "warn", "rpc usage not stored")).toHaveLength(1);
        refuse = false;
        await call(t.router, "getSlot", CONFIRMED);
        await t.router.stop();
        expect(adds).toEqual([["2026-11", [{ endpoint: "rpc1", requests: 2, background: 0 }]]]);
    });

    it("usage is flushed every minute and at stop", async () => {
        const { store, adds } = memoryUsage();
        const t = setup({ at: NOV, more: { usage: store } });
        setCheckState(t.router, "rpc2", { genesis: "error" });
        // Calls 30 s before the flush keep rpc1's marks fresh, so the tick sends no probe
        t.clock.ms = NOV + 30_000;
        await call(t.router, "getEpochInfo", CONFIRMED);
        await call(t.router, "getSlot", CONFIRMED);
        await call(t.router.background, "getBalance", ["addr"]);
        await tickAt(t, NOV + 59_999);
        expect(adds).toEqual([]);
        await tickAt(t, NOV + 60_000);
        expect(adds).toEqual([["2026-11", [{ endpoint: "rpc1", requests: 3, background: 1 }]]]);
        await call(t.router, "getSlot", CONFIRMED);
        await call(t.router, "getSlot", CONFIRMED);
        await t.router.stop();
        expect(adds.slice(1)).toEqual([
            ["2026-11", [{ endpoint: "rpc1", requests: 2, background: 0 }]],
        ]);
    });

    it("month counts load at start", async () => {
        const { store, loads } = memoryUsage({ rpc1: { requests: 9, background: 2 } });
        const t = setup({ at: NOV, passed: false, more: { usage: store } });
        await t.router.start({ timers: false });
        expect(loads).toEqual(["2026-11"]);
        // The start's checks are this month's requests too, all on the background lane
        expect(t.a.calls.length).toBeGreaterThan(0);
        expect(snap(t, "rpc1")).toMatchObject({
            monthRequests: 9 + t.a.calls.length,
            monthBackground: 2 + t.a.calls.length,
        });
        expect(snap(t, "rpc2")).toMatchObject({
            monthRequests: t.b.calls.length,
            monthBackground: t.b.calls.length,
        });
    });

    it("single mode stores usage and the snapshot too", async () => {
        const { store, adds } = memoryUsage();
        const written: RouterSnapshot[] = [];
        const eps = [fakeEndpoint("a")];
        const deps = testDeps(eps, {
            usage: store,
            snapshots: { write: async (s) => void written.push(s) },
        });
        deps.clock.ms = NOV;
        eps[0]!.answer(node(deps.clock, "a"));
        const router = createRouterTransport(testRpcSettings(), deps.urls, deps);
        onTestFinished(() => router.stop());
        await call(router, "getSlot");
        deps.clock.ms = NOV + 60_000;
        await router.tick();
        expect(adds).toEqual([["2026-11", [{ endpoint: "rpc1", requests: 1, background: 0 }]]]);
        expect(written.map((s) => s.mode)).toEqual(["single"]);
        expect(eps[0]!.calls).toHaveLength(1);
    });
});

describe("lanes", () => {
    it("with no background room anywhere a background read fails and a send goes through", async () => {
        const t = setup();
        await teach(t, t.b, "rpc2", 13);
        await teach(t, t.a, "rpc1", 13);
        expect(snap(t, "rpc1").limits).toEqual({ "*": 10 });
        expect(snap(t, "rpc2").limits).toEqual({ "*": 10 });
        t.clock.ms = 11_000;
        for (let i = 0; i < 6; i++) await call(t.router.background, "getSlot");
        await via(t, "rpc2", async () => {
            for (let i = 0; i < 6; i++) await call(t.router.background, "getSlot");
        });
        const before = [t.a.calls.length, t.b.calls.length];
        const e = await rejection(call(t.router.background, "getSlot"));
        expect(reasonOf(e)).toBe("no_endpoint");
        expect(t.clock.ms - 11_000).toBeLessThanOrEqual(1_000);
        expect([t.a.calls.length, t.b.calls.length]).toEqual(before);
        const waited = t.clock.ms;
        expect(await send(t)).toEqual(rpcOk("a-signature"));
        expect(t.a.calls[before[0]!]!.method).toBe("sendTransaction");
        expect(t.clock.ms).toBe(waited);
    });
});

describe("snapshot", () => {
    it("every HTTP request is counted", async () => {
        const t = setup();
        const healthy = node(t.clock, "a");
        const fakes = () => t.a.calls.length + t.b.calls.length;
        // A read with a failover
        t.a.answer(node(t.clock, "a", { getSlot: () => netFail() }));
        await call(t.router, "getSlot");
        // An absence check: a null on rpc1 is asked of rpc2
        t.a.answer(
            node(t.clock, "a", {
                getSignatureStatuses: () => statusesAnswer(slotAt(t.clock.ms), [null]),
            }),
        );
        await call(t.router, "getSignatureStatuses", [
            ["sig1"],
            { searchTransactionHistory: true },
        ]);
        // A cursor never seen is proven by its status first
        t.a.answer(healthy);
        await call(t.router, "getSignaturesForAddress", ["addr", { before: "sig0", limit: 10 }]);
        // A null transaction is asked once more on the other domain
        t.a.answer(node(t.clock, "a", { getTransaction: () => rpcOk(null) }));
        await call(t.router, "getTransaction", ["sig2", { commitment: "confirmed" }]);
        t.a.answer(healthy);
        // A send and its copy
        await send(t);
        // The tick's probes
        await t.router.tick();
        const methods = (ep: FakeEndpoint) => ep.calls.map((c) => c.method);
        expect(methods(t.b)).toEqual(
            expect.arrayContaining([
                "getSlot",
                "getSignatureStatuses",
                "getTransaction",
                "sendTransaction",
            ]),
        );
        expect(methods(t.a).filter((m) => m === "getSignatureStatuses")).toHaveLength(2);
        expect(methods(t.a)).toContain("getEpochInfo");
        const counted = t.router.snapshot().endpoints.reduce((n, e) => n + e.hourRequests, 0);
        expect(counted).toBe(fakes());
    });

    it("outcomes are counted per method", async () => {
        const t = setup();
        let n = 0;
        t.a.answer(node(t.clock, "a", { getSlot: () => (++n === 3 ? httpFail(429) : rpcOk(5n)) }));
        for (let i = 0; i < 3; i++) await call(t.router, "getSlot");
        expect(snap(t, "rpc1").outcomes.getSlot).toEqual({ ok: 2, http_429: 1 });
    });

    it("the snapshot shows the serving endpoint and the learned limits", async () => {
        const t = setup();
        expect(t.router.snapshot()).toMatchObject({
            mode: "routed",
            serving: "rpc1",
            domains: 2,
            absenceQuorum: 2,
            sendFanout: 1,
        });
        let n = 0;
        const healthy = node(t.clock, "a");
        t.a.answer((method, params, p) =>
            ++n === 11 ? httpFail(429, { "retry-after": "10" }) : healthy(method, params, p),
        );
        for (let i = 0; i < 11; i++) await call(t.router, "getSlot");
        expect(snap(t, "rpc1")).toMatchObject({ state: "cooling", limits: { "*": 8 } });
        expect(t.router.snapshot().serving).toBe("rpc2");
        t.clock.ms = 11_000;
        expect(t.router.snapshot().serving).toBe("rpc1");
    });

    it("the snapshot holds no URL or host", async () => {
        const urls = [
            "https://one.x.example/?api-key=KEYKEYKEY1",
            "https://two.b.example/v2/KEYKEYKEY2",
        ];
        const t = setup({ more: { urls } });
        const failures: FakeHandler[] = [
            () => netFail(),
            () => netFail("ECONNREFUSED"),
            () => httpFail(429, { "retry-after": "5" }),
            () => httpFail(503),
            () => rpcFail(-32005, "Node is behind", { numSlotsBehind: 99n }),
            () => rpcFail(35, "upstream https://one.x.example/ said no"),
            () => httpFail(403),
        ];
        // a.example is the host a failed fetch's cause names (netFail)
        const parts = [
            ...urls,
            "one.x.example",
            "two.b.example",
            "x.example",
            "b.example",
            "a.example",
            "KEYKEYKEY",
            "upstream",
        ];
        // Each failure in turn, since lastError keeps only the latest
        for (const fail of failures) {
            t.a.answer(fail);
            await call(t.router, "getSlot", CONFIRMED).catch(() => undefined);
            t.clock.ms += 6_000;
            await t.router.tick();
            const text = JSON.stringify(t.router.snapshot());
            for (const part of parts) expect(text).not.toContain(part);
            expect(snap(t, "rpc1").lastError).not.toBeNull();
        }
    });

    it("the snapshot is written every 15 s", async () => {
        const written: RouterSnapshot[] = [];
        const t = setup({ more: { snapshots: { write: async (s) => void written.push(s) } } });
        await tickAt(t, 14_999);
        expect(written).toEqual([]);
        await tickAt(t, 15_000);
        await tickAt(t, 29_999);
        await tickAt(t, 30_000);
        expect(written.map((s) => s.at)).toEqual([15_000, 30_000]);
        expect(written[0]!.endpoints.map((e) => e.name)).toEqual(["rpc1", "rpc2"]);
    });

    it("a failed snapshot store warns once until it works again", async () => {
        let refuse = true;
        const t = setup({
            more: {
                snapshots: {
                    write: () =>
                        refuse ? Promise.reject(new Error("timeout")) : Promise.resolve(),
                },
            },
        });
        for (const ms of [15_000, 30_000, 45_000]) await tickAt(t, ms);
        refuse = false;
        await tickAt(t, 60_000);
        refuse = true;
        await tickAt(t, 75_000);
        const warn = { level: "warn", msg: "rpc snapshot not stored", err: expect.any(Error) };
        expect(lines(t, "warn", "rpc snapshot not stored")).toEqual([warn, warn]);
    });
});
