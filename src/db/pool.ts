import pg from "pg";

export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url: string): pg.Pool {
    return new pg.Pool({ connectionString: url });
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
