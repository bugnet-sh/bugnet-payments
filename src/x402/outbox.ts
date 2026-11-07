import type pg from "pg";
import type { Settings } from "../config.ts";
import { type Queryable, withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import type {
    AllowanceEventInput,
    AppendResult,
    RouterClient,
    X402ResolvedInput,
} from "../router/client.ts";

export type AllowancePhase = "paid" | "refunded" | "kept";

const PATH_CODE_POINTS = 80;

// A kept event names the start order as its order_id, so each sandbox has at most one.
export async function enqueueAllowanceEvent(
    c: Queryable,
    e: {
        startOrderId: string;
        orderId: string;
        phase: AllowancePhase;
        amountMicros: number;
        keptMicros: number;
        tx: string | null;
    },
    at: Date,
): Promise<boolean> {
    const payload: AllowanceEventInput = {
        orderId: e.orderId,
        startOrderId: e.startOrderId,
        phase: e.phase,
        amountMicros: e.amountMicros,
        keptMicros: e.keptMicros,
        tx: e.tx ?? "",
    };
    const res = await c.query(
        `insert into x402_router_events
            (kind, start_order_id, order_id, phase, payload, created_at, next_at)
         values ('allowance', $1, $2, $3, $4::jsonb, $5, $5)
         on conflict do nothing`,
        [e.startOrderId, e.orderId, e.phase, JSON.stringify(payload), at],
    );
    return res.rowCount === 1;
}

export async function enqueueX402Resolved(
    c: Queryable,
    e: X402ResolvedInput,
    at: Date,
): Promise<boolean> {
    const payload = {
        ...e,
        at: e.at.toISOString(),
        path: Array.from(e.path).slice(0, PATH_CODE_POINTS).join(""),
    };
    const res = await c.query(
        `insert into x402_router_events (kind, start_order_id, ref, payload, created_at, next_at)
         values ('x402_resolved', $1, $2, $3::jsonb, $4, $4)
         on conflict do nothing`,
        [e.startOrderId, e.ref, JSON.stringify(payload), at],
    );
    return res.rowCount === 1;
}

export async function dropPendingPaidEvent(
    c: Queryable,
    orderId: string,
    reason: "voided",
): Promise<boolean> {
    const res = await c.query(
        `update x402_router_events set state = 'dropped', dropped_reason = $2
         where kind = 'allowance' and order_id = $1 and phase = 'paid' and state = 'pending'`,
        [orderId, reason],
    );
    return res.rowCount === 1;
}

export async function paidEventSent(db: Queryable, orderId: string): Promise<boolean> {
    const res = await db.query(
        `select 1 from x402_router_events
         where kind = 'allowance' and order_id = $1 and phase = 'paid' and state = 'sent'`,
        [orderId],
    );
    return res.rows.length === 1;
}

const SEND_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 2_000;

export interface OutboxDeps {
    pool: pg.Pool;
    router: RouterClient;
    x402: Settings["x402"];
    log: Log;
    now: () => Date;
}

interface EventRow {
    id: string;
    kind: "allowance" | "x402_resolved";
    start_order_id: string;
    ref: string | null;
    attempts: number;
    payload: Record<string, unknown>;
}

const stuckAlarmed = new Set<string>();

async function send(router: RouterClient, row: EventRow): Promise<AppendResult> {
    const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
    if (row.kind === "allowance") {
        const p = row.payload as unknown as AllowanceEventInput;
        return router.appendAllowanceEvent({ ...p, tx: p.tx ?? "" }, signal);
    }
    const p = row.payload as unknown as Omit<X402ResolvedInput, "at"> & { at: string };
    return router.appendX402Resolved({ ...p, at: new Date(p.at) }, signal);
}

type Outcome = "sent" | "dropped" | "retried";

// The row lock stays held through the router call, so a void cannot drop a paid row mid-send.
async function sendOne(d: OutboxDeps, skip: string[]): Promise<{ id: string; out?: Outcome }> {
    return withTx(
        d.pool,
        async (c) => {
            const now = d.now();
            const found = await c.query<EventRow>(
                `select id, kind, start_order_id, ref, attempts, payload from x402_router_events
                 where state = 'pending' and next_at <= $1 and id <> all($2::bigint[])
                 order by next_at, id
                 limit 1
                 for no key update skip locked`,
                [now, skip],
            );
            const row = found.rows[0];
            if (!row) return { id: "" };
            let thrown: string | null = null;
            const answer = await send(d.router, row).catch((err: unknown) => {
                thrown = (err instanceof Error ? err.message : String(err)).slice(0, 500);
                d.log.warn("x402_event_send_failed", { eventId: row.id, error: thrown });
                return "retry" as const;
            });
            const backoff = Math.min(
                BASE_BACKOFF_MS * 2 ** Math.min(row.attempts, 30),
                d.x402.events_max_backoff,
            );
            const retryAt = new Date(now.getTime() + backoff);
            if (answer === "ok") {
                await c.query(
                    `update x402_router_events
                     set state = 'sent', sent_at = $2, attempts = attempts + 1, last_error = null
                     where id = $1 and state = 'pending'`,
                    [row.id, now],
                );
                return { id: row.id, out: "sent" };
            }
            if (answer === "invalid" || (answer === "order_unknown" && row.kind !== "allowance")) {
                await c.query(
                    `update x402_router_events set state = 'dropped', dropped_reason = $2
                     where id = $1 and state = 'pending'`,
                    [row.id, answer],
                );
                if (answer === "invalid") {
                    d.log.alarm("x402_event_refused", {
                        eventId: row.id,
                        kind: row.kind,
                        startOrderId: row.start_order_id,
                    });
                } else {
                    d.log.alarm("x402_event_dropped", {
                        eventId: row.id,
                        startOrderId: row.start_order_id,
                        ref: row.ref,
                    });
                }
                return { id: row.id, out: "dropped" };
            }
            await c.query(
                `update x402_router_events
                 set attempts = attempts + 1, next_at = $2, last_error = $3
                 where id = $1 and state = 'pending'`,
                [row.id, retryAt, thrown ?? answer],
            );
            return { id: row.id, out: "retried" };
        },
        d.log,
        { retryDeadlock: false },
    );
}

export async function runOutbox(
    d: OutboxDeps,
): Promise<{ sent: number; dropped: number; retried: number }> {
    const result = { sent: 0, dropped: 0, retried: 0 };
    const seen: string[] = [];
    for (let i = 0; i < d.x402.events_batch; i++) {
        const r = await sendOne(d, seen);
        if (!r.out) break;
        seen.push(r.id);
        result[r.out]++;
    }
    const stuck = await d.pool.query<{ id: string; start_order_id: string; created_at: Date }>(
        `select e.id, e.start_order_id, e.created_at from x402_router_events e
         join orders o on o.id = e.start_order_id
         where e.state = 'pending' and o.state = 'redeemed'
         order by e.created_at, e.id limit 1`,
    );
    const s = stuck.rows[0];
    if (
        s &&
        !stuckAlarmed.has(s.id) &&
        d.now().getTime() - s.created_at.getTime() > d.x402.events_stuck_alarm_after
    ) {
        stuckAlarmed.add(s.id);
        d.log.alarm("x402_events_stuck", {
            eventId: s.id,
            startOrderId: s.start_order_id,
            createdAt: s.created_at,
        });
    }
    return result;
}
