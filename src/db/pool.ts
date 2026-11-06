import pg from "pg";
import { jsonLog, type Log } from "../log.ts";

export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url: string, log: Log = jsonLog("payments")): pg.Pool {
    const pool = new pg.Pool({ connectionString: url });
    // An idle client erroring (server restart, dropped connection) would otherwise crash the process.
    pool.on("error", (err) => log.error("postgres idle client error", { err }));
    return pool;
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
    } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}
