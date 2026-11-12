import type { DepositView } from "../deposits/types.ts";
import type { PublicState } from "../http/public.ts";
import {
    BUILD_FAILED,
    NO_ACCOUNT,
    NO_OPTION,
    type PageStep,
    type PayFlowResult,
    UNCONFIRMED_UNPAID_FOR_MS,
    UNREADABLE_CHALLENGE,
    type WalletError,
} from "./flow.ts";
import type { StatusView } from "./live.ts";

// Every line the page shows (spec 15.6). Each is a full sentence; none passes a wallet's or an
// error's own text through.

export interface MessageContext {
    amountMicros: number;
    // The deadline as local HH:MM
    deadline: string;
    refundMinMicros: number;
    orderId: string;
    // A hold's end as local HH:MM, and a block's end as a local date and time; the page's own
    // locale when left out
    formatTime?: (iso: string) => string;
    formatDateTime?: (iso: string) => string;
    // False on a page that shows no deposit address, whose lines then never point at one (M3)
    hasAddress?: boolean;
}

function showsAddress(c: MessageContext): boolean {
    return c.hasAddress !== false;
}

// A sentence's end: the address as the other way to pay, on a page that shows one
function orSend(c: MessageContext): string {
    return showsAddress(c) ? ", or send to the address below." : ".";
}

export const STATE_LABELS: Record<PublicState, string> = {
    unpaid: "Awaiting payment",
    settling: "Confirming",
    paid: "Paid",
    expired: "Expired",
    refunded: "Refunded",
    review: "Under review",
};

const STATUS_LABELS: Record<string, string> = {
    waiting: "Awaiting payment",
    partial: "Partly paid",
    confirming: "Confirming",
    held: "Waiting for a free slot",
    checking: "Checking",
    paid: "Paid",
    expired: "Expired",
    refunding: "Refunding",
    refunded: "Refunded",
    review: "Under review",
};

const SUPPORT = "support@bugnet.org";
const ASK_NEW_LINK = "Ask your agent for a new payment link.";

// $0.05, $0.007, $0.00
export function amountLabel(micros: number): string {
    const whole = Math.trunc(micros / 1_000_000);
    const fraction = String(micros % 1_000_000)
        .padStart(6, "0")
        .replace(/0+$/, "")
        .padEnd(2, "0");
    return `$${whole}.${fraction}`;
}

// 0.05, 0.000001, 1
export function decimalAmount(micros: number): string {
    const whole = Math.trunc(micros / 1_000_000);
    const fraction = String(micros % 1_000_000)
        .padStart(6, "0")
        .replace(/0+$/, "");
    return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

function localTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}

function localDateTime(iso: string): string {
    return new Date(iso).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: false,
    });
}

const time = (c: MessageContext, iso: string) => (c.formatTime ?? localTime)(iso);
const dateTime = (c: MessageContext, iso: string) => (c.formatDateTime ?? localDateTime)(iso);

// M13: a blocked sender's money, by date when the block has one
function blockedLine(sent: number, until: string | null, c: MessageContext): string {
    return until === null
        ? `Bugnet blocks the wallet that sent ${amountLabel(sent)}, so that money is being returned to it.`
        : `Bugnet blocks the wallet that sent ${amountLabel(sent)} until ${dateTime(c, until)}, so that money is being returned to it.`;
}

// The reason a transfer is going back, worded by its reason (M10 to M16, M27, M28)
function returnLine(
    v: NonNullable<StatusView["deposit"]>,
    c: MessageContext,
    done: boolean,
): string | null {
    const sent = amountLabel(v.reasonMicros);
    switch (v.reason) {
        case "late":
            return done
                ? `${sent} arrived after this order closed and was returned to the address that sent it.`
                : `${sent} arrived after this order closed and is being returned to the address that sent it.`;
        case "after_paid":
            return `${sent} arrived after this order was paid and is being returned to the address that sent it.`;
        case "paid_otherwise":
            return `This order was paid with a wallet, so the ${sent} sent to the address is being returned to the address that sent it.`;
        case "payer_blocked":
            return blockedLine(v.reasonMicros, v.blockedUntil, c);
        case "payer_busy":
            return `The wallet that sent ${sent} stayed at its sandbox limit until time ran out, so that money is being returned to it. Stop a sandbox, then ask your agent for a new payment link.`;
        case "payer_rate_limited":
            return `The wallet that sent ${sent} started too many sandboxes recently, so that money is being returned to it. Ask your agent for a new payment link in a few minutes.`;
        case "allowance_unavailable":
            return `Bugnet is not taking allowance payments right now, so the ${sent} is being returned. Ask your agent to try again later.`;
        case "pool_busy":
            return `Bugnet had no free sandbox slot when time ran out, so the ${sent} is being returned. Ask your agent to try again in a few minutes.`;
        case "router_unavailable":
            return `Bugnet could not confirm this top-up with its sandbox service before time ran out, so the ${sent} is being returned. Ask your agent to try again.`;
        default:
            return null;
    }
}

