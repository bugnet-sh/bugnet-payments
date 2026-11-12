import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newOrderId } from "../orders/ids.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import { testDb, type TestDb } from "../testing/db.ts";

const ORDER_A = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORDER_B = "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_A = "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley";
const TOKEN_A = "D2mAKdUVEHvizHThmG57bTCiASiiYj5gQbMeMoyWtQo1";
const ADDRESS_B = "Fvkkb7d7zpJZcyUsygPojncsHASt2VtQB6hLRTHKp4aB";
const SALT = Buffer.alloc(16, 1);
const CREATED = new Date("2030-01-01T00:00:00Z");
const EXPIRES = new Date("2030-01-01T00:15:00Z");
const OWN_A = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const OWN_B = "3".repeat(44);
const SIG = "5".repeat(88);

type Failure = { code?: string; constraint?: string } | null;

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
    await order(ORDER_A);
    await order(ORDER_B);
    await deposit(ORDER_A, { address: ADDRESS_A, tokenAccount: TOKEN_A });
    await deposit(ORDER_B, { address: ADDRESS_B });
});
afterAll(async () => {
    await db.close();
});

async function failure(p: Promise<unknown>): Promise<Failure> {
    try {
        await p;
        return null;
    } catch (err) {
        const e = err as { code?: string; constraint?: string };
        return { code: e.code, constraint: e.constraint };
    }
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
    return (await failure(p))?.code;
}

async function order(id = newOrderId()): Promise<string> {
    await seedOrder(db.pool, { id, amountMicros: 50_000, createdAt: CREATED, expiresAt: EXPIRES });
    return id;
}

const unique = (): string => randomBytes(16).toString("hex");

function deposit(
    orderId: string,
    over: { address?: string; tokenAccount?: string; salt?: Buffer } = {},
) {
    return db.pool.query(
        `insert into deposits (order_id, address, token_account, key_version, salt, created_at)
         values ($1, $2, $3, 1, $4, $5)`,
        [
            orderId,
            over.address ?? unique(),
            over.tokenAccount ?? unique(),
            over.salt ?? SALT,
            CREATED,
        ],
    );
}

// A new order with its deposit, so a test never sees another test's rows
async function freshDeposit(): Promise<string> {
    const id = await order();
    await deposit(id);
    return id;
}

interface Move {
    kind?: string;
    amount?: number;
    keep?: number;
    held?: number;
    payer?: string | null;
    closes?: boolean;
    state?: string;
    landedSlot?: number | null;
}

function move(orderId: string, m: Move = {}) {
    const kind = m.kind ?? "create";
    return db.pool.query(
        `insert into deposit_moves (order_id, kind, amount_micros, keep_micros, held_micros, payer,
            closes, state, landed_slot, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
            orderId,
            kind,
            m.amount ?? (kind === "sweep" || kind === "return" ? 1_000 : 0),
            m.keep ?? 0,
            m.held ?? 0,
            m.payer === undefined ? (kind === "return" ? OWN_A : null) : m.payer,
            m.closes ?? false,
            m.state ?? "confirmed",
            m.landedSlot ?? null,
            CREATED,
        ],
    );
}

function transfer(orderId: string, signature: string, blockTime: Date | null = CREATED) {
    return db.pool.query(
        `insert into deposit_transfers (order_id, signature, slot, seq, block_time, seen_at,
            amount_micros)
         values ($1, $2, 100, 0, $3, $4, 10000)`,
        [orderId, signature, blockTime, CREATED],
    );
}

function hold(orderId: string, owner: string, reason: string) {
    return db.pool.query(
        `insert into deposit_holds (order_id, owner, reason, recheck_at, since)
         values ($1, $2, $3, $4, $4)`,
        [orderId, owner, reason, CREATED],
    );
}

interface Refund {
    kind?: string;
    reason?: string;
    part?: number;
    depositSignature?: string | null;
    fromWallet?: string;
}

function refund(orderId: string, r: Refund = {}) {
    return db.pool.query(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            part, deposit_signature, from_wallet)
         values ($1, $2, $3, 1000, 'dest', 'payer', 'pending', $4, $5, $6)`,
        [
            orderId,
            r.kind ?? "full",
            r.reason ?? "late",
            r.part ?? 0,
            r.depositSignature ?? null,
            r.fromWallet ?? "refund",
        ],
    );
}

