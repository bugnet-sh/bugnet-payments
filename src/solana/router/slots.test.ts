import { beforeEach, describe, expect, it } from "vitest";
import { type Commitment, readRequest, type RouterRequest } from "./payload.ts";
import { type Kind, observationsOf, SlotBook } from "./slots.ts";

let ms = 0;
let reference: (endpoint: string) => boolean;
let drops: [string, Commitment, Kind][];
let book: SlotBook;

function fresh(): SlotBook {
    return new SlotBook({
        now: () => ms,
        isReference: (endpoint) => reference(endpoint),
        sampleMaxAgeMs: 120_000,
        maxSlotLag: 50,
        onDrop: (endpoint, c, k) => drops.push([endpoint, c, k]),
    });
}

beforeEach(() => {
    ms = 0;
    reference = () => true;
    drops = [];
    book = fresh();
});

function slotAt(t: number, endpoint: string, value: number, c: Commitment = "confirmed"): void {
    ms = t;
    book.observe(endpoint, { commitment: c, slot: BigInt(value) });
}

function heightAt(t: number, endpoint: string, value: number, c: Commitment = "confirmed"): void {
    ms = t;
    book.observe(endpoint, { commitment: c, height: BigInt(value) });
}

function request(method: string, params: unknown[]): RouterRequest {
    const r = readRequest({ jsonrpc: "2.0", id: 1n, method, params });
    expect(r).not.toBeNull();
    return r!;
}

describe("SlotBook marks", () => {
    it("a mark keeps the highest value and when it was first reported", () => {
        slotAt(0, "a", 100);
        slotAt(1_000, "a", 90);
        slotAt(2_000, "a", 100);
        expect(book.mark("a", "confirmed", "slot")).toEqual({
            value: 100n,
            firstSeen: 0,
            lastSeen: 2000,
        });
        slotAt(3_000, "a", 101);
        expect(book.mark("a", "confirmed", "slot")).toEqual({
            value: 101n,
            firstSeen: 3000,
            lastSeen: 3000,
        });
        expect(book.mark("a", "confirmed", "height")).toBeNull();
        expect(book.mark("b", "confirmed", "slot")).toBeNull();
    });

    it("confirmed marks project at 450 ms per slot for at most 60 s", () => {
        slotAt(0, "a", 1000);
        ms = 4_500;
        expect(book.projected("a", "confirmed", "slot")).toBe(1010n);
        ms = 60_000;
        expect(book.projected("a", "confirmed", "slot")).toBe(1133n);
        ms = 600_000;
        expect(book.projected("a", "confirmed", "slot")).toBe(1133n);
    });

    it("heights project at 500 ms per block", () => {
        heightAt(0, "a", 5000);
        ms = 10_000;
        expect(book.projected("a", "confirmed", "height")).toBe(5020n);
    });

    it("finalized marks are not projected", () => {
        slotAt(0, "a", 900, "finalized");
        ms = 30_000;
        expect(book.projected("a", "finalized", "slot")).toBe(900n);
    });

    it("high water is the largest projection, with more final commitments as lower bounds", () => {
        expect(book.highWater("confirmed", "slot")).toBeNull();
        slotAt(0, "a", 1000);
        slotAt(0, "b", 1100, "finalized");
        expect(book.highWater("confirmed", "slot")).toBe(1100n);
        expect(book.highWater("finalized", "slot")).toBe(1100n);
        expect(book.highWater("processed", "slot")).toBe(1100n);
        expect(book.highWater("confirmed", "height")).toBeNull();
    });

    it("floors subtract the lag", () => {
        expect(book.floor("confirmed", "slot", 50)).toBeNull();
        slotAt(0, "a", 1000);
        slotAt(0, "b", 1100, "finalized");
        expect(book.floor("confirmed", "slot", 50)).toBe(1050n);
    });
});

