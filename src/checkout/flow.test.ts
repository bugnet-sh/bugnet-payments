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
        { id, amountMicros: 10_000, payInto: "cold" },
        {
            publicUrl: "https://pay.bugnet.sh",
            recipient: (await testSigner(1)).address,
            allowanceWallet: (await testSigner(11)).address,
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

    type Option = Record<string, unknown> & { extra: Record<string, unknown> };
    it.each<[string, (o: Option) => void]>([
        ["no payTo", (o) => delete o.payTo],
        ["no amount", (o) => delete o.amount],
        ["no asset", (o) => delete o.asset],
        ["no network", (o) => delete o.network],
        ["no feePayer", (o) => delete o.extra.feePayer],
        ["a numeric payTo", (o) => (o.payTo = 1)],
        ["a numeric amount", (o) => (o.amount = 10_000)],
        ["a null asset", (o) => (o.asset = null)],
        ["a numeric network", (o) => (o.network = 101)],
        ["a feePayer list", (o) => (o.extra.feePayer = [o.extra.feePayer])],
        ["a payTo that is not an address", (o) => (o.payTo = "not-an-address")],
        ["a feePayer that is not an address", (o) => (o.extra.feePayer = "0x1234")],
        ["a fractional amount", (o) => (o.amount = "0.01")],
    ])("fails without signing when the hinted option has %s", async (_, change) => {
        const option: Option = { ...accepts, extra: { ...accepts.extra } };
        change(option);
        const header = b64(JSON.stringify(challenge(option as unknown as PaymentRequirements)));
        const { calls, w, f, sleep } = harness({
            order: () => json(402, {}, { "PAYMENT-REQUIRED": header }),
        });
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

    it.each(["too_many_attempts", "payer_busy", "payer_rate_limited", "too_many_requests"])(
        "answers a 429 %s as unavailable with its Retry-After, never as a refusal",
        async (reason) => {
            const { w, f, sleep } = harness({
                submit: () =>
                    json(
                        429,
                        { refused: reason, orderId: id, retryAfterSeconds: 5 },
                        { "Retry-After": "5" },
                    ),
            });
            const result = await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep });
            expect(result).toEqual({ unavailable: reason, retryAfterSeconds: 5 });
            expect(pageStep(result)).toEqual({
                message: "busy, try again in 5 s",
                payAfterMs: 5_000,
            });
        },
    );

    it("offers Pay at once after a 429 that asks for no wait", async () => {
        const zero = harness({
            submit: () =>
                json(
                    429,
                    { refused: "payer_busy", orderId: id, retryAfterSeconds: 0 },
                    { "Retry-After": "0" },
                ),
        });
        const result = await payWithWallet({
            fetch: zero.f,
            wallet: zero.w,
            orderUrl,
            sleep: zero.sleep,
        });
        expect(result).toEqual({ unavailable: "payer_busy", retryAfterSeconds: 0 });
        expect(pageStep(result)).toEqual({ message: "busy, try again now", payAfterMs: 0 });

        const absent = harness({ order: () => json(429, { error: "too_many_requests" }) });
        const refetched = await payWithWallet({
            fetch: absent.f,
            wallet: absent.w,
            orderUrl,
            sleep: absent.sleep,
        });
        expect(refetched).toEqual({ unavailable: "too_many_requests", retryAfterSeconds: 0 });
        expect(pageStep(refetched)).toEqual({ message: "busy, try again now", payAfterMs: 0 });
        expect(absent.calls).not.toContain("signTransaction");
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

    const unpaid = () => json(200, { orderId: id, state: "unpaid" });

    it("checks status every 2 s for at most 120 s, then answers the last state", async () => {
        const { calls, sleeps, f, sleep } = harness();
        expect(await watchOrder({ fetch: f, orderUrl, sleep })).toBe("settling");
        expect(sleeps).toEqual(new Array(60).fill(2000));
        expect(calls).toEqual(new Array(60).fill("GET status"));
    });

    it("keeps watching an unconfirmed payment through unpaid until it settles", async () => {
        const { sleeps, w, f, sleep } = harness({
            submit: () => {
                throw new TypeError("network error");
            },
            statuses: [unpaid, unpaid, settling, () => json(200, { orderId: id, state: "paid" })],
        });
        const step = pageStep(await payWithWallet({ fetch: f, wallet: w, orderUrl, sleep }));
        expect(step.watch).toEqual({ unpaidForMs: 20_000 });
        const state = await watchOrder({ fetch: f, orderUrl, sleep }, step.watch);
        expect(state).toBe("paid");
        expect(sleeps).toEqual([2000, 2000, 2000, 2000]);
        expect(stateStep(state)).toEqual({ message: "paid", state: "paid" });
    });

    it("answers unpaid for an unconfirmed payment only after 20 s of unpaid", async () => {
        const watch = pageStep("unconfirmed").watch;
        const failing = () => json(503, { error: "too_busy" });
        const { sleeps, f, sleep } = harness({
            statuses: [
                ...new Array<() => Response>(10).fill(unpaid),
                failing,
                ...new Array<() => Response>(10).fill(unpaid),
            ],
        });
        expect(await watchOrder({ fetch: f, orderUrl, sleep }, watch)).toBe("unpaid");
        expect(sleeps).toEqual(new Array(12).fill(2000));

        const steady = harness({ statuses: new Array<() => Response>(20).fill(unpaid) });
        expect(await watchOrder({ fetch: steady.f, orderUrl, sleep: steady.sleep }, watch)).toBe(
            "unpaid",
        );
        expect(steady.sleeps).toEqual(new Array(11).fill(2000));
    });

    it("ends an unconfirmed watch at once on a state other than unpaid", async () => {
        const watch = pageStep("unconfirmed").watch;
        const expired = harness({
            statuses: [unpaid, unpaid, () => json(200, { orderId: id, state: "expired" })],
        });
        expect(await watchOrder({ fetch: expired.f, orderUrl, sleep: expired.sleep }, watch)).toBe(
            "expired",
        );
        expect(expired.sleeps).toHaveLength(3);

        const fellBack = harness({ statuses: [unpaid, settling, unpaid] });
        expect(
            await watchOrder({ fetch: fellBack.f, orderUrl, sleep: fellBack.sleep }, watch),
        ).toBe("unpaid");
        expect(fellBack.sleeps).toHaveLength(3);
    });

    it("never answers unpaid for an unconfirmed payment that read unpaid under 20 s", async () => {
        const failing = () => json(503, { error: "too_busy" });
        const { sleeps, f, sleep } = harness({
            statuses: [
                ...new Array<() => Response>(55).fill(failing),
                ...new Array<() => Response>(5).fill(unpaid),
            ],
        });
        const watch = pageStep("unconfirmed").watch;
        expect(await watchOrder({ fetch: f, orderUrl, sleep }, watch)).toBeUndefined();
        expect(sleeps).toHaveLength(60);
    });

    it("answers unpaid at once when no unpaid wait is asked", async () => {
        const { sleeps, f, sleep } = harness({ statuses: [unpaid] });
        expect(await watchOrder({ fetch: f, orderUrl, sleep })).toBe("unpaid");
        expect(sleeps).toEqual([2000]);
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
            statuses: [settling, ...new Array<() => Response>(59).fill(failing)],
        });
        expect(await watchOrder({ fetch: seen.f, orderUrl, sleep: seen.sleep })).toBe("settling");

        const never = harness({
            statuses: [unknown, ...new Array<() => Response>(59).fill(failing)],
        });
        expect(await watchOrder({ fetch: never.f, orderUrl, sleep: never.sleep })).toBeUndefined();
        expect(never.sleeps).toHaveLength(60);
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
            watch: { unpaidForMs: 20_000 },
        });
        expect(pageStep({ refused: "order_closed" })).toEqual({
            message: "this order is closed",
            watch: {},
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
        expect(pageStep({ unavailable: "http_503", retryAfterSeconds: 0 })).toEqual({
            message: "busy, try again now",
            payAfterMs: 0,
        });
    });
});

describe("order_closed_refunding", () => {
    it("reads a paid order that could not be applied as being refunded", async () => {
        const h = harness({
            submit: () =>
                json(410, { refused: "order_closed", orderId: id, code: "sandbox_ended" }),
        });
        expect(await payWithWallet({ fetch: h.f, wallet: h.w, orderUrl, sleep: h.sleep })).toEqual({
            refused: "order_closed_refunding",
        });
        expect(pageStep({ refused: "order_closed_refunding" })).toEqual({
            message:
                "paid, but this order could not be applied: the money is being refunded to the paying wallet",
            watch: {},
        });
        const other = harness({
            submit: () => json(422, { refused: "payment_invalid", orderId: id, code: "x" }),
        });
        expect(
            await payWithWallet({ fetch: other.f, wallet: other.w, orderUrl, sleep: other.sleep }),
        ).toEqual({ refused: "x" });
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
