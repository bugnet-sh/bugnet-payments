import { describe, expect, it } from "vitest";
import { depositLine } from "../checkout/messages.ts";
import { publicState, type PublicState } from "../http/public.ts";
import type { OrderRow } from "../orders/types.ts";
import type { RefundRow } from "../refunds/request.ts";
import type {
    DepositRow,
    HoldRow,
    KeptReason,
    MoveRow,
    TransferRow,
    WriteOffPartRow,
} from "./types.ts";
import { depositStatus, depositSummary, depositViewFrom, type DepositSummary } from "./view.ts";

const ORDER_ID = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDRESS = "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley";
const TOKEN = "D2mAKdUVEHvizHThmG57bTCiASiiYj5gQbMeMoyWtQo1";
const CREATED = new Date("2030-01-01T00:00:00Z");
const EXPIRES = new Date("2030-01-01T00:15:00Z");
const CFG = { refund_min_micros: 1_000, max_split_owners: 4, settle_grace: 60_000 };

const at = (hms: string): Date => new Date(`2030-01-01T${hms}Z`);
const ON_TIME = at("00:04:00");
const NOW = at("00:05:00");

type Order = Pick<OrderRow, "state" | "amountMicros" | "expiresAt">;
const order = (state: OrderRow["state"] = "unpaid"): Order => ({
    state,
    amountMicros: 50_000,
    expiresAt: EXPIRES,
});

function deposit(over: Partial<DepositRow> = {}): DepositRow {
    return {
        orderId: ORDER_ID,
        address: ADDRESS,
        tokenAccount: TOKEN,
        keyVersion: 1,
        salt: Buffer.alloc(16, 1),
        state: "open",
        balanceMicros: 0n,
        lastSignature: null,
        scanSlot: null,
        scanTop: null,
        scanBefore: null,
        rentPayer: null,
        viewerKey: null,
        viewerBlock: null,
        reviewReason: null,
        holdReason: null,
        movesFailingResetAt: null,
        recheckAt: null,
        expiryDueAt: null,
        hardStopAt: null,
        expiryMinSlot: null,
        closeSeparately: false,
        closeFailures: 0,
        closeAfter: null,
        stableSince: null,
        lateReturns: 0,
        createdAt: CREATED,
        readyAt: null,
        checkedAt: null,
        checkedSlot: null,
        settledAt: null,
        closedAt: null,
        watchUntil: null,
        ...over,
    };
}

function t(
    signature: string,
    owner: string | null,
    amountMicros: number,
    slot: number,
    over: Partial<TransferRow> = {},
): TransferRow {
    return {
        orderId: ORDER_ID,
        signature,
        slot: BigInt(slot),
        seq: 0,
        blockTime: ON_TIME,
        seenAt: ON_TIME,
        amountMicros,
        sourceTokenAccount: owner === null ? null : `Src${owner.slice(3)}`,
        sourceOwner: owner,
        sourceBalanceMicros: null,
        outcome: "open",
        appliedMicros: 0,
        reason: null,
        blockedUntil: null,
        moveId: null,
        refundId: null,
        lostMicros: 0,
        ...over,
    };
}

function move(id: number, kind: MoveRow["kind"], state: MoveRow["state"]): MoveRow {
    const signed = state !== "pending";
    return {
        id,
        orderId: ORDER_ID,
        kind,
        amountMicros: 0,
        keepMicros: 0,
        heldMicros: 0,
        destination: null,
        payer: null,
        memo: null,
        closes: false,
        closeTo: null,
        state,
        txSignature: signed ? `move${id}` : null,
        wireTx: null,
        lastValidBlockHeight: null,
        previousSignatures: [],
        attempts: signed ? 1 : 0,
        landedSlot: state === "confirmed" ? 200n : null,
        expirySeenSlot: null,
        preflightRefusedAt: null,
        manualReason: null,
        createdAt: NOW,
        signedAt: signed ? NOW : null,
        sentAt: null,
        confirmedAt: state === "confirmed" ? NOW : null,
        failedAt: null,
    };
}

function depositRefund(state: RefundRow["state"], signature = "R1"): RefundRow {
    return {
        id: 9,
        orderId: ORDER_ID,
        kind: "deposit",
        reason: "deposit_held",
        amountMicros: 7_000,
        destination: "SrcR",
        payer: "OwnR",
        state,
        txSignature: state === "pending" ? null : "refund9",
        wireTx: null,
        lastValidBlockHeight: null,
        previousSignatures: [],
        attempts: 0,
        manualReason: null,
        createdAt: NOW,
        signedAt: null,
        sentAt: null,
        confirmedAt: null,
        fromWallet: "refund",
        landedSlot: null,
        expirySeenSlot: null,
        signingSlot: null,
        budgetWaived: false,
        handTx: null,
        part: 0,
        depositSignature: signature,
    };
}

