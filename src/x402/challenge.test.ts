import { decodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { memoryLog, silentLog } from "../log.ts";
import { BlockhashCache } from "../solana/blockhash.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import {
    type ChallengeContext,
    challengeFor,
    payUrlFor,
    paymentRequiredHeaders,
    requirementsFor,
} from "./challenge.ts";

const RECIPIENT = (await testSigner(1)).address;
const FEE_PAYER = (await testSigner(2)).address;
const ALLOWANCE = (await testSigner(11)).address;
const ctx: ChallengeContext = {
    publicUrl: "https://pay.bugnet.sh",
    recipient: RECIPIENT,
    allowanceWallet: ALLOWANCE,
    feePayer: FEE_PAYER,
    transactionVersions: [0],
};
const order = {
    id: "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    amountMicros: 10_000,
    payInto: "cold" as const,
    description: "Bugnet sandbox 2 vCPU / 2 GiB, 10 min",
};

function cacheWith(blockhash: string, lastValidBlockHeight: bigint): BlockhashCache {
    return new BlockhashCache(
        createFakeRpc({
            getLatestBlockhash: () => ({ value: { blockhash, lastValidBlockHeight } }),
        }),
        8_000,
    );
}

const pr = await challengeFor(order, ctx, cacheWith("BH1", 900n), silentLog);

describe("x402 challenge", () => {
    it("binds the challenge to the order", () => {
        expect(pr).toEqual({
            x402Version: 2,
            resource: {
                url: "https://pay.bugnet.sh/o/ord_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                description: order.description,
                mimeType: "application/json",
            },
            accepts: [
                {
                    scheme: "exact",
                    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
                    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    amount: "10000",
                    payTo: RECIPIENT,
                    maxTimeoutSeconds: 300,
                    extra: {
                        feePayer: FEE_PAYER,
                        memo: order.id,
                        transactionVersions: [0],
                        recentBlockhash: "BH1",
                        lastValidBlockHeight: "900",
                    },
                },
            ],
        });
    });

    it("requirementsFor carries no blockhash hints", () => {
        expect(requirementsFor(order, ctx).extra).toEqual({
            feePayer: FEE_PAYER,
            memo: order.id,
            transactionVersions: [0],
        });
    });

    it("builds the pay url", () => {
        expect(payUrlFor("https://pay.bugnet.sh", order.id)).toBe(
            "https://pay.bugnet.sh/o/ord_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
    });

    it("serves the challenge without hints when the RPC fails", async () => {
        const log = memoryLog();
        const down = new BlockhashCache(
            createFakeRpc({
                getLatestBlockhash: () => {
                    throw new Error("down");
                },
            }),
            8_000,
        );
        const res = await challengeFor(order, ctx, down, log);
        expect(res.accepts[0]!.extra).not.toHaveProperty("recentBlockhash");
        expect(res.accepts[0]!.extra).not.toHaveProperty("lastValidBlockHeight");
        expect(log.lines.some((l) => l.msg === "blockhash unavailable")).toBe(true);
    });

    it("encodes the header and forbids caching", () => {
        const h = paymentRequiredHeaders(pr);
        expect(decodePaymentRequiredHeader(h["PAYMENT-REQUIRED"]!)).toEqual(pr);
        expect(h["Cache-Control"]).toBe("no-store");
    });

    it("pays into the hot wallet exactly when pay_into is allowance", () => {
        const id = order.id;
        expect(
            requirementsFor({ id, amountMicros: 1_003_000, payInto: "allowance" }, ctx).payTo,
        ).toBe(ALLOWANCE);
        expect(requirementsFor({ id, amountMicros: 10_000, payInto: "cold" }, ctx).payTo).toBe(
            RECIPIENT,
        );
    });
});
