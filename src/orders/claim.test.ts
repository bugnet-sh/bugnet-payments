import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claimHash, claimMatches, newClaim, openClaim, sealClaim } from "./claim.ts";
import { isOrderId, newOrderId } from "./ids.ts";

describe("order ids", () => {
    it("fit the memo budget", () => {
        const id = newOrderId();
        expect(id).toMatch(/^ord_[a-z2-7]{26}$/);
        expect(Buffer.byteLength(id)).toBe(30);
        expect(newOrderId()).not.toBe(id);
    });
    it("are recognised only in full", () => {
        expect(isOrderId(newOrderId())).toBe(true);
        expect(isOrderId("ord_" + "a".repeat(25))).toBe(false);
        expect(isOrderId("ord_" + "a".repeat(27))).toBe(false);
        expect(isOrderId("ord_" + "A".repeat(26))).toBe(false);
        expect(isOrderId("ord_" + "1".repeat(26))).toBe(false);
        expect(isOrderId(`${newOrderId()}\n`)).toBe(false);
        expect(isOrderId(42)).toBe(false);
    });
});

describe("claims", () => {
    it("are 32 random bytes and match only themselves", () => {
        const c = newClaim();
        expect(c).toHaveLength(43);
        expect(Buffer.from(c, "base64url")).toHaveLength(32);
        const h = claimHash(c)!;
        expect(claimMatches(c, h)).toBe(true);
        expect(claimMatches(newClaim(), h)).toBe(false);
        expect(claimHash("short")).toBeNull();
        expect(claimHash("x".repeat(44))).toBeNull();
        expect(claimHash("+".repeat(43))).toBeNull();
        expect(claimMatches("x".repeat(43), h)).toBe(false);
        expect(claimMatches(c, h.subarray(0, 16))).toBe(false);
    });
});

describe("sealed claims", () => {
    it("open only for their order", () => {
        const key = randomBytes(32);
        const box = sealClaim(key, "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", "c".repeat(43));
        expect(box).toHaveLength(60);
        expect(openClaim(key, "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", box)).toBe("c".repeat(43));
        expect(() => openClaim(key, "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb", box)).toThrow();
        expect(() => openClaim(randomBytes(32), "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", box)).toThrow();
        box[20]! ^= 1;
        expect(() => openClaim(key, "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", box)).toThrow();
    });
});