interface Ledger {
    deposit: DepositRow;
    transfers: TransferRow[];
    moves: MoveRow[];
    holds: HoldRow[];
    depositRefunds: RefundRow[];
    writeOffParts: WriteOffPartRow[];
}

function ledger(over: Partial<Ledger> = {}): Ledger {
    return {
        deposit: deposit(),
        transfers: [],
        moves: [],
        holds: [],
        depositRefunds: [],
        writeOffParts: [],
        ...over,
    };
}

function writeOffRefund(id: number, state: RefundRow["state"], signature: string): RefundRow {
    return {
        ...depositRefund(state, signature),
        id,
        reason: "deposit_write_off",
        txSignature: state === "pending" ? null : `refund${id}`,
    };
}

const part = (
    transferSignature: string,
    micros: number,
    refundId: number | null,
    keptReason: KeptReason | null = null,
) => ({
    orderId: ORDER_ID,
    signature: "theft",
    transferSignature,
    micros,
    refundId,
    keptReason,
});

function view(o: Order, l: Ledger, now = NOW) {
    return depositViewFrom(o, l, now, CFG);
}

const A1 = t("A1", "OwnA", 30_000, 100);

describe("depositViewFrom", () => {
    it("waiting", () => {
        const v = view(order(), ledger());
        expect(v).toMatchObject({
            address: ADDRESS,
            ready: false,
            status: "waiting",
            receivedMicros: 0,
            otherMicros: 0,
            remainingMicros: 50_000,
            reason: null,
            hold: null,
            transfers: [],
        });
        expect(depositStatus(order(), ledger(), NOW, CFG)).toBe("waiting");
    });

    it("ready once the token account exists", () => {
        expect(view(order(), ledger({ deposit: deposit({ readyAt: NOW }) })).ready).toBe(true);
    });

    it("partial", () => {
        const v = view(order(), ledger({ transfers: [A1] }));
        expect(v).toMatchObject({
            status: "partial",
            receivedMicros: 30_000,
            remainingMicros: 20_000,
        });
    });

    it("a stranger's money never lowers the amount asked for", () => {
        const both = view(order(), ledger({ transfers: [A1, t("B1", "OwnB", 10_000, 101)] }));
        expect(both).toMatchObject({
            status: "partial",
            receivedMicros: 30_000,
            otherMicros: 10_000,
            remainingMicros: 20_000,
        });
        const stranger = view(order(), ledger({ transfers: [t("B1", "OwnB", 1_000, 101)] }));
        expect(stranger).toMatchObject({
            receivedMicros: 1_000,
            otherMicros: 0,
            remainingMicros: 49_000,
        });
    });

    it("partial with a blocked sender's money on its way back", () => {
        const B1 = t("B1", "OwnB", 20_000, 101, {
            outcome: "return",
            reason: "payer_blocked",
            moveId: 1,
        });
        const v = view(
            order(),
            ledger({ transfers: [A1, B1], moves: [move(1, "return", "sent")] }),
        );
        expect(v).toMatchObject({
            status: "partial",
            receivedMicros: 30_000,
            remainingMicros: 20_000,
            reason: "payer_blocked",
            reasonMicros: 20_000,
            returningMicros: 20_000,
            returnedMicros: 0,
            extraMicros: 0,
        });
    });

    const full = [A1, t("A2", "OwnA", 20_000, 101)];

    it("confirming before settle", () => {
        const v = view(order(), ledger({ transfers: full }));
        expect(v).toMatchObject({
            status: "confirming",
            receivedMicros: 50_000,
            remainingMicros: 0,
        });
    });

    it("held", () => {
        const busy: HoldRow = {
            orderId: ORDER_ID,
            owner: "OwnA",
            reason: "payer_busy",
            recheckAt: at("00:05:10"),
            since: NOW,
        };
        const held = view(order(), ledger({ transfers: full, holds: [busy] }));
        expect(held.status).toBe("held");
        expect(held.hold).toEqual({ reason: "payer_busy", until: "2030-01-01T00:16:00.000Z" });
        expect(held.receivedMicros).toBe(50_000);

        const paused = view(
            order(),
            ledger({
                transfers: full,
                deposit: deposit({ holdReason: "allowance_paused", recheckAt: at("00:05:10") }),
            }),
        );
        expect(paused.status).toBe("held");
        expect(paused.hold).toEqual({
            reason: "allowance_paused",
            until: "2030-01-01T00:16:00.000Z",
        });

        const other = view(
            order(),
            ledger({ transfers: [...full, t("B1", "OwnB", 50_000, 102)], holds: [busy] }),
        );
        expect(other.status).toBe("confirming");
        expect(other.hold).toBeNull();

        const due = view(order(), ledger({ transfers: full, holds: [busy] }), at("00:05:10"));
        expect(due.status).toBe("confirming");
    });

    it("confirming while the sweep flies", () => {
        const v = view(
            order("settling"),
            ledger({
                deposit: deposit({ state: "settling", settledAt: NOW }),
                transfers: [
                    t("A1", "OwnA", 50_000, 100, { outcome: "paid", appliedMicros: 50_000 }),
                ],
            }),
        );
        expect(v).toMatchObject({ status: "confirming", receivedMicros: 50_000 });
    });

    const settled = deposit({ state: "closed", settledAt: NOW });
    const crossing = (moveId: number) =>
        t("A1", "OwnA", 60_000, 100, {
            outcome: "paid",
            appliedMicros: 50_000,
            reason: "extra",
            moveId,
        });

    it("paid", () => {
        const v = view(
            order("paid"),
            ledger({
                deposit: settled,
                transfers: [crossing(2)],
                moves: [move(2, "return", "confirmed")],
            }),
        );
        expect(v).toMatchObject({
            status: "paid",
            receivedMicros: 60_000,
            remainingMicros: 0,
            returnedMicros: 10_000,
            returningMicros: 0,
            extraMicros: 10_000,
            reason: "extra",
            reasonMicros: 10_000,
        });
    });

    it("extraMicros counts extra only", () => {
        const late = t("L1", "OwnL", 2_000, 105, {
            blockTime: at("00:16:00"),
            outcome: "return",
            reason: "late",
        });
        const v = view(
            order("paid"),
            ledger({
                deposit: settled,
                transfers: [crossing(2), late],
                moves: [move(2, "return", "sent")],
            }),
            at("00:17:00"),
        );
        expect(v).toMatchObject({
            status: "paid",
            extraMicros: 10_000,
            returningMicros: 12_000,
            reason: "late",
            reasonMicros: 2_000,
        });
    });

    it("late money names its own amount", () => {
        const v = view(
            order("paid"),
            ledger({
                deposit: settled,
                transfers: [
                    t("A1", "OwnA", 50_000, 100, { outcome: "paid", appliedMicros: 50_000 }),
                    t("L1", "OwnA", 2_000, 105, { outcome: "return", reason: "late" }),
                ],
            }),
        );
        expect(v).toMatchObject({ status: "paid", reason: "late", reasonMicros: 2_000 });
    });

    it("kept dust is kept, not extra", () => {
        const v = view(
            order("paid"),
            ledger({
                deposit: settled,
                transfers: [
                    t("A1", "OwnA", 50_500, 100, {
                        outcome: "paid",
                        appliedMicros: 50_000,
                        reason: "below_minimum",
                    }),
                    t("B1", "OwnB", 1, 99, { outcome: "keep", reason: "below_minimum" }),
                ],
            }),
        );
        expect(v).toMatchObject({
            keptMicros: 501,
            extraMicros: 0,
            reason: "below_minimum",
            reasonMicros: 501,
        });
    });

    it("checking", () => {
        expect(view(order(), ledger({ transfers: [A1] }), at("00:15:30")).status).toBe("checking");
        expect(view(order(), ledger(), at("00:15:30")).status).toBe("checking");
    });

    it("expired", () => {
        expect(view(order("expired"), ledger(), at("00:20:00")).status).toBe("expired");
    });

    const unpaidReturn = (moveId: number) =>
        t("A1", "OwnA", 30_000, 100, { outcome: "return", reason: "unpaid", moveId });

    it("refunding", () => {
        const v = view(
            order("expired"),
            ledger({ transfers: [unpaidReturn(1)], moves: [move(1, "return", "signed")] }),
            at("00:20:00"),
        );
        expect(v).toMatchObject({ status: "refunding", returningMicros: 30_000 });
    });

    it("an expired order's open money is on its way back", () => {
        const v = view(order("expired"), ledger({ transfers: [A1] }), at("00:20:00"));
        expect(v).toMatchObject({ status: "refunding", returningMicros: 30_000 });
    });

    it("refunded", () => {
        const v = view(
            order("expired"),
            ledger({ transfers: [unpaidReturn(1)], moves: [move(1, "return", "confirmed")] }),
            at("00:20:00"),
        );
        expect(v).toMatchObject({
            status: "refunded",
            returnedMicros: 30_000,
            returningMicros: 0,
            reason: "unpaid",
            reasonMicros: 30_000,
        });
        expect(v.transfers[0]).toMatchObject({
            signature: "A1",
            outcome: "returned",
            returnSignature: "move1",
        });
    });

    it("refunded when the order was paid with a wallet", () => {
        const v = view(
            order("paid"),
            ledger({
                transfers: [
                    t("A1", "OwnA", 30_000, 100, {
                        outcome: "return",
                        reason: "paid_otherwise",
                        moveId: 1,
                    }),
                ],
                moves: [move(1, "return", "confirmed")],
            }),
        );
        expect(v.status).toBe("refunded");
    });

    it("review", () => {
        const flagged = ledger({ deposit: deposit({ reviewReason: "unknown_debit" }) });
        for (const state of ["unpaid", "settling", "paid", "expired"] as const) {
            expect(view(order(state), flagged).status).toBe("review");
        }
        expect(view(order(), ledger({ moves: [move(1, "sweep", "manual")] })).status).toBe(
            "review",
        );
        expect(view(order("manual"), ledger()).status).toBe("review");
    });

    const R1 = t("R1", null, 7_000, 102, { outcome: "review", reason: "unattributed" });

    it("a transfer in review alone keeps the status", () => {
        const v = view(order(), ledger({ transfers: [A1, R1] }));
        expect(v).toMatchObject({ status: "partial", reviewMicros: 7_000, receivedMicros: 30_000 });
        const carried = view(
            order(),
            ledger({
                transfers: [A1, { ...R1, moveId: 4 }],
                moves: [move(4, "close", "confirmed")],
            }),
        );
        expect(carried.reviewMicros).toBe(7_000);
        expect(carried.returnedMicros).toBe(0);
    });

    it("a held transfer returned from the float counts as returned", () => {
        const carried = { ...R1, moveId: 4, refundId: 9 };
        const withRefund = (state: RefundRow["state"]) =>
            view(
                order(),
                ledger({
                    transfers: [A1, carried],
                    moves: [move(4, "close", "confirmed")],
                    depositRefunds: [depositRefund(state)],
                }),
            );
        expect(withRefund("sent")).toMatchObject({ reviewMicros: 0, returningMicros: 7_000 });
        expect(withRefund("confirmed")).toMatchObject({
            reviewMicros: 0,
            returningMicros: 0,
            returnedMicros: 7_000,
        });
        expect(withRefund("manual")).toMatchObject({ reviewMicros: 7_000, returnedMicros: 0 });
    });

    it("blockedUntil comes from the newest payer_blocked transfer", () => {
        const blocked = (sig: string, slot: number, until: string) =>
            t(sig, "OwnB", 2_000, slot, {
                outcome: "return",
                reason: "payer_blocked",
                blockedUntil: new Date(until),
            });
        const v = view(
            order(),
            ledger({
                transfers: [
                    blocked("B1", 101, "2030-01-01T12:00:00Z"),
                    blocked("B2", 103, "2030-01-02T00:00:00Z"),
                ],
            }),
        );
        expect(v.blockedUntil).toBe("2030-01-02T00:00:00.000Z");
    });

    it("lists the newest 10 transfers, newest first", () => {
        const many = Array.from({ length: 12 }, (_, i) => t(`T${i}`, "OwnA", 1_000, 100 + i));
        const v = view(order(), ledger({ transfers: many }));
        expect(v.transfers.map((x) => x.signature)).toEqual([
            "T11",
            "T10",
            "T9",
            "T8",
            "T7",
            "T6",
            "T5",
            "T4",
            "T3",
            "T2",
        ]);
        expect(v.transfers[0]).toEqual({
            signature: "T11",
            amountMicros: 1_000,
            at: "2030-01-01T00:04:00.000Z",
            outcome: "counted",
            reason: null,
            returnSignature: null,
        });
    });

    it("names each transfer's outcome", () => {
        const v = view(
            order("expired"),
            ledger({
                transfers: [
                    t("K1", "OwnK", 500, 100, { outcome: "keep", reason: "below_minimum" }),
                    t("R2", null, 7_000, 101, { outcome: "review", reason: "unattributed" }),
                    t("U1", "OwnU", 30_000, 102, {
                        outcome: "return",
                        reason: "unpaid",
                        moveId: 1,
                    }),
                ],
                moves: [move(1, "return", "sent")],
            }),
            at("00:20:00"),
        );
        expect(v.transfers.map((x) => [x.signature, x.outcome, x.returnSignature])).toEqual([
            ["U1", "returning", "move1"],
            ["R2", "review", null],
            ["K1", "kept", null],
        ]);
        expect(v).toMatchObject({ keptMicros: 500, reviewMicros: 7_000, returningMicros: 30_000 });
    });
});

