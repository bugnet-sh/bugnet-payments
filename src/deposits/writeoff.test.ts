import { describe, expect, it } from "vitest";
import type { MoveRow, TransferRow } from "./types.ts";
import { type SplitInput, splitDebit } from "./writeoff.ts";

const ORDER_ID = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const AT = new Date("2030-01-01T00:04:00Z");

function t(
    signature: string,
    amountMicros: number,
    slot: number,
    over: Partial<TransferRow> = {},
): TransferRow {
    return {
        orderId: ORDER_ID,
        signature,
        slot: BigInt(slot),
        seq: 0,
        blockTime: AT,
        seenAt: AT,
        amountMicros,
        sourceTokenAccount: `Src${signature[0]}`,
        sourceOwner: `Own${signature[0]}`,
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

function mv(id: number, over: Partial<MoveRow> = {}): MoveRow {
    return {
        id,
        orderId: ORDER_ID,
        kind: "return",
        amountMicros: 1_000,
        keepMicros: 0,
        heldMicros: 0,
        destination: "SrcA",
        payer: "OwnA",
        memo: null,
        closes: false,
        closeTo: null,
        state: "confirmed",
        txSignature: `move${id}`,
        wireTx: null,
        lastValidBlockHeight: null,
        previousSignatures: [],
        attempts: 1,
        landedSlot: 105n,
        expirySeenSlot: null,
        preflightRefusedAt: null,
        manualReason: null,
        createdAt: AT,
        signedAt: null,
        sentAt: null,
        confirmedAt: null,
        failedAt: null,
        ...over,
    };
}

const split = (o: Partial<SplitInput>) =>
    splitDebit({
        transfers: [],
        moves: [],
        slot: 110n,
        olderInSlot: new Set(),
        micros: 0,
        settling: false,
        ...o,
    });

const parts = (r: ReturnType<typeof splitDebit>) =>
    r.parts.map((p) => [p.signature, p.micros, p.appliedMicros]);

describe("splitDebit", () => {
    it("takes unapplied money newest transfer first", () => {
        const r = split({
            transfers: [t("A1", 30_000, 100), t("B1", 20_000, 101)],
            micros: 25_000,
        });
        expect(parts(r)).toEqual([
            ["A1", 5_000, 0],
            ["B1", 20_000, 0],
        ]);
        expect(r.shortMicros).toBe(0);
    });

    it("takes only what is left of a transfer: its rest less earlier write-offs", () => {
        const r = split({
            transfers: [
                t("A1", 30_000, 100, { outcome: "paid", appliedMicros: 20_000, lostMicros: 4_000 }),
                t("B1", 20_000, 101, { lostMicros: 19_000 }),
            ],
            micros: 7_000,
        });
        expect(parts(r)).toEqual([
            ["A1", 6_000, 0],
            ["B1", 1_000, 0],
        ]);
    });

    it("money a landed move carried is gone, money of a failed or pending move is not", () => {
        const r = split({
            transfers: [
                t("A1", 30_000, 100, { outcome: "return", moveId: 1 }),
                t("B1", 20_000, 101, { outcome: "return", moveId: 2 }),
                t("C1", 10_000, 102, { outcome: "return", moveId: 3 }),
            ],
            moves: [
                mv(1),
                mv(2, { state: "failed", landedSlot: null }),
                mv(3, { state: "pending", landedSlot: null }),
            ],
            micros: 25_000,
        });
        expect(parts(r)).toEqual([
            ["B1", 15_000, 0],
            ["C1", 10_000, 0],
        ]);
    });

    it("kept dust and review money are unapplied money too", () => {
        const r = split({
            transfers: [
                t("U1", 7_000, 100, { outcome: "review", reason: "unattributed" }),
                t("C1", 500, 101, { outcome: "keep", reason: "below_minimum" }),
            ],
            micros: 7_500,
        });
        expect(parts(r)).toEqual([
            ["U1", 7_000, 0],
            ["C1", 500, 0],
        ]);
    });

    it("takes money of the debit's slot only when it came before the debit", () => {
        const transfers = [
            t("A1", 30_000, 100),
            t("B1", 20_000, 110, { seq: 0 }),
            t("C1", 10_000, 110, { seq: 1 }),
            t("D1", 40_000, 111),
        ];
        const r = split({ transfers, olderInSlot: new Set(["B1"]), micros: 25_000 });
        expect(parts(r)).toEqual([
            ["A1", 5_000, 0],
            ["B1", 20_000, 0],
        ]);
    });

    it("a settling payment's applied money goes last", () => {
        const transfers = [
            t("A1", 30_000, 100, { outcome: "paid", appliedMicros: 30_000 }),
            t("B1", 30_000, 101, {
                outcome: "paid",
                appliedMicros: 20_000,
                reason: "extra",
            }),
            t("C1", 5_000, 102, { outcome: "return", reason: "extra" }),
        ];
        const less = split({ transfers, micros: 12_000, settling: true });
        expect(parts(less)).toEqual([
            ["B1", 7_000, 0],
            ["C1", 5_000, 0],
        ]);
        const more = split({ transfers, micros: 40_000, settling: true });
        expect(parts(more)).toEqual([
            ["A1", 5_000, 5_000],
            ["B1", 30_000, 20_000],
            ["C1", 5_000, 0],
        ]);
    });

    it("applied money of a landed sweep is gone", () => {
        const transfers = [t("A1", 60_000, 100, { outcome: "paid", appliedMicros: 50_000 })];
        const r = split({ transfers, micros: 15_000, settling: false });
        expect(parts(r)).toEqual([["A1", 10_000, 0]]);
        expect(r.shortMicros).toBe(5_000);
    });

    it("money after the debit is taken only when the money at its slot is short", () => {
        const transfers = [
            t("A1", 30_000, 100, { outcome: "return", moveId: 1 }),
            t("B1", 20_000, 101),
            t("C1", 10_000, 120),
            t("D1", 10_000, 121),
        ];
        const r = split({ transfers, moves: [mv(1, { landedSlot: 115n })], micros: 25_000 });
        expect(parts(r)).toEqual([
            ["B1", 20_000, 0],
            ["D1", 5_000, 0],
        ]);
        expect(split({ transfers, micros: 75_000 }).shortMicros).toBe(5_000);
    });
});
