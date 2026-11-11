import { describe, expect, it } from "vitest";
import { type Plan, type PlanInput, planDeposit, transferTime } from "./plan.ts";
import type { DepositRow, HoldRow, MoveRow, TransferRow } from "./types.ts";

const ORDER_ID = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDRESS = "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley";
const TOKEN = "D2mAKdUVEHvizHThmG57bTCiASiiYj5gQbMeMoyWtQo1";
const RECIPIENT = "RecipientAta";

const at = (hms: string): Date => new Date(`2030-01-01T${hms}Z`);
const NOW = at("00:05:00");
const EXPIRES = at("00:15:00");

const CFG: PlanInput["cfg"] = {
    settle_grace: 60_000,
    refund_min_micros: 1_000,
    max_open: 500,
    rented_per_ip: 1,
    rented_per_block: 2,
    max_attempts: 3,
    max_late_returns: 2,
    busy_every: 2_000,
    close_retry_after: [120_000, 600_000, 3_600_000],
    returns_per_owner_per_hour: 6,
    max_split_owners: 4,
    compute_unit_limit: 40_000,
    compute_unit_price_micro_lamports: 10_000,
};

function depositRow(over: Partial<DepositRow> = {}): DepositRow {
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
        rentPayer: "Fee",
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
        createdAt: at("00:00:00"),
        readyAt: at("00:01:00"),
        checkedAt: null,
        checkedSlot: null,
        settledAt: null,
        closedAt: null,
        watchUntil: null,
        ...over,
    };
}

// A transfer named by its owner letter: owner "OwnA" sends from "SrcA"
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
        blockTime: at("00:04:00"),
        seenAt: at("00:04:00"),
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

const A1 = (over: Partial<TransferRow> = {}) => t("A1", "OwnA", 30_000, 100, over);
const B1 = (over: Partial<TransferRow> = {}) =>
    t("B1", "OwnB", 30_000, 101, { blockTime: at("00:04:30"), ...over });
const A2 = (over: Partial<TransferRow> = {}) =>
    t("A2", "OwnA", 30_000, 101, { seq: 1, blockTime: at("00:04:30"), ...over });
const U1 = (over: Partial<TransferRow> = {}) => t("U1", null, 7_000, 102, over);
const C1 = (over: Partial<TransferRow> = {}) => t("C1", "OwnC", 500, 102, over);

function mv(
    id: number,
    kind: MoveRow["kind"],
    state: MoveRow["state"],
    over: Partial<MoveRow> = {},
): MoveRow {
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
        txSignature: state === "pending" ? null : `move${id}`,
        wireTx: null,
        lastValidBlockHeight: null,
        previousSignatures: [],
        attempts: state === "pending" ? 0 : 1,
        landedSlot: state === "confirmed" ? 150n : null,
        expirySeenSlot: null,
        preflightRefusedAt: null,
        manualReason: null,
        createdAt: NOW,
        signedAt: null,
        sentAt: null,
        confirmedAt: null,
        failedAt: state === "failed" ? NOW : null,
        ...over,
    };
}

function hold(owner: string, reason: HoldRow["reason"], recheckAt: Date): HoldRow {
    return { orderId: ORDER_ID, owner, reason, recheckAt, since: NOW };
}

type Over = Partial<Omit<PlanInput, "order" | "deposit" | "read">> & {
    order?: Partial<PlanInput["order"]>;
    deposit?: Partial<DepositRow>;
    read?: Partial<PlanInput["read"]>;
};

function input(o: Over = {}): PlanInput {
    const { order, deposit, read, ...rest } = o;
    const r: PlanInput["read"] = {
        exists: true,
        micros: 0n,
        contextSlot: 200n,
        invariant: "held",
        ...read,
    };
    return {
        order: {
            id: ORDER_ID,
            state: "unpaid",
            amountMicros: 50_000,
            expiresAt: EXPIRES,
            payInto: "cold",
            kind: "start",
            ...order,
        },
        deposit: depositRow(deposit),
        read: r,
        expectedMicros: r.micros,
        transfers: [],
        moves: [],
        holds: [],
        bugnetOwners: new Set(["OwnBugnet"]),
        viewer: { seen: false, ipRented: 0, blockRented: 0 },
        rentHolding: 0,
        unpaidCreateLeft: 1_000_000n,
        feeBudgetLeft: 2_000_000n,
        ownerReturns: new Map(),
        feePayer: "Fee",
        now: NOW,
        cfg: CFG,
        ...rest,
    };
}

// The inputs of an expired order whose deposit is draining
const EXPIRED: Over = { order: { state: "expired" }, deposit: { state: "draining" } };
const expired = (o: Over = {}): PlanInput =>
    input({
        ...o,
        order: { ...EXPIRED.order, ...o.order },
        deposit: { ...EXPIRED.deposit, ...o.deposit },
    });

const entries = (m: ReadonlyMap<string, number>) => Object.fromEntries(m);
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function settled(p: Plan): Extract<Plan, { kind: "settle" }> {
    if (p.kind !== "settle") throw new Error(`expected settle, got ${JSON.stringify(p)}`);
    return p;
}

function moved(p: Plan): Extract<Plan, { kind: "move" }> {
    if (p.kind !== "move") throw new Error(`expected move, got ${JSON.stringify(p)}`);
    return p;
}

// Writes an assign plan's outcomes and clears holds, as the tick does
function assigned(i: PlanInput, p: Plan): PlanInput {
    if (p.kind !== "assign") throw new Error(`expected assign, got ${JSON.stringify(p)}`);
    const rows = new Map(p.rows.map((r) => [r.signature, r]));
    return {
        ...i,
        transfers: i.transfers.map((x) => {
            const r = rows.get(x.signature);
            return r === undefined ? x : { ...x, outcome: r.outcome, reason: r.reason };
        }),
        holds: p.clearHolds === true ? [] : i.holds,
        deposit:
            p.clearHolds === true ? { ...i.deposit, holdReason: null, recheckAt: null } : i.deposit,
    };
}