function heldLine(
    v: NonNullable<StatusView["deposit"]>,
    c: MessageContext,
    pastDeadline: boolean,
): string {
    const received = amountLabel(v.receivedMicros);
    const until = v.hold === null ? c.deadline : time(c, v.hold.until);
    switch (v.hold?.reason) {
        case "anonymous_busy":
            return `Received ${received}. Bugnet has no free sandbox slot for this payment right now. It tries again until ${until}, then returns the money.`;
        case "allowance_paused":
            return `Received ${received}. Bugnet's allowance service paused for a moment. It tries again until ${until}, then returns the money if it is still paused.`;
        case "router_unavailable":
            return `Received ${received}. Bugnet is confirming this top-up with its sandbox service and tries again until ${until}, then returns the money.`;
        default: {
            const line = `Received ${received} from a wallet at its sandbox limit. Bugnet tries again until ${until}, then returns it.`;
            // Past the deadline money from another wallet is late and goes back (M4)
            return pastDeadline
                ? line
                : `${line} ${decimalAmount(c.amountMicros)} USDC from another wallet pays at once.`;
        }
    }
}

// M17: money below refund_min_micros stays in the deposit
function keptLine(v: NonNullable<StatusView["deposit"]>, c: MessageContext): string {
    return `${amountLabel(v.keptMicros)} arrived, which is below the ${amountLabel(c.refundMinMicros)} Bugnet returns, so it was kept.`;
}

const P2 = "The payment is confirming on Solana. This page updates when it lands.";
const P3 = "This order's payment was returned to the wallet that paid.";

// The deposit section's Amount row, its Copy value, the QR's alt and the exchange note. Once part of the price has arrived they name what is left, as the QR does (spec 14.2):
// a payer copying the price would overpay and pay for the return. With nothing left, the price,
// which a payment from another wallet still needs while the money waits (M24).
export function depositAsk(
    amountMicros: number,
    d: Pick<DepositView, "remainingMicros">,
): { plain: string; alt: string; exchange: string } {
    const plain = decimalAmount(d.remainingMicros > 0 ? d.remainingMicros : amountMicros);
    return {
        plain,
        alt: `Solana Pay code for ${plain} USDC`,
        // Money returned goes to the sending address, which an exchange may not credit
        exchange: `From an exchange, send exactly ${plain} USDC.`,
    };
}

