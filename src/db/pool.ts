import pg from "pg";
import { secretValues } from "../config.ts";
import { jsonLog, type Log } from "../log.ts";

export type Queryable = pg.Pool | pg.PoolClient;

function defaultLog(): Log {
    return jsonLog("payments", { secrets: secretValues(process.env) });
}

export function createPool(url: string, log: Log = defaultLog(), max?: number): pg.Pool {
    const pool = new pg.Pool({ connectionString: url, ...(max === undefined ? {} : { max }) });
    // An idle client erroring (server restart, dropped connection) would otherwise crash the process.
    pool.on("error", (err) => log.error("postgres idle client error", { err }));
    return pool;
}

async function once<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>, log: Log): Promise<T> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
    } catch (err) {
        try {
            await client.query("rollback");
        } catch (rollbackErr) {
            // A connection that cannot roll back is in an unknown state and must not be reused
            broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
            log.warn("rollback failed, destroying client", { err: rollbackErr });
        }
        throw err;
    } finally {
        client.release(broken);
    }
}

// No fn broadcasts or sends anything outside Postgres before COMMIT, so a re-run repeats only
// database work and reads.
export async function withTx<T>(
    pool: pg.Pool,
    fn: (c: pg.PoolClient) => Promise<T>,
    log: Log = defaultLog(),
    opts: { retryDeadlock?: boolean } = {},
): Promise<T> {
    try {
        return await once(pool, fn, log);
    } catch (err) {
        if ((err as { code?: unknown } | null)?.code !== "40P01" || opts.retryDeadlock === false)
            throw err;
        log.warn("deadlock, re-running the transaction once");
        return once(pool, fn, log);
    }
}
