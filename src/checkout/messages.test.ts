import { describe, expect, it } from "vitest";
import type { DepositView } from "../deposits/types.ts";
import {
    BUILD_FAILED,
    errorStage,
    NO_ACCOUNT,
    NO_OPTION,
    NO_SIGNED,
    UNREADABLE_CHALLENGE,
    walletError,
} from "./flow.ts";
import type { StatusView } from "./live.ts";
import {
    depositAsk,
    depositLine,
    errorStep,
    PAGE_TEXT,
    pageStep,
    walletMessage,
} from "./messages.ts";

const ID = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const C = {
    amountMicros: 50_000,
    deadline: "14:05",
    refundMinMicros: 1_000,
    orderId: ID,
    formatTime: () => "14:06",
    formatDateTime: () => "2 Jan 2030, 00:00",
};
const W = { ...C, wallet: "Phantom" };

function dep(over: Partial<DepositView> = {}): DepositView {
    return {
        address: "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley",
        ready: true,
        status: "waiting",
        receivedMicros: 0,
        otherMicros: 0,
        remainingMicros: 50_000,
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
        ...over,
    };
}
function view(d: Partial<DepositView>, state: StatusView["state"] = "unpaid"): StatusView {
    return {
        state,
        expiresAt: 1,
        serverNow: 0,
        amountMicros: 50_000,
        kind: "start",
        deposit: dep(d),
    };
}
const line = (d: Partial<DepositView>, state?: StatusView["state"]) =>
    depositLine(view(d, state), C);