export function depositLine(
    v: StatusView,
    c: MessageContext,
): { label: string; message: string; extra: string[] } {
    const d = v.deposit;
    if (d === null) {
        const message = v.state === "settling" ? P2 : stateStep(v.state, c).message;
        return { label: STATE_LABELS[v.state], message, extra: [] };
    }
    const kept = d.reason === "below_minimum";
    let message: string;
    switch (d.status) {
        case "waiting":
            // The amount, the address and the time left are already on the page
            message = "";
            break;
        case "partial":
            message = `Received ${amountLabel(d.receivedMicros)}. Send ${amountLabel(d.remainingMicros)} more to the same address by ${c.deadline}.`;
            break;
        case "confirming":
            message = `Received ${amountLabel(d.receivedMicros)}. Confirming the payment on Solana.`;
            break;
        case "held":
            message = heldLine(d, c, v.serverNow >= v.expiresAt);
            break;
        case "checking":
            message = "Time is up. Checking for a transfer sent in the last moments.";
            break;
        case "paid":
            // Paid by deposit, then refunded: the order's state, never "Paid" (spec 8.3)
            if (v.state === "refunded") {
                message = P3;
                break;
            }
            {
                // Money that came after the payment, or another way, is worded by its own
                // reason, which names the newest money, ahead of the payment's own extra
                const other =
                    d.reason !== null && d.reason !== "extra"
                        ? returnLine(d, c, d.returningMicros === 0)
                        : null;
                if (other !== null) message = other;
                else if (d.extraMicros > 0) {
                    message =
                        d.returningMicros > 0
                            ? `The extra ${amountLabel(d.extraMicros)} is being returned to the address that sent it.`
                            : `The extra ${amountLabel(d.extraMicros)} was returned to the address that sent it.`;
                } else message = "Go back to your agent. It continues on its own.";
            }
            break;
        case "refunding":
            message =
                d.reason === "unpaid"
                    ? `Time ran out before the full amount arrived. The ${amountLabel(d.returningMicros > 0 ? d.returningMicros : d.reasonMicros)} you sent is being returned to the address that sent it.`
                    : (returnLine(d, c, false) ??
                      "Money is being returned to the address that sent it.");
            break;
        case "refunded":
            // An expired order whose only money was kept reads refunded too (spec 8.3)
            if (kept && d.returnedMicros === 0) {
                message = keptLine(d, c);
                break;
            }
            message =
                d.reason === "unpaid"
                    ? `Time ran out before the full amount arrived. The ${amountLabel(d.returnedMicros > 0 ? d.returnedMicros : d.reasonMicros)} you sent was returned. ${ASK_NEW_LINK}`
                    : (returnLine(d, c, true) ??
                      "The money was returned to the address that sent it.");
            break;
        case "review":
            message = `This payment needs a check by hand. The money is safe. Write to ${SUPPORT} with order ${c.orderId}.`;
            break;
        case "expired":
        default:
            message =
                kept || (d.keptMicros > 0 && d.receivedMicros === 0)
                    ? keptLine(d, c)
                    : `This order expired at ${c.deadline} and nothing was charged. ${ASK_NEW_LINK}`;
    }
    const extra: string[] = [];
    if (d.keptMicros > 0 && message !== keptLine(d, c)) extra.push(keptLine(d, c));
    if ((d.status === "partial" || d.status === "waiting") && d.reason === "payer_blocked") {
        extra.push(blockedLine(d.reasonMicros, d.blockedUntil, c));
    }
    if ((d.status === "partial" || d.status === "waiting") && d.otherMicros > 0) {
        extra.push(
            `${amountLabel(d.otherMicros)} also arrived from other wallets. It is not counted in the amount above.`,
        );
    }
    if (d.reviewMicros > 0 && d.status !== "review") {
        extra.push(
            `${amountLabel(d.reviewMicros)} arrived in a way Bugnet cannot return on its own. It is safe. To get it back, write to ${SUPPORT} with order ${c.orderId} and a message signed by the sending wallet.`,
        );
    }
    // A paid order reads Paid while stray money goes back, the line says the rest (M6)
    const label =
        v.state === "paid"
            ? STATE_LABELS.paid
            : d.status === "paid" && v.state === "refunded"
              ? STATE_LABELS.refunded
              : (STATUS_LABELS[d.status] ?? STATE_LABELS[v.state]);
    return { label, message, extra };
}

// W35, while money already sits at the address and the order still takes a wallet payment
export function walletNoteText(c: MessageContext): string {
    return `Money already arrived at the address below. Paying by wallet charges the full ${amountLabel(c.amountMicros)} and sends that money back.`;
}

export const PAGE_TEXT = {
    noWallet: "No browser wallet found.",
    connecting: (wallet: string) => `Approve the connection in ${wallet}.`,
    signing: (wallet: string) => `Approve the payment in ${wallet}.`,
    copyFailed: "Copy failed. Select the text and copy it by hand.",
    unreachable: "Cannot reach Bugnet. This page keeps trying; check your connection.",
    tooMany: (s: number) => `Too many requests from your network. This page tries again in ${s} s.`,
} as const;

function shortBalance(have: number, c: MessageContext & { wallet: string }): string {
    const options = showsAddress(c)
        ? "Add USDC, pick another account, or send to the address below."
        : "Add USDC or pick another account.";
    return `Your ${c.wallet} account holds ${amountLabel(have)} USDC on Solana and this order needs ${amountLabel(c.amountMicros)}. Nothing was charged. ${options}`;
}

