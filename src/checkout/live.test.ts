import { describe, expect, it } from "vitest";
import type { DepositView } from "../deposits/types.ts";
import {
    fetchStatus,
    keepPolling,
    parseStatus,
    pollDelay,
    showWalletOptions,
    type StatusView,
    timeLeft,
    walletNote,
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
    });
});
