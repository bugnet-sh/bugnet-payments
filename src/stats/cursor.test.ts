import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, MAX_CURSOR_LENGTH } from "./cursor.ts";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

describe("stats cursor", () => {
    it("round-trips at, kind and id as opaque base64url", () => {
        const c = { at: 1_893_456_000_123, kind: "refund", id: "42" } as const;
        const s = encodeCursor(c);
        expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeCursor(s)).toEqual(c);
        const order = { at: 0, kind: "sandbox", id: "ord_abcdefghijklmnopqrstuvwxyz" } as const;
        expect(decodeCursor(encodeCursor(order))).toEqual(order);
    });

    it("refuses a cursor over the length cap", () => {
        const long = b64({ at: 1, kind: "extend", id: "a".repeat(140) });
        expect(long.length).toBeGreaterThan(MAX_CURSOR_LENGTH);
        expect(decodeCursor(long)).toBeNull();
        expect(MAX_CURSOR_LENGTH).toBe(200);
    });

    it.each([
        ["empty", ""],
        ["not base64url", "abc$def"],
        ["padded", `${b64({ at: 1, kind: "extend", id: "1" })}=`],
        ["not JSON", Buffer.from("{at:1").toString("base64url")],
        ["an array", b64([1, "extend", "1"])],
        ["an unknown kind", b64({ at: 1, kind: "x402_fee", id: "1" })],
        ["a negative at", b64({ at: -1, kind: "extend", id: "1" })],
        ["a fractional at", b64({ at: 1.5, kind: "extend", id: "1" })],
        ["an unsafe at", b64({ at: 2 ** 53, kind: "extend", id: "1" })],
        ["a string at", b64({ at: "1", kind: "extend", id: "1" })],
        ["a missing id", b64({ at: 1, kind: "extend" })],
        ["an empty id", b64({ at: 1, kind: "extend", id: "" })],
        ["an id with odd characters", b64({ at: 1, kind: "extend", id: "1' or 1=1" })],
    ])("refuses %s", (_, s) => {
        expect(decodeCursor(s)).toBeNull();
    });
});
