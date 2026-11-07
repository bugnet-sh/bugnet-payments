import { readFileSync } from "node:fs";
import { ConfigError } from "../config.ts";
import { isCanonicalAddress } from "../solana/base58.ts";
import type { HttpMethod } from "./types.ts";

export interface IndexEntry {
    method: HttpMethod;
    host: string;
    prefix: string;
    url: string;
    payTo: string;
}

export interface IndexCopy {
    readonly size: number;
    lists(e: { method: HttpMethod; host: string; prefix: string; payTo: string }): boolean;
}

const key = (method: string, host: string, prefix: string, payTo: string) =>
    `${method}\0${host}\0${prefix}\0${payTo}`;

function nonEmpty(v: unknown): v is string {
    return typeof v === "string" && v !== "";
}

export function parseIndex(text: string, source: string): IndexCopy {
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch {
        throw new ConfigError(`${source}: not JSON`);
    }
    const root = (typeof doc === "object" && doc !== null ? doc : {}) as Record<string, unknown>;
    if (root.v !== 1) throw new ConfigError(`${source}: v must be 1`);
    if (!Array.isArray(root.services)) {
        throw new ConfigError(`${source}: services must be an array`);
    }
    const listed = new Set<string>();
    root.services.forEach((raw: unknown, i: number) => {
        const e = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
        const bad = (field: string, what: string) =>
            new ConfigError(`${source}: services[${i}].${field} must be ${what}`);
        if (e.method !== "GET" && e.method !== "POST") throw bad("method", "GET or POST");
        for (const field of ["host", "prefix", "url"]) {
            if (!nonEmpty(e[field])) throw bad(field, "a non-empty string");
        }
        if (typeof e.payTo !== "string" || !isCanonicalAddress(e.payTo)) {
            throw bad("payTo", "a canonical Solana address");
        }
        listed.add(key(e.method, e.host as string, e.prefix as string, e.payTo));
    });
    return {
        size: root.services.length,
        lists: (e) => listed.has(key(e.method, e.host, e.prefix, e.payTo)),
    };
}

export function loadIndex(path: string): IndexCopy {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (e) {
        throw new ConfigError(`read ${path}: ${(e as Error).message}`);
    }
    return parseIndex(text, path);
}