// A wallet's own refusal, by its EIP-1193 code (W4 to W10); the wallet's text is never shown
export function walletMessage(
    e: WalletError,
    c: MessageContext & { haveMicros?: number },
): PageStep {
    const w = e.wallet;
    const step = (message: string): PageStep => ({ message, payAfterMs: 0 });
    switch (e.code) {
        case 4001:
            return step(`You declined in ${w}. Nothing was charged. Press Pay to try again.`);
        case 4100:
            return step(
                `${w} has not allowed this page. Unlock ${w}, approve the connection, then press Pay.`,
            );
        case 4900:
            return step(`${w} is offline. Open ${w}, then press Pay again.`);
        case -32002:
            return step(
                `${w} already has a request open. Finish or close it there, then press Pay.`,
            );
        case -32000:
        case -32003:
            return step(
                `${w} refused this payment. Nothing was charged.${showsAddress(c) ? " Send to the address below instead." : ""}`,
            );
    }
    if (c.haveMicros !== undefined && c.haveMicros < c.amountMicros) {
        return step(shortBalance(c.haveMicros, { ...c, wallet: w }));
    }
    return step(
        `${w} could not prepare the payment. Nothing was charged. Press Pay to try again${orSend(c)}`,
    );
}

// Errors the flow throws that are not a wallet's (W11 to W14); never the error's own text
export function errorStep(err: unknown, c: MessageContext & { wallet: string }): PageStep {
    const step = (message: string): PageStep => ({ message, payAfterMs: 0 });
    if (err instanceof TypeError) {
        return step(
            "Cannot reach Bugnet. Nothing was charged. Check your connection, then press Pay.",
        );
    }
    const message = err instanceof Error ? err.message : "";
    if (message === NO_ACCOUNT) {
        return step(
            `${c.wallet} shared no Solana account. Unlock it, pick an account, then press Pay.`,
        );
    }
    if (message === UNREADABLE_CHALLENGE || message === NO_OPTION || message === BUILD_FAILED) {
        return step(
            `This page could not read Bugnet's payment request. Nothing was charged. Reload the page${orSend(c)}`,
        );
    }
    return step(
        `${c.wallet} returned no signed payment. Nothing was charged. Press Pay to try again.`,
    );
}

// Pay is offered again at once without a Retry-After, so the line names no wait then
function waitText(s: number | undefined): string {
    return s === undefined || s <= 0 ? "" : ` in ${s} s`;
}

const CLOSED_FUNDING: Record<string, (amount: string) => string> = {
    allowance_ceiling: (a) =>
        `Paid, but this sandbox already holds the most allowance Bugnet allows. The ${a} is being returned to the paying wallet.`,
    sandbox_ended: (a) =>
        `Paid, but the sandbox has ended. The ${a} is being returned to the paying wallet.`,
    allowance_pool_full: (a) =>
        `Paid, but Bugnet holds as much allowance money as it allows right now. The ${a} is being returned to the paying wallet.`,
    order_expired: (a) =>
        `Paid after the order expired. The ${a} is being returned to the paying wallet.`,
};

const INVALID = new Set([
    "payment_invalid",
    "payment_malformed",
    "payment_order_mismatch",
    "payer_invalid",
]);
const SIMULATION_FAILED = "invalid_exact_svm_transaction_simulation_failed";

