/**
 * Mainnet end-to-end test with $0.01 between our own wallets.
 *
 * One service runs for the whole file. The first test pays an order through the real x402 client,
 * checks the settled transaction on chain, redeems the order token against the router's own
 * verifier and refunds it through a signed router event. The later tests are spike checks that
 * reuse that payment and log their findings for deploy/manual-checks.md.
 */
import { randomBytes, sign } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
    type Address,
    address,
    type Base64EncodedWireTransaction,
    type KeyPairSigner,
    signature,
} from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { ExactSvmScheme, SOLANA_MAINNET_CAIP2, toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme as ExactSvmFacilitator } from "@x402/svm/exact/facilitator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSettings, readSecrets, type Secrets, type Settings } from "../../src/config.ts";
import { auditInflows } from "../../src/jobs/audit.ts";
import { loadTestPayer } from "../../src/keys/test-payer.ts";
import { jsonLog, type Log } from "../../src/log.ts";
import { routeConsole, type RunningService, startService } from "../../src/main.ts";
import { findOrder, findPaymentByOrder } from "../../src/orders/store.ts";
import { orderKey, orderPublicKeyBase64 } from "../../src/orders/token.ts";
import { findOrderRefund, type RefundRow } from "../../src/refunds/request.ts";
import { usdcAta } from "../../src/solana/accounts.ts";
import { MEMO_PROGRAM, SOLANA_MAINNET, USDC_MINT } from "../../src/solana/constants.ts";
import { loadKeypair } from "../../src/solana/keys.ts";
import { createRpc, type SolanaRpc } from "../../src/solana/rpc.ts";
import { until } from "../../src/testing/app.ts";
import { type TestDb, testDb } from "../../src/testing/db.ts";
import { goAvailable, runGoVector } from "../../src/testing/go-vector.ts";
import { requirementsFor } from "../../src/x402/challenge.ts";

const AMOUNT = 10_000;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const RPC_PACE_MS = 1_000;
const REPO = resolve(import.meta.dirname, "../..");
const routerDir = resolve(REPO, "../bugnet-router");

interface ParsedIx {
    programId: string;
    program?: string;
    parsed?: unknown;
}

interface ParsedTx {
    slot: bigint;
    meta: {
        err: unknown;
        computeUnitsConsumed?: bigint;
        innerInstructions?: readonly { instructions: readonly ParsedIx[] }[] | null;
    } | null;
    transaction: {
        message: { accountKeys: readonly { pubkey: string }[]; instructions: readonly ParsedIx[] };
    };
}

interface TransferInfo {
    authority: string;
    source: string;
    destination: string;
    mint: string;
    tokenAmount: { amount: string };
}

interface Balances {
    payerUsdc: bigint;
    recipientUsdc: bigint;
    refundUsdc: bigint;
    feePayerLamports: bigint;
}

interface Created {
    status: string;
    orderId: string;
    payUrl: string;
    claim: string;
}

interface Redeemed {
    status: string;
    kind: string;
    packageId: string;
    amountMicros: number;
    payer: string;
    orderToken: string;
}

interface Landed {
    settleSig: string;
    settleSlot: bigint;
    refund: RefundRow;
}

let db: TestDb | undefined;
let svc: RunningService | undefined;
let restoreConsole: (() => void) | undefined;
let settings: Settings;
let secrets: Secrets;
let log: Log;
let finding: Log;
let rpc: SolanaRpc;
let http: x402HTTPClient;
let testPayer: KeyPairSigner;
let feePayer: KeyPairSigner;
let refundWallet: KeyPairSigner;
let recipientAta: Address;
let live: Landed | undefined;
const eventSeed = randomBytes(32);
// Fetched at start, so it has expired by the time the expired-blockhash check signs with it
let stale: { blockhash: string; lastValidBlockHeight: bigint };

function landed(): Landed {
    if (live === undefined) throw new Error("the payment test did not finish");
    return live;
}

function freePort(): Promise<number> {
    return new Promise((done, fail) => {
        const server = createServer();
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };
            server.close(() => done(port));
        });
    });
}

