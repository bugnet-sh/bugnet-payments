/**
 * The router's Postgres stores (spec 10.1, 10.4, 11): monthly usage per position, the single
 * health snapshot the CLI reads, and the consistency verdicts kept by URL fingerprint. Rows hold
 * position names and fingerprints only, never a URL or host.
 */
import { createHmac, hkdfSync } from "node:crypto";
import type pg from "pg";
import type { Queryable } from "../db/pool.ts";
import type {
    HistoryProbe,
    RouterSnapshot,
    SnapshotStore,
    UsageStore,
    VerdictRow,
    VerdictStore,
} from "./router/index.ts";

const FINGERPRINT_INFO = "bugnet rpc endpoint fingerprint";

export function pgUsageStore(pool: pg.Pool): UsageStore {
    return {
        async load(month) {
            const res = await pool.query<{
                endpoint: string;
                requests: string;
                background: string;
            }>("select endpoint, requests, background from rpc_usage where month = $1", [month]);
            const counts: Record<string, { requests: number; background: number }> = {};
            for (const r of res.rows) {
                counts[r.endpoint] = {
                    requests: Number(r.requests),
                    background: Number(r.background),
                };
            }
            return counts;
        },
        async add(month, rows) {
            // One statement cannot update a row twice, so an endpoint listed twice is summed first
            const sums = new Map<string, { requests: number; background: number }>();
            for (const r of rows) {
                const s = sums.get(r.endpoint) ?? { requests: 0, background: 0 };
                sums.set(r.endpoint, {
                    requests: s.requests + r.requests,
                    background: s.background + r.background,
                });
            }
            if (sums.size === 0) return;
            const totals = [...sums.values()];
            await pool.query(
                `insert into rpc_usage (endpoint, month, requests, background)
                 select endpoint, $1, requests, background
                 from unnest($2::text[], $3::bigint[], $4::bigint[])
                     as t(endpoint, requests, background)
                 on conflict (endpoint, month) do update set
                     requests = rpc_usage.requests + excluded.requests,
                     background = rpc_usage.background + excluded.background`,
                [
                    month,
                    [...sums.keys()],
                    totals.map((t) => t.requests),
                    totals.map((t) => t.background),
                ],
            );
        },
    };
}

export function pgSnapshotStore(pool: pg.Pool, now: () => Date): SnapshotStore {
    return {
        async write(s) {
            await pool.query(
                `insert into rpc_health (id, snapshot, written_at) values (true, $1::jsonb, $2)
                 on conflict (id) do update set
                     snapshot = excluded.snapshot, written_at = excluded.written_at`,
                [JSON.stringify(s), now()],
            );
        },
    };
}

export async function readSnapshot(
    db: Queryable,
): Promise<{ snapshot: RouterSnapshot; writtenAt: Date } | null> {
    const res = await db.query<{ snapshot: RouterSnapshot; written_at: Date }>(
        "select snapshot, written_at from rpc_health where id",
    );
    const row = res.rows[0];
    return row === undefined ? null : { snapshot: row.snapshot, writtenAt: row.written_at };
}

// Only cold payments credit recipientAta; allowance payments go to the hot account. The address
// check needs later after oldest on chain, and confirmed_at can trail the landing by minutes when
// the reconciler confirms, so later is picked by created_at, which precedes its broadcast: oldest
// landed by its confirmed_at, and later after its created_at
export async function historyProbe(
    db: Queryable,
    recipientAta: string,
): Promise<HistoryProbe | null> {
    const res = await db.query<{ oldest: string; later: string | null }>(
        `with cold as (
             select p.order_id, p.tx_signature, p.created_at, p.confirmed_at from payments p
             join orders o on o.id = p.order_id
             where p.status = 'confirmed' and o.pay_into = 'cold' and p.confirmed_at is not null
         ), first as (
             select tx_signature, confirmed_at from cold order by confirmed_at, order_id limit 1
         )
         select f.tx_signature as oldest,
             (select c.tx_signature from cold c
              where c.created_at >= f.confirmed_at + interval '1 minute'
              order by c.created_at, c.order_id limit 1) as later
         from first f`,
    );
    const row = res.rows[0];
    return row === undefined
        ? null
        : { address: recipientAta, oldest: row.oldest, later: row.later };
}

// The service and every routed CLI command write these rows. A process clears a mark only from a
// run started history_check_every after it, so a clear that meets a younger stored mark comes from
// a process that read the rows before another one marked: that mark stays (spec 8.10), and of two
// marks the later one. $6 is now(), $7 history_check_every in ms.
const KEEP_STORED_MARK = `(rpc_verdicts.inconsistent_at is not null and case
    when excluded.inconsistent_at is null
        then rpc_verdicts.inconsistent_at
            > $6::timestamptz - $7::double precision * interval '1 millisecond'
    else rpc_verdicts.inconsistent_at > excluded.inconsistent_at end)`;

export function pgVerdictStore(pool: pg.Pool, now: () => Date, clearAfterMs: number): VerdictStore {
    return {
        async load() {
            const res = await pool.query<{
                fingerprint: string;
                endpoint: string;
                inconsistent_at: Date | null;
                inconsistent_reason: VerdictRow["reason"];
                history_passed: boolean;
            }>(
                `select fingerprint, endpoint, inconsistent_at, inconsistent_reason, history_passed
                 from rpc_verdicts`,
            );
            return res.rows.map((r) => ({
                fingerprint: r.fingerprint,
                endpoint: r.endpoint,
                noAt: r.inconsistent_at === null ? null : r.inconsistent_at.getTime(),
                reason: r.inconsistent_reason,
                historyPassed: r.history_passed,
            }));
        },
        async save(row) {
            await pool.query(
                `insert into rpc_verdicts (fingerprint, endpoint, inconsistent_at,
                     inconsistent_reason, history_passed, updated_at)
                 values ($1, $2, $3, $4, $5, $6)
                 on conflict (fingerprint) do update set
                     endpoint = excluded.endpoint,
                     inconsistent_at = case when ${KEEP_STORED_MARK}
                         then rpc_verdicts.inconsistent_at else excluded.inconsistent_at end,
                     inconsistent_reason = case when ${KEEP_STORED_MARK}
                         then rpc_verdicts.inconsistent_reason else excluded.inconsistent_reason end,
                     history_passed = rpc_verdicts.history_passed or excluded.history_passed,
                     updated_at = excluded.updated_at`,
                [
                    row.fingerprint,
                    row.endpoint,
                    row.noAt === null ? null : new Date(row.noAt),
                    row.reason,
                    row.historyPassed,
                    now(),
                    clearAfterMs,
                ],
            );
        },
    };
}

// Spec 8.10: an HMAC of the normalized URL, so a reordered list keeps each verdict with its URL
// and no URL, host or key is stored
export function endpointFingerprint(claimKey: Buffer): (url: string) => string {
    const key = Buffer.from(hkdfSync("sha256", claimKey, Buffer.alloc(0), FINGERPRINT_INFO, 32));
    return (url) => {
        // new URL's error carries its input, which may hold a key
        if (!URL.canParse(url)) throw new Error("rpc endpoint fingerprint: not a URL");
        return createHmac("sha256", key).update(new URL(url).href).digest("hex").slice(0, 32);
    };
}
