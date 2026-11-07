import type { Queryable } from "../db/pool.ts";
import type { AllowanceEventInput, X402ResolvedInput } from "../router/client.ts";

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
