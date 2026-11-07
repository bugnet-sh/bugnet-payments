const REQUIRED = [
    "BUGNET_SOLANA_RPC_URL",
    "BUGNET_FEE_PAYER_KEY",
    "BUGNET_REFUND_KEY",
    "BUGNET_RECIPIENT_KEY",
    "BUGNET_ORDER_PRIVATE_KEY",
    "BUGNET_CLAIM_KEY",
    "BUGNET_PAYMENTS_TOKEN",
] as const;

const PAYER_KEY = "BUGNET_TEST_PAYER_KEY";
const PAYER_MNEMONIC = "BUGNET_TEST_PAYER_MNEMONIC";

function empty(env: NodeJS.ProcessEnv, name: string): boolean {
    return (env[name] ?? "").trim() === "";
}

export function missingLiveEnv(env: NodeJS.ProcessEnv): string[] {
    const missing: string[] = REQUIRED.filter((name) => empty(env, name));
    if (empty(env, PAYER_KEY) && empty(env, PAYER_MNEMONIC)) {
        missing.push(`${PAYER_KEY} or ${PAYER_MNEMONIC}`);
    }
    return missing;
}