describe("deposit lines", () => {
    it("waiting, partial and confirming", () => {
        expect(line({})).toEqual({
            label: "Waiting for your transfer",
            message:
                "Send 0.05 USDC to the address above by 14:05. This page updates when it arrives.",
            extra: [],
        });
        expect(
            line({ status: "partial", receivedMicros: 30_000, remainingMicros: 20_000 }),
        ).toEqual({
            label: "Partly paid",
            message: "Received $0.03. Send $0.02 more to the same address by 14:05.",
            extra: [],
        });
        expect(line({ status: "confirming", receivedMicros: 50_000 }).message).toBe(
            "Received $0.05. Confirming the payment on Solana.",
        );
    });

    it("once money has arrived, the section asks for the rest and the line says what arrived", () => {
        expect(depositAsk(50_000, { remainingMicros: 50_000 })).toEqual({
            plain: "0.05",
            alt: "Solana Pay code for 0.05 USDC",
            caption: "Scan with a Solana wallet app to send 0.05 USDC",
            exchange:
                "From an exchange, send exactly 0.05 USDC. Anything returned goes back to the sending address, which an exchange may not credit to you.",
        });
        expect(depositAsk(50_000, { remainingMicros: 20_000 })).toEqual({
            plain: "0.02",
            alt: "Solana Pay code for 0.02 USDC",
            caption: "Scan with a Solana wallet app to send 0.02 USDC",
            exchange:
                "From an exchange, send exactly 0.02 USDC. Anything returned goes back to the sending address, which an exchange may not credit to you.",
        });
        // Covered only with a held wallet's money: another wallet still pays the price (M24)
        expect(depositAsk(50_000, { remainingMicros: 0 }).plain).toBe("0.05");
        expect(
            line({ status: "partial", receivedMicros: 30_000, remainingMicros: 20_000 }).message,
        ).toBe("Received $0.03. Send $0.02 more to the same address by 14:05.");
    });

    it("an order paid by deposit and then refunded reads Refunded, never Paid", () => {
        for (const extraMicros of [0, 5_000]) {
            expect(
                line(
                    { status: "paid", receivedMicros: 50_000, remainingMicros: 0, extraMicros },
                    "refunded",
                ),
            ).toEqual({
                label: "Refunded",
                message: "This order's payment was returned to the wallet that paid.",
                extra: [],
            });
        }
        expect(
            line({ status: "paid", receivedMicros: 50_000, remainingMicros: 0 }, "paid"),
        ).toEqual({
            label: "Paid",
            message: "Paid. Go back to your agent; it continues on its own.",
            extra: [],
        });
    });

    it("partial with a blocked sender's money returning adds M13", () => {
        const r = line({
            status: "partial",
            receivedMicros: 30_000,
            remainingMicros: 20_000,
            reason: "payer_blocked",
            reasonMicros: 20_000,
            blockedUntil: "2030-01-02T00:00:00.000Z",
        });
        expect(r.message).toBe("Received $0.03. Send $0.02 more to the same address by 14:05.");
        expect(r.extra).toEqual([
            "Bugnet blocks the wallet that sent $0.02 until 2 Jan 2030, 00:00, so that money is being returned to it.",
        ]);
    });

    it("other wallets' money adds M31", () => {
        const r = line({
            status: "partial",
            receivedMicros: 30_000,
            otherMicros: 10_000,
            remainingMicros: 20_000,
        });
        expect(r.message).toBe("Received $0.03. Send $0.02 more to the same address by 14:05.");
        expect(r.extra).toEqual([
            "$0.01 also arrived from other wallets. It is not counted in the amount above.",
        ]);
    });

    it("held lines by hold reason", () => {
        const held = (reason: string) =>
            line({
                status: "held",
                receivedMicros: 50_000,
                hold: { reason, until: "2030-01-01T00:16:00.000Z" } as DepositView["hold"],
            });
        expect(held("payer_busy")).toEqual({
            label: "Waiting for a free slot",
            message:
                "Received $0.05 from a wallet at its sandbox limit. Bugnet tries again until 14:06, then returns it. 0.05 USDC from another wallet pays at once.",
            extra: [],
        });
        expect(held("anonymous_busy").message).toBe(
            "Received $0.05. Bugnet has no free sandbox slot for this payment right now. It tries again until 14:06, then returns the money.",
        );
        expect(held("allowance_paused").message).toBe(
            "Received $0.05. Bugnet's allowance service paused for a moment. It tries again until 14:06, then returns the money if it is still paused.",
        );
        expect(held("router_unavailable").message).toBe(
            "Received $0.05. Bugnet is confirming this top-up with its sandbox service and tries again until 14:06, then returns the money.",
        );
    });

    it("past the deadline a held wallet's line offers no other wallet (M4)", () => {
        const v = view({
            status: "held",
            receivedMicros: 50_000,
            hold: { reason: "payer_busy", until: "2030-01-01T00:16:00.000Z" },
        });
        expect(depositLine({ ...v, serverNow: 5, expiresAt: 5 }, C).message).toBe(
            "Received $0.05 from a wallet at its sandbox limit. Bugnet tries again until 14:06, then returns it.",
        );
    });

    it("late money on an order paid with extra names the late money, the newest", () => {
        const late = { reason: "late", reasonMicros: 2_000, extraMicros: 2_000 } as const;
        expect(line({ status: "paid", ...late, returningMicros: 2_000 }, "paid").message).toBe(
            "$0.002 arrived after this order closed and is being returned to the address that sent it.",
        );
        expect(line({ status: "paid", ...late, returnedMicros: 4_000 }, "paid").message).toBe(
            "$0.002 arrived after this order closed and was returned to the address that sent it.",
        );
        expect(
            line(
                { status: "paid", reason: "extra", extraMicros: 2_000, returningMicros: 2_000 },
                "paid",
            ).message,
        ).toBe("Paid. The extra $0.002 is being returned to the address that sent it.");
    });

    it("a wallet-paid order reads Paid while stray deposit money goes back (M6)", () => {
        const stray = { reason: "paid_otherwise", reasonMicros: 2_000 } as const;
        expect(line({ status: "refunding", ...stray }, "paid").label).toBe("Paid");
        expect(line({ status: "refunded", ...stray }, "paid").label).toBe("Paid");
        expect(line({ status: "refunded", ...stray }, "expired").label).toBe("Refunded");
    });

    it("paid, expired, refunding, review, checking and kept", () => {
        expect(line({ status: "paid" }, "paid").message).toBe(
            "Paid. Go back to your agent; it continues on its own.",
        );
        expect(
            line({ status: "paid", extraMicros: 10_000, returningMicros: 10_000 }, "paid").message,
        ).toBe("Paid. The extra $0.01 is being returned to the address that sent it.");
        expect(
            line({ status: "paid", extraMicros: 10_000, returnedMicros: 10_000 }, "paid").message,
        ).toBe("Paid. The extra $0.01 was returned to the address that sent it.");
        expect(line({ status: "expired" }, "expired").message).toBe(
            "This order expired at 14:05 and nothing was charged. Ask your agent for a new payment link.",
        );
        expect(
            line(
                {
                    status: "refunding",
                    reason: "unpaid",
                    reasonMicros: 30_000,
                    returningMicros: 30_000,
                },
                "expired",
            ).message,
        ).toBe(
            "Time ran out before the full amount arrived. The $0.03 you sent is being returned to the address that sent it.",
        );
        expect(
            line(
                {
                    status: "refunded",
                    reason: "unpaid",
                    reasonMicros: 30_000,
                    returnedMicros: 30_000,
                },
                "refunded",
            ).message,
        ).toBe(
            "Time ran out before the full amount arrived. The $0.03 you sent was returned. Ask your agent for a new payment link.",
        );
        expect(line({ status: "review" }, "review").message).toBe(
            `This payment needs a check by hand. The money is safe. Write to support@bugnet.org with order ${ID}.`,
        );
        expect(line({ status: "checking" }).message).toBe(
            "Time is up. Checking for a transfer sent in the last moments.",
        );
        expect(
            line({ status: "expired", reason: "below_minimum", keptMicros: 500 }, "expired")
                .message,
        ).toBe("$0.0005 arrived, which is below the $0.001 Bugnet returns, so it was kept.");
    });

    it("partial with money in review adds M23", () => {
        const r = line({
            status: "partial",
            receivedMicros: 30_000,
            remainingMicros: 20_000,
            reviewMicros: 7_000,
        });
        expect(r.extra).toEqual([
            `$0.007 arrived in a way Bugnet cannot return on its own. It is safe. To get it back, write to support@bugnet.org with order ${ID} and a message signed by the sending wallet.`,
        ]);
    });

    it("late money names the amount that arrived", () => {
        const late = { reason: "late" as const, reasonMicros: 2_000 };
        expect(line({ status: "refunding", ...late }, "paid").message).toBe(
            "$0.002 arrived after this order closed and is being returned to the address that sent it.",
        );
        expect(line({ status: "refunded", ...late }, "paid").message).toBe(
            "$0.002 arrived after this order closed and was returned to the address that sent it.",
        );
        expect(
            line({ status: "refunding", reason: "after_paid", reasonMicros: 2_000 }, "paid")
                .message,
        ).toBe(
            "$0.002 arrived after this order was paid and is being returned to the address that sent it.",
        );
        expect(
            line({ status: "refunding", reason: "paid_otherwise", reasonMicros: 2_000 }, "paid")
                .message,
        ).toBe(
            "This order was paid with a wallet, so the $0.002 sent to the address is being returned to the address that sent it.",
        );
        for (const reason of [
            "payer_busy",
            "payer_rate_limited",
            "allowance_unavailable",
            "pool_busy",
            "router_unavailable",
        ] as const) {
            const text = line(
                { status: "refunding", reason, reasonMicros: 2_000 },
                "expired",
            ).message;
            expect(text).toContain("$0.002");
            expect(text).not.toContain("$0.05");
        }
    });
});

