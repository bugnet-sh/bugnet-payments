import { getBase58Decoder } from "@solana/kit";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSettings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { newOrderId } from "../orders/ids.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedOrder } from "../testing/orders.ts";
import { DepositKeys, depositSeed32 } from "./keys.ts";
import { createAndCloseLamports } from "./plan.ts";
import {
    clearHolds,
    deletePendingMove,
    depositLedger,
    ensureDeposit,
    findDeposit,
    holdsOf,
    insertMove,
    insertShares,
    insertTransfers,
    insertWriteOff,
    lockDeposit,
    meteredLamports,
    moveCursor,
    ownerReturns,
    putHold,
    setTransferOutcomes,
    sharesOf,
    transfersChanged,
    unpaidCreateLamports,
    updateDeposit,
    watchedDeposits,
} from "./store.ts";
import type { NewMove, NewTransfer } from "./types.ts";
import { depositView } from "./view.ts";

const ORDER_A = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORDER_B = "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_A = "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley";
const TOKEN_A = "D2mAKdUVEHvizHThmG57bTCiASiiYj5gQbMeMoyWtQo1";
const ADDRESS_B = "Fvkkb7d7zpJZcyUsygPojncsHASt2VtQB6hLRTHKp4aB";
const SEED_7 = Buffer.alloc(32, 7);
const SALT = Buffer.alloc(16, 1);
const CREATED = new Date("2030-01-01T00:00:00Z");
const EXPIRES = new Date("2030-01-01T00:15:00Z");
const NOW = new Date("2030-01-01T00:05:00Z");
const RECIPIENT = "Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw";

const keys = new DepositKeys(new Map([[1, SEED_7]]), 1);
const salt = () => Buffer.from(SALT);

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

async function order(id = newOrderId(), over: Parameters<typeof seedOrder>[1] = {}) {
    const { order: o } = await seedOrder(db.pool, {
        id,
        amountMicros: 50_000,
        createdAt: CREATED,
        expiresAt: EXPIRES,
        ...over,
    });
    return o;
}

// A new order with its deposit, so a test never sees another test's rows
async function fresh() {
    const o = await order();
    const d = await ensureDeposit(db.pool, keys, o, NOW, () => Buffer.alloc(16, 3));
    return { order: o, deposit: d! };
}

function transfer(signature: string, over: Partial<NewTransfer> = {}): NewTransfer {
    return {
        orderId: ORDER_A,
        signature,
        slot: 100n,
        seq: 0,
        blockTime: new Date("2030-01-01T00:04:00Z"),
        seenAt: NOW,
        amountMicros: 30_000,
        sourceTokenAccount: "SrcA",
        sourceOwner: "OwnA",
        sourceBalanceMicros: 1_000_000n,
        ...over,
    };
}

function returnMove(orderId: string, over: Partial<NewMove> = {}): NewMove {
    return {
        orderId,
        kind: "return",
        amountMicros: 30_000,
        keepMicros: 0,
        heldMicros: 0,
        destination: "SrcA",
        payer: "OwnA",
        memo: null,
        closes: false,
        closeTo: null,
        ...over,
    };
}

const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => withTx(db.pool, fn);

async function moveIdOf(orderId: string, signature: string): Promise<string | null> {
    const { rows } = await db.pool.query<{ move_id: string | null }>(
        "select move_id from deposit_transfers where order_id = $1 and signature = $2",
        [orderId, signature],
    );
    return rows[0]!.move_id;
}

