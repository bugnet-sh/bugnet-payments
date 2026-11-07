import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Log, memoryLog } from "../log.ts";
import { dailyAt, every } from "./every.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function gate() {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

function throwingLog(): Log {
    return {
        ...memoryLog(),
        error: () => {
            throw new Error("stderr closed");
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2030-01-01T03:29:00Z") });
});
afterEach(() => {
    vi.useRealTimers();
});

describe("every", () => {
    it("never overlaps runs", async () => {
        const slow = gate();
        let calls = 0;
        let active = 0;
        let maxActive = 0;
        const stop = every(
            1_000,
            "slow",
            async () => {
                calls++;
                active++;
                maxActive = Math.max(maxActive, active);
                await slow.opened;
                active--;
            },
            memoryLog(),
        );
        await vi.advanceTimersByTimeAsync(3_000);
        expect(calls).toBe(1);
        expect(maxActive).toBe(1);

        slow.open();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(calls).toBe(2);
        expect(maxActive).toBe(1);
        stop();
    });

    it("first runs one interval after it starts", async () => {
        let calls = 0;
        const stop = every(1_000, "tick", async () => calls++, memoryLog());
        await vi.advanceTimersByTimeAsync(999);
        expect(calls).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toBe(1);
        stop();
    });

    it("logs a failed run with the job's name and keeps its schedule", async () => {
        const log = memoryLog();
        let calls = 0;
        const stop = every(
            1_000,
            "sweep",
            async () => {
                calls++;
                throw new Error("database gone");
            },
            log,
        );
        await vi.advanceTimersByTimeAsync(2_000);
        expect(calls).toBe(2);
        expect(log.lines.filter((l) => l.level === "error")).toMatchObject([
            { msg: "job failed", job: "sweep", err: { message: "database gone" } },
            { msg: "job failed", job: "sweep", err: { message: "database gone" } },
        ]);
        stop();
    });

    it("keeps its schedule when the logger throws", async () => {
        let calls = 0;
        const stop = every(
            1_000,
            "sweep",
            async () => {
                calls++;
                throw new Error("database gone");
            },
            throwingLog(),
        );
        await vi.advanceTimersByTimeAsync(3_000);
        expect(calls).toBe(3);
        stop();
    });

    it("refuses an interval Node cannot keep and starts no timer", () => {
        for (const ms of [0, -1_000, 0.5, 1.5, NaN, Infinity, 2 ** 31]) {
            expect(() => every(ms, "sweep", async () => {}, memoryLog())).toThrow(RangeError);
        }
        expect(() => every(0, "sweep", async () => {}, memoryLog())).toThrow(/sweep/);
        expect(vi.getTimerCount()).toBe(0);
        const stop = every(2 ** 31 - 1, "sweep", async () => {}, memoryLog());
        expect(vi.getTimerCount()).toBe(1);
        stop();
    });

    it("runs nothing after stop", async () => {
        let calls = 0;
        const stop = every(1_000, "tick", async () => calls++, memoryLog());
        await vi.advanceTimersByTimeAsync(1_000);
        stop();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(calls).toBe(1);
    });
});

describe("dailyAt", () => {
    it("runs at the next HH:MM UTC and then once a day", async () => {
        const runs: string[] = [];
        const stop = dailyAt(
            "03:30",
            "audit",
            async () => runs.push(new Date().toISOString()),
            memoryLog(),
        );
        await vi.advanceTimersByTimeAsync(MIN - 1);
        expect(runs).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(runs).toEqual(["2030-01-01T03:30:00.000Z"]);
        await vi.advanceTimersByTimeAsync(DAY);
        expect(runs).toEqual(["2030-01-01T03:30:00.000Z", "2030-01-02T03:30:00.000Z"]);
        stop();
    });

    it("waits until tomorrow when today's time has passed", async () => {
        vi.setSystemTime(new Date("2030-01-01T04:00:00Z"));
        const runs: string[] = [];
        const stop = dailyAt(
            "03:30",
            "audit",
            async () => runs.push(new Date().toISOString()),
            memoryLog(),
        );
        await vi.advanceTimersByTimeAsync(DAY - 30 * MIN - 1);
        expect(runs).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(runs).toEqual(["2030-01-02T03:30:00.000Z"]);
        stop();
    });

    it("schedules from the clock it is given", async () => {
        const runs: number[] = [];
        const stop = dailyAt(
            "03:30",
            "audit",
            async () => runs.push(Date.now()),
            memoryLog(),
            () => new Date(Date.now() + 10 * MIN),
        );
        await vi.advanceTimersByTimeAsync(DAY - 9 * MIN - 1);
        expect(runs).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(runs).toHaveLength(1);
        stop();
    });

    it("runs once even when the timer fires early", async () => {
        const runs: string[] = [];
        let clockMs = 0;
        const stop = dailyAt(
            "03:30",
            "audit",
            async () => runs.push(new Date().toISOString()),
            memoryLog(),
            () => new Date(Date.now() - clockMs),
        );
        await vi.advanceTimersByTimeAsync(MIN - 50);
        clockMs = 50;
        await vi.advanceTimersByTimeAsync(50);
        expect(runs).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(10 * MIN);
        expect(runs).toHaveLength(1);
        stop();
    });

    it("logs a failed run and still runs the next day", async () => {
        const log = memoryLog();
        let calls = 0;
        const stop = dailyAt(
            "03:30",
            "audit",
            async () => {
                calls++;
                throw new Error("rpc down");
            },
            log,
        );
        await vi.advanceTimersByTimeAsync(MIN + DAY);
        expect(calls).toBe(2);
        expect(log.lines.filter((l) => l.level === "error")).toHaveLength(2);
        expect(log.lines[0]).toMatchObject({ msg: "job failed", job: "audit" });
        stop();
    });

    it("still runs the next day when the logger throws", async () => {
        let calls = 0;
        const stop = dailyAt(
            "03:30",
            "audit",
            async () => {
                calls++;
                throw new Error("rpc down");
            },
            throwingLog(),
        );
        await vi.advanceTimersByTimeAsync(MIN + DAY);
        expect(calls).toBe(2);
        stop();
    });

    it("refuses a time that is not HH:MM UTC and starts no timer", () => {
        for (const hhmm of ["3:30", "24:00", "03:60", "0330", "03:30 ", "", "aa:bb", "03:30:00"]) {
            expect(() => dailyAt(hhmm, "audit", async () => {}, memoryLog())).toThrow(RangeError);
        }
        expect(() => dailyAt("24:00", "audit", async () => {}, memoryLog())).toThrow(/audit/);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("runs nothing after stop", async () => {
        let calls = 0;
        const stop = dailyAt("03:30", "audit", async () => calls++, memoryLog());
        stop();
        await vi.advanceTimersByTimeAsync(2 * DAY);
        expect(calls).toBe(0);
    });
});
