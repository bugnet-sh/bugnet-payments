import { describe, expect, it } from "vitest";
import { RpcRouterError } from "./errors.ts";
import { copyPayload, isMissingBlockhashSimulation } from "./send.ts";
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
    stall,
    testDeps,
    type TestDeps,
    testRpcSettings,
} from "./testing.ts";
import { createRouterTransport, type RouterDeps, type RouterTransport } from "./transport.ts";

// One signed transaction as kit sends it
const WIRE = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
const SEND = "sendTransaction";
const CONFIG = { encoding: "base64", preflightCommitment: "confirmed" };
const COPY = [WIRE, { encoding: "base64", skipPreflight: true }];
const LABELS = ["a", "b", "c", "d"];

function signatureOf(label: string): string {
    return `${label}-signature`;
}

// Accepts every send with its own signature; any other call is answered at slot 1000
function accepting(label: string): FakeHandler {
    return (method) =>
        method === SEND
            ? rpcOk(signatureOf(label))
            : rpcOk({ context: { slot: 1_000n }, value: 5n });
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
    const eps = LABELS.slice(0, n).map((label) => fakeEndpoint(label, accepting(label)));
    const deps = testDeps(eps, more);
    const router = createRouterTransport(testRpcSettings(over), deps.urls, deps);
    passAll(router);
    const at = (i: number) => eps[i] ?? fakeEndpoint(`unused ${LABELS[i]}`);
    return { ...deps, router, a: at(0), b: at(1), c: at(2), d: at(3) };
}

function sendPayload(config: Record<string, unknown> = CONFIG): {
    jsonrpc: string;
    id: bigint;
    method: string;
    params: unknown[];
} {
    return { jsonrpc: "2.0", id: 1n, method: SEND, params: [WIRE, config] };
}

function send(t: Setup): Promise<unknown> {
    return t.router({ payload: sendPayload() });
}

function simulate(t: Setup): Promise<unknown> {
    const config = { encoding: "base64", replaceRecentBlockhash: false, sigVerify: true };
    return t.router({
        payload: { jsonrpc: "2.0", id: 1n, method: "simulateTransaction", params: [WIRE, config] },
    });
}

// What a node answers when its preflight refuses the transaction
function refusal(err: unknown = { InstructionError: [0, { Custom: 1 }] }): unknown {
    return rpcFail(-32002, "Transaction simulation failed", { err });
}

function missingBlockhash(): unknown {
    return rpcOk({ context: { slot: 10n }, value: { err: "BlockhashNotFound", logs: [] } });
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

function sends(fake: FakeEndpoint): FakeEndpoint["calls"] {
    return fake.calls.filter((c) => c.method === SEND);
}

async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 1_000 && !done(); i++) await new Promise((r) => setImmediate(r));
    expect(done()).toBe(true);
}

