export type DepositState = "open" | "settling" | "draining" | "closed" | "done";
// deposits.hold_reason: a hold that stops every owner of the deposit
export type DepositHoldReason = "allowance_paused" | "router_unavailable";
// deposit_holds: anonymous_busy only for owner '', the owner set of a shared payment
export type OwnerHoldReason = "payer_busy" | "payer_rate_limited" | "anonymous_busy";
export type HoldReason = DepositHoldReason | OwnerHoldReason;
export type ReviewReason =
    "unknown_debit" | "double_sweep" | "moves_failing" | "move_expired_repeatedly";
export type TransferOutcome = "open" | "paid" | "return" | "keep" | "review";
export type TransferReason =
    | "extra"
    | "unpaid"
    | "late"
    | "after_paid"
    | "paid_otherwise"
    | "payer_blocked"
    | "payer_busy"
    | "payer_rate_limited"
    | "pool_busy"
    | "router_unavailable"
    | "allowance_unavailable"
    | "below_minimum"
    | "operator"
    | "unattributed"
    | "unreadable"
    | "from_bugnet"
    | "late_limit"
    | "return_destination_invalid"
    | "return_failed";
export type MoveKind = "create" | "sweep" | "return" | "close";
export type MoveState = "pending" | "signed" | "sent" | "confirmed" | "failed" | "manual";

export interface DepositRow {
    orderId: string;
    address: string;
    tokenAccount: string;
    keyVersion: number;
    salt: Buffer;
    state: DepositState;
    balanceMicros: bigint;
    lastSignature: string | null;
    scanSlot: bigint | null;
    scanTop: string | null;
    scanBefore: string | null;
    rentPayer: string | null;
    viewerKey: string | null;
    viewerBlock: string | null;
    reviewReason: ReviewReason | null;
    holdReason: DepositHoldReason | null;
    movesFailingResetAt: Date | null;
    recheckAt: Date | null;
    expiryDueAt: Date | null;
    hardStopAt: Date | null;
    expiryMinSlot: bigint | null;
    closeSeparately: boolean;
    closeFailures: number;
    closeAfter: Date | null;
    stableSince: Date | null;
    lateReturns: number;
    createdAt: Date;
    readyAt: Date | null;
    checkedAt: Date | null;
    checkedSlot: bigint | null;
    settledAt: Date | null;
    closedAt: Date | null;
    watchUntil: Date | null;
}

export interface TransferRow {
    orderId: string;
    signature: string;
    slot: bigint;
    seq: number;
    blockTime: Date;
    seenAt: Date;
    amountMicros: number;
    sourceTokenAccount: string | null;
    sourceOwner: string | null;
    sourceBalanceMicros: bigint | null;
    outcome: TransferOutcome;
    appliedMicros: number;
    reason: TransferReason | null;
    blockedUntil: Date | null;
    moveId: number | null;
    refundId: number | null;
}

export interface MoveRow {
    id: number;
    orderId: string;
    kind: MoveKind;
    amountMicros: number;
    keepMicros: number;
    heldMicros: number;
    destination: string | null;
    payer: string | null;
    memo: string | null;
    closes: boolean;
    closeTo: string | null;
    state: MoveState;
    txSignature: string | null;
    wireTx: string | null;
    lastValidBlockHeight: bigint | null;
    previousSignatures: string[];
    attempts: number;
    landedSlot: bigint | null;
    expirySeenSlot: bigint | null;
    preflightRefusedAt: Date | null;
    manualReason: string | null;
    createdAt: Date;
    signedAt: Date | null;
    sentAt: Date | null;
    confirmedAt: Date | null;
    failedAt: Date | null;
}

export interface ShareRow {
    orderId: string;
    part: number;
    owner: string;
    sourceTokenAccount: string;
    appliedMicros: number;
}

export interface HoldRow {
    orderId: string;
    // '' is the owner set of a shared payment
    owner: string;
    reason: OwnerHoldReason;
    recheckAt: Date;
    since: Date;
}

export type NewMove = Pick<
    MoveRow,
    | "orderId"
    | "kind"
    | "amountMicros"
    | "keepMicros"
    | "heldMicros"
    | "destination"
    | "payer"
    | "memo"
    | "closes"
    | "closeTo"
>;
export type NewTransfer = Omit<
    TransferRow,
    "outcome" | "appliedMicros" | "reason" | "blockedUntil" | "moveId" | "refundId"
>;

export type DepositStatus =
    | "waiting"
    | "partial"
    | "confirming"
    | "held"
    | "checking"
    | "paid"
    | "expired"
    | "refunding"
    | "refunded"
    | "review";

export interface DepositView {
    address: string;
    ready: boolean;
    status: DepositStatus;
    receivedMicros: number;
    otherMicros: number;
    remainingMicros: number;
    extraMicros: number;
    returningMicros: number;
    returnedMicros: number;
    keptMicros: number;
    reviewMicros: number;
    reason: TransferReason | null;
    reasonMicros: number;
    blockedUntil: string | null;
    hold: { reason: HoldReason; until: string } | null;
    transfers: Array<{
        signature: string;
        amountMicros: number;
        at: string;
        outcome: "counted" | "returning" | "returned" | "kept" | "review";
        reason: TransferReason | null;
        returnSignature: string | null;
    }>;
}
