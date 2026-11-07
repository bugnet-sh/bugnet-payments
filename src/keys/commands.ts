/**
 * The `keys` commands of the operator CLI: generate secrets, fund the service wallets from the test
 * payer, show addresses and balances, drain the wallets back, and print the order public key.
 *
 * Only `generate` reads an env file; every other command reads the process environment. None parses
 * the TOML settings: `fund --create-recipient-ata` takes the recipient address itself, so it never
 * reads a config that names another wallet. The test payer pays every fee and every ATA rent, so no
 * other wallet needs SOL for these commands.
 */
import {
    type Address,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    isAddress,
    type KeyPairSigner,
} from "@solana/kit";
import { secretValues } from "../config.ts";
import { jsonLog, type Log } from "../log.ts";
import { orderPublicKeyBase64 } from "../orders/token.ts";
import { inspectTokenAccount, usdcAta } from "../solana/accounts.ts";
import { type Landing, readLanding } from "../solana/landing.ts";
import { loadKeypair } from "../solana/keys.ts";
import { createRpc, type SolanaRpc } from "../solana/rpc.ts";
import { signV0Transaction } from "../solana/transfer.ts";
import { loadTestPayer } from "./test-payer.ts";
import {
    drainPlan,
    fundingPlan,
    generateSecrets,
    parseEnvText,
    type PlannedTx,
    walletAddresses,
} from "./tool.ts";
import { existsSync, readFileSync } from "node:fs";

interface Io {
    out: (s: string) => void;
    err: (s: string) => void;
}

interface Flags {
    values: Map<string, string>;
    switches: Set<string>;
}

const COMPUTE_UNIT_LIMIT = 20_000;
const COMPUTE_UNIT_PRICE = 10_000n;
// One signature plus the priority fee of 20_000 units at 10_000 micro-lamports
const FEE_ESTIMATE_PER_TX = 5_000n + 200n;
const CONFIRM_POLL_MS = 500;
const POLL_CALL_TIMEOUT_MS = 10_000;
const MAX_POLL_FAILURES = 5;
const POLL_BACKOFF_MS = 250;

const COMMANDS: Record<string, { values: string[]; switches: string[] }> = {
    generate: { values: ["--env"], switches: [] },
    fund: {
        values: ["--fee-payer-lamports", "--refund-usdc-micros", "--create-recipient-ata"],
        switches: ["--create-refund-ata"],
    },
    show: { values: [], switches: ["--no-balances"] },
    drain: { values: [], switches: ["--close-atas"] },
    pubkey: { values: [], switches: [] },
};

export const KEYS_USAGE = [
    "  keys generate [--env FILE]               fill empty secrets in FILE (default .env)",
    "  keys fund [--fee-payer-lamports N] [--refund-usdc-micros M]",
    "            [--create-recipient-ata RECIPIENT_ADDRESS] [--create-refund-ata]",
    "                                           send from the test payer, create the USDC accounts",
    "  keys show [--no-balances]                addresses, SOL and USDC balances",
    "  keys drain [--close-atas]                move everything back to the test payer",
    "  keys pubkey                              the order public key for the router",
].join("\n");

function parseFlags(action: string, words: readonly string[]): Flags | string {
    const spec = COMMANDS[action];
    if (spec === undefined) return `unknown keys command ${JSON.stringify(action)}`;
    const flags: Flags = { values: new Map(), switches: new Set() };
    for (let i = 0; i < words.length; i++) {
        const word = words[i]!;
        if (spec.switches.includes(word)) {
            flags.switches.add(word);
        } else if (spec.values.includes(word)) {
            const value = words[++i];
            if (value === undefined) return `${word} needs a value`;
            flags.values.set(word, value);
        } else {
            return `${JSON.stringify(word)} is not an option of keys ${action}`;
        }
    }
    return flags;
}

function whole(flags: Flags, name: string): bigint | string {
    const text = flags.values.get(name) ?? "0";
    return /^[0-9]{1,18}$/.test(text) ? BigInt(text) : `${name} needs a whole number`;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = (env[name] ?? "").trim();
    if (value === "") throw new Error(`${name} is empty`);
    return value;
}

async function testPayerOf(env: NodeJS.ProcessEnv): Promise<KeyPairSigner> {
    const payer = await loadTestPayer(env);
    if (payer === null) {
        throw new Error("set BUGNET_TEST_PAYER_KEY or BUGNET_TEST_PAYER_MNEMONIC");
    }
    return payer;
}

export function isKeysCommand(group: string | undefined): boolean {
    return group === "keys";
}

