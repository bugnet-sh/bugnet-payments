import { randomBytes } from "node:crypto";
import { address, getBase58Decoder, type Address } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { memoryLog } from "../log.ts";
import { setPaymentLandedSlot } from "../orders/store.ts";
import { usdcAta } from "../solana/accounts.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { startFakeChain, type FakeChain } from "../testing/fake-chain.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import {
    landPayment,
    resetLedger,
    seedAccount,
    seedFunding,
    seedX402Payment,
    TEST_PAYTO,
} from "../testing/x402.ts";
import { auditX402, hotFeeLamports } from "./audit.ts";
import { advanceVerified, openTail } from "./tail.ts";
import type { SolanaRpc } from "../solana/rpc.ts";

const t0 = new Date("2030-01-01T12:00:00Z");
const SIG = () => getBase58Decoder().decode(randomBytes(64));

let db: TestDb;
let HOT: Address;
let x402: Settings["x402"];
let defaults: Settings;
let chain: FakeChain | null = null;

const deps = (rpc: SolanaRpc, log = memoryLog()) => ({
    pool: db.pool,
    rpc,
    hotTokenAccount: HOT,
    x402,
    rpcTimeoutMs: 10_000,
    log,
    now: () => t0,
});
const alarms = (log: ReturnType<typeof memoryLog>, name: string) =>
    log.lines.filter((l) => l.level === "alarm" && l.alarm === name);

beforeAll(async () => {
    db = await testDb();
    HOT = await usdcAta((await testSigner(11)).address);
    defaults = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t");
    x402 = defaults.x402;
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await resetLedger(db.pool);
    await db.pool.query(
        "truncate x402_cold_transfers, x402_chain_txs, x402_incidents, audit_checkpoints cascade",
    );
    await db.pool.query(
        `update x402_tail set token_account = null, opening_balance_micros = 0, opening_slot = 0,
            opened_at = null, verified_slot = 0, verified_at = null where id = 1`,
    );
});
afterEach(async () => {
    await chain?.close();
    chain = null;
});

describe("hotFeeLamports", () => {
    it("with today's values is 10_200n", () => {
        expect(
            hotFeeLamports({
                ...defaults.refunds,
                compute_unit_limit: 20_000,
                compute_unit_price_micro_lamports: 10_000,
            }),
        ).toBe(10_200n);
    });

    it("rounds the priority fee up to a whole lamport", () => {
        expect(
            hotFeeLamports({
                ...defaults.refunds,
                compute_unit_limit: 1,
                compute_unit_price_micro_lamports: 1,
            }),
        ).toBe(10_001n);
    });
});

