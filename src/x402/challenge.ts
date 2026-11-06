import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { Log } from "../log.ts";
import type { OrderRow } from "../orders/types.ts";
import type { BlockhashCache } from "../solana/blockhash.ts";
import { SOLANA_MAINNET, USDC_MINT } from "../solana/constants.ts";

const MAX_TIMEOUT_SECONDS = 300;

export interface ChallengeContext {
    publicUrl: string;
    recipient: string;
    feePayer: string;
    transactionVersions: readonly (0 | 1)[];
}

export function payUrlFor(publicUrl: string, orderId: string): string {
    return `${publicUrl}/o/${orderId}`;
}

export function requirementsFor(
    order: Pick<OrderRow, "id" | "amountMicros">,
    ctx: ChallengeContext,
): PaymentRequirements {
    return {
        scheme: "exact",
        network: SOLANA_MAINNET,
        asset: USDC_MINT,
        amount: String(order.amountMicros),
        payTo: ctx.recipient,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: {
            feePayer: ctx.feePayer,
            memo: order.id,
            transactionVersions: [...ctx.transactionVersions],
        },
    };
}

export async function challengeFor(
    order: Pick<OrderRow, "id" | "amountMicros" | "description">,
    ctx: ChallengeContext,
    hints: BlockhashCache,
    log: Log,
): Promise<PaymentRequired> {
    const requirements = requirementsFor(order, ctx);
    try {
        const hint = await hints.latest();
        requirements.extra = {
            ...requirements.extra,
            recentBlockhash: hint.blockhash,
            lastValidBlockHeight: hint.lastValidBlockHeight.toString(),
        };
    } catch (err) {
        // The hints only save the payer an RPC call; the challenge is valid without them.
        log.warn("blockhash unavailable", { orderId: order.id, err: String(err) });
    }
    return {
        x402Version: 2,
        resource: {
            url: payUrlFor(ctx.publicUrl, order.id),
            description: order.description,
            mimeType: "application/json",
        },
        accepts: [requirements],
    };
}

export function paymentRequiredHeaders(pr: PaymentRequired): Record<string, string> {
    return {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr),
        "Cache-Control": "no-store",
    };
}
