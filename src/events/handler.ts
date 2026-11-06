/**
 * Signed router events. The router signs the raw body bytes with Ed25519, so the signature is
 * checked before the body is parsed. An event is stored once by its id; a stored event is then
 * applied: the order is marked as heard from, and a refundable end is turned into a refund or,
 * when the amounts are missing or wrong, parked in the manual queue.
 */
import { createPublicKey, type KeyObject, verify } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type pg from "pg";
import { withTx } from "../db/pool.ts";
import { isRecord } from "../is-record.ts";
import type { Log } from "../log.ts";
import { findOrder, lockOrder, markEventSeen, setOrderState } from "../orders/store.ts";
import { findRefund, requestRefund, returnManualToRedeemed } from "../refunds/request.ts";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const PARKED_BY_SWEEPER = ["no_event_unverifiable", "abandon_unverifiable"] as const;

export function eventPublicKey(b64: string): KeyObject {
    const key = Buffer.from(b64, "base64");
    if (key.length !== KEY_BYTES) throw new Error("event public key must be 32 bytes");
    return createPublicKey({
        key: Buffer.concat([SPKI_ED25519_PREFIX, key]),
        format: "der",
        type: "spki",
    });
}

export function verifyEventSignature(key: KeyObject, raw: Buffer, sigB64: string): boolean {
    const sig = Buffer.from(sigB64, "base64");
    // Buffer.from skips bad characters, so a round trip insists on standard padded base64
    if (sig.length !== SIGNATURE_BYTES || sig.toString("base64") !== sigB64) return false;
    return verify(null, raw, key, sig);
}

export interface EventDeps {
    pool: pg.Pool;
    key: KeyObject | null;
    log: Log;
    now: () => Date;
}

interface RouterEvent {
    id: string;
    type: string;
    createdAt: Date;
    payload: Record<string, unknown>;
}

type Reply = { status: number; body: unknown };

const BAD_EVENT: Reply = { status: 400, body: { error: "bad_event" } };

function headerValue(v: string | string[] | undefined): string | undefined {
    return typeof v === "string" ? v : undefined;
}

function parseEvent(raw: Buffer): RouterEvent | null {
    let json: unknown;
    try {
        json = JSON.parse(raw.toString("utf8"));
    } catch {
        return null;
    }
    if (!isRecord(json)) return null;
    const { id, type, created_at: createdAt, payload } = json;
    if (typeof id !== "string" || id === "" || typeof type !== "string") return null;
    if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;
    return {
        id,
        type,
        createdAt: new Date(createdAt),
        payload: isRecord(payload) ? payload : {},
    };
}

function str(v: unknown): string | undefined {
    return typeof v === "string" && v !== "" ? v : undefined;
}

export async function handleEvent(
    d: EventDeps,
    raw: Buffer,
    h: IncomingHttpHeaders,
): Promise<Reply> {
    if (d.key === null) return { status: 503, body: { error: "events_disabled" } };
    const sig = headerValue(h["x-bugnet-signature"]);
    if (sig === undefined || !verifyEventSignature(d.key, raw, sig)) {
        return { status: 401, body: { error: "bad_signature" } };
    }
    const event = parseEvent(raw);
    if (event === null) return BAD_EVENT;
    if (event.id !== headerValue(h["x-bugnet-event-id"])) {
        return { status: 400, body: { error: "event_id_mismatch" } };
    }
    const orderId = str(event.payload.order_id) ?? null;
    const inserted = await d.pool.query(
        `insert into events (event_id, type, created_at, order_id, payload)
         values ($1, $2, $3, $4, $5) on conflict (event_id) do nothing`,
        [event.id, event.type, event.createdAt, orderId, JSON.stringify(event.payload)],
    );
    if (inserted.rowCount === 0) return { status: 200, body: { ok: true, duplicate: true } };
    try {
        await applyEvent(d, event);
    } catch (err) {
        // The id is already stored, so without this the router's retry would be dropped as a duplicate
        await d.pool.query("delete from events where event_id = $1", [event.id]).catch(() => {});
        throw err;
    }
    return { status: 200, body: { ok: true } };
}

