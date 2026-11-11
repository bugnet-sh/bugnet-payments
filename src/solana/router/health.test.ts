import { beforeEach, describe, expect, it } from "vitest";
import { EndpointHealth, monthOf } from "./health.ts";
import { rpcSettingsSchema } from "./settings.ts";

const settings = rpcSettingsSchema.parse({});
let ms = 0;
let health: EndpointHealth;

beforeEach(() => {
    ms = 0;
    health = new EndpointHealth(
        settings,
        () => ms,
        () => 0.5,
    );
});

function strikes(n: number): void {
    for (let i = 0; i < n; i++) health.strike(100);
}

// A good probe at each time, checking the breaker stays in probation until the last
function goodProbesAt(...times: number[]): void {
    for (const at of times) {
        expect(health.breaker()).toBe("probation");
        ms = at;
        health.probeResult(true);
    }
}

describe("EndpointHealth", () => {
    it("latency starts at 500 and follows answers", () => {
        expect(health.latencyMs()).toBe(500);
        health.succeed(900);
        expect(health.latencyMs()).toBe(900);
        ms = 10_000;
        health.succeed(100);
        expect(health.latencyMs()).toBeCloseTo(394.3, 1);
    });

    it("five strikes in a row open the breaker for 30 s", () => {
        strikes(5);
        expect(health.breaker()).toBe("open");
        expect(health.openUntil()).toBe(30000);
        ms = 30_000;
        expect(health.breaker()).toBe("probation");
        expect(health.probeDue()).toBe(true);
    });

    it("three good probes 10 s apart close the breaker", () => {
        strikes(5);
        ms = 30_000;
        health.probeResult(true);
        expect(health.breaker()).toBe("probation");
        ms = 35_000;
        expect(health.probeDue()).toBe(false);
        ms = 40_000;
        expect(health.probeDue()).toBe(true);
        health.probeResult(true);
        expect(health.breaker()).toBe("probation");
        expect(health.lastProbeGood()).toBe(true);
        ms = 50_000;
        health.probeResult(true);
        expect(health.breaker()).toBe("closed");
    });

    it("probe spacing counts from when each probe was sent", () => {
        strikes(5);
        ms = 30_100;
        health.probeResult(true, 30_000);
        ms = 40_000;
        expect(health.probeDue()).toBe(true);
        ms = 40_100;
        health.probeResult(true, 40_000);
        ms = 50_100;
        health.probeResult(true, 50_000);
        expect(health.breaker()).toBe("closed");
    });

    it("a good probe sooner than 10 s after the last does not count", () => {
        strikes(5);
        ms = 30_000;
        health.probeResult(true);
        ms = 35_000;
        health.probeResult(true);
        ms = 40_000;
        health.probeResult(true);
        expect(health.breaker()).toBe("probation");
        ms = 50_000;
        health.probeResult(true);
        expect(health.breaker()).toBe("closed");
    });

    it("a bad probe reopens it with its doubled time", () => {
        strikes(5);
        ms = 30_000;
        health.probeResult(false);
        expect(health.breaker()).toBe("open");
        expect(health.openUntil()).toBe(90000);
        expect(health.lastProbeGood()).toBe(false);
        ms = 90_000;
        goodProbesAt(90_000, 100_000, 110_000);
        expect(health.breaker()).toBe("closed");
    });

    it("a closed breaker opens again for 30 s", () => {
        strikes(5);
        ms = 30_000;
        goodProbesAt(30_000, 40_000, 50_000);
        expect(health.breaker()).toBe("closed");
        expect(health.errorRate()).toBe(0);
        strikes(4);
        expect(health.breaker()).toBe("closed");
        strikes(1);
        expect(health.breaker()).toBe("open");
        expect(health.openUntil() - ms).toBe(30000);
    });

    it("a success resets the strike run", () => {
        strikes(4);
        health.succeed(100);
        strikes(4);
        expect(health.breaker()).toBe("closed");
    });

    it("an error rate above half over ten answers opens", () => {
        for (let i = 0; i < 5; i++) {
            health.strike(100);
            health.succeed(100);
        }
        expect(health.breaker()).toBe("closed");

        const other = new EndpointHealth(
            settings,
            () => ms,
            () => 0.5,
        );
        for (const answer of "fsfsfsfsff") {
            if (answer === "f") other.strike(100);
            else other.succeed(100);
        }
        expect(other.breaker()).toBe("open");
    });

    it("the breaker stays open at most 10 minutes", () => {
        strikes(5);
        for (let opening = 2; opening <= 7; opening++) {
            ms = health.openUntil();
            expect(health.breaker()).toBe("probation");
            health.probeResult(false);
        }
        expect(health.breaker()).toBe("open");
        expect(health.openUntil() - ms).toBe(600000);
    });

    it("a 401 opens for 10 minutes", () => {
        health.authFailed();
        expect(health.breaker()).toBe("open");
        expect(health.openUntil()).toBe(600000);
        ms = 599_999;
        expect(health.breaker()).toBe("open");
        ms = 600_000;
        expect(health.breaker()).toBe("probation");
    });

    it("a spent or refused endpoint opens for 10 minutes", () => {
        health.endpointDown();
        expect(health.breaker()).toBe("open");
        expect(health.openUntil()).toBe(600000);
        ms = 600_000;
        expect(health.breaker()).toBe("probation");
        health.probeResult(false);
        expect(health.openUntil() - ms).toBe(600000);
    });

    it("a lagging endpoint returns through probation", () => {
        health.lagged();
        expect(health.breaker()).toBe("probation");
        expect(health.probeDue()).toBe(true);
        goodProbesAt(0, 10_000, 20_000);
        expect(health.breaker()).toBe("closed");
    });

    it("a lagging endpoint's bad probe opens it for 30 s", () => {
        health.lagged();
        health.probeResult(false);
        expect(health.breaker()).toBe("open");
        expect(health.openUntil()).toBe(30000);
    });

    it("a long caller abort is a latency sample", () => {
        health.callerAborted(999);
        expect(health.latencyMs()).toBe(500);
        health.callerAborted(2500);
        expect(health.latencyMs()).toBe(2500);
        for (let i = 0; i < 4; i++) health.callerAborted(2500);
        expect(health.breaker()).toBe("closed");
        expect(health.errorRate()).toBe(0);
    });

    it("a sample is no answer", () => {
        health.sample(1000);
        expect(health.latencyMs()).toBe(1000);
        for (let i = 0; i < 9; i++) health.sample(1000);
        expect(health.errorRate()).toBe(0);
        expect(health.breaker()).toBe("closed");

        const other = new EndpointHealth(
            settings,
            () => ms,
            () => 0.5,
        );
        for (let i = 0; i < 4; i++) other.sample(1000);
        other.strike(1000);
        // A run of 1: four more strikes are needed to open
        for (let i = 0; i < 3; i++) other.strike(1000);
        expect(other.breaker()).toBe("closed");
        other.strike(1000);
        expect(other.breaker()).toBe("open");
    });

    it("a method can be turned off", () => {
        health.disableMethod("getSlot");
        expect(health.methodOff("getSlot")).toBe(true);
        expect(health.methodsOff()).toEqual(new Set(["getSlot"]));
        ms = 600_000_000;
        expect(health.methodOff("getSlot")).toBe(true);
        expect(health.methodOff("getBalance")).toBe(false);
    });

    it("the error rate looks back 60 s", () => {
        strikes(3);
        for (let i = 0; i < 7; i++) health.succeed(100);
        expect(health.errorRate()).toBeCloseTo(0.3, 10);
        ms = 61_000;
        expect(health.errorRate()).toBe(0);
    });

    it("in flight counts requests begun and not ended", () => {
        health.begin();
        health.begin();
        expect(health.inflight()).toBe(2);
        health.end();
        expect(health.inflight()).toBe(1);
        health.end();
        health.end();
        expect(health.inflight()).toBe(0);
    });

    it("a capped endpoint cooldown ends in probation", () => {
        health.probationAt(60000);
        ms = 59_999;
        expect(health.breaker()).toBe("closed");
        ms = 60_000;
        goodProbesAt(60_000, 70_000, 80_000);
        expect(health.breaker()).toBe("closed");
    });

    it("months are UTC", () => {
        const at = Date.parse("2026-11-30T23:59:59Z");
        expect(monthOf(at)).toBe("2026-11");
        expect(monthOf(at + 1000)).toBe("2026-12");
    });
});