export async function runKeys(
    action: string | undefined,
    words: readonly string[],
    env: NodeJS.ProcessEnv,
    io: Io,
): Promise<number> {
    const flags = parseFlags(action ?? "", words);
    if (typeof flags === "string") {
        io.err(flags);
        io.err(KEYS_USAGE);
        return 2;
    }
    const envFile = flags.values.get("--env") ?? ".env";
    const source =
        action === "generate" && existsSync(envFile)
            ? parseEnvText(readFileSync(envFile, "utf8"))
            : env;
    const log = jsonLog("payments-keys", { secrets: secretValues(source), write: io.err });
    try {
        switch (action) {
            case "generate":
                return await generate(envFile, io);
            case "pubkey":
                return pubkey(env, io);
            case "show":
                return await show(env, flags, io);
            case "fund":
                return await fund(env, flags, io, log);
            default:
                return await drain(env, flags, io, log);
        }
    } catch (err) {
        log.error(`keys ${action} failed`, { err });
        return 1;
    }
}

async function generate(envFile: string, io: Io): Promise<number> {
    const { added, addresses } = await generateSecrets(envFile);
    io.out(added.length === 0 ? "added=none" : `added=${added.join(",")}`);
    for (const [name, addr] of Object.entries(addresses)) io.out(`${name}=${addr}`);
    return 0;
}

function pubkey(env: NodeJS.ProcessEnv, io: Io): number {
    const name = "BUGNET_ORDER_PRIVATE_KEY";
    const seed = Buffer.from(required(env, name), "base64");
    if (seed.length !== 32) throw new Error(`${name}: expected 32 bytes of base64`);
    io.out(orderPublicKeyBase64(seed));
    return 0;
}

async function show(env: NodeJS.ProcessEnv, flags: Flags, io: Io): Promise<number> {
    const wallets: { name: string; signer: KeyPairSigner }[] = [];
    const testPayer = await loadTestPayer(env);
    if (testPayer !== null) wallets.push({ name: "test_payer", signer: testPayer });
    wallets.push(...(await walletAddresses(env)));
    const rpc = flags.switches.has("--no-balances")
        ? null
        : createRpc(required(env, "BUGNET_SOLANA_RPC_URL"));
    for (const { name, signer } of wallets) {
        if (rpc === null) {
            io.out(`${name}=${signer.address}`);
            continue;
        }
        const sol = await lamportsOf(rpc, signer.address);
        const usdc = await usdcOf(rpc, signer.address);
        io.out(`${name}=${signer.address} sol=${sol} usdc=${usdc}`);
    }
    return 0;
}