// The public URL names the public port, so that port is picked before the service starts
async function liveSettings(dbUrl: string): Promise<Settings> {
    const dev = loadSettings(resolve(REPO, "config/dev.toml"));
    const port = await freePort();
    return {
        ...dev,
        http: {
            ...dev.http,
            internal_listen: "127.0.0.1:0",
            public_listen: `127.0.0.1:${port}`,
            public_url: `http://127.0.0.1:${port}`,
        },
        database: { url: dbUrl },
        router: { ...dev.router, event_public_key: orderPublicKeyBase64(eventSeed) },
    };
}

// until polls every 20 ms, far above what the RPC plan allows
function paced(read: () => Promise<boolean>, ms = RPC_PACE_MS): () => Promise<boolean> {
    return async () => {
        if (await read()) return true;
        await sleep(ms);
        return false;
    };
}

async function usdcOf(owner: Address): Promise<bigint> {
    const ata = await usdcAta(owner);
    const { value } = await rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send();
    return BigInt(value.amount);
}

async function lamportsOf(owner: Address): Promise<bigint> {
    return (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
}

async function balances(): Promise<Balances> {
    return {
        payerUsdc: await usdcOf(testPayer.address),
        recipientUsdc: await usdcOf(address(settings.solana.recipient)),
        refundUsdc: await usdcOf(refundWallet.address),
        feePayerLamports: await lamportsOf(feePayer.address),
    };
}

// A confirmed transaction can reach getTransaction a moment after its status
async function parsedTx(sig: string): Promise<ParsedTx> {
    let tx = null as ParsedTx | null;
    await until(
        paced(async () => {
            tx = (await rpc
                .getTransaction(signature(sig), {
                    encoding: "jsonParsed",
                    maxSupportedTransactionVersion: 1,
                    commitment: "confirmed",
                })
                .send()) as unknown as ParsedTx | null;
            return tx !== null;
        }),
        30_000,
    );
    return tx!;
}

function transfersChecked(tx: ParsedTx): TransferInfo[] {
    return tx.transaction.message.instructions.flatMap((ix) => {
        const parsed = ix.parsed as { type?: string; info?: TransferInfo } | undefined;
        return ix.program === "spl-token" && parsed?.type === "transferChecked" && parsed.info
            ? [parsed.info]
            : [];
    });
}

function transferChecked(tx: ParsedTx): TransferInfo | undefined {
    const all = transfersChecked(tx);
    expect(all).toHaveLength(1);
    return all[0];
}

function memos(tx: ParsedTx): unknown[] {
    return tx.transaction.message.instructions
        .filter((ix) => ix.programId === MEMO_PROGRAM)
        .map((ix) => ix.parsed);
}

function programsOf(tx: ParsedTx): string[] {
    const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);
    return [...tx.transaction.message.instructions, ...inner].map((ix) => ix.programId);
}

async function postOrder<T>(s: RunningService, body: unknown): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${s.internalPort}/v1/orders`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${secrets.paymentsToken}`,
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
}

async function postSignedEvent(
    s: RunningService,
    e: { type: string; payload: Record<string, unknown> },
): Promise<void> {
    const id = `evt_live_${randomBytes(8).toString("hex")}`;
    const raw = Buffer.from(
        JSON.stringify({
            id,
            type: e.type,
            created_at: new Date().toISOString(),
            payload: e.payload,
        }),
    );
    const res = await fetch(`http://127.0.0.1:${s.internalPort}/v1/events`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bugnet-event-id": id,
            "x-bugnet-signature": sign(null, raw, orderKey(eventSeed)).toString("base64"),
        },
        body: new Uint8Array(raw),
    });
    expect(res.status).toBe(200);
}

async function challenge(payUrl: string): Promise<PaymentRequired> {
    const res = await fetch(payUrl, { headers: { accept: "application/json" } });
    expect(res.status).toBe(402);
    return http.getPaymentRequiredResponse((n) => res.headers.get(n), await res.json());
}

