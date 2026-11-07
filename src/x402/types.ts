export type Listed = "indexed" | "unlisted";
export type HttpMethod = "GET" | "POST";
export interface X402Probe {
    at: string;
    status: number;
    accepted: unknown | null;
}
export interface X402ServicePin {
    serviceId: string;
    method: HttpMethod;
    host: string;
    prefix: string;
    url: string;
    maxPriceMicros: number;
    payTo: string;
    listed: Listed;
    pinnedFrom: "probe" | "index";
    probe: X402Probe;
}
export interface X402Setup {
    services?: X402ServicePin[];
    disable?: string[];
    spendPerMinuteMicros?: number;
}
// orders.x402_setup: Payments' own listed and paidPath; newPin marks a new or re-pinned service
export interface StoredPin {
    serviceId: string;
    method: HttpMethod;
    host: string;
    prefix: string;
    url: string;
    maxPriceMicros: number;
    payTo: string;
    listed: Listed;
    paidPath: string | null;
    pinnedFrom: "probe" | "index";
    probe: X402Probe;
    newPin: boolean;
}
export interface StoredX402Setup {
    services: StoredPin[];
    disable: string[];
    spendPerMinuteMicros: number | null;
}
export type PayInto = "cold" | "allowance";
export type X402Refusal =
    "allowance_ceiling" | "allowance_pool_full" | "sandbox_ended" | "order_expired";
export type SellerCheckCode =
    | "network_unsupported"
    | "flow_unsupported"
    | "price_above_max"
    | "payee_refused"
    | "fee_payer_refused"
    | "splits_unsupported"
    | "ata_creation_unsupported";
export type PinReason =
    "service_id_mismatch" | "no_402" | "index_mismatch" | "payee_no_usdc_account" | SellerCheckCode;
export type SignerRefusal =
    | SellerCheckCode
    | "x402_disabled"
    | "outflow_paused"
    | "account_closed"
    | "service_not_enabled"
    | "path_not_paid"
    | "payee_unreliable"
    | "payments_unavailable"
    | "ref_conflict"
    | "not_x402"
    | "version_unsupported"
    | "payee_changed"
    | "payto_blocked"
    | "allowance_spent"
    | "rate_cap"
    | "too_many_open_payments"
    | "payto_daily_cap"
    | "outflow_cap";
export type X402CreateRefusal =
    | "x402_disabled"
    | "x402_paused"
    | "x402_unavailable"
    | "x402_start_unavailable"
    | "sandbox_unknown"
    | "sandbox_ended"
    | "sandbox_not_capable"
    | "router_unavailable"
    | "amount_too_small"
    | "fee_mismatch"
    | "too_many_services"
    | "price_above_ceiling"
    | "pin_refused"
    | "spend_rate_out_of_range"
    | "description_too_long"
    | "allowance_ceiling"
    | "allowance_pool_full";
export type ConfigureRefusal =
    | "needs_payment"
    | "no_account"
    | "sandbox_ended"
    | "price_above_ceiling"
    | "too_many_services"
    | "spend_rate_out_of_range"
    | "router_unavailable"
    | "idempotency_conflict"
    | "bad_request";
export type AccountState = "open" | "closing" | "closed";
export interface AccountRow {
    id: string;
    handleSha256: string | null;
    placementId: string | null;
    packageId: string;
    state: AccountState;
    fundedMicros: number;
    spentMicros: number;
    heldMicros: number;
    refundedMicros: number;
    keptMicros: number;
    keptColdTransferId: number | null;
    spendPerMinuteMicros: number;
    minuteStart: Date;
    minuteMicros: number;
    deadline: Date | null;
    closeCheckFailingSince: Date | null;
    createdAt: Date;
    closingAt: Date | null;
    closedAt: Date | null;
}
export interface FundingRow {
    orderId: string;
    accountId: string;
    allowanceMicros: number;
    feeCreditedMicros: number;
    payer: string;
    sourceTokenAccount: string;
    createdAt: Date;
    voidedAt: Date | null;
}
export type ServiceState = "enabled" | "disabled" | "unreliable";
export interface ServiceRow {
    accountId: string;
    serviceId: string;
    method: HttpMethod;
    host: string;
    prefix: string;
    url: string;
    maxPriceMicros: number;
    payTo: string;
    listed: Listed;
    paidPath: string | null;
    pinnedFrom: "probe" | "index";
    probe: X402Probe;
    orderId: string;
    state: ServiceState;
    failures: number;
    updatedAt: Date;
}
export type X402PaymentState =
    "reserved" | "signed" | "confirmed" | "expired_unlanded" | "failed_onchain" | "released";