describe("depositSummary", () => {
    const pinned = { expiryMinSlot: 500n, checkedSlot: 500n, checkedAt: at("00:16:00") };

    it("counts on-time open money", () => {
        const s = depositSummary(
            order(),
            {
                deposit: deposit(),
                transfers: [A1, t("L1", "OwnA", 5_000, 101, { blockTime: at("00:15:01") })],
                moves: [],
                writeOffParts: [],
            },
            60_000,
        );
        expect(s.onTimeMicros).toBe(30_000);
        expect(s.decided).toBe(false);
    });

    it("is decided only by a read pinned past the grace", () => {
        const decided = (over: Partial<DepositRow>) =>
            depositSummary(
                order(),
                {
                    deposit: deposit({ ...pinned, ...over }),
                    transfers: [],
                    moves: [],
                    writeOffParts: [],
                },
                60_000,
            ).decided;
        expect(decided({})).toBe(true);
        expect(decided({ checkedAt: at("00:15:59") })).toBe(false);
        expect(decided({ checkedSlot: 499n })).toBe(false);
        expect(decided({ expiryMinSlot: null })).toBe(false);
        expect(decided({ checkedAt: null, checkedSlot: null })).toBe(false);
    });

    it("counts money that goes back or was kept", () => {
        const s = depositSummary(
            order("expired"),
            {
                deposit: deposit(),
                transfers: [
                    t("U1", "OwnA", 30_000, 100, {
                        outcome: "return",
                        reason: "unpaid",
                        moveId: 1,
                    }),
                    t("K1", "OwnK", 500, 101, { outcome: "keep", reason: "below_minimum" }),
                    t("R1", null, 7_000, 102, { outcome: "review", reason: "unattributed" }),
                ],
                moves: [move(1, "return", "confirmed")],
                writeOffParts: [],
            },
            60_000,
        );
        expect(s).toEqual({
            onTimeMicros: 0,
            returnedOrReturningMicros: 37_000,
            keptMicros: 500,
            decided: false,
        });
    });
});