describe("ensureDeposit", () => {
    it("ensureDeposit is idempotent and stores only public data", async () => {
        const o = await order(ORDER_A);
        let draws = 0;
        const counted = () => {
            draws += 1;
            return salt();
        };
        const first = await ensureDeposit(db.pool, keys, o, NOW, counted);
        const second = await ensureDeposit(db.pool, keys, o, NOW, counted);
        expect(first).toMatchObject({
            orderId: ORDER_A,
            address: ADDRESS_A,
            tokenAccount: TOKEN_A,
            keyVersion: 1,
            salt: SALT,
            state: "open",
            balanceMicros: 0n,
            readyAt: null,
            createdAt: NOW,
        });
        expect(second).toEqual(first);
        expect(draws).toBe(1);

        const { rows } = await db.pool.query("select * from deposits where order_id = $1", [
            ORDER_A,
        ]);
        expect(rows).toHaveLength(1);
        const key = Buffer.from(depositSeed32(SEED_7, ORDER_A, SALT));
        const secrets = [key, SEED_7].flatMap((b) => [
            b.toString("hex"),
            b.toString("base64"),
            getBase58Decoder().decode(b),
        ]);
        for (const value of Object.values(rows[0] as Record<string, unknown>)) {
            if (Buffer.isBuffer(value)) expect([32, 64]).not.toContain(value.length);
            if (typeof value === "string") {
                for (const s of secrets) expect(value).not.toContain(s);
            }
        }
    });

    it("ensureDeposit refuses closed orders", async () => {
        const paid = await order(newOrderId(), { state: "paid" });
        expect(await ensureDeposit(db.pool, keys, paid, NOW, salt)).toBeNull();
        const unpaid = await order();
        expect(await ensureDeposit(db.pool, keys, unpaid, EXPIRES, salt)).toBeNull();
        const { rows } = await db.pool.query(
            "select 1 from deposits where order_id = any($1::text[])",
            [[paid.id, unpaid.id]],
        );
        expect(rows).toHaveLength(0);
    });

    it("two racing calls store one row", async () => {
        const o = await order();
        const [a, b] = await Promise.all([
            ensureDeposit(db.pool, keys, o, NOW, () => Buffer.alloc(16, 4)),
            ensureDeposit(db.pool, keys, o, NOW, () => Buffer.alloc(16, 5)),
        ]);
        expect(a).toEqual(b);
        expect(await findDeposit(db.pool, o.id)).toEqual(a);
    });
});

describe("transfers and the cursor", () => {
    it("insertTransfers is idempotent per order", async () => {
        const b = await order(ORDER_B);
        const depositB = await ensureDeposit(db.pool, keys, b, NOW, salt);
        expect(depositB?.address).toBe(ADDRESS_B);

        const t1 = transfer("t1");
        expect(await tx((c) => insertTransfers(c, ORDER_A, [t1]))).toBe(1);
        expect(await tx((c) => insertTransfers(c, ORDER_A, [t1]))).toBe(0);
        expect(await tx((c) => insertTransfers(c, ORDER_B, [{ ...t1, orderId: ORDER_B }]))).toBe(1);
        const { rows } = await db.pool.query<{ order_id: string }>(
            "select order_id from deposit_transfers where signature = 't1' order by order_id",
        );
        expect(rows.map((r) => r.order_id)).toEqual([ORDER_A, ORDER_B]);

        const ledger = await depositLedger(db.pool, ORDER_A);
        expect(ledger?.transfers).toEqual([
            {
                ...t1,
                outcome: "open",
                appliedMicros: 0,
                reason: null,
                blockedUntil: null,
                moveId: null,
                refundId: null,
                lostMicros: 0,
            },
        ]);
    });

    it("insertTransfers can record an unreadable transfer for review", async () => {
        const { order: o } = await fresh();
        const u = transfer("u1", {
            orderId: o.id,
            sourceTokenAccount: null,
            sourceOwner: null,
            sourceBalanceMicros: null,
        });
        await tx((c) =>
            insertTransfers(c, o.id, [{ ...u, outcome: "review", reason: "unreadable" }]),
        );
        const ledger = await depositLedger(db.pool, o.id);
        expect(ledger?.transfers[0]).toMatchObject({ outcome: "review", reason: "unreadable" });
    });

    it("moveCursor moves the cursor and the listing together", async () => {
        const { order: o } = await fresh();
        await tx((c) => moveCursor(c, o.id, null, { top: "s12", before: "s10" }));
        expect(await findDeposit(db.pool, o.id)).toMatchObject({
            lastSignature: null,
            scanSlot: null,
            scanTop: "s12",
            scanBefore: "s10",
        });
        await tx((c) =>
            moveCursor(c, o.id, { signature: "s9", slot: 9n }, { top: null, before: null }),
        );
        expect(await findDeposit(db.pool, o.id)).toMatchObject({
            lastSignature: "s9",
            scanSlot: 9n,
            scanTop: null,
            scanBefore: null,
        });
    });

    it("setTransferOutcomes writes only the fields it is given", async () => {
        const { order: o } = await fresh();
        await tx((c) =>
            insertTransfers(c, o.id, [
                transfer("A1", { orderId: o.id }),
                transfer("B1", { orderId: o.id, slot: 101n }),
            ]),
        );
        const until = new Date("2030-01-02T00:00:00Z");
        await tx((c) =>
            setTransferOutcomes(c, o.id, [
                { signature: "A1", outcome: "paid", reason: null, appliedMicros: 20_000 },
                {
                    signature: "B1",
                    outcome: "return",
                    reason: "payer_blocked",
                    blockedUntil: until,
                },
            ]),
        );
        const ledger = await depositLedger(db.pool, o.id);
        expect(
            ledger?.transfers.map((t) => [t.signature, t.outcome, t.reason, t.appliedMicros]),
        ).toEqual([
            ["A1", "paid", null, 20_000],
            ["B1", "return", "payer_blocked", 0],
        ]);
        expect(ledger?.transfers[1]?.blockedUntil).toEqual(until);
        await expect(
            tx((c) =>
                setTransferOutcomes(c, o.id, [
                    { signature: "nope", outcome: "keep", reason: "below_minimum" },
                ]),
            ),
        ).rejects.toThrow("no transfer nope");
    });
});

