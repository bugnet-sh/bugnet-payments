import type { DepositView } from "../deposits/types.ts";
import type { PublicState } from "../http/public.ts";
import type { OrderKind } from "../orders/types.ts";
import { type MessageContext, walletNoteText } from "./messages.ts";

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
// Past the deadline and its grace, an order whose page stops changing is left alone
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

// The only status request the page makes; without Bugnet-Client the server never notes a viewer
export function fetchStatus(d: { fetch: typeof fetch; orderUrl: string }): Promise<Response> {
    return d.fetch(`${d.orderUrl}/status`, {
        headers: { Accept: "application/json", "Bugnet-Client": "checkout" },
    });
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

function busy(v: StatusView): boolean {
    const d = v.deposit;
    if (d === null) return false;
    return BUSY_STATUSES.has(d.status) || d.transfers.some((t) => t.outcome === "returning");
}

export function keepPolling(v: StatusView, nowMs: number, settleGraceMs: number): boolean {
    if (busy(v)) return true;
    if (FINAL_STATES.has(v.state)) return false;
    return nowMs <= v.expiresAt + settleGraceMs + QUIET_AFTER_MS;
}

// The wallet and phone sections go only once the order no longer takes money
export function showWalletOptions(v: StatusView): boolean {
    return v.state === "unpaid";
}

// W35 while the order still takes a wallet payment and money already reached the address
export function walletNote(v: StatusView, c: MessageContext): string | null {
    if (!showWalletOptions(v) || v.deposit === null) return null;
    return v.deposit.receivedMicros + v.deposit.otherMicros > 0 ? walletNoteText(c) : null;
}
