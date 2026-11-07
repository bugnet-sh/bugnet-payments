import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    bugnetAddresses,
    newPaymentIdentifier,
    newX402PaymentId,
    PAYMENT_ID,
    serviceIdFor,
    SERVICE_ID,
} from "./ids.ts";

describe("x402 ids", () => {
    it("serviceIdFor matches the shared vector", () => {
        expect(serviceIdFor("POST", "agent402.tools", "/v1/auto/")).toBe("xs_w5a4htopmpzmmhos");
        expect(serviceIdFor("GET", "seller.example", "/ok/")).toBe("xs_beynw7muaoanyeri");
        expect(serviceIdFor("GET", "seller.example", "/ok/")).toMatch(SERVICE_ID);
    });
    it("serviceIdFor matches the bugnet-proto vector file", () => {
        const file = new URL(
            "../../../bugnet-proto/vectors/x402/service-ids.json",
            import.meta.url,
        );
        const { v, cases } = JSON.parse(readFileSync(file, "utf8")) as {
            v: number;
            cases: { method: string; host: string; prefix: string; id: string }[];
        };
        expect(v).toBe(1);
        expect(cases.length).toBeGreaterThan(0);
        for (const c of cases) expect(serviceIdFor(c.method, c.host, c.prefix)).toBe(c.id);
    });
    it("payment ids match the column check", () => {
        const ids = new Set(Array.from({ length: 1_000 }, () => newX402PaymentId()));
        expect(ids.size).toBe(1_000);
        for (const id of ids) expect(id).toMatch(PAYMENT_ID);
    });
    it("payment identifiers", () => {
        expect(newPaymentIdentifier()).toMatch(/^bn_[0-9a-f]{32}$/);
    });
    it("bugnetAddresses holds the four in a set", () => {
        const a = bugnetAddresses({
            feePayer: "F",
            allowanceWallet: "A",
            refundWallet: "R",
            recipient: "C",
        });
        expect([...a.all].sort()).toEqual(["A", "C", "F", "R"]);
        expect(a.allowanceWallet).toBe("A");
        expect(
            bugnetAddresses({
                feePayer: "F",
                allowanceWallet: "",
                refundWallet: "R",
                recipient: "C",
            }).all.has(""),
        ).toBe(false);
    });
});
