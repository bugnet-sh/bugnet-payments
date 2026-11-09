import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "../testing/db.ts";
import { memoryLog } from "../log.ts";
import { migrate } from "./migrate.ts";
import { createPool } from "./pool.ts";

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

const ORDER_A = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORDER_B = "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb";

async function insertOrder(
    id: string,
    kind = "start",
    handle: string | null = null,
    state = "unpaid",
) {
    await db.pool.query(
        `insert into orders (id, kind, package_id, amount_micros, handle_sha256, description,
            claim_sha256, state, expires_at)
         values ($1, $2, 'pkg', 1000, $3, 'd', '\\x00', $4, now() + interval '1 hour')`,
        [id, kind, handle, state],
    );
}

function insertPayment(orderId: string, sig: string, hash: string) {
    return db.pool.query(
        `insert into payments (order_id, tx_signature, message_hash, payer, source_token_account,
            amount_micros, blockhash, last_valid_block_height, status)
         values ($1, $2, $3, 'payer', 'src', 1000, 'bh', 10, 'settling')`,
        [orderId, sig, hash],
    );
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
    try {
        await p;
    } catch (err) {
        return (err as { code?: string }).code;
    }
    return undefined;
}

describe("schema", () => {
    it("migrates once", async () => {
        const fresh = await testDb();
        try {
            expect(await migrate(fresh.pool)).toBe(0);
            const r = await fresh.pool.query(
                "select version from schema_migrations order by version",
            );
            expect(r.rows).toEqual([
                { version: "00001_init.sql" },
                { version: "00002_payment_key.sql" },
                { version: "00003_x402.sql" },
                { version: "00004_paid_via.sql" },
            ]);
        } finally {
            await fresh.close();
        }
    });

    it("skips macOS ._ metadata files and anything not named NNNNN_name.sql", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "migrations-"));
        try {
            for (const f of await readdir("migrations")) {
                await copyFile(path.join("migrations", f), path.join(dir, f));
            }
            const appleDouble = Buffer.from([
                0, 5, 22, 7, 0, 2, 0, 0, 77, 97, 99, 32, 79, 83, 32, 88,
            ]);
            await writeFile(path.join(dir, "._00001_init.sql"), appleDouble);
            await writeFile(path.join(dir, "notes.sql"), "select broken from nowhere");
            expect(await migrate(db.pool, dir)).toBe(0);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("payments are unique by order, signature and message hash", async () => {
        await insertOrder(ORDER_A);
        await insertOrder(ORDER_B);
        await insertPayment(ORDER_A, "sig1", "hash1");
        expect(await codeOf(insertPayment(ORDER_A, "sig2", "hash2"))).toBe("23505");
        expect(await codeOf(insertPayment(ORDER_B, "sig1", "hash2"))).toBe("23505");
        expect(await codeOf(insertPayment(ORDER_B, "sig2", "hash1"))).toBe("23505");
        await insertPayment(ORDER_B, "sig2", "hash2");
    });

    it("refunds are unique by (order_id, kind)", async () => {
        const id = "ord_cccccccccccccccccccccccccc";
        await insertOrder(id);
        const insert = () =>
            db.pool.query(
                `insert into refunds (order_id, kind, reason, amount_micros, destination, payer,
                    state)
                 values ($1, 'full', 'late', 1000, 'dest', 'payer', 'pending')`,
                [id],
            );
        await insert();
        expect(await codeOf(insert())).toBe("23505");
    });

    it("events dedupe by event_id", async () => {
        const insert = () =>
            db.pool.query(
                `insert into events (event_id, type, created_at, payload)
                 values ('evt_1', 'x', now(), '{}') on conflict (event_id) do nothing`,
            );
        expect((await insert()).rowCount).toBe(1);
        expect((await insert()).rowCount).toBe(0);
    });

    it("orders take a null, checkout or pay_cli paid_via and nothing else", async () => {
        const id = "ord_eeeeeeeeeeeeeeeeeeeeeeeeee";
        await insertOrder(id);
        const set = (v: string | null) =>
            db.pool.query("update orders set paid_via = $2 where id = $1", [id, v]);
        const read = await db.pool.query("select paid_via from orders where id = $1", [id]);
        expect(read.rows).toEqual([{ paid_via: null }]);
        await set("checkout");
        await set("pay_cli");
        await set(null);
        expect(await codeOf(set("browser"))).toBe("23514");
    });

    it("orders reject an unknown state and an extend without handle", async () => {
        const base = "ord_dddddddddddddddddddddddddd";
        expect(await codeOf(insertOrder(base, "start", null, "paid_twice"))).toBe("23514");
        expect(await codeOf(insertOrder(base, "extend", null))).toBe("23514");
    });
});

describe("createPool", () => {
    it("logs idle client errors instead of throwing", async () => {
        const log = memoryLog();
        const pool = createPool("postgres://localhost:5432/postgres?sslmode=disable", log);
        expect(() => pool.emit("error", new Error("terminated"))).not.toThrow();
        expect(log.lines).toHaveLength(1);
        expect(log.lines[0]).toMatchObject({ level: "error", msg: "postgres idle client error" });
        await pool.end();
    });
});
