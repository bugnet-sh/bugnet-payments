import { randomBytes } from "node:crypto";
import {
    address,
    getBase58Decoder,
    getBase64Encoder,
    getTransactionDecoder,
    type KeyPairSigner,
    signature,
} from "@solana/kit";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { transactionMessageHash } from "@x402/svm";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../../config.ts";
import { reconcileSettling } from "../../jobs/reconciler.ts";
import { memoryLog } from "../../log.ts";
import { findOrder } from "../../orders/store.ts";
import { type RefundDeps, resumeRefunds, runRefunds } from "../../refunds/executor.ts";
import { findOrderRefund, requestRefund } from "../../refunds/request.ts";
import { get, testApp } from "../../testing/app.ts";
import { testDb, type TestDb } from "../../testing/db.ts";
import {
    type FakeChain,
    type FakeChainEndpoint,
    startFakeChain,
} from "../../testing/fake-chain.ts";
import { testSigner } from "../../testing/keys.ts";
import { seedOrder, seedPayment } from "../../testing/orders.ts";
import { signedPayment } from "../../testing/payment.ts";
import { resetLedger, signedRow, TEST_PAYTO } from "../../testing/x402.ts";
import { requirementsFor } from "../../x402/challenge.ts";
import { SignerGate } from "../../x402/listener.ts";
import { applyExpiry } from "../../x402/match.ts";
import { type MirrorDeps, resetMirrorState, runMirror } from "../../x402/mirror.ts";
import { findX402Payment } from "../../x402/reserve.ts";
import { resignProof } from "../../x402/resign.ts";
import { type BroadcastRecord, createSettler } from "../../x402/settler.ts";
import { openTail } from "../../x402/tail.ts";
import { usdcAta } from "../accounts.ts";
import { BlockhashCache } from "../blockhash.ts";
import { createRouterRpc, createRpc, type RoutedRpc } from "../rpc.ts";
import { endpointFingerprint, pgVerdictStore } from "../rpc-store.ts";
import { testRpcSettings } from "./testing.ts";
import type { RouterDeps } from "./transport.ts";

// Money decisions through a real router over fake-chain endpoints a (rpc1) and b (rpc2), each on
// its own loopback port and so its own domain: absence_quorum resolves to 2
const RECIPIENT = "Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw";
const defaults = parseSettings(stringify({ solana: { recipient: RECIPIENT } }), "money.test");
const MIN = 60_000;
const HOUR = 60 * MIN;
// The chain and the router's clock move together, 420 ms a slot
const MS_PER_SLOT = 420;

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

