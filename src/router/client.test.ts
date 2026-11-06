import { create } from "@bufbuild/protobuf";
import { DurationSchema, TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it } from "vitest";
import { PayerVerdict } from "../gen/bugnet/router/v1/payments_pb.ts";
import { memoryLog, silentLog } from "../log.ts";
import { startFakeRouter, type FakeRouter } from "../testing/fake-router.ts";
import { createRouterClient } from "./client.ts";

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
