import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = import.meta.dirname;

function sources(): { name: string; text: string }[] {
    return readdirSync(DIR, { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));
}

function isAllowedImport(spec: string): boolean {
    return spec === "@solana/kit" || spec === "zod" || /^node:/.test(spec) || /^\.\//.test(spec);
}

function isTestHost(url: string): boolean {
    if (!URL.canParse(url)) return false;
    const host = new URL(url).hostname;
    return /\.example$/.test(host) || ["localhost", "127.0.0.1", "[::1]"].includes(host);
}

// The [solana.rpc] tables of the TOML, comments included: from their header to the next table
function rpcTables(toml: string): string {
    const lines: string[] = [];
    let inside = false;
    for (const line of toml.split("\n")) {
        const header = /^\s*\[\[?([^\]]+)\]\]?/.exec(line);
        if (header !== null) {
            const name = header[1]!.trim();
            inside = name === "solana.rpc" || name.startsWith("solana.rpc.");
        }
        if (inside) lines.push(line);
    }
    return lines.join("\n");
}

describe("router boundary", () => {
    it("router imports nothing outside its folder", () => {
        const files = sources();
        expect(files.map((f) => f.name)).toContain("settings.ts");
        const imports = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
        const outside = files.flatMap(({ name, text }) =>
            [...text.matchAll(imports)]
                .map((m) => m[1]!)
                .filter((spec) => !isAllowedImport(spec))
                .map((spec) => `${name}: ${spec}`),
        );
        expect(outside).toEqual([]);
    });

    it("the router holds no URL", () => {
        const found = sources().flatMap(({ name, text }) => {
            const urls = text.match(/https?:\/\/[^\s"'`)]*/g) ?? [];
            const bad = name === "testing.ts" ? urls.filter((u) => !isTestHost(u)) : urls;
            return bad.map((u) => `${name}: ${u}`);
        });
        expect(found).toEqual([]);
        const toml = readFileSync(join(DIR, "../../../config/example.toml"), "utf8");
        const tables = rpcTables(toml);
        expect(tables).toContain("[solana.rpc]");
        expect(tables).toContain("[solana.rpc.first_attempt_timeouts]");
        expect(tables).not.toMatch(/:\/\//);
    });
});