describe("auditX402 rows on chain", () => {
    it("a confirmed payment missing on chain raises x402_audit_mismatch", async () => {
        await openTail(db.pool, HOT, 0n, 100n, new Date(t0.getTime() - 86_400_000));
        await advanceVerified(db.pool, 1_000n, t0);
        const a = await seedAccount(db.pool, {});
        const p = await seedX402Payment(db.pool, {
            accountId: a.id,
            state: "confirmed",
            txSignature: SIG(),
            landedSlot: 500n,
        });
        const log = memoryLog();
        const r = await auditX402(deps(createFakeRpc({ getTransaction: () => null }), log));
        expect(r.checked).toBe(1);
        expect(r.mismatches).toContain(`payment ${p.id}`);
        expect(alarms(log, "x402_audit_mismatch").some((l) => l.id === p.id)).toBe(true);
    });

    it("a confirmed payment found on chain with its amount and payee passes", async () => {
        chain = await startFakeChain({ autoFinalize: true });
        const payToAta = await usdcAta(address(TEST_PAYTO));
        chain.setTokenAccount({
            address: HOT,
            owner: (await testSigner(11)).address,
            amount: 50_000n,
        });
        chain.setTokenAccount({ address: payToAta, owner: TEST_PAYTO, amount: 0n });
        await openTail(db.pool, HOT, 50_000n, chain.slot(), new Date(t0.getTime() - 86_400_000));
        chain.advance(1);
        const landed = await landPayment(chain, db.pool, { amount: 10_000n });
        chain.finalize();
        const slot = chain.submitted().find((s) => s.signature === landed.txSignature)!.slot;
        await advanceVerified(db.pool, slot + 1n, t0);
        const a = await seedAccount(db.pool, {});
        await seedX402Payment(db.pool, {
            accountId: a.id,
            state: "confirmed",
            amountMicros: 10_000,
            txSignature: landed.txSignature,
            landedSlot: slot,
            payToTokenAccount: payToAta,
        });
        const r = await auditX402(deps(chain.rpc));
        expect(r.checked).toBe(1);
        expect(r.mismatches.filter((m) => m.startsWith("payment"))).toEqual([]);
    });

    it("a payment whose chain amount differs from the row mismatches", async () => {
        chain = await startFakeChain({ autoFinalize: true });
        const payToAta = await usdcAta(address(TEST_PAYTO));
        chain.setTokenAccount({
            address: HOT,
            owner: (await testSigner(11)).address,
            amount: 50_000n,
        });
        chain.setTokenAccount({ address: payToAta, owner: TEST_PAYTO, amount: 0n });
        await openTail(db.pool, HOT, 50_000n, chain.slot(), new Date(t0.getTime() - 86_400_000));
        chain.advance(1);
        const landed = await landPayment(chain, db.pool, { amount: 10_000n });
        chain.finalize();
        const slot = chain.submitted().find((s) => s.signature === landed.txSignature)!.slot;
        await advanceVerified(db.pool, slot + 1n, t0);
        const a = await seedAccount(db.pool, {});
        const p = await seedX402Payment(db.pool, {
            accountId: a.id,
            state: "confirmed",
            amountMicros: 20_000,
            txSignature: landed.txSignature,
            landedSlot: slot,
            payToTokenAccount: payToAta,
        });
        const r = await auditX402(deps(chain.rpc));
        expect(r.mismatches).toContain(`payment ${p.id}`);
    });

    it("checks a row once: the checkpoint holds the audited verified slot", async () => {
        await openTail(db.pool, HOT, 0n, 100n, new Date(t0.getTime() - 86_400_000));
        await advanceVerified(db.pool, 1_000n, t0);
        const a = await seedAccount(db.pool, {});
        await seedX402Payment(db.pool, {
            accountId: a.id,
            txSignature: SIG(),
            landedSlot: 500n,
        });
        const rpc = createFakeRpc({ getTransaction: () => null });
        expect((await auditX402(deps(rpc))).checked).toBe(1);
        expect((await auditX402(deps(rpc))).checked).toBe(0);
        const cp = await db.pool.query(
            "select signature from audit_checkpoints where name = 'x402_audit'",
        );
        expect(cp.rows[0].signature).toBe("1000");
    });

    it("after a key switch reopens the tail, rows below the new opening slot are not audited", async () => {
        await openTail(db.pool, HOT, 0n, 100n, new Date(t0.getTime() - 86_400_000));
        await advanceVerified(db.pool, 300n, t0);
        await auditX402(deps(createFakeRpc({ getTransaction: () => null })));
        const a = await seedAccount(db.pool, {});
        await seedX402Payment(db.pool, { accountId: a.id, txSignature: SIG(), landedSlot: 400n });
        await openTail(db.pool, HOT, 0n, 800n, new Date(t0.getTime() - 3_600_000));
        await advanceVerified(db.pool, 1_000n, t0);
        const r = await auditX402(deps(createFakeRpc({ getTransaction: () => null })));
        expect(r.checked).toBe(0);
        expect(r.mismatches).toEqual([]);
    });

    it("a row confirmed late is audited the next night and no row is audited twice", async () => {
        await openTail(db.pool, HOT, 0n, 100n, new Date(t0.getTime() - 86_400_000));
        await advanceVerified(db.pool, 1_000n, t0);
        const a = await seedAccount(db.pool, {});
        await seedX402Payment(db.pool, { accountId: a.id, txSignature: SIG(), landedSlot: 500n });
        const rpc = createFakeRpc({ getTransaction: () => null });
        expect((await auditX402(deps(rpc))).checked).toBe(1);
        const late = await seedX402Payment(db.pool, {
            accountId: a.id,
            state: "confirmed",
            txSignature: SIG(),
            landedSlot: 400n,
        });
        const second = await auditX402(deps(rpc));
        expect(second.checked).toBe(1);
        expect(second.mismatches).toContain(`payment ${late.id}`);
        expect((await auditX402(deps(rpc))).checked).toBe(0);
        const done = await db.pool.query(
            "select count(*)::int as n from x402_payments where audited_at is not null",
        );
        expect(done.rows[0].n).toBe(2);
    });

    it("an RPC error throws and leaves the checkpoint where it was", async () => {
        await openTail(db.pool, HOT, 0n, 100n, new Date(t0.getTime() - 86_400_000));
        await advanceVerified(db.pool, 1_000n, t0);
        const a = await seedAccount(db.pool, {});
        await seedX402Payment(db.pool, { accountId: a.id, txSignature: SIG(), landedSlot: 500n });
        const rpc = createFakeRpc({
            getTransaction: () => {
                throw new Error("node down");
            },
        });
        await expect(auditX402(deps(rpc))).rejects.toThrow();
        const cp = await db.pool.query("select 1 from audit_checkpoints where name = 'x402_audit'");
        expect(cp.rowCount).toBe(0);
    });
});

