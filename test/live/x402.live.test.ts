/**
 * Mainnet test of the x402 allowance: a start order paid into the allowance wallet, seller
 * payments signed by Payments and settled by a test seller, the refund, the kept rest and the cold
 * transfer. The test payer pays about $0.55 per run (Task 36 of the x402 plan has the budget), and
 * the test seller's wallets are drained back with `keys drain --testseller` afterwards.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { address, type Address, type KeyPairSigner, signature } from "@solana/kit";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Secrets } from "../../src/config.ts";
import { parseEnvText } from "../../src/keys/tool.ts";
import { loadTestPayer } from "../../src/keys/test-payer.ts";
import { jsonLog, type Log } from "../../src/log.ts";
import { routeConsole, type RunningService, startService } from "../../src/main.ts";
import { usdcAta } from "../../src/solana/accounts.ts";
import { MEMO_PROGRAM } from "../../src/solana/constants.ts";
import { loadKeypair } from "../../src/solana/keys.ts";
import { createRpc, type SolanaRpc } from "../../src/solana/rpc.ts";
import { until } from "../../src/testing/app.ts";
import { type TestDb, testDb } from "../../src/testing/db.ts";
import { findAccount } from "../../src/x402/ledger.ts";
import { ledgerCheck } from "../../src/x402/ledger-check.ts";
import { toX402Payment, X402_PAYMENT_COLUMNS } from "../../src/x402/reserve.ts";
import type { AccountRow, X402PaymentRow } from "../../src/x402/types.ts";
import {
    decodedAccepts,
    decodedPaymentResponse,
    paced,
    ref,
    signedOf,
    startX402Live,
    usdcOf,
    type X402Live,
} from "./helpers.ts";
import { startTestSeller, type TestSeller } from "./test-seller.ts";

const RPC_TIMEOUT_MS = 10_000;
const SETTLE_WAIT_MS = 180_000;
// A test's own timeout must outlast its waits, so that until() reports first and the ledger
// checks that follow still run; the paid run is never retried
const CLOSE_WAIT_MS = 240_000;
const LEDGER_MARGIN_MS = 120_000;
const TEST_TIMEOUT_MS = 2 * SETTLE_WAIT_MS + LEDGER_MARGIN_MS;
const S5_TIMEOUT_MS = 2 * (2 * SETTLE_WAIT_MS + LEDGER_MARGIN_MS);
const CLOSE_TIMEOUT_MS = CLOSE_WAIT_MS + 2 * LEDGER_MARGIN_MS + 60_000;

interface ParsedTx {
    meta: {
        err: unknown;
        computeUnitsConsumed?: bigint;
        preTokenBalances?: readonly TokenBalance[] | null;
        postTokenBalances?: readonly TokenBalance[] | null;
    } | null;
    transaction: {
        message: {
            accountKeys: readonly { pubkey: string }[];
            instructions: readonly { programId: string; parsed?: unknown }[];
        };
    };
}

interface TokenBalance {
    accountIndex: number;
    uiTokenAmount: { amount: string };
}

let db: TestDb | undefined;
let svc: RunningService | undefined;
let live: X402Live | undefined;
let restoreConsole: (() => void) | undefined;
let secrets: Secrets;
let log: Log;
let rpc: SolanaRpc;
let allowanceWallet: Address;
let feePayer: KeyPairSigner;
let payTo: Address;
let recipientAta: Address;
let seller1k: TestSeller;
let seller10k: TestSeller;
let seller46k: TestSeller;
let rpcUrl: string;
let accountA: string;
const others: string[] = [];

// Vitest's agent reporter drops the console output of passing tests, a direct write always shows
function printLine(line: string): void {
    process.stdout.write(`${line}\n`);
}

function pool(): pg.Pool {
    return svc!.pool;
}

function hotUsdc(): Promise<bigint> {
    return usdcOf(rpc, allowanceWallet);
}

// A confirmed transaction can reach getTransaction a moment after its status
async function getTx(sig: string): Promise<ParsedTx> {
    let tx = null as ParsedTx | null;
    await until(
        paced(async () => {
            tx = (await rpc
                .getTransaction(signature(sig), {
                    encoding: "jsonParsed",
                    maxSupportedTransactionVersion: 0,
                    commitment: "confirmed",
                })
                .send()) as unknown as ParsedTx | null;
            return tx !== null;
        }),
        30_000,
    );
    return tx!;
}

function tokenDelta(tx: ParsedTx, tokenAccount: string): bigint {
    const index = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === tokenAccount);
    const at = (balances: readonly TokenBalance[] | null | undefined): bigint => {
        const entry = balances?.find((b) => b.accountIndex === index);
        return entry === undefined ? 0n : BigInt(entry.uiTokenAmount.amount);
    };
    return at(tx.meta!.postTokenBalances) - at(tx.meta!.preTokenBalances);
}

function memos(tx: ParsedTx): unknown[] {
    return tx.transaction.message.instructions
        .filter((ix) => ix.programId === MEMO_PROGRAM)
        .map((ix) => ix.parsed);
}

async function paymentByRef(p: pg.Pool, r: string): Promise<X402PaymentRow> {
    const res = await p.query(`select ${X402_PAYMENT_COLUMNS} from x402_payments where ref = $1`, [
        r,
    ]);
    if (res.rows.length !== 1) throw new Error(`no payment row for ref ${r}`);
    return toX402Payment(res.rows[0] as Record<string, unknown>);
}

async function confirmedCount(p: pg.Pool, account: string): Promise<number> {
    const res = await p.query<{ n: string }>(
        "select count(*) as n from x402_payments where account_id = $1 and state = 'confirmed'",
        [account],
    );
    return Number(res.rows[0]!.n);
}

async function accountOf(p: pg.Pool, account: string): Promise<AccountRow> {
    const row = await findAccount(p, account);
    if (row === null) throw new Error(`unknown account ${account}`);
    return row;
}

async function fundingOf(p: pg.Pool, account: string): Promise<{ allowanceMicros: number }> {
    const res = await p.query<{ allowance_micros: string }>(
        "select coalesce(sum(allowance_micros), 0) as allowance_micros from x402_fundings where account_id = $1",
        [account],
    );
    return { allowanceMicros: Number(res.rows[0]!.allowance_micros) };
}

interface RefundRow {
    id: number;
    state: string;
    amountMicros: number;
    txSignature: string | null;
}

async function allowanceRefunds(p: pg.Pool, account: string): Promise<RefundRow[]> {
    const res = await p.query<{
        id: string;
        state: string;
        amount_micros: string;
        tx_signature: string | null;
    }>(
        `select id, state, amount_micros, tx_signature from refunds
         where order_id = $1 and kind = 'allowance' order by id`,
        [account],
    );
    return res.rows.map((r) => ({
        id: Number(r.id),
        state: r.state,
        amountMicros: Number(r.amount_micros),
        txSignature: r.tx_signature,
    }));
}

async function confirmedColdTransfers(
    p: pg.Pool,
): Promise<{ id: number; amountMicros: number; txSignature: string }[]> {
    const res = await p.query<{ id: string; amount_micros: string; tx_signature: string }>(
        `select id, amount_micros, tx_signature from x402_cold_transfers
         where state = 'confirmed' order by id`,
    );
    return res.rows.map((r) => ({
        id: Number(r.id),
        amountMicros: Number(r.amount_micros),
        txSignature: r.tx_signature,
    }));
}

async function routerEventPhases(p: pg.Pool, account: string): Promise<string[]> {
    const res = await p.query<{ phase: string | null }>(
        "select phase from x402_router_events where start_order_id = $1",
        [account],
    );
    return res.rows.flatMap((r) => (r.phase === null ? [] : [r.phase]));
}

describe("x402 on mainnet", () => {
    beforeAll(async () => {
        db = await testDb();
        const sellerFile =
            process.env.BUGNET_TESTSELLER_ENV ?? join(homedir(), ".config/bugnet/testseller.env");
        if (!existsSync(sellerFile)) throw new Error(`${sellerFile} missing`);
        const sellerKeys = parseEnvText(readFileSync(sellerFile, "utf8"));
        feePayer = await loadKeypair(
            sellerKeys.TESTSELLER_FEE_PAYER_KEY ?? "",
            "TESTSELLER_FEE_PAYER_KEY",
        );
        const payToSigner = await loadKeypair(
            sellerKeys.TESTSELLER_PAYTO_KEY ?? "",
            "TESTSELLER_PAYTO_KEY",
        );
        payTo = payToSigner.address;
        const allowance = await loadKeypair(
            process.env.BUGNET_ALLOWANCE_KEY!,
            "BUGNET_ALLOWANCE_KEY",
        );
        allowanceWallet = allowance.address;
        const testPayer = (await loadTestPayer(process.env))!;

        const hidden = [
            process.env.BUGNET_SOLANA_RPC_URL,
            process.env.BUGNET_PAYMENTS_TOKEN,
            process.env.BUGNET_FEE_PAYER_KEY,
            process.env.BUGNET_REFUND_KEY,
            process.env.BUGNET_ALLOWANCE_KEY,
            process.env.BUGNET_TEST_PAYER_KEY,
            process.env.BUGNET_TEST_PAYER_MNEMONIC,
            process.env.BUGNET_RECIPIENT_KEY,
            process.env.BUGNET_ORDER_PRIVATE_KEY,
            process.env.BUGNET_CLAIM_KEY,
            process.env.BUGNET_SPIKE_SELLER_URL,
            ...Object.values(sellerKeys),
        ].filter(Boolean) as string[];
        log = jsonLog("payments", { secrets: hidden });
        // The facilitator writes RPC errors with console.error
        restoreConsole = routeConsole(log);

        rpcUrl = process.env.BUGNET_SOLANA_RPC_URL!;
        rpc = createRpc(rpcUrl);
        live = await startX402Live({
            dbUrl: db.url,
            eventSeed: randomBytes(32),
            allowanceWallet,
            testPayer,
            rpcUrl,
            paymentsToken: process.env.BUGNET_PAYMENTS_TOKEN!,
        });
        const settings = live.settings();
        secrets = live.secrets(settings);
        recipientAta = await usdcAta(address(settings.solana.recipient));
        const seller = (priceMicros: number) =>
            startTestSeller({ feePayer, payTo, rpcUrl, priceMicros });
        seller1k = await seller(1_000);
        seller10k = await seller(10_000);
        seller46k = await seller(46_000);
        svc = await startService({ settings, secrets, log });
    }, 120_000);

    afterAll(async () => {
        for (const step of [
            () => svc?.stop(),
            () => live?.close(),
            () => db?.close(),
            () => restoreConsole?.(),
        ]) {
            try {
                await step();
            } catch (err) {
                printLine(`afterAll: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }, 120_000);

    it(
        "pays a start with x402 into the hot wallet and funds the account",
        async () => {
            const before = await hotUsdc();
            accountA = await live!.startOrderWithX402(svc!, seller1k, 10_000);
            expect((await hotUsdc()) - before).toBe(63_000n);
            expect((await fundingOf(pool(), accountA)).allowanceMicros).toBe(50_000);
            expect((await ledgerCheck(pool(), rpc, accountA, RPC_TIMEOUT_MS)).ok).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "signs a seller payment with Payments' own blockhash and the seller settles it (T17)",
        async () => {
            const seller = await startTestSeller({
                feePayer,
                payTo,
                rpcUrl,
                memo: "m".repeat(32),
                priceMicros: 1_000,
            });
            const r = ref();
            const signed = signedOf(
                await live!.sign(svc!, accountA, {
                    ref: r,
                    body: "{}",
                    paymentRequired: seller.paymentRequired(),
                }),
            );
            const settled = await seller.settle(signed.paymentSignature);
            expect(settled.success).toBe(true);
            await until(
                async () => (await paymentByRef(pool(), r)).state === "confirmed",
                SETTLE_WAIT_MS,
            );
            const tx = await getTx(settled.transaction);
            expect(tokenDelta(tx, await usdcAta(payTo))).toBe(1_000n);
            expect(tx.meta!.computeUnitsConsumed!).toBeLessThan(20_000n);
            printLine(JSON.stringify({ t17cu: String(tx.meta!.computeUnitsConsumed) }));
            expect((await ledgerCheck(pool(), rpc, accountA, RPC_TIMEOUT_MS)).ok).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "32 parallel calls at $0.01 against $0.05 never pay more than 5 (S5, T3 and T3b)",
        async () => {
            for (const sameBody of [false, true]) {
                const account = await live!.startOrderWithX402(svc!, seller10k, 10_000);
                others.push(account);
                const answers = await Promise.all(
                    Array.from({ length: 32 }, (_, i) =>
                        live!.sign(svc!, account, {
                            ref: ref(),
                            body: sameBody ? "{}" : `{"i":${i}}`,
                            paymentRequired: seller10k.paymentRequired(),
                        }),
                    ),
                );
                const signed = answers.filter((a) => a.result.case === "signed").map(signedOf);
                const spent = answers.filter(
                    (a) =>
                        a.result.case === "refused" && a.result.value.reason === "allowance_spent",
                );
                const fresh = signed.filter((s) => !s.resend);
                const ids = new Set(fresh.map((s) => s.paymentId));
                // Identical bodies: a request that arrives after a row is signed gets that row's resend
                // (7.6 step 8), so the split between fresh rows and resends depends on timing here;
                // money never depends on it
                expect(ids.size).toBe(fresh.length);
                if (sameBody) expect(ids.size).toBeLessThanOrEqual(5);
                else expect(spent).toHaveLength(27);
                if (!sameBody) expect(fresh).toHaveLength(5);
                expect(signed.filter((s) => s.resend).every((s) => ids.has(s.paymentId))).toBe(
                    true,
                );
                expect(signed.length + spent.length).toBe(32);
                await Promise.all(fresh.map((s) => seller10k.settle(s.paymentSignature)));
                await until(
                    async () => (await confirmedCount(pool(), account)) === ids.size,
                    SETTLE_WAIT_MS,
                );
                expect((await accountOf(pool(), account)).spentMicros).toBe(10_000 * ids.size);
                expect((await ledgerCheck(pool(), rpc, account, RPC_TIMEOUT_MS)).ok).toBe(true);
            }
        },
        S5_TIMEOUT_MS,
    );

    it(
        "a real third-party seller at $0.001 accepts the own-blockhash payload (12.3 step 5)",
        async () => {
            // missingLiveEnv fails the run when it is unset
            const url = process.env.BUGNET_SPIKE_SELLER_URL!;
            const probe = await fetch(url);
            expect(probe.status).toBe(402);
            const paymentRequired = probe.headers.get("payment-required")!;
            const accepted = decodedAccepts(paymentRequired)[0]!;
            expect(Number(accepted.amount)).toBeLessThanOrEqual(1_000);
            const account = await live!.startOrderWithPin(svc!, {
                method: "GET",
                url,
                maxPriceMicros: 1_000,
                payTo: accepted.payTo,
                listed: "unlisted",
                accepted,
            });
            others.push(account);
            const t0 = Date.now();
            const s = signedOf(
                await live!.sign(svc!, account, {
                    ref: ref(),
                    body: "",
                    paymentRequired,
                    method: "GET",
                    url,
                }),
            );
            const paid = await fetch(url, { headers: { "PAYMENT-SIGNATURE": s.paymentSignature } });
            expect(paid.status).toBeGreaterThanOrEqual(200);
            expect(paid.status).toBeLessThan(300);
            expect(decodedPaymentResponse(paid.headers.get("payment-response")!).success).toBe(
                true,
            );
            printLine(JSON.stringify({ spikeMs: Date.now() - t0 }));
            await until(async () => (await confirmedCount(pool(), account)) === 1, SETTLE_WAIT_MS);
            expect((await ledgerCheck(pool(), rpc, account, RPC_TIMEOUT_MS)).ok).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "a seller that settles late never takes more than the allowance (S9, T6)",
        async () => {
            const account = await live!.startOrderWithX402(svc!, seller10k, 10_000);
            others.push(account);
            const sign = (body: string) =>
                live!.sign(svc!, account, {
                    ref: ref(),
                    body,
                    paymentRequired: seller10k.paymentRequired(),
                });
            const first = await Promise.all(
                Array.from({ length: 5 }, (_, i) => sign(`{"late":${i}}`)),
            );
            // No room comes back while the 5 are signed
            await sleep(20_000);
            const sixth = await sign('{"late":6}');
            expect(sixth.result.case === "refused" && sixth.result.value.reason).toBe(
                "allowance_spent",
            );
            await Promise.all(first.map((a) => seller10k.settle(signedOf(a).paymentSignature)));
            await until(async () => (await confirmedCount(pool(), account)) === 5, SETTLE_WAIT_MS);
            expect((await accountOf(pool(), account)).spentMicros).toBe(50_000);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "a top-up after allowance_spent lets calls pass again with no restart (T11, S5, S6)",
        async () => {
            const account = await live!.startOrderWithX402(svc!, seller10k, 10_000);
            others.push(account);
            const sign = (body: string) =>
                live!.sign(svc!, account, {
                    ref: ref(),
                    body,
                    paymentRequired: seller10k.paymentRequired(),
                });
            const first = await Promise.all(
                Array.from({ length: 5 }, (_, i) => sign(`{"t11":${i}}`)),
            );
            await Promise.all(first.map((a) => seller10k.settle(signedOf(a).paymentSignature)));
            await until(async () => (await confirmedCount(pool(), account)) === 5, SETTLE_WAIT_MS);
            const refused = await sign('{"t11":"over"}');
            expect(refused.result.case === "refused" && refused.result.value.reason).toBe(
                "allowance_spent",
            );
            await live!.topUp(svc!, account, 50_000);
            expect((await fundingOf(pool(), account)).allowanceMicros).toBe(100_000);
            const again = signedOf(await sign('{"t11":"after"}'));
            expect(again.resend).toBe(false);
            await seller10k.settle(again.paymentSignature);
            await until(async () => (await confirmedCount(pool(), account)) === 6, SETTLE_WAIT_MS);
            expect((await accountOf(pool(), account)).spentMicros).toBe(60_000);
            expect((await ledgerCheck(pool(), rpc, account, RPC_TIMEOUT_MS)).ok).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refunds the unspent rest at the end and measures the refund memo (T19)",
        async () => {
            await live!.terminate(svc!, accountA);
            await until(
                async () => (await accountOf(pool(), accountA)).state === "closed",
                SETTLE_WAIT_MS,
            );
            const rows = await allowanceRefunds(pool(), accountA);
            expect(rows.map((r) => [r.state, r.amountMicros])).toEqual([["confirmed", 49_000]]);
            const tx = await getTx(rows[0]!.txSignature!);
            expect(memos(tx)).toEqual([`bugnet-refund ${rows[0]!.id}`]);
            expect(tx.meta!.computeUnitsConsumed!).toBeLessThan(20_000n);
            printLine(JSON.stringify({ t19cu: String(tx.meta!.computeUnitsConsumed) }));
            const a = await accountOf(pool(), accountA);
            // S6, to the micro
            expect(a.spentMicros + a.refundedMicros + a.keptMicros).toBe(a.fundedMicros);
            expect((await ledgerCheck(pool(), rpc, accountA, RPC_TIMEOUT_MS)).ok).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "keeps an unspent amount under $0.01 (T13)",
        async () => {
            const account = await live!.startOrderWithX402(svc!, seller46k, 50_000);
            const s = signedOf(
                await live!.sign(svc!, account, {
                    ref: ref(),
                    body: "{}",
                    paymentRequired: seller46k.paymentRequired(),
                }),
            );
            await seller46k.settle(s.paymentSignature);
            await until(async () => (await confirmedCount(pool(), account)) === 1, SETTLE_WAIT_MS);
            await live!.terminate(svc!, account);
            await until(
                async () => (await accountOf(pool(), account)).state === "closed",
                SETTLE_WAIT_MS,
            );
            expect((await accountOf(pool(), account)).keptMicros).toBe(4_000);
            expect(await routerEventPhases(pool(), account)).toContain("kept");
            expect((await ledgerCheck(pool(), rpc, account, RPC_TIMEOUT_MS)).ok).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "measures a longer seller memo (T18)",
        async () => {
            await svc!.stop();
            const settings = live!.settings({
                x402: { seller_memo_max_bytes: 64, seller_compute_unit_limit: 40_000 },
            });
            svc = await startService({ settings, secrets: live!.secrets(settings), log });
            const account = await live!.startOrderWithX402(svc, seller1k, 10_000);
            others.push(account);
            const seller = await startTestSeller({
                feePayer,
                payTo,
                rpcUrl,
                memo: "m".repeat(64),
                priceMicros: 1_000,
            });
            const s = signedOf(
                await live!.sign(svc, account, {
                    ref: ref(),
                    body: "{}",
                    paymentRequired: seller.paymentRequired(),
                }),
            );
            const settled = await seller.settle(s.paymentSignature);
            const tx = await getTx(settled.transaction);
            expect(tx.meta!.err).toBeNull();
            printLine(JSON.stringify({ t18cu: String(tx.meta!.computeUnitsConsumed) }));
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "closes every other account, and the ledger equals the chain for each",
        async () => {
            for (const account of others) await live!.terminate(svc!, account);
            await until(
                async () =>
                    (await Promise.all(others.map((a) => accountOf(pool(), a)))).every(
                        (a) => a.state === "closed",
                    ),
                CLOSE_WAIT_MS,
            );
            for (const account of others) {
                expect((await ledgerCheck(pool(), rpc, account, RPC_TIMEOUT_MS)).ok).toBe(true);
            }
        },
        CLOSE_TIMEOUT_MS,
    );

    it(
        "transfers the shares to cold",
        async () => {
            await until(
                async () => (await confirmedColdTransfers(pool())).length >= 1,
                CLOSE_WAIT_MS,
            );
            for (const t of await confirmedColdTransfers(pool())) {
                const tx = await getTx(t.txSignature);
                expect(memos(tx)).toEqual([`bugnet-cold ${t.id}`]);
                expect(tokenDelta(tx, recipientAta)).toBe(BigInt(t.amountMicros));
            }
        },
        CLOSE_TIMEOUT_MS,
    );
});