describe("moves", () => {
    it("insertMove sets move_id on the transfers it carries", async () => {
        const { order: o } = await fresh();
        await tx((c) => insertTransfers(c, o.id, [transfer("A1", { orderId: o.id })]));
        const m = await tx((c) => insertMove(c, returnMove(o.id), ["A1"], NOW));
        expect(m).toMatchObject({
            orderId: o.id,
            kind: "return",
            amountMicros: 30_000,
            destination: "SrcA",
            payer: "OwnA",
            state: "pending",
            txSignature: null,
            attempts: 0,
            previousSignatures: [],
            createdAt: NOW,
        });
        expect(await moveIdOf(o.id, "A1")).toBe(String(m.id));
        await expect(
            tx((c) => insertMove(c, returnMove(o.id), ["missing"], NOW)),
        ).rejects.toThrow();
    });

    it("deletePendingMove deletes only a never-signed row", async () => {
        const { order: o } = await fresh();
        await tx((c) => insertTransfers(c, o.id, [transfer("A1", { orderId: o.id })]));
        const pending = await tx((c) => insertMove(c, returnMove(o.id), ["A1"], NOW));
        expect(await tx((c) => deletePendingMove(c, pending.id))).toBe(true);
        expect(await moveIdOf(o.id, "A1")).toBeNull();
        const gone = await db.pool.query("select 1 from deposit_moves where id = $1", [pending.id]);
        expect(gone.rows).toHaveLength(0);

        const signed = await tx((c) => insertMove(c, returnMove(o.id), ["A1"], NOW));
        await db.pool.query(
            "update deposit_moves set state = 'signed', tx_signature = 'sig-signed' where id = $1",
            [signed.id],
        );
        expect(await tx((c) => deletePendingMove(c, signed.id))).toBe(false);
        expect(await moveIdOf(o.id, "A1")).toBe(String(signed.id));
        const kept = await db.pool.query("select 1 from deposit_moves where id = $1", [signed.id]);
        expect(kept.rows).toHaveLength(1);
    });
});