// Lands a move plan: the move is confirmed and the transfers it carries name it
function landed(i: PlanInput, p: Plan, id: number, micros: bigint): PlanInput {
    const m = moved(p);
    const carried = new Set(m.transfers);
    return {
        ...i,
        moves: [...i.moves, mv(id, m.move.kind, "confirmed", { ...m.move })],
        transfers: i.transfers.map((x) => (carried.has(x.signature) ? { ...x, moveId: id } : x)),
        read: { ...i.read, micros },
        expectedMicros: micros,
    };
}

const WAIT = { kind: "wait" };

describe("planDeposit: settle", () => {
    it("settles when one owner reaches the price", () => {
        const p = settled(
            planDeposit(input({ transfers: [A1(), A2()], read: { micros: 60_000n } })),
        );
        expect(entries(p.applied)).toEqual({ A1: 30_000, A2: 20_000 });
        expect(entries(p.extra)).toEqual({ A2: 10_000 });
        expect(p.owners).toEqual([
            { owner: "OwnA", sourceTokenAccount: "SrcA", appliedMicros: 50_000 },
        ]);
        expect(p.multiSender).toBe(false);
        expect(p.paidAt).toEqual(at("00:04:30"));
        expect(p.closes).toBe(false);
        // The crossing transfer stays paid; its rest is extra
        expect(p.others).toEqual([{ signature: "A2", outcome: "paid", reason: "extra" }]);
    });

    it("a stranger's dust first does not share the payment", () => {
        const p = settled(
            planDeposit(
                input({
                    transfers: [B1({ amountMicros: 1, slot: 99n }), A1({ amountMicros: 50_000 })],
                    read: { micros: 50_001n },
                }),
            ),
        );
        expect(p.owners.map((o) => o.owner)).toEqual(["OwnA"]);
        expect(p.multiSender).toBe(false);
        expect(p.others).toEqual([{ signature: "B1", outcome: "keep", reason: "below_minimum" }]);
        expect(p.closes).toBe(false);
    });

    it("a stranger's larger transfer first is returned as extra", () => {
        const p = settled(
            planDeposit(
                input({
                    transfers: [
                        B1({ amountMicros: 30_000, slot: 99n }),
                        A1({ amountMicros: 50_000 }),
                    ],
                    read: { micros: 80_000n },
                }),
            ),
        );
        expect(p.owners.map((o) => o.owner)).toEqual(["OwnA"]);
        expect(p.others).toEqual([{ signature: "B1", outcome: "return", reason: "extra" }]);
    });

    it("a held stranger who came first does not stop the user", () => {
        const b1 = B1({ amountMicros: 50_000, slot: 99n });
        const holds = [hold("OwnB", "payer_busy", at("00:05:10"))];
        const now = at("00:05:02");
        const p = settled(
            planDeposit(
                input({
                    transfers: [b1, A1({ amountMicros: 50_000 })],
                    holds,
                    now,
                    read: { micros: 100_000n },
                }),
            ),
        );
        expect(p.owners.map((o) => o.owner)).toEqual(["OwnA"]);
        expect(p.others).toEqual([{ signature: "B1", outcome: "return", reason: "extra" }]);

        const alone = input({ transfers: [b1], holds, now, read: { micros: 50_000n } });
        expect(planDeposit(alone)).toEqual(WAIT);
    });

    it("dust owners are kept in a shared payment", () => {
        const p = settled(
            planDeposit(
                input({
                    transfers: [A1(), B1({ amountMicros: 20_000 }), C1()],
                    read: { micros: 50_500n },
                }),
            ),
        );
        expect(p.owners.map((o) => o.owner)).toEqual(["OwnA", "OwnB"]);
        expect(p.multiSender).toBe(true);
        expect(p.others).toEqual([{ signature: "C1", outcome: "keep", reason: "below_minimum" }]);
        expect(p.closes).toBe(false);
    });

    it("two owners share the payment", () => {
        const p = settled(
            planDeposit(
                input({
                    transfers: [A1(), B1({ amountMicros: 20_000 })],
                    read: { micros: 50_000n },
                }),
            ),
        );
        expect(p.owners).toEqual([
            { owner: "OwnA", sourceTokenAccount: "SrcA", appliedMicros: 30_000 },
            { owner: "OwnB", sourceTokenAccount: "SrcB", appliedMicros: 20_000 },
        ]);
        expect(p.multiSender).toBe(true);
        expect(p.closes).toBe(true);
        expect(p.paidAt).toEqual(at("00:04:30"));
    });

    it("exact price closes in the sweep", () => {
        const p = settled(
            planDeposit(
                input({ transfers: [A1({ amountMicros: 50_000 })], read: { micros: 50_000n } }),
            ),
        );
        expect(entries(p.applied)).toEqual({ A1: 50_000 });
        expect(entries(p.extra)).toEqual({});
        expect(p.others).toEqual([]);
        expect(p.closes).toBe(true);
    });

    it("unattributed is per transfer", () => {
        const first = input({
            transfers: [A1({ amountMicros: 50_000 }), U1()],
            read: { micros: 57_000n },
        });
        const p = planDeposit(first);
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "U1", outcome: "review", reason: "unattributed" }],
        });
        const s = settled(planDeposit(assigned(first, p)));
        expect(entries(s.applied)).toEqual({ A1: 50_000 });
        expect(s.closes).toBe(false);
    });

    it("money from a Bugnet wallet goes to review", () => {
        const p = planDeposit(
            input({
                transfers: [t("F1", "OwnBugnet", 50_000, 100)],
                read: { micros: 50_000n },
            }),
        );
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "F1", outcome: "review", reason: "from_bugnet" }],
        });
    });
});

