import { address, getBase64Decoder, getTransactionEncoder, isAddress } from "@solana/kit";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { safeBase64Decode, safeBase64Encode } from "@x402/core/utils";
import type { PublicState } from "../http/public.ts";
import { buildPaymentTransaction, hasBlockhashHints } from "../x402/build.ts";

export interface WalletPort {
    connect(): Promise<{ address: string }>;
    signTransaction(i: {
        account: { address: string };
        transaction: Uint8Array;
        chain: "solana:mainnet";
    }): Promise<{ signedTransaction: Uint8Array }[]>;
}

export type PayFlowResult =
    | "paid"
    | "settling_timeout"
    | "network_busy"
    | "unconfirmed"
    | { unavailable: string; retryAfterSeconds?: number }
    | { refused: string };

export interface StatusDeps {
    fetch: typeof fetch;
    orderUrl: string;
    sleep?: (ms: number) => Promise<void>;
}

export interface PayFlowDeps extends StatusDeps {
    wallet: WalletPort;
}

export interface WatchOptions {
    // Until the order is seen settling, unpaid counts only once it has lasted this long
    unpaidForMs?: number;
}

// What the page shows after a result, and whether and when it offers Pay again
export interface PageStep {
    message: string;
    state?: PublicState;
    payAfterMs?: number;
    watch?: WatchOptions;
}

export const STATE_LABELS: Record<PublicState, string> = {
    unpaid: "Awaiting payment",
    settling: "Settling",
    paid: "Paid",
    expired: "Expired",
    refunded: "Refunded",
    review: "Under review",
};

const POLL_EVERY_MS = 2_000;
const WATCH_FOR_MS = 120_000;
// The server reads unpaid until the settler's checks commit settling, a few seconds after submit
const UNCONFIRMED_UNPAID_FOR_MS = 20_000;
const SIMULATION_FAILED = "invalid_exact_svm_transaction_simulation_failed";
const UNREADABLE_CHALLENGE = "the order answered an unreadable payment challenge";
const JSON_ACCEPT = { Accept: "application/json" };

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isOption(a: unknown): boolean {
    return (
        isRecord(a) &&
        typeof a.payTo === "string" &&
        isAddress(a.payTo) &&
        typeof a.amount === "string" &&
        /^\d+$/.test(a.amount) &&
        typeof a.asset === "string" &&
        typeof a.network === "string" &&
        isRecord(a.extra) &&
        typeof a.extra.feePayer === "string" &&
        isAddress(a.extra.feePayer)
    );
}

function isChallenge(v: unknown): v is PaymentRequired {
    return (
        isRecord(v) &&
        isRecord(v.resource) &&
        typeof v.resource.url === "string" &&
        Array.isArray(v.accepts) &&
        v.accepts.every(isOption)
    );
}

// The same encoding as @x402/core/http, whose module would pull zod into the browser bundle
function decodeChallenge(header: string | null): PaymentRequired {
    let pr: unknown;
    try {
        pr = JSON.parse(safeBase64Decode(header ?? ""));
    } catch {
        throw new Error(UNREADABLE_CHALLENGE);
    }
    if (!isChallenge(pr)) throw new Error(UNREADABLE_CHALLENGE);
    return pr;
}

const FUNDING_REFUSALS = new Set([
    "allowance_ceiling",
    "allowance_pool_full",
    "sandbox_ended",
    "order_expired",
]);

async function reasonOf(res: Response): Promise<string> {
    const body: unknown = await res.json().catch(() => null);
    const field = (name: string): string | undefined => {
        const v = isRecord(body) ? body[name] : undefined;
        return typeof v === "string" && v !== "" ? v : undefined;
    };
    const code = field("code");
    if (field("refused") === "order_closed" && code !== undefined && FUNDING_REFUSALS.has(code)) {
        return "order_closed_refunding";
    }
    return code ?? field("refused") ?? field("error") ?? `http_${res.status}`;
}

async function unavailable(res: Response): Promise<PayFlowResult> {
    // A 429 without a wait means its limit has already reset
    const retryAfter = res.headers.get("Retry-After")?.trim() || (res.status === 429 ? "0" : "");
    const reason = await reasonOf(res);
    if (!/^\d+$/.test(retryAfter)) return { unavailable: reason };
    return { unavailable: reason, retryAfterSeconds: Number(retryAfter) };
}

function isPublicState(v: unknown): v is PublicState {
    return typeof v === "string" && Object.hasOwn(STATE_LABELS, v);
}

async function currentState(d: StatusDeps): Promise<PublicState | undefined> {
    try {
        const res = await d.fetch(`${d.orderUrl}/status`, { headers: JSON_ACCEPT });
        if (res.status !== 200) return undefined;
        const body: unknown = await res.json();
        return isRecord(body) && isPublicState(body.state) ? body.state : undefined;
    } catch {
        return undefined;
    }
}

