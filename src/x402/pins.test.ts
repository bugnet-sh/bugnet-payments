import { describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import { usdcAta } from "../solana/accounts.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { TEST_PAYTO, testIndex, usdcAccountAnswer } from "../testing/x402.ts";
import { SOLANA_MAINNET, USDC_MINT } from "../solana/constants.ts";
import { bugnetAddresses, serviceIdFor } from "./ids.ts";
import { checkPin, decideListed, type PinDeps } from "./pins.ts";
import type { SellerRules } from "./seller.ts";
import type { X402ServicePin } from "./types.ts";

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
const ok = createFakeRpc({ getAccountInfo: () => usdcAccountAnswer(TEST_PAYTO) });
const deps = (rpc: PinDeps["rpc"]): PinDeps => ({
    index: testIndex(),
    rpc,
    rules: RULES,
    rpcTimeoutMs: 1_000,
});
const ID = serviceIdFor("POST", "agent402.tools", "/v1/auto/");
function pin(over: Partial<X402ServicePin> = {}): X402ServicePin {
    return {
        serviceId: ID,
        method: "POST",
        host: "agent402.tools",
        prefix: "/v1/auto/",
        url: "https://agent402.tools/v1/auto/chat/completions",
        maxPriceMicros: 10_000,
        payTo: TEST_PAYTO,
        listed: "indexed",
        pinnedFrom: "probe",
        probe: { at: "2030-01-01T00:00:00.000Z", status: 402, accepted: BASE },
        ...over,
    };
}
const reason = async (p: X402ServicePin) => {
    const r = await checkPin(p, deps(ok));
    return "pinReason" in r ? r.pinReason : r;
};
const probe = (status: number, accepted: unknown) => ({ at: "x", status, accepted });

describe("checkPin", () => {
    it("checks pins in table order", async () => {
        expect(await reason(pin({ serviceId: "xs_aaaaaaaaaaaaaaaa", payTo: "0OIl" }))).toBe(
            "service_id_mismatch",
        );
        expect(await reason(pin({ payTo: A }))).toBe("payee_refused");
        expect(await reason(pin({ probe: probe(200, BASE) }))).toBe("no_402");
        expect(await reason(pin({ probe: probe(402, { ...BASE, payTo: OTHER }) }))).toBe(
            "payee_refused",
        );
        expect(await reason(pin({ probe: probe(402, { ...BASE, extra: { feePayer: F } }) }))).toBe(
            "fee_payer_refused",
        );
        expect(
            await reason(
                pin({
                    probe: probe(402, { ...BASE, extra: { ...BASE.extra, splits: [{}] } }),
                }),
            ),
        ).toBe("splits_unsupported");
        expect(await reason(pin({ pinnedFrom: "index", probe: probe(402, null) }))).toBe(
            "index_mismatch",
        );
        expect(await reason(pin({ pinnedFrom: "index", probe: probe(200, BASE) }))).toBe(
            "index_mismatch",
        );
        expect(
            await reason(pin({ pinnedFrom: "index", payTo: OTHER, probe: probe(200, null) })),
        ).toBe("index_mismatch");
    });

    it("accepts an index pin whose probe gave no 402", async () => {
        expect(
            await checkPin(pin({ pinnedFrom: "index", probe: probe(200, null) }), deps(ok)),
        ).toEqual({ ok: true, listed: "indexed", paidPath: null });
    });

    it("checks index_mismatch both ways", async () => {
        const weather = serviceIdFor("POST", "seller.example", "/weather/");
        expect(
            await reason(
                pin({
                    serviceId: weather,
                    host: "seller.example",
                    prefix: "/weather/",
                    url: "https://seller.example/weather/today",
                }),
            ),
        ).toBe("index_mismatch");
        expect(await checkPin(pin({ listed: "unlisted" }), deps(ok))).toEqual({
            ok: true,
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
        });
        expect(await checkPin(pin(), deps(ok))).toEqual({
            ok: true,
            listed: "indexed",
            paidPath: null,
        });
    });

    it("needs the payee's USDC account", async () => {
        const r = (answer: () => unknown) =>
            checkPin(pin(), deps(createFakeRpc({ getAccountInfo: answer })));
        expect(await r(() => ({ value: null }))).toEqual({
            ok: false,
            pinReason: "payee_no_usdc_account",
        });
        expect(await r(() => usdcAccountAnswer(TEST_PAYTO, { state: "frozen" }))).toMatchObject({
            pinReason: "payee_no_usdc_account",
        });
        expect(await r(() => usdcAccountAnswer(OTHER))).toMatchObject({
            pinReason: "payee_no_usdc_account",
        });
        expect(await r(() => usdcAccountAnswer(TEST_PAYTO, { mint: OTHER }))).toMatchObject({
            pinReason: "payee_no_usdc_account",
        });
        expect(await r(() => usdcAccountAnswer(TEST_PAYTO, { programOwner: OTHER }))).toMatchObject(
            { pinReason: "payee_no_usdc_account" },
        );
        expect(
            await r(() => {
                throw new Error("rpc down");
            }),
        ).toEqual({ ok: false, unavailable: true, cause: "Error" });
    });

    it("carries only the error class name, never its message", async () => {
        const r = await checkPin(
            pin(),
            deps(
                createFakeRpc({
                    getAccountInfo: () => {
                        throw new TypeError("https://rpc.example/?api-key=SECRET");
                    },
                }),
            ),
        );
        expect(r).toEqual({ ok: false, unavailable: true, cause: "TypeError" });
    });

    it("reads the USDC token account of the payee", async () => {
        const seen: unknown[] = [];
        const rpc = createFakeRpc({
            getAccountInfo: (addr: unknown) => {
                seen.push(addr);
                return usdcAccountAnswer(TEST_PAYTO);
            },
        });
        expect(await checkPin(pin(), deps(rpc))).toMatchObject({ ok: true });
        expect(seen).toEqual([await usdcAta(address(TEST_PAYTO))]);
    });
});

describe("decideListed", () => {
    it("stores indexed only when the pin says so and the index lists it", () => {
        const index = testIndex();
        expect(decideListed(pin(), index)).toEqual({ listed: "indexed", paidPath: null });
        expect(decideListed(pin({ listed: "unlisted" }), index)).toEqual({
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
        });
        expect(decideListed(pin({ payTo: OTHER }), index)).toEqual({
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
        });
    });
});