describe("planDeposit: the deadline", () => {
    it("a transfer on time but seen late still settles", () => {
        const p = settled(
            planDeposit(
                input({
                    transfers: [
                        A1({
                            amountMicros: 50_000,
                            blockTime: at("00:14:59"),
                            seenAt: at("00:15:40"),
                        }),
                    ],
                    now: at("00:15:41"),
                    read: { micros: 50_000n },
                }),
            ),
        );
        expect(p.paidAt).toEqual(at("00:14:59"));
    });

    it("a transfer after the deadline is late", () => {
        const p = planDeposit(
            input({
                transfers: [A1({ amountMicros: 50_000, blockTime: at("00:15:01") })],
                now: at("00:15:30"),
                read: { micros: 50_000n },
            }),
        );
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "A1", outcome: "return", reason: "late" }],
        });
    });

    it("the deadline uses the block time only", () => {
        const onTime = A1({
            amountMicros: 50_000,
            blockTime: at("00:14:59"),
            seenAt: at("00:15:40"),
        });
        expect(transferTime(onTime)).toEqual(at("00:14:59"));
        const now = at("00:15:41");
        const read = { micros: 50_000n };
        expect(planDeposit(input({ transfers: [onTime], now, read })).kind).toBe("settle");

        const late = A1({
            amountMicros: 50_000,
            blockTime: at("00:15:01"),
            seenAt: at("00:14:00"),
        });
        expect(planDeposit(input({ transfers: [late], now, read }))).toEqual({
            kind: "assign",
            rows: [{ signature: "A1", outcome: "return", reason: "late" }],
        });
    });

    it("before the deadline a blocked owner's money goes back at once", () => {
        const p = moved(
            planDeposit(
                input({
                    transfers: [
                        A1(),
                        B1({ amountMicros: 20_000, outcome: "return", reason: "payer_blocked" }),
                    ],
                    read: { micros: 50_000n },
                }),
            ),
        );
        expect(p.move).toMatchObject({
            kind: "return",
            amountMicros: 20_000,
            destination: "SrcB",
            payer: "OwnB",
            closes: false,
        });
        expect(p.transfers).toEqual(["B1"]);
        expect(p.metered).toBe(true);
    });

    it("expire does not apply before the deadline", () => {
        const p = moved(
            planDeposit(
                input({
                    transfers: [A1()],
                    deposit: { readyAt: null },
                    read: { exists: false },
                    viewer: { seen: true, ipRented: 0, blockRented: 0 },
                }),
            ),
        );
        expect(p.move.kind).toBe("create");
    });

    it("waits during the grace", () => {
        const p = planDeposit(
            input({ transfers: [A1()], now: at("00:15:30"), read: { micros: 30_000n } }),
        );
        expect(p).toEqual(WAIT);
    });

    it("expiry needs a read at the pinned slot", () => {
        const at1605 = (deposit: Partial<DepositRow>) =>
            planDeposit(
                input({
                    transfers: [A1()],
                    now: at("00:16:05"),
                    read: { micros: 30_000n },
                    deposit: { checkedAt: at("00:16:01"), ...deposit },
                }),
            );
        expect(at1605({ expiryMinSlot: null })).toEqual({ kind: "need_slot" });
        expect(at1605({ expiryMinSlot: 500n, checkedSlot: 499n })).toEqual(WAIT);
        expect(at1605({ expiryMinSlot: 500n, checkedSlot: 500n })).toEqual({ kind: "expire" });
        expect(
            at1605({ expiryMinSlot: 500n, checkedSlot: 500n, checkedAt: at("00:15:59") }),
        ).toEqual(WAIT);
    });

    it("review stops moves, not expiry", () => {
        const deposit: Partial<DepositRow> = {
            reviewReason: "unknown_debit",
            checkedAt: at("00:16:01"),
            expiryMinSlot: 500n,
            checkedSlot: 500n,
        };
        const now = at("00:16:05");
        const read = { micros: 30_000n };
        expect(planDeposit(input({ transfers: [A1()], deposit, now, read }))).toEqual({
            kind: "expire",
        });

        const returning = A1({ outcome: "return", reason: "unpaid" });
        expect(planDeposit(expired({ transfers: [returning], deposit, now, read }))).toEqual(WAIT);
    });
});

describe("planDeposit: the order no longer takes money here", () => {
    it("draining when the order no longer takes money", () => {
        const open = (state: PlanInput["order"]["state"]) =>
            planDeposit(input({ order: { state }, transfers: [A1()], read: { micros: 30_000n } }));
        expect(open("expired")).toEqual({ kind: "drain" });
        expect(open("paid")).toEqual({ kind: "drain" });
        expect(open("settling")).toEqual(WAIT);
    });

    it("expired order returns open money as unpaid", () => {
        expect(planDeposit(expired({ transfers: [A1()], read: { micros: 30_000n } }))).toEqual({
            kind: "assign",
            rows: [{ signature: "A1", outcome: "return", reason: "unpaid" }],
        });
    });

    it("late money on an expired order is late and capped", () => {
        const b1 = B1({ blockTime: at("00:20:00") });
        const now = at("00:21:00");
        const read = { micros: 30_000n };
        expect(planDeposit(expired({ transfers: [b1], now, read }))).toEqual({
            kind: "assign",
            rows: [{ signature: "B1", outcome: "return", reason: "late" }],
        });
        const closed = expired({
            transfers: [b1],
            now,
            read,
            deposit: { state: "closed", lateReturns: 2, rentPayer: "Stranger" },
        });
        expect(planDeposit(closed)).toEqual({
            kind: "assign",
            rows: [{ signature: "B1", outcome: "review", reason: "late_limit" }],
        });
    });

    it("paid another way returns as paid_otherwise", () => {
        const p = planDeposit(
            input({
                order: { state: "paid" },
                deposit: { state: "draining" },
                transfers: [A1()],
                read: { micros: 30_000n },
            }),
        );
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "A1", outcome: "return", reason: "paid_otherwise" }],
        });
    });

    it("x402 in flight waits", () => {
        const p = planDeposit(
            input({ order: { state: "settling" }, transfers: [A1()], read: { micros: 30_000n } }),
        );
        expect(p).toEqual(WAIT);
    });

    it("money after this deposit paid is after_paid", () => {
        const p = planDeposit(
            input({
                order: { state: "paid" },
                deposit: { state: "draining", settledAt: at("00:05:00") },
                transfers: [
                    A1({ amountMicros: 50_000, outcome: "paid", appliedMicros: 50_000 }),
                    B1({ blockTime: at("00:06:00") }),
                ],
                moves: [mv(1, "sweep", "confirmed", { amountMicros: 50_000 })],
                now: at("00:06:10"),
                read: { micros: 30_000n },
            }),
        );
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "B1", outcome: "return", reason: "after_paid" }],
        });
    });
});

