import { randomBytes } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newOrderId } from "../orders/ids.ts";
import type { PaidVia } from "../orders/types.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { type Cursor, decodeCursor } from "./cursor.ts";
import { statsPayments, type StatsPaymentItem } from "./payments.ts";

const NOW = new Date("2030-01-31T12:00:00Z");
const DAY_MS = 86_400_000;

let db: TestDb;

beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await db.pool.query("truncate orders, events cascade");
});

const wallet = () => getBase58Decoder().decode(randomBytes(32));
const signature = () => getBase58Decoder().decode(randomBytes(64));
const ago = (ms: number) => new Date(NOW.getTime() - ms);

interface Paid {
    at: Date;
    kind?: "start" | "extend" | "allowance";
    amountMicros?: number;
    via?: PaidVia | null;
    payer?: string;
    tx?: string;
    status?: "confirmed" | "settling";
}

// Inserts orders with their payments in two statements, so a page's worth stays quick
async function paid(rows: Paid[]): Promise<{ id: string; payer: string; tx: string }[]> {
    const out = rows.map((r) => ({
        id: newOrderId(),
        kind: r.kind ?? "start",
        amount: r.amountMicros ?? 10_000,
        via: r.via ?? null,
        payer: r.payer ?? wallet(),
        tx: r.tx ?? signature(),
        status: r.status ?? "confirmed",
        at: r.at,
    }));
    const col = <K extends keyof (typeof out)[number]>(k: K) => out.map((r) => r[k]);
    await db.pool.query(
        `insert into orders (id, kind, package_id, amount_micros, handle_sha256, description,
            claim_sha256, state, expires_at, paid_via, pay_into, allowance_micros, fee_micros)
         select id, kind, 'pkg', amount, case when kind = 'start' then null else $5 end, 'd',
            '\\x00', 'paid', now(), via, case when kind = 'allowance' then 'allowance' else 'cold' end,
            case when kind = 'allowance' then amount - 1000 else 0 end,
            case when kind = 'allowance' then 1000 else 0 end
           from unnest($1::text[], $2::text[], $3::bigint[], $4::text[])
             as t(id, kind, amount, via)`,
        [col("id"), col("kind"), col("amount"), col("via"), "ab".repeat(32)],
    );
    await db.pool.query(
        `insert into payments (order_id, tx_signature, message_hash, payer, source_token_account,
            amount_micros, blockhash, last_valid_block_height, status, confirmed_at)
         select id, tx, md5(id), payer, 'src', amount, 'bh', 1, status,
            case when status = 'confirmed' then at end
           from unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[],
                $6::timestamptz[]) as t(id, tx, payer, amount, status, at)`,
        [col("id"), col("tx"), col("payer"), col("amount"), col("status"), col("at")],
    );
    return out;
}

async function refund(
    orderId: string,
    kind: "full" | "partial" | "allowance",
    at: Date,
    over: {
        payer?: string;
        from?: "refund" | "allowance";
        tx?: string;
        state?: string;
        amountMicros?: number;
    } = {},
): Promise<{ payer: string; tx: string }> {
    const payer = over.payer ?? wallet();
    const tx = over.tx ?? signature();
    await db.pool.query(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            tx_signature, confirmed_at, from_wallet)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
            orderId,
            kind,
            kind === "allowance" ? "x402_unspent" : "late",
            over.amountMicros ?? 5_000,
            // A token account, never shown
            wallet(),
            payer,
            over.state ?? "confirmed",
            tx,
            at,
            over.from ?? "refund",
        ],
    );
    return { payer, tx };
}

function shown(r: { payer: string; tx: string }): { wallet: string; tx: string } {
    return { wallet: r.payer, tx: r.tx };
}

async function allPages(): Promise<{ pages: StatsPaymentItem[][]; nexts: (string | null)[] }> {
    const pages: StatsPaymentItem[][] = [];
    const nexts: (string | null)[] = [];
    let before: Cursor | null = null;
    for (let i = 0; i < 20; i++) {
        const page = await statsPayments(db.pool, before, NOW);
        pages.push(page.items);
        nexts.push(page.next);
        if (page.next === null) break;
        before = decodeCursor(page.next);
        expect(before).not.toBeNull();
    }
    return { pages, nexts };
}

