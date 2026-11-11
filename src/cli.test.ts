import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CliOptions, cliMain, formatRpcStatus } from "./cli.ts";
import {
    type FakeEndpoint,
    type FakeHandler,
    fakeEndpoint,
    httpFail,
    netFail,
    rpcFail,
    rpcOk,
    signatureStatus,
    statusesAnswer,
} from "./solana/router/testing.ts";
import { MAINNET_GENESIS, type RouterSnapshot } from "./solana/router/index.ts";
import { endpointFingerprint, pgSnapshotStore, pgVerdictStore } from "./solana/rpc-store.ts";
import type { EndpointSnapshot } from "./solana/router/transport.ts";
import { silentLog } from "./log.ts";
import { findOrder } from "./orders/store.ts";
import type { OrderRow } from "./orders/types.ts";
import { pauseRefunds, refundsPaused, resumeRefunds } from "./refunds/executor.ts";
import { findOrderRefund, findRefundById, refundGroup } from "./refunds/request.ts";
import { testDb, type TestDb } from "./testing/db.ts";
import { startFakeChain } from "./testing/fake-chain.ts";
import { createFakeRpc } from "./testing/fake-rpc.ts";
import { testSigner } from "./testing/keys.ts";
import { seedOrder, seedPayment, seedSharedPayment } from "./testing/orders.ts";
import { withTx } from "./db/pool.ts";
import { usdcAta } from "./solana/accounts.ts";
import {
    resetLedger,
    seedAccount,
    seedAllowanceRefundRow,
    seedFunding,
    seedService,
    seedX402Payment,
    TEST_PAYTO,
} from "./testing/x402.ts";
import { isPayToBlocked, readControls, setControls } from "./x402/controls.ts";
import { openIncidents, recordIncident } from "./x402/incidents.ts";
import { readPool } from "./x402/ledger.ts";

let db: TestDb;
let dir: string;
let config: string;
const env = {};

beforeAll(async () => {
    db = await testDb();
    dir = mkdtempSync(join(tmpdir(), "bn-pay-cli-"));
    config = join(dir, "test.toml");
    const recipient = (await testSigner(1)).address;
    writeFileSync(config, stringify({ database: { url: db.url }, solana: { recipient } }));
});
beforeEach(async () => {
    await resetLedger(db.pool);
    await db.pool.query("update x402_tail set verified_slot = 0");
    await db.pool.query("truncate x402_incidents, x402_blocked_payto");
});
afterAll(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
});

function captureIo() {
    const out: string[] = [];
    const err: string[] = [];
    return {
        out: (s: string) => out.push(s),
        err: (s: string) => err.push(s),
        outText: () => out.join("\n"),
        errText: () => err.join("\n"),
    };
}

function cli(args: string[], io = captureIo(), o: CliOptions = {}): Promise<number> {
    return cliMain(["-config", config, ...args], env, io, o);
}

async function manualOrder(
    manualReason: string,
    refundState: "manual" | null,
    over: Partial<OrderRow> = {},
): Promise<OrderRow> {
    const { order } = await seedOrder(db.pool, { state: "manual", manualReason, ...over });
    await seedPayment(db.pool, order.id, {
        status: "confirmed",
        payer: "payer-cli",
        sourceTokenAccount: "source-cli",
    });
    if (refundState !== null) {
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                manual_reason, attempts)
             values ($1, 'full', 'unredeemed', $2, 'source-cli', 'payer-cli', $3, $4, 2)`,
            [order.id, order.amountMicros, refundState, manualReason],
        );
    }
    return order;
}

describe("cliMain", () => {
    it("lists, retries and resolves manual orders and resumes refunds", async () => {
        const manual = await manualOrder("refund_destination_invalid", "manual");
        const byHand = await manualOrder("refund_failed_onchain", "manual");
        const io = captureIo();
        expect(await cli(["manual", "list"], io)).toBe(0);
        expect(io.outText()).toContain(manual.id);
        const line = io
            .outText()
            .split("\n")
            .find((l) => l.startsWith(manual.id))!;
        expect(line.split("\t")).toEqual([
            manual.id,
            "refund_destination_invalid",
            "10000",
            "payer-cli",
            "source-cli",
        ]);

        expect(await cli(["manual", "retry", manual.id])).toBe(0);
        expect(await findOrder(db.pool, manual.id)).toMatchObject({
            state: "refunding",
            manualReason: null,
        });
        expect(await findOrderRefund(db.pool, manual.id)).toMatchObject({
            state: "pending",
            attempts: 0,
            manualReason: null,
        });

        expect(await cli(["manual", "resolve", byHand.id])).toBe(0);
        expect((await findOrder(db.pool, byHand.id))!.state).toBe("refunded");
        expect(await findOrderRefund(db.pool, byHand.id)).toMatchObject({
            state: "manual",
            manualReason: "resolved_by_hand",
        });

        const after = captureIo();
        expect(await cli(["manual", "list"], after)).toBe(0);
        expect(after.outText()).not.toContain(manual.id);
        expect(after.outText()).not.toContain(byHand.id);

        await pauseRefunds(db.pool, "daily_cap", silentLog);
        expect(await cli(["refunds", "resume"])).toBe(0);
        expect(await refundsPaused(db.pool)).toBeNull();
        expect(await cli(["manual"])).toBe(2);
    });

    it("manual retry creates the missing refund row for a parked order", async () => {
        const parked = await manualOrder("no_event_unverifiable", null, { amountMicros: 25_000 });
        expect(await findOrderRefund(db.pool, parked.id)).toBeNull();
        expect(await cli(["manual", "retry", parked.id])).toBe(0);
        expect(await findOrderRefund(db.pool, parked.id)).toMatchObject({
            kind: "full",
            reason: "operator",
            amountMicros: 25_000,
            destination: "source-cli",
            payer: "payer-cli",
            state: "pending",
            attempts: 0,
        });
        expect((await findOrder(db.pool, parked.id))!.state).toBe("refunding");
    });

    it.each(["refund_amount_pending", "refund_amount_invalid"])(
        "manual retry refuses an order parked %s and points to manual refund",
        async (reason) => {
            const parked = await manualOrder(reason, null);
            const io = captureIo();
            expect(await cli(["manual", "retry", parked.id], io)).toBe(1);
            expect(io.errText()).toContain(reason);
            expect(io.errText()).toContain(`manual refund ${parked.id} <amount_micros>`);
            expect(await findOrder(db.pool, parked.id)).toMatchObject({
                state: "manual",
                manualReason: reason,
            });
            expect(await findOrderRefund(db.pool, parked.id)).toBeNull();
        },
    );

    it("manual list shows the parked reason and no amount for an order without one", async () => {
        const pending = await manualOrder("refund_amount_pending", null);
        const invalid = await manualOrder("refund_amount_invalid", null);
        const io = captureIo();
        expect(await cli(["manual", "list"], io)).toBe(0);
        const lines = io.outText().split("\n");
        for (const [order, reason] of [
            [pending, "refund_amount_pending"],
            [invalid, "refund_amount_invalid"],
        ] as const) {
            expect(lines.find((l) => l.startsWith(order.id))!.split("\t")).toEqual([
                order.id,
                reason,
                "-",
                "payer-cli",
                "source-cli",
            ]);
        }
    });

    it("manual refund creates a partial refund and returns the order to refunding", async () => {
        const parked = await manualOrder("refund_amount_pending", null, { amountMicros: 25_000 });
        const io = captureIo();
        expect(await cli(["manual", "refund", parked.id, "7000"], io)).toBe(0);
        expect(io.outText()).toBe(`${parked.id}: refunding 7000 micros`);
        expect(await findOrderRefund(db.pool, parked.id)).toMatchObject({
            kind: "partial",
            reason: "operator",
            amountMicros: 7_000,
            destination: "source-cli",
            payer: "payer-cli",
            state: "pending",
        });
        expect(await findOrder(db.pool, parked.id)).toMatchObject({
            state: "refunding",
            manualReason: null,
        });

        const whole = await manualOrder("refund_amount_invalid", null, { amountMicros: 25_000 });
        expect(await cli(["manual", "refund", whole.id, "25000"])).toBe(0);
        expect((await findOrderRefund(db.pool, whole.id))!.amountMicros).toBe(25_000);
    });

    it("manual refund refuses an amount above the payment and orders it cannot refund", async () => {
        const parked = await manualOrder("refund_amount_invalid", null, { amountMicros: 25_000 });
        const over = captureIo();
        expect(await cli(["manual", "refund", parked.id, "25001"], over)).toBe(1);
        expect(over.errText()).toContain("more than the payment");
        expect(await findOrderRefund(db.pool, parked.id)).toBeNull();
        expect((await findOrder(db.pool, parked.id))!.state).toBe("manual");

        const withRow = await manualOrder("refund_destination_invalid", "manual");
        const exists = captureIo();
        expect(await cli(["manual", "refund", withRow.id, "5000"], exists)).toBe(1);
        expect(exists.errText()).toContain("manual retry");
        expect((await findOrderRefund(db.pool, withRow.id))!.amountMicros).toBe(10_000);

        const { order: paid } = await seedOrder(db.pool, { state: "paid" });
        const notQueued = captureIo();
        expect(await cli(["manual", "refund", paid.id, "5000"], notQueued)).toBe(1);
        expect(notQueued.errText()).toContain("not in the manual queue");
        expect(await findOrderRefund(db.pool, paid.id)).toBeNull();
    });

    it("manual dismiss returns a parked order to redeemed and refuses other reasons", async () => {
        const parked = await manualOrder("no_event_unverifiable", null);
        expect(await cli(["manual", "dismiss", parked.id])).toBe(0);
        expect(await findOrder(db.pool, parked.id)).toMatchObject({
            state: "redeemed",
            routerConfirmedAt: expect.any(Date),
            manualReason: null,
        });
        expect(await findOrderRefund(db.pool, parked.id)).toBeNull();

        const abandoned = await manualOrder("abandon_unverifiable", null);
        expect(await cli(["manual", "dismiss", abandoned.id])).toBe(0);
        expect((await findOrder(db.pool, abandoned.id))!.state).toBe("redeemed");

        const invalid = await manualOrder("refund_destination_invalid", "manual");
        const io = captureIo();
        expect(await cli(["manual", "dismiss", invalid.id], io)).toBe(1);
        expect(io.errText()).toContain("refund_destination_invalid");
        expect(await findOrder(db.pool, invalid.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_destination_invalid",
        });
    });

    it("reports whether refunds are paused", async () => {
        await resumeRefunds(db.pool);
        const running = captureIo();
        expect(await cli(["refunds", "status"], running)).toBe(0);
        expect(running.outText()).toBe("refunds running");

        await pauseRefunds(db.pool, "hourly_rate", silentLog);
        const paused = captureIo();
        expect(await cli(["refunds", "status"], paused)).toBe(0);
        expect(paused.outText()).toBe("refunds paused: hourly_rate");
        await resumeRefunds(db.pool);
    });

    it("refuses orders outside the manual queue and a refund still in flight", async () => {
        const { order: paid } = await seedOrder(db.pool, { state: "paid" });
        for (const action of ["retry", "dismiss", "resolve"]) {
            const io = captureIo();
            expect(await cli(["manual", action, paid.id], io)).toBe(1);
            expect(io.errText()).toContain("paid");
        }
        expect((await findOrder(db.pool, paid.id))!.state).toBe("paid");

        const unknown = captureIo();
        expect(await cli(["manual", "retry", "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa"], unknown)).toBe(1);
        expect(unknown.errText()).toContain("unknown order");

        const inFlight = await manualOrder("refund_destination_invalid", null);
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state)
             values ($1, 'full', 'unredeemed', 10000, 'source-cli', 'payer-cli', 'sent')`,
            [inFlight.id],
        );
        expect(await cli(["manual", "resolve", inFlight.id])).toBe(1);
        expect(await cli(["manual", "retry", inFlight.id])).toBe(1);
        expect((await findOrder(db.pool, inFlight.id))!.state).toBe("manual");
        expect((await findOrderRefund(db.pool, inFlight.id))!.state).toBe("sent");
    });

    it("answers bad usage with 2 before reading any config", async () => {
        const missing = join(dir, "missing.toml");
        for (const args of [
            [],
            ["manual"],
            ["manual", "list", "extra"],
            ["manual", "retry"],
            ["manual", "retry", "not-an-order"],
            ["manual", "refund", "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa"],
            ["manual", "refund", "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", "0"],
            ["manual", "refund", "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", "-5"],
            ["manual", "refund", "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", "1.5"],
            ["manual", "refund", "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", "9007199254740993"],
            ["manual", "refund", "not-an-order", "5000"],
            ["refunds", "pause"],
            ["bogus"],
        ]) {
            const io = captureIo();
            expect(await cliMain(["-config", missing, ...args], env, io)).toBe(2);
            expect(io.errText()).toContain("usage");
        }
        const io = captureIo();
        expect(await cliMain(["-config", missing, "manual", "list"], env, io)).toBe(1);
        expect(io.errText()).toContain(missing);
    });

    it("answers 2 when -config has no file after it", async () => {
        for (const argv of [["-config"], ["manual", "list", "-config"], ["--config"]]) {
            const io = captureIo();
            expect(await cliMain(argv, env, io)).toBe(2);
            expect(io.errText()).toContain("-config needs a file");
            expect(io.errText()).toContain("usage");
        }
    });
});

