import { describe, expect, it } from "vitest";
import type { Lane } from "./health.ts";
import { readRequest, type RouterRequest } from "./payload.ts";
import { choose, type EndpointView, roleOf } from "./select.ts";

const ALL_ROLES = new Set(["read", "history", "send"] as const);
const NO_HISTORY = new Set(["read", "send"] as const);

function view(name: string, over: Partial<EndpointView> = {}): EndpointView {
    return {
        name,
        roles: ALL_ROLES,
        checked: true,
        consistent: true,
        pinnedSignatures: true,
        breaker: "closed",
        openUntil: 0,
        lastProbeGood: false,
        inflight: 0,
        lagging: false,
        coolingUntil: 0,
        room: true,
        rateLimited: false,
        backgroundOut: false,
        behindPin: null,
        methodsOff: new Set(),
        ...over,
    };
}

function request(method: string, params: unknown[] = []): RouterRequest {
    const r = readRequest({ jsonrpc: "2.0", id: 1n, method, params });
    expect(r).not.toBeNull();
    return r!;
}

const getSlot = () => request("getSlot", [{ commitment: "confirmed" }]);
const getTransaction = () =>
    request("getTransaction", ["sig1", { commitment: "confirmed", encoding: "json" }]);
const getStatuses = () => request("getSignatureStatuses", [["sig1"]]);
const listing = (options: Record<string, unknown> = {}) =>
    request("getSignaturesForAddress", ["addr1", { commitment: "confirmed", ...options }]);
const send = () => request("sendTransaction", ["AAAA", { encoding: "base64" }]);

function names(req: RouterRequest, views: EndpointView[], now = 0, lane: Lane = "money"): string[] {
    return choose(req, views, { now, lane }).map((v) => v.name);
}

describe("roleOf", () => {
    it("reads the role from the request", () => {
        expect(roleOf(send())).toBe("send");
        expect(roleOf(getTransaction())).toBe("history");
        expect(roleOf(listing())).toBe("history");
        expect(roleOf(getStatuses())).toBe("read");
        expect(
            roleOf(request("getSignatureStatuses", [["s"], { searchTransactionHistory: true }])),
        ).toBe("history");
        expect(roleOf(request("getBlockTime", [100n]))).toBe("read");
        expect(roleOf(request("getHealth"))).toBe("read");
    });
});