describe("wallet messages", () => {
    const e = (code: number | undefined) =>
        walletError(
            "Phantom",
            code === undefined
                ? new Error("ZZZ-wallet-text")
                : { code, message: "ZZZ-wallet-text" },
        );

    it("by code", () => {
        expect(walletMessage(e(4001), C).message).toBe(
            "You declined in Phantom. Nothing was charged. Press Pay to try again.",
        );
        expect(walletMessage(e(-32603), { ...C, haveMicros: 0 }).message).toBe(
            "Your Phantom account holds $0.00 USDC on Solana and this order needs $0.05. Nothing was charged. Add USDC, pick another account, or send to the address above.",
        );
        expect(walletMessage(e(-32603), { ...C, haveMicros: 60_000 }).message).toBe(
            "Phantom could not prepare the payment. Nothing was charged. Press Pay to try again, or send to the address above.",
        );
        expect(walletMessage(e(4100), C).message).toBe(
            "Phantom has not allowed this page. Unlock Phantom, approve the connection, then press Pay.",
        );
        expect(walletMessage(e(4900), C).message).toBe(
            "Phantom is offline. Open Phantom, then press Pay again.",
        );
        expect(walletMessage(e(-32002), C).message).toBe(
            "Phantom already has a request open. Finish or close it there, then press Pay.",
        );
        for (const code of [-32000, -32003]) {
            expect(walletMessage(e(code), C).message).toBe(
                "Phantom refused this payment. Nothing was charged. Send to the address above instead.",
            );
        }
    });

    it("a page without an address never points at one (M3)", () => {
        const N = { ...C, hasAddress: false };
        const NW = { ...W, hasAddress: false };
        expect(PAGE_TEXT.noWallet(false)).toBe("No browser wallet found.");
        expect(walletMessage(e(-32603), { ...N, haveMicros: 0 }).message).toBe(
            "Your Phantom account holds $0.00 USDC on Solana and this order needs $0.05. Nothing was charged. Add USDC or pick another account.",
        );
        expect(walletMessage(e(-32603), { ...N, haveMicros: 60_000 }).message).toBe(
            "Phantom could not prepare the payment. Nothing was charged. Press Pay to try again.",
        );
        expect(walletMessage(e(-32000), N).message).toBe(
            "Phantom refused this payment. Nothing was charged.",
        );
        expect(errorStep(new Error(UNREADABLE_CHALLENGE), NW).message).toBe(
            "This page could not read Bugnet's payment request. Nothing was charged. Reload the page.",
        );
        expect(
            pageStep(
                { refused: "payment_invalid", code: "invalid_exact_svm_payload_transaction" },
                NW,
            ).message,
        ).toBe(
            "Bugnet could not accept the transaction Phantom signed. Nothing was charged. Press Pay to try again.",
        );
        expect(
            pageStep(
                {
                    refused: "payment_invalid",
                    code: "invalid_exact_svm_transaction_simulation_failed",
                },
                NW,
            ).message,
        ).toBe(
            "Solana refused the payment, most often because the account holds less than $0.05 USDC. Nothing was charged. Add USDC.",
        );
    });

    it("page-made messages", () => {
        expect(PAGE_TEXT.noWallet(true)).toBe(
            "No browser wallet found. Send to the address above instead.",
        );
        expect(PAGE_TEXT.connecting("Phantom")).toBe("Approve the connection in Phantom.");
        expect(PAGE_TEXT.signing("Phantom")).toBe("Approve the payment in Phantom.");
        expect(PAGE_TEXT.copyFailed).toBe("Copy failed. Select the text and copy it by hand.");
        expect(PAGE_TEXT.unreachable).toBe(
            "Cannot reach Bugnet. This page keeps trying; check your connection.",
        );
        expect(PAGE_TEXT.tooMany(7)).toBe(
            "Too many requests from your network. This page tries again in 7 s.",
        );
    });

    it("a page without a deposit shows P2, P3 and the order's own lines", () => {
        const bare = (state: StatusView["state"]) =>
            depositLine({ ...view({}, state), deposit: null }, C);
        expect(bare("settling")).toEqual({
            label: "Confirming",
            message: "The payment is confirming on Solana. This page updates when it lands.",
            extra: [],
        });
        expect(bare("refunded").message).toBe(
            "This order's payment was returned to the wallet that paid.",
        );
        expect(bare("paid").message).toBe("Paid. Go back to your agent; it continues on its own.");
        expect(bare("expired").message).toBe(
            "This order expired at 14:05 and nothing was charged. Ask your agent for a new payment link.",
        );
        expect(bare("review").message).toBe(
            `This payment needs a check by hand. The money is safe. Write to support@bugnet.org with order ${ID}.`,
        );
    });

    it("errorStep never shows the error's text", () => {
        expect(errorStep(new Error(NO_ACCOUNT), W).message).toBe(
            "Phantom shared no Solana account. Unlock it, pick an account, then press Pay.",
        );
        const unreadable =
            "This page could not read Bugnet's payment request. Nothing was charged. Reload the page, or send to the address above.";
        expect(errorStep(new Error(UNREADABLE_CHALLENGE), W).message).toBe(unreadable);
        expect(errorStep(new Error(NO_OPTION), W).message).toBe(unreadable);
        expect(errorStep(new Error(BUILD_FAILED), W).message).toBe(unreadable);
        const noSigned =
            "Phantom returned no signed payment. Nothing was charged. Press Pay to try again.";
        expect(errorStep(new Error(NO_SIGNED), W).message).toBe(noSigned);
        expect(errorStep(new TypeError("fetch failed"), W).message).toBe(
            "Cannot reach Bugnet. Nothing was charged. Check your connection, then press Pay.",
        );
        expect(errorStep(new Error("ZZZ-wallet-text"), W).message).toBe(noSigned);
        expect(errorStep("ZZZ", W).message).toBe(noSigned);
    });

    it("no message passes wallet text through", () => {
        const codes = [4001, 4100, 4900, -32002, -32000, -32003, -32603, 1, undefined];
        for (let i = 0; i < 50; i++) {
            const m = walletMessage(e(codes[i % codes.length]), {
                ...C,
                haveMicros: i % 2 === 0 ? 0 : undefined,
            });
            expect(m.message).not.toContain("ZZZ");
            expect(m.message).not.toContain("Unexpected");
        }
        const results = [
            "paid",
            "settling_timeout",
            "network_busy",
            "unconfirmed",
            "unpaid_after_submit",
            { refused: "ZZZ" },
            { unavailable: "ZZZ" },
        ] as const;
        for (const r of results) {
            const text = pageStep(r, W).message;
            expect(text).not.toContain("payment refused:");
            expect(text).not.toContain("did not go through");
        }
    });
});

