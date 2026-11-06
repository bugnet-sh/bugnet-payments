import {
    getBase64Encoder,
    getTransactionDecoder,
    getTransactionEncoder,
    type KeyPairSigner,
    partiallySignTransaction,
} from "@solana/kit";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";
import { TEST_BLOCKHASH, TEST_LVBH } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { buildPaymentTransaction } from "../x402/build.ts";
import { requirementsFor } from "../x402/challenge.ts";
import { describeResult, payWithWallet, type WalletPort } from "./flow.ts";

const id = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const orderUrl = `https://pay.bugnet.sh/o/${id}`;

let payer: KeyPairSigner;
let accepts: PaymentRequirements;

beforeAll(async () => {
    payer = await testSigner(3);
    const req = requirementsFor(
        { id, amountMicros: 10_000 },
        {
            publicUrl: "https://pay.bugnet.sh",
            recipient: (await testSigner(1)).address,
            feePayer: (await testSigner(5)).address,
            transactionVersions: [0],
        },
    );
    accepts = {
        ...req,
        extra: {
            ...req.extra,
            recentBlockhash: TEST_BLOCKHASH,
            lastValidBlockHeight: String(TEST_LVBH),
        },
    };
});

function challenge(req: PaymentRequirements): PaymentRequired {
    return {
        x402Version: 2,
        resource: { url: orderUrl, description: "Bugnet sandbox", mimeType: "application/json" },
        accepts: [req],
    };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

interface Script {
    order?: () => Response;
    submit?: () => Response;
    statuses?: (() => Response)[];
}

function harness(script: Script = {}) {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const submitted: string[] = [];
    const signInputs: Parameters<WalletPort["signTransaction"]>[0][] = [];
    const statuses = [...(script.statuses ?? [])];
    const account = { address: payer.address };
    const w = {
        account,
        signedBytes: new Uint8Array(),
        async connect() {
            calls.push("connect");
            return account;
        },
        async signTransaction(i: Parameters<WalletPort["signTransaction"]>[0]) {
            calls.push("signTransaction");
            signInputs.push(i);
            const tx = getTransactionDecoder().decode(i.transaction);
            const signed = await partiallySignTransaction([payer.keyPair], tx);
            w.signedBytes = new Uint8Array(getTransactionEncoder().encode(signed));
            return [{ signedTransaction: w.signedBytes }];
        },
    };
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const method = init?.method ?? "GET";
        if (url === `${orderUrl}/status`) {
            calls.push(`${method} status`);
            const next = statuses.shift();
            if (next === undefined) return json(200, { orderId: id, state: "settling" });
            return next();
        }
        expect(url).toBe(orderUrl);
        const signature = headers.get("payment-signature");
        if (signature !== null) {
            calls.push(`${method} payment-signature`);
            submitted.push(signature);
            return (script.submit ?? (() => json(200, { paid: true, orderId: id })))();
        }
        calls.push(`${method} accept:${headers.get("accept")}`);
        const pr = challenge(accepts);
        return (
            script.order ??
            (() => json(402, pr, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) }))
        )();
    }) as typeof fetch;
    const sleep = async (ms: number) => {
        sleeps.push(ms);
    };
    return { calls, sleeps, submitted, signInputs, w, f, sleep };
}

