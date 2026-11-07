import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { GetOrderResponseSchema } from "../gen/bugnet/router/v1/payments_pb.ts";
import type { Settings } from "../config.ts";
import { memoryLog, silentLog } from "../log.ts";
import { findOrder, markEventSeen } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { findRefund } from "../refunds/request.ts";
import { createRouterClient } from "../router/client.ts";
import { startFakeRouter, type FakeRouter } from "../testing/fake-router.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import { sweep, type SweepDeps } from "./sweeper.ts";

const MIN = 60_000;
const t0 = new Date("2026-11-06T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

const orders: Settings["orders"] = {
    unpaid_ttl: 15 * MIN,
    unredeemed_refund_after: 30 * MIN,
    token_ttl: 10 * MIN,
    router_grace: 2 * MIN,
    max_amount_micros: 100_000_000,
    attempts_per_order_per_minute: 5,
    min_idempotency_key_length: 16,
};

type Answer = MessageInitShape<typeof GetOrderResponseSchema> | "error";

let db: TestDb;
let router: FakeRouter;
let calls: string[];
let answer: Answer;
let beforeAnswer: (() => Promise<void>) | null;

beforeAll(async () => {
    db = await testDb();
    router = await startFakeRouter({
        getOrder: async (m) => {
            calls.push(m.orderId);
            await beforeAnswer?.();
            if (answer === "error") throw new Error("router down");
            return create(GetOrderResponseSchema, answer);
        },
    });
});
afterAll(async () => {
    await router.close();
    await db.close();
});
beforeEach(async () => {
    await db.pool.query("truncate orders cascade");
    calls = [];
    beforeAnswer = null;
    answer = { redeemed: false };
});

function deps(
    now: Date,
    over: { getOrder?: boolean; log?: SweepDeps["log"]; alarmed?: Set<string> } = {},
): SweepDeps {
    return {
        pool: db.pool,
        router: createRouterClient({
            url: router.url,
            token: "rt",
            timeoutMs: 2_000,
            checkPayer: false,
            getOrder: over.getOrder ?? true,
            log: silentLog,
        }),
        orders,
        log: over.log ?? silentLog,
        now: () => now,
        unavailableAlarmed: over.alarmed ?? new Set(),
    };
}

// A redeemed order whose router window closed at t0 (grace ends at t0 + 2 minutes)
async function redeemed(over: Partial<OrderRow> = {}): Promise<OrderRow> {
    const { order } = await seedOrder(db.pool, {
        state: "redeemed",
        paidAt: at(-10 * MIN),
        redeemedAt: at(-10 * MIN),
        tokenExpiresAt: t0,
        expiresAt: at(-20 * MIN),
        ...over,
    });
    await seedPayment(db.pool, order.id, { status: "confirmed", createdAt: at(-10 * MIN) });
    return order;
}

const stateOf = async (id: string) => (await findOrder(db.pool, id))!;

describe("expiry", () => {
    it("expires unpaid orders at 15 minutes and never a settling one", async () => {
        const unpaid = await seedOrder(db.pool, {
            state: "unpaid",
            claimBox: Buffer.from("box"),
            createdAt: t0,
            expiresAt: at(15 * MIN),
        });
        const settling = await seedOrder(db.pool, {
            state: "settling",
            createdAt: t0,
            expiresAt: at(15 * MIN),
        });

        expect((await sweep(deps(at(15 * MIN - 1_000)))).expired).toBe(0);
        expect((await stateOf(unpaid.order.id)).state).toBe("unpaid");

        const report = await sweep(deps(at(15 * MIN)));
        expect(report.expired).toBe(1);
        const done = await stateOf(unpaid.order.id);
        expect(done.state).toBe("expired");
        expect(done.claimBox).toBeNull();

        await sweep(deps(at(20 * MIN)));
        expect((await stateOf(settling.order.id)).state).toBe("settling");
    });
});

describe("paid orders", () => {
    it("refunds a forced late payment at once and logs it as impossible", async () => {
        const { order } = await seedOrder(db.pool, {
            state: "paid",
            expiresAt: t0,
            paidAt: at(1_000),
        });
        await seedPayment(db.pool, order.id);
        const log = memoryLog();
        const report = await sweep(deps(at(2_000), { log }));
        expect(report.refunds.late).toBe(1);
        expect(log.lines.filter((l) => l.msg === "impossible late payment")).toEqual([
            expect.objectContaining({ level: "error", orderId: order.id }),
        ]);
        expect((await stateOf(order.id)).state).toBe("refunding");
        expect((await findRefund(db.pool, order.id))?.reason).toBe("late");
    });

    it("refunds paid orders unredeemed for 30 minutes", async () => {
        const { order } = await seedOrder(db.pool, {
            state: "paid",
            expiresAt: at(15 * MIN),
            paidAt: t0,
        });
        await seedPayment(db.pool, order.id);

        const log = memoryLog();
        const early = await sweep(deps(at(30 * MIN - 1_000), { log }));
        expect(early.refunds.unredeemed).toBe(0);
        expect(log.lines.filter((l) => l.level === "error")).toEqual([]);
        expect((await stateOf(order.id)).state).toBe("paid");

        const report = await sweep(deps(at(30 * MIN)));
        expect(report.refunds.unredeemed).toBe(1);
        expect((await stateOf(order.id)).state).toBe("refunding");
        expect((await findRefund(db.pool, order.id))?.reason).toBe("unredeemed");

        expect((await sweep(deps(at(31 * MIN)))).refunds.unredeemed).toBe(0);
    });

    it("leaves a redeemed order alone however old it is", async () => {
        const order = await redeemed({ eventSeenAt: t0 });
        const report = await sweep(deps(at(120 * MIN)));
        expect(report.refunds.unredeemed).toBe(0);
        expect((await stateOf(order.id)).state).toBe("redeemed");
    });
});

describe("redeemed orders with no event", () => {
    it.each([
        [{ redeemed: false }, "refunding", "no_router_record"],
        [
            { redeemed: true, kind: "start", placementState: "ready", refundable: false },
            "redeemed",
            null,
        ],
        ["disabled", "manual", null],
        ["error", "redeemed", null],
    ] as const)("checks via GetOrder %o", async (a, state, reason) => {
        const order = await redeemed();
        const getOrder = a !== "disabled";
        answer = a === "disabled" ? { redeemed: false } : a;

        const early = await sweep(deps(at(2 * MIN - 1_000), { getOrder }));
        expect(early.routerChecks).toBe(0);
        expect(calls).toEqual([]);

        const log = memoryLog();
        const report = await sweep(deps(at(2 * MIN), { getOrder, log }));
        expect(report.routerChecks).toBe(1);
        const row = await stateOf(order.id);
        expect(row.state).toBe(state);
        expect((await findRefund(db.pool, order.id))?.reason ?? null).toBe(reason);
        if (a === "disabled") {
            expect(row.manualReason).toBe("no_event_unverifiable");
            expect(report.manual).toBe(1);
            expect(log.lines.some((l) => l.level === "alarm" && l.alarm === "manual_queue")).toBe(
                true,
            );
        }
        if (typeof a === "object" && a.redeemed) {
            expect(row.routerConfirmedAt).toEqual(at(2 * MIN));
            await sweep(deps(at(5 * MIN)));
            expect(calls).toHaveLength(1);
        }
        if (a === "error") expect(row.routerConfirmedAt).toBeNull();
    });

    it("alarms once per order when GetOrder stays unavailable 30 minutes past the token", async () => {
        const order = await redeemed();
        const other = await redeemed({ abandonAt: at(-5 * MIN) });
        answer = "error";
        const alarmed = new Set<string>();
        const log = memoryLog();
        const alarms = () =>
            log.lines
                .filter((l) => l.alarm === "router_get_order_unavailable")
                .map((l) => l.orderId);

        for (const minute of [2, 29]) await sweep(deps(at(minute * MIN), { log, alarmed }));
        expect(alarms()).toEqual([]);

        await sweep(deps(at(30 * MIN), { log, alarmed }));
        expect(alarms()).toEqual([order.id, other.id]);
        expect(log.lines.find((l) => l.alarm === "router_get_order_unavailable")).toMatchObject({
            level: "alarm",
            orderId: order.id,
            tokenExpiresAt: t0.toISOString(),
        });

        await sweep(deps(at(31 * MIN), { log, alarmed }));
        await sweep(deps(at(60 * MIN), { log, alarmed }));
        expect(alarms()).toEqual([order.id, other.id]);
        expect(calls.filter((id) => id === order.id)).toHaveLength(5);
        for (const o of [order, other]) {
            const row = await stateOf(o.id);
            expect(row).toMatchObject({ state: "redeemed", routerConfirmedAt: null });
            expect(await findRefund(db.pool, o.id)).toBeNull();
        }

        await sweep(deps(at(61 * MIN), { log, alarmed: new Set() }));
        expect(alarms()).toEqual([order.id, other.id, order.id, other.id]);
    });

    it("does not ask the router about orders with an event", async () => {
        await redeemed({ eventSeenAt: at(-1_000) });
        const report = await sweep(deps(at(10 * MIN)));
        expect(report.routerChecks).toBe(0);
        expect(calls).toEqual([]);
    });

    it("refunds in full a failed start the router holds as refundable", async () => {
        const order = await redeemed();
        answer = { redeemed: true, kind: "start", placementState: "failed", refundable: true };
        const report = await sweep(deps(at(2 * MIN)));
        expect(report.refunds.router_refundable).toBe(1);
        expect((await stateOf(order.id)).state).toBe("refunding");
        const refund = await findRefund(db.pool, order.id);
        expect(refund?.kind).toBe("full");
        expect(refund?.reason).toBe("router_refundable");
    });

    it.each(["terminating", "terminated"])(
        "parks a refundable %s placement as refund_amount_pending",
        async (placementState) => {
            const order = await redeemed();
            answer = { redeemed: true, kind: "start", placementState, refundable: true };
            const log = memoryLog();
            const report = await sweep(deps(at(2 * MIN), { log }));
            expect(report.manual).toBe(1);
            const row = await stateOf(order.id);
            expect(row.state).toBe("manual");
            expect(row.manualReason).toBe("refund_amount_pending");
            expect(await findRefund(db.pool, order.id)).toBeNull();
            expect(log.lines.some((l) => l.level === "alarm" && l.alarm === "manual_queue")).toBe(
                true,
            );
        },
    );

    it("only confirms a refundable extend that failed", async () => {
        const order = await redeemed();
        answer = { redeemed: true, kind: "extend", placementState: "failed", refundable: true };
        const report = await sweep(deps(at(2 * MIN)));
        expect(report.refunds.router_refundable).toBe(0);
        const row = await stateOf(order.id);
        expect(row.state).toBe("redeemed");
        expect(row.routerConfirmedAt).toEqual(at(2 * MIN));
    });
});

describe("an order that changes between selection and action", () => {
    const disabledAfter = (hook: () => Promise<void>): SweepDeps => {
        const base = deps(at(2 * MIN));
        return {
            ...base,
            router: {
                ...base.router,
                getOrder: async () => {
                    await hook();
                    return { kind: "disabled" };
                },
            },
        };
    };

    it("skips a no_router_record refund when an event arrives", async () => {
        const order = await redeemed();
        beforeAnswer = () => markEventSeen(db.pool, order.id, at(2 * MIN));
        const report = await sweep(deps(at(2 * MIN)));
        expect(report.refunds.no_router_record).toBe(0);
        expect((await stateOf(order.id)).state).toBe("redeemed");
        expect(await findRefund(db.pool, order.id)).toBeNull();
    });

    it("skips a no_event_unverifiable park when an event arrives", async () => {
        const order = await redeemed();
        const report = await sweep(
            disabledAfter(() => markEventSeen(db.pool, order.id, at(2 * MIN))),
        );
        expect(report.manual).toBe(0);
        expect((await stateOf(order.id)).state).toBe("redeemed");
    });

    it("skips an abandon park when the hint disappears", async () => {
        const order = await redeemed({ abandonAt: at(-5 * MIN) });
        const report = await sweep(
            disabledAfter(async () => {
                await db.pool.query("update orders set abandon_at = null where id = $1", [
                    order.id,
                ]);
            }),
        );
        expect(report.manual).toBe(0);
        expect((await stateOf(order.id)).state).toBe("redeemed");
    });
});

describe("abandon hints", () => {
    it("waits for the grace before acting on an abandon hint", async () => {
        const order = await redeemed({ abandonAt: at(-5 * MIN), abandonReason: "client_gone" });
        await sweep(deps(at(2 * MIN - 1_000)));
        expect(calls).toHaveLength(0);
        expect((await stateOf(order.id)).state).toBe("redeemed");

        const report = await sweep(deps(at(2 * MIN)));
        expect(calls).toEqual([order.id]);
        expect(report.refunds.abandoned).toBe(1);
        expect((await findRefund(db.pool, order.id))?.reason).toBe("abandoned");
    });

    it("asks the router even when an event arrived, as the hint overrides it", async () => {
        const order = await redeemed({ abandonAt: at(-5 * MIN), eventSeenAt: at(-6 * MIN) });
        const report = await sweep(deps(at(2 * MIN)));
        expect(report.refunds.abandoned).toBe(1);
        expect((await stateOf(order.id)).state).toBe("refunding");
    });

    it("keeps the hint and confirms when the router holds the order", async () => {
        const order = await redeemed({ abandonAt: at(-5 * MIN), abandonReason: "client_gone" });
        answer = { redeemed: true, kind: "start", placementState: "ready", refundable: false };
        const log = memoryLog();
        await sweep(deps(at(2 * MIN), { log }));
        const row = await stateOf(order.id);
        expect(row.state).toBe("redeemed");
        expect(row.routerConfirmedAt).toEqual(at(2 * MIN));
        expect(row.abandonAt).toEqual(at(-5 * MIN));
        expect(log.lines.some((l) => l.msg === "abandon ignored, router holds the order")).toBe(
            true,
        );
    });

    it("parks an abandon hint the router cannot verify and leaves an unavailable one", async () => {
        const order = await redeemed({ abandonAt: at(-5 * MIN) });
        answer = "error";
        await sweep(deps(at(2 * MIN)));
        expect((await stateOf(order.id)).state).toBe("redeemed");

        const log = memoryLog();
        const report = await sweep(deps(at(3 * MIN), { getOrder: false, log }));
        const row = await stateOf(order.id);
        expect(row.state).toBe("manual");
        expect(row.manualReason).toBe("abandon_unverifiable");
        expect(report.manual).toBe(1);
        expect(log.lines.some((l) => l.level === "alarm" && l.alarm === "manual_queue")).toBe(true);
    });

    it("never re-parks an order the router confirmed", async () => {
        const order = await redeemed({ abandonAt: at(-5 * MIN), routerConfirmedAt: at(-1 * MIN) });
        const report = await sweep(deps(at(10 * MIN), { getOrder: false }));
        expect(calls).toHaveLength(0);
        expect(report.manual).toBe(0);
        expect((await stateOf(order.id)).state).toBe("redeemed");
    });
});
