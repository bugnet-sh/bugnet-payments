import { createHash } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { epochAt } from "../../testing/fake-rpc.ts";
import type { VerdictRow, VerdictStore } from "./consistency.ts";
import { RpcRouterError } from "./errors.ts";
import { isObject } from "./payload.ts";
import {
    CHECK_REPEATS,
    CHECK_TOTAL_MS,
    type CheckReport,
    checkEndpoint,
    type EndpointCheck,
    type HistoryProbe,
    MAINNET_GENESIS,
    MAINNET_HISTORY_PROBE,
    USDC_MINT_ADDRESS,
} from "./probe.ts";
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
    testUrls,
} from "./testing.ts";
import {
    createRouterTransport,
    type EndpointSnapshot,
    type RouterDeps,
    type RouterTransport,
    setCheckState,
} from "./transport.ts";

const LABELS = ["a", "b", "c"];
const PROBE: HistoryProbe = { address: "recipient-ata", oldest: "oldest-sig", later: "later-sig" };
const KNOWN = new Set([MAINNET_HISTORY_PROBE.signature, PROBE.oldest, PROBE.later]);
const TX = {
    slot: 900n,
    blockTime: null,
    meta: { err: null, fee: 5000n, preTokenBalances: [], postTokenBalances: [] },
    transaction: ["AAAA", "base64"],
};
const HOUR = 3_600_000;
const HISTORY = new Set(["getSignatureStatuses", "getTransaction"]);
const TRANSACTION = [PROBE.oldest, { commitment: "confirmed", encoding: "base64" }];
const LISTING = ["addr", { commitment: "confirmed", minContextSlot: 900n }];
const PINNED_READ = [["key1"], { commitment: "confirmed", minContextSlot: 900n }];

function noHistory(): unknown {
    return rpcFail(-32011, "Transaction history is not available from this node");
}

