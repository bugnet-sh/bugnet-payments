import { describe, expect, it } from "vitest";
import { memoryLog } from "../log.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { countingRpc } from "./budget.ts";

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
});
