import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ORDER_ID = /^ord_[a-z2-7]{26}$/;

// 16 random bytes are 128 bits, which is 25.6 base32 characters, so 26 characters carry them all.
export function newOrderId(): string {
    const bytes = randomBytes(16);
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
    return `ord_${out}`;
}

export function isOrderId(v: unknown): v is string {
    return typeof v === "string" && ORDER_ID.test(v);
}
