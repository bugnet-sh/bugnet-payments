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
    | "unpaid_after_submit"
    | { refused: string; code?: string; blockedUntil?: string }
    | { unavailable: string; code?: string; retryAfterSeconds?: number }
    | { short: { haveMicros: number; needMicros: number } };

export interface StatusDeps {
    fetch: typeof fetch;
    orderUrl: string;
    sleep?: (ms: number) => Promise<void>;
}

export interface PayFlowDeps extends StatusDeps {
    wallet: WalletPort;
    // The pre-check before signing (spec 13.1); null when the check could not run
    balance?: (owner: string) => Promise<{ usdcMicros: number; needMicros: number } | null>;
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

const POLL_EVERY_MS = 2_000;
const WATCH_FOR_MS = 120_000;
// The server reads unpaid until the settler's checks commit settling, a few seconds after submit
export const UNCONFIRMED_UNPAID_FOR_MS = 20_000;
export const UNREADABLE_CHALLENGE = "the order answered an unreadable payment challenge";
export const NO_OPTION = "the challenge offers no payment option";
export const NO_SIGNED = "the wallet returned no signed transaction";
export const NO_ACCOUNT = "the wallet shared no account";
export const BUILD_FAILED = "the payment transaction could not be built";
// Wallet codes that are the user's own choice or state; any other one may be a short balance
const USER_CODES = new Set([4001, 4100, 4900, -32002]);
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

interface Refusal {
    reason: string;
    code?: string;
    blockedUntil?: string;
}

async function reasonOf(res: Response): Promise<Refusal> {
    const body: unknown = await res.json().catch(() => null);
    const field = (name: string): string | undefined => {
        const v = isRecord(body) ? body[name] : undefined;
        return typeof v === "string" && v !== "" ? v : undefined;
    };
    const code = field("code");
    const blockedUntil = field("blockedUntil");
    const reason = field("refused") ?? code ?? field("error") ?? `http_${res.status}`;
    return {
        reason,
        ...(code === undefined || code === reason ? {} : { code }),
        ...(blockedUntil === undefined ? {} : { blockedUntil }),
    };
}

async function unavailable(res: Response): Promise<PayFlowResult> {
    // A 429 without a wait means its limit has already reset
    const retryAfter = res.headers.get("Retry-After")?.trim() || (res.status === 429 ? "0" : "");
    const r = await reasonOf(res);
    return {
        unavailable: r.reason,
        ...(r.code === undefined ? {} : { code: r.code }),
        ...(/^\d+$/.test(retryAfter) ? { retryAfterSeconds: Number(retryAfter) } : {}),
    };
}

const PUBLIC_STATES = new Set(["unpaid", "settling", "paid", "expired", "refunded", "review"]);

// The only status request the page makes; without Bugnet-Client the server never notes a viewer.
// It lives here, below live.ts and messages.ts, so the checkout modules import in one direction.
export function fetchStatus(d: { fetch: typeof fetch; orderUrl: string }): Promise<Response> {
    return d.fetch(`${d.orderUrl}/status`, {
        headers: { Accept: "application/json", "Bugnet-Client": "checkout" },
    });
}

function isPublicState(v: unknown): v is PublicState {
    return typeof v === "string" && PUBLIC_STATES.has(v);
}

async function currentState(d: StatusDeps): Promise<PublicState | undefined> {
    try {
        const res = await fetchStatus(d);
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
    if (state === "unpaid") return "unpaid_after_submit";
    return { refused: `order_${state}` };
}

async function outcome(d: StatusDeps, res: Response): Promise<PayFlowResult> {
    if (res.status === 200) return "paid";
    if (res.status === 202) return untilSettled(d);
    if (res.status === 429 || res.status >= 500) return unavailable(res);
    const r = await reasonOf(res);
    return {
        refused: r.reason,
        ...(r.code === undefined ? {} : { code: r.code }),
        ...(r.blockedUntil === undefined ? {} : { blockedUntil: r.blockedUntil }),
    };
}

// GET /o/{id}/balance (spec 13.1): null for a 503, any other answer it cannot use, or a network
// failure, so the flow skips the check
export async function readBalance(
    d: StatusDeps,
    owner: string,
): Promise<{ usdcMicros: number; needMicros: number } | null> {
    try {
        const res = await d.fetch(`${d.orderUrl}/balance?owner=${encodeURIComponent(owner)}`, {
            headers: JSON_ACCEPT,
        });
        if (res.status !== 200) return null;
        const body: unknown = await res.json();
        if (!isRecord(body)) return null;
        const { usdcMicros, needMicros } = body;
        if (typeof usdcMicros !== "number" || typeof needMicros !== "number") return null;
        return { usdcMicros, needMicros };
    } catch {
        return null;
    }
}

// The report a short balance sends (spec 13.3)
export function shortReport(
    wallet: string,
    short: { haveMicros: number; needMicros: number },
): { stage: string; wallet: string; code: number | null; message: string } {
    return {
        stage: "balance",
        wallet,
        code: null,
        message: `short ${short.haveMicros} ${short.needMicros}`,
    };
}

// The pre-check's answer, or null when it could not run (a 503 or a network failure skip it)
async function shortOf(
    d: PayFlowDeps,
    owner: string,
): Promise<{ haveMicros: number; needMicros: number } | null> {
    if (d.balance === undefined) return null;
    const b = await d.balance(owner).catch(() => null);
    if (b === null || b.usdcMicros >= b.needMicros) return null;
    return { haveMicros: b.usdcMicros, needMicros: b.needMicros };
}

export async function payWithWallet(d: PayFlowDeps): Promise<PayFlowResult> {
    const account = await d.wallet.connect();
    // Before the challenge and before signing, so a short wallet signs nothing
    const short = await shortOf(d, account.address);
    if (short !== null) return { short };
    // Fetched only now, so the blockhash hint is as fresh as it can be when the wallet signs
    const challenge = await d.fetch(d.orderUrl, { headers: JSON_ACCEPT });
    if (challenge.status !== 402) return outcome(d, challenge);
    const pr = decodeChallenge(challenge.headers.get("PAYMENT-REQUIRED"));
    const accepted = pr.accepts[0];
    if (accepted === undefined) throw new Error(NO_OPTION);
    if (!hasBlockhashHints(accepted)) return "network_busy";
    let tx: Awaited<ReturnType<typeof buildPaymentTransaction>>;
    try {
        tx = await buildPaymentTransaction(accepted, address(account.address));
    } catch {
        // The wallet was never asked, so neither it nor the network is to blame (W13)
        throw new Error(BUILD_FAILED);
    }
    let signed: { signedTransaction: Uint8Array } | undefined;
    try {
        [signed] = await d.wallet.signTransaction({
            account,
            transaction: new Uint8Array(getTransactionEncoder().encode(tx)),
            chain: "solana:mainnet",
        });
    } catch (err) {
        // Phantom answers a failed simulation with -32603: a short balance shows as one
        if (err instanceof WalletError && (err.code === undefined || !USER_CODES.has(err.code))) {
            const again = await shortOf(d, account.address);
            if (again !== null) return { short: again };
        }
        throw err;
    }
    if (signed === undefined) throw new Error(NO_SIGNED);
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
                // Payments records it as orders.paid_via for the public stats
                "Bugnet-Client": "checkout",
            },
        });
    } catch {
        // The connection can drop after the server broadcast, so only the order's status can tell
        return "unconfirmed";
    }
    return outcome(d, submitted);
}

