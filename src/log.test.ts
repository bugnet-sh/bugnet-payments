import { describe, expect, it } from "vitest";
import { jsonLog, memoryLog, REDACTED_KEYS, silentLog } from "./log.ts";

function capture(opts: { secrets?: readonly string[] } = {}) {
    const out: string[] = [];
    const log = jsonLog("payments", { ...opts, write: (l) => out.push(l) });
    return { out, log };
}

describe("jsonLog", () => {
    it("redacts secret-bearing keys at any depth", () => {
        const { out, log } = capture();
        log.info("x", {
            claim: "c",
            mnemonic: "w1 w2",
            nested: { payment: { a: 1 }, orderToken: "v1.x" },
            list: [{ token: "t", ok: 1 }],
            orderId: "ord_a",
        });
        const line = JSON.parse(out[0]!);
        expect(line.claim).toBe("[redacted]");
        expect(line.mnemonic).toBe("[redacted]");
        expect(line.nested.payment).toBe("[redacted]");
        expect(line.nested.orderToken).toBe("[redacted]");
        expect(line.list[0].token).toBe("[redacted]");
        expect(line.list[0].ok).toBe(1);
        expect(line.orderId).toBe("ord_a");
    });

    it("scrubs configured secret strings from messages and errors", () => {
        const rpc = "https://mainnet.helius-rpc.com/?api-key=K";
        const { out, log } = capture({ secrets: [rpc] });
        log.error(`fetch ${rpc} failed`, { err: new Error(`POST ${rpc}: 429`) });
        expect(out[0]).not.toContain("api-key=K");
        const line = JSON.parse(out[0]!);
        expect(line.msg).toBe("fetch [redacted] failed");
        expect(line.err).toEqual({ name: "Error", message: "POST [redacted]: 429" });
    });

    it("writes the gateway line shape", () => {
        const { out, log } = capture();
        log.warn("hello", { a: 1 });
        const line = JSON.parse(out[0]!);
        expect(line).toMatchObject({ level: "warn", service: "payments", msg: "hello", a: 1 });
        expect(Number.isNaN(Date.parse(line.t))).toBe(false);
    });

    it("writes alarms with level alarm", () => {
        const { out, log } = capture();
        log.alarm("fee_payer_sol_low", { lamports: "1" });
        expect(JSON.parse(out[0]!)).toMatchObject({
            level: "alarm",
            alarm: "fee_payer_sol_low",
            lamports: "1",
        });
    });

    it("serializes bigint", () => {
        const { out, log } = capture();
        log.info("x", { lvbh: 5n });
        expect(JSON.parse(out[0]!).lvbh).toBe("5");
    });

    it("survives circular fields", () => {
        const { out, log } = capture();
        const a: Record<string, unknown> = {};
        a.self = a;
        log.info("x", { a });
        expect(JSON.parse(out[0]!).a.self).toBe("[circular]");
    });
});

describe("test loggers", () => {
    it("memoryLog collects redacted lines", () => {
        const log = memoryLog();
        log.info("m", { claim: "c" });
        log.alarm("manual_queue");
        expect(log.lines[0]).toMatchObject({ level: "info", msg: "m", claim: "[redacted]" });
        expect(log.lines[1]).toMatchObject({ level: "alarm", alarm: "manual_queue" });
    });

    it("silentLog discards", () => {
        expect(() => silentLog.alarm("refunds_paused")).not.toThrow();
    });

    it("REDACTED_KEYS lists the secret keys", () => {
        expect(REDACTED_KEYS.has("mnemonic")).toBe(true);
        expect(REDACTED_KEYS.has("orderId")).toBe(false);
    });
});
