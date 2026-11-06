import { sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryLog } from "../log.ts";
import { orderKey, orderPublicKeyBase64 } from "../orders/token.ts";
import { findOrder } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { findRefund } from "../refunds/request.ts";
import { type TestApp, testApp } from "../testing/app.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import { eventPublicKey, handleEvent, verifyEventSignature } from "./handler.ts";

const seed = Buffer.alloc(32, 9);
let app: TestApp;
let n = 0;
beforeAll(async () => {
    app = await testApp();
});
afterAll(async () => {
    await app.close();
});

function raw(event: unknown): Buffer {
    return Buffer.from(JSON.stringify(event));
}

function sign64(s: Buffer, body: Buffer): string {
    return sign(null, body, orderKey(s)).toString("base64");
}

async function postEvent(
    body: Buffer,
    signature: string | null,
    id: string | null,
): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== null) headers["x-bugnet-signature"] = signature;
    if (id !== null) headers["x-bugnet-event-id"] = id;
    const res = await fetch(`${app.internalUrl}/v1/events`, {
        method: "POST",
        headers,
        body: new Uint8Array(body),
    });
    return { status: res.status, body: await res.json() };
}

function failed(orderId: string, id: string, refundable = true): Buffer {
    return raw({
        id,
        type: "placement.failed",
        created_at: "2026-11-06T12:00:00Z",
        payload: {
            placement_id: "p",
            order_id: orderId,
            state: "failed",
            provider: "",
            deadline: null,
            billed_seconds: 0,
            refundable,
            reason: "boot_failed",
        },
    });
}

function terminated(orderId: string, id: string, extra: Record<string, unknown>): Buffer {
    return raw({
        id,
        type: "placement.terminated",
        created_at: "2026-11-06T12:00:00Z",
        payload: { placement_id: "p", order_id: orderId, state: "terminated", ...extra },
    });
}

function eid(): string {
    n += 1;
    return `evt-${n}-${Math.random().toString(36).slice(2)}`;
}

async function send(body: Buffer): Promise<{ status: number; body: unknown }> {
    const id = (JSON.parse(body.toString()) as { id: string }).id;
    return postEvent(body, sign64(seed, body), id);
}

async function seeded(
    state: OrderRow["state"],
    over: Partial<OrderRow> = {},
    pay: { payer?: string; sourceTokenAccount?: string } = {},
): Promise<OrderRow> {
    const { order } = await seedOrder(app.pool, { state, ...over });
    await seedPayment(app.pool, order.id, { status: "confirmed", ...pay });
    return order;
}

async function refundRows(orderId: string): Promise<number> {
    const res = await app.pool.query("select count(*)::int as n from refunds where order_id = $1", [
        orderId,
    ]);
    return res.rows[0].n;
}

async function eventRows(id: string): Promise<number> {
    const res = await app.pool.query("select count(*)::int as n from events where event_id = $1", [
        id,
    ]);
    return res.rows[0].n;
}

describe("signature helpers", () => {
    it("verifies the exact bytes and rejects other keys, lengths and padding", () => {
        const key = eventPublicKey(orderPublicKeyBase64(seed));
        const body = Buffer.from("hello");
        const sig = sign64(seed, body);
        expect(verifyEventSignature(key, body, sig)).toBe(true);
        expect(verifyEventSignature(key, Buffer.from("hellO"), sig)).toBe(false);
        expect(verifyEventSignature(key, body, sig.replace(/=+$/, "") + "A")).toBe(false);
        expect(verifyEventSignature(key, body, sig.replace(/=+$/, ""))).toBe(false);
        expect(verifyEventSignature(key, body, "")).toBe(false);
        expect(verifyEventSignature(key, body, Buffer.alloc(63).toString("base64"))).toBe(false);
        const other = eventPublicKey(orderPublicKeyBase64(Buffer.alloc(32, 8)));
        expect(verifyEventSignature(other, body, sig)).toBe(false);
    });

    it("refuses a public key that is not 32 bytes", () => {
        expect(() => eventPublicKey(Buffer.alloc(31).toString("base64"))).toThrow();
    });
});

