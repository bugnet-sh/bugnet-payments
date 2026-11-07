import { describe, expect, it } from "vitest";
import { SOLANA_MAINNET, USDC_MINT } from "../solana/constants.ts";
import { RECORDED_402, TEST_PAYTO } from "../testing/x402.ts";
import { testSigner } from "../testing/keys.ts";
import { bugnetAddresses } from "./ids.ts";
import {
    checkEntry,
    chooseEntry,
    decodeChallenge,
    rawMembers,
    type DecodedChallenge,
    type PinTerms,
    type SellerRules,
} from "./seller.ts";

const F = (await testSigner(5)).address;
const A = (await testSigner(11)).address;
const OTHER = (await testSigner(20)).address;
const B = bugnetAddresses({
    feePayer: F,
    allowanceWallet: A,
    refundWallet: (await testSigner(6)).address,
    recipient: (await testSigner(1)).address,
});
const RULES: SellerRules = { bugnet: B.all, sellerMemoMaxBytes: 32 };
const BASE = {
    scheme: "exact",
    network: SOLANA_MAINNET,
    asset: USDC_MINT,
    amount: "10000",
    payTo: TEST_PAYTO,
    maxTimeoutSeconds: 60,
    extra: { feePayer: "11111111111111111111111111111112" },
};
const check = (e: object) => checkEntry(e, JSON.stringify(e), RULES);
const code = (e: object) => {
    const r = check(e);
    return r.ok ? "ok" : r.code;
};
const extra = (x: object) => ({ ...BASE, extra: { ...BASE.extra, ...x } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const decoded = (entries: object[]) =>
    decodeChallenge(
        b64({ x402Version: 2, resource: { url: "https://s.example/a" }, accepts: entries }),
    ) as DecodedChallenge;
const terms = (over: Partial<PinTerms> = {}): PinTerms => ({
    payTo: TEST_PAYTO,
    maxPriceMicros: 10_000,
    maxPricePerCallMicros: 500_000,
    blocked: new Set(),
    ...over,
});

describe("checkEntry", () => {
    it("refuses each 7.8 row with its code", () => {
        expect(code({ ...BASE, network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" })).toBe(
            "network_unsupported",
        );
        expect(code({ ...BASE, asset: TEST_PAYTO })).toBe("network_unsupported");
        expect(code({ ...BASE, scheme: "upto" })).toBe("flow_unsupported");
        expect(code({ ...BASE, payTo: "0OIl" })).toBe("payee_refused");
        expect(code({ ...BASE, payTo: F })).toBe("payee_refused");
        expect(code({ ...BASE, extra: {} })).toBe("fee_payer_refused");
        expect(code(extra({ feePayer: A }))).toBe("fee_payer_refused");
        expect(code(extra({ splits: [{}] }))).toBe("splits_unsupported");
        expect(code(extra({ splits: [] }))).toBe("ok");
        expect(code(extra({ paymentFlow: "authorization" }))).toBe("ok");
        expect(code(extra({ paymentFlow: "upfront" }))).toBe("ok");
        expect(code(extra({ paymentFlow: "escrow" }))).toBe("flow_unsupported");
        expect(code(extra({ assetTransferMethod: "default" }))).toBe("ok");
        expect(code(extra({ assetTransferMethod: "permit2" }))).toBe("flow_unsupported");
        expect(code(extra({ transactionVersions: [1] }))).toBe("flow_unsupported");
        expect(code(extra({ transactionVersions: [0, 1] }))).toBe("ok");
        expect(code(extra({ ataCreationRequired: true }))).toBe("ata_creation_unsupported");
        expect(code(extra({ memo: "a".repeat(32) }))).toBe("ok");
        expect(code(extra({ memo: "a".repeat(33) }))).toBe("flow_unsupported");
        expect(code(extra({ memo: "é".repeat(16) }))).toBe("ok");
        expect(code(extra({ memo: "é".repeat(17) }))).toBe("flow_unsupported");
    });

    it("counts the rows passed before the failure", () => {
        const passed = (e: unknown) => {
            const r = checkEntry(e, "", RULES);
            return r.ok ? -1 : r.passed;
        };
        expect(passed("not an object")).toBe(0);
        expect(passed({ ...BASE, asset: TEST_PAYTO })).toBe(1);
        expect(passed({ ...BASE, amount: "0" })).toBe(3);
        expect(passed({ ...BASE, extra: {} })).toBe(5);
        expect(passed(extra({ memo: "a".repeat(33) }))).toBe(11);
    });

    it("keeps the entry's text and reads memo, payee and fee payer", () => {
        const e = extra({ memo: "m1" });
        const r = checkEntry(e, "SOURCE", RULES);
        expect(r).toEqual({
            ok: true,
            entry: {
                amountMicros: 10_000n,
                payTo: TEST_PAYTO,
                feePayer: "11111111111111111111111111111112",
                memo: "m1",
                json: "SOURCE",
            },
        });
        const plain = check(BASE);
        expect(plain.ok && plain.entry.memo).toBeNull();
    });

    it("only canonical decimal amounts pass", () => {
        for (const amount of ["0", "-1", "010000", "1e4", " 10000", "10000.0"]) {
            expect(code({ ...BASE, amount })).toBe("price_above_max");
        }
        const big = check({ ...BASE, amount: "9007199254740993" });
        expect(big.ok && big.entry.amountMicros).toBe(9007199254740993n);
        const c = decoded([{ ...BASE, amount: "9007199254740993" }]);
        expect(chooseEntry(c, terms({ maxPriceMicros: 10_000 }), RULES)).toEqual({
            ok: false,
            code: "price_above_max",
            askedMicros: 9007199254740993n,
        });
    });
});

describe("decodeChallenge", () => {
    it("decodes only standard base64 of a version 2 object", () => {
        expect(decodeChallenge("%%%")).toEqual({ refusal: "not_x402" });
        expect(decodeChallenge("")).toEqual({ refusal: "not_x402" });
        expect(decodeChallenge("ab-_")).toEqual({ refusal: "not_x402" });
        expect(decodeChallenge(b64([1, 2]))).toEqual({ refusal: "not_x402" });
        expect(
            decodeChallenge(
                b64({ x402Version: 2, resource: { pad: "a".repeat(30_000) }, accepts: [BASE] }),
            ),
        ).toEqual({ refusal: "not_x402" });
        expect(
            decodeChallenge(b64({ x402Version: 2, resource: {}, accepts: Array(33).fill(BASE) })),
        ).toEqual({ refusal: "not_x402" });
        expect(decodeChallenge(b64({ x402Version: 2, accepts: [BASE] }))).toEqual({
            refusal: "not_x402",
        });
        expect(decodeChallenge(b64({ x402Version: 2, resource: {}, accepts: {} }))).toEqual({
            refusal: "not_x402",
        });
        expect(decodeChallenge(b64({ x402Version: 1, resource: {}, accepts: [BASE] }))).toEqual({
            refusal: "version_unsupported",
        });
    });

    it("refuses bytes that are not UTF-8 or not JSON", () => {
        const bytes = (b: number[]) => Buffer.from(b).toString("base64");
        expect(decodeChallenge(bytes([0xff, 0xfe, 0x7b, 0x7d]))).toEqual({ refusal: "not_x402" });
        expect(decodeChallenge(bytes([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toEqual({
            refusal: "not_x402",
        });
        expect(decodeChallenge(Buffer.from("{nope").toString("base64"))).toEqual({
            refusal: "not_x402",
        });
    });

    it("returns extensions as an object or null", () => {
        const withExt = decodeChallenge(
            b64({ x402Version: 2, resource: {}, accepts: [], extensions: { bazaar: 1 } }),
        ) as DecodedChallenge;
        expect(withExt.extensions).toEqual({ bazaar: 1 });
        expect(decoded([]).extensions).toBeNull();
    });
});

describe("rawMembers", () => {
    it("keeps the source bytes", () => {
        const text =
            '{"x402Version":2,"resource":{"url":"https://s.example/a","b":1,  "a":"é"},"accepts":[ {"scheme":"exact" ,"amount":"10000"} ]}';
        expect(rawMembers(text)).toEqual({
            resource: '{"url":"https://s.example/a","b":1,  "a":"é"}',
            accepts: ['{"scheme":"exact" ,"amount":"10000"}'],
        });
        const d = decodeChallenge(Buffer.from(text, "utf8").toString("base64"));
        expect("refusal" in d ? null : d.resourceJson).toBe(
            '{"url":"https://s.example/a","b":1,  "a":"é"}',
        );
    });

    it("ignores braces and quotes inside strings and nested members", () => {
        const text =
            '{"extensions":{"resource":{"x":1},"accepts":[9]},"accepts":[{"a":"}\\"]"},"s",[1,[2]],7],"resource":"r}"}';
        expect(rawMembers(text)).toEqual({
            resource: '"r}"',
            accepts: ['{"a":"}\\"]"}', '"s"', "[1,[2]]", "7"],
        });
    });

    it("takes the last occurrence of a repeated key", () => {
        const text = '{"resource":{"a":1},"accepts":[1,2],"resource":{"a":2},"accepts":[3]}';
        expect(rawMembers(text)).toEqual({ resource: '{"a":2}', accepts: ["3"] });
        expect(rawMembers('{"accepts":[1],"accepts":5,"resource":1}').accepts).toEqual([]);
    });

    it("reads a key written with an escape", () => {
        expect(rawMembers('{"\\u0072esource":{"k":1},"accepts":[]}').resource).toBe('{"k":1}');
    });
});

describe("chooseEntry", () => {
    it("picks the price tier that fits", () => {
        const c = decoded([
            { ...BASE, amount: "20000" },
            { ...BASE, amount: "10000" },
        ]);
        expect(chooseEntry(c, terms({ maxPriceMicros: 10_000 }), RULES)).toMatchObject({
            ok: true,
            index: 1,
        });
    });

    it("picks the pinned payTo over a new one", () => {
        expect(
            chooseEntry(decoded([{ ...BASE, payTo: OTHER }, BASE]), terms(), RULES),
        ).toMatchObject({ ok: true, index: 1 });
    });

    it("answers the furthest entry's first failure, the earliest on a tie", () => {
        const c = decoded([
            { ...BASE, network: "solana:x" },
            { ...BASE, payTo: OTHER },
        ]);
        expect(chooseEntry(c, terms(), RULES)).toMatchObject({ ok: false, code: "payee_changed" });
        const tie = decoded([
            { ...BASE, amount: "20000" },
            { ...BASE, amount: "30000" },
        ]);
        expect(chooseEntry(tie, terms({ maxPriceMicros: 10_000 }), RULES)).toEqual({
            ok: false,
            code: "price_above_max",
            askedMicros: 20_000n,
        });
    });

    it("answers no amount when row 4 did not pass", () => {
        expect(chooseEntry(decoded([{ ...BASE, amount: "0" }]), terms(), RULES)).toEqual({
            ok: false,
            code: "price_above_max",
            askedMicros: 0n,
        });
        expect(chooseEntry(decoded([]), terms(), RULES)).toMatchObject({
            ok: false,
            askedMicros: 0n,
        });
    });

    it("refuses a blocked payTo", () => {
        expect(
            chooseEntry(decoded([BASE]), terms({ blocked: new Set([TEST_PAYTO]) }), RULES),
        ).toMatchObject({ ok: false, code: "payto_blocked" });
    });

    it("binds the per-call ceiling", () => {
        const c = decoded([{ ...BASE, amount: "600000" }]);
        expect(
            chooseEntry(
                c,
                terms({ maxPriceMicros: 600_000, maxPricePerCallMicros: 500_000 }),
                RULES,
            ),
        ).toMatchObject({ ok: false, code: "price_above_max", askedMicros: 600_000n });
    });

    it("decodes a recorded 402 and chooses its exact Solana entry", () => {
        const d = decodeChallenge(RECORDED_402.header);
        expect("refusal" in d).toBe(false);
        expect(
            chooseEntry(
                d as DecodedChallenge,
                terms({ payTo: RECORDED_402.payTo, maxPriceMicros: RECORDED_402.amountMicros }),
                RULES,
            ),
        ).toMatchObject({ ok: true, index: RECORDED_402.index });
        expect(
            chooseEntry(
                d as DecodedChallenge,
                terms({
                    payTo: RECORDED_402.payTo,
                    maxPriceMicros: RECORDED_402.amountMicros - 1,
                }),
                RULES,
            ),
        ).toMatchObject({ ok: false, code: "price_above_max" });
    });
});
