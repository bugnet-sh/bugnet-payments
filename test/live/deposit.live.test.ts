/**
 * Mainnet live test of paying by sending to an address (spec 18), with tiny amounts between our
 * own wallets. It runs only with the founder's go, on the RPC router release (D7). About 0.01 USDC
 * moves to our own recipient. The test payer pays its own fees and, in the late-money step, about
 * 0.00204 SOL of rent to open the closed account again, which the close gives back to it.
 *
 * It reaches Solana only through the router over the local BUGNET_SOLANA_RPC_URLS, whose keys are
 * the server's, so its calls count against the same daily caps. The log hides
 * secretValues(process.env), every URL of the list and both deposit seeds included, plus this
 * file's own values.
 *
 * Its database holds each deposit's salt, which its key needs (spec 4.2), so a run that did not
 * pass keeps it and logs its name and how to move what the run left in its deposits.
 */
import { randomBytes } from "node:crypto";
import {
    address,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    type Instruction,
    type KeyPairSigner,
    signature,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type RunnerTask } from "vitest";
import { depositLine } from "../../src/checkout/messages.ts";
import { parseStatus } from "../../src/checkout/live.ts";
import { readSecrets, type Secrets, secretValues, type Settings } from "../../src/config.ts";
import { findDeposit } from "../../src/deposits/store.ts";
import type { DepositRow } from "../../src/deposits/types.ts";
import { auditInflows } from "../../src/jobs/audit.ts";
import { waitForLanding } from "../../src/keys/commands.ts";
import { loadTestPayer } from "../../src/keys/test-payer.ts";
import { jsonLog, type Log } from "../../src/log.ts";
import { routeConsole, type RunningService, startService } from "../../src/main.ts";
import { findPaymentByOrder } from "../../src/orders/store.ts";
import type { OrderClaims } from "../../src/orders/token.ts";
import { MEMO_PROGRAM, USDC_MINT } from "../../src/solana/constants.ts";
import { loadKeypair } from "../../src/solana/keys.ts";
import { RpcRouterError } from "../../src/solana/router/errors.ts";
import { createRouterRpc, type RoutedRpc, type SolanaRpc } from "../../src/solana/rpc.ts";
import { signV0Transaction, usdcTransferChecked } from "../../src/solana/transfer.ts";
import { until } from "../../src/testing/app.ts";
import { type TestDb, testDb } from "../../src/testing/db.ts";
import { missingDepositEnv } from "../../src/testing/live-env.ts";
import {
    lamportsOf,
    liveRpcSettings,
    liveSettings,
    paced,
    postOrder as livePostOrder,
    usdcOf,
} from "./helpers.ts";

const PRICE = 10_000;
const PART = 6_000;
const UNDERPAY = 4_000;
const LATE = 2_000;
// Spec 18: the fee payer's net cost of one order, its rent back from the close
const FEE_PAYER_MAX_LAMPORTS = 30_000n;
const POLL_MS = 2_000;
const COMPUTE_UNIT_PRICE = 10_000;

interface Created {
    status: string;
    orderId: string;
    payUrl: string;
    claim: string;
}

interface Redeemed {
    status: string;
    payer: string;
    orderToken: string;
}

interface Status {
    state: string;
    expiresAt: string;
    deposit: {
        address: string;
        ready: boolean;
        status: string;
        receivedMicros: number;
        remainingMicros: number;
        returnedMicros: number;
        reason: string | null;
        reasonMicros: number;
    } | null;
}

interface ParsedTx {
    transaction: { message: { instructions: readonly { programId: string; parsed?: unknown }[] } };
}

let db: TestDb | undefined;
let svc: RunningService | undefined;
let routed: RoutedRpc | undefined;
let restoreConsole: (() => void) | undefined;
let settings: Settings;
let secrets: Secrets;
let log: Log;
let rpc: SolanaRpc;
let testPayer: KeyPairSigner;
let feePayer: KeyPairSigner;
// The first order, paid and closed, whose address the late-money step sends to again
let paidOrder: { orderId: string; sweep: string } | undefined;
const eventSeed = randomBytes(32);
// The file's tests, which afterAll reads before it drops the database
let tests: readonly RunnerTask[] = [];

