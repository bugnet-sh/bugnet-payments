import {
    getBase64EncodedWireTransaction,
    type KeyPairSigner,
    partiallySignTransaction,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { type BuildOptions, buildPaymentTransaction } from "../x402/build.ts";

export async function signedPayment(
    req: PaymentRequirements,
    payer: KeyPairSigner,
    opts: BuildOptions & { x402Version?: number; accepted?: PaymentRequirements } = {},
): Promise<PaymentPayload> {
    const tx = await buildPaymentTransaction(req, payer.address, opts);
    const signed = await partiallySignTransaction([payer.keyPair], tx);
    return {
        x402Version: opts.x402Version ?? 2,
        accepted: opts.accepted ?? req,
        payload: { transaction: getBase64EncodedWireTransaction(signed) },
    };
}