describe("SlotBook lag", () => {
    it("a frozen endpoint lags itself", () => {
        slotAt(0, "a", 1000);
        slotAt(30_000, "a", 1000);
        expect(book.lag("a")).toBe(66);
    });

    it("lag compares with live endpoints seen in the last 10 s", () => {
        slotAt(0, "a", 1000);
        slotAt(1_000, "b", 940);
        expect(book.lag("b")).toBe(62);

        book = fresh();
        slotAt(0, "a", 1000);
        slotAt(11_001, "b", 940);
        expect(book.lag("b")).toBe(0);
    });

    it("a silent endpoint never makes others lag", () => {
        heightAt(0, "a", 5000);
        // Heights slower than the 500 ms a block projection, as when slots are skipped, from
        // after a's 10 s as a reference: only that window keeps a's projection out of b's lag
        for (let t = 15_000; t <= 30 * 60_000; t += 5_000) {
            heightAt(t, "b", 5000 + Math.floor(t / 600));
            // b's own mark projects 2 blocks past it in 5 s; a's mark would add about 95
            expect(book.lag("b")).toBeLessThanOrEqual(2);
        }
    });

    it("an endpoint that is not a reference is left out", () => {
        reference = (endpoint) => endpoint !== "a";
        slotAt(0, "a", 1100);
        slotAt(100, "b", 1000);
        expect(book.lag("b")).toBe(0);
    });

    it("heights lag too", () => {
        heightAt(0, "a", 5000);
        heightAt(500, "b", 4900);
        expect(book.lag("b")).toBe(101);
    });

    it("a -32005 sample counts", () => {
        book.reportLag("a", 70);
        expect(book.lag("a")).toBe(70);
    });

    it("old samples are dropped", () => {
        book.reportLag("a", 70);
        ms = 120_000;
        expect(book.lag("a")).toBe(70);
        ms = 120_001;
        expect(book.lag("a")).toBeNull();
    });

    it("an endpoint never seen has no lag", () => {
        slotAt(0, "a", 1000);
        expect(book.lag("c")).toBeNull();
    });

    it("lag is the largest of the latest samples per commitment and kind", () => {
        slotAt(0, "a", 1000);
        heightAt(0, "a", 5000);
        slotAt(1_000, "b", 940);
        heightAt(1_000, "b", 4990);
        expect(book.lag("b")).toBe(62);
        slotAt(2_000, "b", 1004);
        expect(book.lag("b")).toBe(12);
    });
});

describe("SlotBook slot drops", () => {
    it("a slot drop past max_slot_lag marks the endpoint", () => {
        slotAt(0, "a", 1000);
        slotAt(1_000, "a", 940);
        expect(drops).toEqual([["a", "confirmed", "slot"]]);

        book = fresh();
        drops = [];
        slotAt(0, "a", 1000);
        slotAt(1_000, "a", 960);
        expect(drops).toEqual([]);

        book = fresh();
        heightAt(0, "a", 5000, "finalized");
        heightAt(1_000, "a", 4940, "finalized");
        expect(drops).toEqual([["a", "finalized", "height"]]);

        book = fresh();
        drops = [];
        slotAt(0, "a", 1000, "processed");
        slotAt(1_000, "a", 900, "processed");
        expect(drops).toEqual([]);
    });
});

describe("observationsOf", () => {
    it("observations from answers", () => {
        expect(
            observationsOf(request("getAccountInfo", ["A", { commitment: "confirmed" }]), {
                result: { context: { slot: 7n }, value: null },
            }),
        ).toStrictEqual([{ commitment: "confirmed", slot: 7n }]);
        expect(
            observationsOf(request("getEpochInfo", [{ commitment: "finalized" }]), {
                result: { absoluteSlot: 9n, blockHeight: 8n },
            }),
        ).toStrictEqual([{ commitment: "finalized", slot: 9n, height: 8n }]);
        expect(
            observationsOf(request("getSlot", [{ commitment: "confirmed" }]), { result: 11n }),
        ).toStrictEqual([{ commitment: "confirmed", slot: 11n }]);
        expect(
            observationsOf(request("getBlockHeight", [{ commitment: "confirmed" }]), {
                result: 12n,
            }),
        ).toStrictEqual([{ commitment: "confirmed", height: 12n }]);
        expect(
            observationsOf(
                request("getSignatureStatuses", [["S"], { searchTransactionHistory: true }]),
                { result: { context: { slot: 13n }, value: [null] } },
            ),
        ).toStrictEqual([{ commitment: "processed", slot: 13n }]);
        expect(
            observationsOf(request("getBalance", ["A", { commitment: "confirmed" }]), {
                error: {
                    code: -32016n,
                    message: "Minimum context slot has not been reached",
                    data: { contextSlot: 14n },
                },
            }),
        ).toStrictEqual([{ commitment: "confirmed", slot: 14n }]);
        expect(
            observationsOf(request("getTransaction", ["S", { commitment: "confirmed" }]), {
                result: { slot: 15n, meta: null },
            }),
        ).toStrictEqual([]);
        expect(
            observationsOf(request("getSlot", [{ commitment: "confirmed" }]), {
                error: { code: -32005n, message: "Node is behind", data: { numSlotsBehind: 3n } },
            }),
        ).toStrictEqual([]);
        expect(
            observationsOf(request("getAccountInfo", ["A", { commitment: "confirmed" }]), {
                error: { code: -32603n, message: "Internal error" },
            }),
        ).toStrictEqual([]);
    });

    it("an answer without a readable value gives nothing", () => {
        expect(
            observationsOf(request("getSlot", [{ commitment: "confirmed" }]), { result: "x" }),
        ).toStrictEqual([]);
        expect(
            observationsOf(request("getEpochInfo", [{ commitment: "confirmed" }]), {
                result: { absoluteSlot: 9n },
            }),
        ).toStrictEqual([{ commitment: "confirmed", slot: 9n }]);
        expect(
            observationsOf(request("getAccountInfo", ["A", { commitment: "confirmed" }]), {
                result: { value: null },
            }),
        ).toStrictEqual([]);
    });
});
