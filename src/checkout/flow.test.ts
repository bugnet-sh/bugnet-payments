import {
    appendTransactionMessageInstruction,
    compileTransaction,
    decompileTransactionMessage,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    getTransactionEncoder,
    type Instruction,
    type KeyPairSigner,
    partiallySignTransaction,
} from "@solana/kit";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";
import { LIGHTHOUSE_PROGRAM } from "../solana/constants.ts";
import { TEST_BLOCKHASH, TEST_LVBH } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { buildPaymentTransaction } from "../x402/build.ts";
import { requirementsFor } from "../x402/challenge.ts";
import { pageStep, payWithWallet, stateStep, type WalletPort, watchOrder } from "./flow.ts";

const id = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const orderUrl = `https://pay.bugnet.sh/o/${id}`;
const lighthouse: Instruction = { programAddress: LIGHTHOUSE_PROGRAM, data: new Uint8Array([9]) };

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
        // Like Phantom, it appends a Lighthouse instruction before signing
        async signTransaction(i: Parameters<WalletPort["signTransaction"]>[0]) {
            calls.push("signTransaction");
            signInputs.push(i);
            const given = getTransactionDecoder().decode(i.transaction);
            const message = appendTransactionMessageInstruction(
                lighthouse,
                decompileTransactionMessage(
                    getCompiledTransactionMessageDecoder().decode(given.messageBytes),
                ),
            );
            const signed = await partiallySignTransaction(
                [payer.keyPair],
                compileTransaction(message),
            );
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
        const built = await buildPaymentTransaction(accepts, payer.address);
        const rebuilt = getTransactionEncoder().encode(
            await partiallySignTransaction([payer.keyPair], built),
        );
        expect(w.signedBytes).not.toEqual(new Uint8Array(rebuilt));
        const walletTx = getTransactionDecoder().decode(w.signedBytes);
        expect(walletTx.messageBytes).not.toEqual(built.messageBytes);
        const walletIxs = decompileTransactionMessage(
            getCompiledTransactionMessageDecoder().decode(walletTx.messageBytes),
        ).instructions;
        expect(walletIxs).toHaveLength(5);
        expect(walletIxs[4]!.programAddress).toBe(LIGHTHOUSE_PROGRAM);

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

    const b64 = (text: string) => Buffer.from(text).toString("base64");
    it.each([
        ["no header", undefined],
        ["an empty header", ""],
        ["a header that is not base64", "%%% not base64 %%%"],
        ["base64 that is not JSON", b64("not json")],
        ["a null resource", b64(JSON.stringify({ x402Version: 2, resource: null, accepts: [] }))],
        ["no accepts", b64(JSON.stringify({ x402Version: 2, resource: { url: orderUrl } }))],
        [
            "an option without extra",
            b64(JSON.stringify({ x402Version: 2, resource: { url: orderUrl }, accepts: [{}] })),
        ],
    ])("fails without signing when the challenge has %s", async (_, header) => {
        const headers: Record<string, string> =
            header === undefined ? {} : { "PAYMENT-REQUIRED": header };
        const { calls, w, f, sleep } = harness({ order: () => json(402, {}, headers) });
        await expect(payWithWallet({ fetch: f, wallet: w, orderUrl, sleep })).rejects.toThrow(
            new Error("the order answered an unreadable payment challenge"),
        );
        expect(calls).not.toContain("signTransaction");
    });

    it("answers a 5xx as unavailable with its Retry-After, never as a refusal", async () => {
        const rpcDown = harness({
            submit: () =>
                json(
                    503,
                    { refused: "rpc_unavailable", orderId: id, retryAfterSeconds: 5 },
                    { "Retry-After": "5" },
                ),
        });
        expect(
            await payWithWallet({
                fetch: rpcDown.f,
                wallet: rpcDown.w,
                orderUrl,
                sleep: rpcDown.sleep,
            }),
        ).toEqual({ unavailable: "rpc_unavailable", retryAfterSeconds: 5 });

        const broken = harness({ order: () => json(500, { error: "internal_error" }) });
        expect(
            await payWithWallet({
                fetch: broken.f,
                wallet: broken.w,
                orderUrl,
                sleep: broken.sleep,
            }),
        ).toEqual({ unavailable: "internal_error" });
        expect(broken.calls).not.toContain("signTransaction");
    });

    it("answers unconfirmed when the submit fails in flight", async () => {
        const { calls, w, f, sleep } = harness({
            submit: () => {
                throw new TypeError("network error");
            },
        });
        expect(await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep })).toBe("unconfirmed");
        expect(calls).toEqual([
            "connect",
            "GET accept:application/json",
            "signTransaction",
            "GET payment-signature",
        ]);
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

describe("watchOrder", () => {
    const settling = () => json(200, { orderId: id, state: "settling" });

    it("checks status every 2 s for at most 60 s, then answers the last state", async () => {
        const { calls, sleeps, f, sleep } = harness();
        expect(await watchOrder({ fetch: f, orderUrl, sleep })).toBe("settling");
        expect(sleeps).toEqual(new Array(30).fill(2000));
        expect(calls).toEqual(new Array(30).fill("GET status"));
    });

    it("stops as soon as the order is paid or closed", async () => {
        const paid = harness({
            statuses: [settling, () => json(200, { orderId: id, state: "paid" })],
        });
        expect(await watchOrder({ fetch: paid.f, orderUrl, sleep: paid.sleep })).toBe("paid");
        expect(paid.sleeps).toEqual([2000, 2000]);

        const expired = harness({
            statuses: [() => json(200, { orderId: id, state: "expired" })],
        });
        expect(await watchOrder({ fetch: expired.f, orderUrl, sleep: expired.sleep })).toBe(
            "expired",
        );
        expect(expired.sleeps).toEqual([2000]);
    });

    it("keeps the last state it saw through failed or unknown answers", async () => {
        const failing = () => json(503, { error: "too_busy" });
        const unknown = () => json(200, { orderId: id, state: "weird" });
        const seen = harness({
            statuses: [settling, ...new Array<() => Response>(29).fill(failing)],
        });
        expect(await watchOrder({ fetch: seen.f, orderUrl, sleep: seen.sleep })).toBe("settling");

        const never = harness({
            statuses: [unknown, ...new Array<() => Response>(29).fill(failing)],
        });
        expect(await watchOrder({ fetch: never.f, orderUrl, sleep: never.sleep })).toBeUndefined();
        expect(never.sleeps).toHaveLength(30);
    });
});

describe("pageStep", () => {
    it("explains each result to the payer", () => {
        expect(pageStep("network_busy").message).toBe("network busy, try again");
        expect(
            pageStep({ refused: "invalid_exact_svm_transaction_simulation_failed" }).message,
        ).toBe("the wallet lacks USDC or the payment expired, try again");
        expect(pageStep("paid").message).toBe("paid");
        expect(pageStep("settling_timeout").message).toBe(
            "the payment is still settling, refresh this page in a minute",
        );
        expect(pageStep({ refused: "order_unpaid" }).message).toBe(
            "the payment did not land, try again",
        );
        expect(pageStep({ refused: "payer_blocked" }).message).toBe(
            "payment refused: payer_blocked",
        );
    });

    it("offers Pay again only while the order can still be paid", () => {
        expect(pageStep("network_busy").payAfterMs).toBe(0);
        expect(pageStep({ refused: "payer_blocked" }).payAfterMs).toBe(0);
        expect(pageStep({ refused: "order_unpaid" })).toEqual({
            message: "the payment did not land, try again",
            state: "unpaid",
            payAfterMs: 0,
        });
        expect(pageStep("paid")).toEqual({ message: "paid", state: "paid" });
        expect(pageStep("settling_timeout")).toEqual({
            message: "the payment is still settling, refresh this page in a minute",
            state: "settling",
        });
        expect(pageStep({ refused: "order_expired" })).toEqual({
            message: "this order has expired",
            state: "expired",
        });
        expect(pageStep({ refused: "order_refunded" })).toEqual({
            message: "this order was refunded",
            state: "refunded",
        });
        expect(pageStep({ refused: "order_review" })).toEqual({
            message: "this order is under review",
            state: "review",
        });
        expect(pageStep({ refused: "order_unknown" })).toEqual({
            message: "this order does not exist",
        });
    });

    it("checks the order's status when the result leaves it unknown", () => {
        expect(pageStep("unconfirmed")).toEqual({
            message: "could not confirm the payment; checking status…",
            watch: true,
        });
        expect(pageStep({ refused: "order_closed" })).toEqual({
            message: "this order is closed",
            watch: true,
        });
    });

    it("waits out Retry-After before offering Pay again", () => {
        expect(pageStep({ unavailable: "rpc_unavailable", retryAfterSeconds: 5 })).toEqual({
            message: "busy, try again in 5 s",
            payAfterMs: 5_000,
        });
        expect(pageStep({ unavailable: "http_502" })).toEqual({
            message: "busy, try again",
            payAfterMs: 0,
        });
    });
});

describe("stateStep", () => {
    it("maps a watched state to the page, telling the payer to refresh when it never settled", () => {
        expect(stateStep("unpaid")).toEqual(pageStep({ refused: "order_unpaid" }));
        expect(stateStep("paid")).toEqual(pageStep("paid"));
        expect(stateStep("settling")).toEqual(pageStep("settling_timeout"));
        expect(stateStep(undefined)).toEqual({
            message: "could not confirm the payment, refresh this page in a minute",
        });
    });
});
