import { create } from "@bufbuild/protobuf";
import { DurationSchema, TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it } from "vitest";
import {
    PayerVerdict,
    type AppendAllowanceEventRequest,
    type AppendX402ResolvedRequest,
} from "../gen/bugnet/router/v1/payments_pb.ts";
import { SOLANA_MAINNET, USDC_MINT } from "../solana/constants.ts";
import { memoryLog, silentLog } from "../log.ts";
import { startFakeRouter, type FakeRouter } from "../testing/fake-router.ts";
import { createRouterClient, type AllowanceEventInput, type X402ResolvedInput } from "./client.ts";

const req = { payer: "payerA", feePayer: "feeB", packageId: "pkg_small", kind: "start" } as const;
const ts = (iso: string) => create(TimestampSchema, { seconds: BigInt(Date.parse(iso) / 1000) });
const dur = (seconds: number) => create(DurationSchema, { seconds: BigInt(seconds) });
const signal = () => AbortSignal.timeout(2_000);

const open: FakeRouter[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((r) => r.close()));
});
async function router(impl: Parameters<typeof startFakeRouter>[0]) {
    const r = await startFakeRouter(impl);
    open.push(r);
    return r;
}
const opts = (url: string, over: Partial<Parameters<typeof createRouterClient>[0]> = {}) => ({
    url,
    token: "rt",
    timeoutMs: 1_000,
    checkPayer: true,
    getOrder: false,
    log: silentLog,
    ...over,
});

describe("checkPayer", () => {
    it.each([
        [{ verdict: PayerVerdict.OK }, { verdict: "ok" }],
        [
            { verdict: PayerVerdict.BLOCKED, blockedUntil: ts("2026-11-07T00:00:00Z") },
            { verdict: "blocked", blockedUntil: "2026-11-07T00:00:00.000Z" },
        ],
        [{ verdict: PayerVerdict.BLOCKED }, { verdict: "blocked" }],
        [
            { verdict: PayerVerdict.RATE_LIMITED, retryAfter: dur(12) },
            { verdict: "rate_limited", retryAfterSeconds: 12 },
        ],
        [
            { verdict: PayerVerdict.BUSY, retryAfter: dur(7) },
            { verdict: "busy", retryAfterSeconds: 7 },
        ],
        [{ verdict: PayerVerdict.BUSY }, { verdict: "busy", retryAfterSeconds: 30 }],
        [{ verdict: PayerVerdict.UNSPECIFIED }, { verdict: "unavailable" }],
    ])("maps %o", async (answer, want) => {
        const r = await router({ checkPayer: () => answer });
        const c = createRouterClient(opts(r.url));
        expect(await c.checkPayer(req, signal())).toEqual(want);
        expect(r.headers[0]!.get("authorization")).toBe("Bearer rt");
    });

    it("sends the request fields to the router", async () => {
        let seen: unknown;
        const r = await router({
            checkPayer: (m) => {
                seen = {
                    payer: m.payer,
                    feePayer: m.feePayer,
                    packageId: m.packageId,
                    kind: m.kind,
                };
                return { verdict: PayerVerdict.OK };
            },
        });
        await createRouterClient(opts(r.url)).checkPayer(req, signal());
        expect(seen).toEqual(req);
    });

    it("maps InvalidArgument to invalid", async () => {
        const r = await router({
            checkPayer: () => {
                throw new ConnectError("bad payer", Code.InvalidArgument);
            },
        });
        const c = createRouterClient(opts(r.url));
        expect(await c.checkPayer(req, signal())).toEqual({ verdict: "invalid" });
    });

    it("maps other errors, a dead router and a timeout to unavailable", async () => {
        const failing = await router({
            checkPayer: () => {
                throw new ConnectError("boom", Code.Internal);
            },
        });
        const log = memoryLog();
        expect(
            await createRouterClient(opts(failing.url, { log })).checkPayer(req, signal()),
        ).toEqual({ verdict: "unavailable" });

        const dead = await router({});
        const deadUrl = dead.url;
        await dead.close();
        expect(await createRouterClient(opts(deadUrl)).checkPayer(req, signal())).toEqual({
            verdict: "unavailable",
        });

        const slow = await router({
            checkPayer: () => new Promise((resolve) => setTimeout(resolve, 1_500)),
        });
        const c = createRouterClient(opts(slow.url, { timeoutMs: 100 }));
        expect(await c.checkPayer(req, signal())).toEqual({ verdict: "unavailable" });
    });

    it("answers unavailable when the caller aborts", async () => {
        const r = await router({ checkPayer: () => ({ verdict: PayerVerdict.OK }) });
        const c = createRouterClient(opts(r.url));
        expect(await c.checkPayer(req, AbortSignal.abort())).toEqual({ verdict: "unavailable" });
    });
});

