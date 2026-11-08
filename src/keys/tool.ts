import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
    getCloseAccountInstruction,
    getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token";
import { usdcAta } from "../solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "../solana/constants.ts";
import { generateExportableKeypair, loadKeypair } from "../solana/keys.ts";
import { usdcTransferChecked } from "../solana/transfer.ts";
import { loadTestPayer } from "./test-payer.ts";

export interface PlannedTx {
    feePayer: Address;
    instructions: Instruction[];
}

const WALLET_KEYS = [
    ["BUGNET_FEE_PAYER_KEY", "fee_payer"],
    ["BUGNET_REFUND_KEY", "refund"],
    ["BUGNET_RECIPIENT_KEY", "recipient"],
] as const;

const ALLOWANCE_KEY = "BUGNET_ALLOWANCE_KEY";
const TESTSELLER_KEYS = ["TESTSELLER_FEE_PAYER_KEY", "TESTSELLER_PAYTO_KEY"] as const;
const PAYMENTS_ENV_FILE = "/etc/bugnet/payments.env";

const SERVICE_SECRETS = [
    ["BUGNET_ORDER_PRIVATE_KEY", () => randomBytes(32).toString("base64")],
    ["BUGNET_CLAIM_KEY", () => randomBytes(32).toString("base64")],
    ["BUGNET_PAYMENTS_TOKEN", () => randomBytes(32).toString("base64url")],
] as const;

const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