describe("publicState with deposits", () => {
    const row = (state: OrderRow["state"]) => ({ state, expiresAt: EXPIRES }) as OrderRow;
    const dep = (over: Partial<DepositSummary>): DepositSummary => ({
        onTimeMicros: 0,
        returnedOrReturningMicros: 0,
        keptMicros: 0,
        decided: false,
        ...over,
    });
    const late = at("00:15:30");

    it("an unpaid order past its deadline settles while the deposit may still pay it", () => {
        expect(publicState(row("unpaid"), late, dep({ onTimeMicros: 30_000 }))).toBe("settling");
        expect(publicState(row("unpaid"), late, dep({ decided: false }))).toBe("settling");
        expect(publicState(row("unpaid"), late, dep({ decided: true }))).toBe("expired");
        expect(publicState(row("unpaid"), late, dep({ onTimeMicros: 30_000, decided: true }))).toBe(
            "settling",
        );
        expect(publicState(row("unpaid"), NOW, dep({}))).toBe("unpaid");
        expect(publicState(row("unpaid"), late)).toBe("expired");
    });

    it("an expired order with returned or kept money reads refunded", () => {
        expect(publicState(row("expired"), late, dep({ returnedOrReturningMicros: 30_000 }))).toBe(
            "refunded",
        );
        expect(publicState(row("expired"), late, dep({ keptMicros: 500 }))).toBe("refunded");
        expect(publicState(row("expired"), late, dep({}))).toBe("expired");
        expect(publicState(row("expired"), late)).toBe("expired");
    });

    it("every other state maps as before", () => {
        const d = dep({ onTimeMicros: 30_000, returnedOrReturningMicros: 30_000 });
        expect(publicState(row("settling"), late, d)).toBe("settling");
        expect(publicState(row("paid"), late, d)).toBe("paid");
        expect(publicState(row("redeemed"), late, d)).toBe("paid");
        expect(publicState(row("refunding"), late, d)).toBe("refunded");
        expect(publicState(row("refunded"), late, d)).toBe("refunded");
        expect(publicState(row("manual"), late, d)).toBe("review");
    });
});

