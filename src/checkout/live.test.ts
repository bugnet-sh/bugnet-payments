import { describe, expect, it } from "vitest";
import type { DepositView } from "../deposits/types.ts";
import {
    fetchStatus,
    keepPolling,
    needsReload,
    parseStatus,
    pollDelay,
    showDepositAsk,
    showDepositQr,
    showWalletOptions,
    statusKey,
    type StatusView,
    timeLeft,
    walletNote,
    watchWallet,
} from "./live.ts";

const T = (hms: string) => Date.parse(`2030-01-01T${hms}.000Z`);
const C = { amountMicros: 50_000, deadline: "14:05", refundMinMicros: 1_000, orderId: "ord_a" };

function view(state: StatusView["state"], d: Partial<DepositView> | null = null): StatusView {
    return {
        state,
        expiresAt: T("00:15:00"),
        serverNow: T("00:05:00"),
        amountMicros: 50_000,
        kind: "start",
        deposit:
            d === null
                ? null
                : ({
                      address: "A",
                      status: "waiting",
                      receivedMicros: 0,
                      otherMicros: 0,
                      transfers: [],
                      ...d,
                  } as DepositView),
    };
}

describe("live status", () => {
    it("timeLeft", () => {
        expect(timeLeft(T("00:15:00"), T("00:00:28"))).toBe("14:32");
        expect(timeLeft(T("00:15:00"), T("00:14:18"))).toBe("0:42");
        expect(timeLeft(T("00:15:00"), T("00:15:05"))).toBe("0:00");
    });

    it("pollDelay", () => {
        expect(pollDelay({ visible: true, failures: 0 })).toBe(2_000);
        expect(pollDelay({ visible: false, failures: 0 })).toBe(10_000);
        expect(pollDelay({ visible: true, failures: 0, retryAfterSeconds: 5 })).toBe(5_000);
    });

    it("keepPolling", () => {
        const now = T("00:05:00");
        expect(keepPolling(view("paid", { status: "paid" }), now, 60_000)).toBe(false);
        expect(
            keepPolling(
                view("paid", {
                    status: "paid",
                    transfers: [{ outcome: "returning" } as DepositView["transfers"][number]],
                }),
                now,
                60_000,
            ),
        ).toBe(true);
        expect(keepPolling(view("unpaid", { status: "held" }), now, 60_000)).toBe(true);
        expect(keepPolling(view("expired"), T("00:18:00") + 1, 60_000)).toBe(false);
        expect(keepPolling(view("unpaid", { status: "checking" }), T("00:30:00"), 60_000)).toBe(
            true,
        );
        // A return in flight past the newest ten transfers still keeps it
        expect(
            keepPolling(view("paid", { status: "paid", returningMicros: 2_000 }), now, 60_000),
        ).toBe(true);
    });

    it("keepPolling stops 2 min after the grace only once nothing changes", () => {
        // A wallet payment settling with no deposit: neither busy nor final
        const settling = view("settling");
        const limit = T("00:18:00");
        expect(keepPolling(settling, limit, 60_000, T("00:10:00"))).toBe(true);
        expect(keepPolling(settling, limit + 1, 60_000, T("00:10:00"))).toBe(false);
        // Still changing past the limit: it goes on until 2 min pass with no change
        expect(keepPolling(settling, limit + 1, 60_000, T("00:17:30"))).toBe(true);
        expect(keepPolling(settling, T("00:19:30") + 1, 60_000, T("00:17:30"))).toBe(false);
        expect(statusKey(settling)).toBe(statusKey({ ...settling, serverNow: T("00:06:00") }));
        expect(statusKey(settling)).not.toBe(statusKey(view("paid")));
    });

    it("after W17 or W16 the poller brings back Pay with W18", () => {
        const t0 = T("00:05:00");
        // W17: unpaid must last 20 s
        let w = watchWallet({ unpaidForMs: 20_000, unpaidSince: null }, "unpaid", t0);
        expect(w).toEqual({ unpaidForMs: 20_000, unpaidSince: t0 });
        expect(watchWallet(w as never, "unpaid", t0 + 19_999)).toEqual(w);
        expect(watchWallet(w as never, "unpaid", t0 + 20_000)).toBe("unpaid");
        // Settling restarts the count with no wait, so a later unpaid is final at once
        w = watchWallet(w as never, "settling", t0 + 5_000);
        expect(w).toEqual({ unpaidForMs: 0, unpaidSince: null });
        expect(watchWallet(w as never, "unpaid", t0 + 6_000)).toBe("unpaid");
        // W16 watches with no wait; a paid order ends the watch
        expect(watchWallet({ unpaidForMs: 0, unpaidSince: null }, "unpaid", t0)).toBe("unpaid");
        expect(watchWallet({ unpaidForMs: 0, unpaidSince: null }, "paid", t0)).toBeNull();
    });

    it("the deposit QR shows only while the order lacks money", () => {
        expect(showDepositQr(view("unpaid", { remainingMicros: 20_000 }))).toBe(true);
        expect(showDepositQr(view("unpaid", { status: "held", remainingMicros: 0 }))).toBe(false);
        expect(showDepositQr(view("settling", { remainingMicros: 20_000 }))).toBe(false);
        expect(showDepositQr(view("unpaid"))).toBe(false);
    });

    it("the deposit ask shows only while money sent to the address can still pay", () => {
        expect(showDepositAsk(view("unpaid", { remainingMicros: 20_000 }))).toBe(true);
        expect(showDepositAsk(view("unpaid", { status: "held", remainingMicros: 0 }))).toBe(true);
        for (const state of ["settling", "paid", "expired", "refunded", "review"] as const) {
            expect(showDepositAsk(view(state, { status: "paid", remainingMicros: 0 }))).toBe(false);
        }
        // Review signs nothing until an operator looks, so money sent now cannot pay
        const review = view("unpaid", { status: "review", remainingMicros: 30_000 });
        expect(showDepositAsk(review)).toBe(false);
        expect(showDepositQr(review)).toBe(false);
        expect(showWalletOptions(review)).toBe(true);
    });

    it("a page drawn for another state reloads once the order reads unpaid", () => {
        expect(needsReload("settling", view("unpaid"))).toBe(true);
        expect(needsReload("expired", view("unpaid", {}))).toBe(true);
        expect(needsReload("unpaid", view("unpaid"))).toBe(false);
        expect(needsReload("settling", view("settling"))).toBe(false);
        expect(needsReload("settling", view("paid"))).toBe(false);
    });

    it("showWalletOptions and walletNote", () => {
        expect(showWalletOptions(view("unpaid", { receivedMicros: 30_000 }))).toBe(true);
        expect(showWalletOptions(view("paid"))).toBe(false);
        expect(walletNote(view("unpaid", {}), C)).toBeNull();
        const w35 =
            "Money already arrived at the address above. A wallet payment charges the full $0.05, and that money then goes back to the wallet that sent it.";
        expect(walletNote(view("unpaid", { receivedMicros: 1 }), C)).toBe(w35);
        expect(walletNote(view("unpaid", { otherMicros: 1 }), C)).toBe(w35);
    });

    it("fetchStatus sends both headers", async () => {
        const seen: { url: string; headers: Record<string, string> }[] = [];
        const fake = (async (url: string, init?: RequestInit) => {
            seen.push({ url, headers: init?.headers as Record<string, string> });
            return new Response("{}");
        }) as unknown as typeof fetch;
        await fetchStatus({ fetch: fake, orderUrl: "https://pay.bugnet.sh/o/ord_a" });
        expect(seen).toEqual([
            {
                url: "https://pay.bugnet.sh/o/ord_a/status",
                headers: { Accept: "application/json", "Bugnet-Client": "checkout" },
            },
        ]);
    });

    it("parseStatus", () => {
        const v = parseStatus({
            orderId: "ord_a",
            state: "unpaid",
            expiresAt: "2030-01-01T00:15:00.000Z",
            now: "2030-01-01T00:05:00.000Z",
            amountMicros: 50_000,
            kind: "start",
        });
        expect(v).toMatchObject({
            state: "unpaid",
            expiresAt: T("00:15:00"),
            serverNow: T("00:05:00"),
            deposit: null,
        });
        expect(parseStatus({ state: "weird", expiresAt: "2030-01-01T00:15:00.000Z" })).toBeNull();
        const deposit = {
            address: "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley",
            ready: true,
            status: "partial",
            receivedMicros: 30_000,
            otherMicros: 0,
            remainingMicros: 20_000,
            extraMicros: 0,
            returningMicros: 0,
            returnedMicros: 0,
            keptMicros: 0,
            reviewMicros: 0,
            reason: null,
            reasonMicros: 0,
            blockedUntil: null,
            hold: null,
            transfers: [],
        };
        expect(
            parseStatus({
                orderId: "ord_a",
                state: "unpaid",
                expiresAt: "2030-01-01T00:15:00.000Z",
                now: "2030-01-01T00:05:00.000Z",
                amountMicros: 50_000,
                kind: "allowance",
                deposit,
            }),
        ).toEqual({
            state: "unpaid",
            expiresAt: T("00:15:00"),
            serverNow: T("00:05:00"),
            amountMicros: 50_000,
            kind: "allowance",
            deposit,
        });
    });
});