const depositRefund = (over: Refund = {}): Refund => ({
    kind: "deposit",
    reason: "deposit_held",
    depositSignature: SIG,
    ...over,
});

function share(orderId: string, part: number, owner: string) {
    return db.pool.query(
        `insert into payment_shares (order_id, part, owner, source_token_account, applied_micros)
         values ($1, $2, $3, 'src', 25000)`,
        [orderId, part, owner],
    );
}

async function count(table: string, where: string, params: unknown[]): Promise<number> {
    const r = await db.pool.query<{ n: number }>(
        `select count(*)::int as n from ${table} where ${where}`,
        params,
    );
    return r.rows[0]!.n;
}

describe("migration 00005", () => {
    it("paid_via accepts transfer and refuses others", async () => {
        const id = await order();
        const set = (v: string) =>
            db.pool.query("update orders set paid_via = $2 where id = $1", [id, v]);
        await set("transfer");
        expect(await code(set("wire"))).toBe("23514");
    });

    it("payments flags default", async () => {
        const id = await order();
        await seedPayment(db.pool, id);
        const r = await db.pool.query(
            "select payer_counted, multi_sender from payments where order_id = $1",
            [id],
        );
        expect(r.rows).toEqual([{ payer_counted: true, multi_sender: false }]);
    });

    it("a second in-flight move for one deposit is refused", async () => {
        const id = await freshDeposit();
        await move(id, { state: "pending" });
        expect(await failure(move(id, { state: "pending" }))).toEqual({
            code: "23505",
            constraint: "deposit_moves_one_in_flight",
        });

        const other = await freshDeposit();
        await move(other, { state: "confirmed" });
        await move(other, { state: "pending" });
        expect(await count("deposit_moves", "order_id = $1", [other])).toBe(2);
    });

    it("move amount checks", async () => {
        const id = await freshDeposit();
        expect(await code(move(id, { kind: "sweep", amount: 0 }))).toBe("23514");
        await move(id, { kind: "close", amount: 0 });
        expect(await code(move(id, { kind: "return", payer: null }))).toBe("23514");
        await move(id, { kind: "close", keep: 500, closes: true });
        expect(await code(move(id, { kind: "sweep", keep: 500, closes: true }))).toBe("23514");
        expect(await code(move(id, { kind: "return", held: 7_000, closes: false }))).toBe("23514");
    });

    it("a failed move cannot hold a landing slot", async () => {
        const id = await freshDeposit();
        expect(await code(move(id, { state: "failed", landedSlot: 5 }))).toBe("23514");
    });

    it("one signature for two deposits stores two rows", async () => {
        const sig = "4".repeat(88);
        await transfer(ORDER_A, sig);
        await transfer(ORDER_B, sig);
        expect(await count("deposit_transfers", "signature = $1", [sig])).toBe(2);
        expect(await code(transfer(ORDER_A, sig))).toBe("23505");
    });

    it("deposit address is unique", async () => {
        const id = await order();
        expect(await code(deposit(id, { address: ADDRESS_A }))).toBe("23505");
    });

    it("salt is 16 bytes", async () => {
        const id = await order();
        expect(await code(deposit(id, { salt: Buffer.alloc(15, 1) }))).toBe("23514");
    });

    it("review_reason takes only ledger faults", async () => {
        const id = await freshDeposit();
        const set = (v: string) =>
            db.pool.query("update deposits set review_reason = $2 where order_id = $1", [id, v]);
        await set("unknown_debit");
        expect(await code(set("guard_short"))).toBe("23514");
    });

    it("hold_reason takes only deposit-wide holds", async () => {
        const id = await freshDeposit();
        const set = (v: string) =>
            db.pool.query("update deposits set hold_reason = $2 where order_id = $1", [id, v]);
        await set("allowance_paused");
        expect(await code(set("payer_busy"))).toBe("23514");
    });

    it("deposit holds are one per owner", async () => {
        const id = await freshDeposit();
        await hold(id, OWN_A, "payer_busy");
        expect(await code(hold(id, OWN_A, "payer_busy"))).toBe("23505");
        await hold(id, "", "anonymous_busy");

        const other = await freshDeposit();
        expect(await code(hold(other, OWN_B, "pool"))).toBe("23514");
        expect(await code(hold(other, OWN_B, "owner_limited"))).toBe("23514");
        expect(await code(hold(other, OWN_A, "anonymous_busy"))).toBe("23514");
        expect(await code(hold(other, "", "payer_busy"))).toBe("23514");
    });

    it("a transfer needs a block time", async () => {
        const id = await freshDeposit();
        expect(await code(transfer(id, "3".repeat(88), null))).toBe("23502");
    });

    it("payments counted and split flags agree", async () => {
        const id = await order();
        await seedPayment(db.pool, id);
        const set = (counted: boolean, multi: boolean, min: number | null) =>
            db.pool.query(
                `update payments set payer_counted = $2, multi_sender = $3, split_min_micros = $4
                  where order_id = $1`,
                [id, counted, multi, min],
            );
        expect(await failure(set(false, false, null))).toEqual({
            code: "23514",
            constraint: "payments_split_check",
        });
        expect(await code(set(true, true, 1_000))).toBe("23514");
        expect(await code(set(false, true, null))).toBe("23514");
        await set(false, true, 1_000);
        const r = await db.pool.query(
            `select payer_counted, multi_sender, split_min_micros::text as min
               from payments where order_id = $1`,
            [id],
        );
        expect(r.rows).toEqual([{ payer_counted: false, multi_sender: true, min: "1000" }]);
    });

    it("refunds take one row per part", async () => {
        const id = await order();
        await refund(id, { part: 0 });
        await refund(id, { part: 1 });
        expect(await failure(refund(id, { part: 0 }))).toEqual({
            code: "23505",
            constraint: "refunds_order_kind_part",
        });
    });

    it("a deposit refund row needs its signature and the float", async () => {
        const id = await order();
        const refused = { code: "23514", constraint: "refunds_deposit_check" };
        expect(await failure(refund(id, depositRefund({ depositSignature: null })))).toEqual(
            refused,
        );
        expect(await failure(refund(id, depositRefund({ reason: "operator" })))).toEqual(refused);
        expect(await failure(refund(id, depositRefund({ fromWallet: "allowance" })))).toEqual(
            refused,
        );
        await refund(id, depositRefund({ fromWallet: "refund" }));
        expect(await count("refunds", "order_id = $1 and kind = 'deposit'", [id])).toBe(1);
    });

    it("a held transfer gets one deposit refund row", async () => {
        const id = await order();
        await refund(id, depositRefund({ part: 0 }));
        expect(await failure(refund(id, depositRefund({ part: 1 })))).toEqual({
            code: "23505",
            constraint: "refunds_deposit_once",
        });
    });

    it("payment shares", async () => {
        const id = await order();
        await share(id, 0, OWN_A);
        expect(await code(share(id, 1, OWN_A))).toBe("23505");
        await share(id, 1, OWN_B);
        expect(await count("payment_shares", "order_id = $1", [id])).toBe(2);
    });
});