// The page's line for the server's own view
function line(o: Order, l: Ledger, state: PublicState, now = at("00:20:00")) {
    return depositLine(
        {
            state,
            expiresAt: EXPIRES.getTime(),
            serverNow: now.getTime(),
            amountMicros: 50_000,
            kind: "start",
            deposit: view(o, l, now),
        },
        { amountMicros: 50_000, deadline: "00:15", refundMinMicros: 1_000, orderId: ORDER_ID },
    );
}

describe("the page's line for the server's own view", () => {
    const K1 = t("K1", "OwnK", 500, 101, { outcome: "keep", reason: "below_minimum" });
    const kept = "$0.0005 arrived, which is below the $0.001 Bugnet returns, so it was kept.";

    it("an expired order whose only money was kept says it was kept", () => {
        const l = ledger({ deposit: deposit({ state: "closed" }), transfers: [K1] });
        expect(view(order("expired"), l, at("00:20:00")).status).toBe("refunded");
        expect(line(order("expired"), l, "refunded")).toEqual({
            label: "Refunded",
            message: kept,
            extra: [],
        });
    });

    it("kept dust beside returned money adds M17 after the main line", () => {
        const a1 = t("A1", "OwnA", 30_000, 100, {
            outcome: "return",
            reason: "unpaid",
            moveId: 1,
        });
        const l = ledger({
            deposit: deposit({ state: "closed" }),
            transfers: [a1, K1],
            moves: [move(1, "return", "confirmed")],
        });
        const r = line(order("expired"), l, "refunded");
        expect(r.message).not.toBe(kept);
        expect(r.extra).toEqual([kept]);
    });
});