describe("planDeposit: failing moves", () => {
    const sweep = (id: number, state: MoveRow["state"], closes: boolean) =>
        mv(id, "sweep", state, {
            amountMicros: 50_000,
            destination: RECIPIENT,
            memo: ORDER_ID,
            closes,
            closeTo: closes ? "Fee" : null,
        });
    const settling = (o: Over): PlanInput =>
        input({
            order: { state: "settling" },
            ...o,
            deposit: { state: "settling", settledAt: at("00:04:50"), ...o.deposit },
        });
    const paidA1 = A1({ amountMicros: 50_000, outcome: "paid", appliedMicros: 50_000 });

    it("failing moves come before sweeping again", () => {
        const p = planDeposit(
            settling({
                transfers: [paidA1],
                moves: [
                    sweep(1, "failed", false),
                    sweep(2, "failed", false),
                    sweep(3, "failed", false),
                ],
                read: { micros: 50_000n },
            }),
        );
        expect(p).toEqual({ kind: "assign", rows: [], review: "moves_failing" });
    });

    it("a retry counts only the sweeps that failed after it", () => {
        const before = [1, 2, 3].map((id) => ({
            ...sweep(id, "failed", false),
            createdAt: ago(60_000),
        }));
        const retried = { movesFailingResetAt: ago(30_000) };
        const again = planDeposit(
            settling({
                transfers: [paidA1],
                moves: before,
                read: { micros: 50_000n },
                deposit: retried,
            }),
        );
        expect(again).toMatchObject({ kind: "move", move: { kind: "sweep" } });
        const after = [4, 5, 6].map((id) => sweep(id, "failed", false));
        const p = planDeposit(
            settling({
                transfers: [paidA1],
                moves: [...before, ...after],
                read: { micros: 50_000n },
                deposit: retried,
            }),
        );
        expect(p).toEqual({ kind: "assign", rows: [], review: "moves_failing" });
    });

    it("failing returns stop only their destination", () => {
        const back = (id: number) =>
            mv(id, "return", "failed", {
                amountMicros: 20_000,
                destination: "SrcB",
                payer: "OwnB",
                memo: `bugnet-return ${ORDER_ID}`,
            });
        const first = expired({
            transfers: [
                A1({ outcome: "return", reason: "unpaid" }),
                B1({ amountMicros: 20_000, outcome: "return", reason: "unpaid", moveId: 3 }),
            ],
            moves: [back(1), back(2), back(3)],
            read: { micros: 50_000n },
        });
        const p = planDeposit(first);
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "B1", outcome: "review", reason: "return_failed" }],
        });
        const next = moved(planDeposit(assigned(first, p)));
        expect(next.move).toMatchObject({
            kind: "return",
            amountMicros: 30_000,
            destination: "SrcA",
            heldMicros: 20_000,
            closes: true,
        });
        expect(next.transfers).toEqual(["A1", "B1"]);
    });

    it("closing failures never review", () => {
        const sweeps = settling({
            transfers: [paidA1],
            deposit: { closeSeparately: true },
            moves: [sweep(1, "failed", true), sweep(2, "failed", true), sweep(3, "failed", true)],
            read: { micros: 50_000n },
        });
        expect(moved(planDeposit(sweeps)).move).toMatchObject({ kind: "sweep", closes: false });

        const closing = (id: number) =>
            mv(id, "return", "failed", {
                amountMicros: 30_000,
                destination: "SrcA",
                payer: "OwnA",
                closes: true,
                closeTo: "Fee",
            });
        const close = (id: number) => mv(id, "close", "failed", { closes: true, closeTo: "Fee" });
        const returns = expired({
            transfers: [A1({ outcome: "return", reason: "unpaid" })],
            deposit: { closeSeparately: true },
            moves: [closing(1), closing(2), closing(3), close(4), close(5), close(6)],
            read: { micros: 30_000n },
        });
        expect(moved(planDeposit(returns)).move).toMatchObject({ kind: "return", closes: false });
    });

    it("sweep again after a failed sweep", () => {
        const o: Over = {
            transfers: [paidA1, B1({ amountMicros: 1, outcome: "return", reason: "after_paid" })],
            deposit: { closeSeparately: true },
            read: { micros: 50_001n },
        };
        const p = moved(planDeposit(settling({ ...o, moves: [sweep(1, "failed", true)] })));
        expect(p).toEqual({
            kind: "move",
            move: {
                orderId: ORDER_ID,
                kind: "sweep",
                amountMicros: 50_000,
                keepMicros: 0,
                heldMicros: 0,
                destination: RECIPIENT,
                payer: null,
                memo: ORDER_ID,
                closes: false,
                closeTo: null,
            },
            transfers: [],
            metered: false,
        });

        const done = planDeposit(settling({ ...o, moves: [sweep(1, "confirmed", true)] }));
        expect(done.kind === "move" && done.move.kind === "sweep").toBe(false);
    });
});