describe("the unpaid-create budget", () => {
    it("prices each create with its close as the planner does", async () => {
        const { order: o } = await fresh();
        // Later than any other test's moves, so only this create counts
        const since = new Date("2040-01-01T00:00:00Z");
        await db.pool.query(
            "insert into deposit_moves (order_id, kind, created_at) values ($1, 'create', $2)",
            [o.id, since],
        );
        const defaults = parseSettings(`[solana]\nrecipient = "${RECIPIENT}"`, "t.toml").deposits;
        expect(await unpaidCreateLamports(db.pool, since, defaults)).toBe(15_800n);
        const dear = { ...defaults, compute_unit_price_micro_lamports: 100_000 };
        expect(createAndCloseLamports(dear)).toBeGreaterThan(15_800n);
        expect(await unpaidCreateLamports(db.pool, since, dear)).toBe(createAndCloseLamports(dear));
    });
});

describe("deposit rows", () => {
    it("updateDeposit writes each field kind and lockDeposit reads it back", async () => {
        const { order: o } = await fresh();
        const at = new Date("2030-01-01T00:06:00Z");
        await updateDeposit(db.pool, o.id, {
            state: "settling",
            balanceMicros: 50_000n,
            checkedSlot: 1_234n,
            checkedAt: at,
            closeSeparately: true,
            closeFailures: 2,
            holdReason: "allowance_paused",
            readyAt: at,
            rentPayer: "Fee",
        });
        const locked = await tx((c) => lockDeposit(c, o.id));
        expect(locked).toMatchObject({
            state: "settling",
            balanceMicros: 50_000n,
            checkedSlot: 1_234n,
            checkedAt: at,
            closeSeparately: true,
            closeFailures: 2,
            holdReason: "allowance_paused",
            readyAt: at,
            rentPayer: "Fee",
        });
        await updateDeposit(db.pool, o.id, { holdReason: null, checkedSlot: null });
        expect(await findDeposit(db.pool, o.id)).toMatchObject({
            holdReason: null,
            checkedSlot: null,
            balanceMicros: 50_000n,
        });
        expect(await tx((c) => lockDeposit(c, "ord_nonexistent"))).toBeNull();
    });

    it("watchedDeposits leaves out done deposits and closed ones read recently", async () => {
        const { order: open } = await fresh();
        const { order: recent } = await fresh();
        const { order: due } = await fresh();
        const { order: ended } = await fresh();
        const { order: done } = await fresh();
        const later = new Date("2030-01-02T00:00:00Z");
        await updateDeposit(db.pool, recent.id, {
            state: "closed",
            checkedAt: new Date(NOW.getTime() - 60_000),
            watchUntil: later,
        });
        await updateDeposit(db.pool, due.id, {
            state: "closed",
            checkedAt: new Date(NOW.getTime() - 120_000),
            watchUntil: later,
        });
        await updateDeposit(db.pool, ended.id, {
            state: "closed",
            checkedAt: new Date(NOW.getTime() - 60_000),
            watchUntil: NOW,
        });
        await updateDeposit(db.pool, done.id, { state: "done" });
        // Past its watch and read since, as one still waiting for a close: the closed pace again
        const { order: waiting } = await fresh();
        await updateDeposit(db.pool, waiting.id, {
            state: "closed",
            checkedAt: new Date(NOW.getTime() - 60_000),
            watchUntil: new Date(NOW.getTime() - 90_000),
        });
        const ids = (await watchedDeposits(db.pool, NOW, 120_000)).map((d) => d.orderId);
        expect(ids).toEqual(expect.arrayContaining([open.id, due.id, ended.id]));
        expect(ids).not.toContain(recent.id);
        expect(ids).not.toContain(done.id);
        expect(ids).not.toContain(waiting.id);
        const afterPace = new Date(NOW.getTime() + 60_000);
        const later2 = (await watchedDeposits(db.pool, afterPace, 120_000)).map((d) => d.orderId);
        expect(later2).toContain(waiting.id);
    });

    it("putHold upserts per owner and clearHolds removes every hold", async () => {
        const { order: o } = await fresh();
        const since = NOW;
        await tx((c) =>
            putHold(c, {
                orderId: o.id,
                owner: "OwnA",
                reason: "payer_busy",
                recheckAt: new Date(NOW.getTime() + 10_000),
                since,
            }),
        );
        await tx((c) =>
            putHold(c, {
                orderId: o.id,
                owner: "OwnA",
                reason: "payer_rate_limited",
                recheckAt: new Date(NOW.getTime() + 20_000),
                since: new Date(NOW.getTime() + 10_000),
            }),
        );
        await tx((c) =>
            putHold(c, {
                orderId: o.id,
                owner: "",
                reason: "anonymous_busy",
                recheckAt: new Date(NOW.getTime() + 10_000),
                since,
            }),
        );
        expect(await holdsOf(db.pool, o.id)).toEqual([
            {
                orderId: o.id,
                owner: "",
                reason: "anonymous_busy",
                recheckAt: new Date(NOW.getTime() + 10_000),
                since,
            },
            {
                orderId: o.id,
                owner: "OwnA",
                reason: "payer_rate_limited",
                recheckAt: new Date(NOW.getTime() + 20_000),
                since,
            },
        ]);
        await tx((c) => clearHolds(c, o.id));
        expect(await holdsOf(db.pool, o.id)).toEqual([]);
    });

    it("insertShares and sharesOf keep the part order", async () => {
        const { order: o } = await fresh();
        await tx((c) =>
            insertShares(c, [
                {
                    orderId: o.id,
                    part: 1,
                    owner: "OwnB",
                    sourceTokenAccount: "SrcB",
                    appliedMicros: 20_000,
                },
                {
                    orderId: o.id,
                    part: 0,
                    owner: "OwnA",
                    sourceTokenAccount: "SrcA",
                    appliedMicros: 30_000,
                },
            ]),
        );
        expect(
            (await sharesOf(db.pool, o.id)).map((s) => [s.part, s.owner, s.appliedMicros]),
        ).toEqual([
            [0, "OwnA", 30_000],
            [1, "OwnB", 20_000],
        ]);
    });
});