// Vitest's agent reporter drops the console output of passing tests, a direct write always shows
function printLine(line: string): void {
    process.stdout.write(`${line}\n`);
}

function errorText(err: unknown): string {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function service(): RunningService {
    if (svc === undefined) throw new Error("the service did not start");
    return svc;
}

function paid(): { orderId: string; sweep: string } {
    if (paidOrder === undefined) throw new Error("the paying test did not finish");
    return paidOrder;
}

const base = () => `http://127.0.0.1:${service().publicPort}`;

function postOrder<T>(body: unknown): Promise<T> {
    return livePostOrder<T>(service(), secrets.paymentsToken, body);
}

function createOrder(description: string): Promise<Created> {
    return postOrder<Created>({
        kind: "start",
        packageId: "live-test",
        amountMicros: PRICE,
        description,
    });
}

// A browser's view of the page makes the deposit row (spec 5)
async function viewPage(orderId: string): Promise<void> {
    const res = await fetch(`${base()}/o/${orderId}`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    await res.text();
}

// The page script's poll, whose header lets Bugnet open the token account (spec 5, 15.4)
async function status(orderId: string): Promise<Status> {
    const res = await fetch(`${base()}/o/${orderId}/status`, {
        headers: { accept: "application/json", "bugnet-client": "checkout" },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Status;
}

async function waitFor(
    orderId: string,
    cond: (s: Status) => boolean,
    timeoutMs: number,
): Promise<Status> {
    let last: Status | undefined;
    await until(
        paced(async () => {
            last = await status(orderId);
            return cond(last);
        }, POLL_MS),
        timeoutMs,
    );
    return last!;
}

async function depositOf(orderId: string): Promise<DepositRow> {
    const d = await findDeposit(service().pool, orderId);
    if (d === null) throw new Error(`no deposit for ${orderId}`);
    return d;
}

async function waitForDeposit(
    orderId: string,
    cond: (d: DepositRow) => boolean | Promise<boolean>,
    timeoutMs: number,
): Promise<DepositRow> {
    await until(
        paced(async () => await cond(await depositOf(orderId)), POLL_MS),
        timeoutMs,
    );
    return await depositOf(orderId);
}

/**
 * The test payer sends USDC from its own account, paying the fee; with open it first creates the
 * deposit token account, as a wallet does for an account that is not there, and pays its rent.
 */
async function sendUsdc(d: DepositRow, micros: number, open = false): Promise<string> {
    const instructions: Instruction[] = [];
    if (open) {
        instructions.push(
            await getCreateAssociatedTokenIdempotentInstructionAsync({
                payer: testPayer,
                owner: address(d.address),
                mint: USDC_MINT,
            }),
        );
    }
    instructions.push(
        await usdcTransferChecked(testPayer, address(d.tokenAccount), BigInt(micros)),
    );
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const signed = await signV0Transaction({
        feePayer: testPayer,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        computeUnitLimit: open ? 60_000 : 20_000,
        computeUnitPrice: COMPUTE_UNIT_PRICE,
        instructions,
    });
    const sig = getSignatureFromTransaction(signed);
    try {
        await rpc
            .sendTransaction(getBase64EncodedWireTransaction(signed), {
                encoding: "base64",
                preflightCommitment: "confirmed",
            })
            .send();
    } catch (err) {
        // It may have gone out, so only its landing can say
        if (!(err instanceof RpcRouterError && err.reason === "send_unconfirmed")) throw err;
    }
    await waitForLanding(rpc, sig, latest.lastValidBlockHeight);
    return sig;
}

async function accountGone(tokenAccount: string): Promise<boolean> {
    const { value } = await rpc
        .getAccountInfo(address(tokenAccount), { commitment: "confirmed", encoding: "base64" })
        .send();
    return value === null;
}

async function memosOf(sig: string): Promise<unknown[]> {
    let tx: ParsedTx | null = null;
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
    return tx!.transaction.message.instructions
        .filter((ix) => ix.programId === MEMO_PROGRAM)
        .map((ix) => ix.parsed);
}

// Why the database must stay, or null when every test passed and every deposit closed
async function keepReason(d: TestDb): Promise<string | null> {
    if (tests.length === 0 || tests.some((t) => t.result?.state !== "pass")) {
        return "a test did not pass";
    }
    try {
        const { rows } = await d.pool.query<{ order_id: string }>(
            "select order_id from deposits where state not in ('closed', 'done') order by order_id",
        );
        if (rows.length === 0) return null;
        return `deposits not closed: ${rows.map((r) => r.order_id).join(" ")}`;
    } catch (err) {
        return `its deposits could not be read: ${errorText(err)}`;
    }
}

async function dropOrKeep(): Promise<void> {
    if (db === undefined) return;
    const why = await keepReason(db);
    if (why === null) return await db.close();
    log.warn(`kept database ${db.name} (${why}): only it holds this run's deposit salts`);
    log.warn(
        `recover: in a copy of config/dev.toml point [database] url at database ${db.name} ` +
            "on the BUGNET_TEST_PG_URL server, run pnpm exec tsx src/main.ts -config <copy> so " +
            "the deposit job returns and closes what is left, follow it with pnpm cli -config " +
            "<copy> deposits list, and move late money from a done deposit with deposits " +
            "return-late",
    );
    await db.pool.end();
}

// The token's middle part is its claims; the router verifies the signature, not this test
function claimsOf(token: string): OrderClaims {
    const part = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as OrderClaims;
}

describe("deposits on mainnet", () => {
    beforeAll(async () => {
        const missing = missingDepositEnv(process.env);
        if (missing.length > 0) {
            throw new Error(`deposit live test needs ${missing.join(", ")} in .env (spec 18)`);
        }
        // Before the database, so a kept one is always logged
        log = jsonLog("payments", { secrets: secretValues(process.env) });
        db = await testDb();
        // A deadline two minutes out, so the expiry step needs no fifteen-minute wait
        settings = await liveSettings(db.url, eventSeed, {
            deposits: { enabled: true },
            orders: { unpaid_ttl: "2m" },
        });
        secrets = readSecrets(process.env, settings);
        restoreConsole = routeConsole(log);
        const live = liveRpcSettings(process.env);
        routed = createRouterRpc(live.settings, live.urls, {
            log,
            now: () => Date.now(),
            random: Math.random,
        });
        await routed.router.start({ timers: true });
        rpc = routed.rpc;
        const payer = await loadTestPayer(process.env);
        if (payer === null) throw new Error("no test payer");
        testPayer = payer;
        feePayer = await loadKeypair(secrets.feePayerKey, "BUGNET_FEE_PAYER_KEY");
        svc = await startService({ settings, secrets, log });
    }, 120_000);

    beforeEach(({ task }) => {
        tests = task.suite?.tasks ?? [];
    });

    afterAll(async () => {
        for (const [what, step] of [
            ["service stop", () => svc?.stop()],
            ["router stop", () => routed?.router.stop()],
            ["database drop or keep", dropOrKeep],
            ["console restore", () => restoreConsole?.()],
        ] as const) {
            try {
                await step();
            } catch (err) {
                printLine(`afterAll: ${what} failed: ${errorText(err)}`);
            }
        }
    }, 120_000);

    it("underpay, top up, overpay: paid, extra returned, closed", async () => {
        const recipient = address(settings.solana.recipient);
        const payerBefore = await usdcOf(rpc, testPayer.address);
        const recipientBefore = await usdcOf(rpc, recipient);
        const feePayerBefore = await lamportsOf(rpc, feePayer.address);

        const created = await createOrder("Bugnet deposit live test $0.01");
        expect(created.status).toBe("payment_required");
        const id = created.orderId;
        await viewPage(id);
        await waitFor(id, (s) => s.deposit?.ready === true, 30_000);
        const dep = await depositOf(id);

        await sendUsdc(dep, PART);
        const partial = await waitFor(id, (s) => s.deposit?.status === "partial", 20_000);
        expect(partial.deposit).toMatchObject({ receivedMicros: PART, remainingMicros: 4_000 });

        await sendUsdc(dep, PART);
        await waitFor(id, (s) => s.state === "paid", 40_000);
        const closed = await waitForDeposit(id, (d) => d.state === "closed", 60_000);
        expect(closed.state).toBe("closed");
        // The extra 2,000 lands back in the test payer's account
        await until(
            paced(async () => payerBefore - (await usdcOf(rpc, testPayer.address)) === 10_000n),
            60_000,
        );
        expect((await usdcOf(rpc, recipient)) - recipientBefore).toBe(BigInt(PRICE));
        expect(await accountGone(dep.tokenAccount)).toBe(true);
        expect(feePayerBefore - (await lamportsOf(rpc, feePayer.address))).toBeLessThanOrEqual(
            FEE_PAYER_MAX_LAMPORTS,
        );

        const payment = await findPaymentByOrder(service().pool, id);
        expect(payment).not.toBeNull();
        const sweep = payment!.txSignature;
        expect(await memosOf(sweep)).toEqual([id]);
        const redeemed = await postOrder<Redeemed>({ orderId: id, claim: created.claim });
        expect(redeemed.status).toBe("paid");
        expect(claimsOf(redeemed.orderToken)).toMatchObject({
            payer: testPayer.address,
            fee_payer: feePayer.address,
            tx: sweep,
        });
        paidOrder = { orderId: id, sweep };
    }, 300_000);

    it("underpay then expire: returned", async () => {
        const payerBefore = await usdcOf(rpc, testPayer.address);
        const created = await createOrder("Bugnet deposit live test, left to expire");
        const id = created.orderId;
        await viewPage(id);
        await waitFor(id, (s) => s.deposit?.ready === true, 30_000);
        await sendUsdc(await depositOf(id), UNDERPAY);
        const partial = await waitFor(id, (s) => s.deposit?.status === "partial", 20_000);
        expect(partial.deposit).toMatchObject({ receivedMicros: UNDERPAY });

        // The deadline, the grace, the expiry and the return
        const waitMs =
            Date.parse(partial.expiresAt) - Date.now() + settings.deposits.settle_grace + 180_000;
        await waitFor(id, (s) => s.state === "refunded", waitMs);
        await until(
            paced(async () => (await usdcOf(rpc, testPayer.address)) === payerBefore),
            60_000,
        );
    }, 420_000);

    it("late money to a closed address is returned", async () => {
        const { orderId: id } = paid();
        const dep = await depositOf(id);
        expect(dep.state).toBe("closed");
        const payerBefore = await usdcOf(rpc, testPayer.address);
        const lamportsBefore = await lamportsOf(rpc, testPayer.address);

        await sendUsdc(dep, LATE, true);
        const back = await waitFor(
            id,
            (s) => s.deposit?.reason === "late" && s.deposit.reasonMicros === LATE,
            180_000,
        );
        const line = depositLine(parseStatus(back)!, {
            amountMicros: PRICE,
            deadline: "00:00",
            refundMinMicros: settings.deposits.refund_min_micros,
            orderId: id,
        });
        expect(line.extra.concat(line.message).join(" ")).toContain(
            "$0.002 arrived after this order closed",
        );
        await waitForDeposit(
            id,
            async (d) => d.state === "closed" && (await accountGone(d.tokenAccount)),
            180_000,
        );
        expect(await usdcOf(rpc, testPayer.address)).toBe(payerBefore);
        // The close gave the rent back to the test payer, which made the account again
        expect(lamportsBefore - (await lamportsOf(rpc, testPayer.address))).toBeLessThan(
            FEE_PAYER_MAX_LAMPORTS,
        );
    }, 420_000);

    it("the audit matches the sweep", async () => {
        const { orderId, sweep } = paid();
        const report = await auditInflows({
            pool: service().pool,
            rpc,
            recipient: address(settings.solana.recipient),
            rpcTimeoutMs: settings.solana.rpc_timeout,
            log,
            // Past the audit's confirmation lag, so the sweep falls inside its window
            now: () => new Date(Date.now() + 6 * 60_000),
        });
        expect(report.matched).toBeGreaterThanOrEqual(1);
        expect(report.mismatches).not.toContain(sweep);
        expect(report.missing).not.toContain(orderId);
    }, 120_000);
});
