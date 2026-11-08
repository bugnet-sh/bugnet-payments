import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usdcAta } from "../solana/accounts.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { type FakeChain, startFakeChain } from "../testing/fake-chain.ts";
import { testSigner } from "../testing/keys.ts";
import {
    resetLedger,
    seedAccount,
    seedAllowanceRefundRow,
    seedFunding,
    seedX402Payment,
} from "../testing/x402.ts";
import { ledgerCheck } from "./ledger-check.ts";

let db: TestDb;
let chain: FakeChain;
let payToAta: string;
let payerAta: string;

beforeAll(async () => {
    db = await testDb();
    payToAta = await usdcAta((await testSigner(41)).address);
    payerAta = await usdcAta((await testSigner(42)).address);
});
beforeEach(async () => {
    await resetLedger(db.pool);
    chain = await startFakeChain();
    chain.setTokenAccount({
        address: payToAta,
        owner: (await testSigner(41)).address,
        amount: 0n,
    });
    chain.setTokenAccount({
        address: payerAta,
        owner: (await testSigner(42)).address,
        amount: 0n,
    });
});
afterEach(() => chain.close());
afterAll(() => db.close());

async function closedAccount(over: { refundedMicros: number }) {
    const account = await seedAccount(db.pool, {
        state: "closed",
        fundedMicros: 1_000_000,
        spentMicros: 30_000,
        keptMicros: 0,
        ...over,
    });
    const funding = await seedFunding(db.pool, {
        accountId: account.id,
        allowanceMicros: 1_000_000,
    });
    // seedFunding credits the account again; the ledger already holds this funding
    await db.pool.query("update x402_accounts set funded_micros = 1000000 where id = $1", [
        account.id,
    ]);
    return { account, funding };
}

async function pay(accountId: string, ledgerMicros: number, chainMicros: bigint) {
    return seedX402Payment(db.pool, {
        accountId,
        state: "confirmed",
        amountMicros: ledgerMicros,
        payToTokenAccount: payToAta,
        txSignature: chain.credit(payToAta, chainMicros),
    });
}

describe("ledgerCheck", () => {
    it("ok for an account whose rows match the chain", async () => {
        const { account, funding } = await closedAccount({ refundedMicros: 970_000 });
        for (let i = 0; i < 3; i++) await pay(account.id, 10_000, 10_000n);
        await seedAllowanceRefundRow(db.pool, funding.orderId, {
            amountMicros: 970_000,
            destination: payerAta,
            state: "confirmed",
            txSignature: chain.credit(payerAta, 970_000n),
        });
        const r = await ledgerCheck(db.pool, chain.rpc, account.id, 5_000);
        expect(r.ok).toBe(true);
        expect(r.lines.filter((l) => / ok( |$)/.test(l))).toHaveLength(5);
        expect(r.lines.join("\n")).not.toContain(payerAta);
        expect(r.lines.join("\n")).not.toContain(payToAta);
        expect(r.lines.at(-1)).toBe(
            `account ${account.id} funded=1000000 spent=30000 refunded=970000 kept=0 ok`,
        );
    });

    it("names a payment whose on-chain amount differs", async () => {
        const { account } = await closedAccount({ refundedMicros: 970_000 });
        const p = await pay(account.id, 10_000, 10_001n);
        const r = await ledgerCheck(db.pool, chain.rpc, account.id, 5_000);
        expect(r.ok).toBe(false);
        expect(r.lines).toContain(`payment ${p.id} MISMATCH ledger=10000 chain=10001`);
    });

    it("names a payment the chain does not have and one that failed", async () => {
        const { account } = await closedAccount({ refundedMicros: 970_000 });
        const missing = await seedX402Payment(db.pool, {
            accountId: account.id,
            state: "confirmed",
            amountMicros: 10_000,
            payToTokenAccount: payToAta,
            txSignature: "1".repeat(64),
        });
        chain.failNext();
        const failed = await pay(account.id, 10_000, 10_000n);
        const r = await ledgerCheck(db.pool, chain.rpc, account.id, 5_000);
        expect(r.ok).toBe(false);
        expect(r.lines).toContain(`payment ${missing.id} MISMATCH ledger=10000 chain=missing`);
        expect(r.lines).toContain(`payment ${failed.id} MISMATCH ledger=10000 chain=failed`);
    });

    it("names a refund whose on-chain amount differs", async () => {
        const { account, funding } = await closedAccount({ refundedMicros: 970_000 });
        const id = await seedAllowanceRefundRow(db.pool, funding.orderId, {
            amountMicros: 970_000,
            destination: payerAta,
            state: "confirmed",
            txSignature: chain.credit(payerAta, 969_999n),
        });
        const r = await ledgerCheck(db.pool, chain.rpc, account.id, 5_000);
        expect(r.ok).toBe(false);
        expect(r.lines).toContain(`refund ${id} MISMATCH ledger=970000 chain=969999`);
    });

    it("reports a refund resolved by hand without checking it", async () => {
        const { account, funding } = await closedAccount({ refundedMicros: 970_000 });
        const id = await seedAllowanceRefundRow(db.pool, funding.orderId, {
            amountMicros: 970_000,
            destination: payerAta,
            state: "manual",
            manualReason: "resolved_by_hand",
            handTx: "2".repeat(64),
        });
        const r = await ledgerCheck(db.pool, chain.rpc, account.id, 5_000);
        expect(r.ok).toBe(true);
        expect(r.lines).toContain(`refund ${id} resolved by hand ${"2".repeat(64)}`);
        expect(chain.calls().filter((c) => c.method === "getTransaction")).toHaveLength(0);
    });

    it("names a closed account whose totals do not add up", async () => {
        const { account } = await closedAccount({ refundedMicros: 960_000 });
        const r = await ledgerCheck(db.pool, chain.rpc, account.id, 5_000);
        expect(r.ok).toBe(false);
        expect(r.lines.at(-1)).toBe(
            `account ${account.id} funded=1000000 spent=30000 refunded=960000 kept=0 MISMATCH`,
        );
    });

    it("does not require an open account to balance", async () => {
        const account = await seedAccount(db.pool, { fundedMicros: 1_000_000 });
        const r = await ledgerCheck(db.pool, chain.rpc, account.id, 5_000);
        expect(r.ok).toBe(true);
    });

    it("rejects an unknown account", async () => {
        await expect(
            ledgerCheck(db.pool, chain.rpc, "ord_00000000000000000000", 5_000),
        ).rejects.toThrow("unknown account");
    });
});
