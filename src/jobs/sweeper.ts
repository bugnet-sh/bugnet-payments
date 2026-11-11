import type pg from "pg";
import { withTx } from "../db/pool.ts";
import type { Settings } from "../config.ts";
import { lockDeposit } from "../deposits/store.ts";
import type { DepositState } from "../deposits/types.ts";
import type { Log } from "../log.ts";
import { findOrder, lockOrder, setOrderState, updateOrderFields } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { requestRefund, type RefundReason } from "../refunds/request.ts";
import type { RouterClient } from "../router/client.ts";
import type { AllowanceFunding } from "../x402/funding.ts";
import { movePool } from "../x402/ledger.ts";

export interface SweepDeps {
    pool: pg.Pool;
    router: RouterClient;
    orders: Settings["orders"];
    funding: AllowanceFunding | null;
    x402: Settings["x402"];
    log: Log;
    now: () => Date;
    // Orders already alarmed as router_get_order_unavailable, kept for the life of the process
    unavailableAlarmed: Set<string>;
}

export interface SweepReport {
    expired: number;
    refunds: Record<RefundReason, number>;
    routerChecks: number;
    manual: number;
}

type ManualReason = "no_event_unverifiable" | "abandon_unverifiable" | "refund_amount_pending";

const UNAVAILABLE_ALARM_AFTER_MS = 30 * 60_000;
// A deposit the job still watches holds its order open until the hard stop (spec 6.6)
const LIVE: ReadonlySet<DepositState> = new Set(["open", "settling"]);
const NO_LIVE_DEPOSIT = `not exists (select 1 from deposits d where d.order_id = orders.id
    and d.state in ('open', 'settling') and (d.hard_stop_at is null or d.hard_stop_at > $1))`;

// The caller holds the order's lock and has checked that it is unpaid; the pool releases the
// allowance the order reserved
export async function expireUnpaidOrder(
    c: pg.PoolClient,
    order: OrderRow,
    x402: Settings["x402"],
    log: Log,
): Promise<void> {
    await setOrderState(c, order.id, "unpaid", "expired");
    if (order.allowanceMicros > 0) {
        await movePool(c, { unpaid: -order.allowanceMicros }, x402, log);
    }
}

