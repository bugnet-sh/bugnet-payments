import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newOrderId } from "../orders/ids.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { migrate } from "./migrate.ts";

const HANDLE = "ab".repeat(32);
const PAYTO = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const SERVICE = "xs_w5a4htopmpzmmhos";
const RESET = "drop schema public cascade; create schema public";
type Failure = { code?: string; constraint?: string } | null;

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
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

interface RawOrder {
    kind?: string;
    handle?: string | null;
    payInto?: string;
    allowance?: number;
    fee?: number;
    amount?: number;
}

async function rawOrder(o: RawOrder = {}): Promise<string> {
    const id = newOrderId();
    await db.pool.query(
        `insert into orders (id, kind, package_id, amount_micros, handle_sha256, description,
            claim_sha256, state, expires_at, pay_into, allowance_micros, fee_micros)
         values ($1, $2, 'cpu-small', $3, $4, 'd', '\\x00', 'unpaid', now() + interval '1 hour',
            $5, $6, $7)`,
        [
            id,
            o.kind ?? "start",
            o.amount ?? 10_000,
            o.handle ?? null,
            o.payInto ?? "cold",
            o.allowance ?? 0,
            o.fee ?? 0,
        ],
    );
    return id;
}

async function account(): Promise<string> {
    const id = await rawOrder();
    await db.pool.query(
        `insert into x402_accounts (id, package_id, spend_per_minute_micros)
         values ($1, 'cpu-small', 500000)`,
        [id],
    );
    return id;
}

