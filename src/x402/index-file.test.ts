import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../config.ts";
import { loadIndex, parseIndex } from "./index-file.ts";

const P = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const OTHER = "1".repeat(32);
const ENTRY = {
    method: "POST",
    host: "agent402.tools",
    prefix: "/v1/auto/",
    url: "https://agent402.tools/v1/auto/chat/completions",
    payTo: P,
    category: "chat",
    keyNames: ["OPENAI_API_KEY"],
    reviewedAt: "2026-11-07",
};
const text = (o: unknown) => JSON.stringify(o);
const SRC = "/etc/bugnet/payments/x402-index.json";

describe("x402 index copy", () => {
    it("lists only an exact method, host, prefix and payTo match", () => {
        const idx = parseIndex(text({ v: 1, services: [ENTRY] }), SRC);
        expect(idx.size).toBe(1);
        const e = {
            method: "POST",
            host: "agent402.tools",
            prefix: "/v1/auto/",
            payTo: P,
        } as const;
        expect(idx.lists(e)).toBe(true);
        expect(idx.lists({ ...e, payTo: OTHER })).toBe(false);
        expect(idx.lists({ ...e, method: "GET" })).toBe(false);
        expect(idx.lists({ ...e, prefix: "/v1/" })).toBe(false);
        expect(idx.lists({ ...e, host: "other.example" })).toBe(false);
    });
    it("refuses v 2", () => {
        const bad = () => parseIndex(text({ v: 2, services: [] }), SRC);
        expect(bad).toThrow(ConfigError);
        expect(bad).toThrow(/x402-index.json: v must be 1/);
    });
    it("refuses services that is not an array", () => {
        expect(() => parseIndex(text({ v: 1, services: {} }), SRC)).toThrow(
            /x402-index.json: services must be an array/,
        );
    });
    it("refuses a payTo that does not decode to 32 bytes", () => {
        expect(() =>
            parseIndex(text({ v: 1, services: [{ ...ENTRY, payTo: "1" + P }] }), SRC),
        ).toThrow(/services\[0\]\.payTo/);
    });
    it("refuses a bad method and an empty host", () => {
        expect(() =>
            parseIndex(text({ v: 1, services: [ENTRY, { ...ENTRY, method: "PUT" }] }), SRC),
        ).toThrow(/services\[1\]\.method/);
        expect(() => parseIndex(text({ v: 1, services: [{ ...ENTRY, host: "" }] }), SRC)).toThrow(
            /services\[0\]\.host/,
        );
    });
    it("refuses text that is not JSON", () => {
        expect(() => parseIndex("{", SRC)).toThrow(/x402-index.json: not JSON/);
    });
    it("loadIndex reads a file and names a missing one", () => {
        const dir = mkdtempSync(join(tmpdir(), "bn-index-"));
        try {
            const path = join(dir, "index.json");
            writeFileSync(path, text({ v: 1, services: [ENTRY] }));
            expect(loadIndex(path).size).toBe(1);
            const missing = join(dir, "missing.json");
            expect(() => loadIndex(missing)).toThrow(ConfigError);
            expect(() => loadIndex(missing)).toThrow(/read .*missing.json/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
