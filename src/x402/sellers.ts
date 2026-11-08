import type { Queryable } from "../db/pool.ts";
import type { X402SellerStats } from "./types.ts";

const MAX_HOSTS = 20;
const MAX_HOST_LENGTH = 253;

export function parseHosts(query: string | null): string[] | null {
    if (query === null) return null;
    const hosts = [
        ...new Set(
            query
                .split(",")
                .map((h) => h.trim().toLowerCase())
                .filter((h) => h !== ""),
        ),
    ];
    if (hosts.length === 0 || hosts.length > MAX_HOSTS) return null;
    if (hosts.some((h) => h.length > MAX_HOST_LENGTH)) return null;
    return hosts;
}

export async function sellerStats(
    db: Queryable,
    hosts: readonly string[],
    now: Date,
): Promise<Record<string, X402SellerStats>> {
    const res = await db.query<{ host: string; paid: string; failed: string }>(
        `select host,
            count(*) filter (where state = 'confirmed' and not late_landed) as paid,
            count(*) filter (where (state = 'confirmed' and not ended_clean)
                or state in ('failed_onchain', 'expired_unlanded')) as failed
         from x402_payments
         where host = any($1) and created_at > $2::timestamptz - interval '30 days'
         group by host`,
        [hosts, now],
    );
    const out: Record<string, X402SellerStats> = {};
    for (const h of hosts) out[h] = { paidCalls30d: 0, failedPaid30d: 0 };
    for (const r of res.rows) {
        out[r.host] = { paidCalls30d: Number(r.paid), failedPaid30d: Number(r.failed) };
    }
    return out;
}
