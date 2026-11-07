import type { Settings } from "../config.ts";
import type { Queryable } from "../db/pool.ts";
import { SOLANA_MAINNET, USDC_MINT } from "../solana/constants.ts";
import { readControls } from "./controls.ts";
import type { BugnetAddresses, SignerHealth, X402Terms } from "./types.ts";

export async function x402Terms(
    db: Queryable,
    d: {
        x402: Settings["x402"];
        allowanceClaim: boolean;
        signer: SignerHealth;
        addresses: BugnetAddresses;
    },
): Promise<X402Terms> {
    const controls = await readControls(db);
    const x = d.x402;
    return {
        enabled: x.enabled && !controls.disabled && !controls.paused && d.signer.open(),
        startWithX402: d.allowanceClaim,
        network: SOLANA_MAINNET,
        asset: USDC_MINT,
        sessionFeeMicros: x.session_fee_micros,
        minAllowanceMicros: x.min_allowance_micros,
        suggestedAllowanceMicros: x.suggested_allowance_micros,
        maxAllowancePerSandboxMicros: x.max_allowance_per_sandbox_micros,
        maxPricePerCallMicros: x.max_price_per_call_micros,
        defaultSpendPerMinuteMicros: x.default_spend_per_minute_micros,
        minSpendPerMinuteMicros: x.min_spend_per_minute_micros,
        maxSpendPerMinuteMicros: x.max_spend_per_minute_micros,
        maxServices: x.max_services,
        maxNewServicesPerOrder: x.max_new_services_per_order,
        sellerMemoMaxBytes: x.seller_memo_max_bytes,
        refundMinMicros: x.refund_min_micros,
        bugnetAddresses: [
            d.addresses.feePayer,
            d.addresses.allowanceWallet,
            d.addresses.refundWallet,
            d.addresses.recipient,
        ],
    };
}
