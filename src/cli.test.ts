import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliMain } from "./cli.ts";
import { silentLog } from "./log.ts";
import { findOrder } from "./orders/store.ts";
import type { OrderRow } from "./orders/types.ts";
import { pauseRefunds, refundsPaused, resumeRefunds } from "./refunds/executor.ts";
import { findOrderRefund } from "./refunds/request.ts";
import { testDb, type TestDb } from "./testing/db.ts";
import { testSigner } from "./testing/keys.ts";
import { seedOrder, seedPayment } from "./testing/orders.ts";

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

function cli(args: string[], io = captureIo()): Promise<number> {
    return cliMain(["-config", config, ...args], env, io);
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