describe("migration 00003", () => {
    it("applies 00003 and 00004 after 00001 and 00002", async () => {
        const fresh = await testDb();
        try {
            await fresh.pool.query(RESET);
            expect(await migrate(fresh.pool)).toBe(4);
            expect(await migrate(fresh.pool)).toBe(0);
        } finally {
            await fresh.close();
        }
    });

    it("upgrades a database that holds 00001 and 00002 rows", async () => {
        const fresh = await testDb();
        const dir = await mkdtemp(path.join(tmpdir(), "bn-mig-"));
        try {
            await fresh.pool.query(RESET);
            for (const f of ["00001_init.sql", "00002_payment_key.sql"]) {
                await copyFile(path.join("migrations", f), path.join(dir, f));
            }
            expect(await migrate(fresh.pool, dir)).toBe(2);
            const start = newOrderId();
            const extend = newOrderId();
            const insert = (id: string, kind: string, handle: string | null) =>
                fresh.pool.query(
                    `insert into orders (id, kind, package_id, amount_micros, handle_sha256,
                        description, claim_sha256, state, expires_at)
                     values ($1, $2, 'cpu-small', 10000, $3, 'd', '\\x00', 'unpaid',
                        now() + interval '1 hour')`,
                    [id, kind, handle],
                );
            await insert(start, "start", null);
            await insert(extend, "extend", HANDLE);
            await fresh.pool.query(
                `insert into refunds (order_id, kind, reason, amount_micros, destination, payer,
                    state)
                 values ($1, 'full', 'late', 10000, 'dest', 'payer', 'pending')`,
                [start],
            );
            expect(await migrate(fresh.pool)).toBe(2);
            const o = await fresh.pool.query(
                `select pay_into, allowance_micros::text, fee_micros::text, x402_setup,
                    hot_router_refund_micros::text from orders where id = $1`,
                [start],
            );
            expect(o.rows).toEqual([
                {
                    pay_into: "cold",
                    allowance_micros: "0",
                    fee_micros: "0",
                    x402_setup: null,
                    hot_router_refund_micros: "0",
                },
            ]);
            const e = await fresh.pool.query(
                "select allowance_micros::text, fee_micros::text from orders where id = $1",
                [extend],
            );
            expect(e.rows).toEqual([{ allowance_micros: "0", fee_micros: "0" }]);
            const r = await fresh.pool.query(
                "select from_wallet, budget_waived from refunds where order_id = $1",
                [start],
            );
            expect(r.rows).toEqual([{ from_wallet: "refund", budget_waived: false }]);
        } finally {
            await rm(dir, { recursive: true, force: true });
            await fresh.close();
        }
    });

    it.each<[string, RawOrder, string | null]>([
        ["start, cold", { amount: 10_000 }, null],
        [
            "start into the hot wallet",
            { payInto: "allowance", allowance: 1_000_000, fee: 3_000, amount: 1_013_000 },
            null,
        ],
        [
            "allowance with a handle",
            {
                kind: "allowance",
                handle: HANDLE,
                payInto: "allowance",
                allowance: 1_000_000,
                fee: 3_000,
                amount: 1_003_000,
            },
            null,
        ],
        [
            "allowance off by 1_000",
            {
                kind: "allowance",
                handle: HANDLE,
                payInto: "allowance",
                allowance: 1_000_000,
                fee: 3_000,
                amount: 1_004_000,
            },
            "orders_allowance_check",
        ],
        [
            "extend with allowance 1",
            { kind: "extend", handle: HANDLE, allowance: 1 },
            "orders_allowance_check",
        ],
        [
            "start into the hot wallet with allowance 0",
            { payInto: "allowance" },
            "orders_allowance_check",
        ],
        ["start with a fee and no allowance", { fee: 3_000 }, "orders_allowance_check"],
        [
            "allowance without a handle",
            {
                kind: "allowance",
                payInto: "allowance",
                allowance: 1_000_000,
                fee: 3_000,
                amount: 1_003_000,
            },
            "orders_handle_check",
        ],
        ["start with a handle", { handle: HANDLE }, "orders_handle_check"],
    ])("orders_allowance_check vectors: %s", async (_, o, constraint) => {
        expect(await failure(rawOrder(o))).toEqual(
            constraint === null ? null : { code: "23514", constraint },
        );
    });

    it("refund kinds and wallets", async () => {
        const id = await rawOrder();
        const refund = (kind: string, reason: string) =>
            db.pool.query(
                `insert into refunds (order_id, kind, reason, amount_micros, destination, payer,
                    state)
                 values ($1, $2, $3, 1000, 'dest', 'payer', 'pending') returning from_wallet`,
                [id, kind, reason],
            );
        expect(await failure(refund("allowance", "unredeemed"))).toEqual({
            code: "23514",
            constraint: "refunds_allowance_reason_check",
        });
        expect((await refund("allowance", "x402_unspent")).rows[0].from_wallet).toBe("refund");
        expect(await failure(refund("allowance", "x402_unspent"))).toEqual({
            code: "23505",
            constraint: "refunds_order_id_kind_key",
        });
    });

    it("one open incident per kind and subject", async () => {
        const open = () =>
            db.pool.query(
                `insert into x402_incidents (kind, subject, detail)
                 values ('balance_short', 'balance_short', '{}')`,
            );
        await open();
        expect(await failure(open())).toEqual({ code: "23505", constraint: "x402_incidents_open" });
        await db.pool.query("update x402_incidents set resolved_at = now()");
        expect(await failure(open())).toBeNull();
    });

    it("router event uniques", async () => {
        const start = await rawOrder();
        const allowance = () =>
            db.pool.query(
                `insert into x402_router_events (kind, start_order_id, order_id, phase, payload)
                 values ('allowance', $1, $1, 'paid', '{}')`,
                [start],
            );
        const resolved = () =>
            db.pool.query(
                `insert into x402_router_events (kind, start_order_id, ref, payload)
                 values ('x402_resolved', $1, 'abcdefghijklmnop', '{}')`,
                [start],
            );
        expect(await failure(allowance())).toBeNull();
        expect(await failure(allowance())).toMatchObject({ code: "23505" });
        expect(await failure(resolved())).toBeNull();
        expect(await failure(resolved())).toMatchObject({ code: "23505" });
    });

    it.each(["x402_pool", "x402_controls", "x402_tail"])("singletons: %s", async (table) => {
        expect((await db.pool.query(`select id from ${table}`)).rows).toEqual([{ id: 1 }]);
        expect(await failure(db.pool.query(`insert into ${table} (id) values (2)`))).toMatchObject({
            code: "23514",
        });
    });

    it("payment id and ref shapes", async () => {
        const accountId = await account();
        const pay = (id: string, ref: string) =>
            db.pool.query(
                `insert into x402_payments (id, ref, account_id, service_id, placement_id, method,
                    host, path, target_sha256, body_sha256, amount_micros, pay_to,
                    pay_to_token_account, fee_payer, listed, cap_day, state)
                 values ($1, $2, $3, $4, $5, 'POST', 'agent402.tools', '/v1/auto/x', '\\x00',
                    '\\x00', 10000, $6, $6, $6, 'indexed', '2026-11-07', 'reserved')`,
                [id, ref, accountId, SERVICE, randomUUID(), PAYTO],
            );
        expect(await failure(pay(`xp_${"a".repeat(26)}`, "abcdefghijklmnop"))).toBeNull();
        expect(await failure(pay("xp_short", "abcdefghijklmnoq"))).toMatchObject({
            code: "23514",
        });
        expect(await failure(pay(`xp_${"b".repeat(26)}`, "ABCDEFGHIJKLMNOP"))).toMatchObject({
            code: "23514",
        });
    });

    it("services paid_path matches listed", async () => {
        const accountId = await account();
        const orderId = await rawOrder();
        const service = (listed: string, paidPath: string | null) =>
            db.pool.query(
                `insert into x402_services (account_id, service_id, method, host, prefix, url,
                    max_price_micros, pay_to, listed, paid_path, pinned_from, probe, order_id)
                 values ($1, $2, 'GET', 'agent402.tools', '/v1', 'https://agent402.tools/v1', 10000,
                    $3, $4, $5, 'probe', '{}', $6)`,
                [accountId, SERVICE, PAYTO, listed, paidPath, orderId],
            );
        expect(await failure(service("indexed", "/x"))).toMatchObject({ code: "23514" });
        expect(await failure(service("unlisted", null))).toMatchObject({ code: "23514" });
        expect(await failure(service("unlisted", "/x"))).toBeNull();
    });

    it("funding fee below allowance", async () => {
        const accountId = await account();
        const orderId = await rawOrder();
        expect(
            await failure(
                db.pool.query(
                    `insert into x402_fundings (order_id, account_id, allowance_micros,
                        fee_credited_micros, payer, source_token_account)
                     values ($1, $2, 3000, 3000, $3, $3)`,
                    [orderId, accountId, PAYTO],
                ),
            ),
        ).toMatchObject({ code: "23514" });
    });

    it("account totals", async () => {
        const id = await rawOrder();
        expect(
            await failure(
                db.pool.query(
                    `insert into x402_accounts (id, package_id, spend_per_minute_micros,
                        spent_micros, funded_micros)
                     values ($1, 'cpu-small', 500000, 1, 0)`,
                    [id],
                ),
            ),
        ).toMatchObject({ code: "23514" });
    });
});
