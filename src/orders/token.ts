import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { isCanonicalAddress, isCanonicalSignature } from "../solana/base58.ts";
import type { OrderRow } from "./types.ts";

// Matches bugnet-router/internal/ordertoken, which decodes these claims strictly
export interface OrderClaims {
    order_id: string;
    kind: "start" | "extend";
    package_id: string;
    amount_micros: number;
    expires_at: string;
    handle_sha256?: string;
    allowance_micros?: number;
    fee_micros?: number;
    payer?: string;
    fee_payer?: string;
    tx?: string;
    issued_at?: string;
}

// Which claims the live router decodes; each turns on with its [router] setting
export interface ClaimSwitches {
    allowance: boolean;
    fee: boolean;
}

export interface PaymentProof {
    payer: string;
    feePayer: string;
    tx: string;
}

const pkcs8Ed25519Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
const spkiEd25519PrefixLength = 12;

export function orderKey(seed: Buffer): KeyObject {
    if (seed.length !== 32) throw new Error("order key seed must be 32 bytes");
    return createPrivateKey({
        key: Buffer.concat([pkcs8Ed25519Prefix, seed]),
        format: "der",
        type: "pkcs8",
    });
}

export function signOrderToken(key: KeyObject, claims: OrderClaims): string {
    const seg = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = sign(null, Buffer.from(`bugnet-order-v1.${seg}`), key);
    return `v1.${seg}.${sig.toString("base64url")}`;
}

// Claims come from the stored order, never from the request, so a replayed or tampered request cannot change what the token grants.
export function claimsFor(
    order: OrderRow,
    expiresAt: Date,
    on: ClaimSwitches,
    proof?: PaymentProof,
    issuedAt?: Date,
): OrderClaims {
    if (order.kind === "allowance") throw new Error("allowance orders carry no token");
    const claims: OrderClaims = {
        order_id: order.id,
        kind: order.kind,
        package_id: order.packageId,
        amount_micros: order.amountMicros,
        expires_at: expiresAt.toISOString(),
    };
    if (order.kind === "extend") {
        if (order.handleSha256 === null) throw new Error("extend order has no handle hash");
        claims.handle_sha256 = order.handleSha256;
    }
    if (order.kind === "start" && order.allowanceMicros > 0 && on.allowance) {
        claims.allowance_micros = order.allowanceMicros;
    }
    // The router leaves the x402 session fee out of the package share
    if (order.kind === "start" && order.feeMicros > 0 && on.fee) {
        claims.fee_micros = order.feeMicros;
    }
    if (proof !== undefined) {
        claims.payer = proof.payer;
        claims.fee_payer = proof.feePayer;
        claims.tx = proof.tx;
    }
    // The router measures its start target from it on start tokens only
    if (order.kind === "start" && issuedAt !== undefined) claims.issued_at = issuedAt.toISOString();
    return claims;
}

// All three or none: a partial set would give the router a half-checkable record
export function paymentProof(
    payer: string | undefined,
    feePayer: string | undefined,
    tx: string | undefined,
): PaymentProof | undefined {
    if (!isCanonicalAddress(payer) || !isCanonicalAddress(feePayer) || !isCanonicalSignature(tx)) {
        return undefined;
    }
    return { payer, feePayer, tx };
}

export function orderPublicKeyBase64(seed: Buffer): string {
    const spki = createPublicKey(orderKey(seed)).export({ format: "der", type: "spki" });
    return spki.subarray(spkiEd25519PrefixLength).toString("base64");
}
