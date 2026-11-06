import pg from "pg";
import { jsonLog, type Log } from "../log.ts";

export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url: string, log: Log = jsonLog("payments")): pg.Pool {
    const pool = new pg.Pool({ connectionString: url });
    // An idle client erroring (server restart, dropped connection) would otherwise crash the process.
    pool.on("error", (err) => log.error("postgres idle client error", { err }));
    return pool;
}

export async function withTx<T>(
    pool: pg.Pool,
    fn: (c: pg.PoolClient) => Promise<T>,
    log: Log = jsonLog("payments"),
): Promise<T> {
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
