import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { until } from "../testing/app.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { RUNNER_KEYS, singleRunner } from "./single-runner.ts";

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

describe("singleRunner", () => {
    it("keys are the nine fixed values", () => {
        expect(RUNNER_KEYS).toEqual({
            mirror: 4020001,
            fastPass: 4020002,
            release: 4020003,
            closeCheck: 4020004,
            close: 4020005,
            hotRefunds: 4020006,
            cold: 4020007,
            outbox: 4020008,
            deposits: 4020009,
        });
    });

    it("a second process skips a single-runner job", async () => {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        const first = singleRunner(db.pool, RUNNER_KEYS.mirror, async () => {
            await held;
            return "ran";
        });
        await until(
            async () =>
                (
                    await db.pool.query(
                        "select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1 and granted",
                        [RUNNER_KEYS.mirror],
                    )
                ).rows[0].n === 1,
            2_000,
        );
        expect(await singleRunner(db.pool, RUNNER_KEYS.mirror, async () => "ran")).toBe("skipped");
        expect(await singleRunner(db.pool, RUNNER_KEYS.outbox, async () => "other key")).toBe(
            "other key",
        );
        release();
        expect(await first).toBe("ran");
        expect(await singleRunner(db.pool, RUNNER_KEYS.mirror, async () => "again")).toBe("again");
    });

    it("unlocks when the job throws", async () => {
        await expect(
            singleRunner(db.pool, RUNNER_KEYS.close, () => Promise.reject(new Error("boom"))),
        ).rejects.toThrow("boom");
        expect(await singleRunner(db.pool, RUNNER_KEYS.close, async () => 1)).toBe(1);
        expect(db.pool.idleCount).toBe(db.pool.totalCount);
    });
});
