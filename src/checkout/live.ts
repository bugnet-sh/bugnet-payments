import type { DepositView } from "../deposits/types.ts";
import type { PublicState } from "../http/public.ts";
import type { OrderKind } from "../orders/types.ts";

export { fetchStatus } from "./flow.ts";

// The page's live view of an order, from GET /o/{id}/status (spec 15.4)
export interface StatusView {
    state: PublicState;
    expiresAt: number;
    serverNow: number;
    amountMicros: number;
    kind: OrderKind;
    deposit: DepositView | null;
}

const STATES = new Set<PublicState>([
    "unpaid",
    "settling",
    "paid",
    "expired",
    "refunded",
    "review",
]);
const KINDS = new Set<OrderKind>(["start", "extend", "allowance"]);
const VISIBLE_POLL_MS = 2_000;
const HIDDEN_POLL_MS = 10_000;
// Past the deadline and its grace, an order whose status stops changing is left alone
const QUIET_AFTER_MS = 120_000;
const BUSY_STATUSES = new Set(["confirming", "held", "checking", "refunding"]);
const FINAL_STATES = new Set<PublicState>(["paid", "expired", "refunded", "review"]);

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseStatus(body: unknown): StatusView | null {
    if (!isRecord(body)) return null;
    const { state, expiresAt, now, amountMicros, kind, deposit } = body;
    if (typeof state !== "string" || !STATES.has(state as PublicState)) return null;
    const expires = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
    if (Number.isNaN(expires)) return null;
    const serverNow = typeof now === "string" ? Date.parse(now) : NaN;
    return {
        state: state as PublicState,
        expiresAt: expires,
        serverNow: Number.isNaN(serverNow) ? Date.now() : serverNow,
        amountMicros: typeof amountMicros === "number" ? amountMicros : 0,
        kind:
            typeof kind === "string" && KINDS.has(kind as OrderKind)
                ? (kind as OrderKind)
                : "start",
        deposit:
            isRecord(deposit) && typeof deposit.address === "string"
                ? (deposit as unknown as DepositView)
                : null,
    };
}

export function timeLeft(expiresAtMs: number, nowMs: number): string {
    const s = Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function pollDelay(o: {
    visible: boolean;
    failures: number;
    retryAfterSeconds?: number;
}): number {
    if (o.retryAfterSeconds !== undefined) return o.retryAfterSeconds * 1_000;
    return o.visible ? VISIBLE_POLL_MS : HIDDEN_POLL_MS;
}

// returningMicros counts every returning transfer; the list holds only the newest ten
function busy(v: StatusView): boolean {
    const d = v.deposit;
    if (d === null) return false;
    return (
        BUSY_STATUSES.has(d.status) ||
        d.returningMicros > 0 ||
        d.transfers.some((t) => t.outcome === "returning")
    );
}

/**
 * Spec 15.4: polling goes on while money moves, stops once the order is final, and otherwise
 * stops 2 min after expiresAt + settle_grace if nothing changes. changedAtMs is when the status
 * last differed from the answer before it.
 */
export function keepPolling(
    v: StatusView,
    nowMs: number,
    settleGraceMs: number,
    changedAtMs = Number.NEGATIVE_INFINITY,
): boolean {
    if (busy(v)) return true;
    if (FINAL_STATES.has(v.state)) return false;
    return nowMs <= Math.max(v.expiresAt + settleGraceMs, changedAtMs) + QUIET_AFTER_MS;
}

// What tells one answer from the next, without the server's clock
export function statusKey(v: StatusView): string {
    return JSON.stringify([v.state, v.deposit]);
}

/**
 * After W16 or W17 the wallet section waits on the poller: an order read unpaid for unpaidForMs
 * did not get the payment, and the page shows W18 and offers Pay again. Settling restarts the
 * count with no wait; any other state ends the watch.
 */
export interface WalletWatch {
    unpaidForMs: number;
    unpaidSince: number | null;
}

export function watchWallet(
    w: WalletWatch,
    state: PublicState,
    nowMs: number,
): WalletWatch | "unpaid" | null {
    if (state === "settling") return { unpaidForMs: 0, unpaidSince: null };
    if (state !== "unpaid") return null;
    const since = w.unpaidSince ?? nowMs;
    return nowMs - since >= w.unpaidForMs ? "unpaid" : { ...w, unpaidSince: since };
}

// A page drawn for another state shows no address and no Pay button, so it reloads once the
// order takes money again
export function needsReload(renderedState: string | undefined, v: StatusView): boolean {
    return v.state === "unpaid" && renderedState !== undefined && renderedState !== "unpaid";
}

// The whole price arrived and is confirming: the page asks for nothing more while it lands,
// since a way to pay left in view invites a second payment (owner ruling, 2026-11-12)
export function confirmingInFull(d: Pick<DepositView, "status" | "remainingMicros">): boolean {
    return d.status === "confirming" && d.remainingMicros <= 0;
}

// Every way to pay goes once the order no longer takes money
export function showWalletOptions(v: StatusView): boolean {
    return v.state === "unpaid" && (v.deposit === null || !confirmingInFull(v.deposit));
}

// The address and its notes ask for money, so they show only while money sent there can still
// pay the order: a closed order says only what happened (spec 15.1), and a deposit in review
// signs nothing until an operator looks
export function showDepositAsk(v: StatusView): boolean {
    return showWalletOptions(v) && v.deposit?.status !== "review";
}

// The deposit QR asks for money, so it shows only while the order still lacks some
export function showDepositQr(v: StatusView): boolean {
    return showDepositAsk(v) && v.deposit !== null && v.deposit.remainingMicros > 0;
}

// Which ways to pay the page shows. A found browser wallet shows its Pay button. Without one, the
// wallet app links show on a phone or on a page with no address. The code that opens the page in
// Phantom shows whenever no address shows, off a phone, even beside a found wallet, which may
// hold no USDC; so a page never draws two codes.
export interface Arrangement {
    wallet: boolean;
    phone: boolean;
    phoneLinks: boolean;
    phoneQr: boolean;
    or: boolean;
}

export function arrangement(o: {
    takesMoney: boolean;
    walletsFound: number;
    address: boolean;
    phone: boolean;
}): Arrangement {
    const wallet = o.takesMoney && o.walletsFound > 0;
    const phoneLinks = o.takesMoney && o.walletsFound === 0 && (o.phone || !o.address);
    const phoneQr = o.takesMoney && !o.address && !o.phone;
    const phone = phoneLinks || phoneQr;
    return { wallet, phone, phoneLinks, phoneQr, or: o.address && (wallet || phone) };
}

// Each found wallet gets a button that names it
export const payLabel = (wallet: string | undefined): string =>
    wallet === undefined ? "Pay" : `Pay with ${wallet}`;
