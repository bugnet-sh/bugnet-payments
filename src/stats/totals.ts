import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";

export interface StatsMoney {
    earnedMicros: number;
    refundedMicros: number;
    allowanceReturnedMicros: number;
    x402SpentMicros: number;
}

export interface StatsTotals {
    version: 1;
    daily: ({ day: string } & StatsMoney)[];
    totals: StatsMoney;
    byKind: {
        kind: "sandbox" | "extend" | "x402_allowance" | "x402_fee";
        count: number;
        micros: number;
    }[];
    refunds: { count: number; micros: number };
    byMethod: { method: string; count: number; micros: number }[];
    limits: Record<string, number>;
}

type MoneyKey = keyof StatsMoney;

const DAY_MS = 86_400_000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// The four money kinds by UTC day, a null day for a row without its time
const DAILY_SQL = `
    select 'earnedMicros' as what, to_char(p.confirmed_at at time zone 'UTC', 'YYYY-MM-DD') as day,
        count(*)::text as n, sum(o.amount_micros - o.allowance_micros)::text as micros
      from payments p join orders o on o.id = p.order_id
     where p.status = 'confirmed'
     group by 2
    union all
    select case from_wallet when 'refund' then 'refundedMicros' else 'allowanceReturnedMicros' end,
        to_char(confirmed_at at time zone 'UTC', 'YYYY-MM-DD'), count(*)::text,
        sum(amount_micros)::text
      from refunds
     where state = 'confirmed'
     group by 1, 2
    union all
    select 'x402SpentMicros', to_char(resolved_at at time zone 'UTC', 'YYYY-MM-DD'),
        count(*)::text, sum(amount_micros)::text
      from x402_payments
     where state = 'confirmed' and not late_landed
     group by 2`;

const BY_KIND_SQL = `
    select count(*) filter (where o.kind = 'start')::text as sandbox_n,
        coalesce(sum(o.amount_micros - o.allowance_micros - o.fee_micros)
            filter (where o.kind = 'start'), 0)::text as sandbox_m,
        count(*) filter (where o.kind = 'extend')::text as extend_n,
        coalesce(sum(o.amount_micros) filter (where o.kind = 'extend'), 0)::text as extend_m,
        count(*) filter (where o.allowance_micros > 0)::text as allowance_n,
        coalesce(sum(o.allowance_micros) filter (where o.allowance_micros > 0), 0)::text
            as allowance_m,
        count(*) filter (where o.fee_micros > 0)::text as fee_n,
        coalesce(sum(o.fee_micros) filter (where o.fee_micros > 0), 0)::text as fee_m
      from payments p join orders o on o.id = p.order_id
     where p.status = 'confirmed'`;

const BY_METHOD_SQL = `
    select o.paid_via as method, count(*)::text as n, sum(p.amount_micros)::text as micros
      from payments p join orders o on o.id = p.order_id
     where p.status = 'confirmed' and o.paid_via is not null
     group by 1
     order by 1`;

function safe(v: string | null, what: string): number {
    const n = BigInt(v ?? "0");
    if (n > MAX_SAFE || n < -MAX_SAFE) throw new Error(`stats ${what} is not a safe integer: ${n}`);
    return Number(n);
}

function zero(): StatsMoney {
    return { earnedMicros: 0, refundedMicros: 0, allowanceReturnedMicros: 0, x402SpentMicros: 0 };
}

function addTo(m: StatsMoney, key: MoneyKey, micros: number): void {
    const sum = m[key] + micros;
    if (!Number.isSafeInteger(sum)) throw new Error(`stats ${key} is not a safe integer: ${sum}`);
    m[key] = sum;
}

function utcDay(t: Date): string {
    return t.toISOString().slice(0, 10);
}

interface DailyRow extends pg.QueryResultRow {
    what: MoneyKey;
    day: string | null;
    n: string;
    micros: string | null;
}

interface KindRow extends pg.QueryResultRow {
    sandbox_n: string;
    sandbox_m: string;
    extend_n: string;
    extend_m: string;
    allowance_n: string;
    allowance_m: string;
    fee_n: string;
    fee_m: string;
}

interface MethodRow extends pg.QueryResultRow {
    method: string;
    n: string;
    micros: string | null;
}

/** Payments' money for the router's stats summary, from confirmed rows only (control-plane 20.7). */
export async function statsTotals(pool: pg.Pool, s: Settings, now: Date): Promise<StatsTotals> {
    const [daily, kinds, methods] = await withTx(pool, async (c) => {
        // One snapshot, so the totals, kinds and methods describe the same rows
        await c.query("set transaction isolation level repeatable read, read only");
        return [
            (await c.query<DailyRow>(DAILY_SQL)).rows,
            (await c.query<KindRow>(BY_KIND_SQL)).rows[0]!,
            (await c.query<MethodRow>(BY_METHOD_SQL)).rows,
        ] as const;
    });

    const today = utcDay(now);
    const totals = zero();
    const byDay = new Map<string, StatsMoney>();
    const refunds = { count: 0 };
    for (const r of daily) {
        const micros = safe(r.micros, r.what);
        addTo(totals, r.what, micros);
        if (r.what === "refundedMicros") refunds.count += safe(r.n, "refund count");
        // A day past today is clock skew, its money stays in the totals only
        if (r.day === null || r.day > today) continue;
        let m = byDay.get(r.day);
        if (m === undefined) byDay.set(r.day, (m = zero()));
        addTo(m, r.what, micros);
    }

    const days: StatsTotals["daily"] = [];
    const first = [...byDay.keys()].sort()[0];
    if (first !== undefined) {
        const end = Date.parse(`${today}T00:00:00Z`);
        for (let t = Date.parse(`${first}T00:00:00Z`); t <= end; t += DAY_MS) {
            const day = utcDay(new Date(t));
            days.push({ day, ...(byDay.get(day) ?? zero()) });
        }
    }

    return {
        version: 1,
        daily: days,
        totals,
        byKind: [
            {
                kind: "sandbox",
                count: safe(kinds.sandbox_n, "count"),
                micros: safe(kinds.sandbox_m, "sandbox"),
            },
            {
                kind: "extend",
                count: safe(kinds.extend_n, "count"),
                micros: safe(kinds.extend_m, "extend"),
            },
            {
                kind: "x402_allowance",
                count: safe(kinds.allowance_n, "count"),
                micros: safe(kinds.allowance_m, "x402_allowance"),
            },
            {
                kind: "x402_fee",
                count: safe(kinds.fee_n, "count"),
                micros: safe(kinds.fee_m, "x402_fee"),
            },
        ],
        refunds: { count: refunds.count, micros: totals.refundedMicros },
        byMethod: methods.map((m) => ({
            method: m.method,
            count: safe(m.n, "count"),
            micros: safe(m.micros, m.method),
        })),
        limits: {
            "order.max_micros": s.orders.max_amount_micros,
            "x402.max_allowance_micros": s.x402.max_allowance_per_sandbox_micros,
            "x402.max_price_per_call_micros": s.x402.max_price_per_call_micros,
        },
    };
}
