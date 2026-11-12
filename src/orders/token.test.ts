import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { orderRow } from "../testing/orders.ts";
import type { OrderRow } from "./types.ts";
import { goAvailable, runGoVector } from "../testing/go-vector.ts";
import {
    claimsFor,
    orderKey,
    orderPublicKeyBase64,
    paymentProof,
    signOrderToken,
    type OrderClaims,
} from "./token.ts";

const seed = Buffer.alloc(32, 7);
const PAYER = getBase58Decoder().decode(Buffer.alloc(32, 9));
const FEE_PAYER = getBase58Decoder().decode(Buffer.alloc(32, 5));
const TX = getBase58Decoder().decode(Buffer.alloc(64, 3));
const at = new Date("2026-11-06T12:10:00.000Z");
const OFF = { allowance: false, fee: false };
const ALLOWANCE = { allowance: true, fee: false };
const BOTH = { allowance: true, fee: true };
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
        expect(signOrderToken(orderKey(seed), claimsFor(o, at, OFF))).toBe(START);
    });

    it("matches the extend vector", () => {
        const o = orderRow({
            id: "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb",
            kind: "extend",
            packageId: "ext-10m",
            amountMicros: 20_000,
            handleSha256: "6e84ff9f1b031bc128494c91a9e0286578046eb6499d6e4e89a970813b2982a5",
        });
        expect(signOrderToken(orderKey(seed), claimsFor(o, at, OFF))).toBe(EXTEND);
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
        expect(() =>
            claimsFor(orderRow({ kind: "extend", handleSha256: null }), at, OFF),
        ).toThrow();
    });
});

describe("allowance_micros claim", () => {
    const start = (over: Partial<OrderRow> = {}) =>
        orderRow({
            kind: "start",
            payInto: "allowance",
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            amountMicros: 1_013_000,
            ...over,
        });

    it("signs allowance_micros on start tokens only while the claim is on", () => {
        expect(claimsFor(start(), at, ALLOWANCE).allowance_micros).toBe(1_000_000);
        expect("allowance_micros" in claimsFor(start(), at, OFF)).toBe(false);
        const extend = orderRow({ kind: "extend", handleSha256: "ab".repeat(32) });
        expect("allowance_micros" in claimsFor(extend, at, ALLOWANCE)).toBe(false);
        const cold = orderRow({ kind: "start" });
        expect("allowance_micros" in claimsFor(cold, at, ALLOWANCE)).toBe(false);
        const allowance = orderRow({
            kind: "allowance",
            handleSha256: "ab".repeat(32),
            payInto: "allowance",
            allowanceMicros: 1_000_000,
            amountMicros: 1_000_000,
        });
        expect(() => claimsFor(allowance, at, ALLOWANCE)).toThrow(
            "allowance orders carry no token",
        );
    });

    it("adds issued_at last on a start token when given", () => {
        const proof = { payer: PAYER, feePayer: FEE_PAYER, tx: TX };
        const issued = new Date("2026-11-06T12:00:01.250Z");
        const claims = claimsFor(start(), at, ALLOWANCE, proof, issued);
        expect(Object.keys(claims).at(-1)).toBe("issued_at");
        expect(claims.issued_at).toBe("2026-11-06T12:00:01.250Z");
        expect("issued_at" in claimsFor(start(), at, ALLOWANCE, proof)).toBe(false);
    });

    it("never puts issued_at on an extend token", () => {
        const extend = orderRow({ kind: "extend", packageId: "ext-10m", handleSha256: "ab" });
        expect("issued_at" in claimsFor(extend, at, OFF, undefined, at)).toBe(false);
    });

    it("puts allowance_micros last", () => {
        expect(Object.keys(claimsFor(start(), at, ALLOWANCE))).toEqual([
            "order_id",
            "kind",
            "package_id",
            "amount_micros",
            "expires_at",
            "allowance_micros",
        ]);
    });

    it("adds payer, fee_payer and tx after the existing claims when given", () => {
        const proof = { payer: PAYER, feePayer: FEE_PAYER, tx: TX };
        expect(Object.keys(claimsFor(start(), at, ALLOWANCE, proof))).toEqual([
            "order_id",
            "kind",
            "package_id",
            "amount_micros",
            "expires_at",
            "allowance_micros",
            "payer",
            "fee_payer",
            "tx",
        ]);
        expect(claimsFor(start(), at, OFF, proof)).toMatchObject({
            payer: PAYER,
            fee_payer: FEE_PAYER,
            tx: TX,
        });
    });

    it("keeps the claim set unchanged when no proof is given", () => {
        expect(Object.keys(claimsFor(start(), at, OFF))).toEqual([
            "order_id",
            "kind",
            "package_id",
            "amount_micros",
            "expires_at",
        ]);
        expect(Object.keys(claimsFor(start(), at, OFF, undefined))).toHaveLength(5);
    });

    it("signs fee_micros on start tokens with a fee only while the claim is on", () => {
        expect(claimsFor(start(), at, BOTH).fee_micros).toBe(3_000);
        expect("fee_micros" in claimsFor(start(), at, ALLOWANCE)).toBe(false);
        expect("fee_micros" in claimsFor(start({ feeMicros: 0 }), at, BOTH)).toBe(false);
        const extend = orderRow({
            kind: "extend",
            handleSha256: "ab".repeat(32),
            feeMicros: 3_000,
        });
        expect("fee_micros" in claimsFor(extend, at, BOTH)).toBe(false);
    });

    it("puts fee_micros after allowance_micros and before the payer claims", () => {
        const proof = { payer: PAYER, feePayer: FEE_PAYER, tx: TX };
        const issued = new Date("2026-11-06T12:00:01.250Z");
        expect(Object.keys(claimsFor(start(), at, BOTH, proof, issued))).toEqual([
            "order_id",
            "kind",
            "package_id",
            "amount_micros",
            "expires_at",
            "allowance_micros",
            "fee_micros",
            "payer",
            "fee_payer",
            "tx",
            "issued_at",
        ]);
    });
});