async function lamportsOf(rpc: SolanaRpc, owner: Address): Promise<bigint> {
    return (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
}

async function usdcOf(rpc: SolanaRpc, owner: Address): Promise<bigint> {
    return (await inspectTokenAccount(rpc, await usdcAta(owner)))?.amount ?? 0n;
}

async function fund(env: NodeJS.ProcessEnv, flags: Flags, io: Io, log: Log): Promise<number> {
    const lamports = whole(flags, "--fee-payer-lamports");
    const micros = whole(flags, "--refund-usdc-micros");
    if (typeof lamports === "string" || typeof micros === "string") {
        io.err(`${typeof lamports === "string" ? lamports : micros}`);
        return 2;
    }
    const recipient = flags.values.get("--create-recipient-ata") ?? "";
    const createRecipientAta = recipient !== "";
    if (flags.values.has("--create-recipient-ata") && !isAddress(recipient)) {
        io.err("--create-recipient-ata needs the recipient's base58 address");
        return 2;
    }
    const testPayer = await testPayerOf(env);
    const feePayer = await loadKeypair(
        required(env, "BUGNET_FEE_PAYER_KEY"),
        "BUGNET_FEE_PAYER_KEY",
    );
    const refund = await loadKeypair(required(env, "BUGNET_REFUND_KEY"), "BUGNET_REFUND_KEY");
    const rpc = createRpc(required(env, "BUGNET_SOLANA_RPC_URL"));

    const rentExemptMin = await rpc.getMinimumBalanceForRentExemption(0n).send();
    const ataRent = await rpc.getMinimumBalanceForRentExemption(165n).send();
    const plan = await fundingPlan({
        testPayer,
        feePayer: feePayer.address,
        refundWallet: refund.address,
        recipient: (recipient || testPayer.address) as Address,
        feePayerLamports: lamports,
        feePayerBalance: await lamportsOf(rpc, feePayer.address),
        rentExemptMin,
        refundUsdcMicros: micros,
        createRecipientAta,
    });

    const owners = createRecipientAta ? [refund.address, recipient as Address] : [refund.address];
    let missing = 0n;
    for (const owner of owners) {
        if ((await inspectTokenAccount(rpc, await usdcAta(owner))) === null) missing++;
    }
    const need =
        lamports + missing * ataRent + FEE_ESTIMATE_PER_TX * BigInt(plan.length) + rentExemptMin;
    const have = await lamportsOf(rpc, testPayer.address);
    if (have < need) {
        throw new Error(
            `test payer ${testPayer.address} holds ${have} lamports, needs ${need} ` +
                `for the transfer, ${missing} new account(s) at ${ataRent} each, fees and the ` +
                `${rentExemptMin} it must keep: ` +
                `short by ${need - have}`,
        );
    }
    const usdcHave = await usdcOf(rpc, testPayer.address);
    if (usdcHave < micros) {
        throw new Error(`test payer holds ${usdcHave} USDC micros, short by ${micros - usdcHave}`);
    }
    if (createRecipientAta) {
        io.out(
            `recipient USDC account ${await usdcAta(recipient as Address)} of owner ${recipient}`,
        );
    }
    await sendAll(rpc, testPayer, plan, io, log);
    return 0;
}

async function drain(env: NodeJS.ProcessEnv, flags: Flags, io: Io, log: Log): Promise<number> {
    const testPayer = await testPayerOf(env);
    const feePayer = await loadKeypair(
        required(env, "BUGNET_FEE_PAYER_KEY"),
        "BUGNET_FEE_PAYER_KEY",
    );
    const refund = await loadKeypair(required(env, "BUGNET_REFUND_KEY"), "BUGNET_REFUND_KEY");
    const recipientKey = (env.BUGNET_RECIPIENT_KEY ?? "").trim();
    const recipient =
        recipientKey === "" ? undefined : await loadKeypair(recipientKey, "BUGNET_RECIPIENT_KEY");
    const rpc = createRpc(required(env, "BUGNET_SOLANA_RPC_URL"));
    const plan = await drainPlan(
        {
            testPayer,
            feePayer,
            refundSigner: refund,
            recipient,
            closeAtas: flags.switches.has("--close-atas"),
        },
        {
            feePayerLamports: await lamportsOf(rpc, feePayer.address),
            refundLamports: await lamportsOf(rpc, refund.address),
            recipientLamports: recipient ? await lamportsOf(rpc, recipient.address) : 0n,
            refundUsdc: await usdcOf(rpc, refund.address),
            recipientUsdc: recipient ? await usdcOf(rpc, recipient.address) : 0n,
        },
    );
    if (plan.length === 0) {
        io.out("nothing to drain");
        return 0;
    }
    await sendAll(rpc, testPayer, plan, io, log);
    return 0;
}

async function sendAll(
    rpc: SolanaRpc,
    testPayer: KeyPairSigner,
    plan: readonly PlannedTx[],
    io: Io,
    log: Log,
): Promise<void> {
    for (const [i, tx] of plan.entries()) {
        const signature = await sendAndConfirm(rpc, testPayer, tx);
        log.info("transaction confirmed", { step: i + 1, of: plan.length, signature });
        io.out(`confirmed ${signature}`);
    }
}

async function sendAndConfirm(
    rpc: SolanaRpc,
    testPayer: KeyPairSigner,
    tx: PlannedTx,
): Promise<string> {
    if (tx.feePayer !== testPayer.address) throw new Error("planned transaction has another payer");
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const signed = await signV0Transaction({
        feePayer: testPayer,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        computeUnitLimit: COMPUTE_UNIT_LIMIT,
        computeUnitPrice: COMPUTE_UNIT_PRICE,
        instructions: tx.instructions,
    });
    const signature = getSignatureFromTransaction(signed);
    await rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), {
            encoding: "base64",
            preflightCommitment: "confirmed",
        })
        .send();
    await waitForLanding(rpc, signature, latest.lastValidBlockHeight);
    return signature;
}

// Waits by block height, not wall clock: a transaction can land any time before its blockhash
// expires, so only an expired blockhash with no status proves it never will.
async function waitForLanding(
    rpc: SolanaRpc,
    txSignature: string,
    lastValidBlockHeight: bigint,
): Promise<void> {
    let failures = 0;
    for (;;) {
        let landing: Landing;
        try {
            landing = await readLanding(
                rpc,
                txSignature,
                lastValidBlockHeight,
                POLL_CALL_TIMEOUT_MS,
            );
        } catch (err) {
            if (++failures >= MAX_POLL_FAILURES) {
                const why = err instanceof Error ? err.message : String(err);
                throw new Error(
                    `transaction ${txSignature} unknown, check the explorer before retrying ` +
                        `(polling kept failing: ${why})`,
                    { cause: err },
                );
            }
            await new Promise((r) => setTimeout(r, POLL_BACKOFF_MS * failures));
            continue;
        }
        failures = 0;
        if (landing === "landed") return;
        if (landing === "onchain_failed") {
            throw new Error(`transaction ${txSignature} failed on chain`);
        }
        if (landing === "blockhash_expired") {
            throw new Error(`transaction ${txSignature} not landed, safe to retry`);
        }
        await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
    }
}
