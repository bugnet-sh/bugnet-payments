import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import type { PayRefusal } from "../x402/decode.ts";

export type OrderKind = "start" | "extend";

export type OrderState =
    "unpaid" | "settling" | "paid" | "redeemed" | "refunding" | "refunded" | "expired" | "manual";

export const ALLOWED_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
    unpaid: ["settling", "expired"],
    settling: ["paid", "unpaid", "expired"],
    paid: ["redeemed", "refunding", "manual"],
    redeemed: ["refunding", "manual"],
    refunding: ["refunded", "manual"],
    manual: ["refunding", "refunded", "redeemed"],
    refunded: [],
    expired: [],
};

export interface OrderRow {
    id: string;
    kind: OrderKind;
    packageId: string;
    amountMicros: number;
    handleSha256: string | null;
    description: string;
    claimSha256: Buffer;
    claimBox: Buffer | null;
    idempotencyKey: string | null;
    state: OrderState;
    createdAt: Date;
    expiresAt: Date;
    paidAt: Date | null;
    payer: string | null;
    redeemedAt: Date | null;
    tokenExpiresAt: Date | null;
    eventSeenAt: Date | null;
    routerConfirmedAt: Date | null;
    abandonReason: string | null;
    abandonAt: Date | null;
    manualReason: string | null;
}

export type NewOrder = Pick<
    OrderRow,
    | "id"
    | "kind"
    | "packageId"
    | "amountMicros"
    | "handleSha256"
    | "description"
    | "claimSha256"
    | "claimBox"
    | "idempotencyKey"
    | "expiresAt"
>;

export interface PaymentRow {
    orderId: string;
    txSignature: string;
    messageHash: string;
    payer: string;
    sourceTokenAccount: string;
    amountMicros: number;
    blockhash: string;
    lastValidBlockHeight: bigint;
    status: "settling" | "confirmed";
    createdAt: Date;
    confirmedAt: Date | null;
}

// createdAt comes from the injected clock, never from Postgres now(), so one clock decides every time rule.
export type NewPayment = Omit<PaymentRow, "status" | "confirmedAt"> & {
    keySha256?: Buffer | null;
};

export type OrderUpdate = Partial<
    Pick<
        OrderRow,
        "paidAt" | "payer" | "redeemedAt" | "tokenExpiresAt" | "manualReason" | "routerConfirmedAt"
    >
>;

// The four terms are required unless both orderId and claim are present
export interface OrderRequest {
    kind?: OrderKind;
    packageId?: string;
    amountMicros?: number;
    description?: string;
    handleSha256?: string;
    orderId?: string;
    claim?: string;
    payment?: unknown;
    idempotencyKey?: string;
}

export type RefusalReason =
    | PayRefusal
    | "bad_request"
    | "unauthorized"
    | "claim_mismatch"
    | "terms_mismatch"
    | "idempotency_conflict"
    | "settling"
    | "payment_late"
    | "token_expired"
    | "paid_claim_required";

export type OrderResult =
    | {
          status: "payment_required";
          orderId: string;
          claim?: string;
          payUrl: string;
          paymentRequired: PaymentRequired;
      }
    | {
          status: "paid";
          orderId: string;
          orderToken: string;
          payer: string;
          kind: OrderKind;
          packageId: string;
          amountMicros: number;
          handleSha256?: string;
          paymentResponse?: SettleResponse;
      }
    | { status: "refused"; orderId?: string; reason: RefusalReason; retryAfterSeconds?: number };
