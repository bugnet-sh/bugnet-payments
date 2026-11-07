import { createHash, randomBytes } from "node:crypto";
import type { BugnetAddresses, HttpMethod } from "./types.ts";

export const SERVICE_ID = /^xs_[a-z2-7]{16}$/;
export const PAYMENT_ID = /^xp_[a-z2-7]{26}$/;
export const REF = /^[a-z2-7]{16}$/;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Lower(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

export function serviceIdFor(method: HttpMethod, host: string, prefix: string): string {
    const digest = createHash("sha256").update(`${method}\0${host}\0${prefix}`).digest();
    return `xs_${base32Lower(digest).slice(0, 16)}`;
}

// 16 random bytes are 128 bits, which is 25.6 base32 characters, so 26 characters carry them all.
export function newX402PaymentId(): string {
    return `xp_${base32Lower(randomBytes(16))}`;
}

export function newPaymentIdentifier(): string {
    return `bn_${randomBytes(16).toString("hex")}`;
}

export function bugnetAddresses(o: {
    feePayer: string;
    allowanceWallet: string;
    refundWallet: string;
    recipient: string;
}): BugnetAddresses {
    const all = new Set([o.feePayer, o.allowanceWallet, o.refundWallet, o.recipient]);
    all.delete("");
    return { ...o, all };
}
