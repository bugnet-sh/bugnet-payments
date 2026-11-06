import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { orderRow } from "../testing/orders.ts";
import { goAvailable, runGoVector } from "../testing/go-vector.ts";
import {
    claimsFor,
    orderKey,
    orderPublicKeyBase64,
    signOrderToken,
    type OrderClaims,
} from "./token.ts";

const seed = Buffer.alloc(32, 7);
const at = new Date("2026-11-06T12:10:00.000Z");
const START =
    "v1.eyJvcmRlcl9pZCI6Im9yZF9hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYSIsImtpbmQiOiJzdGFydCIsInBhY2thZ2VfaWQiOiJjcHUtMi0yZy0xMG0iLCJhbW91bnRfbWljcm9zIjo1MDAwMCwiZXhwaXJlc19hdCI6IjIwMjYtMTEtMDZUMTI6MTA6MDAuMDAwWiJ9.xcufODyq28K0XzJqmS-uoAimARPU5c1e1hTXeCs3OHM7BojnuUSSuH0SYFTaRwkc2C4gfNrsSOdGAM5q8CU4Ag";
const EXTEND =
    "v1.eyJvcmRlcl9pZCI6Im9yZF9iYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsImtpbmQiOiJleHRlbmQiLCJwYWNrYWdlX2lkIjoiZXh0LTEwbSIsImFtb3VudF9taWNyb3MiOjIwMDAwLCJleHBpcmVzX2F0IjoiMjAyNi0xMS0wNlQxMjoxMDowMC4wMDBaIiwiaGFuZGxlX3NoYTI1NiI6IjZlODRmZjlmMWIwMzFiYzEyODQ5NGM5MWE5ZTAyODY1NzgwNDZlYjY0OTlkNmU0ZTg5YTk3MDgxM2IyOTgyYTUifQ.FAbIkAqicy0GMJG8ijnCKv4G9-xSgli3lHuO7xKi0mLkWjZ2akbmYLDEv2StCjwGOeaw31pX4bDpxcrpD75IBA";
const PUB = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";

describe("order token", () => {
    it("matches the start vector", () => {
        const o = orderRow({
            id: "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            kind: "start",
            packageId: "cpu-2-2g-10m",
            amountMicros: 50_000,
            handleSha256: null,
        });
        expect(signOrderToken(orderKey(seed), claimsFor(o, at))).toBe(START);
    });

    it("matches the extend vector", () => {
        const o = orderRow({
            id: "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb",
            kind: "extend",
            packageId: "ext-10m",
            amountMicros: 20_000,
            handleSha256: "6e84ff9f1b031bc128494c91a9e0286578046eb6499d6e4e89a970813b2982a5",
        });
        expect(signOrderToken(orderKey(seed), claimsFor(o, at))).toBe(EXTEND);
    });

    it("publishes the router public key", () => {
        expect(orderPublicKeyBase64(seed)).toBe(PUB);
    });

    it("puts no other claim in the token", () => {
        const seg = JSON.parse(Buffer.from(START.split(".")[1]!, "base64url").toString());
        expect(Object.keys(seg)).toEqual([
            "order_id",
            "kind",
            "package_id",
            "amount_micros",
            "expires_at",
        ]);
    });

    it("refuses a seed that is not 32 bytes", () => {
        expect(() => orderKey(Buffer.alloc(31))).toThrow("32 bytes");
    });

    it("refuses an extend order without a handle hash", () => {
        expect(() => claimsFor(orderRow({ kind: "extend", handleSha256: null }), at)).toThrow();
    });
});

const router = process.env.BUGNET_ROUTER_DIR ?? resolve("../bugnet-router");
describe.skipIf(!existsSync(join(router, "internal/ordertoken")) || !goAvailable())(
    "router verifier",
    () => {
        it("accepts our tokens and refuses an extra payer claim", () => {
            expect(runGoVector(router, START, PUB, "ok", new Date("2026-11-06T12:00:00Z"))).toBe(0);
            expect(runGoVector(router, EXTEND, PUB, "ok")).toBe(0);
            const withPayer = signOrderToken(orderKey(seed), {
                ...claimsFor(orderRow({}), at),
                payer: "x",
            } as OrderClaims);
            expect(runGoVector(router, withPayer, PUB, "malformed")).toBe(0);
        });
    },
);
