import type pg from "pg";
import type { Settings } from "../config.ts";
import type { Queryable } from "../db/pool.ts";
import type { Log } from "../log.ts";
import type { OrderRequest, OrderResult } from "../orders/types.ts";
import type { PlacementState, RouterClient } from "../router/client.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { readControls } from "./controls.ts";
import { describeOrder } from "./describe.ts";
import type { IndexCopy } from "./index-file.ts";
import { ceilingUsedMicros, feeDue, findAccountForHandle, insertAccount } from "./ledger.ts";
import { serviceIdFor } from "./ids.ts";
import { checkPin } from "./pins.ts";
import type {
    AccountRow,
    BugnetAddresses,
    PayInto,
    ServiceState,
    SignerHealth,
    StoredPin,
    StoredX402Setup,
    X402ServicePin,
    X402Setup,
} from "./types.ts";

export interface X402OrderDeps {
    x402: Settings["x402"];
    allowanceClaim: boolean;
    router: RouterClient;
    rpc: SolanaRpc;
    index: () => IndexCopy;
    signer: SignerHealth;
    addresses: BugnetAddresses;
    rpcTimeoutMs: number;
    log: Log;
    now: () => Date;
}

export class RpcUnavailableError extends Error {
    constructor(readonly errorClass: string) {
        super("payee check unreachable");
    }
}

export type ValidCreate = Required<
    Pick<OrderRequest, "kind" | "packageId" | "amountMicros" | "description">
> &
    Pick<
        OrderRequest,
        "handleSha256" | "allowanceMicros" | "feeMicros" | "x402" | "idempotencyKey"
    >;

type Refused = Extract<OrderResult, { status: "refused" }>;

export type CreatePlan =
    | {
          ok: true;
          payInto: PayInto;
          allowanceMicros: number;
          feeMicros: number;
          setup: StoredX402Setup | null;
          description: string;
          ttlMs: number;
      }
    | { ok: false; refused: Refused };

interface HeldService {
    serviceId: string;
    payTo: string;
    maxPriceMicros: number;
    state: ServiceState;
    listed: StoredPin["listed"];
    paidPath: string | null;
}

const PG_FOREIGN_KEY = "23503";

function refuse(reason: Refused["reason"], extra: Partial<Refused> = {}): CreatePlan {
    return { ok: false, refused: { status: "refused", reason, ...extra } };
}

export async function settleGate(
    db: Queryable,
    d: Pick<X402OrderDeps, "x402" | "signer">,
): Promise<"x402_disabled" | "x402_paused" | "x402_unavailable" | null> {
    if (!d.x402.enabled) return "x402_disabled";
    const controls = await readControls(db);
    if (controls.disabled) return "x402_disabled";
    if (controls.paused) return "x402_paused";
    if (!d.signer.open()) return "x402_unavailable";
    return null;
}

export function spendRateFits(
    limitMicros: number,
    enabledMaxPrices: readonly number[],
    x402: Settings["x402"],
): boolean {
    return (
        limitMicros >= x402.min_spend_per_minute_micros &&
        limitMicros <= x402.max_spend_per_minute_micros &&
        enabledMaxPrices.every((price) => price <= limitMicros)
    );
}

function canonicalSetup(s: {
    services?: ReadonlyArray<
        Pick<
            X402ServicePin,
            "serviceId" | "method" | "host" | "prefix" | "url" | "maxPriceMicros" | "payTo"
        >
    >;
    disable?: readonly string[];
    spendPerMinuteMicros?: number | null;
}): string {
    const services = [...(s.services ?? [])]
        .sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0))
        .map((p) => [p.serviceId, p.method, p.host, p.prefix, p.url, p.maxPriceMicros, p.payTo]);
    const disable = [...new Set(s.disable ?? [])].sort();
    return JSON.stringify([services, disable, s.spendPerMinuteMicros ?? null]);
}

export function sameSetupTerms(
    sent: X402Setup | undefined,
    stored: StoredX402Setup | null,
): boolean {
    if (sent === undefined) return true;
    if (stored === null) return false;
    return canonicalSetup(sent) === canonicalSetup(stored);
}

// Postgres refuses jsonb text holding \u0000 or a lone surrogate, which would fail the order's
// insert after the checks passed
function storable(v: unknown): boolean {
    if (typeof v === "string") return !v.includes("\0") && v.isWellFormed();
    if (Array.isArray(v)) return v.every(storable);
    if (v !== null && typeof v === "object") {
        return Object.entries(v).every(([k, x]) => storable(k) && storable(x));
    }
    return true;
}

async function heldServices(db: Queryable, accountId: string): Promise<HeldService[]> {
    const res = await db.query<{
        service_id: string;
        pay_to: string;
        max_price_micros: string | number;
        state: ServiceState;
        listed: StoredPin["listed"];
        paid_path: string | null;
    }>(
        `select service_id, pay_to, max_price_micros, state, listed, paid_path
         from x402_services where account_id = $1`,
        [accountId],
    );
    return res.rows.map((r) => ({
        serviceId: r.service_id,
        payTo: r.pay_to,
        maxPriceMicros: Number(r.max_price_micros),
        state: r.state,
        listed: r.listed,
        paidPath: r.paid_path,
    }));
}

const live = (state: PlacementState) => state === "placing" || state === "ready";

type Located = { account: AccountRow | null } | { reason: Refused["reason"] };

