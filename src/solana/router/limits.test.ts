import { beforeEach, describe, expect, it } from "vitest";
import { parseRetryAfter } from "./classify.ts";
import type { Lane } from "./health.ts";
import { LearnedLimits } from "./limits.ts";
import { rpcSettingsSchema } from "./settings.ts";

const settings = rpcSettingsSchema.parse({});
let ms = 0;
let limits: LearnedLimits;

function fresh(): LearnedLimits {
    return new LearnedLimits(
        settings,
        () => ms,
        () => 0.5,
    );
}

beforeEach(() => {
    ms = 0;
    limits = fresh();
});

function record(n: number, method: string, lane: Lane): void {
    for (let i = 0; i < n; i++) limits.record(method, lane);
}

// { "*": 40 } from a first 429 after a burst of 50; returns 20 s later, its window and cooldown over
function learnStar40(): void {
    record(50, "getEpochInfo", "money");
    limits.hit429("getEpochInfo", null);
    expect(limits.limits()).toEqual({ "*": 40 });
    ms += 20_000;
}

// The cooldown a 429 for this method gave, measured from now
function cooldownOf(method: string): number {
    limits.record(method, "money");
    limits.hit429(method, null);
    return limits.coolingUntil(method) - ms;
}

describe("LearnedLimits", () => {
    it("no limit before a 429", () => {
        record(1000, "getSlot", "background");
        expect(limits.hasRoom("getSlot", "background")).toBe(true);
        expect(limits.limits()).toEqual({});
    });

    it("an endpoint's first 429 learns 80 percent of its whole window", () => {
        for (let i = 0; i < 50; i++) {
            ms = i * 200;
            if (i % 5 < 3) limits.record("getSlot", "money");
            else limits.record("getBalance", "background");
        }
        ms = 9_900;
        expect(limits.hit429("getSlot", null)).toEqual({ scope: "*", capped: false });
        expect(limits.limits()).toEqual({ "*": 40 });
        expect(limits.endpointCoolingUntil()).toBe(10900);
        expect(limits.coolingUntil("getBalance")).toBe(10900);
        expect(limits.hasRoom("getBalance", "money")).toBe(false);
        ms = 10_899;
        expect(limits.hasRoom("getBalance", "money")).toBe(false);
        ms = 10_900;
        expect(limits.endpointCoolingUntil()).toBe(0);
    });

    it("a 429 on a one-call method sets the endpoint limit", () => {
        record(49, "getMultipleAccounts", "background");
        record(1, "getLatestBlockhash", "money");
        expect(limits.hit429("getLatestBlockhash", null).scope).toBe("*");
        expect(limits.limits()).toEqual({ "*": 40 });
    });

    it("a later 429 for a method with half the window learns that method", () => {
        learnStar40();
        record(12, "getTransaction", "money");
        record(8, "getBalance", "money");
        expect(limits.hit429("getTransaction", null)).toEqual({
            scope: "getTransaction",
            capped: false,
        });
        expect(limits.limits()).toEqual({ "*": 40, getTransaction: 9 });
        expect(limits.coolingUntil("getTransaction")).toBeGreaterThan(ms);
        expect(limits.coolingUntil("getBalance")).toBe(0);
        expect(limits.endpointCoolingUntil()).toBe(0);
    });

    it("a later 429 for a small share lowers the endpoint limit", () => {
        learnStar40();
        record(3, "getSlot", "money");
        record(27, "getBalance", "background");
        expect(limits.hit429("getSlot", null).scope).toBe("*");
        expect(limits.limits()).toEqual({ "*": 24 });
        expect(limits.endpointCoolingUntil()).toBeGreaterThan(ms);
    });

    it("setting the endpoint limit drops method limits of the same 10 s", () => {
        const learnTransaction9 = () => {
            learnStar40();
            record(12, "getTransaction", "money");
            record(8, "getBalance", "money");
            limits.hit429("getTransaction", null);
            expect(limits.limits()).toEqual({ "*": 40, getTransaction: 9 });
        };

        learnTransaction9();
        ms += 5_000;
        record(1, "getSlot", "money");
        expect(limits.hit429("getSlot", null).scope).toBe("*");
        expect(limits.limits()).toEqual({ "*": 16 });

        ms = 0;
        limits = fresh();
        learnTransaction9();
        ms += 11_000;
        record(20, "getBalance", "money");
        record(1, "getSlot", "money");
        expect(limits.hit429("getSlot", null).scope).toBe("*");
        expect(limits.limits()).toEqual({ "*": 16, getTransaction: 9 });
    });

    it("Retry-After sets the cooldown", () => {
        limits.record("getTransaction", "money");
        expect(limits.hit429("getTransaction", 10000)).toEqual({ scope: "*", capped: false });
        expect(limits.coolingUntil("getTransaction")).toBe(10000);
        expect(limits.endpointCoolingUntil()).toBe(10000);
    });

    it("Retry-After is capped at 60 s", () => {
        limits.record("getSlot", "money");
        expect(limits.hit429("getSlot", 3_600_000)).toEqual({ scope: "*", capped: true });
        expect(limits.endpointCoolingUntil()).toBe(60000);

        limits = fresh();
        const yearAhead = new Date(365 * 86_400_000).toUTCString();
        limits.record("getSlot", "money");
        expect(limits.hit429("getSlot", parseRetryAfter(yearAhead, 0))).toEqual({
            scope: "*",
            capped: true,
        });
        expect(limits.endpointCoolingUntil()).toBe(60000);

        limits = fresh();
        learnStar40();
        limits.record("getTransaction", "money");
        expect(limits.hit429("getTransaction", 3_600_000)).toEqual({
            scope: "getTransaction",
            capped: true,
        });
        expect(limits.coolingUntil("getTransaction")).toBe(ms + 60_000);
        expect(limits.endpointCoolingUntil()).toBe(0);
    });

    it("a 5xx Retry-After cools the endpoint under the same cap", () => {
        expect(limits.coolEndpoint(5_000)).toEqual({ capped: false });
        expect(limits.endpointCoolingUntil()).toBe(5000);
        expect(limits.coolEndpoint(3_600_000)).toEqual({ capped: true });
        expect(limits.endpointCoolingUntil()).toBe(60000);
        expect(limits.coolEndpoint(5_000)).toEqual({ capped: false });
        expect(limits.endpointCoolingUntil()).toBe(60000);
        expect(limits.limits()).toEqual({});
        ms = 300_000;
        expect(limits.rateLimited()).toBe(false);
    });

    it("backoff without Retry-After doubles and resets", () => {
        expect(cooldownOf("getSlot")).toBe(1000);
        ms += 1_000;
        expect(cooldownOf("getSlot")).toBe(2000);
        limits.succeeded("getSlot");
        ms += 2_000;
        expect(cooldownOf("getSlot")).toBe(1000);
        const seen: number[] = [];
        for (let i = 0; i < 6; i++) {
            ms += 60_000;
            seen.push(cooldownOf("getSlot"));
        }
        expect(seen).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    });

    it("rate limited after 5 minutes of 429s without a success", () => {
        for (ms = 0; ms < 300_000; ms += 60_000) limits.hit429("getEpochInfo", null);
        ms = 299_999;
        expect(limits.rateLimited()).toBe(false);
        ms = 300_000;
        expect(limits.rateLimited()).toBe(true);
        limits.succeeded("getSlot");
        expect(limits.rateLimited()).toBe(false);
    });

    it("the window bounds requests", () => {
        learnStar40();
        const start = ms;
        for (let i = 0; i < 40; i++) {
            ms = start + i * 100;
            limits.record("getSlot", "money");
        }
        ms = start + 4_000;
        expect(limits.hasRoom("getSlot", "money")).toBe(false);
        expect(limits.msUntilRoom("getSlot", "money")).toBe(6000);
        ms = start + 9_999;
        expect(limits.hasRoom("getSlot", "money")).toBe(false);
        ms = start + 10_000;
        expect(limits.hasRoom("getSlot", "money")).toBe(true);
        expect(limits.msUntilRoom("getSlot", "money")).toBe(0);
    });

    it("a limit grows 10 percent after a minute at the limit", () => {
        learnStar40();
        record(40, "getSlot", "money");
        ms = 59_999;
        expect(limits.limits()["*"]).toBe(40);
        ms = 60_000;
        expect(limits.limits()["*"]).toBe(44);
        ms = 70_000;
        record(10, "getSlot", "money");
        ms = 180_000;
        expect(limits.limits()["*"]).toBe(44);
    });

    it("background uses at most 60 percent of a learned limit", () => {
        learnStar40();
        record(13, "getSlot", "money");
        expect(limits.hit429("getSlot", null).scope).toBe("getSlot");
        ms += 20_000;
        expect(limits.limits()).toEqual({ "*": 40, getSlot: 10 });
        record(6, "getSlot", "background");
        expect(limits.hasRoom("getSlot", "background")).toBe(false);
        expect(limits.msUntilRoom("getSlot", "background")).toBe(10000);
        expect(limits.backgroundOut("getSlot")).toBe(false);
        expect(limits.hasRoom("getSlot", "money")).toBe(true);
        record(4, "getSlot", "money");
        expect(limits.hasRoom("getSlot", "money")).toBe(false);
    });

    it("a limit of 1 makes the endpoint out for the background lane", () => {
        learnStar40();
        record(1, "getTransaction", "money");
        expect(limits.hit429("getTransaction", null).scope).toBe("getTransaction");
        ms += 20_000;
        expect(limits.limits()).toEqual({ "*": 40, getTransaction: 1 });
        expect(limits.hasRoom("getTransaction", "background")).toBe(false);
        expect(limits.msUntilRoom("getTransaction", "background")).toBe(Infinity);
        expect(limits.backgroundOut("getTransaction")).toBe(true);
        expect(limits.backgroundOut("getSlot")).toBe(false);
        expect(limits.hasRoom("getTransaction", "money")).toBe(true);
    });

    it("an endpoint-wide limit binds every method", () => {
        record(13, "getSlot", "money");
        limits.hit429("getSlot", null);
        expect(limits.limits()).toEqual({ "*": 10 });
        ms = 20_000;
        record(5, "getSlot", "money");
        record(5, "getBalance", "money");
        expect(limits.hasRoom("getEpochInfo", "money")).toBe(false);
        expect(limits.hasRoom("getEpochInfo", "background")).toBe(false);
    });

    it("calls sent together need room for all of them", () => {
        learnStar40();
        const start = ms;
        record(23, "getSlot", "background");
        ms = start + 1_000;
        record(16, "getSlot", "money");
        const both = ["getSignatureStatuses", "getSignaturesForAddress"];
        expect(limits.hasRoom("getSignaturesForAddress", "money")).toBe(true);
        expect(limits.hasRoom(both, "money")).toBe(false);
        expect(limits.msUntilRoom(both, "money")).toBe(9_000);
        expect(limits.hasRoom("getSignaturesForAddress", "background")).toBe(true);
        expect(limits.hasRoom(both, "background")).toBe(false);
        expect(limits.msUntilRoom(both, "background")).toBe(9_000);
        expect(limits.backgroundOut(both)).toBe(false);
        ms = start + 10_000;
        expect(limits.hasRoom(both, "money")).toBe(true);
        expect(limits.hasRoom(both, "background")).toBe(true);
    });

    it("a method's own limit counts only its own calls", () => {
        learnStar40();
        record(3, "getSlot", "money");
        expect(limits.hit429("getSlot", null).scope).toBe("getSlot");
        ms += 20_000;
        expect(limits.limits()).toEqual({ "*": 40, getSlot: 2 });
        record(1, "getSlot", "money");
        expect(limits.hasRoom(["getBalance", "getSlot"], "money")).toBe(true);
        expect(limits.hasRoom(["getSlot", "getSlot"], "money")).toBe(false);
        expect(limits.msUntilRoom(["getSlot", "getSlot"], "money")).toBe(10_000);
        expect(limits.msUntilRoom(["getSlot", "getSlot", "getSlot"], "money")).toBe(Infinity);
        expect(limits.backgroundOut("getSlot")).toBe(false);
        expect(limits.backgroundOut(["getBalance", "getSlot"])).toBe(false);
        expect(limits.backgroundOut(["getSlot", "getSlot"])).toBe(true);
        expect(limits.msUntilRoom(["getSlot", "getSlot"], "background")).toBe(Infinity);
    });
});