function createOrder(s: RunningService, description: string): Promise<Created> {
    return postOrder<Created>(s, {
        kind: "start",
        packageId: "live-test",
        amountMicros: AMOUNT,
        description,
    });
}

// The 422 carries only the code, so the same facilitator verifies the payload again to read why
async function facilitatorVerdict(payload: PaymentPayload, orderId: string) {
    const signer = toFacilitatorSvmSigner(feePayer, { [SOLANA_MAINNET]: rpc });
    const scheme = new ExactSvmFacilitator(
        { ...signer, sendTransaction: () => Promise.reject(new Error("verify never broadcasts")) },
        undefined,
        {
            maxComputeUnits: settings.solana.max_compute_units,
            maxPriorityFeeMicroLamports: settings.solana.max_priority_fee_micro_lamports,
            maxRequiredSignatures: settings.solana.max_required_signatures,
            transactionVersions: settings.solana.transaction_versions,
            enableSmartWalletVerification: false,
        },
    );
    return new x402Facilitator().register(SOLANA_MAINNET, scheme).verify(
        payload,
        requirementsFor(
            { id: orderId, amountMicros: AMOUNT, payInto: "cold" },
            {
                publicUrl: settings.http.public_url,
                recipient: settings.solana.recipient,
                allowanceWallet: settings.x402.allowance_wallet,
                feePayer: feePayer.address,
                transactionVersions: settings.solana.transaction_versions,
            },
        ),
    );
}

// Vitest's agent reporter drops the console output of passing tests, a direct write always shows
function printLine(line: string): void {
    process.stdout.write(`${line}\n`);
}