export type SellerHintText = "success" | "failure" | "absent" | "rejected";
export interface X402PaymentRow {
    id: string;
    ref: string;
    accountId: string;
    serviceId: string;
    placementId: string;
    method: string;
    host: string;
    path: string;
    targetSha256: Buffer;
    bodySha256: Buffer;
    amountMicros: number;
    payTo: string;
    payToTokenAccount: string;
    feePayer: string;
    listed: Listed;
    capDay: string;
    state: X402PaymentState;
    blockhash: string | null;
    lastValidBlockHeight: bigint | null;
    signingSlot: bigint | null;
    memo: Buffer | null;
    computeUnitLimit: number | null;
    computeUnitPriceMicroLamports: bigint | null;
    acceptedJson: string | null;
    messageHash: string | null;
    ourSignatureSha256: Buffer | null;
    paymentIdentifier: string | null;
    keepUntil: Date | null;
    landedSlot: bigint | null;
    expirySeenSlot: bigint | null;
    txSignature: string | null;
    lateLanded: boolean;
    hint: SellerHintText | null;
    hintTx: string | null;
    hintError: string | null;
    httpStatus: number | null;
    streamCut: boolean;
    endedClean: boolean;
    createdAt: Date;
    signedAt: Date | null;
    resolvedAt: Date | null;
}
export interface X402ServiceView {
    serviceId: string;
    method: HttpMethod;
    host: string;
    prefix: string;
    url: string;
    paidPath: string | null;
    maxPriceMicros: number;
    payTo: string;
    listed: Listed;
    state: ServiceState;
}
export interface X402RefundView {
    state: "waiting" | "pending" | "sent" | "confirmed" | "manual" | "kept";
    amountMicros: number;
    keptMicros: number;
    txs: string[];
}
export interface X402AccountView {
    state: AccountState;
    fundedMicros: number;
    spentMicros: number;
    heldMicros: number;
    leftMicros: number;
    allowanceRoomMicros: number;
    paidCalls: number;
    pendingCalls: number;
    spendPerMinuteMicros: number;
    services: X402ServiceView[];
    refund?: X402RefundView;
}
export interface X402Terms {
    enabled: boolean;
    startWithX402: boolean;
    network: string;
    asset: string;
    sessionFeeMicros: number;
    minAllowanceMicros: number;
    suggestedAllowanceMicros: number;
    maxAllowancePerSandboxMicros: number;
    maxPricePerCallMicros: number;
    defaultSpendPerMinuteMicros: number;
    minSpendPerMinuteMicros: number;
    maxSpendPerMinuteMicros: number;
    maxServices: number;
    maxNewServicesPerOrder: number;
    sellerMemoMaxBytes: number;
    refundMinMicros: number;
    bugnetAddresses: string[];
}
export interface X402SellerStats {
    paidCalls30d: number;
    failedPaid30d: number;
}
export interface SignerHealth {
    open(): boolean;
    onDown?(cb: () => void): void;
}
export interface BugnetAddresses {
    feePayer: string;
    allowanceWallet: string;
    refundWallet: string;
    recipient: string;
    all: ReadonlySet<string>;
}
export type IncidentKind =
    | "balance_mismatch"
    | "mirror_gap"
    | "balance_short"
    | "unknown_change"
    | "token_account_changed"
    | "late_landing"
    | "double_transfer";
