import { describe, expect, it } from "vitest";
import { RateLimiter } from "./ratelimit.ts";

describe("RateLimiter", () => {
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
});
