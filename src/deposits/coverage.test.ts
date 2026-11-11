import { describe, expect, it } from "vitest";
import { coverage } from "./coverage.ts";
import type { OwnerHoldReason, TransferRow } from "./types.ts";

const PRICE = 50_000;
const EXPIRES = new Date("2030-01-01T00:15:00Z");
const ON_TIME = new Date("2030-01-01T00:04:00Z");
const CFG = { refund_min_micros: 1_000, max_split_owners: 4 };
const NONE = { owners: new Map<string, OwnerHoldReason>(), shared: false };

// A transfer named by its owner letter: owner "OwnA" sends from "SrcA"
function t(
    signature: string,
    owner: string | null,
    amountMicros: number,
    slot: number,
    over: Partial<TransferRow> = {},
): TransferRow {
    return {
        orderId: "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa",
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
        ...over,
    };
}

const entries = (m: ReadonlyMap<string, number>) => Object.fromEntries(m);
const owners = (c: ReturnType<typeof coverage>) => c.owners.map((o) => o.owner);

describe("coverage", () => {
    it("one owner alone settles even after a stranger's dust", () => {
        const c = coverage(
            PRICE,
            [t("B1", "OwnB", 1, 99), t("A1", "OwnA", 50_000, 100)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.mode).toBe("single");
        expect(c.owners).toEqual([
            { owner: "OwnA", sourceTokenAccount: "SrcA", appliedMicros: 50_000 },
        ]);
        expect(entries(c.applied)).toEqual({ A1: 50_000 });
        expect(entries(c.extra)).toEqual({});
        expect(c.notApplied).toEqual(["B1"]);
        expect(c.dust).toEqual([]);
        expect(c.crossing?.signature).toBe("A1");
        expect(c.countedMicros).toBe(50_000);
    });

    it("a stranger's larger transfer does not share the payment", () => {
        const c = coverage(
            PRICE,
            [t("B1", "OwnB", 30_000, 99), t("A1", "OwnA", 50_000, 100)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.mode).toBe("single");
        expect(owners(c)).toEqual(["OwnA"]);
        expect(c.notApplied).toEqual(["B1"]);
    });

    it("the first owner to reach the price wins", () => {
        const c = coverage(
            PRICE,
            [t("A1", "OwnA", 50_000, 100), t("B1", "OwnB", 50_000, 101)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.mode).toBe("single");
        expect(owners(c)).toEqual(["OwnA"]);
        expect(c.notApplied).toEqual(["B1"]);
    });

    it("an owner's later transfers are not applied and the crossing keeps the rest", () => {
        const c = coverage(
            PRICE,
            [
                t("A1", "OwnA", 30_000, 100),
                t("A2", "OwnA", 30_000, 101),
                t("A3", "OwnA", 5_000, 102),
            ],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.mode).toBe("single");
        expect(entries(c.applied)).toEqual({ A1: 30_000, A2: 20_000 });
        expect(entries(c.extra)).toEqual({ A2: 10_000 });
        expect(c.notApplied).toEqual(["A3"]);
        expect(c.countedMicros).toBe(60_000);
    });

    it("two owners share when neither reaches it alone", () => {
        const c = coverage(
            PRICE,
            [t("A1", "OwnA", 30_000, 100), t("B1", "OwnB", 20_000, 101)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.mode).toBe("shared");
        expect(c.owners).toEqual([
            { owner: "OwnA", sourceTokenAccount: "SrcA", appliedMicros: 30_000 },
            { owner: "OwnB", sourceTokenAccount: "SrcB", appliedMicros: 20_000 },
        ]);
        expect(c.countedMicros).toBe(50_000);
        expect(c.notApplied).toEqual([]);
    });

    it("the larger share is part 0, a tie goes to the earliest", () => {
        const larger = coverage(
            PRICE,
            [t("A1", "OwnA", 20_000, 100), t("B1", "OwnB", 30_000, 101)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(larger.owners.map((o) => [o.owner, o.appliedMicros])).toEqual([
            ["OwnB", 30_000],
            ["OwnA", 20_000],
        ]);
        const tie = coverage(
            PRICE,
            [t("A1", "OwnA", 25_000, 100), t("B1", "OwnB", 25_000, 101)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(owners(tie)).toEqual(["OwnA", "OwnB"]);
    });

    it("the crossing transfer keeps the rest as extra", () => {
        const c = coverage(
            PRICE,
            [t("A1", "OwnA", 30_000, 100), t("B1", "OwnB", 30_000, 101)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.mode).toBe("shared");
        expect(entries(c.applied)).toEqual({ A1: 30_000, B1: 20_000 });
        expect(entries(c.extra)).toEqual({ B1: 10_000 });
        expect(c.crossing?.signature).toBe("B1");
    });

    it("an owner's source is the account with its largest applied part", () => {
        const c = coverage(
            PRICE,
            [
                t("A1", "OwnA", 10_000, 100, { sourceTokenAccount: "SrcA1" }),
                t("A2", "OwnA", 15_000, 101, { sourceTokenAccount: "SrcA2" }),
                t("B1", "OwnB", 25_000, 102),
            ],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.owners).toEqual([
            { owner: "OwnA", sourceTokenAccount: "SrcA2", appliedMicros: 25_000 },
            { owner: "OwnB", sourceTokenAccount: "SrcB", appliedMicros: 25_000 },
        ]);
    });

    it("owners beyond the cap are left out", () => {
        const five = ["A", "B", "C", "D", "E"].map((x, i) => t(`${x}1`, `Own${x}`, 12_000, 90 + i));
        const c = coverage(PRICE, five, EXPIRES, NONE, CFG);
        expect(c.mode).toBe("short");
        expect(c.countedMicros).toBe(48_000);
        expect(c.notApplied).toEqual(["E1"]);
        expect(c.owners).toEqual([]);
        expect(entries(c.applied)).toEqual({});
    });

    it("late and unattributed transfers do not count", () => {
        const c = coverage(
            PRICE,
            [
                t("L1", "OwnA", 50_000, 100, { blockTime: new Date("2030-01-01T00:15:01Z") }),
                t("U1", null, 50_000, 101),
                t("A1", "OwnA", 30_000, 102),
            ],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.mode).toBe("short");
        expect(c.countedMicros).toBe(30_000);
        expect(c.largestMicros).toBe(30_000);
        expect(c.otherMicros).toBe(0);
        expect(c.notApplied).toEqual([]);
    });

    it("a transfer at the deadline is on time", () => {
        const c = coverage(
            PRICE,
            [t("A1", "OwnA", 50_000, 100, { blockTime: EXPIRES })],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.mode).toBe("single");
    });

    it("only open transfers count", () => {
        const c = coverage(
            PRICE,
            [
                t("B1", "OwnB", 50_000, 99, { outcome: "return", reason: "payer_blocked" }),
                t("R1", "OwnC", 50_000, 100, { outcome: "review", reason: "from_bugnet" }),
                t("A1", "OwnA", 30_000, 101),
            ],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.mode).toBe("short");
        expect(c.largestMicros).toBe(30_000);
    });

    it("dust owners never take part in a shared payment", () => {
        const dust = ["C", "D", "E", "F", "G"].map((x, i) => t(`${x}1`, `Own${x}`, 600, 90 + i));
        const short = coverage(
            PRICE,
            [...dust, t("A1", "OwnA", 25_000, 95), t("B1", "OwnB", 22_000, 96)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(short.mode).toBe("short");
        expect(short.countedMicros).toBe(47_000);
        expect(short.dust).toEqual(["C1", "D1", "E1", "F1", "G1"]);
        expect(entries(short.applied)).toEqual({});

        const shared = coverage(
            PRICE,
            [...dust, t("A1", "OwnA", 25_000, 95), t("B1", "OwnB", 25_000, 96)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(shared.mode).toBe("shared");
        expect(shared.owners.map((o) => [o.owner, o.appliedMicros])).toEqual([
            ["OwnA", 25_000],
            ["OwnB", 25_000],
        ]);
        expect(shared.dust).toEqual(["C1", "D1", "E1", "F1", "G1"]);
        expect(entries(shared.applied)).toEqual({ A1: 25_000, B1: 25_000 });
        expect(shared.notApplied).toEqual([]);
    });

    it("a held owner is left out", () => {
        const held = { owners: new Map<string, OwnerHoldReason>([["OwnB", "payer_busy"]]) };
        const c = coverage(
            PRICE,
            [t("B1", "OwnB", 50_000, 99), t("A1", "OwnA", 50_000, 100)],
            EXPIRES,
            { ...held, shared: false },
            CFG,
        );
        expect(c.mode).toBe("single");
        expect(owners(c)).toEqual(["OwnA"]);
        expect(c.notApplied).toEqual(["B1"]);
        expect(c.heldCovers).toBeNull();

        const alone = coverage(
            PRICE,
            [t("B1", "OwnB", 50_000, 99)],
            EXPIRES,
            { ...held, shared: false },
            CFG,
        );
        expect(alone.mode).toBe("short");
        expect(alone.heldCovers).toBe("payer_busy");
        expect(alone.notApplied).toEqual(["B1"]);
    });

    it("a shared hold stops only the shared mode", () => {
        const held = { owners: new Map<string, OwnerHoldReason>(), shared: true };
        const c = coverage(
            PRICE,
            [t("A1", "OwnA", 30_000, 100), t("B1", "OwnB", 20_000, 101)],
            EXPIRES,
            held,
            CFG,
        );
        expect(c.mode).toBe("short");
        expect(c.heldCovers).toBe("anonymous_busy");

        const single = coverage(PRICE, [t("A1", "OwnA", 50_000, 100)], EXPIRES, held, CFG);
        expect(single.mode).toBe("single");
        expect(single.heldCovers).toBeNull();
    });

    it("a short coverage without a held owner names no hold", () => {
        const c = coverage(PRICE, [t("A1", "OwnA", 30_000, 100)], EXPIRES, NONE, CFG);
        expect(c.mode).toBe("short");
        expect(c.heldCovers).toBeNull();
        expect(c.crossing).toBeNull();
    });

    it("largest and other", () => {
        const c = coverage(
            PRICE,
            [t("A1", "OwnA", 30_000, 100), t("B1", "OwnB", 1_000, 101)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.largestMicros).toBe(30_000);
        expect(c.largestOwner).toBe("OwnA");
        expect(c.otherMicros).toBe(1_000);
    });

    it("other is every owner outside the coverage once it reaches the price", () => {
        const c = coverage(
            PRICE,
            [t("A1", "OwnA", 50_000, 100), t("B1", "OwnB", 60_000, 101)],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(c.mode).toBe("single");
        expect(c.largestOwner).toBe("OwnB");
        expect(c.largestMicros).toBe(60_000);
        expect(c.otherMicros).toBe(60_000);
    });

    it("chain order is slot, then seq", () => {
        const c = coverage(
            PRICE,
            [t("B1", "OwnB", 50_000, 100, { seq: 1 }), t("A1", "OwnA", 50_000, 100, { seq: 0 })],
            EXPIRES,
            NONE,
            CFG,
        );
        expect(owners(c)).toEqual(["OwnA"]);
    });

    it("nothing on time gives an empty short coverage", () => {
        const c = coverage(PRICE, [], EXPIRES, NONE, CFG);
        expect(c).toMatchObject({
            mode: "short",
            countedMicros: 0,
            largestMicros: 0,
            largestOwner: null,
            otherMicros: 0,
            crossing: null,
            heldCovers: null,
        });
    });
});
