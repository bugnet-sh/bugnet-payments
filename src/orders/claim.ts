import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    timingSafeEqual,
} from "node:crypto";

const CLAIM_CHARS = /^[A-Za-z0-9_-]{43}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function newClaim(): string {
    return randomBytes(32).toString("base64url");
}

export function claimHash(claim: string): Buffer | null {
    if (!CLAIM_CHARS.test(claim)) return null;
    const bytes = Buffer.from(claim, "base64url");
    if (bytes.length !== 32) return null;
    return createHash("sha256").update(bytes).digest();
}

export function claimMatches(claim: string, stored: Buffer): boolean {
    const hash = claimHash(claim);
    if (hash === null || hash.length !== stored.length) return false;
    return timingSafeEqual(hash, stored);
}

export function sealClaim(key: Buffer, orderId: string, claim: string): Buffer {
    const bytes = Buffer.from(claim, "base64url");
    if (!CLAIM_CHARS.test(claim) || bytes.length !== 32) throw new Error("invalid claim");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(orderId));
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

export function openClaim(key: Buffer, orderId: string, box: Buffer): string {
    if (box.length < IV_BYTES + TAG_BYTES) throw new Error("sealed claim too short");
    const decipher = createDecipheriv("aes-256-gcm", key, box.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(orderId));
    decipher.setAuthTag(box.subarray(box.length - TAG_BYTES));
    const body = box.subarray(IV_BYTES, box.length - TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("base64url");
}
