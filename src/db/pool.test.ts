import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { memoryLog } from "../log.ts";
import { withTx } from "./pool.ts";

function fakePool(rollbackFails: boolean) {
    const release = vi.fn();
    const client = {
        query: vi.fn(async (sql: string) => {
            if (sql === "rollback" && rollbackFails) throw new Error("connection lost");
        }),
        release,
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    return { pool, release };
}

describe("withTx", () => {
    it("destroys the client when rollback fails and rethrows the original error", async () => {
        const { pool, release } = fakePool(true);
        const log = memoryLog();
        await expect(
            withTx(
                pool,
                async () => {
                    throw new Error("boom");
                },
                log,
            ),
        ).rejects.toThrow("boom");
        expect(release).toHaveBeenCalledWith(
            expect.objectContaining({ message: "connection lost" }),
        );
        expect(log.lines.some((l) => l.level === "warn")).toBe(true);
    });

    it("releases normally when rollback succeeds", async () => {
        const { pool, release } = fakePool(false);
        await expect(
            withTx(pool, async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        expect(release).toHaveBeenCalledWith(undefined);
    });
});