function errorText(err: unknown): string {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

describe("mainnet", () => {
    beforeAll(async () => {
        db = await testDb();
        settings = await liveSettings(db.url);
        secrets = readSecrets(process.env, settings);
        const hidden = [
            secrets.rpcUrl,
            secrets.paymentsToken,
            secrets.routerToken,
            secrets.feePayerKey,
            secrets.refundKey,
            process.env.BUGNET_TEST_PAYER_KEY,
            process.env.BUGNET_TEST_PAYER_MNEMONIC,
            process.env.BUGNET_RECIPIENT_KEY,
            process.env.BUGNET_ORDER_PRIVATE_KEY,
            process.env.BUGNET_CLAIM_KEY,
        ].filter(Boolean) as string[];
        log = jsonLog("payments", { secrets: hidden });
        finding = jsonLog("live-finding", { secrets: hidden, write: printLine });
        // The facilitator writes RPC errors with console.error
        restoreConsole = routeConsole(log);
        rpc = createRpc(secrets.rpcUrl);
        testPayer = (await loadTestPayer(process.env))!;
        feePayer = await loadKeypair(secrets.feePayerKey, "BUGNET_FEE_PAYER_KEY");
        refundWallet = await loadKeypair(secrets.refundKey, "BUGNET_REFUND_KEY");
        recipientAta = await usdcAta(address(settings.solana.recipient));
        http = new x402HTTPClient(
            new x402Client().register(
                SOLANA_MAINNET_CAIP2,
                new ExactSvmScheme(testPayer, { rpcUrl: secrets.rpcUrl, transactionVersions: [0] }),
            ),
        );
        stale = (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
        svc = await startService({ settings, secrets, log });
    }, 120_000);

    afterAll(async () => {
        try {
            await svc?.stop();
        } catch (err) {
            printLine(`afterAll: service stop failed: ${errorText(err)}`);
        }
        try {
            await db?.close();
        } catch (err) {
            printLine(`afterAll: database drop failed: ${errorText(err)}`);
        }
        try {
            restoreConsole?.();
        } catch (err) {
            printLine(`afterAll: console restore failed: ${errorText(err)}`);
        }
    }, 120_000);

    it("pays, settles, redeems and refunds $0.01 on mainnet", async () => {
        const s = svc!;
        const before = await balances();
        const created = await createOrder(s, "Bugnet live test $0.01");
        expect(created.status).toBe("payment_required");

        const payload = await http.createPaymentPayload(await challenge(created.payUrl));
        const r2 = await fetch(created.payUrl, {
            headers: http.encodePaymentSignatureHeader(payload),
        });
        expect(r2.status).toBe(200);
        const settle = decodePaymentResponseHeader(r2.headers.get("payment-response")!);

        const tx = await parsedTx(settle.transaction);
        expect(tx.meta!.err).toBeNull();
        expect(tx.transaction.message.accountKeys[0]!.pubkey).toBe(feePayer.address);
        expect(transferChecked(tx)).toMatchObject({
            authority: testPayer.address,
            destination: recipientAta,
            mint: USDC_MINT,
            tokenAmount: { amount: String(AMOUNT) },
        });
        expect(memos(tx)).toEqual([created.orderId]);
        expect(tx.meta!.computeUnitsConsumed!).toBeLessThan(20_000n);

        const redeemed = await postOrder<Redeemed>(s, {
            orderId: created.orderId,
            claim: created.claim,
        });
        // The token stays out of the matcher, whose failure message prints the whole object
        const { orderToken, ...shown } = redeemed;
        expect(shown).toMatchObject({
            status: "paid",
            kind: "start",
            packageId: "live-test",
            amountMicros: AMOUNT,
            payer: testPayer.address,
        });
        expect(goAvailable()).toBe(true);
        const orderPub = orderPublicKeyBase64(secrets.orderSeed);
        expect(runGoVector(routerDir, orderToken, orderPub, "ok", new Date())).toBe(0);

        await postSignedEvent(s, {
            type: "placement.failed",
            payload: { order_id: created.orderId, refundable: true, reason: "boot_failed" },
        });
        await until(async () => {
            const order = (await findOrder(s.pool, created.orderId))!;
            if (order.state === "manual") {
                throw new Error(`order went manual: ${order.manualReason}`);
            }
            return order.state === "refunded";
        }, 120_000);

        const payment = (await findPaymentByOrder(s.pool, created.orderId))!;
        expect(payment).toMatchObject({ status: "confirmed", txSignature: settle.transaction });
        const refund = (await findOrderRefund(s.pool, created.orderId))!;
        const rtx = await parsedTx(refund.txSignature!);
        expect(rtx.meta!.err).toBeNull();
        expect(rtx.transaction.message.accountKeys[0]!.pubkey).toBe(feePayer.address);
        expect(transfersChecked(rtx)).toEqual([
            expect.objectContaining({
                authority: refundWallet.address,
                source: await usdcAta(refundWallet.address),
                destination: payment.sourceTokenAccount,
                tokenAmount: expect.objectContaining({ amount: String(AMOUNT) }),
            }),
        ]);
        expect(programsOf(rtx)).not.toContain(ATA_PROGRAM);

        // Balance reads can lag the confirmation the refund job saw on another RPC node
        let after = before;
        await until(
            paced(async () => {
                after = await balances();
                return after.refundUsdc !== before.refundUsdc;
            }),
            30_000,
        );
        expect(after.payerUsdc).toBe(before.payerUsdc);
        expect(after.recipientUsdc - before.recipientUsdc).toBe(BigInt(AMOUNT));
        expect(before.refundUsdc - after.refundUsdc).toBe(BigInt(AMOUNT));
        expect(before.feePayerLamports - after.feePayerLamports).toBeLessThanOrEqual(21_000n);
        printLine(
            JSON.stringify({
                settleSig: settle.transaction,
                cu: String(tx.meta!.computeUnitsConsumed),
                spentLamports: String(before.feePayerLamports - after.feePayerLamports),
            }),
        );
        live = { settleSig: settle.transaction, settleSlot: tx.slot, refund };
    });

    it("logs whether getSignaturesForAddress until includes the until signature", async () => {
        const { settleSig, settleSlot } = landed();
        const rows = await rpc
            .getSignaturesForAddress(recipientAta, {
                until: signature(settleSig),
                limit: 10,
                commitment: "confirmed",
            })
            .send();
        finding.info("until inclusiveness", {
            untilIncluded: rows.some((r) => r.signature === settleSig),
            newerSignatures: rows.filter((r) => r.signature !== settleSig).length,
        });
        expect(rows.every((r) => r.slot >= settleSlot)).toBe(true);
    });

    it("resending a landed refund moves no money", async () => {
        const { refund } = landed();
        expect(refund.state).toBe("confirmed");
        expect(refund.wireTx).not.toBeNull();
        const before = await balances();
        let answer: Record<string, string>;
        try {
            const sig = await rpc
                .sendTransaction(refund.wireTx as Base64EncodedWireTransaction, {
                    encoding: "base64",
                    skipPreflight: true,
                    maxRetries: 0n,
                })
                .send();
            answer = { answered: "signature", sameSignature: String(sig === refund.txSignature) };
        } catch (err) {
            answer = { answered: "error", error: errorText(err) };
        }
        finding.info("resend of a landed refund", {
            refundSignature: refund.txSignature,
            ...answer,
        });
        // A duplicate that landed would show within a few slots
        await sleep(15_000);
        expect(await balances()).toEqual(before);
    });

    it("refuses a payment signed with an expired blockhash and broadcasts nothing", async () => {
        const s = svc!;
        await until(
            paced(async () => {
                const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
                return height > stale.lastValidBlockHeight;
            }, 2_000),
            240_000,
        );
        const feeBefore = await lamportsOf(feePayer.address);
        const order = await createOrder(s, "Bugnet live test expired blockhash");
        expect(order.status).toBe("payment_required");
        const required = await challenge(order.payUrl);
        const accepted = required.accepts[0]!;
        const payload = await http.createPaymentPayload({
            ...required,
            accepts: [
                {
                    ...accepted,
                    extra: {
                        ...accepted.extra,
                        recentBlockhash: stale.blockhash,
                        lastValidBlockHeight: stale.lastValidBlockHeight.toString(),
                    },
                },
            ],
        });
        const res = await fetch(order.payUrl, {
            headers: http.encodePaymentSignatureHeader(payload),
        });
        const body = (await res.json()) as { refused?: string; orderId?: string; code?: string };
        expect(res.status).toBe(422);
        expect(body).toMatchObject({ refused: "payment_invalid", orderId: order.orderId });

        const verdict = await facilitatorVerdict(payload, order.orderId);
        finding.info("expired blockhash", {
            code: body.code,
            facilitatorReason: verdict.invalidReason,
            facilitatorMessage: verdict.invalidMessage,
        });
        expect(verdict.isValid).toBe(false);
        expect(verdict.invalidReason).toBe(body.code);
        expect(await lamportsOf(feePayer.address)).toBe(feeBefore);
        expect((await findOrder(s.pool, order.orderId))!.state).toBe("unpaid");
        expect(await findPaymentByOrder(s.pool, order.orderId)).toBeNull();
    });

    it("the audit matches the live payment's inflow", async () => {
        const s = svc!;
        const { settleSig } = landed();
        await until(
            paced(async () => {
                const { value } = await rpc.getSignatureStatuses([signature(settleSig)]).send();
                return value[0]?.confirmationStatus === "finalized";
            }),
            120_000,
        );
        // With one payment row in the database, one match can only be the live payment
        const payments = await s.pool.query("select tx_signature from payments");
        expect(payments.rows).toEqual([{ tx_signature: settleSig }]);
        const report = await auditInflows({
            pool: s.pool,
            rpc,
            recipient: address(settings.solana.recipient),
            rpcTimeoutMs: settings.solana.rpc_timeout,
            log,
            // Six minutes on, the payment is past the confirmation lag and inside the missing window
            now: () => new Date(Date.now() + 6 * 60_000),
        });
        finding.info("audit history", {
            scanned: report.scanned,
            matched: report.matched,
            mismatches: report.mismatches,
            missing: report.missing.length,
        });
        expect(report.matched).toBe(1);
        expect(report.mismatches).not.toContain(settleSig);
        expect(report.missing).toEqual([]);
    });
});
