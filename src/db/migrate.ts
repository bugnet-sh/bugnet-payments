import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { withTx } from "./pool.ts";

const MIGRATION_LOCK = 724_001;

export async function migrate(pool: pg.Pool, dir = "migrations"): Promise<number> {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    return withTx(pool, async (c) => {
        await c.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
        await c.query(
            `create table if not exists schema_migrations (
                version text primary key,
                applied_at timestamptz not null default now()
            )`,
        );
        const done = await c.query<{ version: string }>("select version from schema_migrations");
        const applied = new Set(done.rows.map((r) => r.version));
        let count = 0;
        for (const file of files) {
            if (applied.has(file)) continue;
            await c.query(await readFile(path.join(dir, file), "utf8"));
            await c.query("insert into schema_migrations (version) values ($1)", [file]);
            count++;
        }
        return count;
    });
}
