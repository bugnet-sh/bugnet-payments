import type pg from "pg";
import { describe, expect, it, vi, type Mock } from "vitest";
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

// connect() hands out a new client each time; each client records its queries and its release
function freshClients() {
    const clients: { query: Mock; release: Mock }[] = [];
    const pool = {
        connect: async () => {
            const c = { query: vi.fn(async () => undefined), release: vi.fn() };
            clients.push(c);
            return c;
        },
    } as unknown as pg.Pool;
    return { pool, clients };
}
const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
const sqlOf = (c: { query: Mock }) => c.query.mock.calls.map((a) => a[0]);

describe("withTx deadlock re-run", () => {
    it("re-runs once on a deadlock", async () => {
        const { pool, clients } = freshClients();
        let calls = 0;
        const log = memoryLog();
        const result = await withTx(
            pool,
            async () => {
                calls++;
                if (calls === 1) throw deadlock();
                return 7;
            },
            log,
        );
        expect(log.lines).toMatchObject([
            { level: "warn", msg: "deadlock, re-running the transaction once" },
        ]);
        expect(result).toBe(7);
        expect(calls).toBe(2);
        expect(clients).toHaveLength(2);
        expect(sqlOf(clients[0]!)).toEqual(["begin", "rollback"]);
        expect(clients[0]!.release).toHaveBeenCalledWith(undefined);
        expect(sqlOf(clients[1]!)).toEqual(["begin", "commit"]);
    });

    it("throws a second deadlock", async () => {
        const { pool } = freshClients();
        let calls = 0;
        await expect(
            withTx(
                pool,
                async () => {
                    calls++;
                    throw deadlock();
                },
                memoryLog(),
            ),
        ).rejects.toMatchObject({ code: "40P01" });
        expect(calls).toBe(2);
    });

    it("never re-runs other errors", async () => {
        const { pool } = freshClients();
        let calls = 0;
        const unique = Object.assign(new Error("duplicate key"), { code: "23505" });
        await expect(
            withTx(pool, async () => {
                calls++;
                throw unique;
            }),
        ).rejects.toBe(unique);
        expect(calls).toBe(1);
    });

    it("retryDeadlock false never re-runs", async () => {
        const { pool } = freshClients();
        let calls = 0;
        await expect(
            withTx(
                pool,
                async () => {
                    calls++;
                    throw deadlock();
                },
                undefined,
                { retryDeadlock: false },
            ),
        ).rejects.toMatchObject({ code: "40P01" });
        expect(calls).toBe(1);
    });
});
