import { describe, expect, it } from "vitest";
import { ipKey, viewerHash } from "./ipkey.ts";

describe("ipKey", () => {
    it("keys an IPv4 address by itself", () => {
        expect(ipKey("203.0.113.7")).toEqual({ key: "203.0.113.7", block: null });
    });

    it("keys an IPv6 address by its /64, with its /48 as the block", () => {
        const a = ipKey("2a02:4780:c:ab47::1");
        const b = ipKey("2a02:4780:c:ab47:ffff::2");
        expect(a).toEqual({ key: "2a02:4780:c:ab47::/64", block: "2a02:4780:c::/48" });
        expect(b).toEqual(a);
        expect(ipKey("2A02:4780:000C:AB47:0:0:0:9")).toEqual(a);
    });

    it("keys an IPv4-mapped IPv6 address by its IPv4 address", () => {
        expect(ipKey("::ffff:203.0.113.7")).toEqual({ key: "203.0.113.7", block: null });
        expect(ipKey("::FFFF:203.0.113.7")).toEqual({ key: "203.0.113.7", block: null });
        expect(ipKey("::ffff:cb00:7107")).toEqual({ key: "203.0.113.7", block: null });
        expect(ipKey("0:0:0:0:0:ffff:cb00:7107")).toEqual({ key: "203.0.113.7", block: null });
    });

    it("keeps an address it cannot read as one key", () => {
        expect(ipKey("unknown")).toEqual({ key: "unknown", block: null });
    });
});

describe("viewerHash", () => {
    const seed = Buffer.alloc(32, 7);

    it("is a 64-character hex that depends on the seed and the key only", () => {
        const h = viewerHash(seed, "203.0.113.7");
        expect(h).toMatch(/^[0-9a-f]{64}$/);
        expect(viewerHash(Buffer.alloc(32, 7), "203.0.113.7")).toBe(h);
        expect(viewerHash(seed, "203.0.113.8")).not.toBe(h);
        expect(viewerHash(Buffer.alloc(32, 8), "203.0.113.7")).not.toBe(h);
        expect(h).not.toContain("203.0.113.7");
        expect(viewerHash(seed, "2a02:4780:c::/48")).not.toContain("2a02");
    });
});
