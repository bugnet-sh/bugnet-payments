import type { Address } from "@solana/kit";
import { inspectTokenAccount, usdcAta } from "./solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "./solana/constants.ts";
import type { SolanaRpc } from "./solana/rpc.ts";

export class BootCheckError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BootCheckError";
    }
}

export interface BootDeps {
    rpc: SolanaRpc;
    recipient: Address;
    feePayer: Address;
    refundWallet: Address;
    feePayerMinLamports: bigint;
    refundsEnabled: boolean;
    eventPublicKey: string;
}

async function requireUsdcAccount(
    rpc: SolanaRpc,
    label: string,
    owner: Address,
    fix: string,
): Promise<Address> {
    const ata = await usdcAta(owner);
    const info = await inspectTokenAccount(rpc, ata);
    if (info === null) {
        throw new BootCheckError(`${label} USDC account ${ata} does not exist: ${fix}`);
    }
    if (info.programOwner !== TOKEN_PROGRAM) {
        throw new BootCheckError(
            `${label} USDC account ${ata} is owned by program ${info.programOwner}, not the Token program ${TOKEN_PROGRAM}`,
        );
    }
    if (info.mint !== USDC_MINT) {
        throw new BootCheckError(
            `${label} USDC account ${ata} has mint ${info.mint}, expected USDC ${USDC_MINT}`,
        );
    }
    if (info.owner !== owner) {
        throw new BootCheckError(
            `${label} USDC account ${ata} is owned by ${info.owner}, expected ${owner}`,
        );
    }
    if (info.state === "frozen") {
        throw new BootCheckError(
            `${label} USDC account ${ata} is frozen: use a different ${label} wallet`,
        );
    }
    if (info.state !== "initialized") {
        throw new BootCheckError(`${label} USDC account ${ata} is not initialized: ${fix}`);
    }
    return ata;
}

export async function bootChecks(
    d: BootDeps,
): Promise<{ recipientAta: Address; feePayerLamports: bigint }> {
    if (d.refundsEnabled && d.eventPublicKey === "") {
        throw new BootCheckError(
            'router.event_public_key: set it to the output of bugnet-dev pubkey --priv "$BUGNET_EVENT_SIGNING_KEY"',
        );
    }
    if (d.recipient === d.feePayer || d.recipient === d.refundWallet) {
        throw new BootCheckError(
            `recipient must be a cold address: ${d.recipient} is also the fee payer or the refund wallet; set BUGNET_RECIPIENT_KEY to a different wallet`,
        );
    }

    const recipientAta = await requireUsdcAccount(
        d.rpc,
        "recipient",
        d.recipient,
        "create it once with: pnpm cli keys fund --create-recipient-ata",
    );

    const { value: feePayerLamports } = await d.rpc.getBalance(d.feePayer).send();
    if (feePayerLamports < d.feePayerMinLamports) {
        throw new BootCheckError(
            `fee payer holds ${feePayerLamports} lamports, needs at least ${d.feePayerMinLamports}: send SOL to ${d.feePayer}`,
        );
    }

    if (d.refundsEnabled) {
        await requireUsdcAccount(
            d.rpc,
            "refund",
            d.refundWallet,
            "create it once with: pnpm cli keys fund --create-refund-ata, or set refunds.enabled = false",
        );
    }
    return { recipientAta, feePayerLamports: BigInt(feePayerLamports) };
}