describe("flags", () => {
    it("makes no request when the flags are off", async () => {
        const r = await router({});
        const c = createRouterClient(opts(r.url, { checkPayer: false, getOrder: false }));
        expect(await c.checkPayer(req, signal())).toEqual({ verdict: "skipped" });
        expect(await c.getOrder("ord_a", signal())).toEqual({ kind: "disabled" });
        expect(r.headers).toHaveLength(0);
    });
});

describe("getOrder", () => {
    it.each([
        [{ redeemed: false }, { kind: "absent" }],
        [
            { redeemed: true, kind: "start", placementState: "ready", refundable: false },
            {
                kind: "found",
                orderKind: "start",
                placementState: "ready",
                refundable: false,
                failureReason: "",
                terminationReason: "",
            },
        ],
        [
            {
                redeemed: true,
                kind: "start",
                placementState: "failed",
                refundable: true,
                failureReason: "provider_failed",
                terminationReason: "provider_failed",
                endedAt: ts("2026-11-07T00:00:00Z"),
            },
            {
                kind: "found",
                orderKind: "start",
                placementState: "failed",
                refundable: true,
                failureReason: "provider_failed",
                terminationReason: "provider_failed",
                endedAt: new Date("2026-11-07T00:00:00Z"),
            },
        ],
    ])("maps %o", async (answer, want) => {
        let seen = "";
        const r = await router({
            getOrder: (m) => {
                seen = m.orderId;
                return answer;
            },
        });
        const c = createRouterClient(opts(r.url, { getOrder: true }));
        expect(await c.getOrder("ord_a", signal())).toEqual(want);
        expect(seen).toBe("ord_a");
        expect(r.headers[0]!.get("authorization")).toBe("Bearer rt");
    });

    it("answers disabled on Unimplemented and warns once per process", async () => {
        const r = await router({
            getOrder: () => {
                throw new ConnectError("no", Code.Unimplemented);
            },
        });
        const log = memoryLog();
        const c = createRouterClient(opts(r.url, { getOrder: true, log }));
        expect(await c.getOrder("ord_a", signal())).toEqual({ kind: "disabled" });
        expect(await c.getOrder("ord_b", signal())).toEqual({ kind: "disabled" });
        expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
    });

    it("answers unavailable on InvalidArgument", async () => {
        const r = await router({
            getOrder: () => {
                throw new ConnectError("bad", Code.InvalidArgument);
            },
        });
        const c = createRouterClient(opts(r.url, { getOrder: true }));
        expect(await c.getOrder("", signal())).toEqual({ kind: "unavailable" });
    });

    it("answers unavailable when the deadline passes", async () => {
        const r = await router({
            getOrder: () => new Promise((resolve) => setTimeout(resolve, 1_500)),
        });
        const c = createRouterClient(opts(r.url, { getOrder: true, timeoutMs: 100 }));
        expect(await c.getOrder("ord_a", signal())).toEqual({ kind: "unavailable" });
    });

    it("answers unavailable on an error, a dead router and an abort", async () => {
        const failing = await router({
            getOrder: () => {
                throw new ConnectError("boom", Code.Internal);
            },
        });
        const c = createRouterClient(opts(failing.url, { getOrder: true }));
        expect(await c.getOrder("ord_a", signal())).toEqual({ kind: "unavailable" });
        expect(await c.getOrder("ord_a", AbortSignal.abort())).toEqual({ kind: "unavailable" });

        const dead = await router({});
        const deadUrl = dead.url;
        await dead.close();
        const d = createRouterClient(opts(deadUrl, { getOrder: true }));
        expect(await d.getOrder("ord_a", signal())).toEqual({ kind: "unavailable" });
    });
});

const TOKEN = "router-secret-token-1";
const xopts = (url: string, over: Partial<Parameters<typeof createRouterClient>[0]> = {}) =>
    opts(url, { token: TOKEN, ...over });
const HANDLE = { handleSha256: "ab".repeat(32) };
const FOUND = {
    placementId: "8f9c0a52-0000-4000-8000-000000000001",
    startOrderId: "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    state: "ready",
    deadline: ts("2030-01-01T01:00:00Z"),
    x402Capable: true,
    packageId: "cpu-small",
};
const EVENT: AllowanceEventInput = {
    orderId: "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb",
    startOrderId: "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    phase: "kept",
    amountMicros: 0,
    keptMicros: 4_000,
    tx: "",
};
const RESOLVED: X402ResolvedInput = {
    startOrderId: "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    ref: "abcdefghijklmnop",
    status: "paid",
    amountMicros: 10_000,
    tx: "1".repeat(63) + "2",
    at: new Date("2026-11-07T10:00:00Z"),
    host: "agent402.tools",
    method: "POST",
    path: "/v1/auto/chat/completions",
    payTo: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
};

