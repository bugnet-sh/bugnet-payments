/**
 * Per-IP keys (spec 5): an IPv4 address is its own key, an IPv6 address is keyed by its /64, and
 * the /48 holding that /64 is its block, the way the gateway groups IPv6 (`addressKey` in
 * bugnet-gateway's ratelimit.ts). One host with a /64 is one key.
 */
import { createHmac } from "node:crypto";
import { isIPv6 } from "node:net";

export interface IpKey {
    key: string;
    block: string | null;
}

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const VIEWER_DOMAIN = "bugnet/viewer/v1/";

function hextets(address: string): string[] | null {
    let a = address.split("%")[0]!;
    const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
    if (v4) {
        const [b1, b2, b3, b4] = v4.slice(1).map(Number) as [number, number, number, number];
        a = `${a.slice(0, v4.index)}${((b1 << 8) | b2).toString(16)}:${((b3 << 8) | b4).toString(16)}`;
    }
    const halves = a.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
    const all = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
    return all.length === 8 ? all : null;
}

function prefixKey(parts: readonly string[], count: number): string {
    const head = parts.slice(0, count).map((h) => Number.parseInt(h, 16).toString(16));
    return `${head.join(":")}::/${count * 16}`;
}

export function ipKey(ip: string): IpKey {
    const mapped = MAPPED_V4.exec(ip)?.[1];
    if (mapped !== undefined) return { key: mapped, block: null };
    const parts = isIPv6(ip) ? hextets(ip) : null;
    if (parts === null) return { key: ip, block: null };
    return { key: prefixKey(parts, 4), block: prefixKey(parts, 3) };
}

// Stored on the deposit instead of the address, so the database holds no viewer's IP
export function viewerHash(seed: Buffer, key: string): string {
    return createHmac("sha256", seed)
        .update(VIEWER_DOMAIN + key)
        .digest("hex");
}