// At the clock's slot, so the answer moves no mark back
function notFound(t: Setup): unknown {
    return statusesAnswer(slotAt(t.clock.ms), [null]);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultOf(answer: unknown): unknown {
    return (answer as { result: unknown }).result;
}

function slotAt(ms: number): bigint {
    return 1_000n + BigInt(Math.floor(ms / 400));
}

function optionsOf(params: readonly unknown[]): Record<string, unknown> {
    const last = params.at(-1);
    return isObject(last) ? last : {};
}

function pinOf(params: readonly unknown[]): bigint | null {
    const pin = optionsOf(params).minContextSlot;
    return typeof pin === "bigint" ? pin : null;
}

// A mainnet node with full history at slot(): it refuses a pin past its slot, and finds only the
// history probes' signatures
function node(label: string, slot: () => bigint, over: Record<string, FakeHandler> = {}) {
    const handler: FakeHandler = (method, params, payload) => {
        const own = over[method];
        if (own !== undefined) return own(method, params, payload);
        const at = slot();
        const pin = pinOf(params);
        if (pin !== null && pin > at) {
            return rpcFail(-32016, "Minimum context slot has not been reached", {
                contextSlot: at,
            });
        }
        switch (method) {
            case "getGenesisHash":
                return rpcOk(MAINNET_GENESIS);
            case "getEpochInfo":
                return rpcOk(epochAt(at - 100n, at));
            case "getIdentity":
                return rpcOk({ identity: `node-${label}` });
            case "getSlot":
                return rpcOk(at);
            case "getSignatureStatuses": {
                const [first] = params[0] as string[];
                return statusesAnswer(at, [KNOWN.has(first!) ? S(500n, "finalized") : null]);
            }
            case "getTransaction":
                return rpcOk(KNOWN.has(params[0] as string) ? TX : null);
            case "getSignaturesForAddress":
                return rpcOk(
                    optionsOf(params).before === PROBE.later
                        ? [{ signature: "x" }, { signature: PROBE.oldest }]
                        : [],
                );
            default:
                return rpcOk({ context: { slot: at }, value: null });
        }
    };
    return handler;
}

// The node's answers, with fn answering first; n counts that method's calls from here on, and
// undefined leaves the call to the node
function tweak(
    t: Setup,
    ep: FakeEndpoint,
    fn: (method: string, params: readonly unknown[], n: number) => unknown,
): void {
    const own = node(ep.label, () => slotAt(t.clock.ms));
    const counts = new Map<string, number>();
    ep.answer((method, params, payload) => {
        const n = counts.get(method) ?? 0;
        counts.set(method, n + 1);
        return fn(method, params, n) ?? own(method, params, payload);
    });
}

function direct(over: Record<string, FakeHandler> = {}): FakeEndpoint {
    return fakeEndpoint(
        "a",
        node("a", () => 500n, over),
    );
}

function run(ep: FakeEndpoint, probe: HistoryProbe | null = PROBE): Promise<EndpointCheck> {
    return checkEndpoint(ep.transport, "rpc1", probe, {
        timeoutMs: 200,
        now: () => 0,
        genesisOnly: false,
    });
}

interface Setup extends TestDeps {
    router: RouterTransport;
    a: FakeEndpoint;
    b: FakeEndpoint;
    c: FakeEndpoint;
}

function routed(
    n: number,
    over: Partial<RpcSettings> = {},
    more: Partial<RouterDeps> & { urls?: string[] } = {},
): Setup {
    const eps = LABELS.slice(0, n).map((label) => fakeEndpoint(label));
    const deps = testDeps(eps, { historyProbe: () => Promise.resolve(PROBE), ...more });
    eps.forEach((ep) => ep.answer(node(ep.label, () => slotAt(deps.clock.ms))));
    const router = createRouterTransport(testRpcSettings(over), deps.urls, deps);
    onTestFinished(() => router.stop());
    const at = (i: number) => eps[i] ?? fakeEndpoint(`unused ${LABELS[i]}`);
    return { ...deps, router, a: at(0), b: at(1), c: at(2) };
}

// The service's start, then the rest of each run, which goes on in the background
async function boot(t: Setup): Promise<void> {
    await t.router.start({ timers: true });
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

async function tickAt(t: Setup, ms: number): Promise<void> {
    t.clock.ms = ms;
    await t.router.tick();
}

function snap(t: Setup, name: string): EndpointSnapshot {
    return t.router.snapshot().endpoints.find((e) => e.name === name)!;
}

function lines(t: Setup, level: string, msg?: string): Record<string, unknown>[] {
    return t.log.lines.filter((l) => l.level === level && (msg === undefined || l.msg === msg));
}

function methods(ep: FakeEndpoint): string[] {
    return ep.calls.map((c) => c.method);
}

function historyCalls(ep: FakeEndpoint): number {
    return ep.calls.filter((c) => HISTORY.has(c.method)).length;
}

function pinnedCalls(ep: FakeEndpoint): number {
    return ep.calls.filter((c) => pinOf(c.params) !== null).length;
}

function call(t: Setup, method: string, params: unknown[] = []): Promise<unknown> {
    return t.router({ payload: { jsonrpc: "2.0", id: 1n, method, params } });
}

async function reaches(t: Setup, method: string, params: unknown[] = []): Promise<string[]> {
    const before = [t.a, t.b, t.c].map((ep) => ep.calls.length);
    await call(t, method, params);
    return [t.a, t.b, t.c].filter((ep, i) => ep.calls.length > before[i]!).map((ep) => ep.label);
}

async function rejection(answer: Promise<unknown>): Promise<RpcRouterError> {
    try {
        await answer;
    } catch (e) {
        expect(e).toBeInstanceOf(RpcRouterError);
        return e as RpcRouterError;
    }
    throw new Error("The call did not reject");
}

function memoryVerdicts(): VerdictStore & { rows: Map<string, VerdictRow> } {
    const rows = new Map<string, VerdictRow>();
    return {
        rows,
        load: () => Promise.resolve([...rows.values()]),
        save: (row) => {
            rows.set(row.fingerprint, row);
            return Promise.resolve();
        },
    };
}

function fingerprint(url: string): string {
    return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

describe("checkEndpoint", () => {
    it("a mainnet endpoint passes", async () => {
        expect(await run(direct())).toEqual({
            name: "rpc1",
            genesis: "ok",
            genesisError: null,
            pinnedAccounts: "ok",
            pinnedSignatures: "ok",
            history: "ok",
            repeatsAgree: true,
            identity: "node-a",
            slot: 500n,
            latencyMs: 0,
        });
    });

    it("the pinned probes use a slot far ahead at both commitments", async () => {
        const ep = direct();
        await run(ep);
        const pinned = (method: string) =>
            ep.calls.filter((c) => c.method === method && pinOf(c.params) !== null);
        expect(pinned("getAccountInfo").map((c) => c.params)).toEqual([
            [USDC_MINT_ADDRESS, { encoding: "jsonParsed", minContextSlot: 1_000_500n }],
            [
                USDC_MINT_ADDRESS,
                { encoding: "jsonParsed", commitment: "confirmed", minContextSlot: 1_000_500n },
            ],
        ]);
        expect(pinned("getSignaturesForAddress").map((c) => c.params)).toEqual([
            [USDC_MINT_ADDRESS, { minContextSlot: 1_000_500n, limit: 1 }],
            [USDC_MINT_ADDRESS, { commitment: "confirmed", minContextSlot: 1_000_500n, limit: 1 }],
        ]);
    });

    it("the history probe pins the transaction version", async () => {
        const ep = direct();
        await run(ep);
        const sent = ep.calls.filter((c) => c.method === "getTransaction").map((c) => c.params);
        expect(sent).toEqual(
            Array(CHECK_REPEATS).fill([
                PROBE.oldest,
                { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
            ]),
        );
    });

    it("a short address index is missing", async () => {
        const page: FakeHandler = (_m, params) =>
            pinOf(params) === null
                ? rpcOk([{ signature: "x" }, { signature: "y" }])
                : rpcFail(-32016, "Minimum context slot has not been reached");
        const c = await run(direct({ getSignaturesForAddress: page }));
        expect(c).toMatchObject({ history: "missing", repeatsAgree: true });
    });

    it("a full address page is inconclusive", async () => {
        const full = Array.from({ length: 1_000 }, (_, i) => ({ signature: `s${i}` }));
        const page: FakeHandler = (_m, params) =>
            pinOf(params) === null
                ? rpcOk(full)
                : rpcFail(-32016, "Minimum context slot has not been reached");
        const c = await run(direct({ getSignaturesForAddress: page }));
        expect(c).toMatchObject({ history: "ok", pinnedSignatures: "ok" });
    });

    it("no payment yet uses the mainnet probe", async () => {
        const ep = direct();
        expect((await run(ep, null)).history).toBe("ok");
        const signatures = ep.calls
            .filter((c) => HISTORY.has(c.method))
            .map((c) =>
                c.method === "getTransaction" ? c.params[0] : (c.params[0] as string[])[0],
            );
        expect(signatures).toEqual(Array(2 * CHECK_REPEATS).fill(MAINNET_HISTORY_PROBE.signature));
        const pages = ep.calls.filter(
            (c) => c.method === "getSignaturesForAddress" && pinOf(c.params) === null,
        );
        expect(pages).toEqual([]);
    });
});

function alarm(endpoint: string, reason: string, more: Record<string, unknown> = {}) {
    const name = "rpc_endpoint_down";
    return { level: "alarm", msg: name, alarm: name, endpoint, reason, ...more };
}

function ignoring(t: Setup, ep: FakeEndpoint, method: string): void {
    tweak(t, ep, (m, params) => {
        if (m !== method || pinOf(params) === null) return undefined;
        const slot = slotAt(t.clock.ms);
        return rpcOk(m === "getAccountInfo" ? { context: { slot }, value: null } : []);
    });
}

describe("boot checks", () => {
    it("a devnet endpoint stops the start", async () => {
        const t = routed(2);
        const devnet = () => rpcOk("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
        tweak(t, t.a, (m) => (m === "getGenesisHash" ? devnet() : undefined));
        const e = await rejection(t.router.start({ timers: true }));
        expect(e.reason).toBe("wrong_network");
        expect(e.endpoint).toBe("rpc1");
        expect(snap(t, "rpc1").state).toBe("wrong_network");
    });

    it("every endpoint repeats each history call 3 times", async () => {
        const t = routed(2);
        const most = [0, 0];
        [t.a, t.b].forEach((ep, i) => {
            const own = node(ep.label, () => slotAt(t.clock.ms));
            let running = 0;
            ep.answer(async (method, params, payload) => {
                running += 1;
                most[i] = Math.max(most[i]!, running);
                await new Promise((r) => setImmediate(r));
                running -= 1;
                return own(method, params, payload);
            });
        });
        await t.router.start({ timers: false });
        expect(most).toEqual([1, 1]);
        for (const ep of [t.a, t.b]) {
            expect(methods(ep)).toEqual([
                "getGenesisHash",
                "getEpochInfo",
                "getIdentity",
                "getAccountInfo",
                "getAccountInfo",
                "getSignaturesForAddress",
                "getSignaturesForAddress",
                ...Array(CHECK_REPEATS).fill("getSignatureStatuses"),
                ...Array(CHECK_REPEATS).fill("getTransaction"),
                "getSignaturesForAddress",
            ]);
        }
    });

    it("the boot checks set the floors", async () => {
        const t = routed(2);
        t.a.answer(node("a", () => 500n));
        t.b.answer(
            node("b", () => 380n, {
                // a's slot read is in first
                getGenesisHash: () => delay(5).then(() => rpcOk(MAINNET_GENESIS)),
                getEpochInfo: () => rpcOk(epochAt(300n, 380n)),
            }),
        );
        await t.router.start({ timers: false });
        expect(snap(t, "rpc2")).toMatchObject({ state: "lagging", lag: 120 });
        // The confirmed height high water of 400 puts the floor at 350 for every commitment below
        const processed = [{ commitment: "processed" }];
        t.a.answer(node("a", () => 500n, { getBlockHeight: () => rpcOk(349n) }));
        expect((await rejection(call(t, "getBlockHeight", processed))).reason).toBe("stale");
        t.a.answer(node("a", () => 500n, { getBlockHeight: () => rpcOk(350n) }));
        expect(resultOf(await call(t, "getBlockHeight", processed))).toBe(350n);
    });

    it("the service start waits only for genesis and the slot read", async () => {
        const t = routed(2, { attempt_timeout: 30_000 });
        tweak(t, t.b, (m) =>
            m === "getGenesisHash" || m === "getEpochInfo" ? undefined : stall(),
        );
        await t.router.start({ timers: true });
        // Its identity call is still waiting
        expect(methods(t.b)).toEqual(["getGenesisHash", "getEpochInfo", "getIdentity"]);
        expect(snap(t, "rpc2")).toMatchObject({
            state: "ok",
            roles: ["read", "send"],
            checks: { genesis: "ok", history: "unchecked" },
        });
        await t.router.stop();
        expect(snap(t, "rpc2")).toMatchObject({
            roles: ["read", "send"],
            checks: { history: "error" },
        });
    });

    it("the CLI start waits for the whole run, at most 20 s", async () => {
        const t = routed(2, { attempt_timeout: 30_000 });
        tweak(t, t.b, (m) =>
            m === "getGenesisHash" || m === "getEpochInfo" ? undefined : stall(),
        );
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const reports: CheckReport[] = [];
            const started = t.router.start({ timers: false }).then((r) => reports.push(r));
            await vi.advanceTimersByTimeAsync(CHECK_TOTAL_MS - 1);
            expect(reports).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            await started;
            expect(reports[0]!.endpoints.map((c) => c.history)).toEqual(["ok", "error"]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a stalled endpoint skips its remaining checks", async () => {
        const t = routed(2);
        tweak(t, t.b, (m) => (m === "getAccountInfo" ? stall() : undefined));
        const report = await t.router.check();
        expect(methods(t.b)).toEqual([
            "getGenesisHash",
            "getEpochInfo",
            "getIdentity",
            "getAccountInfo",
        ]);
        expect(report.endpoints[1]).toMatchObject({
            pinnedAccounts: "error",
            pinnedSignatures: "error",
            history: "error",
            repeatsAgree: null,
        });
    });

    it("endpoints that report one identity count as one domain", async () => {
        const t = routed(3);
        for (const ep of [t.a, t.b]) {
            tweak(t, ep, (m) =>
                m === "getIdentity" ? rpcOk({ identity: "node-shared" }) : undefined,
            );
        }
        await t.router.start({ timers: false });
        expect(lines(t, "warn")).toEqual([
            { level: "warn", msg: "rpc endpoints share a node", endpoints: ["rpc1", "rpc2"] },
        ]);
        tweak(t, t.c, (m) => (m === "getSignatureStatuses" ? netFail() : undefined));
        const asked = (ep: FakeEndpoint) =>
            ep.calls.filter((c) => c.method === "getSignatureStatuses").length;
        const before = [asked(t.b), asked(t.c)];
        const read = call(t, "getSignatureStatuses", [
            ["missing-sig"],
            { searchTransactionHistory: true },
        ]);
        expect((await rejection(read)).reason).toBe("absence_unconfirmed");
        expect([asked(t.b), asked(t.c)]).toEqual([before[0], before[1]! + 1]);
    });

    // rpc1 and rpc2 report one node; rpc3 is on its own
    async function sharing(): Promise<Setup> {
        const t = routed(3);
        for (const ep of [t.a, t.b]) {
            tweak(t, ep, (m) =>
                m === "getIdentity" ? rpcOk({ identity: "node-shared" }) : undefined,
            );
        }
        await t.router.start({ timers: false });
        return t;
    }

    it("a null transaction is asked again of another node, not of the one it shares", async () => {
        const t = await sharing();
        tweak(t, t.a, (m) => (m === "getTransaction" ? rpcOk(null) : undefined));
        expect(await reaches(t, "getTransaction", TRANSACTION)).toEqual(["a", "c"]);
    });

    it("a send copy never goes to an endpoint that shares the node", async () => {
        const t = await sharing();
        const sends = (ep: FakeEndpoint) =>
            ep.calls.filter((c) => c.method === "sendTransaction").length;
        await call(t, "sendTransaction", ["AQID", { encoding: "base64" }]);
        await new Promise((r) => setImmediate(r));
        expect([t.a, t.b, t.c].map(sends)).toEqual([1, 0, 1]);
    });
});

describe("pinned checks", () => {
    it("an endpoint that ignores minContextSlot on scans is marked", async () => {
        const t = routed(2);
        ignoring(t, t.a, "getSignaturesForAddress");
        const report = await t.router.start({ timers: false });
        expect(report.endpoints[0]).toMatchObject({
            pinnedAccounts: "ok",
            pinnedSignatures: "ignored",
        });
        expect(await reaches(t, "getSignaturesForAddress", LISTING)).toEqual(["b"]);
        expect(await reaches(t, "getMultipleAccounts", PINNED_READ)).toEqual(["a"]);
        expect(lines(t, "alarm")).toEqual([alarm("rpc1", "min_context_slot_ignored")]);
    });

    it("ignoring minContextSlot on accounts only alarms", async () => {
        const t = routed(2);
        ignoring(t, t.a, "getAccountInfo");
        const report = await t.router.start({ timers: false });
        expect(report.endpoints[0]).toMatchObject({
            pinnedAccounts: "ignored",
            pinnedSignatures: "ok",
        });
        expect(lines(t, "alarm")).toEqual([alarm("rpc1", "min_context_slot_ignored")]);
        expect(await reaches(t, "getMultipleAccounts", PINNED_READ)).toEqual(["a"]);
        expect(await reaches(t, "getSignaturesForAddress", LISTING)).toEqual(["a"]);
    });

    it("an inconsistent endpoint's ignored pinned check raises no alarm", async () => {
        const t = routed(2);
        const own = node("a", () => slotAt(t.clock.ms));
        let statuses = 0;
        t.a.answer((method, params, payload) => {
            if (method === "getSignaturesForAddress" && pinOf(params) !== null) return rpcOk([]);
            if (method === "getSignatureStatuses" && statuses++ === 1) return notFound(t);
            return own(method, params, payload);
        });
        const report = await t.router.start({ timers: false });
        expect(report.endpoints[0]).toMatchObject({
            pinnedSignatures: "ignored",
            repeatsAgree: false,
        });
        expect(snap(t, "rpc1").consistent).toBe("no");
        expect(lines(t, "alarm")).toEqual([]);
    });
});

describe("history checks", () => {
    it("an endpoint without history loses the role and warns", async () => {
        const t = routed(2);
        tweak(t, t.a, (m) => (m === "getSignatureStatuses" ? notFound(t) : undefined));
        const report = await t.router.start({ timers: false });
        expect(report.endpoints[0]).toMatchObject({ history: "missing", repeatsAgree: true });
        expect(snap(t, "rpc1").roles).toEqual(["read", "send"]);
        expect(await reaches(t, "getTransaction", TRANSACTION)).toEqual(["b"]);
        expect(lines(t, "warn")).toEqual([
            { level: "warn", msg: "rpc endpoint has no history", endpoint: "rpc1" },
        ]);
        expect(lines(t, "alarm")).toEqual([]);
    });

    it("-32011 history is missing, not error", async () => {
        const t = routed(2);
        tweak(t, t.a, (m, params) =>
            HISTORY.has(m) || (m === "getSignaturesForAddress" && pinOf(params) === null)
                ? noHistory()
                : undefined,
        );
        const report = await t.router.start({ timers: false });
        expect(report.endpoints[0]).toMatchObject({ history: "missing", repeatsAgree: true });
        expect(lines(t, "warn")).toEqual([
            { level: "warn", msg: "rpc endpoint has no history", endpoint: "rpc1" },
        ]);
        const atStart = historyCalls(t.a);
        await tickAt(t, 60_000);
        expect(historyCalls(t.a)).toBe(atStart);
        await tickAt(t, HOUR);
        expect(historyCalls(t.a)).toBe(atStart + 2 * CHECK_REPEATS);
    });

    it("-32011 mixed with found disagrees", async () => {
        const t = routed(2);
        tweak(t, t.a, (m, _p, n) =>
            m === "getSignatureStatuses" && n === 1 ? noHistory() : undefined,
        );
        const report = await t.router.start({ timers: false });
        expect(report.endpoints[0]).toMatchObject({ history: "ok", repeatsAgree: false });
        expect(snap(t, "rpc1").consistent).toBe("no");
    });

    it("missing waits for the hourly run", async () => {
        const t = routed(2);
        tweak(t, t.a, (m, params) => {
            if (m === "getSignatureStatuses") return notFound(t);
            if (m !== "getAccountInfo" || pinOf(params) === null) return undefined;
            return rpcOk({ context: { slot: slotAt(t.clock.ms) }, value: null });
        });
        const report = await t.router.start({ timers: false });
        expect(report.endpoints[0]).toMatchObject({
            history: "missing",
            pinnedAccounts: "ignored",
        });
        const counts = () => [historyCalls(t.a), pinnedCalls(t.a)];
        const atStart = counts();
        await tickAt(t, 60_000);
        expect(counts()).toEqual(atStart);
        await tickAt(t, HOUR);
        expect(counts()).toEqual([atStart[0]! + 2 * CHECK_REPEATS, atStart[1]! + 4]);
    });

    it("an errored check backs off", async () => {
        const t = routed(2);
        const storage = () => rpcFail(-32019, "Failed to query long-term storage");
        tweak(t, t.a, (m) => (m === "getTransaction" ? storage() : undefined));
        await boot(t);
        expect(snap(t, "rpc1").checks.history).toBe("error");
        const ticks: number[] = [];
        for (let ms = 60_000; ms <= 4 * HOUR; ms += 60_000) {
            const before = historyCalls(t.a);
            await tickAt(t, ms);
            if (historyCalls(t.a) > before) ticks.push(ms);
        }
        // probe_every doubling from 60 s, then the hourly run alone once the wait reaches an hour
        expect(ticks).toEqual([
            60_000,
            180_000,
            420_000,
            900_000,
            1_860_000,
            HOUR,
            2 * HOUR,
            3 * HOUR,
            4 * HOUR,
        ]);
    });

    it("history lost after passing alarms", async () => {
        const t = routed(2);
        await t.router.start({ timers: false });
        tweak(t, t.a, (m) => (m === "getSignatureStatuses" ? notFound(t) : undefined));
        await tickAt(t, HOUR);
        expect(snap(t, "rpc1").checks.history).toBe("missing");
        expect(lines(t, "alarm")).toEqual([alarm("rpc1", "history_missing")]);
    });

    it("disagreeing repeats mark the endpoint inconsistent", async () => {
        const t = routed(2);
        tweak(t, t.a, (m, _p, n) =>
            m === "getSignatureStatuses" && n === 1 ? notFound(t) : undefined,
        );
        const report = await t.router.start({ timers: false });
        expect(report.endpoints[0]).toMatchObject({ history: "ok", repeatsAgree: false });
        expect(snap(t, "rpc1").consistent).toBe("no");
        expect(lines(t, "warn")).toEqual([
            {
                level: "warn",
                msg: "rpc endpoint answers inconsistently",
                endpoint: "rpc1",
                reason: "check_disagreed",
            },
        ]);
        expect(lines(t, "alarm")).toEqual([]);
        expect(await reaches(t, "getSignaturesForAddress", LISTING)).toEqual(["b"]);
        expect(await reaches(t, "getTransaction", TRANSACTION)).toEqual(["a"]);
    });

    it("an inconsistent endpoint votes again only after a scheduled run agrees", async () => {
        const t = routed(2);
        tweak(t, t.a, (m, _p, n) =>
            m === "getSignatureStatuses" && n === 1 ? notFound(t) : undefined,
        );
        await t.router.start({ timers: false });
        expect(snap(t, "rpc1").consistent).toBe("no");
        const atStart = historyCalls(t.a);
        await tickAt(t, 60_000);
        expect(historyCalls(t.a)).toBe(atStart);
        expect(snap(t, "rpc1").consistent).toBe("no");
        await tickAt(t, HOUR);
        expect(snap(t, "rpc1").consistent).toBe("yes");
    });

    it("a run that finds nothing never clears a no", async () => {
        const t = routed(2);
        tweak(t, t.a, (m, _p, n) =>
            m === "getSignatureStatuses" && n === 1 ? notFound(t) : undefined,
        );
        await t.router.start({ timers: false });
        expect(snap(t, "rpc1").consistent).toBe("no");
        // Every repeat answers and agrees, but the statuses find nothing
        tweak(t, t.a, (m) => (m === "getSignatureStatuses" ? notFound(t) : undefined));
        await tickAt(t, HOUR);
        expect(snap(t, "rpc1")).toMatchObject({
            consistent: "no",
            checks: { history: "missing" },
        });
        tweak(t, t.a, () => undefined);
        await tickAt(t, 2 * HOUR);
        expect(snap(t, "rpc1").consistent).toBe("yes");
    });

    it("an hourly run waits out a cooldown", async () => {
        const t = routed(2);
        await t.router.start({ timers: false });
        const first = historyCalls(t.a);
        tweak(t, t.a, (m, _p, n) =>
            m === "getSlot" && n === 0 ? httpFail(429, { "retry-after": "60" }) : undefined,
        );
        t.clock.ms = HOUR - 1_000;
        expect(await reaches(t, "getSlot")).toEqual(["a", "b"]);
        await tickAt(t, HOUR);
        expect(historyCalls(t.a)).toBe(first);
        await tickAt(t, HOUR + 60_000);
        expect(historyCalls(t.a)).toBe(2 * first);
    });

    it("a CLI rerun waits out a cooldown within the cap", async () => {
        const t = routed(2);
        let rerunAt: number | null = null;
        tweak(t, t.b, (m, _p, n) => {
            if (m !== "getSignatureStatuses") return undefined;
            if (n === 0) return httpFail(429, { "retry-after": "5" });
            rerunAt ??= t.clock.ms;
            return undefined;
        });
        const report = await t.router.start({ timers: false });
        expect(report.endpoints[1]!.history).toBe("ok");
        expect(rerunAt).toBe(5_000);
    });

    it("an errored hourly run keeps consistent: yes", async () => {
        for (const fail of [() => httpFail(429), () => stall()]) {
            const t = routed(2);
            await t.router.start({ timers: false });
            expect(snap(t, "rpc1").consistent).toBe("yes");
            tweak(t, t.a, (m, _p, n) => (m === "getTransaction" && n === 1 ? fail() : undefined));
            await tickAt(t, HOUR);
            expect(snap(t, "rpc1")).toMatchObject({
                consistent: "yes",
                checks: { history: "error" },
            });
            expect(lines(t, "warn", "rpc endpoint answers inconsistently")).toEqual([]);
        }
    });

    it("an endpoint whose boot run errored votes after its rerun agrees", async () => {
        const t = routed(2);
        tweak(t, t.a, (m, _p, n) =>
            m === "getSignatureStatuses" && n === 0 ? httpFail(429) : undefined,
        );
        await boot(t);
        expect(snap(t, "rpc1")).toMatchObject({
            consistent: "unknown",
            checks: { history: "error" },
        });
        await tickAt(t, 60_000);
        expect(snap(t, "rpc1")).toMatchObject({ consistent: "yes", checks: { history: "ok" } });
    });

    it("an error keeps a passed check", async () => {
        const t = routed(2);
        await t.router.start({ timers: false });
        const storage = () => rpcFail(-32019, "Failed to query long-term storage");
        tweak(t, t.a, (m) => (m === "getTransaction" ? storage() : undefined));
        await tickAt(t, HOUR);
        expect(snap(t, "rpc1")).toMatchObject({
            roles: ["read", "history", "send"],
            checks: { history: "error" },
        });
    });

    it("a -32015 is an error, not ok", async () => {
        const t = routed(2);
        const version = () =>
            rpcFail(-32015, "Transaction version (0) is not supported by the requesting client");
        tweak(t, t.a, (m) => (m === "getTransaction" ? version() : undefined));
        await boot(t);
        expect(snap(t, "rpc1")).toMatchObject({
            roles: ["read", "send"],
            checks: { history: "error" },
        });
        tweak(t, t.a, () => undefined);
        await tickAt(t, 60_000);
        expect(snap(t, "rpc1")).toMatchObject({
            roles: ["read", "history", "send"],
            checks: { history: "ok" },
        });
    });

    it("history is checked again every hour", async () => {
        const t = routed(2);
        await t.router.start({ timers: false });
        const counts = () => [historyCalls(t.a), pinnedCalls(t.a)];
        const first = counts();
        await tickAt(t, HOUR - 1);
        expect(counts()).toEqual(first);
        await tickAt(t, HOUR);
        expect(counts()).toEqual([2 * first[0]!, 2 * first[1]!]);
    });
});

describe("verdicts", () => {
    it("a verdict survives a restart", async () => {
        const store = memoryVerdicts();
        const first = routed(2, {}, { verdicts: store, fingerprint });
        await first.router.start({ timers: false });
        // rpc2 finds a transaction at confirmed, then reads it null
        setCheckState(first.router, "rpc1", { genesis: "error" });
        await call(first, "getTransaction", TRANSACTION);
        tweak(first, first.b, (m) => (m === "getTransaction" ? rpcOk(null) : undefined));
        await call(first, "getTransaction", TRANSACTION);
        await first.router.stop();
        expect(store.rows.get(fingerprint(first.urls[1]!))).toEqual({
            fingerprint: fingerprint(first.urls[1]!),
            endpoint: "rpc2",
            noAt: 0,
            reason: "found_then_missing",
            historyPassed: true,
        });

        const second = routed(2, {}, { verdicts: store, fingerprint });
        second.clock.ms = 900_000;
        await second.router.start({ timers: false });
        expect(snap(second, "rpc2").consistent).toBe("no");
        await tickAt(second, HOUR);
        expect(snap(second, "rpc2").consistent).toBe("no");
        await tickAt(second, 900_000 + HOUR);
        expect(snap(second, "rpc2").consistent).toBe("yes");
    });

    it("a reordered list keeps the verdict with its URL", async () => {
        const store = memoryVerdicts();
        const [first, second] = testUrls(2) as [string, string];
        store.rows.set(fingerprint(second), {
            fingerprint: fingerprint(second),
            endpoint: "rpc2",
            noAt: 0,
            reason: "found_then_missing",
            historyPassed: true,
        });
        const t = routed(2, {}, { verdicts: store, fingerprint, urls: [second, first] });
        const before: string[][] = [];
        tweak(t, t.a, (m) => {
            if (m === "getGenesisHash")
                before.push([snap(t, "rpc1").consistent, snap(t, "rpc2").consistent]);
            return undefined;
        });
        await t.router.start({ timers: false });
        expect(before).toEqual([["no", "unknown"]]);
        expect([snap(t, "rpc1").consistent, snap(t, "rpc2").consistent]).toEqual(["no", "yes"]);
    });

    it("history lost after a restart still alarms", async () => {
        const store = memoryVerdicts();
        const first = routed(2, {}, { verdicts: store, fingerprint });
        await first.router.start({ timers: false });
        await first.router.stop();
        const second = routed(2, {}, { verdicts: store, fingerprint });
        tweak(second, second.a, (m) =>
            m === "getSignatureStatuses" ? notFound(second) : undefined,
        );
        await second.router.start({ timers: false });
        expect(lines(second, "alarm")).toEqual([alarm("rpc1", "history_missing")]);
    });

    it("a failed verdict store is one warn each time", async () => {
        const fails = () => Promise.reject(new Error("relation rpc_verdicts does not exist"));
        const t = routed(2, {}, { verdicts: { load: fails, save: fails }, fingerprint });
        await t.router.start({ timers: false });
        await t.router.stop();
        // Each run passed history and agreed: two changes, so two writes, per endpoint
        expect(lines(t, "warn").map((l) => [l.msg, l.endpoint])).toEqual([
            ["rpc verdicts not loaded", undefined],
            ["rpc verdict not stored", "rpc1"],
            ["rpc verdict not stored", "rpc1"],
            ["rpc verdict not stored", "rpc2"],
            ["rpc verdict not stored", "rpc2"],
        ]);
        expect(snap(t, "rpc1").consistent).toBe("yes");
    });
});

describe("unreachable endpoints", () => {
    it("a genesis HTTP error is named", async () => {
        const t = routed(2);
        tweak(t, t.a, (m) => (m === "getGenesisHash" ? httpFail(400) : undefined));
        const report = await t.router.start({ timers: false });
        expect(report.endpoints[0]).toMatchObject({ genesis: "error", genesisError: "http_400" });
        expect(snap(t, "rpc1")).toMatchObject({
            state: "unchecked",
            checks: { genesis: "error http_400" },
        });
        expect(lines(t, "alarm")).toEqual([alarm("rpc1", "unreachable", { status: 400 })]);
        expect(await reaches(t, "getSlot")).toEqual(["b"]);
    });

    it("no endpoint at all", async () => {
        const t = routed(2);
        for (const ep of [t.a, t.b]) ep.answer(() => netFail());
        await t.router.start({ timers: false });
        expect((await rejection(call(t, "getSlot"))).reason).toBe("no_endpoint");
    });

    it("an unreachable endpoint starts unchecked and is retried", async () => {
        const t = routed(2);
        tweak(t, t.a, () => netFail());
        await boot(t);
        expect(await reaches(t, "getSlot")).toEqual(["b"]);
        tweak(t, t.a, () => undefined);
        await tickAt(t, 60_000);
        expect(await reaches(t, "getSlot")).toEqual(["a"]);
    });
});

describe("the tick timer", () => {
    it("the service's start ticks every 5 s until stop, and a CLI start never ticks", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        onTestFinished(() => void vi.useRealTimers());
        for (const timers of [true, false]) {
            // A snapshot is written on the tick alone, once snapshot_every has passed
            const written: unknown[] = [];
            const t = routed(2, {}, { snapshots: { write: async (s) => void written.push(s) } });
            await t.router.start({ timers });
            const ticks = async (n: number) => {
                for (let i = 0; i < n; i++) {
                    t.clock.ms += 60_000;
                    await vi.advanceTimersByTimeAsync(5_000);
                    for (let j = 0; j < 5; j++) await new Promise((r) => setImmediate(r));
                }
            };
            await ticks(3);
            expect(written).toHaveLength(timers ? 3 : 0);
            await t.router.stop();
            await ticks(2);
            expect(written).toHaveLength(timers ? 3 : 0);
        }
    });
});

describe("start line", () => {
    it("a routed start names its positions", async () => {
        const t = routed(2);
        await t.router.start({ timers: false });
        expect(lines(t, "info", "rpc router started")).toEqual([
            { level: "info", msg: "rpc router started", endpoints: ["rpc1", "rpc2"] },
        ]);
        const single = routed(1);
        await single.router.start({ timers: false });
        expect(lines(single, "info")).toEqual([]);
    });
});

describe("idle probes", () => {
    it("every endpoint gets a confirmed getEpochInfo each minute", async () => {
        const t = routed(2);
        await t.router.start({ timers: false });
        const confirmed = [{ commitment: "confirmed" }];
        t.clock.ms = 59_000;
        expect(await reaches(t, "getSlot", confirmed)).toEqual(["a"]);
        const epochs = (ep: FakeEndpoint) =>
            ep.calls.filter((c) => c.method === "getEpochInfo").map((c) => c.params);
        const before = [epochs(t.a).length, epochs(t.b).length];
        await tickAt(t, 60_000);
        expect(epochs(t.a).slice(before[0])).toEqual([confirmed]);
        expect(epochs(t.b).slice(before[1])).toEqual([confirmed]);
        t.clock.ms = 100_000;
        expect(await reaches(t, "getEpochInfo", confirmed)).toEqual(["a"]);
        const answered = epochs(t.a).length;
        await tickAt(t, 120_000);
        expect(epochs(t.a)).toHaveLength(answered);
    });
});

describe("single mode", () => {
    it("single mode checks only the genesis at start", async () => {
        const t = routed(1);
        await t.router.start({ timers: false });
        expect(methods(t.a)).toEqual(["getGenesisHash"]);
        await t.router.check();
        expect(methods(t.a)).toEqual([
            "getGenesisHash",
            "getGenesisHash",
            "getEpochInfo",
            "getIdentity",
            "getAccountInfo",
            "getAccountInfo",
            "getSignaturesForAddress",
            "getSignaturesForAddress",
            ...Array(CHECK_REPEATS).fill("getSignatureStatuses"),
            ...Array(CHECK_REPEATS).fill("getTransaction"),
            "getSignaturesForAddress",
        ]);
    });

    it("single mode serves requests when getGenesisHash fails at start", async () => {
        const t = routed(1);
        tweak(t, t.a, (m) => (m === "getGenesisHash" ? netFail() : undefined));
        await t.router.start({ timers: false });
        expect(t.log.lines).toEqual([
            {
                level: "warn",
                msg: "rpc genesis check failed",
                endpoint: "rpc1",
                outcome: "network",
            },
        ]);
        expect(await reaches(t, "getSlot")).toEqual(["a"]);
    });

    it("single mode never drops its endpoint", async () => {
        const t = routed(1);
        await t.router.start({ timers: false });
        tweak(t, t.a, (m, _p, n) => {
            if (m === "getSignatureStatuses") return notFound(t);
            return m === "getTransaction" && n === 1 ? rpcOk(null) : undefined;
        });
        const report = await t.router.check();
        expect(report.endpoints[0]).toMatchObject({ history: "missing", repeatsAgree: false });
        expect(await reaches(t, "getTransaction", TRANSACTION)).toEqual(["a"]);
        expect(await reaches(t, "getSignaturesForAddress", LISTING)).toEqual(["a"]);
    });
});
