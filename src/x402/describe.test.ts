import { describe, expect, it } from "vitest";
import { TEST_PAYTO } from "../testing/x402.ts";
import { describeOrder, usd } from "./describe.ts";
import { serviceIdFor } from "./ids.ts";
import type { StoredPin } from "./types.ts";

function stored(over: Partial<StoredPin> = {}): StoredPin {
    return {
        serviceId: serviceIdFor("POST", "agent402.tools", "/v1/auto/"),
        method: "POST",
        host: "agent402.tools",
        prefix: "/v1/auto/",
        url: "https://agent402.tools/v1/auto/chat/completions",
        maxPriceMicros: 10_000,
        payTo: TEST_PAYTO,
        listed: "indexed",
        paidPath: null,
        pinnedFrom: "probe",
        probe: { at: "2030-01-01T00:00:00.000Z", status: 402, accepted: null },
        newPin: true,
        ...over,
    };
}

describe("usd", () => {
    it("formats dollars", () => {
        expect([1_000_000, 3_000, 10_000, 100_000, 5_003_000, 1].map(usd)).toEqual([
            "$1.00",
            "$0.003",
            "$0.01",
            "$0.10",
            "$5.003",
            "$0.000001",
        ]);
    });
});

describe("describeOrder", () => {
    it("writes the 7.15 example", () => {
        expect(
            describeOrder({
                kind: "allowance",
                packageText: "ignored",
                allowanceMicros: 1_000_000,
                feeMicros: 3_000,
                pins: [stored()],
            }),
        ).toBe(
            "Bugnet x402 $1.00 + $0.003 fee: agent402.tools/v1/auto/ up to $0.01 pays 4vJ9...kLKi",
        );
    });

    it("leaves the fee out when it is not due", () => {
        expect(
            describeOrder({
                kind: "allowance",
                packageText: "",
                allowanceMicros: 500_000,
                feeMicros: 0,
                pins: [],
            }),
        ).toBe("Bugnet x402 $0.50");
    });

    it("cuts a start order's package text to 120", () => {
        const text = "p".repeat(130);
        expect(
            describeOrder({
                kind: "start",
                packageText: text,
                allowanceMicros: 1_000_000,
                feeMicros: 3_000,
                pins: [],
            }),
        ).toBe(`${"p".repeat(120)} + x402 $1.00 + $0.003 fee`);
    });

    it("cuts by code points, not UTF-16 units", () => {
        const out = describeOrder({
            kind: "start",
            packageText: "😀".repeat(130),
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            pins: [],
        });
        expect(out.startsWith("😀".repeat(120) + " + x402")).toBe(true);
    });

    it("names an unlisted pin's paid path", () => {
        const text = describeOrder({
            kind: "allowance",
            packageText: "",
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            pins: [
                stored({
                    host: "seller.example",
                    prefix: "/weather/",
                    listed: "unlisted",
                    paidPath: "/weather/today",
                }),
            ],
        });
        expect(
            text.endsWith(
                ": seller.example/weather/today up to $0.01 pays 4vJ9...kLKi (unreviewed)",
            ),
        ).toBe(true);
    });

    it("throws on an unlisted pin with no paid path", () => {
        expect(() =>
            describeOrder({
                kind: "allowance",
                packageText: "",
                allowanceMicros: 1_000_000,
                feeMicros: 3_000,
                pins: [stored({ listed: "unlisted", paidPath: null })],
            }),
        ).toThrow(/no paid path/);
    });

    it("joins pins with '; ', names only new pins and never cuts", () => {
        const pins = [1, 2, 3, 4, 5].map((n) =>
            stored({
                prefix: `/p${n}/`,
                url: `https://agent402.tools/p${n}/${"x".repeat(250)}`,
                listed: "unlisted",
                paidPath: `/p${n}/${"x".repeat(250)}`,
            }),
        );
        const old = stored({ host: "old.example", newPin: false });
        const text = describeOrder({
            kind: "allowance",
            packageText: "",
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            pins: [pins[0]!, old, ...pins.slice(1)],
        });
        expect(text.length).toBeGreaterThan(1_000);
        expect(text.split("; ")).toHaveLength(5);
        expect(text).not.toContain("old.example");
        expect(
            text.endsWith(
                `agent402.tools/p5/${"x".repeat(250)} up to $0.01 pays 4vJ9...kLKi (unreviewed)`,
            ),
        ).toBe(true);
    });
});