async function locateAccount(
    pool: pg.Pool,
    d: X402OrderDeps,
    r: ValidCreate,
    signal: AbortSignal,
): Promise<Located> {
    const no = (reason: Refused["reason"]): Located => ({ reason });
    if (r.kind !== "allowance") return { account: null };
    const found = await findAccountForHandle(pool, d.router, r.handleSha256!, signal);
    switch (found.kind) {
        case "unknown":
            return no("sandbox_unknown");
        case "unavailable":
            return no("router_unavailable");
        case "found":
            if (found.account.state !== "open") return no("sandbox_ended");
            if (found.placementState !== undefined && !live(found.placementState)) {
                return no("sandbox_ended");
            }
            return { account: found.account };
        case "placement": {
            const p = found.placement;
            if (!live(p.state)) return no("sandbox_ended");
            if (!p.x402Capable) return no("sandbox_not_capable");
            try {
                const account = await insertAccount(pool, {
                    id: p.startOrderId,
                    handleSha256: r.handleSha256!,
                    placementId: p.placementId,
                    packageId: p.packageId,
                    spendPerMinuteMicros: d.x402.default_spend_per_minute_micros,
                    deadline: p.deadline,
                    createdAt: d.now(),
                });
                return { account };
            } catch (err) {
                if ((err as { code?: unknown } | null)?.code === PG_FOREIGN_KEY) {
                    return no("sandbox_unknown");
                }
                throw err;
            }
        }
    }
}

export async function planOrder(
    pool: pg.Pool,
    d: X402OrderDeps,
    r: ValidCreate,
    signal: AbortSignal,
): Promise<CreatePlan> {
    const x = d.x402;
    const allowanceMicros = r.allowanceMicros ?? 0;
    const feeMicros = r.feeMicros ?? 0;

    const gate = await settleGate(pool, d);
    if (gate !== null) return refuse(gate);
    if (r.kind === "start" && !d.allowanceClaim) return refuse("x402_start_unavailable");
    if (allowanceMicros < x.min_allowance_micros) return refuse("amount_too_small");

    const located = await locateAccount(pool, d, r, signal);
    if ("reason" in located) return refuse(located.reason);
    const { account } = located;
    const due = await feeDue(pool, account?.id ?? null);
    if (feeMicros !== (due ? x.session_fee_micros : 0)) return refuse("fee_mismatch");

    const held = account === null ? [] : await heldServices(pool, account.id);
    const heldById = new Map(held.map((h) => [h.serviceId, h]));
    const pins = r.x402?.services ?? [];
    const disable = new Set(r.x402?.disable ?? []);

    const live = new Set(held.filter((h) => h.state !== "disabled").map((h) => h.serviceId));
    for (const p of pins) live.add(p.serviceId);
    for (const id of disable) live.delete(id);
    if (live.size > x.max_services) return refuse("too_many_services");
    if (pins.some((p) => p.maxPriceMicros > x.max_price_per_call_micros)) {
        return refuse("price_above_ceiling");
    }

    const isNew = (p: X402ServicePin) => {
        const row = heldById.get(p.serviceId);
        return row === undefined || row.payTo !== p.payTo;
    };
    const checks = new Map<string, { listed: StoredPin["listed"]; paidPath: string | null }>();
    const rules = { bugnet: d.addresses.all, sellerMemoMaxBytes: x.seller_memo_max_bytes };
    for (const p of pins) {
        if (!storable(p)) {
            return refuse("pin_refused", { serviceId: p.serviceId, pinReason: "flow_unsupported" });
        }
        if (serviceIdFor(p.method, p.host, p.prefix) !== p.serviceId) {
            return refuse("pin_refused", {
                serviceId: p.serviceId,
                pinReason: "service_id_mismatch",
            });
        }
        if (!isNew(p)) continue;
        const check = await checkPin(p, {
            index: d.index(),
            rpc: d.rpc,
            rules,
            rpcTimeoutMs: d.rpcTimeoutMs,
        });
        if (!check.ok) {
            if ("unavailable" in check) throw new RpcUnavailableError(check.cause);
            return refuse("pin_refused", { serviceId: p.serviceId, pinReason: check.pinReason });
        }
        checks.set(p.serviceId, { listed: check.listed, paidPath: check.paidPath });
    }

    const limit =
        r.x402?.spendPerMinuteMicros ??
        account?.spendPerMinuteMicros ??
        x.default_spend_per_minute_micros;
    const prices = new Map(
        held.filter((h) => h.state === "enabled").map((h) => [h.serviceId, h.maxPriceMicros]),
    );
    for (const p of pins) prices.set(p.serviceId, p.maxPriceMicros);
    for (const id of disable) prices.delete(id);
    if (!spendRateFits(limit, [...prices.values()], x)) return refuse("spend_rate_out_of_range");

    if (checks.size > x.max_new_services_per_order) return refuse("description_too_long");

    const used = account === null ? 0 : await ceilingUsedMicros(pool, account.id);
    if (used + allowanceMicros > x.max_allowance_per_sandbox_micros) {
        return refuse("allowance_ceiling");
    }

    const services: StoredPin[] = pins.map((p) => {
        const fresh = checks.get(p.serviceId);
        const row = heldById.get(p.serviceId);
        const { listed, paidPath } = fresh ?? { listed: row!.listed, paidPath: row!.paidPath };
        return { ...p, listed, paidPath, newPin: fresh !== undefined };
    });
    const setup: StoredX402Setup = {
        services,
        disable: r.x402?.disable ?? [],
        spendPerMinuteMicros: r.x402?.spendPerMinuteMicros ?? null,
    };
    return {
        ok: true,
        payInto: "allowance",
        allowanceMicros,
        feeMicros,
        setup,
        description: describeOrder({
            kind: r.kind === "start" ? "start" : "allowance",
            packageText: r.description,
            allowanceMicros,
            feeMicros,
            pins: services,
        }),
        ttlMs: x.unpaid_allowance_order_ttl,
    };
}