describe("lookupPlacement", () => {
    it("lookupPlacement by handle answers every field", async () => {
        let keyCase: string | undefined;
        const r = await router({
            lookupPlacement: (m) => {
                keyCase = m.key.case;
                return FOUND;
            },
        });
        const got = await createRouterClient(xopts(r.url)).lookupPlacement(HANDLE);
        expect(got).toEqual({
            kind: "found",
            placementId: FOUND.placementId,
            startOrderId: FOUND.startOrderId,
            state: "ready",
            deadline: new Date("2030-01-01T01:00:00Z"),
            endedAt: null,
            x402Capable: true,
            packageId: "cpu-small",
        });
        expect(keyCase).toBe("handleSha256");
    });

    it("lookupPlacement answers endedAt when the router sets it", async () => {
        const r = await router({
            lookupPlacement: () => ({
                ...FOUND,
                state: "terminated",
                deadline: undefined,
                endedAt: ts("2030-01-01T00:30:00Z"),
            }),
        });
        const got = await createRouterClient(xopts(r.url)).lookupPlacement(HANDLE);
        expect(got).toMatchObject({
            kind: "found",
            state: "terminated",
            deadline: null,
            endedAt: new Date("2030-01-01T00:30:00Z"),
        });
    });

    it("lookupPlacement by start order sends that key", async () => {
        let key: unknown;
        const r = await router({
            lookupPlacement: (m) => {
                key = m.key;
                return FOUND;
            },
        });
        await createRouterClient(xopts(r.url)).lookupPlacement({
            startOrderId: FOUND.startOrderId,
        });
        expect(key).toEqual({ case: "startOrderId", value: FOUND.startOrderId });
    });

    it.each(["HANDLE_UNKNOWN", "ORDER_UNKNOWN"])("NotFound is unknown: %s", async (reason) => {
        const r = await router({
            lookupPlacement: () => {
                throw new ConnectError(reason, Code.NotFound);
            },
        });
        expect(await createRouterClient(xopts(r.url)).lookupPlacement(HANDLE)).toEqual({
            kind: "unknown",
        });
    });

    it("other errors are unavailable", async () => {
        const cases: Array<[string, Partial<Parameters<typeof startFakeRouter>[0]>, number?]> = [
            [
                "unavailable",
                {
                    lookupPlacement: () => {
                        throw new ConnectError("down", Code.Unavailable);
                    },
                },
            ],
            [
                "invalid_argument",
                {
                    lookupPlacement: () => {
                        throw new ConnectError("bad", Code.InvalidArgument);
                    },
                },
            ],
            [
                "deadline_exceeded",
                {
                    lookupPlacement: () => new Promise((resolve) => setTimeout(resolve, 1_000)),
                },
                200,
            ],
            ["weird", { lookupPlacement: () => ({ ...FOUND, state: "weird" }) }],
        ];
        for (const [name, impl, timeoutMs] of cases) {
            const log = memoryLog();
            const r = await router(impl);
            const c = createRouterClient(
                xopts(r.url, { log, ...(timeoutMs ? { timeoutMs } : {}) }),
            );
            expect(await c.lookupPlacement(HANDLE), name).toEqual({ kind: "unavailable" });
            const warns = log.lines.filter((l) => l.level === "warn");
            expect(warns, name).toHaveLength(1);
            expect(JSON.stringify(log.lines)).not.toContain(TOKEN);
        }
    });

    it("an unavailable lookup names the Connect code in its warn line", async () => {
        const log = memoryLog();
        const r = await router({
            lookupPlacement: () => {
                throw new ConnectError("down", Code.Unavailable);
            },
        });
        await createRouterClient(xopts(r.url, { log })).lookupPlacement(HANDLE);
        expect(JSON.stringify(log.lines)).toContain("Unavailable");
    });
});