export async function sweep(d: SweepDeps): Promise<SweepReport> {
    const now = d.now();
    const report: SweepReport = {
        expired: 0,
        refunds: {
            unredeemed: 0,
            late: 0,
            router_refundable: 0,
            abandoned: 0,
            no_router_record: 0,
            operator: 0,
            x402_unspent: 0,
            x402_ceiling: 0,
            x402_closed: 0,
            deposit_held: 0,
        },
        routerChecks: 0,
        manual: 0,
    };

    // One bad order must not stop the run, the next run tries it again
    const each = async (ids: string[], step: (id: string) => Promise<void>): Promise<void> => {
        for (const id of ids) {
            try {
                await step(id);
            } catch (err) {
                d.log.error("sweep step failed", { orderId: id, error: err });
            }
        }
    };
    const refund = async (
        id: string,
        reason: RefundReason,
        eligible: (o: OrderRow) => boolean,
    ): Promise<void> => {
        if (
            (await requestRefund(d.pool, id, reason, {
                eligible,
                funding: d.funding ?? undefined,
                at: now,
                log: d.log,
            })) === "created"
        ) {
            report.refunds[reason]++;
            d.log.info("sweeper refund requested", { orderId: id, reason });
        }
    };
    const park = async (
        id: string,
        reason: ManualReason,
        eligible: (o: OrderRow) => boolean,
    ): Promise<void> => {
        const parked = await withTx(d.pool, async (c) => {
            const order = await lockOrder(c, id);
            if (order === null || !eligible(order)) return false;
            await setOrderState(c, id, "redeemed", "manual", { manualReason: reason });
            return true;
        });
        if (!parked) return;
        report.manual++;
        d.log.alarm("manual_queue", { orderId: id, reason });
    };
    const confirm = async (id: string): Promise<void> => {
        await updateOrderFields(d.pool, id, { routerConfirmedAt: now });
    };
    const unavailable = async (id: string): Promise<void> => {
        if (d.unavailableAlarmed.has(id)) return;
        const tokenExpiresAt = (await findOrder(d.pool, id))?.tokenExpiresAt ?? null;
        if (
            tokenExpiresAt === null ||
            now.getTime() < tokenExpiresAt.getTime() + UNAVAILABLE_ALARM_AFTER_MS
        ) {
            return;
        }
        d.unavailableAlarmed.add(id);
        d.log.alarm("router_get_order_unavailable", {
            orderId: id,
            tokenExpiresAt: tokenExpiresAt.toISOString(),
        });
    };

    await each(
        await ids(d.pool, `state = 'unpaid' and expires_at <= $1 and ${NO_LIVE_DEPOSIT}`, [now]),
        async (id) => {
            const expired = await withTx(d.pool, async (c) => {
                const order = await lockOrder(c, id);
                if (order === null || order.state !== "unpaid") return null;
                if (order.expiresAt > now) return null;
                const deposit = await lockDeposit(c, id);
                const live = deposit !== null && LIVE.has(deposit.state);
                if (live && (deposit.hardStopAt === null || deposit.hardStopAt > now)) return null;
                await expireUnpaidOrder(c, order, d.x402, d.log);
                return { hardStop: live };
            });
            if (expired === null) return;
            report.expired++;
            // The deposit job had no read it could trust before the hard stop came
            if (expired.hardStop) {
                d.log.alarm("deposit_review", { orderId: id, reason: "expired_unchecked" });
            }
        },
    );

    // Unreachable, payOrder records paid_at only before the order expires
    await each(
        await ids(
            d.pool,
            "state = 'paid' and paid_at > expires_at and kind in ('start', 'extend')",
            [],
        ),
        async (id) => {
            d.log.error("impossible late payment", { orderId: id });
            await refund(id, "late", (o) => o.state === "paid");
        },
    );

    const unredeemedBefore = new Date(now.getTime() - d.orders.unredeemed_refund_after);
    await each(
        // A transfer's paid_at is its chain time, so the wait counts from when Payments confirmed it
        await ids(
            d.pool,
            `state = 'paid' and kind in ('start', 'extend') and greatest(paid_at,
                (select p.confirmed_at from payments p where p.order_id = orders.id)) <= $1`,
            [unredeemedBefore],
        ),
        (id) => refund(id, "unredeemed", (o) => o.state === "paid"),
    );

    const graceBefore = new Date(now.getTime() - d.orders.router_grace);
    const unconfirmed = `state = 'redeemed' and kind in ('start', 'extend')
        and router_confirmed_at is null and token_expires_at <= $1`;
    const checks: Array<{ where: string; abandon: boolean }> = [
        {
            where: `${unconfirmed} and event_seen_at is null and abandon_at is null`,
            abandon: false,
        },
        { where: `${unconfirmed} and abandon_at is not null`, abandon: true },
    ];
    for (const { where, abandon } of checks) {
        await each(await ids(d.pool, where, [graceBefore]), async (id) => {
            report.routerChecks++;
            const answer = await d.router.getOrder(id);
            const stillUnconfirmed = (o: OrderRow): boolean =>
                o.state === "redeemed" &&
                o.routerConfirmedAt === null &&
                (abandon ? o.abandonAt !== null : o.eventSeenAt === null && o.abandonAt === null);
            switch (answer.kind) {
                case "absent":
                    return refund(id, abandon ? "abandoned" : "no_router_record", stillUnconfirmed);
                case "disabled":
                    return park(
                        id,
                        abandon ? "abandon_unverifiable" : "no_event_unverifiable",
                        stillUnconfirmed,
                    );
                case "unavailable":
                    return unavailable(id);
                case "found": {
                    if (answer.refundable) {
                        if (answer.orderKind === "start" && answer.placementState === "failed") {
                            return refund(id, "router_refundable", stillUnconfirmed);
                        }
                        if (
                            answer.placementState === "terminating" ||
                            answer.placementState === "terminated"
                        ) {
                            return park(id, "refund_amount_pending", stillUnconfirmed);
                        }
                    }
                    await confirm(id);
                    d.log.info(
                        abandon
                            ? "abandon ignored, router holds the order"
                            : "router holds the order",
                        { orderId: id, placementState: answer.placementState },
                    );
                }
            }
        });
    }

    return report;
}

async function ids(db: pg.Pool, where: string, params: unknown[]): Promise<string[]> {
    const res = await db.query<{ id: string }>(
        `select id from orders where ${where} order by created_at, id`,
        params,
    );
    return res.rows.map((r) => r.id);
}