describe("money decisions over the router", () => {
    let chain: FakeChain;
    let payer: KeyPairSigner, owner: KeyPairSigner;
    let source: string, destination: string;
    const clock = { ms: Date.UTC(2030, 0, 1) };
    const routers: RoutedRpc[] = [];
    beforeEach(async () => {
        await db.pool.query("truncate orders, rpc_verdicts cascade");
        chain = await startFakeChain({ autoFinalize: true });
        [payer, owner] = await Promise.all([testSigner(61), testSigner(62)]);
        source = await usdcAta(owner.address);
        destination = await usdcAta(RECIPIENT as never);
        chain.setTokenAccount({ address: source, owner: owner.address, amount: 1_000_000n });
        chain.setTokenAccount({ address: destination, owner: RECIPIENT, amount: 0n });
    });
    afterEach(async () => {
        for (const r of routers.splice(0)) await r.router.stop();
        await chain.close();
    });

    function advance(slots: number) {
        chain.advance(slots);
        clock.ms += slots * MS_PER_SLOT;
    }

    async function routed(
        endpoints: FakeChainEndpoint[],
        over: Partial<Pick<RouterDeps, "verdicts" | "fingerprint">> = {},
    ) {
        const log = memoryLog();
        const r = createRouterRpc(
            testRpcSettings({ attempt_timeout: 300 }),
            endpoints.map((e) => e.url),
            { log, now: () => clock.ms, random: () => 0.5, ...over },
        );
        routers.push(r);
        await r.router.start({ timers: false });
        return { ...r, log };
    }

    // A settling order whose payment row names sig and expires at lastValid
    async function settling(sig: string, lastValid: bigint) {
        const recorded = new Date(clock.ms - 2 * MIN);
        const { order } = await seedOrder(db.pool, {
            state: "settling",
            payer: owner.address,
            createdAt: new Date(recorded.getTime() - MIN),
            expiresAt: new Date(recorded.getTime() + 14 * MIN),
        });
        await seedPayment(db.pool, order.id, {
            txSignature: sig,
            payer: owner.address,
            createdAt: recorded,
            lastValidBlockHeight: lastValid,
        });
        return order.id;
    }

    const reconcile = (r: RoutedRpc, log = memoryLog()) =>
        reconcileSettling({
            pool: db.pool,
            rpc: r.rpc,
            rpcTimeoutMs: 5_000,
            log,
            now: () => new Date(clock.ms),
            paid: null,
            x402: defaults.x402,
        });

    const pay = () =>
        chain.transfer({ authority: owner, feePayer: payer, source, destination, micros: 50_000n });

    for (const mode of [false, "short"] as const) {
        it(`a history-less endpoint never reverts a paid order (history ${String(mode)})`, async () => {
            const a = await chain.addEndpoint({ history: mode });
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            // b finds the payment either way; what this pins is that a never holds the history
            // role, which the lost-history test below needs for its quorum
            expect(r.router.snapshot().endpoints[0]!.checks.history).toBe("missing");
            const sig = await pay();
            const id = await settling(sig, chain.height() + 5n);
            advance(200);
            const report = await reconcile(r);
            expect(report.reverted).toBe(0);
            expect((await findOrder(db.pool, id))?.state).toBe("paid");
        });
    }

    it("two domains that agree still revert a dropped payment", async () => {
        const r = await routed([await chain.addEndpoint(), await chain.addEndpoint()]);
        const dropped = getBase58Decoder().decode(randomBytes(64));
        const id = await settling(dropped, chain.height() + 5n);
        advance(200);
        const report = await reconcile(r);
        expect(report.reverted).toBe(1);
        expect((await findOrder(db.pool, id))?.state).toBe("unpaid");
    });

    it("with one domain down the order waits", async () => {
        const a = await chain.addEndpoint();
        const b = await chain.addEndpoint();
        const r = await routed([a, b]);
        b.stall("before");
        const dropped = getBase58Decoder().decode(randomBytes(64));
        const id = await settling(dropped, chain.height() + 5n);
        advance(200);
        const report = await reconcile(r);
        expect(report.waiting).toBe(1);
        expect(report.reverted).toBe(0);
        expect((await findOrder(db.pool, id))?.state).toBe("settling");
        expect(r.log.lines.filter((l) => l.alarm === "rpc_absence_unconfirmed")).toHaveLength(1);
    });
    const consistent = (r: RoutedRpc, name: string) =>
        r.router.snapshot().endpoints.find((e) => e.name === name)?.consistent;
    const absenceAlarms = (r: { log: ReturnType<typeof memoryLog> }) =>
        r.log.lines.filter((l) => l.alarm === "rpc_absence_unconfirmed");
    const randomSignature = () => getBase58Decoder().decode(randomBytes(64));

    it("an inconsistent endpoint stays so across a router restart", async () => {
        const a = await chain.addEndpoint({ history: false });
        const b = await chain.addEndpoint();
        const c = await chain.addEndpoint({ history: "alternate" });
        const stored = {
            verdicts: pgVerdictStore(db.pool, () => new Date(clock.ms), HOUR),
            fingerprint: endpointFingerprint(Buffer.alloc(32, 7)),
        };
        const first = await routed([a, b, c], stored);
        expect(consistent(first, "rpc3")).toBe("no");
        await first.router.stop();

        clock.ms += 10 * MIN;
        // Its answers agree from now on, but a run sooner than the hour gives no vote back
        c.setHistory(true);
        const r = await routed([a, b, c], stored);
        expect(consistent(r, "rpc3")).toBe("no");

        const id = await settling(randomSignature(), chain.height() + 5n);
        advance(200);
        const report = await reconcile(r);
        expect(report.reverted).toBe(0);
        expect(report.waiting).toBe(1);
        expect((await findOrder(db.pool, id))?.state).toBe("settling");
    });

    it("an endpoint that lost its history and a history-less one never revert a paid order", async () => {
        const a = await chain.addEndpoint({ history: false });
        const b = await chain.addEndpoint();
        const c = await chain.addEndpoint();
        const r = await routed([a, b, c]);
        // As if its next backends had no history
        c.setHistory("short");
        const sig = await pay();
        const id = await settling(sig, chain.height() + 5n);
        advance(200);
        b.stall("before");
        const report = await reconcile(r);
        expect(report.reverted).toBe(0);
        expect(report.waiting).toBe(1);
        expect((await findOrder(db.pool, id))?.state).toBe("settling");
        expect(absenceAlarms(r)).toHaveLength(1);

        b.stall("off");
        await reconcile(r);
        expect((await findOrder(db.pool, id))?.state).toBe("paid");
    });

    it("a flipping endpoint never makes a quorum", async () => {
        const a = await chain.addEndpoint({ history: false });
        const b = await chain.addEndpoint();
        const c = await chain.addEndpoint({ history: "alternate" });
        const r = await routed([a, b, c]);
        expect(consistent(r, "rpc3")).toBe("no");
        b.setHistory("short");
        const sig = await pay();
        const id = await settling(sig, chain.height() + 5n);
        advance(200);
        // c's next history answer is the null one, the case where counting it would revert
        c.setHistory("alternate");
        await createRpc(c.url)
            .getSignatureStatuses([signature(sig)], { searchTransactionHistory: true })
            .send();
        const report = await reconcile(r);
        expect(report.reverted).toBe(0);
        const state = (await findOrder(db.pool, id))?.state;
        // paid when c answered found; a null from c is no vote, so then the order waits
        expect(["paid", "settling"]).toContain(state);
        if (state === "settling") expect(absenceAlarms(r)).toHaveLength(1);
    });

    describe("refunds", () => {
        let refundSigner: KeyPairSigner;
        beforeEach(async () => {
            await resumeRefunds(db.pool);
            refundSigner = await testSigner(63);
            chain.setTokenAccount({
                address: await usdcAta(refundSigner.address),
                owner: refundSigner.address,
                amount: 1_000_000n,
            });
        });

        const deps = (r: RoutedRpc): RefundDeps => ({
            pool: db.pool,
            rpc: r.rpc,
            feePayer: payer,
            refundSigner,
            allowanceSigner: null,
            x402: defaults.x402,
            hotTokenAccount: null,
            cfg: defaults.refunds,
            rpcTimeoutMs: 5_000,
            log: memoryLog(),
            now: () => new Date(clock.ms),
        });

        // A paid order refunded from the refund wallet to the payer's own account
        async function pendingRefund(): Promise<string> {
            const { order } = await seedOrder(db.pool, {
                state: "paid",
                amountMicros: 10_000,
                payer: owner.address,
            });
            await seedPayment(db.pool, order.id, {
                status: "confirmed",
                payer: owner.address,
                sourceTokenAccount: source,
            });
            expect(await requestRefund(db.pool, order.id, "unredeemed")).toBe("created");
            return order.id;
        }
        const refundOf = async (orderId: string) => (await findOrderRefund(db.pool, orderId))!;

        for (const mode of [false, "short"] as const) {
            it(`a history-less endpoint never re-signs a landed refund (history ${String(mode)})`, async () => {
                const a = await chain.addEndpoint();
                const b = await chain.addEndpoint();
                const r = await routed([a, b]);
                // a keeps the history role it earned at boot, so its null is the first answer
                // and only the quorum asks b
                a.setHistory(mode);
                const orderId = await pendingRefund();
                expect((await runRefunds(deps(r), "refund")).sent).toBe(1);
                advance(200);
                const tick = await runRefunds(deps(r), "refund");
                expect(tick).toMatchObject({ confirmed: 1, resigned: 0 });
                expect((await refundOf(orderId)).state).toBe("confirmed");
                expect((await findOrder(db.pool, orderId))?.state).toBe("refunded");
                expect(chain.submitted()).toHaveLength(1);
            });
        }

        it("a refund whose first send stalls is never re-signed on AlreadyProcessed", async () => {
            const a = await chain.addEndpoint();
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            const orderId = await pendingRefund();
            // a lands the refund and never answers; b's preflight then finds it processed
            a.stall("after");
            b.alreadyProcessed(true);
            const d = deps(r);
            const first = await runRefunds(d, "refund");
            expect(first.sent).toBe(0);
            expect(a.calls().some((c) => c.method === "sendTransaction")).toBe(true);
            expect(JSON.stringify((d.log as ReturnType<typeof memoryLog>).lines)).toContain(
                "send_unconfirmed",
            );
            const signed = await refundOf(orderId);
            expect(signed.state).toBe("signed");
            expect(chain.submitted()).toHaveLength(1);

            advance(60);
            const next = await runRefunds(deps(r), "refund");
            expect(next).toMatchObject({ confirmed: 1, resigned: 0 });
            expect(await refundOf(orderId)).toMatchObject({
                state: "confirmed",
                txSignature: signed.txSignature,
            });
            expect(chain.submitted()).toHaveLength(1);
        });

        it("a dropped refund is resent while the second endpoint is down", async () => {
            const a = await chain.addEndpoint();
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            const orderId = await pendingRefund();
            a.dropNext();
            b.stall("before");
            expect((await runRefunds(deps(r), "refund")).sent).toBe(1);
            const sent = await refundOf(orderId);
            expect(chain.submitted()).toHaveLength(0);

            // Past the 20 s check age, inside the blockhash's life
            advance(50);
            expect(chain.height()).toBeLessThanOrEqual(sent.lastValidBlockHeight!);
            const resent = await runRefunds(deps(r), "refund");
            expect(resent).toMatchObject({ resent: 1, resigned: 0 });
            expect(chain.submitted().map((t) => t.signature)).toEqual([sent.txSignature]);

            advance(10);
            expect((await runRefunds(deps(r), "refund")).confirmed).toBe(1);
            expect(await refundOf(orderId)).toMatchObject({
                state: "confirmed",
                txSignature: sent.txSignature,
            });
            expect(chain.submitted()).toHaveLength(1);
        });
    });

    describe("x402", () => {
        let allowance: KeyPairSigner;
        let hot: string, cold: string;
        beforeEach(async () => {
            await resetLedger(db.pool);
            await db.pool.query(
                `truncate x402_chain_txs, x402_incidents, x402_cold_transfers, x402_payto_days,
                    x402_unlisted_days, x402_outflow_days cascade`,
            );
            await db.pool.query("update x402_tail set finalized_height = 0 where id = 1");
            resetMirrorState();
            allowance = await testSigner(64);
            hot = await usdcAta(allowance.address);
            const coldOwner = await testSigner(65);
            cold = await usdcAta(coldOwner.address);
            chain.setTokenAccount({ address: hot, owner: allowance.address, amount: 1_000_000n });
            chain.setTokenAccount({ address: cold, owner: coldOwner.address, amount: 0n });
            chain.setTokenAccount({
                address: await usdcAta(address(TEST_PAYTO)),
                owner: TEST_PAYTO,
                amount: 0n,
            });
        });

        it("resignProof never answers absent while one endpoint knows the transaction", async () => {
            const a = await chain.addEndpoint();
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            // a keeps its history role, so its null answers first
            a.setHistory("short");
            const sig = await pay();
            const expirySeenSlot = chain.slot();
            advance(400);
            await db.pool.query("update x402_tail set verified_slot = $1", [
                chain.slot().toString(),
            ]);
            const proof = await resignProof(
                db.pool,
                r.rpc,
                { signatures: [sig], expirySeenSlot },
                defaults.x402,
                5_000,
            );
            expect(proof).not.toBe("absent");
        });

        it("checkLanded never releases while one endpoint knows the transaction", async () => {
            const a = await chain.addEndpoint();
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            // a keeps its history role, so its null answers first
            a.setHistory("short");
            const sig = await pay();
            const landedSlot = chain.slot();
            const row = await signedRow(db.pool, {
                lastValidBlockHeight: chain.height(),
                landedSlot,
                txSignature: sig,
                expirySeenSlot: landedSlot,
            });
            advance(400);
            const run = {
                h0: chain.height(),
                c0: chain.slot(),
                verifiedSlot: chain.slot(),
            };
            await applyExpiry(db.pool, r.rpc, run, {
                x402: defaults.x402,
                hotTokenAccount: hot,
                coldTokenAccount: cold,
                log: memoryLog(),
                now: () => new Date(clock.ms),
                rpcTimeoutMs: 5_000,
            });
            expect(await findX402Payment(db.pool, row.id)).toMatchObject({
                state: "signed",
                landedSlot,
                txSignature: sig,
            });
        });

        async function mirrorDeps(r: RoutedRpc): Promise<MirrorDeps> {
            const log = memoryLog();
            const gate = new SignerGate({
                staleAfterMs: 120_000,
                log,
                now: () => new Date(clock.ms),
            });
            gate.record("tls", "pass");
            await openTail(db.pool, hot, 1_000_000n, chain.slot(), new Date(clock.ms - 1_000));
            advance(1);
            return {
                pool: db.pool,
                rpc: r.rpc,
                allowanceWallet: allowance.address,
                hotTokenAccount: address(hot),
                coldTokenAccount: address(cold),
                x402: defaults.x402,
                gate,
                log,
                now: () => new Date(clock.ms),
                rpcTimeoutMs: 5_000,
            };
        }

        it("the mirror stays verified across a lagging endpoint", async () => {
            const a = await chain.addEndpoint();
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            const d = await mirrorDeps(r);
            a.setLag(400, { refuse: true });
            chain.credit(hot, 5_000n);
            advance(1);
            // A read from the lagging endpoint alone would verify too, but without the credit
            expect(await runMirror(d)).toMatchObject({ verified: true, stored: 1 });
        });

        const pinnedReads = (ep: FakeChainEndpoint) =>
            ep
                .calls()
                .filter(
                    (c) =>
                        c.method === "getAccountInfo" &&
                        JSON.stringify(c.params).includes("minContextSlot"),
                );

        it("the mirror fails over when rpc1 lags and refuses its pin", async () => {
            const a = await chain.addEndpoint();
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            const d = await mirrorDeps(r);
            // Under max_slot_lag, so only the pin keeps a's read out; b answers the epoch read
            a.setLag(30, { refuse: true });
            a.failNext(500);
            chain.credit(hot, 5_000n);
            advance(1);
            const before = pinnedReads(a).length;
            expect(await runMirror(d)).toMatchObject({ verified: true, stored: 1 });
            expect(pinnedReads(a).length - before).toBe(1);
        });

        it("an endpoint that ignores minContextSlot never serves a read below its pin", async () => {
            const a = await chain.addEndpoint({ ignoreMinContextSlot: true });
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            expect(r.router.snapshot().endpoints[0]!.checks.pinnedAccounts).toBe("ignored");
            const d = await mirrorDeps(r);
            // a answers its own view, 30 slots below the pin that b's epoch read gives
            a.setLag(30, { refuse: false });
            a.failNext(500);
            chain.credit(hot, 5_000n);
            advance(1);
            const before = pinnedReads(a).length;
            const run = await runMirror(d);
            expect(run).toMatchObject({ verified: true, stored: 1 });
            expect(pinnedReads(a).length - before).toBe(1);
            expect(run.c).toBeGreaterThanOrEqual(run.c0);
        });

        it("the mirror fails over when rpc1 dies", async () => {
            const a = await chain.addEndpoint();
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            const d = await mirrorDeps(r);
            chain.credit(hot, 5_000n);
            // b was last asked at boot, 50 s of clock ago
            advance(120);
            await a.close();
            const before = b.calls().length;
            expect(await runMirror(d)).toMatchObject({ verified: true });
            const pinned = b
                .calls()
                .slice(before)
                .filter((c) => JSON.stringify(c.params).includes("minContextSlot"));
            expect(pinned.length).toBeGreaterThan(0);
        });

        // An x402 payment from owner whose blockhash the settler's hints never saw, so it bounds
        // the last valid height by getBlockHeight plus the margin
        async function settleUnknownBlockhash(r: RoutedRpc): Promise<BroadcastRecord> {
            const latest = await chain.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
            const req = requirementsFor(
                { id: "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", amountMicros: 10_000, payInto: "cold" },
                {
                    publicUrl: "https://pay.example",
                    recipient: RECIPIENT,
                    allowanceWallet: allowance.address,
                    feePayer: payer.address,
                    transactionVersions: [0],
                },
            );
            const payload = await signedPayment(
                {
                    ...req,
                    extra: {
                        ...req.extra,
                        recentBlockhash: latest.value.blockhash,
                        lastValidBlockHeight: String(latest.value.lastValidBlockHeight),
                    },
                },
                owner,
            );
            const wire = (payload.payload as { transaction: string }).transaction;
            const messageHash = transactionMessageHash(
                getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
            );
            const records: BroadcastRecord[] = [];
            const settler = createSettler({
                feePayer: payer,
                rpc: r.rpc,
                hints: new BlockhashCache(r.rpc, 8_000, () => clock.ms),
                caps: {
                    maxComputeUnits: 50_000,
                    maxPriorityFeeMicroLamports: 10_000,
                    maxRequiredSignatures: 2,
                },
                transactionVersions: [0],
                rpcTimeoutMs: 5_000,
                log: memoryLog(),
            });
            await settler.settle(
                {
                    messageHash,
                    committed: false,
                    commit: async (rec) => {
                        records.push(rec);
                    },
                },
                payload,
                req,
            );
            expect(records).toHaveLength(1);
            return records[0]!;
        }

        it("the settler's stored height stays above the real one when rpc1 freezes", async () => {
            const a = await chain.addEndpoint();
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            a.freeze(true);
            advance(120);
            // a's own height would bound the payment 70 blocks too low
            expect(await createRpc(a.url).getBlockHeight().send()).toBe(chain.height() - 120n);
            const record = await settleUnknownBlockhash(r);
            expect(record.lastValidBlockHeight).toBeGreaterThanOrEqual(chain.height() + 250n);
        });

        it("a lagging endpoint from boot keeps the stored height above the real one", async () => {
            const a = await chain.addEndpoint({ lag: 120, refuse: false });
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            expect(await createRpc(a.url).getBlockHeight().send()).toBe(chain.height() - 120n);
            const record = await settleUnknownBlockhash(r);
            expect(record.lastValidBlockHeight).toBeGreaterThanOrEqual(chain.height() + 250n);
        });
    });
    it("a payment goes through while one endpoint answers 429", async () => {
        const a = await chain.addEndpoint();
        const b = await chain.addEndpoint();
        const r = await routed([a, b]);
        const app = await testApp({ solanaRpc: r.rpc });
        try {
            const recipientAta = await usdcAta(address(app.settings.solana.recipient));
            const payerAta = await usdcAta(app.payer.address);
            chain.setTokenAccount({
                address: recipientAta,
                owner: app.settings.solana.recipient,
                amount: 0n,
            });
            chain.setTokenAccount({
                address: payerAta,
                owner: app.payer.address,
                amount: 1_000_000n,
            });
            const { order } = await seedOrder(app.pool, {
                expiresAt: new Date(app.now.get().getTime() + 15 * MIN),
            });
            a.rateLimit(5, 10);
            const challenge = await get(app, `/o/${order.id}`);
            expect(challenge.status).toBe(402);
            const required = decodePaymentRequiredHeader(
                challenge.headers.get("payment-required")!,
            );
            const payment = await signedPayment(required.accepts[0]!, app.payer);
            const paid = await get(app, `/o/${order.id}`, {
                "payment-signature": encodePaymentSignatureHeader(payment),
            });
            expect(paid.status).toBe(200);
            expect((await findOrder(app.pool, order.id))?.state).toBe("paid");
            expect(chain.balance(recipientAta)).toBe(BigInt(order.amountMicros));
            const limited = Object.values(r.router.snapshot().endpoints[0]!.outcomes).reduce(
                (n, byOutcome) => n + (byOutcome.http_429 ?? 0),
                0,
            );
            expect(limited).toBeGreaterThan(0);
        } finally {
            await app.close();
        }
    });
});