// Polls until the order leaves settling or time runs out, and answers the last state it saw
export async function watchOrder(
    d: StatusDeps,
    opts: WatchOptions = {},
): Promise<PublicState | undefined> {
    const sleep = d.sleep ?? wait;
    let unpaidForMs = opts.unpaidForMs ?? 0;
    let unpaidSince: number | undefined;
    let state: PublicState | undefined;
    for (let waited = POLL_EVERY_MS; waited <= WATCH_FOR_MS; waited += POLL_EVERY_MS) {
        await sleep(POLL_EVERY_MS);
        const seen = await currentState(d);
        if (seen === undefined) continue;
        state = seen;
        if (state === "settling") unpaidForMs = 0;
        else if (state !== "unpaid") return state;
        else if (waited - (unpaidSince ??= waited) >= unpaidForMs) return state;
    }
    // Unpaid for less than asked is no answer yet
    return state === "unpaid" ? undefined : state;
}

async function untilSettled(d: StatusDeps): Promise<PayFlowResult> {
    const state = await watchOrder(d);
    if (state === "paid") return "paid";
    if (state === undefined || state === "settling") return "settling_timeout";
    return { refused: `order_${state}` };
}

async function outcome(d: StatusDeps, res: Response): Promise<PayFlowResult> {
    if (res.status === 200) return "paid";
    if (res.status === 202) return untilSettled(d);
    if (res.status === 429 || res.status >= 500) return unavailable(res);
    return { refused: await reasonOf(res) };
}

export async function payWithWallet(d: PayFlowDeps): Promise<PayFlowResult> {
    const account = await d.wallet.connect();
    // Fetched only now, so the blockhash hint is as fresh as it can be when the wallet signs
    const challenge = await d.fetch(d.orderUrl, { headers: JSON_ACCEPT });
    if (challenge.status !== 402) return outcome(d, challenge);
    const pr = decodeChallenge(challenge.headers.get("PAYMENT-REQUIRED"));
    const accepted = pr.accepts[0];
    if (accepted === undefined) throw new Error("the challenge offers no payment option");
    if (!hasBlockhashHints(accepted)) return "network_busy";
    const tx = await buildPaymentTransaction(accepted, address(account.address));
    const [signed] = await d.wallet.signTransaction({
        account,
        transaction: new Uint8Array(getTransactionEncoder().encode(tx)),
        chain: "solana:mainnet",
    });
    if (signed === undefined) throw new Error("the wallet returned no signed transaction");
    const payment: PaymentPayload = {
        x402Version: 2,
        resource: pr.resource,
        accepted,
        payload: { transaction: getBase64Decoder().decode(signed.signedTransaction) },
    };
    let submitted: Response;
    try {
        submitted = await d.fetch(d.orderUrl, {
            headers: {
                ...JSON_ACCEPT,
                "PAYMENT-SIGNATURE": safeBase64Encode(JSON.stringify(payment)),
            },
        });
    } catch {
        // The connection can drop after the server broadcast, so only the order's status can tell
        return "unconfirmed";
    }
    return outcome(d, submitted);
}

export function stateStep(state: PublicState | undefined): PageStep {
    switch (state) {
        case undefined:
            return { message: "could not confirm the payment, refresh this page in a minute" };
        case "unpaid":
            return { message: "the payment did not land, try again", state, payAfterMs: 0 };
        case "settling":
            return {
                message: "the payment is still settling, refresh this page in a minute",
                state,
            };
        case "paid":
            return { message: "paid", state };
        case "expired":
            return { message: "this order has expired", state };
        case "refunded":
            return { message: "this order was refunded", state };
        case "review":
            return { message: "this order is under review", state };
    }
}

export function pageStep(r: PayFlowResult): PageStep {
    switch (r) {
        case "paid":
            return stateStep("paid");
        case "settling_timeout":
            return stateStep("settling");
        case "network_busy":
            return { message: "network busy, try again", payAfterMs: 0 };
        case "unconfirmed":
            return {
                message: "could not confirm the payment; checking status…",
                watch: { unpaidForMs: UNCONFIRMED_UNPAID_FOR_MS },
            };
    }
    if ("unavailable" in r) {
        const seconds = r.retryAfterSeconds;
        if (seconds === undefined) return { message: "busy, try again", payAfterMs: 0 };
        if (seconds === 0) return { message: "busy, try again now", payAfterMs: 0 };
        return { message: `busy, try again in ${seconds} s`, payAfterMs: seconds * 1_000 };
    }
    switch (r.refused) {
        case SIMULATION_FAILED:
            return {
                message: "the wallet lacks USDC or the payment expired, try again",
                payAfterMs: 0,
            };
        case "order_unpaid":
            return stateStep("unpaid");
        case "order_expired":
            return stateStep("expired");
        case "order_refunded":
            return stateStep("refunded");
        case "order_review":
            return stateStep("review");
        case "order_closed_refunding":
            return {
                message:
                    "paid, but this order could not be applied: the money is being refunded to the paying wallet",
                watch: {},
            };
        case "order_closed":
            return { message: "this order is closed", watch: {} };
        case "order_unknown":
            return { message: "this order does not exist" };
        default:
            return { message: `payment refused: ${r.refused}`, payAfterMs: 0 };
    }
}
