import { describe, expect, it } from "vitest";
import type { DepositView } from "../deposits/types.ts";
import {
    arrangement,
    arrivedMicros,
    confirmingInFull,
    fetchStatus,
    keepPolling,
    needsReload,
    parseStatus,
    payLabel,
    pollDelay,
    showDepositAsk,
    showDepositQr,
    showWalletOptions,
    statusKey,
    type StatusView,
    timeLeft,
    watchWallet,
} from "./live.ts";

const T = (hms: string) => Date.parse(`2030-01-01T${hms}.000Z`);

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

    it("every way to pay shows while the order takes money", () => {
        expect(showWalletOptions(view("unpaid", { receivedMicros: 30_000 }))).toBe(true);
        expect(showWalletOptions(view("paid"))).toBe(false);
    });

    it("with the whole price in and confirming, the page asks for nothing more", () => {
        const full = view("unpaid", {
            status: "confirming",
            receivedMicros: 50_000,
            remainingMicros: 0,
        });
        expect(confirmingInFull(full.deposit!)).toBe(true);
        expect(showWalletOptions(full)).toBe(false);
        expect(showDepositAsk(full)).toBe(false);
        expect(showDepositQr(full)).toBe(false);
        // Part of it confirming still asks for the rest
        const part = view("unpaid", {
            status: "confirming",
            receivedMicros: 20_000,
            remainingMicros: 30_000,
        });
        expect(confirmingInFull(part.deposit!)).toBe(false);
        expect(showDepositAsk(part)).toBe(true);
    });
});

describe("which ways to pay show", () => {
    const at = (o: Partial<Parameters<typeof arrangement>[0]>) =>
        arrangement({ takesMoney: true, walletsFound: 0, address: true, phone: false, ...o });

    const none = { wallet: false, phone: false, phoneLinks: false, phoneQr: false, or: false };

    it("a found wallet always shows, under the address after an or", () => {
        for (const phone of [false, true]) {
            expect(at({ walletsFound: 1, phone })).toEqual({ ...none, wallet: true, or: true });
        }
    });

    it("without an address, a found wallet keeps the Phantom code beside it off a phone", () => {
        // The extension may hold no USDC while the phone does
        expect(at({ walletsFound: 2, address: false })).toEqual({
            ...none,
            wallet: true,
            phone: true,
            phoneQr: true,
        });
        // A phone with a wallet is inside that wallet: neither links nor a code it cannot scan
        expect(at({ walletsFound: 1, address: false, phone: true })).toEqual({
            ...none,
            wallet: true,
        });
    });

    it("with no wallet and an address, a desktop shows the address alone and a phone adds the app links", () => {
        expect(at({})).toEqual(none);
        expect(at({ phone: true })).toEqual({ ...none, phone: true, phoneLinks: true, or: true });
    });

    it("with no wallet and no address, the page offers the phone, its code off a phone", () => {
        expect(at({ address: false })).toEqual({
            ...none,
            phone: true,
            phoneLinks: true,
            phoneQr: true,
        });
        expect(at({ address: false, phone: true })).toEqual({
            ...none,
            phone: true,
            phoneLinks: true,
        });
    });

    it("an order that no longer takes money offers nothing", () => {
        for (const walletsFound of [0, 1, 2]) {
            for (const address of [false, true]) {
                expect(at({ takesMoney: false, walletsFound, address })).toEqual(none);
            }
        }
    });

    it("never draws two codes: the phone code shows only where no address shows", () => {
        for (const address of [false, true]) {
            for (const phone of [false, true]) {
                for (const walletsFound of [0, 1]) {
                    const a = at({ address, phone, walletsFound });
                    expect(a.phoneQr && address).toBe(false);
                }
            }
        }
    });

    it("each wallet's button names it, and the whole price once money already arrived", () => {
        expect(payLabel(undefined)).toBe("Pay");
        expect(payLabel("Phantom")).toBe("Pay with Phantom");
        expect(payLabel("Phantom", "$0.08")).toBe("Pay $0.08 with Phantom");
    });

    it("money at the address counts only while the address shows", () => {
        expect(arrivedMicros(view("unpaid", {}))).toBe(0);
        expect(arrivedMicros(view("unpaid", { receivedMicros: 20_000, otherMicros: 5_000 }))).toBe(
            25_000,
        );
        // In review that money waits for a person, and is not returned on its own
        expect(arrivedMicros(view("unpaid", { status: "review", receivedMicros: 20_000 }))).toBe(0);
        expect(arrivedMicros(view("paid", { receivedMicros: 50_000 }))).toBe(0);
    });
});

describe("status requests", () => {
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