async function landedOnChain(amount = 10_000n) {
    chain = await startFakeChain({ autoFinalize: true });
    const payToAta = await usdcAta(address(TEST_PAYTO));
    chain.setTokenAccount({ address: HOT, owner: (await testSigner(11)).address, amount: 50_000n });
    chain.setTokenAccount({ address: payToAta, owner: TEST_PAYTO, amount: 0n });
    await openTail(db.pool, HOT, 50_000n, chain.slot(), new Date(t0.getTime() - 86_400_000));
    chain.advance(1);
    const landed = await landPayment(chain, db.pool, { amount });
    chain.finalize();
    const slot = chain.submitted().find((s) => s.signature === landed.txSignature)!.slot;
    await advanceVerified(db.pool, slot + 1n, t0);
    return { payToAta, signature: landed.txSignature, slot };
}

async function seedAllowanceRefund(over: {
    signature: string;
    slot: bigint;
    amount: number;
    destination: string;
}) {
    const { order } = await seedOrder(db.pool, { state: "redeemed" });
    const res = await db.pool.query<{ id: string }>(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            tx_signature, landed_slot, from_wallet)
         values ($1, 'allowance', 'x402_unspent', $2, $3, 'p', 'confirmed', $4, $5, 'allowance')
         returning id`,
        [order.id, over.amount, over.destination, over.signature, over.slot.toString()],
    );
    return res.rows[0]!.id;
}

async function seedColdTransfer(signature: string, slot: bigint, amount: number) {
    const res = await db.pool.query<{ id: string }>(
        `insert into x402_cold_transfers (amount_micros, state, tx_signature, landed_slot)
         values ($1, 'confirmed', $2, $3) returning id`,
        [amount, signature, slot.toString()],
    );
    return res.rows[0]!.id;
}

describe("auditX402 refund and cold rows", () => {
    it("a refund to the destination it was recorded with passes", async () => {
        const c = await landedOnChain();
        await seedAllowanceRefund({
            signature: c.signature,
            slot: c.slot,
            amount: 10_000,
            destination: c.payToAta,
        });
        const r = await auditX402(deps(chain!.rpc));
        expect(r.checked).toBe(1);
        expect(r.mismatches.filter((m) => m.startsWith("refund"))).toEqual([]);
    });

    it("a refund whose destination received nothing mismatches as 'refund <id>'", async () => {
        const c = await landedOnChain();
        const other = await usdcAta((await testSigner(31)).address);
        const id = await seedAllowanceRefund({
            signature: c.signature,
            slot: c.slot,
            amount: 10_000,
            destination: other,
        });
        const r = await auditX402(deps(chain!.rpc));
        expect(r.mismatches).toContain(`refund ${id}`);
    });

    it("a cold transfer is checked on the hot side only", async () => {
        const c = await landedOnChain();
        const id = await seedColdTransfer(c.signature, c.slot, 10_000);
        const ok = await auditX402(deps(chain!.rpc));
        expect(ok.checked).toBe(1);
        expect(ok.mismatches.filter((m) => m.startsWith("cold"))).toEqual([]);
        await db.pool.query("update x402_cold_transfers set audited_at = null");
        await db.pool.query("update x402_cold_transfers set amount_micros = 20000");
        const bad = await auditX402(deps(chain!.rpc));
        expect(bad.mismatches).toContain(`cold ${id}`);
    });
});

describe("auditX402 balance and committed", () => {
    it("the balance equation holds to the micro on a fixture", async () => {
        await openTail(db.pool, HOT, 2_016_000n, 100n, new Date(t0.getTime() - 86_400_000));
        await advanceVerified(db.pool, 1_000n, t0);
        const { order: o1 } = await seedOrder(db.pool, {
            kind: "start",
            payInto: "allowance",
            amountMicros: 1_013_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            state: "redeemed",
        });
        await seedPayment(db.pool, o1.id, { status: "confirmed" });
        await setPaymentLandedSlot(db.pool, o1.id, 200n);
        await seedAccount(db.pool, { id: o1.id, fundedMicros: 1_000_000 });
        await seedFunding(db.pool, {
            accountId: o1.id,
            orderId: o1.id,
            allowanceMicros: 1_000_000,
        });
        await db.pool.query(
            `insert into events (event_id, type, created_at, order_id, payload)
             values ('ev-ready', 'placement.ready', $1, $2, $3)`,
            [t0, o1.id, { order_id: o1.id, deadline: "2030-01-01T13:00:00Z" }],
        );
        const { order: o2 } = await seedOrder(db.pool, { state: "redeemed" });
        await seedPayment(db.pool, o2.id, { status: "confirmed" });
        await setPaymentLandedSlot(db.pool, o2.id, 150n);
        await seedAccount(db.pool, {
            id: o2.id,
            handleSha256: "cd".repeat(32),
            state: "closed",
            fundedMicros: 100_000,
            spentMicros: 97_000,
            keptMicros: 3_000,
            closedAt: t0,
        });
        await db.pool.query(
            "insert into x402_cold_transfers (amount_micros, state, tx_signature) values (1000000, 'sent', $1)",
            [SIG()],
        );
        await db.pool.query(
            `insert into x402_chain_txs (signature, slot, delta_micros, failed, matched, matched_id)
             values ($1, 300, 10000, false, 'order', $3), ($2, 400, 3000, false, 'inflow', null)`,
            [SIG(), SIG(), o1.id],
        );
        await db.pool.query("update x402_pool set committed_micros = 1000000");
        const log = memoryLog();
        expect((await auditX402(deps(createFakeRpc(), log))).mismatches).toEqual([]);
        await db.pool.query("update x402_tail set opening_balance_micros = 2016001");
        const off = await auditX402(deps(createFakeRpc(), log));
        expect(off.mismatches).toEqual(["balance 2029001 != 2029000"]);
        expect(alarms(log, "x402_audit_mismatch")).toHaveLength(1);
    });

    it("skips the balance while the tail is not open", async () => {
        await db.pool.query(
            "insert into x402_chain_txs (signature, slot, delta_micros, failed, matched) values ($1, 5, 7, false, 'inflow')",
            [SIG()],
        );
        const log = memoryLog();
        const r = await auditX402(deps(createFakeRpc(), log));
        expect(r.mismatches).toEqual([]);
        expect(alarms(log, "x402_audit_mismatch")).toEqual([]);
    });

    it("committed drift raises x402_pool_drift", async () => {
        await seedAccount(db.pool, { fundedMicros: 1_000_000, spentMicros: 300_000 });
        await db.pool.query("update x402_pool set committed_micros = 700000");
        const log = memoryLog();
        expect((await auditX402(deps(createFakeRpc(), log))).driftMicros).toBe(0);
        await db.pool.query("update x402_pool set committed_micros = 1000000");
        expect((await auditX402(deps(createFakeRpc(), log))).driftMicros).toBe(300_000);
        expect(alarms(log, "x402_pool_drift")).toHaveLength(1);
    });
});