describe("choose", () => {
    it("the list order decides", () => {
        expect(names(getSlot(), [view("rpc1", { inflight: 5 }), view("rpc2")])).toEqual([
            "rpc1",
            "rpc2",
        ]);
        expect(names(getSlot(), [view("rpc2"), view("rpc1", { inflight: 5 })])).toEqual([
            "rpc2",
            "rpc1",
        ]);
    });

    it("history requests skip endpoints without history", () => {
        expect(
            names(getTransaction(), [view("rpc1", { roles: NO_HISTORY }), view("rpc2")]),
        ).toEqual(["rpc2"]);
    });

    it("the background lane never sends", () => {
        const views = [view("rpc1"), view("rpc2")];
        expect(names(send(), views, 0, "background")).toEqual([]);
        expect(names(send(), views, 0, "money")).toEqual(["rpc1", "rpc2"]);
    });

    it("listings skip an inconsistent endpoint", () => {
        const views = [view("rpc1", { consistent: false }), view("rpc2")];
        expect(names(listing(), views)).toEqual(["rpc2"]);
        expect(names(getTransaction(), views)).toEqual(["rpc1", "rpc2"]);
        expect(names(getStatuses(), views)).toEqual(["rpc1", "rpc2"]);
    });

    it("getBlockTime prefers an endpoint with history", () => {
        const views = [view("rpc1", { roles: NO_HISTORY }), view("rpc2")];
        expect(names(request("getBlockTime", [100n]), views)).toEqual(["rpc2", "rpc1"]);
    });

    it("an open breaker, probation or a cooldown excludes", () => {
        const views = [
            view("rpc1", { breaker: "open", openUntil: 10_000 }),
            view("rpc2", { breaker: "probation" }),
            view("rpc3", { coolingUntil: 5_000 }),
            view("rpc4"),
        ];
        expect(names(getSlot(), views, 0)).toEqual(["rpc4"]);
    });

    it("no room excludes", () => {
        expect(names(getSlot(), [view("rpc1", { room: false }), view("rpc2")])).toEqual(["rpc2"]);
    });

    it("a lagging endpoint is excluded", () => {
        expect(names(getSlot(), [view("rpc1", { lagging: true }), view("rpc2")])).toEqual(["rpc2"]);
    });

    it("pinned scans skip endpoints whose signatures check failed", () => {
        const views = [view("rpc1", { pinnedSignatures: false }), view("rpc2")];
        expect(names(listing({ minContextSlot: 10n }), views)).toEqual(["rpc2"]);
        expect(names(listing(), views)).toEqual(["rpc1", "rpc2"]);
    });

    it("pinned account reads are never excluded for an old slot", () => {
        const req = request("getMultipleAccounts", [
            ["acct1", "acct2"],
            { commitment: "confirmed", minContextSlot: 1000n },
        ]);
        expect(names(req, [view("rpc1"), view("rpc2", { pinnedSignatures: false })])).toEqual([
            "rpc1",
            "rpc2",
        ]);
    });

    it("an endpoint behind a pin is tried last for 5 s", () => {
        const views = [view("rpc1", { behindPin: { slot: 150n, at: 0 } }), view("rpc2")];
        const pinned = (slot: bigint) =>
            request("getAccountInfo", ["acct1", { commitment: "confirmed", minContextSlot: slot }]);
        expect(names(pinned(150n), views, 4_000)).toEqual(["rpc2", "rpc1"]);
        expect(names(pinned(140n), views, 4_000)).toEqual(["rpc1", "rpc2"]);
        expect(names(pinned(150n), views, 5_001)).toEqual(["rpc1", "rpc2"]);
    });

    it("a method turned off excludes", () => {
        const views = [view("rpc1", { methodsOff: new Set(["getSlot"]) }), view("rpc2")];
        expect(names(getSlot(), views)).toEqual(["rpc2"]);
        expect(names(request("getBlockHeight"), views)).toEqual(["rpc1", "rpc2"]);
    });

    it("an unchecked endpoint is never chosen", () => {
        expect(names(getSlot(), [view("rpc1", { checked: false }), view("rpc2")])).toEqual([
            "rpc2",
        ]);
        expect(names(getSlot(), [view("rpc1", { checked: false })])).toEqual([]);
    });

    it("with every breaker open, probation first, then the soonest to close, one request each", () => {
        const at = (over: { rpc2?: Partial<EndpointView>; rpc3?: Partial<EndpointView> }) => [
            view("rpc1", { breaker: "open", openUntil: 9_000 }),
            view("rpc2", { breaker: "open", openUntil: 5_000, ...over.rpc2 }),
            view("rpc3", { breaker: "probation", lastProbeGood: true, ...over.rpc3 }),
        ];
        expect(names(getSlot(), at({}))).toEqual(["rpc3", "rpc2", "rpc1"]);
        expect(names(getSlot(), at({ rpc3: { inflight: 1 } }))).toEqual(["rpc2", "rpc1"]);
        expect(names(getSlot(), at({ rpc2: { inflight: 1 } }))).toEqual(["rpc3", "rpc1"]);
    });

    it("cooldowns are never relaxed", () => {
        const views = [
            view("rpc1", { coolingUntil: 10_000 }),
            view("rpc2", { coolingUntil: 10_000 }),
        ];
        expect(names(getSlot(), views, 0)).toEqual([]);
        const open = [
            view("rpc1", { breaker: "open", openUntil: 5_000, coolingUntil: 10_000 }),
            view("rpc2", { breaker: "open", openUntil: 5_000, room: false }),
        ];
        expect(names(getSlot(), open, 0)).toEqual([]);
    });

    it("background stops at the first endpoint that only lacks room", () => {
        const views = [view("rpc1", { room: false }), view("rpc2")];
        expect(names(getSlot(), views, 0, "background")).toEqual([]);
        expect(names(getSlot(), views, 0, "money")).toEqual(["rpc2"]);
        const cooling = [view("rpc1", { coolingUntil: 5_000 }), view("rpc2")];
        expect(names(getSlot(), cooling, 0, "background")).toEqual([]);
        const later = [view("rpc1"), view("rpc2", { room: false }), view("rpc3")];
        expect(names(getSlot(), later, 0, "background")).toEqual(["rpc1"]);
    });

    it("background passes an endpoint that is out", () => {
        const outs: Partial<EndpointView>[] = [
            { breaker: "open", openUntil: 10_000 },
            { lagging: true },
            { checked: false },
            { rateLimited: true, coolingUntil: 5_000 },
            { backgroundOut: true },
        ];
        for (const out of outs) {
            const views = [view("rpc1", out), view("rpc2")];
            expect(names(getSlot(), views, 0, "background"), JSON.stringify(out)).toEqual(["rpc2"]);
            const busy = [view("rpc1", { ...out, room: false }), view("rpc2")];
            expect(names(getSlot(), busy, 0, "background"), JSON.stringify(out)).toEqual(["rpc2"]);
        }
        const inconsistent = [view("rpc1", { consistent: false, room: false }), view("rpc2")];
        expect(names(listing(), inconsistent, 0, "background")).toEqual(["rpc2"]);
    });

    it("relaxing never breaks a role, lag or consistency", () => {
        const views = [
            view("rpc1", { breaker: "open", openUntil: 8_000 }),
            view("rpc2", { breaker: "open", openUntil: 6_000, consistent: false }),
            view("rpc3", { breaker: "open", openUntil: 7_000, lagging: true }),
            view("rpc4", { breaker: "open", openUntil: 9_000 }),
        ];
        expect(names(listing(), views)).toEqual(["rpc1", "rpc4"]);
        const noHistory = [
            view("rpc1", { breaker: "open", openUntil: 5_000, roles: NO_HISTORY }),
            view("rpc2", { breaker: "open", openUntil: 6_000 }),
        ];
        expect(names(getTransaction(), noHistory)).toEqual(["rpc2"]);
    });
});
