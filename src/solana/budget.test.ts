import { describe, expect, it } from "vitest";
import { memoryLog } from "../log.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { countingRpc } from "./budget.ts";
import type { SolanaRpc } from "./rpc.ts";

describe("countingRpc", () => {
    it("fires once past the hourly limit and resets as the hour slides", async () => {
        let t = 0;
        const log = memoryLog();
        const rpc = countingRpc(createFakeRpc(), { limitPerHour: 3, log, now: () => t });
        const alarms = () => log.lines.filter((l) => l.alarm === "x402_rpc_budget").length;
        for (let i = 0; i < 4; i++) await rpc.getBlockHeight().send();
        expect(alarms()).toBe(1);
        await rpc.getBlockHeight().send();
        expect(alarms()).toBe(1);
        t = 3_600_001;
        for (let i = 0; i < 3; i++) await rpc.getBlockHeight().send();
        expect(alarms()).toBe(1);
        await rpc.getBlockHeight().send();
        expect(alarms()).toBe(2);
    });

    it("counts sends, not built requests, and passes answers through", async () => {
        const log = memoryLog();
        const rpc = countingRpc(createFakeRpc(), { limitPerHour: 0, log, now: () => 0 });
        rpc.getBlockHeight();
        expect(log.lines).toHaveLength(0);
        expect(await rpc.getBlockHeight().send()).toBe(1000n);
        expect(log.lines.filter((l) => l.alarm === "x402_rpc_budget")).toHaveLength(1);
    });

    it("logs the alarm fields", async () => {
        const log = memoryLog();
        const rpc = countingRpc(createFakeRpc(), { limitPerHour: 1, log, now: () => 0 });
        await rpc.getBlockHeight().send();
        await rpc.getBlockHeight().send();
        const line = log.lines.find((l) => l.alarm === "x402_rpc_budget");
        expect(line).toMatchObject({ calls: 2, limitPerHour: 1 });
    });

    it("keeps a send at exactly one hour in the window and drops it after", async () => {
        let t = 0;
        const log = memoryLog();
        const rpc = countingRpc(createFakeRpc(), { limitPerHour: 1, log, now: () => t });
        const alarms = () => log.lines.filter((l) => l.alarm === "x402_rpc_budget").length;
        await rpc.getBlockHeight().send();
        t = 3_600_000;
        await rpc.getBlockHeight().send();
        expect(alarms()).toBe(1);
        t = 7_200_001;
        await rpc.getBlockHeight().send();
        expect(alarms()).toBe(1);
        await rpc.getBlockHeight().send();
        expect(alarms()).toBe(2);
    });

    it("counts a send that fails", async () => {
        const log = memoryLog();
        const base = {
            boom: () => ({ send: () => Promise.reject(new Error("down")) }),
        } as unknown as SolanaRpc;
        const rpc = countingRpc(base, { limitPerHour: 0, log, now: () => 0 });
        await expect(
            (rpc as unknown as { boom: () => { send: () => Promise<unknown> } }).boom().send(),
        ).rejects.toThrow("down");
        expect(log.lines.filter((l) => l.alarm === "x402_rpc_budget")).toHaveLength(1);
    });

    it("counts reactiveStore calls", () => {
        const log = memoryLog();
        const base = {
            watch: () => ({ send: () => Promise.resolve(1), reactiveStore: () => "store" }),
        } as unknown as SolanaRpc;
        const rpc = countingRpc(base, { limitPerHour: 0, log, now: () => 0 });
        const pending = (
            rpc as unknown as { watch: () => { reactiveStore: () => string } }
        ).watch();
        expect(log.lines).toHaveLength(0);
        expect(pending.reactiveStore()).toBe("store");
        expect(log.lines.filter((l) => l.alarm === "x402_rpc_budget")).toHaveLength(1);
    });

    it("leaves Object.prototype members working", () => {
        const rpc = countingRpc(createFakeRpc(), {
            limitPerHour: 5,
            log: memoryLog(),
            now: () => 0,
        });
        expect(typeof String(rpc)).toBe("string");
        expect(typeof `${rpc}`).toBe("string");
        const has = (rpc as unknown as Record<string, (k: string) => unknown>)["hasOwnProperty"]!;
        expect(has.call(rpc, "nope")).toBe(false);
    });
});