describe("payWithWallet", () => {
    it("refetches the challenge just before signing", async () => {
        const { calls, w, f, sleep } = harness();
        expect(await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep })).toBe("paid");
        expect(calls).toEqual([
            "connect",
            "GET accept:application/json",
            "signTransaction",
            "GET payment-signature",
        ]);
    });

    it("asks the wallet to sign the payment built from the refetched challenge", async () => {
        const { signInputs, w, f, sleep } = harness();
        await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep });
        expect(signInputs).toHaveLength(1);
        const input = signInputs[0]!;
        expect(input.account).toBe(w.account);
        expect(input.chain).toBe("solana:mainnet");
        const expected = getTransactionEncoder().encode(
            await buildPaymentTransaction(accepts, payer.address),
        );
        expect(input.transaction).toEqual(new Uint8Array(expected));
    });

    it("submits the wallet's signed bytes unchanged", async () => {
        const { submitted, w, f, sleep } = harness();
        await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep });
        expect(submitted).toHaveLength(1);
        const sent = decodePaymentSignatureHeader(submitted[0]!);
        expect(sent).toEqual({
            x402Version: 2,
            resource: challenge(accepts).resource,
            accepted: accepts,
            payload: { transaction: Buffer.from(w.signedBytes).toString("base64") },
        });
        expect(
            new Uint8Array(getBase64Encoder().encode(sent.payload.transaction as string)),
        ).toEqual(w.signedBytes);
    });

    it("polls status every 2 s after a 202", async () => {
        const settling = () => json(200, { orderId: id, state: "settling" });
        const { calls, sleeps, w, f, sleep } = harness({
            submit: () => json(202, { state: "settling", orderId: id }),
            statuses: [settling, settling, () => json(200, { orderId: id, state: "paid" })],
        });
        expect(await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep })).toBe("paid");
        expect(sleeps).toEqual([2000, 2000, 2000]);
        expect(calls.slice(-3)).toEqual(["GET status", "GET status", "GET status"]);
    });

    it("keeps polling through a failed status call", async () => {
        const { sleeps, w, f, sleep } = harness({
            submit: () => json(202, { state: "settling", orderId: id }),
            statuses: [
                () => json(429, { error: "too_many_requests" }),
                () => {
                    throw new TypeError("network error");
                },
                () => json(200, { orderId: id, state: "paid" }),
            ],
        });
        expect(await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep })).toBe("paid");
        expect(sleeps).toEqual([2000, 2000, 2000]);
    });

    it("gives up settling after 120 s", async () => {
        const { calls, sleeps, w, f, sleep } = harness({
            submit: () => json(202, { state: "settling", orderId: id }),
        });
        expect(await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep })).toBe(
            "settling_timeout",
        );
        expect(sleeps).toEqual(new Array(60).fill(2000));
        expect(calls.filter((c) => c === "GET status")).toHaveLength(60);
    });

    it("stops polling when the order leaves settling without being paid", async () => {
        const { w, f, sleep } = harness({
            submit: () => json(202, { state: "settling", orderId: id }),
            statuses: [() => json(200, { orderId: id, state: "unpaid" })],
        });
        expect(await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep })).toEqual({
            refused: "order_unpaid",
        });
    });

    it("answers network_busy without hints and never asks the wallet to sign", async () => {
        const extra = { ...accepts.extra };
        delete extra.recentBlockhash;
        delete extra.lastValidBlockHeight;
        const blockhashless = challenge({ ...accepts, extra });
        const { calls, w, f, sleep } = harness({
            order: () =>
                json(402, blockhashless, {
                    "PAYMENT-REQUIRED": encodePaymentRequiredHeader(blockhashless),
                }),
        });
        expect(await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep })).toBe("network_busy");
        expect(calls).toEqual(["connect", "GET accept:application/json"]);
    });

    it("fails without signing when the challenge header is unreadable", async () => {
        const header = Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64");
        const { calls, w, f, sleep } = harness({
            order: () => json(402, {}, { "PAYMENT-REQUIRED": header }),
        });
        await expect(payWithWallet({ fetch: f, wallet: w, orderUrl, sleep })).rejects.toThrow(
            "the order answered an unreadable payment challenge",
        );
        expect(calls).not.toContain("signTransaction");
    });

    it("refuses with the most specific reason a 4xx gives", async () => {
        const simulation = harness({
            submit: () =>
                json(422, {
                    refused: "payment_invalid",
                    orderId: id,
                    code: "invalid_exact_svm_transaction_simulation_failed",
                }),
        });
        expect(
            await payWithWallet({
                fetch: simulation.f,
                wallet: simulation.w,
                orderUrl,
                sleep: simulation.sleep,
            }),
        ).toEqual({ refused: "invalid_exact_svm_transaction_simulation_failed" });

        const blocked = harness({
            submit: () => json(403, { refused: "payer_blocked", orderId: id }),
        });
        expect(
            await payWithWallet({
                fetch: blocked.f,
                wallet: blocked.w,
                orderUrl,
                sleep: blocked.sleep,
            }),
        ).toEqual({ refused: "payer_blocked" });
    });

    it("never signs when the refetch shows the order is no longer payable", async () => {
        const expired = harness({
            order: () => json(410, { error: "order_expired", orderId: id }),
        });
        expect(
            await payWithWallet({
                fetch: expired.f,
                wallet: expired.w,
                orderUrl,
                sleep: expired.sleep,
            }),
        ).toEqual({ refused: "order_expired" });
        expect(expired.calls).not.toContain("signTransaction");

        const paid = harness({ order: () => json(200, { paid: true, orderId: id }) });
        expect(
            await payWithWallet({ fetch: paid.f, wallet: paid.w, orderUrl, sleep: paid.sleep }),
        ).toBe("paid");
        expect(paid.calls).not.toContain("signTransaction");
    });
});

describe("describeResult", () => {
    it("explains each result to the payer", () => {
        expect(describeResult("network_busy")).toBe("network busy, try again");
        expect(describeResult({ refused: "invalid_exact_svm_transaction_simulation_failed" })).toBe(
            "the wallet lacks USDC or the payment expired, try again",
        );
        expect(describeResult("paid")).toBe("paid");
        expect(describeResult("settling_timeout")).toBe(
            "the payment is still settling, check this page again in a minute",
        );
        expect(describeResult({ refused: "order_unpaid" })).toBe(
            "the payment did not land, try again",
        );
        expect(describeResult({ refused: "payer_blocked" })).toBe("payment refused: payer_blocked");
    });
});
