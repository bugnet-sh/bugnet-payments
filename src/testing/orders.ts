import type pg from "pg";
import { randomBytes } from "node:crypto";
import { claimHash, newClaim } from "../orders/claim.ts";
import { newOrderId } from "../orders/ids.ts";
import type { OrderRow, PaymentRow } from "../orders/types.ts";
import { findOrder, findPaymentByOrder } from "../orders/store.ts";

const FIXED_CLAIM_SHA256 = Buffer.alloc(32, 7);

export function orderRow(over: Partial<OrderRow> = {}): OrderRow {
    const now = new Date();
    return {
        id: newOrderId(),
        kind: "start",
        packageId: "pkg-test",
        amountMicros: 10_000,
        handleSha256: null,
        description: "test order",
        claimSha256: FIXED_CLAIM_SHA256,
        claimBox: null,
        idempotencyKey: null,
        state: "unpaid",
        createdAt: now,
        expiresAt: new Date(now.getTime() + 15 * 60_000),
        paidAt: null,
        payer: null,
        redeemedAt: null,
        tokenExpiresAt: null,
        eventSeenAt: null,
        routerConfirmedAt: null,
        abandonReason: null,
        abandonAt: null,
        manualReason: null,
        payInto: "cold",
        allowanceMicros: 0,
        feeMicros: 0,
        x402Setup: null,
        x402Refusal: null,
        coldTransferId: null,
        hotRouterRefundMicros: 0,
        ...over,
    };
}

// Writes the row exactly as given, state included, bypassing the state machine.
export async function seedOrder(
    pool: pg.Pool,
    over: Partial<OrderRow> = {},
): Promise<{ order: OrderRow; claim: string }> {
    const claim = newClaim();
    const o = orderRow({ claimSha256: claimHash(claim)!, ...over });
    await pool.query(
        `insert into orders (id, kind, package_id, amount_micros, handle_sha256, description,
            claim_sha256, claim_box, idempotency_key, state, created_at, expires_at, paid_at, payer,
            redeemed_at, token_expires_at, event_seen_at, router_confirmed_at, abandon_reason,
            abandon_at, manual_reason, pay_into, allowance_micros, fee_micros, x402_setup,
            x402_refusal, cold_transfer_id, hot_router_refund_micros)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25::jsonb, $26, $27, $28)`,
        [
            o.id,
            o.kind,
            o.packageId,
            o.amountMicros,
            o.handleSha256,
            o.description,
            o.claimSha256,
            o.claimBox,
            o.idempotencyKey,
            o.state,
            o.createdAt,
            o.expiresAt,
            o.paidAt,
            o.payer,
            o.redeemedAt,
            o.tokenExpiresAt,
            o.eventSeenAt,
            o.routerConfirmedAt,
            o.abandonReason,
            o.abandonAt,
            o.manualReason,
            o.payInto,
            o.allowanceMicros,
            o.feeMicros,
            o.x402Setup === null ? null : JSON.stringify(o.x402Setup),
            o.x402Refusal,
            o.coldTransferId,
            o.hotRouterRefundMicros,
        ],
    );
    return { order: (await findOrder(pool, o.id))!, claim };
}

export async function seedAllowanceOrder(
    pool: pg.Pool,
    over: Partial<OrderRow> = {},
): Promise<{ order: OrderRow; claim: string }> {
    return seedOrder(pool, {
        kind: "allowance",
        packageId: "x402-allowance",
        handleSha256: "ab".repeat(32),
        allowanceMicros: 1_000_000,
        feeMicros: 3_000,
        amountMicros: 1_003_000,
        payInto: "allowance",
        x402Setup: { services: [], disable: [], spendPerMinuteMicros: null },
        ...over,
    });
}

export async function seedPayment(
    pool: pg.Pool,
    orderId: string,
    over: Partial<PaymentRow> = {},
): Promise<PaymentRow> {
    const order = (await findOrder(pool, orderId))!;
    const p: PaymentRow = {
        orderId,
        txSignature: randomBytes(32).toString("hex"),
        messageHash: randomBytes(32).toString("hex"),
        payer: "payer-test",
        sourceTokenAccount: "source-test",
        amountMicros: order.amountMicros,
        blockhash: "blockhash-test",
        lastValidBlockHeight: 1_000n,
        status: "settling",
        createdAt: new Date(),
        confirmedAt: null,
        landedSlot: null,
        payerCounted: true,
        multiSender: false,
        splitMinMicros: null,
        ...over,
    };
    await pool.query(
        `insert into payments (order_id, tx_signature, message_hash, payer, source_token_account,
            amount_micros, blockhash, last_valid_block_height, status, created_at, confirmed_at,
            landed_slot, payer_counted, multi_sender, split_min_micros)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
            p.orderId,
            p.txSignature,
            p.messageHash,
            p.payer,
            p.sourceTokenAccount,
            p.amountMicros,
            p.blockhash,
            p.lastValidBlockHeight.toString(),
            p.status,
            p.createdAt,
            p.confirmedAt,
            p.landedSlot === null ? null : p.landedSlot.toString(),
            p.payerCounted,
            p.multiSender,
            p.splitMinMicros,
        ],
    );
    return (await findPaymentByOrder(pool, orderId))!;
}

export interface TestShare {
    owner: string;
    sourceTokenAccount: string;
    appliedMicros: number;
}

// The default shares of a 50,000 order (spec 10.9's example)
export const TEST_SHARES: readonly TestShare[] = [
    { owner: "OwnA", sourceTokenAccount: "SrcA", appliedMicros: 30_000 },
    { owner: "OwnB", sourceTokenAccount: "SrcB", appliedMicros: 20_000 },
];

// A payment shared by several owners as settle writes it: share part 0 is the payments row's
// payer and source.
export async function seedSharedPayment(
    pool: pg.Pool,
    orderId: string,
    o: { shares?: readonly TestShare[]; splitMinMicros?: number; over?: Partial<PaymentRow> } = {},
): Promise<PaymentRow> {
    const shares = o.shares ?? TEST_SHARES;
    const payment = await seedPayment(pool, orderId, {
        status: "confirmed",
        payer: shares[0]!.owner,
        sourceTokenAccount: shares[0]!.sourceTokenAccount,
        multiSender: true,
        payerCounted: false,
        splitMinMicros: o.splitMinMicros ?? 1_000,
        ...o.over,
    });
    for (const [part, s] of shares.entries()) {
        await pool.query(
            `insert into payment_shares (order_id, part, owner, source_token_account,
                applied_micros)
             values ($1, $2, $3, $4, $5)`,
            [orderId, part, s.owner, s.sourceTokenAccount, s.appliedMicros],
        );
    }
    return payment;
}
