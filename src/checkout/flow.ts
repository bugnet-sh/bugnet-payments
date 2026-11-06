import { address, getBase64Decoder, getTransactionEncoder } from "@solana/kit";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { safeBase64Decode, safeBase64Encode } from "@x402/core/utils";
import { buildPaymentTransaction } from "../x402/build.ts";

export interface WalletPort {
    connect(): Promise<{ address: string }>;
    signTransaction(i: {
        account: { address: string };
        transaction: Uint8Array;
        chain: "solana:mainnet";
    }): Promise<{ signedTransaction: Uint8Array }[]>;
}

export type PayFlowResult = "paid" | "settling_timeout" | "network_busy" | { refused: string };

export interface PayFlowDeps {
    fetch: typeof fetch;
    wallet: WalletPort;
    orderUrl: string;
    sleep?: (ms: number) => Promise<void>;
}

const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 120_000;
const SIMULATION_FAILED = "invalid_exact_svm_transaction_simulation_failed";
const JSON_ACCEPT = { Accept: "application/json" };

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// The same encoding as @x402/core/http, whose module would pull zod into the browser bundle
function decodeChallenge(header: string): PaymentRequired {
    const pr = JSON.parse(safeBase64Decode(header)) as Partial<PaymentRequired> | null;
    if (!Array.isArray(pr?.accepts) || typeof pr.resource !== "object") {
        throw new Error("the order answered an unreadable payment challenge");
    }
    return pr as PaymentRequired;
}

async function refusalOf(res: Response): Promise<{ refused: string }> {
    const body: unknown = await res.json().catch(() => null);
    const field = (name: string): string | undefined => {
        const v = (body as Record<string, unknown> | null)?.[name];
        return typeof v === "string" && v !== "" ? v : undefined;
    };
    return { refused: field("code") ?? field("refused") ?? field("error") ?? `http_${res.status}` };
}

async function currentState(d: PayFlowDeps): Promise<string | undefined> {
    try {
        const res = await d.fetch(`${d.orderUrl}/status`, { headers: JSON_ACCEPT });
        if (res.status !== 200) return undefined;
        const { state } = (await res.json()) as { state?: unknown };
        return typeof state === "string" ? state : undefined;
    } catch {
        return undefined;
    }
}

async function untilSettled(d: PayFlowDeps): Promise<PayFlowResult> {
    const sleep = d.sleep ?? wait;
    for (let waited = 0; waited < POLL_FOR_MS; waited += POLL_EVERY_MS) {
        await sleep(POLL_EVERY_MS);
        const state = await currentState(d);
        if (state === "paid") return "paid";
        if (state !== undefined && state !== "settling") return { refused: `order_${state}` };
    }
    return "settling_timeout";
}

function outcome(d: PayFlowDeps, res: Response): Promise<PayFlowResult> | PayFlowResult {
    if (res.status === 200) return "paid";
    if (res.status === 202) return untilSettled(d);
    return refusalOf(res);
}

export async function payWithWallet(d: PayFlowDeps): Promise<PayFlowResult> {
    const account = await d.wallet.connect();
    // Fetched only now, so the blockhash hint is as fresh as it can be when the wallet signs
    const challenge = await d.fetch(d.orderUrl, { headers: JSON_ACCEPT });
    if (challenge.status !== 402) return outcome(d, challenge);
    const pr = decodeChallenge(challenge.headers.get("PAYMENT-REQUIRED") ?? "");
    const accepted = pr.accepts[0];
    if (accepted === undefined) throw new Error("the challenge offers no payment option");
    const { recentBlockhash, lastValidBlockHeight } = accepted.extra;
    if (typeof recentBlockhash !== "string" || typeof lastValidBlockHeight !== "string") {
        return "network_busy";
    }
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
    const submitted = await d.fetch(d.orderUrl, {
        headers: { ...JSON_ACCEPT, "PAYMENT-SIGNATURE": safeBase64Encode(JSON.stringify(payment)) },
    });
    return outcome(d, submitted);
}

export function describeResult(r: PayFlowResult): string {
    switch (r) {
        case "paid":
            return "paid";
        case "settling_timeout":
            return "the payment is still settling, check this page again in a minute";
        case "network_busy":
            return "network busy, try again";
    }
    switch (r.refused) {
        case SIMULATION_FAILED:
            return "the wallet lacks USDC or the payment expired, try again";
        case "order_unpaid":
            return "the payment did not land, try again";
        default:
            return `payment refused: ${r.refused}`;
    }
}