describe("planDeposit: holds", () => {
    const a1 = A1({ amountMicros: 50_000 });
    const read = { micros: 50_000n };

    it("an owner's hold waits, is taken in again, and ends with the grace", () => {
        const busy = [hold("OwnA", "payer_busy", at("00:05:10"))];
        expect(
            planDeposit(input({ transfers: [a1], holds: busy, now: at("00:05:05"), read })),
        ).toEqual(WAIT);
        expect(
            planDeposit(input({ transfers: [a1], holds: busy, now: at("00:05:11"), read })).kind,
        ).toBe("settle");
        expect(
            planDeposit(input({ transfers: [a1], holds: busy, now: at("00:16:00"), read })),
        ).toEqual({
            kind: "assign",
            rows: [{ signature: "A1", outcome: "return", reason: "payer_busy" }],
            clearHolds: true,
        });

        const limited = [hold("OwnA", "payer_rate_limited", at("00:05:10"))];
        expect(
            planDeposit(input({ transfers: [a1], holds: limited, now: at("00:16:00"), read })),
        ).toEqual({
            kind: "assign",
            rows: [{ signature: "A1", outcome: "return", reason: "payer_rate_limited" }],
            clearHolds: true,
        });
    });

    it("the anonymous pool's hold returns the shared owners as pool_busy", () => {
        const p = planDeposit(
            input({
                transfers: [A1(), B1({ amountMicros: 20_000 })],
                holds: [hold("", "anonymous_busy", at("00:05:10"))],
                now: at("00:16:00"),
                read,
            }),
        );
        expect(p).toEqual({
            kind: "assign",
            rows: [
                { signature: "A1", outcome: "return", reason: "pool_busy" },
                { signature: "B1", outcome: "return", reason: "pool_busy" },
            ],
            clearHolds: true,
        });
    });

    it("a deposit hold stops every settle until its recheck and returns at the grace", () => {
        const deposit: Partial<DepositRow> = {
            holdReason: "router_unavailable",
            recheckAt: at("00:05:10"),
        };
        expect(planDeposit(input({ transfers: [a1], deposit, now: at("00:05:05"), read }))).toEqual(
            WAIT,
        );
        const blocked = B1({ amountMicros: 20_000, outcome: "return", reason: "payer_blocked" });
        const withReturn = input({
            transfers: [a1, blocked],
            deposit,
            now: at("00:05:05"),
            read: { micros: 70_000n },
        });
        expect(planDeposit(withReturn)).toEqual(WAIT);
        const above = input({
            transfers: [a1],
            deposit,
            now: at("00:05:05"),
            read: { micros: 60_000n, invariant: "above" },
        });
        expect(planDeposit(above)).toEqual(WAIT);
        expect(planDeposit({ ...above, now: at("00:05:11") }).kind).toBe("settle");
        expect(planDeposit(input({ transfers: [a1], deposit, now: at("00:16:00"), read }))).toEqual(
            {
                kind: "assign",
                rows: [{ signature: "A1", outcome: "return", reason: "router_unavailable" }],
                clearHolds: true,
            },
        );

        const paused = input({
            transfers: [a1],
            deposit: { holdReason: "allowance_paused", recheckAt: at("00:05:10") },
            now: at("00:16:00"),
            read,
        });
        expect(planDeposit(paused)).toEqual({
            kind: "assign",
            rows: [{ signature: "A1", outcome: "return", reason: "allowance_unavailable" }],
            clearHolds: true,
        });
    });

    it("an expired order's held money is returned with its hold's reason", () => {
        const transfers = [
            A1(),
            B1({ amountMicros: 20_000 }),
            t("C1", "OwnC", 5_000, 102, { blockTime: at("00:15:30") }),
        ];
        const holds = [hold("", "anonymous_busy", at("00:15:20"))];
        const now = at("00:21:05");
        const first = expired({ transfers, holds, now, read: { micros: 55_000n } });
        const p = planDeposit(first);
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "C1", outcome: "return", reason: "late" }],
        });
        expect(planDeposit(assigned(first, p))).toEqual({
            kind: "assign",
            rows: [
                { signature: "A1", outcome: "return", reason: "pool_busy" },
                { signature: "B1", outcome: "return", reason: "pool_busy" },
            ],
            clearHolds: true,
        });

        const above = expired({
            transfers,
            holds,
            now,
            read: { micros: 60_000n, invariant: "above" },
        });
        const late = planDeposit(above);
        expect(late).toEqual(p);
        expect(planDeposit(assigned(above, late))).toEqual(WAIT);

        expect(planDeposit(expired({ transfers, now, read: { micros: 55_000n } }))).toEqual({
            kind: "assign",
            rows: [
                { signature: "A1", outcome: "return", reason: "unpaid" },
                { signature: "B1", outcome: "return", reason: "unpaid" },
                { signature: "C1", outcome: "return", reason: "late" },
            ],
        });
    });
});

