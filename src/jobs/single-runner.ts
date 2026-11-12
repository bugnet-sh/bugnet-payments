import type pg from "pg";

export const RUNNER_KEYS = {
    mirror: 4020001,
    fastPass: 4020002,
    release: 4020003,
    closeCheck: 4020004,
    close: 4020005,
    hotRefunds: 4020006,
    cold: 4020007,
    outbox: 4020008,
    deposits: 4020009,
} as const;

// A session-level advisory lock on a dedicated client: another process running the same job
// skips, and a dropped session frees the lock with it.
export async function singleRunner<T>(
    pool: pg.Pool,
    key: number,
    fn: () => Promise<T>,
): Promise<T | "skipped"> {
    const c = await pool.connect();
    let broken: Error | undefined;
    try {
        let got: pg.QueryResult<{ ok: boolean }>;
        try {
            got = await c.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [key]);
        } catch (err) {
            broken = err instanceof Error ? err : new Error(String(err));
            throw err;
        }
        if (!got.rows[0]?.ok) return "skipped";
        try {
            return await fn();
        } finally {
            try {
                await c.query("select pg_advisory_unlock($1)", [key]);
            } catch (err) {
                // Destroying the session drops the lock the unlock could not
                broken = err instanceof Error ? err : new Error(String(err));
            }
        }
    } finally {
        c.release(broken);
    }
}
