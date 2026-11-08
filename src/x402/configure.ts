import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withTx } from "../db/pool.ts";
import { MAX_PINS, x402PinSchema } from "../orders/service.ts";
import { spendRateFits, type X402OrderDeps } from "./create.ts";
import { SERVICE_ID } from "./ids.ts";
import { feeDue, findAccountForHandle, lockAccount, placementEnded } from "./ledger.ts";
import type { ConfigureRefusal, ServiceState, X402AccountView, X402ServicePin } from "./types.ts";
import { accountView } from "./view.ts";

export interface ConfigureRequest {
    handleSha256: string;
    services: X402ServicePin[];
    disable: string[];
    spendPerMinuteMicros?: number;
    requestId: string;
}

export type ConfigureResult =
    { status: "ok"; x402: X402AccountView } | { status: "refused"; reason: ConfigureRefusal };

export class RouterUnavailableError extends Error {
    constructor() {
        super("router unavailable");
    }
}

const requestSchema = z.strictObject({
    handleSha256: z.string().regex(/^[0-9a-f]{64}$/),
    services: z.array(x402PinSchema).max(MAX_PINS).default([]),
    disable: z.array(z.string().regex(SERVICE_ID)).max(MAX_PINS).default([]),
    spendPerMinuteMicros: z.int().min(1).optional(),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

const refuse = (reason: ConfigureRefusal): ConfigureResult => ({ status: "refused", reason });

// Only what the caller decides enters the hash, so a re-probed replay still matches
export function configureRequestSha256(r: ConfigureRequest): Buffer {
    const services = [...r.services]
        .sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0))
        .map((s) => ({
            serviceId: s.serviceId,
            method: s.method,
            host: s.host,
            prefix: s.prefix,
            url: s.url,
            maxPriceMicros: s.maxPriceMicros,
            payTo: s.payTo,
        }));
    const disable = [...new Set(r.disable)].sort();
    const canonical = JSON.stringify({
        handleSha256: r.handleSha256,
        services,
        disable,
        spendPerMinuteMicros: r.spendPerMinuteMicros ?? null,
    });
    return createHash("sha256").update(canonical, "utf8").digest();
}

interface HeldRow {
    service_id: string;
    method: string;
    host: string;
    prefix: string;
    pay_to: string;
    max_price_micros: string;
    state: ServiceState;
}

class Twin extends Error {}

async function storedAnswer(
    pool: pg.Pool,
    accountId: string,
    r: ConfigureRequest,
): Promise<ConfigureResult | null> {
    const res = await pool.query<{ request_sha256: Buffer; answer: ConfigureResult }>(
        "select request_sha256, answer from x402_configure_requests where account_id = $1 and request_id = $2",
        [accountId, r.requestId],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    return row.request_sha256.equals(configureRequestSha256(r))
        ? row.answer
        : refuse("idempotency_conflict");
}

export async function configure(
    pool: pg.Pool,
    d: X402OrderDeps,
    body: unknown,
    signal: AbortSignal,
): Promise<ConfigureResult> {
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return refuse("bad_request");
    const r: ConfigureRequest = parsed.data;
    const sent = new Set(r.services.map((s) => s.serviceId));
    if (sent.size !== r.services.length) return refuse("bad_request");
    if (r.disable.some((id) => sent.has(id))) return refuse("bad_request");

    const found = await findAccountForHandle(pool, d.router, r.handleSha256, signal);
    if (found.kind === "unavailable") return refuse("router_unavailable");
    if (found.kind !== "found") return refuse("no_account");
    const account = found.account;

    const replay = await storedAnswer(pool, account.id, r);
    if (replay !== null) return replay;

    if (account.state !== "open" || (await placementEnded(pool, account.id))) {
        return refuse("sandbox_ended");
    }

    try {
        return await withTx(
            pool,
            async (c) => {
                const locked = await lockAccount(c, account.id);
                if (locked === null || locked.state !== "open") return refuse("sandbox_ended");
                const held = await c.query<HeldRow>(
                    `select service_id, method, host, prefix, pay_to, max_price_micros, state
                 from x402_services where account_id = $1 order by service_id for no key update`,
                    [account.id],
                );
                const rows = new Map(
                    held.rows.map((h) => [
                        h.service_id,
                        { price: Number(h.max_price_micros), state: h.state },
                    ]),
                );
                const byId = new Map(held.rows.map((h) => [h.service_id, h]));
                for (const p of r.services) {
                    const h = byId.get(p.serviceId);
                    if (
                        h === undefined ||
                        h.method !== p.method ||
                        h.host !== p.host ||
                        h.prefix !== p.prefix ||
                        h.pay_to !== p.payTo
                    ) {
                        return refuse("needs_payment");
                    }
                    if (p.maxPriceMicros > d.x402.max_price_per_call_micros) {
                        return refuse("price_above_ceiling");
                    }
                    rows.set(p.serviceId, {
                        price: p.maxPriceMicros,
                        state: h.state === "disabled" ? "enabled" : h.state,
                    });
                }
                for (const id of r.disable) {
                    const row = rows.get(id);
                    if (row === undefined) return refuse("needs_payment");
                    row.state = "disabled";
                }
                const live = [...rows.values()].filter((v) => v.state !== "disabled");
                if (live.length > d.x402.max_services) return refuse("too_many_services");
                const limit = r.spendPerMinuteMicros ?? locked.spendPerMinuteMicros;
                const prices = live.map((v) => v.price);
                if (!spendRateFits(limit, prices, d.x402)) return refuse("spend_rate_out_of_range");

                const now = d.now();
                for (const id of [...sent, ...r.disable]) {
                    const row = rows.get(id)!;
                    await c.query(
                        `update x402_services set max_price_micros = $3, state = $4, updated_at = $5
                     where account_id = $1 and service_id = $2`,
                        [account.id, id, row.price, row.state, now],
                    );
                }
                if (r.spendPerMinuteMicros !== undefined) {
                    await c.query(
                        "update x402_accounts set spend_per_minute_micros = $2 where id = $1",
                        [account.id, r.spendPerMinuteMicros],
                    );
                }
                const answer: ConfigureResult = {
                    status: "ok",
                    x402: await accountView(c, account.id, d.x402),
                };
                const stored = await c.query(
                    `insert into x402_configure_requests (account_id, request_id, request_sha256, answer)
                 values ($1, $2, $3, $4::jsonb) on conflict do nothing`,
                    [account.id, r.requestId, configureRequestSha256(r), JSON.stringify(answer)],
                );
                if (stored.rowCount === 0) throw new Twin();
                return answer;
            },
            d.log,
        );
    } catch (err) {
        if (!(err instanceof Twin)) throw err;
        return (await storedAnswer(pool, account.id, r))!;
    }
}

export async function accountAnswer(
    pool: pg.Pool,
    d: X402OrderDeps,
    handleSha256: string,
    signal: AbortSignal,
): Promise<{ x402: X402AccountView | null; feeDue: boolean }> {
    const found = await findAccountForHandle(pool, d.router, handleSha256, signal);
    if (found.kind === "unavailable") throw new RouterUnavailableError();
    if (found.kind !== "found") return { x402: null, feeDue: true };
    const id = found.account.id;
    return { x402: await accountView(pool, id, d.x402), feeDue: await feeDue(pool, id) };
}