async function applyEvent(d: EventDeps, event: RouterEvent): Promise<void> {
    const { payload } = event;
    const orderId =
        event.type === "placement.extended" ? str(payload.extend_order_id) : str(payload.order_id);
    if (orderId === undefined) return;
    if ((await findOrder(d.pool, orderId)) === null) {
        d.log.warn("event for an unknown order", { eventId: event.id, orderId });
        return;
    }
    await markEventSeen(d.pool, orderId, d.now());
    if (payload.refundable !== true) {
        await returnManualToRedeemed(d.pool, orderId, d.now(), PARKED_BY_SWEEPER);
        return;
    }
    if (event.type === "placement.terminated") {
        await refundTerminated(d, event, orderId);
        return;
    }
    const out = await requestRefund(d.pool, orderId, "router_refundable");
    d.log.info("router refund requested", { eventId: event.id, orderId, result: out });
}

interface RefundEntry {
    orderId: string;
    amountMicros: number;
}

// Null when any entry is malformed: a half-read array must not pay anyone.
function parseEntries(v: unknown): RefundEntry[] | null {
    if (!Array.isArray(v)) return null;
    const out: RefundEntry[] = [];
    for (const e of v) {
        if (!isRecord(e)) return null;
        const id = str(e.order_id);
        const micros = e.refund_micros;
        if (id === undefined || typeof micros !== "number") return null;
        if (!Number.isSafeInteger(micros) || micros < 0) return null;
        out.push({ orderId: id, amountMicros: micros });
    }
    return out;
}

// The router prices each order's refund; Payments pays exactly that, checked against what was paid.
async function refundTerminated(
    d: EventDeps,
    event: RouterEvent,
    startOrder: string,
): Promise<void> {
    const raw = event.payload.refunds;
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
        await parkManual(d, event, startOrder, "refund_amount_pending");
        return;
    }
    const entries = parseEntries(raw);
    if (entries === null) {
        const named = Array.isArray(raw)
            ? raw.map((e) => (isRecord(e) ? str(e.order_id) : undefined))
            : [];
        const orders = new Set([startOrder, ...named.filter((o) => o !== undefined)]);
        for (const id of orders) await parkManual(d, event, id, "refund_amount_invalid");
        return;
    }
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const e of entries) {
        if (seen.has(e.orderId)) repeated.add(e.orderId);
        seen.add(e.orderId);
    }
    for (const e of entries) {
        if (repeated.has(e.orderId)) {
            await parkManual(d, event, e.orderId, "refund_amount_invalid");
            continue;
        }
        if (e.amountMicros === 0) continue;
        const out = await requestRefund(d.pool, e.orderId, "router_refundable", e.amountMicros);
        if (out === "unknown") {
            d.log.warn("refund entry for an unknown order", {
                eventId: event.id,
                orderId: e.orderId,
            });
        } else if (out === "invalid_amount") {
            await parkManual(d, event, e.orderId, "refund_amount_invalid");
        } else {
            await markEventSeen(d.pool, e.orderId, d.now());
            d.log.info("router refund requested", {
                eventId: event.id,
                orderId: e.orderId,
                result: out,
            });
        }
    }
}

// A paid or redeemed order, or a manual one with no refund row, waits for an operator.
async function parkManual(
    d: EventDeps,
    event: RouterEvent,
    orderId: string,
    reason: "refund_amount_pending" | "refund_amount_invalid",
): Promise<void> {
    const parked = await withTx(d.pool, async (c) => {
        const order = await lockOrder(c, orderId);
        if (order === null) return false;
        if (order.state === "paid" || order.state === "redeemed") {
            await setOrderState(c, orderId, order.state, "manual", { manualReason: reason });
            return true;
        }
        if (order.state !== "manual" || (await findRefund(c, orderId)) !== null) return false;
        await c.query("update orders set manual_reason = $2 where id = $1", [orderId, reason]);
        return true;
    });
    if (!parked) return;
    d.log.alarm("manual_queue", {
        orderId,
        reason,
        eventId: event.id,
        terminationReason: str(event.payload.termination_reason),
        unusedSeconds: event.payload.unused_seconds,
    });
}