describe("paymentProof", () => {
    it("returns the three values when all are canonical", () => {
        expect(paymentProof(PAYER, FEE_PAYER, TX)).toEqual({
            payer: PAYER,
            feePayer: FEE_PAYER,
            tx: TX,
        });
    });

    it("returns undefined when any one is missing or not canonical", () => {
        expect(paymentProof(undefined, FEE_PAYER, TX)).toBeUndefined();
        expect(paymentProof(PAYER, "", TX)).toBeUndefined();
        expect(paymentProof(PAYER, FEE_PAYER, undefined)).toBeUndefined();
        expect(paymentProof("P", FEE_PAYER, TX)).toBeUndefined();
        expect(paymentProof(PAYER, "not base58!", TX)).toBeUndefined();
        expect(paymentProof(PAYER, FEE_PAYER, PAYER)).toBeUndefined();
    });
});

const router = process.env.BUGNET_ROUTER_DIR ?? resolve("../bugnet-router");
// Prod router d7cc8df decodes strictly and has no fee_micros; feat/pricing-groundwork adds it
const routerHasFee = ((): boolean => {
    try {
        return readFileSync(join(router, "internal/ordertoken/ordertoken.go"), "utf8").includes(
            'json:"fee_micros',
        );
    } catch {
        return false;
    }
})();
describe.skipIf(!existsSync(join(router, "internal/ordertoken")) || !goAvailable())(
    "router verifier",
    () => {
        it("accepts our tokens and refuses an extra payer claim", () => {
            expect(runGoVector(router, START, PUB, "ok", new Date("2026-11-06T12:00:00Z"))).toBe(0);
            expect(runGoVector(router, EXTEND, PUB, "ok")).toBe(0);
            const withPayer = signOrderToken(orderKey(seed), {
                ...claimsFor(orderRow({}), at, OFF),
                payer: "x",
            } as OrderClaims);
            expect(runGoVector(router, withPayer, PUB, "malformed")).toBe(0);
        });

        it("accepts allowance_micros, payer, fee_payer and tx once router Task 28 runs", () => {
            const proof = { payer: PAYER, feePayer: FEE_PAYER, tx: TX };
            const now = new Date("2026-11-06T12:00:00Z");
            const start = orderRow({
                id: "ord_cccccccccccccccccccccccccc",
                kind: "start",
                packageId: "cpu-2-2g-10m",
                amountMicros: 1_050_000,
                allowanceMicros: 1_000_000,
                handleSha256: null,
            });
            const extend = orderRow({
                id: "ord_dddddddddddddddddddddddddd",
                kind: "extend",
                packageId: "ext-10m",
                amountMicros: 20_000,
                handleSha256: "6e84ff9f1b031bc128494c91a9e0286578046eb6499d6e4e89a970813b2982a5",
            });
            const key = orderKey(seed);
            const both = signOrderToken(key, claimsFor(start, at, ALLOWANCE, proof));
            const extended = signOrderToken(key, claimsFor(extend, at, ALLOWANCE, proof));
            expect(runGoVector(router, both, PUB, "ok", now)).toBe(0);
            expect(runGoVector(router, extended, PUB, "ok", now)).toBe(0);
        });

        it("accepts issued_at once the router has 95d7c49", () => {
            const now = new Date("2026-11-06T12:00:00Z");
            const proof = { payer: PAYER, feePayer: FEE_PAYER, tx: TX };
            const claims = claimsFor(orderRow({}), at, OFF, proof, now);
            const token = signOrderToken(orderKey(seed), claims);
            expect(runGoVector(router, token, PUB, "ok", now)).toBe(0);
        });

        const now = new Date("2026-11-06T12:00:00Z");
        const feeStart = orderRow({
            id: "ord_eeeeeeeeeeeeeeeeeeeeeeeeee",
            kind: "start",
            packageId: "cpu-2-2g-10m",
            amountMicros: 1_053_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            payInto: "allowance",
            handleSha256: null,
        });
        const feeToken = (over: Partial<OrderClaims> = {}): string =>
            signOrderToken(orderKey(seed), {
                ...claimsFor(
                    feeStart,
                    at,
                    BOTH,
                    { payer: PAYER, feePayer: FEE_PAYER, tx: TX },
                    now,
                ),
                ...over,
            });

        it.skipIf(routerHasFee)(
            "a router without fee_micros refuses it, so fee_claim stays off",
            () => {
                expect(runGoVector(router, feeToken(), PUB, "malformed", now)).toBe(0);
            },
        );

        it.skipIf(!routerHasFee)("accepts fee_micros up to the amount less the allowance", () => {
            expect(runGoVector(router, feeToken(), PUB, "ok", now)).toBe(0);
            expect(runGoVector(router, feeToken({ fee_micros: 53_000 }), PUB, "ok", now)).toBe(0);
            expect(
                runGoVector(router, feeToken({ fee_micros: 53_001 }), PUB, "malformed", now),
            ).toBe(0);
        });
    },
);
