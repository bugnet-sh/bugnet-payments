import { afterEach, describe, expect, it, vi } from "vitest";
import { IpLimiter, RateLimiter } from "./ratelimit.ts";
import { ipKey } from "./http/ipkey.ts";

describe("RateLimiter", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("allows 5 per minute per key", () => {
        let t = 0;
        const l = new RateLimiter(5, 60_000, () => t);
        for (let i = 0; i < 5; i++) expect(l.take("order:a").ok).toBe(true);
        expect(l.take("order:a")).toEqual({ ok: false, retryAfterSeconds: 60 });
        expect(l.take("order:b").ok).toBe(true);
        t = 60_000;
        expect(l.take("order:a").ok).toBe(true);
    });

    it("keeps a fixed window and rounds the wait up to whole seconds", () => {
        let t = 0;
        const l = new RateLimiter(2, 60_000, () => t);
        expect(l.take("k").ok).toBe(true);
        t = 30_000;
        expect(l.take("k").ok).toBe(true);
        expect(l.take("k")).toEqual({ ok: false, retryAfterSeconds: 30 });
        t = 59_001;
        expect(l.take("k")).toEqual({ ok: false, retryAfterSeconds: 1 });
        t = 60_000;
        expect(l.take("k").ok).toBe(true);
        expect(l.take("k").ok).toBe(true);
        expect(l.take("k")).toEqual({ ok: false, retryAfterSeconds: 60 });
    });

    it("starts a key afresh once its window has passed while other keys were taken", () => {
        let t = 0;
        const l = new RateLimiter(1, 1_000, () => t);
        expect(l.take("a").ok).toBe(true);
        t = 500;
        expect(l.take("b").ok).toBe(true);
        t = 1_000;
        expect(l.take("a").ok).toBe(true);
        expect(l.take("b")).toEqual({ ok: false, retryAfterSeconds: 1 });
        t = 1_500;
        expect(l.take("b").ok).toBe(true);
        expect(l.take("a")).toEqual({ ok: false, retryAfterSeconds: 1 });
    });

    it.each([
        [0, 60_000],
        [-1, 60_000],
        [Number.NaN, 60_000],
        [5, 0],
        [5, -1],
        [5, Number.NaN],
    ])("refuses limit %s with window %s ms at construction", (limit, windowMs) => {
        expect(() => new RateLimiter(limit, windowMs, () => 0)).toThrow(RangeError);
    });

    it("never stretches a window past windowMs when the clock steps back", () => {
        let t = 30_000;
        const l = new RateLimiter(1, 60_000, () => t);
        expect(l.take("k").ok).toBe(true);
        t = 0;
        expect(l.take("k")).toEqual({ ok: false, retryAfterSeconds: 60 });
        t = 60_000;
        expect(l.take("k").ok).toBe(true);
    });

    it("reads a monotonic clock by default", () => {
        const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
        vi.spyOn(Date, "now").mockReturnValue(0);
        const l = new RateLimiter(1, 60_000);
        expect(l.take("k").ok).toBe(true);
        expect(l.take("k")).toEqual({ ok: false, retryAfterSeconds: 60 });
        now.mockReturnValue(61_000);
        expect(l.take("k").ok).toBe(true);
    });
});

describe("IpLimiter", () => {
    it("one /64 is one key", () => {
        const t = 0;
        const limiter = new IpLimiter(2, 60_000, 4, () => t);
        const take = (ip: string) => limiter.take(ipKey(ip)).ok;
        // Two addresses of one /64 share its 2 takes
        expect([take("2001:db8:1:1::1"), take("2001:db8:1:1::2"), take("2001:db8:1:1::3")]).toEqual(
            [true, true, false],
        );
        // Other /64s of the same /48 get their own 2, until the /48 has taken 8
        const results: boolean[] = [];
        for (let n = 2; n <= 6; n++)
            results.push(take(`2001:db8:1:${n}::1`), take(`2001:db8:1:${n}::2`));
        expect(results.filter(Boolean)).toHaveLength(6);
        expect(results.slice(0, 6)).toEqual([true, true, true, true, true, true]);
        expect(results.slice(6)).toEqual([false, false, false, false]);
        // An IPv4 address is its own key
        expect([take("203.0.113.7"), take("203.0.113.7"), take("203.0.113.7")]).toEqual([
            true,
            true,
            false,
        ]);
    });
});
