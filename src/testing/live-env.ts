import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REQUIRED = [
    "BUGNET_FEE_PAYER_KEY",
    "BUGNET_REFUND_KEY",
    "BUGNET_RECIPIENT_KEY",
    "BUGNET_ORDER_PRIVATE_KEY",
    "BUGNET_CLAIM_KEY",
    "BUGNET_PAYMENTS_TOKEN",
] as const;

const X402_REQUIRED = ["BUGNET_ALLOWANCE_KEY", "BUGNET_SPIKE_SELLER_URL"] as const;

const RPC_LIST = "BUGNET_SOLANA_RPC_URLS";
const RPC_SINGLE = "BUGNET_SOLANA_RPC_URL";
const PAYER_KEY = "BUGNET_TEST_PAYER_KEY";
const PAYER_MNEMONIC = "BUGNET_TEST_PAYER_MNEMONIC";

function empty(env: NodeJS.ProcessEnv, name: string): boolean {
    return (env[name] ?? "").trim() === "";
}

export function missingLiveEnv(env: NodeJS.ProcessEnv): string[] {
    const missing: string[] = [];
    if (empty(env, RPC_LIST) && empty(env, RPC_SINGLE)) {
        missing.push(`${RPC_LIST} or ${RPC_SINGLE}`);
    }
    missing.push(...REQUIRED.filter((name) => empty(env, name)));
    if (empty(env, PAYER_KEY) && empty(env, PAYER_MNEMONIC)) {
        missing.push(`${PAYER_KEY} or ${PAYER_MNEMONIC}`);
    }
    return missing;
}

// Only the x402 live file needs these, so the v1 mainnet live test runs without them
export function missingX402Env(
    env: NodeJS.ProcessEnv,
    exists: (path: string) => boolean = existsSync,
): string[] {
    const missing: string[] = X402_REQUIRED.filter((name) => empty(env, name));
    const sellerFile =
        env.BUGNET_TESTSELLER_ENV ?? join(homedir(), ".config/bugnet/testseller.env");
    if (!exists(sellerFile)) missing.push(`${sellerFile} missing`);
    return missing;
}

// Only the deposit live file needs it; the other live files run with deposits off
export function missingDepositEnv(env: NodeJS.ProcessEnv): string[] {
    return empty(env, "BUGNET_DEPOSIT_SEED") ? ["BUGNET_DEPOSIT_SEED"] : [];
}