describe("depositLedger and depositView", () => {
    const cfg = parseSettings(`[solana]\nrecipient = "${RECIPIENT}"`, "t.toml").deposits;

    it("the ledger holds rows in chain order and the deposit's own refunds", async () => {
        const { order: o } = await fresh();
        await tx((c) =>
            insertTransfers(c, o.id, [
                transfer("late", { orderId: o.id, slot: 120n }),
                transfer("first", { orderId: o.id, slot: 100n, seq: 1 }),
                transfer("zero", { orderId: o.id, slot: 100n, seq: 0 }),
            ]),
        );
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                part, deposit_signature, from_wallet)
             values ($1, 'deposit', 'deposit_held', 30000, 'SrcA', 'OwnA', 'sent', 0, 'zero', 'refund')`,
            [o.id],
        );
        const ledger = await depositLedger(db.pool, o.id);
        expect(ledger?.transfers.map((t) => t.signature)).toEqual(["zero", "first", "late"]);
        expect(ledger?.depositRefunds.map((r) => [r.kind, r.depositSignature])).toEqual([
            ["deposit", "zero"],
        ]);
        expect(await depositLedger(db.pool, "ord_nonexistent")).toBeNull();
    });

    it("the ledger holds each write-off, its parts and each transfer's lost money", async () => {
        const { order: o } = await fresh();
        await tx((c) =>
            insertTransfers(c, o.id, [
                transfer("A1", { orderId: o.id, slot: 100n }),
                transfer("B1", { orderId: o.id, slot: 101n }),
            ]),
        );
        const before = (await depositLedger(db.pool, o.id))!;
        expect(before.writeOffs).toEqual([]);
        expect(before.writeOffParts).toEqual([]);
        await tx((c) =>
            insertWriteOff(
                c,
                { orderId: o.id, signature: "theft2", slot: 140n, micros: 5_000, writtenAt: NOW },
                [{ transferSignature: "B1", micros: 5_000, refundId: null }],
            ),
        );
        await tx((c) =>
            insertWriteOff(
                c,
                { orderId: o.id, signature: "theft1", slot: 130n, micros: 12_000, writtenAt: NOW },
                [
                    { transferSignature: "B1", micros: 10_000, refundId: null },
                    { transferSignature: "A1", micros: 2_000, refundId: null },
                ],
            ),
        );
        const ledger = (await depositLedger(db.pool, o.id))!;
        expect(ledger.writeOffs).toEqual([
            { orderId: o.id, signature: "theft1", slot: 130n, micros: 12_000, writtenAt: NOW },
            { orderId: o.id, signature: "theft2", slot: 140n, micros: 5_000, writtenAt: NOW },
        ]);
        expect(
            ledger.writeOffParts.map((p) => [p.signature, p.transferSignature, p.micros]),
        ).toEqual([
            ["theft1", "A1", 2_000],
            ["theft1", "B1", 10_000],
            ["theft2", "B1", 5_000],
        ]);
        expect(ledger.transfers.map((t) => [t.signature, t.lostMicros])).toEqual([
            ["A1", 2_000],
            ["B1", 15_000],
        ]);
        // A plan read before the write-off is stale
        expect(await tx((c) => transfersChanged(c, o.id, before.transfers))).toBe(true);
        expect(await tx((c) => transfersChanged(c, o.id, ledger.transfers))).toBe(false);
    });

    it("depositView reads the ledger", async () => {
        const { order: o, deposit: d } = await fresh();
        await tx((c) => insertTransfers(c, o.id, [transfer("A1", { orderId: o.id })]));
        const v = await depositView(db.pool, o, NOW, cfg);
        expect(v).toMatchObject({
            address: d.address,
            status: "partial",
            receivedMicros: 30_000,
            remainingMicros: 20_000,
        });
    });

    it("depositView is null without a deposit or with an empty one of an order paid another way", async () => {
        const none = await order();
        expect(await depositView(db.pool, none, NOW, cfg)).toBeNull();
        const { order: o } = await fresh();
        await db.pool.query("update orders set state = 'paid' where id = $1", [o.id]);
        expect(await depositView(db.pool, { ...o, state: "paid" }, NOW, cfg)).toBeNull();
        await tx((c) => insertTransfers(c, o.id, [transfer("A1", { orderId: o.id })]));
        expect(await depositView(db.pool, { ...o, state: "paid" }, NOW, cfg)).toMatchObject({
            status: "refunding",
        });
    });
});

describe("indexes", () => {
    // Every order with a viewed page adds moves for good; these run on every tick and status poll
    it("the move ledger and the hourly windows never scan every move", async () => {
        const cfg = parseSettings(`[solana]\nrecipient = "${RECIPIENT}"`, "t.toml").deposits;
        const queries: { text: string; values: unknown[] }[] = [];
        const capture = {
            query: async (text: string, values: unknown[] = []) => {
                queries.push({ text, values });
                return { rows: text.includes("count(*)") ? [{ n: 0 }] : [], rowCount: 0 };
            },
        } as unknown as pg.Pool;
        const since = new Date(NOW.getTime() - 3_600_000);
        await meteredLamports(capture, since, "Fee", cfg);
        await ownerReturns(capture, since, "Fee");
        await unpaidCreateLamports(capture, since, cfg);
        const ledger = "select * from deposit_moves where order_id = $1 order by id";
        queries.push({ text: ledger, values: [ORDER_A] });
        await tx(async (c) => {
            await c.query("set local enable_seqscan = off");
            for (const q of queries) {
                const { rows } = await c.query<{ "QUERY PLAN": string }>(
                    `explain ${q.text}`,
                    q.values,
                );
                const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
                expect(plan, q.text).not.toContain("Seq Scan on deposit_moves");
            }
        });
    });
});