describe("error report stages", () => {
    it("names the stage that failed, never the wallet for Bugnet's own errors", () => {
        for (const message of [UNREADABLE_CHALLENGE, NO_OPTION, BUILD_FAILED]) {
            expect(errorStage(new Error(message), "connect")).toBe("challenge");
        }
        expect(errorStage(new Error(NO_SIGNED), "connect")).toBe("sign");
        expect(errorStage(new TypeError("fetch failed"), "sign")).toBe("status");
        expect(errorStage(new Error(NO_ACCOUNT), "connect")).toBe("connect");
    });
});

describe("refusal messages", () => {
    it("each W row", () => {
        expect(
            pageStep({ refused: "payer_blocked", blockedUntil: "2030-01-02T00:00:00.000Z" }, W)
                .message,
        ).toBe(
            "Bugnet blocks this wallet until 2 Jan 2030, 00:00. Nothing was charged. Pay from another wallet.",
        );
        expect(pageStep({ unavailable: "payer_busy", retryAfterSeconds: 7 }, W).message).toBe(
            "This wallet already runs as many sandboxes as Bugnet allows at once. Nothing was charged. Stop a sandbox, then press Pay.",
        );
        for (const reason of ["payer_rate_limited", "too_many_attempts"]) {
            expect(pageStep({ unavailable: reason, retryAfterSeconds: 7 }, W)).toEqual({
                message:
                    "Too many tries from this wallet. Nothing was charged. Press Pay again in 7 s.",
                payAfterMs: 7_000,
            });
        }
        expect(
            pageStep(
                { refused: "payment_invalid", code: "invalid_exact_svm_payload_transaction" },
                W,
            ).message,
        ).toBe(
            "Bugnet could not accept the transaction Phantom signed. Nothing was charged. Press Pay to try again, or send to the address above.",
        );
        expect(
            pageStep(
                {
                    refused: "payment_invalid",
                    code: "invalid_exact_svm_transaction_simulation_failed",
                },
                W,
            ).message,
        ).toBe(
            "Solana refused the payment, most often because the account holds less than $0.05 USDC. Nothing was charged. Add USDC, or send to the address above.",
        );
        expect(pageStep({ refused: "order_closed", code: "allowance_ceiling" }, W).message).toBe(
            "Paid, but this sandbox already holds the most allowance Bugnet allows. The $0.05 is being returned to the paying wallet.",
        );
        expect(pageStep({ refused: "order_closed", code: "sandbox_ended" }, W).message).toBe(
            "Paid, but the sandbox has ended. The $0.05 is being returned to the paying wallet.",
        );
        expect(pageStep({ refused: "order_closed", code: "allowance_pool_full" }, W).message).toBe(
            "Paid, but Bugnet holds as much allowance money as it allows right now. The $0.05 is being returned to the paying wallet.",
        );
        expect(pageStep({ refused: "order_closed", code: "order_expired" }, W).message).toBe(
            "Paid after the order expired. The $0.05 is being returned to the paying wallet.",
        );
        expect(pageStep({ refused: "order_closed" }, W).message).toBe(
            "This order is closed and cannot be paid. Ask your agent for a new payment link.",
        );
        expect(
            pageStep({ unavailable: "router_unavailable", retryAfterSeconds: 7 }, W).message,
        ).toBe(
            "Bugnet cannot take the payment right now. Nothing was charged. Press Pay again in 7 s.",
        );
        // Without a Retry-After Pay is offered at once, so the line names no wait
        for (const retryAfterSeconds of [undefined, 0]) {
            expect(pageStep({ unavailable: "rpc_unavailable", retryAfterSeconds }, W)).toEqual({
                message:
                    "Bugnet cannot take the payment right now. Nothing was charged. Press Pay again.",
                payAfterMs: 0,
            });
            expect(pageStep({ unavailable: "payer_rate_limited", retryAfterSeconds }, W)).toEqual({
                message: "Too many tries from this wallet. Nothing was charged. Press Pay again.",
                payAfterMs: 0,
            });
        }
        expect(pageStep({ refused: "order_unknown" }, W).message).toBe(
            "Bugnet has no order for this link. Ask your agent for a new payment link.",
        );
        expect(pageStep({ refused: "payment_replayed" }, W).message).toBe(
            "This signed payment was already sent once. Nothing was charged again. Press Pay to sign a new one.",
        );
        expect(pageStep({ refused: "something_new" }, W).message).toBe(
            "Bugnet refused the payment (something_new). Nothing was charged. Press Pay to try again, or write to support@bugnet.org.",
        );
        expect(pageStep({ short: { haveMicros: 0, needMicros: 50_000 } }, W).message).toBe(
            "Your Phantom account holds $0.00 USDC on Solana and this order needs $0.05. Nothing was charged. Add USDC, pick another account, or send to the address above.",
        );
    });
});
