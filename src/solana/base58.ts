import { getBase58Decoder, getBase58Encoder } from "@solana/kit";

// The byte length and the canonical re-encoding decide, never the length of the string
export function isCanonicalBase58(s: unknown, bytes: 32 | 64): s is string {
    if (typeof s !== "string" || s === "") return false;
    try {
        const decoded = getBase58Encoder().encode(s);
        return decoded.length === bytes && getBase58Decoder().decode(decoded) === s;
    } catch {
        return false;
    }
}

export function isCanonicalAddress(s: unknown): s is string {
    return isCanonicalBase58(s, 32);
}

export function isCanonicalSignature(s: unknown): s is string {
    return isCanonicalBase58(s, 64);
}
