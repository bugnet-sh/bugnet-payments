import { randomBytes } from "node:crypto";
import type pg from "pg";
import { migrate } from "../db/migrate.ts";
import { createPool } from "../db/pool.ts";

export interface TestDb {
    pool: pg.Pool;
    url: string;
    name: string;
    close(): Promise<void>;
}

const DEFAULT_ADMIN_URL = "postgres://localhost:5432/postgres?sslmode=disable";

export async function testDb(): Promise<TestDb> {
    const adminUrl = process.env.BUGNET_TEST_PG_URL || DEFAULT_ADMIN_URL;
    const name = `bn_pay_test_${randomBytes(8).toString("hex")}`;
    const admin = createPool(adminUrl);
    try {
        await admin.query(`create database ${name}`);
    } finally {
        await admin.end();
    }
    const u = new URL(adminUrl);
    u.pathname = `/${name}`;
    const url = u.toString();
    const pool = createPool(url);
    try {
        await migrate(pool);
    } catch (err) {
        await pool.end();
        await dropDatabase(adminUrl, name);
        throw err;
    }
    return {
        pool,
        url,
        name,
        async close() {
            await pool.end();
            await dropDatabase(adminUrl, name);
        },
    };
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
    const admin = createPool(adminUrl);
    try {
        await admin.query(`drop database if exists ${name} with (force)`);
    } finally {
        await admin.end();
    }
}
