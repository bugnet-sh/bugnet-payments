import { describe, expect, it } from "vitest";
import { isCanonicalAddress, isCanonicalBase58, isCanonicalSignature } from "./base58.ts";

const SIG_86 =
    "1GEoSr1zQmSdVRBytTGqwokiyaVTd1mNJ2jkEGmhDSmTwX9CbcVZrrYJZc42r5Wyu9rAJGFSDAPJWAaui4Y5Ku";
const ONES_32 = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"; // 32 bytes of 0x01

describe("base58 checks", () => {
    it("canonical signatures by decoding", () => {
        expect(SIG_86).toHaveLength(86);
        expect(isCanonicalSignature(SIG_86)).toBe(true);
        expect(isCanonicalSignature("1".repeat(63) + "2")).toBe(true);
        expect(isCanonicalSignature(ONES_32)).toBe(false);
        for (const bad of ["0OIl", "", 123, null]) expect(isCanonicalSignature(bad)).toBe(false);
    });

    it("canonical addresses by decoding", () => {
        expect(isCanonicalAddress("1".repeat(32))).toBe(true);
        expect(isCanonicalAddress(ONES_32)).toBe(true);
        expect(isCanonicalAddress("1" + ONES_32)).toBe(false); // 33 bytes
        expect(isCanonicalAddress(SIG_86)).toBe(false);
        expect(isCanonicalBase58(ONES_32, 64)).toBe(false);
    });
});