describe("migration 00007", () => {
    const THEFT = "6".repeat(88);
    const SECOND = "7".repeat(88);

    function writeOff(orderId: string, signature = THEFT, micros = 4_000) {
        return db.pool.query(
            `insert into deposit_write_offs (order_id, signature, slot, micros, written_at)
             values ($1, $2, 200, $3, $4)`,
            [orderId, signature, micros, CREATED],
        );
    }

    function part(
        orderId: string,
        transferSignature: string,
        o: {
            signature?: string;
            micros?: number;
            refundId?: number | null;
            keptReason?: string | null;
        } = {},
    ) {
        return db.pool.query(
            `insert into deposit_write_off_parts (order_id, signature, transfer_signature, micros,
                refund_id, kept_reason)
             values ($1, $2, $3, $4, $5, $6)`,
            [
                orderId,
                o.signature ?? THEFT,
                transferSignature,
                o.micros ?? 4_000,
                o.refundId ?? null,
                o.keptReason ?? null,
            ],
        );
    }

    it("a write-off row and its parts", async () => {
        const id = await freshDeposit();
        const sig = "8".repeat(88);
        await transfer(id, sig);
        expect(await code(writeOff(id, THEFT, 0))).toBe("23514");
        await writeOff(id);
        expect(await code(writeOff(id))).toBe("23505");
        // A part names a write-off and a transfer of the same deposit
        expect(await code(part(id, sig, { signature: SECOND }))).toBe("23503");
        expect(await code(part(id, "9".repeat(88)))).toBe("23503");
        expect(await code(part(id, sig, { micros: 0 }))).toBe("23514");
        await part(id, sig);
        expect(await code(part(id, sig))).toBe("23505");
        expect(await code(writeOff("ord_unknownunknownunknownunk"))).toBe("23503");
    });

    it("a part Bugnet keeps names why, and a kept part has no refund row", async () => {
        const id = await freshDeposit();
        const sigs = ["a", "b", "c", "d"].map((x) => x.repeat(88));
        for (const sig of sigs) await transfer(id, sig);
        await writeOff(id);
        await part(id, sigs[0]!, { keptReason: "bugnet_own" });
        await part(id, sigs[1]!, { keptReason: "below_refund_min" });
        expect(await failure(part(id, sigs[2]!, { keptReason: "dust" }))).toEqual({
            code: "23514",
            constraint: "deposit_write_off_parts_kept_reason_check",
        });
        const r = await db.pool.query<{ id: string }>(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                part, deposit_signature, from_wallet)
             values ($1, 'deposit', 'deposit_write_off', 1000, 'dest', 'payer', 'pending', 0, $2,
                'refund')
             returning id`,
            [id, sigs[3]],
        );
        const refundId = Number(r.rows[0]!.id);
        expect(await failure(part(id, sigs[3]!, { refundId, keptReason: "bugnet_own" }))).toEqual({
            code: "23514",
            constraint: "deposit_write_off_parts_kept_check",
        });
        await part(id, sigs[3]!, { refundId });
    });

    it("one theft transaction gives one row per deposit", async () => {
        const a = await freshDeposit();
        const b = await freshDeposit();
        await writeOff(a, SECOND);
        await writeOff(b, SECOND);
        expect(await count("deposit_write_offs", "signature = $1", [SECOND])).toBe(2);
    });

    it("a deposit refund row returns held money or a written-off part", async () => {
        const id = await order();
        await refund(id, depositRefund({ part: 0 }));
        await refund(id, depositRefund({ part: 1, reason: "deposit_write_off" }));
        expect(
            await failure(refund(id, depositRefund({ part: 2, reason: "deposit_write_off" }))),
        ).toEqual({ code: "23505", constraint: "refunds_deposit_once" });
        expect(await failure(refund(id, { kind: "full", reason: "deposit_write_off" }))).toEqual({
            code: "23514",
            constraint: "refunds_deposit_check",
        });
        expect(
            await failure(
                refund(
                    id,
                    depositRefund({
                        part: 3,
                        reason: "deposit_write_off",
                        fromWallet: "allowance",
                    }),
                ),
            ),
        ).toEqual({ code: "23514", constraint: "refunds_deposit_check" });
    });

    it("a written-off payment is archived with its reason", async () => {
        const id = await order();
        const archive = (reason: string) =>
            db.pool.query(
                `insert into failed_payments (order_id, tx_signature, message_hash, payer,
                    amount_micros, reason)
                 values ($1, 'sig', 'hash', 'payer', 50000, $2)`,
                [id, reason],
            );
        await archive("written_off");
        expect(await code(archive("stolen"))).toBe("23514");
    });
});