export function parseEnvText(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const m = LINE.exec(line);
        if (m) env[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    return env;
}

export function walletAddresses(
    env: NodeJS.ProcessEnv,
): Promise<{ name: string; signer: KeyPairSigner }[]> {
    return Promise.all(
        [...WALLET_KEYS, [ALLOWANCE_KEY, "allowance"] as const]
            .filter(([variable]) => (env[variable] ?? "").trim() !== "")
            .map(async ([variable, name]) => ({
                name,
                signer: await loadKeypair(env[variable]!, variable),
            })),
    );
}

export async function generateSecrets(
    envPath: string,
): Promise<{ added: string[]; addresses: Record<string, string> }> {
    const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
    const current = parseEnvText(text);
    const added: string[] = [];
    const set = (variable: string, value: string) => {
        const at = lines.findIndex((l) => LINE.exec(l)?.[1] === variable);
        if (at === -1) lines.push(`${variable}=${value}`);
        else lines[at] = `${variable}=${value}`;
        current[variable] = value;
        added.push(variable);
    };
    for (const [variable] of WALLET_KEYS) {
        if ((current[variable] ?? "") === "")
            set(variable, (await generateExportableKeypair()).secretBase58);
    }
    for (const [variable, make] of SERVICE_SECRETS) {
        if ((current[variable] ?? "") === "") set(variable, make());
    }
    if ((current[ALLOWANCE_KEY] ?? "") === "") {
        set(ALLOWANCE_KEY, (await generateExportableKeypair()).secretBase58);
    }
    const addresses: Record<string, string> = {};
    const testPayer = await loadTestPayer(current);
    if (testPayer !== null) addresses.test_payer = testPayer.address;
    for (const { name, signer } of await walletAddresses(current)) addresses[name] = signer.address;
    if (added.length > 0) {
        // A rename keeps a crash from truncating a file that holds the only copy of the keys
        const temp = `${envPath}.${process.pid}.tmp`;
        writeFileSync(temp, `${lines.join("\n")}\n`, { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, envPath);
    } else if (existsSync(envPath)) {
        chmodSync(envPath, 0o600);
    }
    return { added, addresses };
}

export async function fundingPlan(o: {
    testPayer: KeyPairSigner;
    feePayer: Address;
    refundWallet: Address;
    recipient: Address;
    feePayerLamports: bigint;
    feePayerBalance: bigint;
    rentExemptMin: bigint;
    refundUsdcMicros: bigint;
    createRecipientAta: boolean;
    allowanceWallet: Address | null;
}): Promise<PlannedTx[]> {
    if (o.feePayerLamports > 0n && o.feePayerBalance + o.feePayerLamports < o.rentExemptMin) {
        throw new Error(
            `fee payer would hold ${o.feePayerBalance + o.feePayerLamports} lamports, ` +
                `below the rent-exempt minimum of ${o.rentExemptMin}`,
        );
    }
    const instructions: Instruction[] = [];
    if (o.feePayerLamports > 0n) {
        instructions.push(
            getTransferSolInstruction({
                source: o.testPayer,
                destination: o.feePayer,
                amount: o.feePayerLamports,
            }),
        );
    }
    const owners = o.createRecipientAta ? [o.refundWallet, o.recipient] : [o.refundWallet];
    if (o.allowanceWallet !== null) owners.push(o.allowanceWallet);
    for (const owner of owners) {
        instructions.push(
            await getCreateAssociatedTokenIdempotentInstructionAsync({
                payer: o.testPayer,
                owner,
                mint: USDC_MINT,
            }),
        );
    }
    if (o.refundUsdcMicros > 0n) {
        instructions.push(
            await usdcTransferChecked(
                o.testPayer,
                await usdcAta(o.refundWallet),
                o.refundUsdcMicros,
            ),
        );
    }
    return [{ feePayer: o.testPayer.address, instructions }];
}

export async function drainPlan(
    o: {
        testPayer: KeyPairSigner;
        feePayer: KeyPairSigner;
        refundSigner: KeyPairSigner;
        recipient?: KeyPairSigner;
        closeAtas: boolean;
    },
    balances: {
        feePayerLamports: bigint;
        refundLamports: bigint;
        recipientLamports: bigint;
        refundUsdc: bigint;
        recipientUsdc: bigint;
    },
): Promise<PlannedTx[]> {
    const txs: PlannedTx[] = [];
    const plan = (instructions: Instruction[]) => {
        if (instructions.length > 0) txs.push({ feePayer: o.testPayer.address, instructions });
    };
    const destination = await usdcAta(o.testPayer.address);
    const wallets = [
        { signer: o.refundSigner, lamports: balances.refundLamports, usdc: balances.refundUsdc },
        ...(o.recipient
            ? [
                  {
                      signer: o.recipient,
                      lamports: balances.recipientLamports,
                      usdc: balances.recipientUsdc,
                  },
              ]
            : []),
    ];
    for (const { signer, usdc } of wallets) {
        if (usdc === 0n) continue;
        const source = await usdcAta(signer.address);
        const instructions: Instruction[] = [await usdcTransferChecked(signer, destination, usdc)];
        if (o.closeAtas) {
            instructions.push(
                getCloseAccountInstruction(
                    { account: source, destination: o.testPayer.address, owner: signer },
                    { programAddress: TOKEN_PROGRAM },
                ),
            );
        }
        plan(instructions);
    }
    const sol = [{ signer: o.feePayer, lamports: balances.feePayerLamports }, ...wallets];
    for (const { signer, lamports } of sol) {
        if (lamports === 0n) continue;
        plan([
            getTransferSolInstruction({
                source: signer,
                destination: o.testPayer.address,
                amount: lamports,
            }),
        ]);
    }
    return txs;
}

export async function allowanceDrainPlan(
    o: { testPayer: KeyPairSigner; allowance: KeyPairSigner },
    hotUsdc: bigint,
): Promise<PlannedTx[]> {
    if (hotUsdc === 0n) return [];
    return [
        {
            feePayer: o.testPayer.address,
            instructions: [
                await usdcTransferChecked(o.allowance, await usdcAta(o.testPayer.address), hotUsdc),
            ],
        },
    ];
}

export async function testSellerPlan(o: {
    testPayer: KeyPairSigner;
    payTo: Address;
}): Promise<PlannedTx[]> {
    return [
        {
            feePayer: o.testPayer.address,
            instructions: [
                await getCreateAssociatedTokenIdempotentInstructionAsync({
                    payer: o.testPayer,
                    owner: o.payTo,
                    mint: USDC_MINT,
                }),
            ],
        },
    ];
}

export async function testSellerDrainPlan(
    o: { testPayer: KeyPairSigner; feePayer: KeyPairSigner; payTo: KeyPairSigner },
    balances: { feePayerLamports: bigint; payToLamports: bigint; payToUsdc: bigint },
): Promise<PlannedTx[]> {
    const txs: PlannedTx[] = [];
    const plan = (instructions: Instruction[]) =>
        txs.push({ feePayer: o.testPayer.address, instructions });
    const instructions: Instruction[] = [];
    if (balances.payToUsdc > 0n) {
        instructions.push(
            await usdcTransferChecked(
                o.payTo,
                await usdcAta(o.testPayer.address),
                balances.payToUsdc,
            ),
        );
    }
    instructions.push(
        getCloseAccountInstruction(
            {
                account: await usdcAta(o.payTo.address),
                destination: o.testPayer.address,
                owner: o.payTo,
            },
            { programAddress: TOKEN_PROGRAM },
        ),
    );
    plan(instructions);
    for (const [signer, lamports] of [
        [o.feePayer, balances.feePayerLamports],
        [o.payTo, balances.payToLamports],
    ] as const) {
        if (lamports === 0n) continue;
        plan([
            getTransferSolInstruction({
                source: signer,
                destination: o.testPayer.address,
                amount: lamports,
            }),
        ]);
    }
    return txs;
}

export async function writeTestSellerEnv(
    path: string,
): Promise<{ added: string[]; feePayer: Address; payTo: Address }> {
    if (basename(path) === ".env" || resolve(path) === PAYMENTS_ENV_FILE) {
        throw new Error(
            `refusing to write the test seller's keys to ${path}: use a file of its own`,
        );
    }
    const existed = existsSync(path);
    const text = existed ? readFileSync(path, "utf8") : "";
    const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
    const current = parseEnvText(text);
    const added: string[] = [];
    for (const variable of TESTSELLER_KEYS) {
        if ((current[variable] ?? "") !== "") continue;
        const value = (await generateExportableKeypair()).secretBase58;
        const at = lines.findIndex((l) => LINE.exec(l)?.[1] === variable);
        if (at === -1) lines.push(`${variable}=${value}`);
        else lines[at] = `${variable}=${value}`;
        current[variable] = value;
        added.push(variable);
    }
    if (added.length > 0) {
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, `${lines.join("\n")}\n`, { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, path);
    } else {
        chmodSync(path, 0o600);
    }
    const [feePayer, payTo] = await Promise.all(
        TESTSELLER_KEYS.map((v) => loadKeypair(current[v]!, v)),
    );
    return { added, feePayer: feePayer!.address, payTo: payTo!.address };
}