describe("planDeposit: moving money", () => {
    it("returns go one per source, oldest first", () => {
        const first = expired({
            transfers: [
                A1({ amountMicros: 10_000, outcome: "return", reason: "unpaid" }),
                B1({ amountMicros: 7_000, outcome: "return", reason: "unpaid" }),
                A2({ amountMicros: 5_000, outcome: "return", reason: "unpaid" }),
            ],
            read: { micros: 22_000n },
        });
        const p = planDeposit(first);
        expect(p).toEqual({
            kind: "move",
            move: {
                orderId: ORDER_ID,
                kind: "return",
                amountMicros: 15_000,
                keepMicros: 0,
                heldMicros: 0,
                destination: "SrcA",
                payer: "OwnA",
                memo: `bugnet-return ${ORDER_ID}`,
                closes: false,
                closeTo: null,
            },
            transfers: ["A1", "A2"],
            metered: true,
        });
        const next = moved(planDeposit(landed(first, p, 1, 7_000n)));
        expect(next.move).toMatchObject({
            kind: "return",
            amountMicros: 7_000,
            destination: "SrcB",
            payer: "OwnB",
            closes: true,
            closeTo: "Fee",
        });
        expect(next.transfers).toEqual(["B1"]);
        expect(next.metered).toBe(false);
    });

    it("the extra part goes back after the sweep", () => {
        const p = moved(
            planDeposit(
                input({
                    order: { state: "paid" },
                    deposit: { state: "draining", settledAt: at("00:04:50") },
                    transfers: [
                        A1({ outcome: "paid", appliedMicros: 30_000 }),
                        A2({ outcome: "paid", appliedMicros: 20_000, reason: "extra" }),
                    ],
                    moves: [mv(1, "sweep", "confirmed", { amountMicros: 50_000 })],
                    read: { micros: 10_000n },
                }),
            ),
        );
        expect(p.move).toMatchObject({
            kind: "return",
            amountMicros: 10_000,
            destination: "SrcA",
            payer: "OwnA",
            closes: true,
            closeTo: "Fee",
        });
        expect(p.transfers).toEqual(["A2"]);
    });

    it("only the rest of a paid transfer in review rides to the float", () => {
        const p = moved(
            planDeposit(
                input({
                    order: { state: "paid" },
                    deposit: {
                        state: "draining",
                        settledAt: at("00:04:50"),
                        stableSince: ago(3_000),
                    },
                    transfers: [
                        A1({ outcome: "paid", appliedMicros: 30_000 }),
                        A2({
                            outcome: "review",
                            reason: "return_destination_invalid",
                            appliedMicros: 20_000,
                        }),
                    ],
                    moves: [mv(1, "sweep", "confirmed", { amountMicros: 50_000 })],
                    read: { micros: 10_000n },
                }),
            ),
        );
        expect(p.move).toMatchObject({
            kind: "close",
            amountMicros: 0,
            keepMicros: 0,
            heldMicros: 10_000,
            closes: true,
        });
        expect(p.transfers).toEqual(["A2"]);
    });

    it("dust rides in the closing move", () => {
        const first = expired({
            transfers: [
                A1({ amountMicros: 10_000, outcome: "return", reason: "unpaid" }),
                B1({ amountMicros: 500, outcome: "return", reason: "unpaid" }),
            ],
            read: { micros: 10_500n },
        });
        const p = planDeposit(first);
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "B1", outcome: "keep", reason: "below_minimum" }],
        });
        const next = moved(planDeposit(assigned(first, p)));
        expect(next.move).toMatchObject({
            kind: "return",
            amountMicros: 10_000,
            keepMicros: 500,
            heldMicros: 0,
            destination: "SrcA",
            closes: true,
            closeTo: "Fee",
        });
        expect(next.transfers).toEqual(["A1", "B1"]);
    });

    it("review money rides in the closing move to the float", () => {
        const p = moved(
            planDeposit(
                expired({
                    transfers: [
                        A1({ amountMicros: 10_000, outcome: "return", reason: "unpaid" }),
                        U1({ outcome: "review", reason: "unattributed" }),
                    ],
                    read: { micros: 17_000n },
                }),
            ),
        );
        expect(p.move).toMatchObject({
            kind: "return",
            amountMicros: 10_000,
            keepMicros: 0,
            heldMicros: 7_000,
            closes: true,
        });
        expect(p.transfers).toEqual(["A1", "U1"]);
    });

    it("review dust is kept", () => {
        const p = planDeposit(
            expired({
                transfers: [U1({ amountMicros: 500, outcome: "review", reason: "unattributed" })],
                read: { micros: 500n },
            }),
        );
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "U1", outcome: "keep", reason: "below_minimum" }],
        });
    });

    it("a paid deposit holding an unattributed micro still closes", () => {
        const first = input({
            order: { state: "paid" },
            deposit: { state: "draining", settledAt: at("00:04:50"), stableSince: ago(3_000) },
            transfers: [
                A1({ amountMicros: 50_000, outcome: "paid", appliedMicros: 50_000 }),
                U1({ amountMicros: 1, outcome: "review", reason: "unattributed" }),
            ],
            moves: [mv(1, "sweep", "confirmed", { amountMicros: 50_000 })],
            read: { micros: 1n },
        });
        const p = planDeposit(first);
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "U1", outcome: "keep", reason: "below_minimum" }],
        });
        expect(planDeposit(assigned(first, p))).toEqual({
            kind: "move",
            move: {
                orderId: ORDER_ID,
                kind: "close",
                amountMicros: 0,
                keepMicros: 1,
                heldMicros: 0,
                destination: null,
                payer: null,
                memo: null,
                closes: true,
                closeTo: "Fee",
            },
            transfers: ["U1"],
            metered: false,
        });
    });

    it("dust alone goes in the close", () => {
        const p = moved(
            planDeposit(
                expired({
                    transfers: [
                        B1({ amountMicros: 500, outcome: "keep", reason: "below_minimum" }),
                    ],
                    deposit: { stableSince: ago(3_000) },
                    read: { micros: 500n },
                }),
            ),
        );
        expect(p.move).toMatchObject({
            kind: "close",
            amountMicros: 0,
            keepMicros: 500,
            closes: true,
        });
        expect(p.transfers).toEqual(["B1"]);
    });

    it("a failed closing move makes later moves close separately", () => {
        const first = expired({
            transfers: [A1({ amountMicros: 10_000, outcome: "return", reason: "unpaid" })],
            deposit: { closeSeparately: true, stableSince: ago(1_000) },
            read: { micros: 10_000n },
        });
        const p = planDeposit(first);
        expect(moved(p).move).toMatchObject({ kind: "return", closes: false });

        const empty = landed(first, p, 1, 0n);
        expect(planDeposit(empty)).toEqual(WAIT);
        const stable = { ...empty, deposit: { ...empty.deposit, stableSince: ago(3_000) } };
        expect(moved(planDeposit(stable)).move).toMatchObject({
            kind: "close",
            closes: true,
            closeTo: "Fee",
        });
        const backingOff = {
            ...stable,
            deposit: { ...stable.deposit, closeAfter: new Date(NOW.getTime() + 60_000) },
        };
        expect(planDeposit(backingOff)).toEqual(WAIT);
    });

    it("dust on a re-opened closed account is left alone", () => {
        const deposit: Partial<DepositRow> = {
            state: "closed",
            rentPayer: "Stranger",
            stableSince: ago(3_000),
            watchUntil: at("01:00:00"),
        };
        const b1 = B1({ amountMicros: 500, blockTime: at("00:20:00") });
        const now = at("00:21:00");
        const read = { micros: 500n };
        expect(planDeposit(expired({ transfers: [b1], deposit, now, read }))).toEqual({
            kind: "assign",
            rows: [{ signature: "B1", outcome: "return", reason: "late" }],
        });

        const first = expired({
            transfers: [{ ...b1, outcome: "return", reason: "late" }],
            deposit,
            now,
            read,
        });
        const p = planDeposit(first);
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "B1", outcome: "keep", reason: "below_minimum" }],
        });
        expect(planDeposit(assigned(first, p))).toEqual(WAIT);
    });

    it("late returns are capped", () => {
        const deposit = (lateReturns: number): Partial<DepositRow> => ({
            state: "closed",
            rentPayer: "Stranger",
            lateReturns,
            watchUntil: at("01:00:00"),
        });
        const a1 = A1({ amountMicros: 2_000, blockTime: at("00:20:00") });
        const now = at("00:21:00");
        const read = { micros: 2_000n };
        expect(planDeposit(expired({ transfers: [a1], deposit: deposit(2), now, read }))).toEqual({
            kind: "assign",
            rows: [{ signature: "A1", outcome: "review", reason: "late_limit" }],
        });

        const first = expired({ transfers: [a1], deposit: deposit(1), now, read });
        const p = planDeposit(first);
        expect(p).toEqual({
            kind: "assign",
            rows: [{ signature: "A1", outcome: "return", reason: "late" }],
        });
        const back = moved(planDeposit(assigned(first, p)));
        expect(back.move).toMatchObject({
            kind: "return",
            amountMicros: 2_000,
            destination: "SrcA",
            closes: true,
            closeTo: "Stranger",
        });
        expect(back.lateReturn).toBe(true);
        expect(back.metered).toBe(true);
    });

    it("the free-move budget meters only metered moves", () => {
        const spent = { feeBudgetLeft: 0n };
        const a1 = A1({ outcome: "return", reason: "unpaid" });
        const b1 = B1({ amountMicros: 20_000, outcome: "return", reason: "unpaid" });

        const twoReturns = expired({ ...spent, transfers: [a1, b1], read: { micros: 50_000n } });
        expect(planDeposit(twoReturns)).toEqual(WAIT);

        const toFee = moved(
            planDeposit(expired({ ...spent, transfers: [a1], read: { micros: 30_000n } })),
        );
        expect(toFee.move).toMatchObject({ kind: "return", closes: true, closeTo: "Fee" });
        expect(toFee.metered).toBe(false);

        const toStranger = expired({
            ...spent,
            transfers: [a1],
            deposit: { rentPayer: "Stranger" },
            read: { micros: 30_000n },
        });
        expect(planDeposit(toStranger)).toEqual(WAIT);

        const create = input({
            ...spent,
            deposit: { readyAt: null },
            read: { exists: false },
            viewer: { seen: true, ipRented: 0, blockRented: 0 },
        });
        expect(moved(planDeposit(create)).move.kind).toBe("create");

        const close = expired({ ...spent, deposit: { stableSince: ago(3_000) } });
        expect(moved(planDeposit(close)).move).toMatchObject({ kind: "close", closeTo: "Fee" });

        const settle = input({
            ...spent,
            transfers: [A1({ amountMicros: 50_000 })],
            read: { micros: 50_000n },
        });
        expect(planDeposit(settle).kind).toBe("settle");

        const resweep = input({
            ...spent,
            order: { state: "settling" },
            deposit: { state: "settling", settledAt: at("00:04:50") },
            transfers: [A1({ amountMicros: 50_000, outcome: "paid", appliedMicros: 50_000 })],
            moves: [
                mv(1, "sweep", "failed", {
                    amountMicros: 50_000,
                    destination: RECIPIENT,
                    memo: ORDER_ID,
                }),
            ],
            read: { micros: 50_000n },
        });
        expect(moved(planDeposit(resweep)).move.kind).toBe("sweep");
    });

    it("per-owner return limit", () => {
        const o = (b1: TransferRow): PlanInput =>
            expired({
                ownerReturns: new Map([["OwnB", 6]]),
                deposit: { closeSeparately: true },
                transfers: [A1({ outcome: "return", reason: "unpaid" }), b1],
                read: { micros: 50_000n },
            });
        const b1 = B1({ amountMicros: 20_000, outcome: "return", reason: "unpaid" });
        const first = o(b1);
        const p = planDeposit(first);
        expect(moved(p).move).toMatchObject({ destination: "SrcA", payer: "OwnA" });
        expect(planDeposit(landed(first, p, 1, 20_000n))).toEqual(WAIT);

        // The limited owner's older money does not hold back another owner's return
        const older = moved(planDeposit(o({ ...b1, slot: 99n })));
        expect(older.move).toMatchObject({ destination: "SrcA", payer: "OwnA" });
    });

    it("one move at a time", () => {
        const p = planDeposit(
            input({
                transfers: [A1({ amountMicros: 50_000 })],
                moves: [mv(1, "create", "sent")],
                read: { micros: 50_000n },
            }),
        );
        expect(p).toEqual(WAIT);
    });

    it("a read below the ledger waits", () => {
        const p = planDeposit(
            input({
                transfers: [A1({ amountMicros: 50_000 })],
                read: { micros: 49_000n, invariant: "below" },
            }),
        );
        expect(p).toEqual(WAIT);
    });

    it("a read above the ledger may only settle", () => {
        const p = settled(
            planDeposit(
                input({
                    transfers: [A1({ amountMicros: 50_000 })],
                    read: { micros: 60_000n, invariant: "above" },
                }),
            ),
        );
        expect(p.closes).toBe(false);

        const returnDue = expired({
            transfers: [A1({ outcome: "return", reason: "unpaid" })],
            read: { micros: 60_000n, invariant: "above" },
        });
        expect(planDeposit(returnDue)).toEqual(WAIT);
    });
});

