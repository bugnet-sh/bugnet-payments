import { isRecord } from "../is-record.ts";

export const LIST_KINDS = [
    "sandbox",
    "extend",
    "x402_allowance",
    "refund",
    "allowance_return",
] as const;
export type ListKind = (typeof LIST_KINDS)[number];

// The last item of a page, in the list's order (at desc, kind, id desc)
export interface Cursor {
    at: number;
    kind: ListKind;
    id: string;
}

export const MAX_CURSOR_LENGTH = 200;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ID = /^[A-Za-z0-9_]{1,64}$/;

export function encodeCursor(c: Cursor): string {
    return Buffer.from(JSON.stringify({ at: c.at, kind: c.kind, id: c.id })).toString("base64url");
}

export function decodeCursor(s: string): Cursor | null {
    if (s.length > MAX_CURSOR_LENGTH || !BASE64URL.test(s)) return null;
    const bytes = Buffer.from(s, "base64url");
    // Buffer ignores stray trailing bits, so only the canonical spelling of a cursor is one
    if (bytes.toString("base64url") !== s) return null;
    let v: unknown;
    try {
        v = JSON.parse(bytes.toString("utf8"));
    } catch {
        return null;
    }
    if (!isRecord(v)) return null;
    const { at, kind, id } = v;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return null;
    if (typeof kind !== "string" || !(LIST_KINDS as readonly string[]).includes(kind)) return null;
    if (typeof id !== "string" || !ID.test(id)) return null;
    return { at, kind: kind as ListKind, id };
}