describe("statsPayments", () => {
    it("lists payments, refunds and returns newest first with their wallets and signatures", async () => {
        const [start, extend, allowance] = await paid([
            { at: ago(5_000), kind: "start", amountMicros: 50_000, via: "checkout" },
            { at: ago(4_000), kind: "extend", amountMicros: 20_000, via: "pay_cli" },
            { at: ago(3_000), kind: "allowance", amountMicros: 1_003_000 },
        ]);
        const back = await refund(start!.id, "full", ago(2_000), { amountMicros: 50_000 });
        const ret = await refund(allowance!.id, "allowance", ago(1_000), {
            amountMicros: 400_000,
            from: "allowance",
        });
        const page = await statsPayments(db.pool, null, NOW);
        expect(page).toEqual({
            items: [
                {
                    at: ago(1_000).toISOString(),
                    kind: "allowance_return",
                    amountMicros: 400_000,
                    wallet: ret.payer,
                    tx: ret.tx,
                },
                {
                    at: ago(2_000).toISOString(),
                    kind: "refund",
                    amountMicros: 50_000,
                    wallet: back.payer,
                    tx: back.tx,
                },
                {
                    at: ago(3_000).toISOString(),
                    kind: "x402_allowance",
                    amountMicros: 1_003_000,
                    wallet: allowance!.payer,
                    tx: allowance!.tx,
                },
                {
                    at: ago(4_000).toISOString(),
                    kind: "extend",
                    amountMicros: 20_000,
                    method: "pay_cli",
                    wallet: extend!.payer,
                    tx: extend!.tx,
                },
                {
                    at: ago(5_000).toISOString(),
                    kind: "sandbox",
                    amountMicros: 50_000,
                    method: "checkout",
                    wallet: start!.payer,
                    tx: start!.tx,
                },
            ],
            next: null,
        });
        expect(Object.keys(page.items[3]!)).toEqual([
            "at",
            "kind",
            "amountMicros",
            "method",
            "wallet",
            "tx",
        ]);
        expect(page.items[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    });

    it("names refunds by their kind whichever wallet paid them, one row per refund", async () => {
        const [cold, x402, allowance] = await paid([
            { at: ago(9_000), amountMicros: 50_000 },
            { at: ago(8_000), amountMicros: 1_063_000 },
            { at: ago(7_000), kind: "allowance" },
        ]);
        const partial = await refund(cold!.id, "partial", ago(3_000), {
            from: "allowance",
            amountMicros: 20_000,
        });
        const full = await refund(x402!.id, "full", ago(2_000), {
            from: "allowance",
            amountMicros: 1_063_000,
        });
        const ret = await refund(allowance!.id, "allowance", ago(1_000), {
            from: "allowance",
            amountMicros: 4_000,
        });
        const page = await statsPayments(db.pool, null, NOW);
        expect(page.items.slice(0, 3)).toEqual([
            {
                at: ago(1_000).toISOString(),
                kind: "allowance_return",
                amountMicros: 4_000,
                ...shown(ret),
            },
            {
                at: ago(2_000).toISOString(),
                kind: "refund",
                amountMicros: 1_063_000,
                ...shown(full),
            },
            {
                at: ago(3_000).toISOString(),
                kind: "refund",
                amountMicros: 20_000,
                ...shown(partial),
            },
        ]);
    });

    it("stats show each part with its wallet", async () => {
        const [order] = await paid([{ at: ago(9_000), amountMicros: 50_000 }]);
        const ownA = wallet();
        const ownB = wallet();
        const parts: { payer: string; tx: string }[] = [];
        for (const [part, payer, amount] of [
            [0, ownA, 30_000],
            [1, ownB, 20_000],
        ] as const) {
            const tx = signature();
            await db.pool.query(
                `insert into refunds (order_id, kind, part, reason, amount_micros, destination,
                    payer, state, tx_signature, confirmed_at)
                 values ($1, 'full', $2, 'late', $3, $4, $5, 'confirmed', $6, $7)`,
                [order!.id, part, amount, wallet(), payer, tx, ago(2_000)],
            );
            parts.push({ payer, tx });
        }
        await db.pool.query(
            `insert into refunds (order_id, kind, part, reason, amount_micros, destination, payer,
                state, tx_signature, confirmed_at, deposit_signature)
             values ($1, 'deposit', 0, 'deposit_held', 7000, $2, $3, 'confirmed', $4, $5, 'held')`,
            [order!.id, wallet(), wallet(), signature(), ago(1_000)],
        );
        const page = await statsPayments(db.pool, null, NOW);
        // Rows at one time come newest id first
        expect(page.items.filter((i) => i.kind === "refund")).toEqual([
            {
                at: ago(2_000).toISOString(),
                kind: "refund",
                amountMicros: 20_000,
                ...shown(parts[1]!),
            },
            {
                at: ago(2_000).toISOString(),
                kind: "refund",
                amountMicros: 30_000,
                ...shown(parts[0]!),
            },
        ]);
        expect(page.items).toHaveLength(3);
    });

    it("pages 51 rows into 50 with a cursor, then 1 with next null", async () => {
        await paid(Array.from({ length: 51 }, (_, i) => ({ at: ago((i + 1) * 60_000) })));
        const { pages, nexts } = await allPages();
        expect(pages.map((p) => p.length)).toEqual([50, 1]);
        expect(nexts[0]).toEqual(expect.any(String));
        expect(nexts[1]).toBeNull();
        expect(pages[1]![0]!.at).toBe(ago(51 * 60_000).toISOString());
    });

    it("answers next null on a page of exactly 50", async () => {
        await paid(Array.from({ length: 50 }, (_, i) => ({ at: ago((i + 1) * 1_000) })));
        const page = await statsPayments(db.pool, null, NOW);
        expect(page.items).toHaveLength(50);
        expect(page.next).toBeNull();
    });

    it("pages rows that tie on at without duplicates or gaps", async () => {
        const tie = ago(10_000);
        const rows = await paid([
            ...Array.from({ length: 70 }, () => ({ at: tie })),
            ...Array.from({ length: 30 }, () => ({ at: tie, kind: "extend" as const })),
        ]);
        const refunds = [];
        for (const r of rows.slice(0, 12)) refunds.push(await refund(r.id, "full", tie));
        // Microseconds apart, one millisecond on the page
        await db.pool.query(
            "update payments set confirmed_at = confirmed_at + interval '300 microseconds' where order_id = $1",
            [rows[0]!.id],
        );
        const { pages } = await allPages();
        expect(pages.map((p) => p.length)).toEqual([50, 50, 12]);
        const seen = pages.flat().map((i) => i.tx);
        expect(new Set(seen).size).toBe(112);
        expect(new Set(seen)).toEqual(
            new Set([...rows.map((r) => r.tx), ...refunds.map((r) => r.tx)]),
        );
        const kinds = pages.flat().map((i) => i.kind);
        expect(kinds).toEqual([...kinds].sort());
    });

    it("keeps the last 30 days only and nothing after now", async () => {
        const [inside] = await paid([
            { at: ago(30 * DAY_MS - 1) },
            { at: ago(30 * DAY_MS) },
            { at: ago(31 * DAY_MS) },
            { at: new Date(NOW.getTime() + 1) },
            { at: NOW },
        ]);
        const page = await statsPayments(db.pool, null, NOW);
        expect(page.items.map((i) => i.at)).toEqual([
            NOW.toISOString(),
            ago(30 * DAY_MS - 1).toISOString(),
        ]);
        expect(page.items[1]!.tx).toBe(inside!.tx);
    });

    it("leaves out unconfirmed payments and refunds", async () => {
        const [o] = await paid([{ at: ago(1_000), status: "settling" }]);
        await refund(o!.id, "full", ago(500), { state: "sent" });
        expect(await statsPayments(db.pool, null, NOW)).toEqual({ items: [], next: null });
    });

    it("skips rows whose wallet or signature is not canonical base58 of the right length", async () => {
        const good = await paid(Array.from({ length: 50 }, (_, i) => ({ at: ago(i * 1_000) })));
        const [bad] = await paid([
            { at: ago(500), payer: "payer-test" },
            { at: ago(600), tx: wallet() },
            { at: ago(700), payer: signature() },
        ]);
        await refund(bad!.id, "full", ago(800), { payer: "not a wallet" });
        await refund(bad!.id, "allowance", ago(900), { tx: "not-a-signature", from: "allowance" });
        const page = await statsPayments(db.pool, null, NOW);
        expect(page.items).toHaveLength(50);
        expect(page.next).toBeNull();
        expect(new Set(page.items.map((i) => i.tx))).toEqual(new Set(good.map((g) => g.tx)));
    });
});
