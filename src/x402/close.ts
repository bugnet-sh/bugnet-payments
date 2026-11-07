import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import { findOrder } from "../orders/store.ts";
import type { RouterClient } from "../router/client.ts";
import type { AllowanceFunding } from "./funding.ts";
import { lockAccount, startClosing, storePlacement } from "./ledger.ts";

export interface CloseDeps {
    pool: pg.Pool;
    router: RouterClient;
    funding: AllowanceFunding;
    x402: Settings["x402"];
    orders: Settings["orders"];
    log: Log;
    now: () => Date;
}

const unverifiableAlarmed = new Set<string>();
const slowAlarmed = new Set<string>();

type Verdict = "closing" | "waiting" | "failing" | "skipped";

async function clearFailing(c: pg.PoolClient, id: string): Promise<void> {
    await c.query("update x402_accounts set close_check_failing_since = null where id = $1", [id]);
}

// Open accounts past their deadline (or, without one, old enough) are asked about at the router.
export async function runCloseCheck(
    d: CloseDeps,
): Promise<{ closing: number; waiting: number; failing: number }> {
    const now = d.now();
    const due = await d.pool.query<{ id: string }>(
        `select id from x402_accounts
         where state = 'open'
           and ((deadline is not null
                 and deadline < $1::timestamptz - $2 * interval '1 millisecond')
             or (deadline is null
                 and created_at < $1::timestamptz - $2 * interval '1 millisecond'))
         order by id`,
        [now, d.x402.close_check_after],
    );
    const counts = { closing: 0, waiting: 0, failing: 0 };
    for (const { id } of due.rows) {
        try {
            await checkOne(id);
        } catch (err) {
            d.log.error("x402 close check failed for account", { accountId: id, err: String(err) });
        }
    }
    return counts;

    async function checkOne(id: string): Promise<void> {
        const answer = await d.router.lookupPlacement({ startOrderId: id });
        const alarms: (() => void)[] = [];
        const verdict = await withTx(d.pool, async (c): Promise<Verdict> => {
            const account = await lockAccount(c, id);
            if (account === null || account.state !== "open") return "skipped";
            if (answer.kind === "unavailable") {
                const since = account.closeCheckFailingSince ?? now;
                await c.query(
                    `update x402_accounts
                     set close_check_failing_since = coalesce(close_check_failing_since, $2)
                     where id = $1`,
                    [id, now],
                );
                if (
                    now.getTime() - since.getTime() > d.x402.close_unverifiable_after &&
                    !unverifiableAlarmed.has(id)
                ) {
                    unverifiableAlarmed.add(id);
                    alarms.push(() =>
                        d.log.alarm("x402_close_unverifiable", {
                            accountId: id,
                            failingSince: since,
                        }),
                    );
                }
                return "failing";
            }
            unverifiableAlarmed.delete(id);
            await clearFailing(c, id);
            if (answer.kind === "found") {
                if (answer.state === "terminated" || answer.state === "failed") {
                    await startClosing(c, id, now);
                    return "closing";
                }
                if (answer.state === "placing" || answer.state === "ready") {
                    await storePlacement(c, id, {
                        placementId: answer.placementId,
                        deadline: answer.deadline,
                    });
                }
                return "waiting";
            }
            const start = await findOrder(c, id);
            const ended =
                start !== null &&
                (start.state === "refunding" ||
                    start.state === "refunded" ||
                    start.state === "manual" ||
                    (start.state === "redeemed" &&
                        (start.routerConfirmedAt !== null || start.eventSeenAt !== null) &&
                        start.tokenExpiresAt !== null &&
                        now.getTime() > start.tokenExpiresAt.getTime() + d.orders.router_grace));
            if (!ended) return "waiting";
            await startClosing(c, id, now);
            return "closing";
        });
        for (const alarm of alarms) alarm();
        if (verdict !== "skipped") counts[verdict] += 1;
    }
}

// Each closing account is settled under its lock, taken before its rows are read: the unspent rest
// goes back, and the account closes once every allowance refund is confirmed or manual.
export async function runCloseJob(
    d: CloseDeps,
): Promise<{ refunded: number; kept: number; closed: number; waiting: number }> {
    const now = d.now();
    const ids = await d.pool.query<{ id: string }>(
        "select id from x402_accounts where state = 'closing' order by id",
    );
    const counts = { refunded: 0, kept: 0, closed: 0, waiting: 0 };
    for (const { id } of ids.rows) {
        try {
            await closeOne(id);
        } catch (err) {
            d.log.error("x402 close failed for account", { accountId: id, err: String(err) });
        }
    }
    return counts;

    async function closeOne(id: string): Promise<void> {
        const alarms: (() => void)[] = [];
        const tally = { refunded: 0, kept: 0, closed: 0, waiting: 0 };
        await withTx(d.pool, async (c) => {
            const account = await lockAccount(c, id);
            if (account === null || account.state !== "closing") return;
            const open = await c.query<{ n: string }>(
                `select count(*) as n from x402_payments
                 where account_id = $1 and state in ('reserved', 'signed')`,
                [id],
            );
            if (Number(open.rows[0]!.n) > 0) {
                tally.waiting += 1;
                const since = account.closingAt ?? now;
                if (
                    now.getTime() - since.getTime() > d.x402.close_slow_alarm_after &&
                    !slowAlarmed.has(id)
                ) {
                    slowAlarmed.add(id);
                    alarms.push(() =>
                        d.log.alarm("x402_close_slow", { accountId: id, closingAt: since }),
                    );
                }
                return;
            }
            const outcome = await d.funding.refund(c, account, now);
            if (outcome.kind === "not_ready") {
                tally.waiting += 1;
                return;
            }
            if (outcome.kind === "refund") {
                tally.refunded += 1;
                return;
            }
            if (outcome.kind === "kept") tally.kept += 1;
            if (outcome.kind === "already") {
                const rows = await c.query<{ open: string }>(
                    `select count(*) filter (where r.state not in ('confirmed', 'manual')) as open
                     from refunds r join x402_fundings f on f.order_id = r.order_id
                     where f.account_id = $1 and r.kind = 'allowance'`,
                    [id],
                );
                if (Number(rows.rows[0]!.open) > 0) return;
            }
            const closed = await c.query(
                `update x402_accounts set state = 'closed', closed_at = $2
                 where id = $1 and state = 'closing'`,
                [id, now],
            );
            tally.closed += closed.rowCount ?? 0;
            slowAlarmed.delete(id);
        });
        for (const key of Object.keys(tally) as (keyof typeof tally)[]) counts[key] += tally[key];
        for (const alarm of alarms) alarm();
    }
}