describe("events", () => {
    it("refunds on a signed refundable failure", async () => {
        const redeemed = await seeded("redeemed");
        const id = eid();
        const body = failed(redeemed.id, id);
        expect(await postEvent(body, sign64(seed, body), id)).toEqual({
            status: 200,
            body: { ok: true },
        });
        expect((await findOrder(app.pool, redeemed.id))!.state).toBe("refunding");
        expect(await findRefund(app.pool, redeemed.id)).toMatchObject({
            kind: "full",
            reason: "router_refundable",
            amountMicros: 10_000,
        });
        expect((await findOrder(app.pool, redeemed.id))!.eventSeenAt).not.toBeNull();
    });

    it("does not refund a non-refundable event but marks the order seen", async () => {
        const redeemed = await seeded("redeemed");
        const out = await send(failed(redeemed.id, eid(), false));
        expect(out.status).toBe(200);
        expect(await refundRows(redeemed.id)).toBe(0);
        expect((await findOrder(app.pool, redeemed.id))!).toMatchObject({
            state: "redeemed",
            eventSeenAt: app.now.get(),
        });
    });

    it("drops a duplicate event", async () => {
        const redeemed = await seeded("redeemed");
        const id = eid();
        const body = failed(redeemed.id, id);
        expect((await postEvent(body, sign64(seed, body), id)).body).toEqual({ ok: true });
        expect(await postEvent(body, sign64(seed, body), id)).toEqual({
            status: 200,
            body: { ok: true, duplicate: true },
        });
        expect(await refundRows(redeemed.id)).toBe(1);
        expect(await eventRows(id)).toBe(1);
    });

    it("verifies the exact raw bytes", async () => {
        const redeemed = await seeded("redeemed");
        const id = eid();
        // refundable before order_id is jsonb key order, not the order a Go struct marshals in
        const body = Buffer.from(
            `{"id":"${id}","type":"placement.failed","created_at":"2026-11-06T12:00:00Z",` +
                `"payload":{"refundable":true,"order_id":"${redeemed.id}" , "reason":"x"}}`,
        );
        const sig = sign64(seed, body);
        const tampered = Buffer.from(body);
        tampered[tampered.length - 3] = tampered[tampered.length - 3]! ^ 1;
        expect(await postEvent(tampered, sig, id)).toEqual({
            status: 401,
            body: { error: "bad_signature" },
        });
        expect(await eventRows(id)).toBe(0);
        expect((await postEvent(body, sig, id)).status).toBe(200);
        expect((await findOrder(app.pool, redeemed.id))!.state).toBe("refunding");
    });

    it("refuses a missing or wrong signature and a mismatched id", async () => {
        const redeemed = await seeded("redeemed");
        const id = eid();
        const body = failed(redeemed.id, id);
        expect(await postEvent(body, null, id)).toEqual({
            status: 401,
            body: { error: "bad_signature" },
        });
        expect((await postEvent(body, sign64(Buffer.alloc(32, 1), body), id)).status).toBe(401);
        expect(await postEvent(body, sign64(seed, body), "other-id")).toEqual({
            status: 400,
            body: { error: "event_id_mismatch" },
        });
        expect((await postEvent(body, sign64(seed, body), null)).status).toBe(400);
        expect(await eventRows(id)).toBe(0);
        expect((await findOrder(app.pool, redeemed.id))!.state).toBe("redeemed");
    });

    it("answers 400 for a signed body that is not an event", async () => {
        for (const text of ["not json", "[]", '{"id":"x"}']) {
            const body = Buffer.from(text);
            const out = await postEvent(body, sign64(seed, body), "x");
            expect(out.status).toBe(400);
        }
    });

    it("stores unknown types and unknown orders without changing state", async () => {
        const redeemed = await seeded("redeemed");
        const parked = await seeded("manual", { manualReason: "no_event_unverifiable" });
        const id = eid();
        const blocked = raw({
            id,
            type: "wallet.blocked",
            created_at: "2026-11-06T12:00:00Z",
            payload: { wallet: "w" },
        });
        expect((await send(blocked)).status).toBe(200);
        expect(await eventRows(id)).toBe(1);
        for (const target of [redeemed, parked]) {
            for (const refundable of [true, false]) {
                const evId = eid();
                const body = raw({
                    id: evId,
                    type: "wallet.blocked",
                    created_at: "2026-11-06T12:00:00Z",
                    payload: { order_id: target.id, refundable },
                });
                expect((await send(body)).status).toBe(200);
                expect(await eventRows(evId)).toBe(1);
            }
        }
        expect(await findOrder(app.pool, redeemed.id)).toMatchObject({
            state: "redeemed",
            eventSeenAt: null,
        });
        expect(await findOrder(app.pool, parked.id)).toMatchObject({
            state: "manual",
            manualReason: "no_event_unverifiable",
            routerConfirmedAt: null,
        });
        expect(await refundRows(redeemed.id)).toBe(0);
        const ghostId = eid();
        expect((await send(failed("ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", ghostId))).status).toBe(200);
        expect(await eventRows(ghostId)).toBe(1);
    });

    it("marks the extend order seen on placement.extended", async () => {
        const extend = await seeded("redeemed", {
            kind: "extend",
            handleSha256: "a".repeat(64),
        });
        const start = await seeded("redeemed");
        const body = raw({
            id: eid(),
            type: "placement.extended",
            created_at: "2026-11-06T12:00:00Z",
            payload: { order_id: start.id, extend_order_id: extend.id, refundable: false },
        });
        expect((await send(body)).status).toBe(200);
        expect((await findOrder(app.pool, extend.id))!.eventSeenAt).toEqual(app.now.get());
        expect((await findOrder(app.pool, start.id))!.eventSeenAt).toBeNull();
        const row = await app.pool.query("select order_id from events where event_id = $1", [
            JSON.parse(body.toString()).id,
        ]);
        expect(row.rows[0].order_id).toBe(extend.id);
    });

    it("returns a parked manual order to redeemed on a non-refundable event", async () => {
        for (const reason of ["no_event_unverifiable", "abandon_unverifiable"]) {
            const parked = await seeded("manual", { manualReason: reason });
            const body = raw({
                id: eid(),
                type: "placement.ready",
                created_at: "2026-11-06T12:00:00Z",
                payload: { order_id: parked.id, refundable: false },
            });
            expect((await send(body)).status).toBe(200);
            expect(await findOrder(app.pool, parked.id)).toMatchObject({
                state: "redeemed",
                manualReason: null,
                eventSeenAt: app.now.get(),
                routerConfirmedAt: app.now.get(),
            });
        }
    });

    it("leaves a manual order parked for another reason alone", async () => {
        const parked = await seeded("manual", { manualReason: "refund_failed" });
        await send(failed(parked.id, eid(), false));
        expect(await findOrder(app.pool, parked.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_failed",
        });
    });

    it("refunds a parked manual order on a refundable event", async () => {
        const parked = await seeded("manual", { manualReason: "no_event_unverifiable" });
        expect((await send(failed(parked.id, eid()))).status).toBe(200);
        expect((await findOrder(app.pool, parked.id))!.state).toBe("refunding");
        expect(await refundRows(parked.id)).toBe(1);
    });

    it("answers 503 when no key is configured", async () => {
        const out = await handleEvent(
            { pool: app.pool, key: null, log: memoryLog(), now: app.now.get },
            Buffer.from("{}"),
            {},
        );
        expect(out).toEqual({ status: 503, body: { error: "events_disabled" } });
    });

    it("keeps the stored event when applying fails and applies it on the retry", async () => {
        const redeemed = await seeded("redeemed");
        const id = eid();
        const body = failed(redeemed.id, id);
        const key = eventPublicKey(orderPublicKeyBase64(seed));
        // Only the transactional path (connect) fails, so the insert lands and the apply throws
        const pool = new Proxy(app.pool, {
            get(target, prop) {
                if (prop === "connect") return () => Promise.reject(new Error("db down"));
                const v = Reflect.get(target, prop, target);
                return typeof v === "function" ? v.bind(target) : v;
            },
        });
        const headers = { "x-bugnet-signature": sign64(seed, body), "x-bugnet-event-id": id };
        await expect(
            handleEvent({ pool, key, log: memoryLog(), now: app.now.get }, body, headers),
        ).rejects.toThrow("db down");
        expect(await eventRows(id)).toBe(1);
        const retry = await send(body);
        expect(retry).toEqual({ status: 200, body: { ok: true } });
        expect((await findOrder(app.pool, redeemed.id))!.state).toBe("refunding");
        expect(await send(body)).toEqual({ status: 200, body: { ok: true, duplicate: true } });
        expect(await refundRows(redeemed.id)).toBe(1);
    });
});