// A wallet payment's outcome (W4, W15 to W33)
export function pageStep(r: PayFlowResult, c: MessageContext & { wallet: string }): PageStep {
    const amount = amountLabel(c.amountMicros);
    switch (r) {
        case "paid":
            return {
                message: "Go back to your agent. It continues on its own.",
                state: "paid",
            };
        case "settling_timeout":
            // The poller keeps watching: if the payment falls back to unpaid, Pay comes back
            return {
                message:
                    "The payment is still confirming on Solana. This page updates when it lands.",
                state: "settling",
                watch: {},
            };
        case "network_busy":
            return {
                message:
                    "Bugnet could not get a recent Solana block. Nothing was charged. Press Pay again in a few seconds.",
                payAfterMs: 0,
            };
        case "unconfirmed":
            return {
                message:
                    "The connection dropped after sending. Checking whether the payment landed.",
                watch: { unpaidForMs: UNCONFIRMED_UNPAID_FOR_MS },
            };
        case "unpaid_after_submit":
            return {
                message:
                    "The payment did not land on Solana. Nothing was charged. Press Pay to try again.",
                payAfterMs: 0,
            };
    }
    if ("short" in r) return { message: shortBalance(r.short.haveMicros, c), payAfterMs: 0 };
    if ("unavailable" in r) {
        const s = r.retryAfterSeconds;
        const after = s === undefined ? 0 : s * 1_000;
        switch (r.unavailable) {
            case "payer_busy":
                return {
                    message:
                        "This wallet already runs as many sandboxes as Bugnet allows at once. Nothing was charged. Stop a sandbox, then press Pay.",
                    payAfterMs: 0,
                };
            case "payer_rate_limited":
            case "too_many_attempts":
                return {
                    message: `Too many tries from this wallet. Nothing was charged. Press Pay again${waitText(s)}.`,
                    payAfterMs: after,
                };
            case "x402_disabled":
                return {
                    message:
                        "Bugnet is not taking allowance payments right now. Nothing was charged. Ask your agent to try again later.",
                    payAfterMs: 0,
                };
            default:
                return {
                    message: `Bugnet cannot take the payment right now. Nothing was charged. Press Pay again${waitText(s)}.`,
                    payAfterMs: after,
                };
        }
    }
    const code = r.code;
    switch (r.refused) {
        case "payer_blocked":
            return {
                message:
                    r.blockedUntil === undefined
                        ? "Bugnet blocks this wallet. Nothing was charged. Pay from another wallet."
                        : `Bugnet blocks this wallet until ${dateTime(c, r.blockedUntil)}. Nothing was charged. Pay from another wallet.`,
                payAfterMs: 0,
            };
        case "x402_disabled":
            return {
                message:
                    "Bugnet is not taking allowance payments right now. Nothing was charged. Ask your agent to try again later.",
                payAfterMs: 0,
            };
        case "payment_replayed":
            return {
                message:
                    "This signed payment was already sent once. Nothing was charged again. Press Pay to sign a new one.",
                payAfterMs: 0,
            };
        case "order_closed": {
            const funding = code === undefined ? undefined : CLOSED_FUNDING[code];
            if (funding !== undefined) return { message: funding(amount), watch: {} };
            return { message: `This order is closed and cannot be paid. ${ASK_NEW_LINK}` };
        }
        case "order_unknown":
            return { message: `Bugnet has no order for this link. ${ASK_NEW_LINK}` };
        case "order_unpaid":
            return stateStep("unpaid", c);
        case "order_expired":
            return stateStep("expired", c);
        case "order_refunded":
            return stateStep("refunded", c);
        case "order_review":
            return stateStep("review", c);
    }
    if (INVALID.has(r.refused)) {
        if (r.refused === "payment_invalid" && code === SIMULATION_FAILED) {
            return {
                message: `Solana refused the payment, most often because the account holds less than ${amount} USDC. Nothing was charged. Add USDC${orSend(c)}`,
                payAfterMs: 0,
            };
        }
        return {
            message: `Bugnet could not accept the transaction ${c.wallet} signed. Nothing was charged. Press Pay to try again${orSend(c)}`,
            payAfterMs: 0,
        };
    }
    return {
        message: `Bugnet refused the payment (${code ?? r.refused}). Nothing was charged. Press Pay to try again, or write to ${SUPPORT}.`,
        payAfterMs: 0,
    };
}

// An order's state without a deposit, or after a wallet payment (M4, M7, M18, P2, P3, W16, W18)
export function stateStep(s: PublicState | undefined, c: MessageContext): PageStep {
    switch (s) {
        case undefined:
        case "settling":
            return {
                message:
                    "The payment is still confirming on Solana. This page updates when it lands.",
                ...(s === undefined ? {} : { state: s }),
            };
        case "unpaid":
            return {
                message:
                    "The payment did not land on Solana. Nothing was charged. Press Pay to try again.",
                state: s,
                payAfterMs: 0,
            };
        case "paid":
            return { message: "Go back to your agent. It continues on its own.", state: s };
        case "expired":
            return {
                message: `This order expired at ${c.deadline} and nothing was charged. ${ASK_NEW_LINK}`,
                state: s,
            };
        case "refunded":
            return { message: P3, state: s };
        case "review":
            return {
                message: `This payment needs a check by hand. The money is safe. Write to ${SUPPORT} with order ${c.orderId}.`,
                state: s,
            };
    }
}