// Copies are detached, so a test that expects none gives them a moment to show
async function settled(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe("copyPayload", () => {
    it("keeps the wire and the caller's config, without preflight", () => {
        const caller = sendPayload({ ...CONFIG, minContextSlot: 5n, maxRetries: 0n });
        expect(copyPayload(caller)).toEqual({
            jsonrpc: "2.0",
            id: 1n,
            method: SEND,
            params: [
                WIRE,
                { encoding: "base64", minContextSlot: 5n, maxRetries: 0n, skipPreflight: true },
            ],
        });
        expect(caller.params[1]).toEqual({ ...CONFIG, minContextSlot: 5n, maxRetries: 0n });
        expect((copyPayload(caller) as { params: unknown[] }).params[0]).toBe(WIRE);
    });

    it("a send without a config gets one", () => {
        expect(copyPayload({ params: [WIRE] })).toEqual({
            params: [WIRE, { skipPreflight: true }],
        });
    });
});

describe("isMissingBlockhashSimulation", () => {
    it("is true only for a simulation whose error is BlockhashNotFound", () => {
        expect(isMissingBlockhashSimulation(missingBlockhash())).toBe(true);
        const ok = rpcOk({ context: { slot: 10n }, value: { err: null, logs: [] } });
        expect(isMissingBlockhashSimulation(ok)).toBe(false);
        const failed = rpcOk({
            context: { slot: 10n },
            value: { err: { InstructionError: [0, 1] } },
        });
        expect(isMissingBlockhashSimulation(failed)).toBe(false);
        expect(isMissingBlockhashSimulation(refusal("BlockhashNotFound"))).toBe(false);
        expect(isMissingBlockhashSimulation(null)).toBe(false);
    });
});

describe("sends", () => {
    it("a send goes to the first send endpoint as given", async () => {
        const t = setup(2);
        const sent = sendPayload();
        expect(resultOf(await t.router({ payload: sent }))).toBe(signatureOf("a"));
        expect(t.a.calls[0]!.payload).toBe(sent);
    });

    it("an accepted send is copied to send_fanout other domains", async () => {
        const t = setup(3, { send_fanout: 1 });
        expect(resultOf(await send(t))).toBe(signatureOf("a"));
        await until(() => t.b.calls.length === 1);
        expect(t.b.calls[0]!.params).toEqual(COPY);
        expect(t.b.calls[0]!.params[0] === WIRE).toBe(true);
        await settled();
        expect(t.c.calls).toHaveLength(0);
        expect(sends(t.a)).toHaveLength(1);
    });

    it("copies go to other domains only", async () => {
        const urls = ["https://one.x.example/", "https://two.x.example/", "https://c.example/"];
        const t = setup(3, {}, { urls });
        expect(resultOf(await send(t))).toBe(signatureOf("a"));
        await until(() => t.c.calls.length === 1);
        expect(t.c.calls[0]!.params).toEqual(COPY);
        await settled();
        expect(t.b.calls).toHaveLength(0);
    });

    it("a copy's failure never reaches the caller", async () => {
        const t = setup(2);
        t.b.answer(() => netFail());
        expect(resultOf(await send(t))).toBe(signatureOf("a"));
        await until(() => t.log.lines.some((l) => l.msg === "rpc send copy failed"));
        expect(t.log.lines).toContainEqual(
            expect.objectContaining({
                level: "warn",
                msg: "rpc send copy failed",
                endpoint: "rpc2",
            }),
        );
    });

    it("a preflight refusal returns at once, without copies", async () => {
        const t = setup(2);
        const refused = refusal();
        t.a.answer(() => refused);
        expect(await send(t)).toBe(refused);
        await settled();
        expect(t.b.calls.length).toBe(0);
    });

    it("a refusal after a definite non-delivery still returns", async () => {
        const firsts: FakeHandler[] = [
            () => httpFail(403),
            () => netFail("ECONNREFUSED"),
            () => httpFail(400),
        ];
        for (const first of firsts) {
            const t = setup(2);
            const refused = refusal();
            t.a.answer(first);
            t.b.answer(() => refused);
            expect(await send(t)).toBe(refused);
        }
    });

    it("a refusal after a 429 or a node's error is send_unconfirmed", async () => {
        const firsts: FakeHandler[] = [
            () => httpFail(429),
            () => rpcFail(-32005, "Node is unhealthy", { numSlotsBehind: 10n }),
            () => rpcFail(-32016, "Minimum context slot has not been reached", { contextSlot: 9n }),
            () => refusal("BlockhashNotFound"),
        ];
        for (const first of firsts) {
            const t = setup(2);
            t.a.answer(first);
            t.b.answer(() => refusal());
            expect(reasonOf(await rejection(send(t)))).toBe("send_unconfirmed");
        }
    });

    it("AlreadyProcessed is always send_unconfirmed", async () => {
        const t = setup(2);
        t.a.answer(() => refusal("AlreadyProcessed"));
        expect(reasonOf(await rejection(send(t)))).toBe("send_unconfirmed");
        await settled();
        expect(t.b.calls.length).toBe(0);
        const single = setup(1);
        const processed = refusal("AlreadyProcessed");
        single.a.answer(() => processed);
        expect(await send(single)).toBe(processed);
    });

    it("a refusal after a stalled attempt is send_unconfirmed", async () => {
        const t = setup(3);
        t.a.answer(() => stall());
        // An instruction error alone is a clean refusal, so only the stall can make it unconfirmed
        t.b.answer(() => refusal());
        const e = await rejection(send(t));
        expect(e).toBeInstanceOf(RpcRouterError);
        expect(reasonOf(e)).toBe("send_unconfirmed");
        await settled();
        expect(t.c.calls).toHaveLength(0);
    });

    it("a refusal after a reset or a 5xx is send_unconfirmed", async () => {
        for (const first of [() => netFail(), () => httpFail(502)]) {
            const t = setup(2);
            t.a.answer(first);
            t.b.answer(() => refusal());
            expect(reasonOf(await rejection(send(t)))).toBe("send_unconfirmed");
        }
    });

    it("an error that returns after an ambiguous attempt is send_unconfirmed", async () => {
        const t = setup(2);
        t.a.answer(() => httpFail(429));
        t.b.answer(() => httpFail(413));
        expect(reasonOf(await rejection(send(t)))).toBe("send_unconfirmed");
        const clean = setup(2);
        clean.a.answer(() => httpFail(403));
        const tooLarge = rpcFail(-32602, "invalid transaction: too large");
        clean.b.answer(() => tooLarge);
        expect(await send(clean)).toBe(tooLarge);
    });

    it("an acceptance after a stall is the answer", async () => {
        const t = setup(3);
        t.a.answer(() => stall());
        expect(resultOf(await send(t))).toBe(signatureOf("b"));
        await until(() => t.c.calls.length === 1);
        expect(t.c.calls[0]!.params).toEqual(COPY);
        expect(sends(t.a)).toHaveLength(1);
    });

    it("every send endpoint failing after a stall is send_unconfirmed", async () => {
        const t = setup(3);
        t.a.answer(() => stall());
        // Neither surely delivered, so only the stall can make the send unconfirmed
        t.b.answer(() => httpFail(403));
        t.c.answer(() => netFail("ECONNREFUSED"));
        expect(reasonOf(await rejection(send(t)))).toBe("send_unconfirmed");
    });

    it("a missing blockhash moves to the next send endpoint", async () => {
        const t = setup(3, { send_fanout: 1 });
        t.a.answer(() => refusal("BlockhashNotFound"));
        expect(resultOf(await send(t))).toBe(signatureOf("b"));
        await until(() => t.c.calls.length === 1);
        expect(t.c.calls[0]!.params).toEqual(COPY);
        await settled();
        expect(sends(t.a)).toHaveLength(1);
    });

    it("a 429 on send moves on", async () => {
        const t = setup(2);
        t.a.answer(() => httpFail(429));
        expect(resultOf(await send(t))).toBe(signatureOf("b"));
    });

    it("a 400 on send was never delivered", async () => {
        const t = setup(2);
        t.a.answer(() => httpFail(400));
        const refused = refusal();
        t.b.answer(() => refused);
        expect(await send(t)).toBe(refused);
    });

    it("a proxy's own code on send may have delivered", async () => {
        const t = setup(2);
        t.a.answer(() => rpcFail(35, "m"));
        t.b.answer(() => refusal());
        expect(reasonOf(await rejection(send(t)))).toBe("send_unconfirmed");
    });

    it("a send skips an endpoint that turned sendTransaction off", async () => {
        const t = setup(3);
        t.a.answer(() => netFail("ECONNREFUSED"));
        t.b.answer(() => rpcFail(-32601, "Method not found"));
        expect(resultOf(await send(t))).toBe(signatureOf("c"));
        expect(sends(t.b)).toHaveLength(1);
        expect(resultOf(await send(t))).toBe(signatureOf("c"));
        await settled();
        expect(sends(t.a)).toHaveLength(2);
        expect(sends(t.b)).toHaveLength(1);
    });

    it("the wire is never changed", async () => {
        const t = setup(4, { send_fanout: 2 });
        t.a.answer(() => httpFail(429));
        t.b.answer(() => refusal("BlockhashNotFound"));
        expect(resultOf(await send(t))).toBe(signatureOf("c"));
        await until(() => sends(t.d).length === 1);
        const all = [t.a, t.b, t.c, t.d].flatMap(sends);
        expect(all).toHaveLength(4);
        for (const c of all) expect(c.params[0] === WIRE).toBe(true);
    });

    it("no copies with send_fanout 0", async () => {
        const t = setup(2, { send_fanout: 0 });
        expect(resultOf(await send(t))).toBe(signatureOf("a"));
        await settled();
        expect(t.b.calls.length).toBe(0);
    });

    it("a send never runs on the background lane", async () => {
        const t = setup(2);
        const e = await rejection(t.router.background({ payload: sendPayload() }));
        expect(reasonOf(e)).toBe("no_endpoint");
        expect(t.a.calls).toHaveLength(0);
        expect(t.b.calls).toHaveLength(0);
    });
});

describe("simulations", () => {
    it("a simulation without the blockhash is retried once elsewhere", async () => {
        const t = setup(3);
        t.a.answer(() => missingBlockhash());
        const found = rpcOk({ context: { slot: 10n }, value: { err: null, logs: [] } });
        t.b.answer(() => found);
        expect(await simulate(t)).toBe(found);
        const again = setup(3);
        again.a.answer(() => missingBlockhash());
        const second = missingBlockhash();
        again.b.answer(() => second);
        expect(await simulate(again)).toBe(second);
        expect(again.c.calls).toHaveLength(0);
    });

    it("a simulation without the blockhash is returned when no other endpoint answers", async () => {
        const t = setup(2);
        const first = missingBlockhash();
        t.a.answer(() => first);
        t.b.answer(() => netFail());
        expect(await simulate(t)).toBe(first);
        const alone = setup(2, { max_attempts: 1 });
        const only = missingBlockhash();
        alone.a.answer(() => only);
        expect(await simulate(alone)).toBe(only);
        expect(alone.b.calls).toHaveLength(0);
    });
});