describe("planDeposit: the account", () => {
    it("closes an empty account once the order is done", () => {
        const p = planDeposit(expired({ deposit: { stableSince: ago(3_000) } }));
        expect(p).toEqual({
            kind: "move",
            move: {
                orderId: ORDER_ID,
                kind: "close",
                amountMicros: 0,
                keepMicros: 0,
                heldMicros: 0,
                destination: null,
                payer: null,
                memo: null,
                closes: true,
                closeTo: "Fee",
            },
            transfers: [],
            metered: false,
        });
    });

    it("no close while the creator is unknown", () => {
        expect(
            planDeposit(expired({ deposit: { stableSince: ago(3_000), rentPayer: null } })),
        ).toEqual(WAIT);

        const back = moved(
            planDeposit(
                expired({
                    deposit: { rentPayer: null },
                    transfers: [A1({ outcome: "return", reason: "unpaid" })],
                    read: { micros: 30_000n },
                }),
            ),
        );
        expect(back.move).toMatchObject({ kind: "return", closes: false, closeTo: null });

        const s = settled(
            planDeposit(
                input({
                    deposit: { rentPayer: null },
                    transfers: [A1({ amountMicros: 50_000 })],
                    read: { micros: 50_000n },
                }),
            ),
        );
        expect(s.closes).toBe(false);
    });

    it("closed when the account is gone", () => {
        expect(planDeposit(expired({ read: { exists: false } }))).toEqual({ kind: "closed" });
    });

    it("done after the watch window", () => {
        const p = planDeposit(
            expired({
                deposit: { state: "closed", watchUntil: at("00:00:00") },
                read: { exists: false },
            }),
        );
        expect(p).toEqual({ kind: "done" });
    });

    it("a closed deposit holding review money is not done until a close carries it", () => {
        const late = B1({
            amountMicros: 2_000,
            blockTime: at("00:20:00"),
            outcome: "review",
            reason: "late_limit",
        });
        const backingOff = expired({
            deposit: {
                state: "closed",
                rentPayer: "Stranger",
                stableSince: ago(3_000),
                watchUntil: ago(1_000),
                closeAfter: new Date(NOW.getTime() + 60_000),
            },
            transfers: [late],
            read: { micros: 2_000n },
        });
        expect(planDeposit(backingOff)).toEqual(WAIT);

        // Once the backoff ends, the close carries it to the float, and the deposit then finishes
        const due = { ...backingOff, deposit: { ...backingOff.deposit, closeAfter: null } };
        const close = moved(planDeposit(due));
        expect(close.move).toMatchObject({ kind: "close", heldMicros: 2_000, closeTo: "Stranger" });
        const gone = landed(due, close, 9, 0n);
        expect(planDeposit({ ...gone, read: { ...gone.read, exists: false } })).toEqual({
            kind: "done",
        });

        // Kept dust never holds a deposit open
        const dust = expired({
            deposit: { state: "closed", rentPayer: "Stranger", watchUntil: ago(1_000) },
            transfers: [{ ...late, amountMicros: 500, outcome: "keep", reason: "below_minimum" }],
            read: { micros: 500n },
        });
        expect(planDeposit(dust)).toEqual({ kind: "done" });
    });

    it("create only for a viewer under every cap", () => {
        const plan = (o: Over) =>
            planDeposit(
                input({
                    deposit: { readyAt: null },
                    read: { exists: false },
                    viewer: { seen: true, ipRented: 0, blockRented: 0 },
                    ...o,
                }),
            );
        expect(plan({})).toEqual({
            kind: "move",
            move: {
                orderId: ORDER_ID,
                kind: "create",
                amountMicros: 0,
                keepMicros: 0,
                heldMicros: 0,
                destination: null,
                payer: null,
                memo: null,
                closes: false,
                closeTo: null,
            },
            transfers: [],
            metered: false,
        });
        const viewer = (ipRented: number, blockRented: number) => ({
            viewer: { seen: true, ipRented, blockRented },
        });
        expect(moved(plan({ ...viewer(0, 1), rentHolding: 499 })).move.kind).toBe("create");
        expect(plan({ rentHolding: 500 })).toEqual(WAIT);
        expect(plan(viewer(1, 0))).toEqual(WAIT);
        expect(plan(viewer(0, 2))).toEqual(WAIT);
        expect(moved(plan({ unpaidCreateLeft: 15_800n })).move.kind).toBe("create");
        expect(plan({ unpaidCreateLeft: 15_799n })).toEqual(WAIT);
        expect(plan({ viewer: { seen: false, ipRented: 0, blockRented: 0 } })).toEqual(WAIT);
        expect(plan({ now: at("00:15:00") })).toEqual(WAIT);
        const failed = [1, 2, 3].map((id) => mv(id, "create", "failed"));
        expect(moved(plan({ moves: failed.slice(0, 2) })).move.kind).toBe("create");
        expect(plan({ moves: failed })).toEqual(WAIT);
    });

    it("an account a sender created is ready", () => {
        expect(planDeposit(input({ deposit: { readyAt: null } }))).toEqual({ kind: "ready" });
    });
});
