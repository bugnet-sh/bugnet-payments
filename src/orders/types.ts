import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import type { PayRefusal } from "../x402/decode.ts";
import type {
    PayInto,
    PinReason,
    StoredX402Setup,
    X402AccountView,
    X402CreateRefusal,
    X402Refusal,
    X402Setup,
} from "../x402/types.ts";

export type OrderKind = "start" | "extend" | "allowance";

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
    payInto: PayInto;
    allowanceMicros: number;
    feeMicros: number;
    x402Setup: StoredX402Setup | null;
    x402Refusal: X402Refusal | null;
    coldTransferId: number | null;
    hotRouterRefundMicros: number;
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
    | "payInto"
    | "allowanceMicros"
    | "feeMicros"
    | "x402Setup"
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
    landedSlot: bigint | null;
}

// createdAt comes from the injected clock, never from Postgres now(), so one clock decides every time rule.
export type NewPayment = Omit<PaymentRow, "status" | "confirmedAt" | "landedSlot"> & {
    keySha256?: Buffer | null;
};

// How the paying request reached us, from its Bugnet-Client header
export type PaidVia = "checkout" | "pay_cli" | "transfer";

export type OrderUpdate = Partial<
    Pick<
        OrderRow,
        | "paidAt"
        | "payer"
        | "redeemedAt"
        | "tokenExpiresAt"
        | "manualReason"
        | "routerConfirmedAt"
        | "x402Refusal"
        | "coldTransferId"
        | "hotRouterRefundMicros"
        | "eventSeenAt"
    > & { paidVia: PaidVia }
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
    allowanceMicros?: number;
    feeMicros?: number;
    x402?: X402Setup;
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
    | "paid_claim_required"
    | X402CreateRefusal;

export type OrderResult =
    | {
          status: "payment_required";
          orderId: string;
          claim?: string;
          // Lets a caller that holds only the order id tell an x402 allowance from sandbox time
          kind: OrderKind;
          allowanceMicros: number;
          payUrl: string;
          paymentRequired: PaymentRequired;
      }
    | {
          status: "paid";
          orderId: string;
          orderToken: string;
          payer: string;
          kind: "start" | "extend";
          packageId: string;
          amountMicros: number;
          handleSha256?: string;
          allowanceMicros?: number;
          firstUse?: boolean;
          x402?: X402AccountView;
          paymentResponse?: SettleResponse;
      }
    | {
          status: "paid";
          orderId: string;
          kind: "allowance";
          handleSha256: string;
          payer: string;
          amountMicros: number;
          allowanceMicros: number;
          firstUse: boolean;
          x402: X402AccountView;
          paymentResponse?: SettleResponse;
      }
    | {
          status: "refused";
          orderId?: string;
          reason: RefusalReason;
          retryAfterSeconds?: number;
          refundPending?: boolean;
          charged?: false;
          serviceId?: string;
          pinReason?: PinReason;
      };