describe("appends", () => {
    it("appendAllowanceEvent sends asset, network and start_order_id", async () => {
        let seen: AppendAllowanceEventRequest | undefined;
        const r = await router({
            appendAllowanceEvent: (m) => {
                seen = m;
                return {};
            },
        });
        expect(await createRouterClient(xopts(r.url)).appendAllowanceEvent(EVENT)).toBe("ok");
        expect(seen!.orderId).toBe(EVENT.orderId);
        expect(seen!.startOrderId).toBe(EVENT.startOrderId);
        expect(seen!.event).toMatchObject({
            phase: "kept",
            amountMicros: 0n,
            keptMicros: 4000n,
            tx: "",
            asset: USDC_MINT,
            network: SOLANA_MAINNET,
        });
    });

    it("appendX402Resolved sends every field", async () => {
        let seen: AppendX402ResolvedRequest | undefined;
        const r = await router({
            appendX402Resolved: (m) => {
                seen = m;
                return {};
            },
        });
        expect(await createRouterClient(xopts(r.url)).appendX402Resolved(RESOLVED)).toBe("ok");
        expect(seen).toMatchObject({
            startOrderId: RESOLVED.startOrderId,
            ref: RESOLVED.ref,
            status: "paid",
            amountMicros: 10_000n,
            tx: RESOLVED.tx,
            host: RESOLVED.host,
            method: RESOLVED.method,
            path: RESOLVED.path,
            payTo: RESOLVED.payTo,
        });
        expect(Number(seen!.at!.seconds) * 1000).toBe(Date.parse("2026-11-07T10:00:00Z"));
    });

    it.each([
        [undefined, "ok"],
        [Code.NotFound, "order_unknown"],
        [Code.InvalidArgument, "invalid"],
        [Code.Unavailable, "retry"],
        [Code.Internal, "retry"],
    ] as const)(
        "append results map OK, NotFound, InvalidArgument and others: %s",
        async (code, want) => {
            const answer = () => {
                if (code !== undefined) throw new ConnectError("x", code);
                return {};
            };
            const log = memoryLog();
            const r = await router({ appendAllowanceEvent: answer, appendX402Resolved: answer });
            const c = createRouterClient(xopts(r.url, { log }));
            expect(await c.appendAllowanceEvent(EVENT)).toBe(want);
            expect(await c.appendX402Resolved(RESOLVED)).toBe(want);
            if (want === "retry") {
                expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(2);
                expect(JSON.stringify(log.lines)).toContain(Code[code!]);
            }
        },
    );

    it.each([1.5, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 2])(
        "malformed micros %s is invalid without calling the router",
        async (bad) => {
            let calls = 0;
            const count = () => {
                calls++;
                return {};
            };
            const r = await router({ appendAllowanceEvent: count, appendX402Resolved: count });
            const c = createRouterClient(xopts(r.url));
            expect(await c.appendAllowanceEvent({ ...EVENT, amountMicros: bad })).toBe("invalid");
            expect(await c.appendAllowanceEvent({ ...EVENT, keptMicros: bad })).toBe("invalid");
            expect(await c.appendX402Resolved({ ...RESOLVED, amountMicros: bad })).toBe("invalid");
            expect(calls).toBe(0);
        },
    );

    it("a dead router is retry", async () => {
        const c = createRouterClient(xopts("http://127.0.0.1:1"));
        expect(await c.appendAllowanceEvent(EVENT)).toBe("retry");
        expect(await c.appendX402Resolved(RESOLVED)).toBe("retry");
    });

    it("a timeout is retry", async () => {
        const r = await router({
            appendAllowanceEvent: () => new Promise((resolve) => setTimeout(resolve, 1_000)),
        });
        const c = createRouterClient(xopts(r.url, { timeoutMs: 200 }));
        expect(await c.appendAllowanceEvent(EVENT)).toBe("retry");
    });
});

it("every call carries the router token", async () => {
    const r = await router({
        lookupPlacement: () => FOUND,
        appendAllowanceEvent: () => ({}),
        appendX402Resolved: () => ({}),
    });
    const c = createRouterClient(xopts(r.url));
    await c.lookupPlacement(HANDLE);
    await c.appendAllowanceEvent(EVENT);
    await c.appendX402Resolved(RESOLVED);
    expect(r.headers).toHaveLength(3);
    for (const h of r.headers) expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
});

it("lookups and appends ignore check_payer and get_order", async () => {
    const r = await router({
        lookupPlacement: () => FOUND,
        appendAllowanceEvent: () => ({}),
        appendX402Resolved: () => ({}),
    });
    const c = createRouterClient(xopts(r.url, { checkPayer: false, getOrder: false }));
    expect(await c.lookupPlacement(HANDLE)).toMatchObject({ kind: "found" });
    expect(await c.appendAllowanceEvent(EVENT)).toBe("ok");
    expect(await c.appendX402Resolved(RESOLVED)).toBe("ok");
    expect(r.headers).toHaveLength(3);
});