describe("placement.terminated refunds", () => {
    it("creates a partial refund per entry, each to its own order's payment source", async () => {
        const start = await seeded(
            "redeemed",
            {},
            { payer: "payer-1", sourceTokenAccount: "src-1" },
        );
        const extend = await seeded(
            "redeemed",
            { kind: "extend", handleSha256: "b".repeat(64), amountMicros: 5_000 },
            { payer: "payer-2", sourceTokenAccount: "src-2" },
        );
        const body = terminated(start.id, eid(), {
            refundable: true,
            termination_reason: "provider_failed",
            refunds: [
                { order_id: start.id, refund_micros: 6_000 },
                { order_id: extend.id, refund_micros: 2_500 },
            ],
        });
        expect((await send(body)).status).toBe(200);
        expect(await findRefund(app.pool, start.id)).toMatchObject({
            kind: "partial",
            reason: "router_refundable",
            amountMicros: 6_000,
            destination: "src-1",
            payer: "payer-1",
        });
        expect(await findRefund(app.pool, extend.id)).toMatchObject({
            kind: "partial",
            amountMicros: 2_500,
            destination: "src-2",
            payer: "payer-2",
        });
        expect((await findOrder(app.pool, extend.id))!.state).toBe("refunding");
        expect((await findOrder(app.pool, extend.id))!.eventSeenAt).not.toBeNull();
    });

    it("creates nothing new on a replay of the event", async () => {
        const start = await seeded("redeemed");
        const body = terminated(start.id, eid(), {
            refundable: true,
            refunds: [{ order_id: start.id, refund_micros: 3_000 }],
        });
        await send(body);
        expect((await send(body)).body).toEqual({ ok: true, duplicate: true });
        const again = terminated(start.id, eid(), {
            refundable: true,
            refunds: [{ order_id: start.id, refund_micros: 3_000 }],
        });
        expect((await send(again)).status).toBe(200);
        expect(await refundRows(start.id)).toBe(1);
    });

    it("skips zero amounts and unknown orders", async () => {
        const start = await seeded("redeemed");
        const log = app.log.lines.length;
        const body = terminated(start.id, eid(), {
            refundable: true,
            refunds: [
                { order_id: start.id, refund_micros: 0 },
                { order_id: "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb", refund_micros: 500 },
            ],
        });
        expect((await send(body)).status).toBe(200);
        expect(await refundRows(start.id)).toBe(0);
        expect((await findOrder(app.pool, start.id))!.state).toBe("redeemed");
        expect(
            app.log.lines
                .slice(log)
                .some((l) => l.level === "warn" && /unknown order/.test(String(l.msg))),
        ).toBe(true);
    });

    it("parks an entry above what the order paid as manual refund_amount_invalid", async () => {
        const start = await seeded("redeemed");
        const body = terminated(start.id, eid(), {
            refundable: true,
            refunds: [{ order_id: start.id, refund_micros: 10_001 }],
        });
        expect((await send(body)).status).toBe(200);
        expect(await findOrder(app.pool, start.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_amount_invalid",
        });
        expect(await refundRows(start.id)).toBe(0);
        expect(
            app.log.lines.some((l) => l.alarm === "manual_queue" && l.orderId === start.id),
        ).toBe(true);
    });

    it("parks a duplicated order_id in one event without refunding it", async () => {
        const start = await seeded("redeemed");
        const other = await seeded("redeemed");
        const body = terminated(start.id, eid(), {
            refundable: true,
            refunds: [
                { order_id: start.id, refund_micros: 100 },
                { order_id: start.id, refund_micros: 200 },
                { order_id: other.id, refund_micros: 300 },
            ],
        });
        await send(body);
        expect(await findOrder(app.pool, start.id)).toMatchObject({
            state: "manual",
            manualReason: "refund_amount_invalid",
        });
        expect(await refundRows(start.id)).toBe(0);
        expect(await refundRows(other.id)).toBe(1);
    });

    it("parks every order of an event with a malformed refunds array, refunding none", async () => {
        const start = await seeded("redeemed");
        const other = await seeded("redeemed");
        const body = terminated(start.id, eid(), {
            refundable: true,
            refunds: [
                { order_id: other.id, refund_micros: 100 },
                { order_id: start.id, refund_micros: -1 },
            ],
        });
        await send(body);
        for (const o of [start, other]) {
            expect(await findOrder(app.pool, o.id)).toMatchObject({
                state: "manual",
                manualReason: "refund_amount_invalid",
            });
            expect(await refundRows(o.id)).toBe(0);
        }
        const notArray = await seeded("redeemed");
        await send(terminated(notArray.id, eid(), { refundable: true, refunds: "all" }));
        expect((await findOrder(app.pool, notArray.id))!.manualReason).toBe(
            "refund_amount_invalid",
        );
    });

    it("parks the start order as refund_amount_pending when refunds are absent", async () => {
        const missing = await seeded("redeemed");
        await send(terminated(missing.id, eid(), { refundable: true }));
        const empty = await seeded("paid");
        await send(terminated(empty.id, eid(), { refundable: true, refunds: [] }));
        const nil = await seeded("redeemed");
        await send(terminated(nil.id, eid(), { refundable: true, refunds: null }));
        for (const o of [missing, empty, nil]) {
            expect(await findOrder(app.pool, o.id)).toMatchObject({
                state: "manual",
                manualReason: "refund_amount_pending",
            });
            expect(await refundRows(o.id)).toBe(0);
        }
        expect(
            app.log.lines.some((l) => l.alarm === "manual_queue" && l.orderId === missing.id),
        ).toBe(true);
    });

    it("refunds an extension entry when the start order id is unknown or missing", async () => {
        const extend = await seeded("redeemed", {
            kind: "extend",
            handleSha256: "c".repeat(64),
        });
        const entries = [
            { order_id: "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb", refund_micros: 100 },
            { order_id: extend.id, refund_micros: 2_000 },
        ];
        const log = app.log.lines.length;
        await send(
            terminated("ord_bbbbbbbbbbbbbbbbbbbbbbbbbb", eid(), {
                refundable: true,
                refunds: entries,
            }),
        );
        expect(await findRefund(app.pool, extend.id)).toMatchObject({ amountMicros: 2_000 });
        expect(
            app.log.lines
                .slice(log)
                .some((l) => l.level === "warn" && /unknown order/.test(String(l.msg))),
        ).toBe(true);
        const other = await seeded("redeemed", { kind: "extend", handleSha256: "d".repeat(64) });
        const mark = app.log.lines.length;
        await send(
            raw({
                id: eid(),
                type: "placement.terminated",
                created_at: "2026-11-06T12:00:00Z",
                payload: {
                    refundable: true,
                    refunds: [{ order_id: other.id, refund_micros: 500 }],
                },
            }),
        );
        expect(await findRefund(app.pool, other.id)).toMatchObject({ amountMicros: 500 });
        expect(
            app.log.lines
                .slice(mark)
                .some((l) => l.level === "warn" && /without an order id/.test(String(l.msg))),
        ).toBe(true);
    });

    it("does not park an order already parked with the same reason again", async () => {
        const start = await seeded("redeemed");
        await send(terminated(start.id, eid(), { refundable: true }));
        const alarms = () => app.log.lines.filter((l) => l.alarm === "manual_queue").length;
        const before = alarms();
        await send(terminated(start.id, eid(), { refundable: true }));
        expect(alarms()).toBe(before);
    });

    it("pays a sweeper-parked refund_amount_pending order when the amounts arrive", async () => {
        const parked = await seeded("manual", { manualReason: "refund_amount_pending" });
        await send(
            terminated(parked.id, eid(), {
                refundable: true,
                refunds: [{ order_id: parked.id, refund_micros: 7_000 }],
            }),
        );
        expect((await findOrder(app.pool, parked.id))!.state).toBe("refunding");
        expect(await findRefund(app.pool, parked.id)).toMatchObject({
            kind: "partial",
            amountMicros: 7_000,
        });
    });

    it("does not refund when the termination is not refundable", async () => {
        const start = await seeded("redeemed");
        await send(
            terminated(start.id, eid(), {
                refundable: false,
                refunds: [{ order_id: start.id, refund_micros: 100 }],
            }),
        );
        expect(await refundRows(start.id)).toBe(0);
        expect((await findOrder(app.pool, start.id))!.state).toBe("redeemed");
    });

    it("still refunds a refundable failure in full", async () => {
        const start = await seeded("redeemed");
        await send(failed(start.id, eid()));
        expect(await findRefund(app.pool, start.id)).toMatchObject({
            kind: "full",
            amountMicros: 10_000,
        });
    });
});