const SIG = (n: number) => getBase58Decoder().decode(new Uint8Array(64).fill(n));
const SIG63 = getBase58Decoder().decode(new Uint8Array(63).fill(1));
const REASON = {
    full: "operator",
    partial: "router_refundable",
    allowance: "x402_unspent",
} as const;

let handles = 0;

async function hotOrder(over: Partial<OrderRow> = {}): Promise<OrderRow> {
    const handleSha256 = (++handles).toString(16).padStart(64, "0");
    const { order } = await seedOrder(db.pool, {
        kind: "start",
        payInto: "allowance",
        amountMicros: 1_013_000,
        allowanceMicros: 1_000_000,
        feeMicros: 3_000,
        state: "redeemed",
        ...over,
    });
    await seedPayment(db.pool, order.id, {
        status: "confirmed",
        payer: "payer-cli",
        sourceTokenAccount: "source-cli",
    });
    await seedAccount(db.pool, { id: order.id, handleSha256, fundedMicros: 1_000_000 });
    await seedFunding(db.pool, {
        accountId: order.id,
        orderId: order.id,
        allowanceMicros: 1_000_000,
        payer: "payer-cli",
        sourceTokenAccount: "source-cli",
    });
    return order;
}

async function row(
    orderId: string,
    r: {
        kind: "full" | "partial" | "allowance";
        fromWallet: "refund" | "allowance";
        state: string;
        amountMicros: number;
        manualReason?: string | null;
        txSignature?: string | null;
        expirySeenSlot?: bigint;
    },
): Promise<number> {
    const res = await db.pool.query(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            from_wallet, manual_reason, tx_signature, expiry_seen_slot, attempts)
         values ($1, $2, $3, $4, 'source-cli', 'payer-cli', $5, $6, $7, $8, $9, 3) returning id`,
        [
            orderId,
            r.kind,
            REASON[r.kind],
            r.amountMicros,
            r.state,
            r.fromWallet,
            r.manualReason ?? null,
            r.txSignature ?? null,
            r.expirySeenSlot?.toString() ?? null,
        ],
    );
    return Number(res.rows[0].id);
}

const refundOf = async (id: number) => (await findRefundById(db.pool, id))!;
const absentRpc = () =>
    createFakeRpc({
        getSignatureStatuses: () => ({ context: { slot: 1_400n }, value: [null] }),
    });

describe("cliMain hot-wallet queue", () => {
    it("manual list shows hot rows by refund id", async () => {
        const o = await hotOrder();
        const listed = await row(o.id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 300_000,
            manualReason: "refund_destination_invalid",
        });
        const p = await hotOrder({ coldTransferId: 5 });
        const partial = await row(p.id, {
            kind: "partial",
            fromWallet: "refund",
            state: "manual",
            amountMicros: 13_000,
            manualReason: "refund_failed_onchain",
        });
        const h = await hotOrder();
        const byHand = await row(h.id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 1,
            manualReason: "resolved_by_hand",
        });
        const io = captureIo();
        expect(await cli(["manual", "list"], io)).toBe(0);
        const lines = io.outText().split("\n");
        expect(lines).toContain(
            [
                "refund",
                listed,
                "allowance",
                "part 0/1",
                "allowance",
                "manual",
                "refund_destination_invalid",
                "300000",
                "source-cli",
            ].join("\t"),
        );
        expect(lines).toContain(
            [
                "refund",
                partial,
                "partial",
                "part 0/1",
                "refund",
                "manual",
                "refund_failed_onchain",
                "13000",
                "source-cli",
            ].join("\t"),
        );
        expect(lines.some((l) => l.startsWith(`refund\t${byHand}\t`))).toBe(false);
    });

    it("retry by refund id waits for the proof on an allowance row, then resets it", async () => {
        const o = await hotOrder();
        const id = await row(o.id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 300_000,
            manualReason: "refund_expired_repeatedly",
            txSignature: SIG(1),
            expirySeenSlot: 1_000n,
        });
        await db.pool.query("update x402_tail set verified_slot = 1299");
        const io = captureIo();
        expect(await cli(["manual", "retry", String(id)], io, { rpc: absentRpc() })).toBe(1);
        expect(io.errText()).toContain(
            `refund ${id}: its last transaction is not yet proven absent`,
        );
        expect((await refundOf(id)).state).toBe("manual");
        await db.pool.query("update x402_tail set verified_slot = 1300");
        const ok = captureIo();
        expect(await cli(["manual", "retry", String(id)], ok, { rpc: absentRpc() })).toBe(0);
        expect(ok.outText()).toBe(`refund ${id}: pending`);
        expect(await refundOf(id)).toMatchObject({
            state: "pending",
            attempts: 0,
            budgetWaived: true,
            manualReason: null,
            txSignature: SIG(1),
        });
    });

    it("retry by refund id refuses a row the listing does not name", async () => {
        const o = await hotOrder({ state: "manual", manualReason: "refund_destination_invalid" });
        const id = await row(o.id, {
            kind: "full",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 1_013_000,
            manualReason: "refund_destination_invalid",
        });
        const io = captureIo();
        expect(await cli(["manual", "retry", String(id)], io)).toBe(1);
        expect(io.errText()).toContain("use the order-level command");
        const unknown = captureIo();
        expect(await cli(["manual", "retry", "999999"], unknown)).toBe(1);
        expect(unknown.errText()).toContain("refund 999999: unknown refund");
    });

    it("needs BUGNET_SOLANA_RPC_URL for a proof", async () => {
        const o = await hotOrder();
        const id = await row(o.id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 1,
            txSignature: SIG(2),
            expirySeenSlot: 1n,
        });
        const io = captureIo();
        expect(await cli(["manual", "retry", String(id)], io)).toBe(1);
        expect(io.errText()).toContain(
            "BUGNET_SOLANA_RPC_URLS or BUGNET_SOLANA_RPC_URL must be set",
        );
    });

    it("manual resolve <refundId> --tx on a pending row while refunds are held", async () => {
        const o = await hotOrder();
        const id = await row(o.id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "pending",
            amountMicros: 300_000,
        });
        await db.pool.query("update x402_pool set committed_micros = 1000000");
        const notHeld = captureIo();
        expect(await cli(["manual", "resolve", String(id), "--tx", SIG(7)], notHeld)).toBe(1);
        expect(notHeld.errText()).toContain("pending rows only while refunds are held");
        await setControls(db.pool, { refundsHeld: true }, "leak", new Date());
        const io = captureIo();
        expect(await cli(["manual", "resolve", String(id), "--tx", SIG(7)], io)).toBe(0);
        expect(io.outText()).toBe(`refund ${id}: resolved by hand`);
        expect(await refundOf(id)).toMatchObject({
            state: "manual",
            manualReason: "resolved_by_hand",
            handTx: SIG(7),
            confirmedAt: expect.any(Date),
        });
        const ev = await db.pool.query(
            "select payload from x402_router_events where kind = 'allowance' and order_id = $1 and phase = 'refunded'",
            [o.id],
        );
        expect(ev.rows[0].payload).toMatchObject({ amountMicros: 300_000, tx: SIG(7) });
        expect((await readPool(db.pool)).committedMicros).toBe(700_000);
    });

    it("manual resolve <refundId> --tx on a manual row waits for the proof", async () => {
        const o = await hotOrder();
        const id = await row(o.id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 300_000,
            manualReason: "refund_expired_repeatedly",
            txSignature: SIG(3),
            expirySeenSlot: 1_000n,
        });
        await db.pool.query("update x402_pool set committed_micros = 1000000");
        await db.pool.query("update x402_tail set verified_slot = 1299");
        const io = captureIo();
        expect(
            await cli(["manual", "resolve", String(id), "--tx", SIG(8)], io, { rpc: absentRpc() }),
        ).toBe(1);
        expect(io.errText()).toContain("its last transaction is not yet proven absent");
        expect((await refundOf(id)).handTx).toBeNull();
        await db.pool.query("update x402_tail set verified_slot = 1300");
        expect(
            await cli(["manual", "resolve", String(id), "--tx", SIG(8)], captureIo(), {
                rpc: absentRpc(),
            }),
        ).toBe(0);
        expect(await refundOf(id)).toMatchObject({
            state: "manual",
            manualReason: "resolved_by_hand",
            handTx: SIG(8),
        });
        expect((await readPool(db.pool)).committedMicros).toBe(700_000);
    });

    it("manual resolve <refundId> --tx refuses a 63-byte signature", async () => {
        const o = await hotOrder();
        const id = await row(o.id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "pending",
            amountMicros: 300_000,
        });
        await setControls(db.pool, { refundsHeld: true }, "leak", new Date());
        const io = captureIo();
        expect(await cli(["manual", "resolve", String(id), "--tx", SIG63], io)).toBe(1);
        expect(io.errText()).toContain("not a 64-byte signature");
        expect((await refundOf(id)).state).toBe("pending");
    });

    it("manual resolve --tx refuses a refund-wallet row and one the executor owns", async () => {
        const o = await hotOrder({ coldTransferId: 5 });
        const wallet = await row(o.id, {
            kind: "partial",
            fromWallet: "refund",
            state: "manual",
            amountMicros: 13_000,
            manualReason: "refund_failed_onchain",
        });
        const io = captureIo();
        expect(await cli(["manual", "resolve", String(wallet), "--tx", SIG(4)], io)).toBe(1);
        expect(io.errText()).toContain(
            `refund ${wallet}: a refund-wallet row: use manual resolve ${wallet} without --tx`,
        );
        const sent = await row((await hotOrder()).id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "sent",
            amountMicros: 1,
        });
        const owned = captureIo();
        expect(await cli(["manual", "resolve", String(sent), "--tx", SIG(4)], owned)).toBe(1);
        expect(owned.errText()).toContain(
            `refund ${sent}: its refund is sent and the executor still owns it`,
        );
    });

    it("manual resolve without --tx on a refund-wallet partial", async () => {
        const o = await hotOrder({ coldTransferId: 5 });
        const id = await row(o.id, {
            kind: "partial",
            fromWallet: "refund",
            state: "manual",
            amountMicros: 13_000,
            manualReason: "refund_failed_onchain",
        });
        expect(await cli(["manual", "resolve", String(id)])).toBe(0);
        expect(await refundOf(id)).toMatchObject({
            state: "manual",
            manualReason: "resolved_by_hand",
        });
        expect((await findOrder(db.pool, o.id))!.state).toBe("redeemed");
        const a = await row((await hotOrder()).id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 1,
            manualReason: "x402_refund_budget",
        });
        const io = captureIo();
        expect(await cli(["manual", "resolve", String(a)], io)).toBe(1);
        expect(io.errText()).toContain(`manual resolve ${a} --tx <signature>`);
    });

    it("manual resolve <orderId> on a hot order's row points to the refund id form", async () => {
        const o = await hotOrder({ state: "manual", manualReason: "refund_destination_invalid" });
        const id = await row(o.id, {
            kind: "full",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 1_013_000,
            manualReason: "refund_destination_invalid",
        });
        const io = captureIo();
        expect(await cli(["manual", "resolve", o.id], io)).toBe(1);
        expect(io.errText()).toContain(`hot-wallet refund: use manual resolve ${id}`);
        expect((await findOrder(db.pool, o.id))!.state).toBe("manual");
    });

    it("manual retry <orderId> resets a hot order's full row after the proof", async () => {
        const o = await hotOrder({ state: "manual", manualReason: "refund_destination_invalid" });
        const id = await row(o.id, {
            kind: "full",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 1_013_000,
            manualReason: "refund_destination_invalid",
        });
        expect(await cli(["manual", "retry", o.id])).toBe(0);
        expect(await refundOf(id)).toMatchObject({
            state: "pending",
            attempts: 0,
            budgetWaived: true,
            manualReason: null,
        });
        expect(await findOrder(db.pool, o.id)).toMatchObject({
            state: "refunding",
            manualReason: null,
        });
    });

    it("manual retry <orderId> points a hot order's partial row to its refund id", async () => {
        const o = await hotOrder({ coldTransferId: 5 });
        const id = await row(o.id, {
            kind: "partial",
            fromWallet: "refund",
            state: "manual",
            amountMicros: 13_000,
            manualReason: "refund_failed_onchain",
        });
        const io = captureIo();
        expect(await cli(["manual", "retry", o.id], io)).toBe(1);
        expect(io.errText()).toContain(`hot-wallet refund: use manual retry ${id}`);
    });

    it("manual retry <orderId> on a hot order whose share went to cold exits 1", async () => {
        const o = await hotOrder({
            state: "manual",
            manualReason: "refund_destination_invalid",
            coldTransferId: 5,
        });
        const io = captureIo();
        expect(await cli(["manual", "retry", o.id], io)).toBe(1);
        expect(io.errText()).toContain("share already transferred to cold; refund by hand");
        expect(await findOrderRefund(db.pool, o.id)).toBeNull();
    });

    it("manual refund on a hot order writes a budget-waived partial and returns it to redeemed", async () => {
        const o = await hotOrder({ state: "manual", manualReason: "refund_amount_pending" });
        const io = captureIo();
        expect(await cli(["manual", "refund", o.id, "13001"], io)).toBe(1);
        expect(io.errText()).toContain(
            "invalid_amount: above amount_micros - allowance_micros (13000)",
        );
        expect(await cli(["manual", "refund", o.id, "13000"])).toBe(0);
        expect(await findOrderRefund(db.pool, o.id)).toMatchObject({
            kind: "partial",
            amountMicros: 13_000,
            fromWallet: "allowance",
            budgetWaived: true,
        });
        expect((await findOrder(db.pool, o.id))!.state).toBe("redeemed");
    });

    it("a retry or resolve of a row resolved by hand exits 1", async () => {
        const o = await hotOrder();
        const id = await row(o.id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 1,
            manualReason: "resolved_by_hand",
        });
        for (const args of [
            ["manual", "retry", String(id)],
            ["manual", "resolve", String(id), "--tx", SIG(8)],
        ]) {
            const io = captureIo();
            expect(await cli(args, io)).toBe(1);
            expect(io.errText()).toContain(`refund ${id}: resolved by hand`);
        }
    });

    it("manual resolve <orderId> --tx is a usage error", async () => {
        const o = await hotOrder({ state: "manual", manualReason: "refund_destination_invalid" });
        const io = captureIo();
        expect(await cli(["manual", "resolve", o.id, "--tx", SIG(1)], io)).toBe(2);
        expect(io.errText()).toContain("--tx belongs to a refund id");
        expect((await findOrder(db.pool, o.id))!.state).toBe("manual");
    });

    it("a landed proof says the refund was paid on chain", async () => {
        const o = await hotOrder();
        const id = await row(o.id, {
            kind: "allowance",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 300_000,
            manualReason: "refund_expired_repeatedly",
            txSignature: SIG(1),
            expirySeenSlot: 1_000n,
        });
        await db.pool.query(
            `insert into x402_chain_txs (signature, slot, delta_micros, failed, matched)
             values ($1, 1100, 0, false, 'no_effect')`,
            [SIG(1)],
        );
        for (const args of [
            ["manual", "retry", String(id)],
            ["manual", "resolve", String(id), "--tx", SIG(8)],
        ]) {
            const io = captureIo();
            expect(await cli(args, io, { rpc: absentRpc() })).toBe(1);
            expect(io.errText()).toContain("paid on chain");
            expect(io.errText()).toContain("confirm path");
            expect(io.errText()).not.toContain("not yet proven absent");
        }
        expect((await refundOf(id)).state).toBe("manual");
        await db.pool.query("delete from x402_chain_txs where signature = $1", [SIG(1)]);
    });

    it("retry and resolve by refund id refuse a row whose signatures changed after the proof", async () => {
        for (const args of [
            (id: number) => ["manual", "retry", String(id)],
            (id: number) => ["manual", "resolve", String(id), "--tx", SIG(8)],
        ]) {
            const o = await hotOrder();
            const id = await row(o.id, {
                kind: "allowance",
                fromWallet: "allowance",
                state: "manual",
                amountMicros: 300_000,
                manualReason: "refund_expired_repeatedly",
                txSignature: SIG(1),
                expirySeenSlot: 1_000n,
            });
            await db.pool.query("update x402_tail set verified_slot = 1300");
            await db.pool.query("update x402_pool set committed_micros = 1000000");
            const racing = createFakeRpc({
                getSignatureStatuses: async () => {
                    await db.pool.query(
                        "update refunds set tx_signature = $2, previous_signatures = array[$3] where id = $1",
                        [id, SIG(20 + id), SIG(1)],
                    );
                    return { context: { slot: 1_400n }, value: [null] };
                },
            });
            const io = captureIo();
            expect(await cli(args(id), io, { rpc: racing })).toBe(1);
            expect(io.errText()).toContain(
                args(id)[1] === "retry"
                    ? `refund ${id}: changed while retrying`
                    : `refund ${id}: changed while resolving`,
            );
            expect(await refundOf(id)).toMatchObject({ state: "manual", handTx: null });
        }
    });

    it("manual retry <orderId> on a hot full row refuses a proof that is not absent", async () => {
        const o = await hotOrder({ state: "manual", manualReason: "refund_expired_repeatedly" });
        const id = await row(o.id, {
            kind: "full",
            fromWallet: "allowance",
            state: "manual",
            amountMicros: 1_013_000,
            manualReason: "refund_expired_repeatedly",
            txSignature: SIG(1),
            expirySeenSlot: 1_000n,
        });
        await db.pool.query("update x402_tail set verified_slot = 1299");
        const io = captureIo();
        expect(await cli(["manual", "retry", o.id], io, { rpc: absentRpc() })).toBe(1);
        expect(io.errText()).toContain(`${o.id}: its last transaction is not yet proven absent`);
        expect((await refundOf(id)).state).toBe("manual");
        expect((await findOrder(db.pool, o.id))!.state).toBe("manual");
    });

    it("manual retry and resolve <orderId> refuse a row resolved by hand", async () => {
        const o = await hotOrder({ state: "manual", manualReason: "refund_destination_invalid" });
        await row(o.id, {
            kind: "full",
            fromWallet: "refund",
            state: "manual",
            amountMicros: 1_013_000,
            manualReason: "resolved_by_hand",
        });
        const cold = await manualOrder("refund_failed_onchain", "manual");
        await db.pool.query(
            "update refunds set manual_reason = 'resolved_by_hand' where order_id = $1",
            [cold.id],
        );
        for (const id of [o.id, cold.id]) {
            for (const verb of ["retry", "resolve"]) {
                const io = captureIo();
                expect(await cli(["manual", verb, id], io)).toBe(1);
                expect(io.errText()).toContain(`${id}: resolved by hand`);
            }
        }
    });

    it("takes --tx only on manual resolve", async () => {
        for (const args of [
            ["manual", "retry", "5", "--tx", SIG(1)],
            ["manual", "resolve", "5", "--tx"],
            ["manual", "resolve", "5", "--tx", SIG(1), "--tx", SIG(2)],
            ["manual", "resolve", "0"],
        ]) {
            const io = captureIo();
            expect(await cli(args, io)).toBe(2);
            expect(io.errText()).toContain("usage");
        }
    });
});

describe("cliMain refund groups", () => {
    type Part = {
        state: string;
        manualReason?: string | null;
        fromWallet?: "refund" | "allowance";
    };

    // A manual order of 50,000 paid by OwnA (30,000, SrcA) and OwnB (20,000, SrcB), its full
    // refund split in two parts with the given states
    async function sharedManual(
        parts: readonly Part[] | null,
        over: Partial<OrderRow> = {},
    ): Promise<{ order: OrderRow; ids: number[] }> {
        const { order } = await seedOrder(db.pool, {
            state: "manual",
            manualReason: "refund_destination_invalid",
            amountMicros: 50_000,
            ...over,
        });
        await seedSharedPayment(db.pool, order.id);
        const ids: number[] = [];
        for (const [part, p] of (parts ?? []).entries()) {
            const res = await db.pool.query(
                `insert into refunds (order_id, kind, part, reason, amount_micros, destination,
                    payer, state, from_wallet, manual_reason, attempts)
                 values ($1, 'full', $2, 'unredeemed', $3, $4, $5, $6, $7, $8, 3) returning id`,
                [
                    order.id,
                    part,
                    part === 0 ? 30_000 : 20_000,
                    part === 0 ? "SrcA" : "SrcB",
                    part === 0 ? "OwnA" : "OwnB",
                    p.state,
                    p.fromWallet ?? "refund",
                    p.manualReason ?? (p.state === "manual" ? "refund_destination_invalid" : null),
                ],
            );
            ids.push(Number(res.rows[0].id));
        }
        return { order, ids };
    }

    async function depositRow(orderId: string, state = "manual"): Promise<number> {
        const res = await db.pool.query(
            `insert into refunds (order_id, kind, part, reason, amount_micros, destination, payer,
                state, from_wallet, deposit_signature, manual_reason)
             values ($1, 'deposit', 0, 'deposit_held', 7000, 'DstA', 'PayA', $2, 'refund',
                'held-1', $3) returning id`,
            [orderId, state, state === "manual" ? "refund_destination_invalid" : null],
        );
        return Number(res.rows[0].id);
    }

    const partStates = async (orderId: string) =>
        (await refundGroup(db.pool, orderId, "full")).map((r) => [r.state, r.manualReason]);

    it("manual list prints every part", async () => {
        const { order, ids } = await sharedManual([{ state: "confirmed" }, { state: "manual" }]);
        const { order: paid } = await seedOrder(db.pool, { state: "paid" });
        const held = await depositRow(paid.id);
        const io = captureIo();
        expect(await cli(["manual", "list"], io)).toBe(0);
        const lines = io.outText().split("\n");
        expect(lines.find((l) => l.startsWith(order.id))!.split("\t")).toEqual([
            order.id,
            "refund_destination_invalid",
            "50000",
            "OwnA",
            "SrcA",
        ]);
        expect(lines).toContain(
            [
                "refund",
                ids[1],
                "full",
                "part 1/2",
                "refund",
                "manual",
                "refund_destination_invalid",
                "20000",
                "SrcB",
            ].join("\t"),
        );
        expect(lines.some((l) => l.startsWith(`refund\t${ids[0]}\t`))).toBe(false);
        expect(lines).toContain(
            [
                "refund",
                held,
                "deposit",
                "part 0/1",
                "refund",
                "manual",
                "refund_destination_invalid",
                "7000",
                "DstA",
            ].join("\t"),
        );
    });

    it("one bad destination stops only its own part", async () => {
        const { order, ids } = await sharedManual([{ state: "confirmed" }, { state: "manual" }]);
        expect(await cli(["manual", "retry", order.id])).toBe(0);
        expect(await partStates(order.id)).toEqual([
            ["confirmed", null],
            ["pending", null],
        ]);
        expect((await refundOf(ids[1]!)).attempts).toBe(0);
        expect(await findOrder(db.pool, order.id)).toMatchObject({
            state: "refunding",
            manualReason: null,
        });

        await db.pool.query(
            `update refunds set state = 'manual', manual_reason = 'refund_destination_invalid'
             where id = $1`,
            [ids[1]],
        );
        await db.pool.query(
            `update orders set state = 'manual', manual_reason = 'refund_destination_invalid'
             where id = $1`,
            [order.id],
        );
        const io = captureIo();
        expect(await cli(["manual", "retry", String(ids[1])], io)).toBe(0);
        expect(io.outText()).toBe(`refund ${ids[1]}: pending`);
        expect(await partStates(order.id)).toEqual([
            ["confirmed", null],
            ["pending", null],
        ]);
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
    });

    it("manual resolve <orderId> marks every open part of a cold group", async () => {
        const both = await sharedManual([{ state: "manual" }, { state: "manual" }]);
        expect(await cli(["manual", "resolve", both.order.id])).toBe(0);
        expect(await partStates(both.order.id)).toEqual([
            ["manual", "resolved_by_hand"],
            ["manual", "resolved_by_hand"],
        ]);
        expect((await findOrder(db.pool, both.order.id))!.state).toBe("refunded");

        const sent = await sharedManual([{ state: "manual" }, { state: "sent" }]);
        const inFlight = captureIo();
        expect(await cli(["manual", "resolve", sent.order.id], inFlight)).toBe(1);
        expect(inFlight.errText()).toContain("sent and the executor still owns it");
        expect(await partStates(sent.order.id)).toEqual([
            ["manual", "refund_destination_invalid"],
            ["sent", null],
        ]);
        expect((await findOrder(db.pool, sent.order.id))!.state).toBe("manual");

        const hot = await sharedManual(
            [
                { state: "confirmed", fromWallet: "allowance" },
                { state: "manual", fromWallet: "allowance" },
            ],
            { payInto: "allowance", kind: "start", allowanceMicros: 20_000 },
        );
        const refused = captureIo();
        expect(await cli(["manual", "resolve", hot.order.id], refused)).toBe(1);
        expect(refused.errText()).toContain(`manual resolve ${hot.ids[1]} --tx`);
        expect(refused.errText()).not.toContain(`manual resolve ${hot.ids[0]}`);
        expect(await partStates(hot.order.id)).toEqual([
            ["confirmed", null],
            ["manual", "refund_destination_invalid"],
        ]);
        expect((await findOrder(db.pool, hot.order.id))!.state).toBe("manual");
    });

    it("a cold part resolved by hand completes the group when it is the last", async () => {
        const last = await sharedManual([{ state: "confirmed" }, { state: "manual" }]);
        expect(await cli(["manual", "resolve", String(last.ids[1])])).toBe(0);
        expect((await findOrder(db.pool, last.order.id))!.state).toBe("refunded");

        // With a part still in flight the order goes back to refunding for the executor to finish
        const flying = await sharedManual([{ state: "sent" }, { state: "manual" }]);
        expect(await cli(["manual", "resolve", String(flying.ids[1])])).toBe(0);
        expect(await findOrder(db.pool, flying.order.id)).toMatchObject({
            state: "refunding",
            manualReason: null,
        });
    });

    it("manual refund splits", async () => {
        const { order } = await sharedManual(null, { manualReason: "refund_amount_pending" });
        const io = captureIo();
        expect(await cli(["manual", "refund", order.id, "10000"], io)).toBe(0);
        expect(io.outText()).toBe(`${order.id}: refunding 10000 micros`);
        expect(
            (await refundGroup(db.pool, order.id, "partial")).map((r) => [
                r.part,
                r.amountMicros,
                r.destination,
                r.state,
            ]),
        ).toEqual([
            [0, 6_000, "SrcA", "pending"],
            [1, 4_000, "SrcB", "pending"],
        ]);
        expect((await findOrder(db.pool, order.id))!.state).toBe("refunding");
    });

    it("a manual deposit row can be retried and resolved", async () => {
        const { order } = await seedOrder(db.pool, { state: "paid" });
        const id = await depositRow(order.id);
        const retried = captureIo();
        expect(await cli(["manual", "retry", String(id)], retried)).toBe(0);
        expect(retried.outText()).toBe(`refund ${id}: pending`);
        expect(await refundOf(id)).toMatchObject({ state: "pending", manualReason: null });
        await db.pool.query(
            "update refunds set state = 'manual', manual_reason = 'refund_failed_onchain' where id = $1",
            [id],
        );
        const resolved = captureIo();
        expect(await cli(["manual", "resolve", String(id)], resolved)).toBe(0);
        expect(resolved.outText()).toBe(`refund ${id}: resolved by hand`);
        expect(await refundOf(id)).toMatchObject({
            state: "manual",
            manualReason: "resolved_by_hand",
        });
        expect((await findOrder(db.pool, order.id))!.state).toBe("paid");
    });
});

describe("the x402 operator commands", () => {
    const controls = () => readControls(db.pool);

    it("pause, resume, kill and unkill change the row", async () => {
        expect(await cli(["x402", "pause", "audit"])).toBe(0);
        expect(await controls()).toMatchObject({ paused: true, reason: "audit" });
        expect(await cli(["x402", "resume"])).toBe(0);
        expect((await controls()).paused).toBe(false);
        expect(await cli(["x402", "kill"])).toBe(0);
        expect(await controls()).toMatchObject({ disabled: true, reason: "x402 kill" });
        expect(await cli(["x402", "unkill"])).toBe(0);
        expect(await controls()).toMatchObject({ disabled: false, reason: null });
    });

    it("unkill keeps the pause reason while the pause stays set", async () => {
        expect(await cli(["x402", "pause", "audit"])).toBe(0);
        expect(await cli(["x402", "kill"])).toBe(0);
        expect(await cli(["x402", "unkill"])).toBe(0);
        expect(await controls()).toMatchObject({ paused: true, disabled: false, reason: "audit" });
        expect(await cli(["x402", "refunds", "hold"])).toBe(0);
        expect(await cli(["x402", "resume"])).toBe(0);
        expect(await controls()).toMatchObject({ paused: false, refundsHeld: true });
        expect((await controls()).reason).not.toBeNull();
        expect(await cli(["x402", "refunds", "release"])).toBe(0);
        expect((await controls()).reason).toBeNull();
    });

    it("pause rejects an empty or control-character reason", async () => {
        expect(await cli(["x402", "pause", ""])).toBe(2);
        expect(await cli(["x402", "pause", "a\nb"])).toBe(2);
        expect((await controls()).paused).toBe(false);
    });

    it("resume exits 1 while an incident is unresolved, then works after incident resolve", async () => {
        await withTx(db.pool, (c) =>
            recordIncident(
                c,
                { kind: "mirror_gap", subject: SIG(4), detail: {} },
                silentLog,
                new Date(),
            ),
        );
        const [inc] = await openIncidents(db.pool);
        const io = captureIo();
        expect(await cli(["x402", "resume"], io)).toBe(1);
        expect(io.errText()).toContain(`unresolved incident ${inc!.id} mirror_gap`);
        expect((await controls()).paused).toBe(true);
        expect(
            await cli(["x402", "incident", "resolve", String(inc!.id), "rpc history lagged"]),
        ).toBe(0);
        expect(await cli(["x402", "resume"])).toBe(0);
        expect((await controls()).paused).toBe(false);
        const again = captureIo();
        expect(await cli(["x402", "incident", "resolve", String(inc!.id), "again"], again)).toBe(1);
        expect(again.errText()).toContain("unknown or resolved incident");
    });

    it('block-payto refuses "0OIl" and blocks a canonical address; unblock-payto', async () => {
        expect(await cli(["x402", "block-payto", "0OIl", "scam"])).toBe(1);
        expect(await cli(["x402", "block-payto", TEST_PAYTO, "scam"])).toBe(0);
        expect(await isPayToBlocked(db.pool, TEST_PAYTO)).toBe(true);
        expect(await cli(["x402", "unblock-payto", TEST_PAYTO])).toBe(0);
        expect(await isPayToBlocked(db.pool, TEST_PAYTO)).toBe(false);
        const io = captureIo();
        expect(await cli(["x402", "unblock-payto", TEST_PAYTO], io)).toBe(0);
        expect(io.outText()).toBe(`${TEST_PAYTO}: was not blocked`);
    });

    it("re-blocking an address updates its reason; unblock refuses a non-address", async () => {
        expect(await cli(["x402", "block-payto", TEST_PAYTO, "first"])).toBe(0);
        expect(await cli(["x402", "block-payto", TEST_PAYTO, "second"])).toBe(0);
        const { rows } = await db.pool.query("select reason from x402_blocked_payto");
        expect(rows).toEqual([{ reason: "second" }]);
        const io = captureIo();
        expect(await cli(["x402", "unblock-payto", "0OIl"], io)).toBe(1);
        expect(io.errText()).toContain("not a 32-byte address");
        expect(await isPayToBlocked(db.pool, TEST_PAYTO)).toBe(true);
    });

    it("service reset sets enabled and failures 0", async () => {
        const a = await seedAccount(db.pool, {});
        const s = await seedService(db.pool, {
            accountId: a.id,
            serviceId: "xs_w5a4htopmpzmmhos",
            state: "unreliable",
            failures: 3,
        });
        expect(await cli(["x402", "service", "reset", a.id, s.serviceId])).toBe(0);
        const row = (
            await db.pool.query("select state, failures from x402_services where account_id = $1", [
                a.id,
            ])
        ).rows[0];
        expect(row).toEqual({ state: "enabled", failures: 0 });
        const io = captureIo();
        expect(await cli(["x402", "service", "reset", a.id, "xs_beynw7muaoanyeri"], io)).toBe(1);
        expect(io.errText()).toContain("unknown service");
    });

    it("refunds hold and release flip refunds_held", async () => {
        expect(await cli(["x402", "refunds", "hold"])).toBe(0);
        expect(await controls()).toMatchObject({
            refundsHeld: true,
            reason: "x402 refunds hold",
        });
        expect(await cli(["x402", "refunds", "release"])).toBe(0);
        expect((await controls()).refundsHeld).toBe(false);
    });

    it("incident list prints kind, subject, loss and detail", async () => {
        await withTx(db.pool, (c) =>
            recordIncident(
                c,
                {
                    kind: "unknown_change",
                    subject: SIG(5),
                    lossMicros: 5_000,
                    detail: { deltaMicros: "-5000" },
                },
                silentLog,
                new Date(),
            ),
        );
        const io = captureIo();
        expect(await cli(["x402", "incident", "list"], io)).toBe(0);
        const cells = io
            .outText()
            .split("\n")
            .find((l) => l.includes(SIG(5)))!
            .split("\t");
        expect(cells[1]).toBe("unknown_change");
        expect(cells[2]).toBe(SIG(5));
        expect(cells[3]).toBe("5000");
        expect(JSON.parse(cells[5]!)).toEqual({ deltaMicros: "-5000" });
    });

    it("x402 status runs without an RPC URL", async () => {
        const io = captureIo();
        expect(await cli(["x402", "status"], io)).toBe(0);
        expect(io.outText()).toContain("chain balance: unavailable");
    });

    describe("ledger-check", () => {
        async function fixture(chainMicros: bigint, refunded: number) {
            const chain = await startFakeChain();
            const payTo = await usdcAta((await testSigner(41)).address);
            chain.setTokenAccount({
                address: payTo,
                owner: (await testSigner(41)).address,
                amount: 0n,
            });
            const account = await seedAccount(db.pool, {
                state: "closed",
                fundedMicros: 1_000_000,
                spentMicros: 10_000,
                refundedMicros: refunded,
            });
            const funding = await seedFunding(db.pool, {
                accountId: account.id,
                allowanceMicros: 1_000_000,
            });
            await db.pool.query("update x402_accounts set funded_micros = 1000000 where id = $1", [
                account.id,
            ]);
            await seedX402Payment(db.pool, {
                accountId: account.id,
                state: "confirmed",
                amountMicros: 10_000,
                payToTokenAccount: payTo,
                txSignature: chain.credit(payTo, chainMicros),
            });
            await seedAllowanceRefundRow(db.pool, funding.orderId, {
                amountMicros: 990_000,
                destination: "dest-test",
                state: "manual",
                manualReason: "resolved_by_hand",
                handTx: "3".repeat(64),
            });
            return { chain, account };
        }

        it("exits 1 on a mismatch and 0 when the ledger matches", async () => {
            const bad = await fixture(10_001n, 990_000);
            try {
                const io = captureIo();
                const env = { BUGNET_SOLANA_RPC_URL: bad.chain.url };
                expect(
                    await cliMain(
                        ["-config", config, "x402", "ledger-check", bad.account.id],
                        env,
                        io,
                    ),
                ).toBe(1);
                expect(io.outText()).toMatch(/payment \S+ MISMATCH ledger=10000 chain=10001/);
            } finally {
                await bad.chain.close();
            }
            await resetLedger(db.pool);
            const good = await fixture(10_000n, 990_000);
            try {
                const io = captureIo();
                const env = { BUGNET_SOLANA_RPC_URL: good.chain.url };
                expect(
                    await cliMain(
                        ["-config", config, "x402", "ledger-check", good.account.id],
                        env,
                        io,
                    ),
                ).toBe(0);
                expect(io.outText()).toContain(
                    `account ${good.account.id} funded=1000000 spent=10000 refunded=990000 kept=0 ok`,
                );
            } finally {
                await good.chain.close();
            }
        });

        it("exits 2 for a non account id and 1 without an RPC URL", async () => {
            expect(await cli(["x402", "ledger-check", "nope"])).toBe(2);
            const account = await seedAccount(db.pool, {});
            const io = captureIo();
            expect(await cli(["x402", "ledger-check", account.id], io)).toBe(1);
            expect(io.errText()).toContain(
                "BUGNET_SOLANA_RPC_URLS or BUGNET_SOLANA_RPC_URL must be set",
            );
        });
    });
});

describe("rpc commands", () => {
    const NOW = new Date("2026-11-10T14:00:20.000Z");
    function endpoint(over: Partial<EndpointSnapshot> = {}): EndpointSnapshot {
        return {
            name: "rpc1",
            roles: ["read", "history", "send"],
            state: "ok",
            untilMs: null,
            latencyMs: 84,
            errorRate: 0,
            inflight: 0,
            confirmedSlot: "467621707",
            lag: 0,
            consistent: "yes",
            limits: {},
            monthRequests: 412334,
            monthBackground: 127824,
            hourRequests: 10,
            laneRequests: { money: 5, background: 5 },
            outcomes: {},
            checks: { genesis: "ok", history: "ok", pinnedAccounts: "ok", pinnedSignatures: "ok" },
            lastError: null,
            ...over,
        };
    }
    function snapshot(endpoints: EndpointSnapshot[]): RouterSnapshot {
        return {
            at: NOW.getTime(),
            mode: endpoints.length > 1 ? "routed" : "single",
            serving: "rpc1",
            domains: 3,
            absenceQuorum: 2,
            sendFanout: 1,
            endpoints,
        };
    }
    const fiveSecondsAgo = new Date(NOW.getTime() - 5_000);

    it("rpc status prints one line per endpoint", () => {
        expect(formatRpcStatus(snapshot([endpoint()]), fiveSecondsAgo, NOW, false)).toEqual([
            "snapshot: 2026-11-10T14:00:15.000Z (age 5s)",
            "serving: rpc1  domains: 3  quorum: 2  copies: 1",
            "rpc1  state: ok  roles: read history send  latency: 84ms  errors: 0%  slot: 467621707  lag: 0  month: 412334  background: 31%  limits: none  genesis: ok  history: ok  consistent: yes  pinned-accounts: ok  pinned-signatures: ok",
        ]);
    });

    it("rpc status shows cooling with its seconds", () => {
        const e = endpoint({ state: "cooling", untilMs: NOW.getTime() + 7_000 });
        const [, , line] = formatRpcStatus(snapshot([e]), fiveSecondsAgo, NOW, false);
        expect(line).toContain("state: cooling 7s");
    });

    it("rpc status shows an inconsistent endpoint", () => {
        const e = endpoint({
            consistent: "no",
            roles: ["read", "send"],
            checks: {
                genesis: "ok",
                history: "missing",
                pinnedAccounts: "ok",
                pinnedSignatures: "ok",
            },
        });
        const [, , line] = formatRpcStatus(snapshot([e]), fiveSecondsAgo, NOW, false);
        expect(line).toContain("consistent: no");
        expect(line).toContain("roles: read send");
        expect(line).toContain("history: missing");
    });

    it("rpc status shows learned limits", () => {
        const e = endpoint({ limits: { getTransaction: 8, "*": 80 } });
        const [, , line] = formatRpcStatus(snapshot([e]), fiveSecondsAgo, NOW, false);
        expect(line).toContain("limits: all 80/10s, getTransaction 8/10s");
    });

    it("rpc status marks an old snapshot", () => {
        const old = new Date(NOW.getTime() - 300_000);
        const [first] = formatRpcStatus(snapshot([endpoint()]), old, NOW, false);
        expect(first).toMatch(/\(age 300s, stale\)$/);
    });

    it("rpc status --outcomes adds one line per method", () => {
        const e = endpoint({ outcomes: { getSlot: { ok: 2, http_429: 1 } } });
        expect(formatRpcStatus(snapshot([e]), fiveSecondsAgo, NOW, true).at(-1)).toBe(
            "  rpc1 getSlot  ok: 2  http_429: 1",
        );
    });

    it("rpc status without a snapshot", async () => {
        await db.pool.query("delete from rpc_health");
        const io = captureIo();
        expect(await cli(["rpc", "status"], io)).toBe(1);
        expect(io.errText()).toContain("no router snapshot: is the service running?");
    });

    // A healthy mainnet node at slot `at` that knows every signature it is asked about
    function checkNode(label: string, over: Record<string, FakeHandler> = {}, at = 500n) {
        return fakeEndpoint(label, (method, params, payload) => {
            const own = over[method];
            if (own !== undefined) return own(method, params, payload);
            const last = params.at(-1);
            const pin =
                typeof last === "object" && last !== null
                    ? (last as { minContextSlot?: unknown }).minContextSlot
                    : undefined;
            if (typeof pin === "bigint" && pin > at) {
                return rpcFail(-32016, "Minimum context slot has not been reached", {
                    contextSlot: at,
                });
            }
            switch (method) {
                case "getGenesisHash":
                    return rpcOk(MAINNET_GENESIS);
                case "getEpochInfo":
                    return rpcOk({
                        absoluteSlot: at,
                        blockHeight: at - 100n,
                        epoch: 0n,
                        slotIndex: at,
                        slotsInEpoch: 432_000n,
                        transactionCount: 0n,
                    });
                case "getIdentity":
                    return rpcOk({ identity: `node-${label}` });
                case "getSignatureStatuses":
                    return statusesAnswer(
                        at,
                        (params[0] as string[]).map(() => signatureStatus(400n, "finalized")),
                    );
                case "getTransaction":
                    return rpcOk({ slot: 400n });
                case "getSignaturesForAddress":
                    return rpcOk(Array.from({ length: 1_000 }, (_, i) => ({ signature: `s${i}` })));
                default:
                    return rpcOk({ context: { slot: at }, value: null });
            }
        });
    }
    const TWO = { BUGNET_SOLANA_RPC_URLS: "https://a.example/,https://b.example/" };
    const FOUR = {
        BUGNET_SOLANA_RPC_URLS:
            "https://a.example/,https://b.example/,https://c.example/,https://d.example/",
    };
    // Every repeat of the history check answers alike when `same`, else they alternate
    function statusesRepeats(same: boolean): FakeHandler {
        let flip = false;
        return (_m, params) => {
            flip = !flip;
            return statusesAnswer(
                500n,
                (params[0] as string[]).map(() =>
                    same || flip ? signatureStatus(400n, "finalized") : null,
                ),
            );
        };
    }
    async function probe(
        env: NodeJS.ProcessEnv,
        nodes: ReturnType<typeof checkNode>[],
    ): Promise<{ code: number; out: string[]; text: string }> {
        const io = captureIo();
        const code = await cliMain(["-config", config, "rpc", "probe"], env, io, {
            rpcTransportFor: (name) => nodes[Number(name.slice(3)) - 1]!.transport,
        });
        return { code, out: io.outText().split("\n"), text: io.outText() + io.errText() };
    }

    it("rpc probe prints each check", async () => {
        const r = await probe(TWO, [checkNode("a"), checkNode("b")]);
        expect(r.out[0]).toMatch(
            /^rpc1 {2}genesis: ok {2}pinned-accounts: ok {2}pinned-signatures: ok {2}history: ok {2}consistent: yes {2}slot: 500 {2}latency: \d+ms$/,
        );
        expect(r.out.slice(-2)).toEqual(["quorum: 2 of 2 domains ready", "listings: rpc1 rpc2"]);
        expect(r.code).toBe(0);
    });

    it("rpc probe prints a wrong genesis and fails", async () => {
        const devnet = checkNode("a", {
            getGenesisHash: () => rpcOk("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
        });
        const r = await probe(TWO, [devnet, checkNode("b")]);
        expect(r.out.some((l) => l.startsWith("rpc1  genesis: wrong"))).toBe(true);
        expect(r.out.find((l) => l.startsWith("rpc2"))).toMatch(
            /^rpc2 {2}genesis: ok {2}pinned-accounts: ok {2}pinned-signatures: ok {2}history: ok {2}consistent: yes {2}slot: 500 {2}latency: \d+ms$/,
        );
        expect(r.code).toBe(1);
    });

    it("rpc probe fails on an ignored minContextSlot at a consistent endpoint", async () => {
        const ignoring = checkNode("b", {
            getAccountInfo: () => rpcOk({ context: { slot: 500n }, value: null }),
            getSignaturesForAddress: () => rpcOk([]),
        });
        const r = await probe(TWO, [checkNode("a"), ignoring]);
        expect(r.out.find((l) => l.startsWith("rpc2"))).toMatch(
            /^rpc2 {2}genesis: ok {2}pinned-accounts: ignored {2}pinned-signatures: ignored {2}history: ok {2}consistent: yes /,
        );
        expect(r.code).toBe(1);
    });

    it("rpc probe calls each endpoint's checks once", async () => {
        const a = checkNode("a");
        const r = await probe(TWO, [a, checkNode("b")]);
        expect(r.code).toBe(0);
        expect(a.calls.filter((c) => c.method === "getGenesisHash")).toHaveLength(1);
    });

    it("an inconsistent endpoint or one without history does not fail the probe", async () => {
        const c = checkNode("c", { getSignatureStatuses: statusesRepeats(false) });
        const d = checkNode("d", {
            getSignatureStatuses: (_m, params) =>
                statusesAnswer(
                    500n,
                    (params[0] as string[]).map(() => null),
                ),
            getTransaction: () => rpcOk(null),
        });
        const r = await probe(FOUR, [checkNode("a"), checkNode("b"), c, d]);
        expect(r.out.find((l) => l.startsWith("rpc3"))).toMatch(
            / {2}history: ok {2}consistent: no {2}/,
        );
        expect(r.out.find((l) => l.startsWith("rpc4"))).toMatch(/ {2}history: missing {2}/);
        expect(r.out.slice(-2)).toEqual(["quorum: 2 of 2 domains ready", "listings: rpc1 rpc2"]);
        expect(r.code).toBe(0);
    });

    it("rpc probe names a genesis error", async () => {
        const broken = checkNode("a", { getGenesisHash: () => httpFail(400) });
        const r = await probe(TWO, [broken, checkNode("b")]);
        expect(r.out[0]).toMatch(/^rpc1 {2}genesis: error http_400/);
        expect(r.code).toBe(1);
    });

    it("rpc probe fails when the quorum is short", async () => {
        let flip = false;
        const flipping = checkNode("b", {
            getSignatureStatuses: (_m, params) => {
                flip = !flip;
                return statusesAnswer(
                    500n,
                    (params[0] as string[]).map(() =>
                        flip ? signatureStatus(400n, "finalized") : null,
                    ),
                );
            },
        });
        const r = await probe(TWO, [checkNode("a"), flipping]);
        expect(r.out).toContain("quorum: 1 of 2 domains ready");
        expect(r.code).toBe(1);
    });

    it("rpc probe in single mode", async () => {
        const r = await probe({ BUGNET_SOLANA_RPC_URL: "https://a.example/" }, [checkNode("a")]);
        expect(r.out.slice(-2)).toEqual(["quorum: off (one URL)", "listings: rpc1"]);
        expect(r.code).toBe(0);
    });

    it("rpc probe never prints a URL", async () => {
        const keyed = {
            BUGNET_SOLANA_RPC_URLS:
                "https://one.a.example/0123456789abcdef0123456789abcdef?api-key=KEYONE12345678,https://two.b.example/",
        };
        const refusing = checkNode("b", { getGenesisHash: () => httpFail(403) });
        for (const nodes of [
            [checkNode("a"), checkNode("b")],
            [checkNode("a"), refusing],
        ]) {
            const r = await probe(keyed, nodes);
            for (const part of [
                "one.a.example",
                "a.example",
                "two.b.example",
                "b.example",
                "0123456789abcdef0123456789abcdef",
                "KEYONE12345678",
            ]) {
                expect(r.text).not.toContain(part);
            }
        }
        const failed = await probe(keyed, [checkNode("a"), refusing]);
        expect(failed.text).toContain("rpc2  genesis: error http_403");
    });

    describe("a hot-wallet re-sign proof through the router", () => {
        const CLAIM_KEY = Buffer.alloc(32, 9);
        const AT = 2_000n;
        // A hot refund past its expiry, the mirror verified through expiry_seen_slot + 300
        async function waitingRow(sig: string): Promise<number> {
            const o = await hotOrder();
            const id = await row(o.id, {
                kind: "allowance",
                fromWallet: "allowance",
                state: "manual",
                amountMicros: 300_000,
                manualReason: "refund_expired_repeatedly",
                txSignature: sig,
                expirySeenSlot: 1_000n,
            });
            await db.pool.query("update x402_tail set verified_slot = 1300");
            return id;
        }
        // Every signature found but `sig`, which is null unless `knows`
        const statusesFor =
            (sig: string, knows: boolean): FakeHandler =>
            (_m, params) =>
                statusesAnswer(
                    AT,
                    (params[0] as string[]).map((s) =>
                        s === sig && !knows ? null : signatureStatus(1_100n, "finalized"),
                    ),
                );
        function proofNode(label: string, sig: string, over: Record<string, FakeHandler> = {}) {
            return checkNode(label, { getSignatureStatuses: statusesFor(sig, false), ...over }, AT);
        }
        async function retry(id: number, env: NodeJS.ProcessEnv, nodes: FakeEndpoint[]) {
            const io = captureIo();
            const code = await cliMain(
                ["-config", config, "manual", "retry", String(id)],
                env,
                io,
                {
                    rpcTransportFor: (name) => nodes[Number(name.slice(3)) - 1]!.transport,
                },
            );
            return { code, io };
        }
        beforeEach(async () => {
            await db.pool.query("delete from rpc_verdicts");
        });

        it("the CLI reads the list", async () => {
            const sig = SIG(31);
            const id = await waitingRow(sig);
            const dead = fakeEndpoint("a", () => netFail());
            const b = proofNode("b", sig);
            const r = await retry(id, TWO, [dead, b]);
            // Without the claim key the stored verdicts are off, and the command says so
            expect(r.io.errText()).toContain(
                "rpc stored verdicts are not used without a valid BUGNET_CLAIM_KEY",
            );
            const asked = b.calls.filter(
                (c) =>
                    c.method === "getSignatureStatuses" && (c.params[0] as string[]).includes(sig),
            );
            expect(asked.length).toBeGreaterThan(0);
        });

        it("the CLI proof uses the quorum", async () => {
            const sig = SIG(32);
            const id = await waitingRow(sig);
            // a has no history at all; b knows the refund landed
            const a = checkNode(
                "a",
                {
                    getSignatureStatuses: (_m, params) =>
                        statusesAnswer(
                            AT,
                            (params[0] as string[]).map(() => null),
                        ),
                    getTransaction: () => rpcOk(null),
                },
                AT,
            );
            const knows = proofNode("b", sig, { getSignatureStatuses: statusesFor(sig, true) });
            const r = await retry(id, TWO, [a, knows]);
            expect(r.code).toBe(1);
            expect(r.io.errText()).toContain(
                `refund ${id}: its last transaction is not yet proven absent`,
            );
            expect((await refundOf(id)).state).toBe("manual");
        });

        it("the CLI never counts a vote the service took away", async () => {
            const sig = SIG(33);
            const id = await waitingRow(sig);
            await pgVerdictStore(db.pool, () => new Date(), 3_600_000).save({
                fingerprint: endpointFingerprint(CLAIM_KEY)("https://b.example/"),
                endpoint: "rpc2",
                noAt: Date.now() - 10 * 60_000,
                reason: "check_disagreed",
                historyPassed: true,
            });
            const env = { ...TWO, BUGNET_CLAIM_KEY: CLAIM_KEY.toString("base64") };
            // Both answer null and b's own boot run agrees, but the stored mark is younger than
            // the hour
            const r = await retry(id, env, [proofNode("a", sig), proofNode("b", sig)]);
            expect(r.code).toBe(1);
            expect(r.io.errText()).toContain(
                `refund ${id}: its last transaction is not yet proven absent`,
            );
            expect((await refundOf(id)).state).toBe("manual");

            // The same two answers without the stored mark prove the absence
            await db.pool.query("delete from rpc_verdicts");
            const clean = await retry(id, env, [proofNode("a", sig), proofNode("b", sig)]);
            expect(clean.code).toBe(0);
            expect((await refundOf(id)).state).toBe("pending");
        });

        it("a CLI command reruns an errored check once", async () => {
            const sig = SIG(34);
            const id = await waitingRow(sig);
            let first = true;
            const answer = statusesFor(sig, false);
            const b = proofNode("b", sig, {
                getSignatureStatuses: (m, params, payload) => {
                    if (!first) return answer(m, params, payload);
                    first = false;
                    return httpFail(503);
                },
            });
            const env = { ...TWO, BUGNET_CLAIM_KEY: CLAIM_KEY.toString("base64") };
            const r = await retry(id, env, [proofNode("a", sig), b]);
            expect(first).toBe(false);
            expect(r.code).toBe(0);
            expect((await refundOf(id)).state).toBe("pending");
        });

        it("a router refused at start still flushes its usage", async () => {
            const sig = SIG(35);
            const id = await waitingRow(sig);
            await db.pool.query("delete from rpc_usage");
            const devnet = checkNode("a", {
                getGenesisHash: () => rpcOk("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
            });
            const r = await retry(id, TWO, [devnet, proofNode("b", sig)]);
            expect(r.code).toBe(1);
            const rows = await db.pool.query<{ endpoint: string }>(
                "select endpoint from rpc_usage order by endpoint",
            );
            expect(rows.rows.map((x) => x.endpoint)).toEqual(["rpc1", "rpc2"]);
        });
    });

    it("rpc probe works before migration 00006", async () => {
        const old = await testDb();
        try {
            await old.pool.query("drop table rpc_usage, rpc_health, rpc_verdicts");
            const oldConfig = join(dir, "before-00006.toml");
            const recipient = (await testSigner(1)).address;
            writeFileSync(
                oldConfig,
                stringify({ database: { url: old.url }, solana: { recipient } }),
            );
            const io = captureIo();
            const env = { ...TWO, BUGNET_CLAIM_KEY: Buffer.alloc(32, 9).toString("base64") };
            const nodes = [checkNode("a"), checkNode("b")];
            const code = await cliMain(["-config", oldConfig, "rpc", "probe"], env, io, {
                rpcTransportFor: (name) => nodes[Number(name.slice(3)) - 1]!.transport,
            });
            expect(code).toBe(0);
            const out = io.outText().split("\n");
            expect(out.filter((l) => /^rpc[12] {2}genesis: ok/.test(l))).toHaveLength(2);
            expect(out.slice(-2)).toEqual(["quorum: 2 of 2 domains ready", "listings: rpc1 rpc2"]);
            const warns = io
                .errText()
                .split("\n")
                .filter((l) => l.includes('"level":"warn"'));
            expect(warns).toHaveLength(1);
            expect(warns[0]).not.toContain("example");
        } finally {
            await old.close();
        }

        // Nor does a probe write usage where the table exists
        await db.pool.query("delete from rpc_usage");
        const nodes = [checkNode("a"), checkNode("b")];
        expect((await probe(TWO, nodes)).code).toBe(0);
        expect((await db.pool.query("select 1 from rpc_usage")).rowCount).toBe(0);
    });

    it("the CLI names list problems by position", async () => {
        const io = captureIo();
        const env = {
            BUGNET_SOLANA_RPC_URLS: "https://a.example/?api-key=SECRETKEY1,http://b.example",
        };
        expect(await cliMain(["-config", config, "rpc", "probe"], env, io)).toBe(1);
        expect(io.errText()).toContain(
            "BUGNET_SOLANA_RPC_URLS rpc2 must be an https URL (http only on a loopback host)",
        );
        const all = io.outText() + io.errText();
        expect(all).not.toContain("SECRETKEY1");
        expect(all).not.toContain("b.example");
    });

    it("the CLI flushes usage before closing the pool", async () => {
        const chain = await startFakeChain();
        try {
            await db.pool.query("delete from rpc_usage");
            const io = captureIo();
            const env = { BUGNET_SOLANA_RPC_URL: chain.url };
            expect(await cliMain(["-config", config, "x402", "status"], env, io)).toBe(0);
            const rows = await db.pool.query<{ endpoint: string }>(
                "select endpoint from rpc_usage",
            );
            expect(rows.rows.map((r) => r.endpoint)).toContain("rpc1");
        } finally {
            await chain.close();
        }
    });

    it("the CLI warns when it reads another list than the service", async () => {
        const chain = await startFakeChain();
        try {
            const three = snapshot([
                endpoint(),
                endpoint({ name: "rpc2" }),
                endpoint({ name: "rpc3" }),
            ]);
            const env = { BUGNET_SOLANA_RPC_URL: chain.url };
            await pgSnapshotStore(db.pool, () => new Date(Date.now() - 5_000)).write(three);
            const fresh = captureIo();
            await cliMain(["-config", config, "x402", "status"], env, fresh);
            expect(fresh.errText()).toContain("rpc the CLI reads 1 URL, the service 3");

            await pgSnapshotStore(db.pool, () => new Date(Date.now() - 300_000)).write(three);
            const old = captureIo();
            await cliMain(["-config", config, "x402", "status"], env, old);
            expect(old.errText()).not.toContain("rpc the CLI reads");
        } finally {
            await chain.close();
        }
    });

    it("keys commands work without a config file", async () => {
        const chain = await startFakeChain();
        try {
            const io = captureIo();
            const env = { BUGNET_SOLANA_RPC_URL: chain.url };
            expect(await cliMain(["keys", "show"], env, io)).toBe(0);
            expect(chain.calls().some((c) => c.method === "getGenesisHash")).toBe(true);
        } finally {
            await chain.close();
        }
    });
});