describe("written-off money on the page (spec 23.1)", () => {
    it("a stolen part paid back from the float is returning, then returned", () => {
        const a1 = t("A1", "OwnA", 30_000, 100, {
            outcome: "return",
            reason: "unpaid",
            lostMicros: 10_000,
            moveId: 1,
        });
        const sent = view(
            order("expired"),
            ledger({
                transfers: [a1],
                moves: [move(1, "return", "confirmed")],
                depositRefunds: [writeOffRefund(10, "sent", "A1")],
                writeOffParts: [part("A1", 10_000, 10)],
            }),
        );
        expect(sent).toMatchObject({
            status: "refunding",
            returnedMicros: 20_000,
            returningMicros: 10_000,
            reviewMicros: 0,
            reasonMicros: 30_000,
        });
        const confirmed = view(
            order("expired"),
            ledger({
                transfers: [a1],
                moves: [move(1, "return", "confirmed")],
                depositRefunds: [writeOffRefund(10, "confirmed", "A1")],
                writeOffParts: [part("A1", 10_000, 10)],
            }),
        );
        expect(confirmed).toMatchObject({
            status: "refunded",
            returnedMicros: 30_000,
            returningMicros: 0,
        });
    });

    it("a transfer taken whole shows by its payout, and one of no known sender is review", () => {
        const a1 = t("A1", "OwnA", 30_000, 100, {
            outcome: "return",
            reason: "unpaid",
            lostMicros: 30_000,
        });
        const u1 = t("U1", null, 7_000, 101, {
            outcome: "review",
            reason: "unattributed",
            lostMicros: 7_000,
        });
        const v = view(
            order("expired"),
            ledger({
                transfers: [a1, u1],
                depositRefunds: [writeOffRefund(10, "sent", "A1")],
                writeOffParts: [part("A1", 30_000, 10), part("U1", 7_000, null)],
            }),
        );
        expect(v).toMatchObject({ returningMicros: 30_000, reviewMicros: 7_000 });
        expect(v.transfers.map((x) => [x.signature, x.outcome, x.returnSignature])).toEqual([
            ["U1", "review", null],
            ["A1", "returning", "refund10"],
        ]);
    });

    it("a part Bugnet keeps is not shown to the payer, as kept or as review", () => {
        const a1 = t("A1", "OwnA", 30_000, 100, {
            outcome: "return",
            reason: "unpaid",
            lostMicros: 500,
            moveId: 1,
        });
        const k1 = t("K1", "OwnK", 600, 101, {
            outcome: "keep",
            reason: "below_minimum",
            lostMicros: 600,
        });
        const u1 = t("U1", null, 7_000, 102, {
            outcome: "review",
            reason: "unattributed",
            lostMicros: 7_000,
        });
        const l = ledger({
            deposit: deposit({ state: "closed" }),
            transfers: [a1, k1, u1],
            moves: [move(1, "return", "confirmed")],
            writeOffParts: [
                part("A1", 500, null, "below_refund_min"),
                part("K1", 600, null, "bugnet_own"),
                part("U1", 7_000, null),
            ],
        });
        const v = view(order("expired"), l);
        expect(v).toMatchObject({ returnedMicros: 29_500, keptMicros: 0, reviewMicros: 7_000 });
        expect(v.transfers.map((x) => [x.signature, x.outcome])).toEqual([
            ["U1", "review"],
            ["K1", "kept"],
            ["A1", "returned"],
        ]);
        expect(line(order("expired"), l, "refunded")).toEqual({
            label: "Refunded",
            message:
                "Time ran out before the full amount arrived. The $0.0295 you sent was returned. Ask your agent for a new payment link.",
            extra: [
                `$0.007 arrived in a way Bugnet cannot return on its own. It is safe. To get it back, write to support@bugnet.org with order ${ORDER_ID} and a message signed by the sending wallet.`,
            ],
        });
    });

    it("a part is kept by the reason stored when it was written off, not by its transfer now", () => {
        // B1 was a return to pay by hand when written off and was kept afterwards; F1 came from a
        // Bugnet wallet before the planner named it
        const b1 = t("B1", "OwnB", 5_000, 100, {
            outcome: "keep",
            reason: "below_minimum",
            lostMicros: 5_000,
        });
        const f1 = t("F1", "OwnF", 4_000, 101, { outcome: "open", lostMicros: 4_000 });
        const v = view(
            order("expired"),
            ledger({
                deposit: deposit({ state: "closed" }),
                transfers: [b1, f1],
                writeOffParts: [part("B1", 5_000, null), part("F1", 4_000, null, "bugnet_own")],
            }),
        );
        expect(v).toMatchObject({ keptMicros: 0, reviewMicros: 5_000 });
        expect(v.transfers.map((x) => [x.signature, x.outcome])).toEqual([
            ["F1", "kept"],
            ["B1", "review"],
        ]);
    });

    it("money Bugnet keeps of a write-off never reads as returned or kept", () => {
        const f1 = t("F1", "OwnF", 4_000, 101, { outcome: "open", lostMicros: 4_000 });
        const l = ledger({
            deposit: deposit({ state: "closed" }),
            transfers: [f1],
            writeOffParts: [part("F1", 4_000, null, "bugnet_own")],
        });
        expect(depositSummary(order("expired"), l, CFG.settle_grace)).toMatchObject({
            returnedOrReturningMicros: 0,
            keptMicros: 0,
        });
        expect(line(order("expired"), l, "expired")).toEqual({
            label: "Expired",
            message:
                "This order expired at 00:15 and nothing was charged. Ask your agent for a new payment link.",
            extra: [],
        });
        // A transfer taken whole, partly kept and partly paid back, reads by its payout
        const a1 = t("A1", "OwnA", 30_000, 100, {
            outcome: "return",
            reason: "unpaid",
            lostMicros: 30_000,
        });
        const both = view(
            order("expired"),
            ledger({
                transfers: [a1],
                depositRefunds: [writeOffRefund(10, "confirmed", "A1")],
                writeOffParts: [
                    part("A1", 500, null, "below_refund_min"),
                    { ...part("A1", 29_500, 10), signature: "theft2" },
                ],
            }),
        );
        expect(both).toMatchObject({ status: "refunded", returnedMicros: 29_500, keptMicros: 0 });
        expect(both.transfers.map((x) => x.outcome)).toEqual(["returned"]);
    });

    it("a payment a write-off failed is returned with its own line", () => {
        const a1 = t("A1", "OwnA", 80_000, 100, {
            outcome: "return",
            reason: "written_off",
            lostMicros: 30_000,
        });
        const returning = ledger({
            deposit: deposit({ state: "draining" }),
            transfers: [a1],
            depositRefunds: [writeOffRefund(10, "pending", "A1")],
            writeOffParts: [part("A1", 30_000, 10)],
        });
        expect(line(order("expired"), returning, "refunded")).toEqual({
            label: "Refunding",
            message: "The payment did not go through. The $0.08 you sent is being returned.",
            extra: [],
        });
        const returned = ledger({
            deposit: deposit({ state: "closed" }),
            transfers: [{ ...a1, moveId: 1 }],
            moves: [move(1, "return", "confirmed")],
            depositRefunds: [writeOffRefund(10, "confirmed", "A1")],
            writeOffParts: [part("A1", 30_000, 10)],
        });
        expect(line(order("expired"), returned, "refunded").message).toBe(
            "The payment did not go through. The $0.08 you sent was returned. Ask your agent for a new payment link.",
        );
    });

    it("the extra names the part a theft took that the float pays back", () => {
        const settled = deposit({ state: "closed", settledAt: NOW });
        const a1 = (lostMicros: number, over: Partial<TransferRow> = {}) =>
            t("A1", "OwnA", 80_000, 100, {
                outcome: "paid",
                appliedMicros: 50_000,
                reason: "extra",
                lostMicros,
                ...over,
            });
        const whole = ledger({
            deposit: settled,
            transfers: [a1(30_000)],
            depositRefunds: [writeOffRefund(10, "pending", "A1")],
            writeOffParts: [part("A1", 30_000, 10)],
        });
        expect(view(order("paid"), whole)).toMatchObject({
            status: "paid",
            extraMicros: 30_000,
            returningMicros: 30_000,
            reasonMicros: 30_000,
        });
        expect(line(order("paid"), whole, "paid").message).toBe(
            "The extra $0.03 is being returned to the address that sent it.",
        );
        const some = ledger({
            deposit: settled,
            transfers: [a1(10_000, { moveId: 2 })],
            moves: [move(2, "return", "confirmed")],
            depositRefunds: [writeOffRefund(10, "confirmed", "A1")],
            writeOffParts: [part("A1", 10_000, 10)],
        });
        expect(view(order("paid"), some)).toMatchObject({
            extraMicros: 30_000,
            returnedMicros: 30_000,
        });
        expect(line(order("paid"), some, "paid").message).toBe(
            "The extra $0.03 was returned to the address that sent it.",
        );
        // The same source's whole transfer after the price is extra too
        const a2 = t("A2", "OwnA", 20_000, 101, {
            outcome: "return",
            reason: "extra",
            lostMicros: 5_000,
        });
        const later = view(
            order("paid"),
            ledger({
                deposit: settled,
                transfers: [
                    t("A1", "OwnA", 50_000, 100, { outcome: "paid", appliedMicros: 50_000 }),
                    a2,
                ],
                depositRefunds: [writeOffRefund(10, "sent", "A2")],
                writeOffParts: [part("A2", 5_000, 10)],
            }),
        );
        expect(later).toMatchObject({ extraMicros: 20_000, returningMicros: 20_000 });
    });

    it("money a theft took before the price arrived is said to go back", () => {
        const before = (lostMicros: number, state: RefundRow["state"]) =>
            ledger({
                transfers: [t("A1", "OwnA", 30_000, 100, { lostMicros })],
                depositRefunds: [writeOffRefund(10, state, "A1")],
                writeOffParts: [part("A1", lostMicros, 10)],
            });
        expect(line(order(), before(30_000, "pending"), "unpaid", NOW)).toEqual({
            label: "Awaiting payment",
            message: "",
            extra: ["The $0.03 you sent is being returned."],
        });
        expect(line(order(), before(10_000, "confirmed"), "unpaid", NOW)).toEqual({
            label: "Partly paid",
            message: "Received $0.02 of $0.05.",
            extra: ["The $0.01 you sent was returned."],
        });
    });

    it("a held return and a write-off payout of one transfer are told apart", () => {
        const u1 = t("U1", "OwnU", 7_000, 101, {
            outcome: "review",
            reason: "late_limit",
            lostMicros: 2_000,
            moveId: 1,
        });
        const v = view(
            order("expired"),
            ledger({
                transfers: [u1],
                moves: [move(1, "close", "confirmed")],
                depositRefunds: [
                    depositRefund("pending", "U1"),
                    writeOffRefund(10, "confirmed", "U1"),
                ],
                writeOffParts: [part("U1", 2_000, 10)],
            }),
        );
        expect(v).toMatchObject({ returningMicros: 5_000, returnedMicros: 2_000, reviewMicros: 0 });
    });

    it("the open money still on time is what was not taken", () => {
        const s = depositSummary(
            order(),
            {
                ...ledger({ transfers: [t("A1", "OwnA", 30_000, 100, { lostMicros: 30_000 })] }),
            },
            CFG.settle_grace,
        );
        expect(s).toMatchObject({ onTimeMicros: 0, returnedOrReturningMicros: 30_000 });
        const partial = view(
            order(),
            ledger({ transfers: [t("A1", "OwnA", 30_000, 100, { lostMicros: 10_000 })] }),
        );
        expect(partial).toMatchObject({
            status: "partial",
            receivedMicros: 20_000,
            remainingMicros: 30_000,
        });
    });
});
