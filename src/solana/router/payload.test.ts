import { describe, expect, it } from "vitest";
import { METHODS, UNKNOWN_METHOD } from "./methods.ts";
import { contextSlotOf, readRequest, type RouterRequest, rpcErrorOf } from "./payload.ts";

function request(method: string, params: unknown[]): RouterRequest {
    const r = readRequest({ jsonrpc: "2.0", id: 1n, method, params });
    expect(r).not.toBeNull();
    return r!;
}

describe("readRequest", () => {
    it("a missing commitment reads as finalized", () => {
        expect(request("getAccountInfo", ["A", { encoding: "base64" }]).commitment).toBe(
            "finalized",
        );
    });

    it("a given commitment passes through", () => {
        const r = request("getAccountInfo", ["A", { encoding: "base64", commitment: "confirmed" }]);
        expect(r.commitment).toBe("confirmed");
    });

    it("getSignatureStatuses reads as processed", () => {
        const r = request("getSignatureStatuses", [
            ["s1", "s2"],
            { searchTransactionHistory: true },
        ]);
        expect(r).toMatchObject({
            commitment: "processed",
            searchHistory: true,
            needsHistory: true,
            signatures: ["s1", "s2"],
        });
    });

    it("statuses without history search need no history", () => {
        const r = request("getSignatureStatuses", [["s1"]]);
        expect(r.needsHistory).toBe(false);
        expect(r.searchHistory).toBe(false);
    });

    it("minContextSlot stays a bigint", () => {
        const r = request("getAccountInfo", ["A", { minContextSlot: 123n }]);
        expect(r.minContextSlot).toBe(123n);
        expect(request("getAccountInfo", ["A"]).minContextSlot).toBeNull();
    });

    it("signature scans need history and carry cursors", () => {
        const r = request("getSignaturesForAddress", [
            "A",
            { before: "b", until: "u", limit: 1000 },
        ]);
        expect(r).toMatchObject({ needsHistory: true, before: "b", until: "u" });
        const plain = request("getSignaturesForAddress", ["A"]);
        expect(plain).toMatchObject({ before: null, until: null });
    });

    it("getTransaction needs history and retries a null", () => {
        const r = request("getTransaction", ["S", { maxSupportedTransactionVersion: 0 }]);
        expect(r.needsHistory).toBe(true);
        expect(r.spec.nullRetry).toBe(true);
        expect(r.signatures).toEqual(["S"]);
    });

    it("getBlockTime prefers history", () => {
        const r = request("getBlockTime", [5n]);
        expect(r.needsHistory).toBe(false);
        expect(r.spec.history).toBe("preferred");
        expect(r.spec.retry).toBe(true);
        expect(r.spec.optionsAt).toBeNull();
        expect(r.commitment).toBe("finalized");
    });

    it("getMultipleAccounts counts its keys", () => {
        const r = request("getMultipleAccounts", [["a", "b", "c"], { encoding: "base64" }]);
        expect(r.accounts).toBe(3);
        expect(request("getAccountInfo", ["A"]).accounts).toBe(0);
    });

    it("options at position 0", () => {
        expect(request("getEpochInfo", [{ commitment: "confirmed" }]).commitment).toBe("confirmed");
        expect(request("getSlot", []).commitment).toBe("finalized");
    });

    it("a send reads its preflight commitment", () => {
        const r = request("sendTransaction", ["T", { preflightCommitment: "confirmed" }]);
        expect(r.commitment).toBe("confirmed");
        expect(r.spec.kind).toBe("send");
    });

    it("an unknown method is never retried", () => {
        const r = readRequest({ jsonrpc: "2.0", id: 1, method: "getVoteAccounts", params: [] });
        expect(r!.spec).toBe(UNKNOWN_METHOD);
        expect(r!.spec.retry).toBe(false);
        expect(r!.commitment).toBe("finalized");
    });

    it("not a JSON-RPC payload", () => {
        expect(readRequest("x")).toBeNull();
        expect(readRequest(null)).toBeNull();
        expect(readRequest({ jsonrpc: "2.0", id: 1, method: "getSlot" })).toBeNull();
        expect(readRequest({ jsonrpc: "2.0", id: 1, method: "getSlot", params: {} })).toBeNull();
    });

    it("the request keeps the payload's params", () => {
        const params = ["A", { encoding: "base64" }];
        expect(request("getAccountInfo", params).params).toBe(params);
    });
});

describe("answers", () => {
    it("contextSlotOf", () => {
        expect(contextSlotOf({ result: { context: { slot: 5n }, value: 1n } })).toBe(5n);
        expect(contextSlotOf({ result: 5n })).toBeNull();
        expect(contextSlotOf({ result: null })).toBeNull();
        expect(
            contextSlotOf({ error: { code: -32016n, message: "m", data: { contextSlot: 9n } } }),
        ).toBeNull();
    });

    it("rpcErrorOf", () => {
        expect(
            rpcErrorOf({ error: { code: -32016n, message: "m", data: { contextSlot: 9n } } }),
        ).toEqual({ code: -32016, message: "m", data: { contextSlot: 9n } });
        expect(rpcErrorOf({ result: 1n })).toBeNull();
        expect(rpcErrorOf({ error: { code: -32005 } })).toEqual({
            code: -32005,
            message: "",
            data: undefined,
        });
        expect(rpcErrorOf({ error: "x" })!.code).toBeNaN();
        expect(rpcErrorOf("x")).toBeNull();
    });
});

describe("the method table", () => {
    it("every Payments method has a spec", () => {
        const methods = [
            "getAccountInfo",
            "getBalance",
            "getBlockHeight",
            "getBlockTime",
            "getEpochInfo",
            "getFirstAvailableBlock",
            "getGenesisHash",
            "getIdentity",
            "getLatestBlockhash",
            "getMinimumBalanceForRentExemption",
            "getMultipleAccounts",
            "getSignatureStatuses",
            "getSignaturesForAddress",
            "getSlot",
            "getTokenAccountBalance",
            "getTransaction",
            "sendTransaction",
            "simulateTransaction",
        ];
        for (const method of methods) expect(METHODS, method).toHaveProperty(method);
        expect(Object.keys(METHODS).sort()).toEqual([...methods].sort());
    });

    it("the rows follow the spec's table", () => {
        expect(METHODS.getBlockHeight).toMatchObject({ slot: "height_result", optionsAt: 0 });
        expect(METHODS.getEpochInfo).toMatchObject({ slot: "epoch_info", optionsAt: 0 });
        expect(METHODS.getSlot).toMatchObject({ slot: "slot_result", optionsAt: 0 });
        expect(METHODS.getLatestBlockhash).toMatchObject({ slot: "context", optionsAt: 0 });
        expect(METHODS.getSignatureStatuses).toMatchObject({
            history: "when_searching",
            slot: "context",
            optionsAt: 1,
        });
        expect(METHODS.getFirstAvailableBlock).toMatchObject({
            history: "always",
            slot: "none",
            optionsAt: null,
        });
        expect(METHODS.getMinimumBalanceForRentExemption).toMatchObject({
            slot: "none",
            optionsAt: 1,
        });
        expect(METHODS.sendTransaction).toMatchObject({ kind: "send", slot: "none" });
        const nullRetry = Object.keys(METHODS).filter((m) => METHODS[m]!.nullRetry);
        expect(nullRetry).toEqual(["getTransaction"]);
        expect(UNKNOWN_METHOD).toEqual({
            kind: "read",
            history: "never",
            slot: "none",
            optionsAt: null,
            retry: false,
            nullRetry: false,
        });
    });
});
