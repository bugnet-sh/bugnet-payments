/**
 * A seller and its own facilitator in process, no HTTP: it hands out the PAYMENT-REQUIRED value a
 * real seller would send and settles a PAYMENT-SIGNATURE with its own fee payer, so a live test
 * can prove that a payload signed by Payments is a payment a facilitator accepts and lands.
 */
import { type Address, type KeyPairSigner } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { SOLANA_MAINNET, USDC_MINT } from "../../src/solana/constants.ts";
import { createRpc } from "../../src/solana/rpc.ts";

export interface TestSeller {
    paymentRequired(): string;
    settle(paymentSignature: string): Promise<{ success: boolean; transaction: string }>;
    close(): Promise<void>;
}

export const TEST_SELLER = {
    host: "testseller.bugnet-live.invalid",
    prefix: "/ok/",
    url: "https://testseller.bugnet-live.invalid/ok/x",
} as const;

export async function startTestSeller(o: {
    feePayer: KeyPairSigner;
    payTo: Address;
    rpcUrl: string;
    memo?: string;
    priceMicros: number;
}): Promise<TestSeller> {
    const requirements: PaymentRequirements = {
        scheme: "exact",
        network: SOLANA_MAINNET,
        asset: USDC_MINT,
        amount: String(o.priceMicros),
        payTo: o.payTo,
        maxTimeoutSeconds: 60,
        extra: { feePayer: o.feePayer.address, ...(o.memo === undefined ? {} : { memo: o.memo }) },
    };
    const signer = toFacilitatorSvmSigner(o.feePayer, { [SOLANA_MAINNET]: createRpc(o.rpcUrl) });
    const scheme = new ExactSvmScheme(signer, undefined, {
        maxComputeUnits: 50_000,
        maxPriorityFeeMicroLamports: 10_000,
        maxRequiredSignatures: 2,
        transactionVersions: [0],
        enableSmartWalletVerification: false,
    });
    const facilitator = new x402Facilitator().register(SOLANA_MAINNET, scheme);
    return {
        paymentRequired: () =>
            Buffer.from(
                JSON.stringify({
                    x402Version: 2,
                    resource: { url: TEST_SELLER.url },
                    accepts: [requirements],
                }),
            ).toString("base64"),
        async settle(paymentSignature) {
            const payload = decodePaymentSignatureHeader(paymentSignature);
            const verdict = await facilitator.verify(payload, requirements);
            if (!verdict.isValid) {
                throw new Error(`test seller refused the payload: ${verdict.invalidReason}`);
            }
            const settled = await facilitator.settle(payload, requirements);
            return { success: settled.success, transaction: settled.transaction };
        },
        close: () => Promise.resolve(),
    };
}