// A wallet's own refusal, kept apart from Bugnet's errors so the page can name the wallet
export class WalletError extends Error {
    constructor(
        readonly wallet: string,
        readonly code: number | undefined,
        said: string,
    ) {
        super(said);
        this.name = "WalletError";
    }
}

export function walletError(wallet: string, err: unknown): WalletError {
    const code =
        isRecord(err) || err instanceof Error ? (err as { code?: unknown }).code : undefined;
    const said =
        err instanceof Error
            ? err.message
            : isRecord(err) && typeof err.message === "string"
              ? err.message
              : String(err);
    return new WalletError(wallet, typeof code === "number" ? code : undefined, said);
}

// The page's own account of a wallet error (spec 13.3); a failed report is ignored. The strings
// are cut to the route's limits here, so a long wallet text never makes the body too large.
export async function reportError(
    d: StatusDeps,
    r: { stage: string; wallet: string; code: number | null; message: string },
): Promise<void> {
    const body = { ...r, wallet: r.wallet.slice(0, 40), message: r.message.slice(0, 200) };
    await d
        .fetch(`${d.orderUrl}/report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        })
        .catch(() => undefined);
}

// The report stage of an error the flow threw that is not a wallet's
export function errorStage(err: unknown, stage: "connect" | "sign" | "challenge"): string {
    if (err instanceof TypeError) return "status";
    const message = err instanceof Error ? err.message : "";
    if ([UNREADABLE_CHALLENGE, NO_OPTION, BUILD_FAILED].includes(message)) return "challenge";
    if (message === NO_SIGNED) return "sign";
    return stage;
}
