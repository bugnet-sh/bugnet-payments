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
    ["BUGNET_DEPOSIT_SEED", () => randomBytes(32).toString("base64")],
] as const;

const DEPOSIT_SEED = "BUGNET_DEPOSIT_SEED";
const DEPOSIT_SEED_PREVIOUS = "BUGNET_DEPOSIT_SEED_PREVIOUS";

const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

export function parseEnvText(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const m = LINE.exec(line);
        if (m) env[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    return env;
}

function linesOf(text: string): string[] {
    return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

function lineOf(lines: readonly string[], variable: string): number {
    return lines.findIndex((l) => LINE.exec(l)?.[1] === variable);
}

function setLine(lines: string[], variable: string, value: string): void {
    const at = lineOf(lines, variable);
    if (at === -1) lines.push(`${variable}=${value}`);
    else lines[at] = `${variable}=${value}`;
}

// A rename keeps a crash from truncating a file that holds the only copy of the keys
function writeEnvFile(path: string, lines: readonly string[]): void {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
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
    const lines = linesOf(text);
    const current = parseEnvText(text);
    const added: string[] = [];
    const set = (variable: string, value: string) => {
        setLine(lines, variable, value);
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
        writeEnvFile(envPath, lines);
    } else if (existsSync(envPath)) {
        chmodSync(envPath, 0o600);
    }
    return { added, addresses };
}

function readEnvFile(path: string): { lines: string[]; env: Record<string, string> } {
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    const text = readFileSync(path, "utf8");
    return { lines: linesOf(text), env: parseEnvText(text) };
}

// Spec 4.3: one rename moves the seed and writes the new one, so a crash leaves either both or
// neither, and a second rotation cannot drop a seed that live deposits still sign with
export function rotateDepositSeed(envPath: string): void {
    const { lines, env } = readEnvFile(envPath);
    if ((env[DEPOSIT_SEED_PREVIOUS] ?? "") !== "") {
        throw new Error(`${DEPOSIT_SEED_PREVIOUS} is set: a rotation is still draining`);
    }
    const seed = env[DEPOSIT_SEED] ?? "";
    if (seed === "") throw new Error(`${DEPOSIT_SEED} is empty: run keys generate first`);
    const at = lineOf(lines, DEPOSIT_SEED);
    lines[at] = `${DEPOSIT_SEED}=${randomBytes(32).toString("base64")}`;
    const previous = `${DEPOSIT_SEED_PREVIOUS}=${seed}`;
    const old = lineOf(lines, DEPOSIT_SEED_PREVIOUS);
    if (old === -1) lines.splice(at + 1, 0, previous);
    else lines[old] = previous;
    writeEnvFile(envPath, lines);
}

// Spec 4.3: the archive is written before the env file loses the seed, so a run that stops
// between the two is finished by the next one and the seed is never lost
export function retireDepositSeed(o: { envPath: string; archivePath: string; version: number }): {
    archived: boolean;
    removed: boolean;
} {
    if (resolve(o.archivePath) === resolve(o.envPath)) {
        throw new Error("the archive must be a file of its own");
    }
    const { lines, env } = readEnvFile(o.envPath);
    const previous = env[DEPOSIT_SEED_PREVIOUS] ?? "";
    if (previous === "") return { archived: false, removed: false };
    const name = `${DEPOSIT_SEED}_V${o.version}`;
    const archive = existsSync(o.archivePath)
        ? readEnvFile(o.archivePath)
        : { lines: [], env: {} as Record<string, string> };
    const kept = archive.env[name] ?? "";
    if (kept !== "" && kept !== previous) {
        throw new Error(`${name} is already archived with another value`);
    }
    if (kept === "") {
        setLine(archive.lines, name, previous);
        writeEnvFile(o.archivePath, archive.lines);
    } else {
        chmodSync(o.archivePath, 0o600);
    }
    writeEnvFile(
        o.envPath,
        lines.filter((l) => LINE.exec(l)?.[1] !== DEPOSIT_SEED_PREVIOUS),
    );
    return { archived: kept === "", removed: true };
}

// D8 A, phase 1: the line a Mac-side script appends to the offline archive. The env file keeps
// the seed until phase 2 sees that line read back, so a seed is never lost in transit.
export function previousSeedLine(envPath: string, version: number): string | null {
    const previous = readEnvFile(envPath).env[DEPOSIT_SEED_PREVIOUS] ?? "";
    return previous === "" ? null : `${DEPOSIT_SEED}_V${version}=${previous}`;
}

// D8 A, phase 2: the seed leaves the env file only when the archive holds this same value
export function removeArchivedSeed(
    envPath: string,
    version: number,
    archive: Readonly<Record<string, string>>,
): "removed" | "nothing" | "mismatch" {
    const { lines, env } = readEnvFile(envPath);
    const previous = env[DEPOSIT_SEED_PREVIOUS] ?? "";
    if (previous === "") return "nothing";
    if (archive[`${DEPOSIT_SEED}_V${version}`] !== previous) return "mismatch";
    writeEnvFile(
        envPath,
        lines.filter((l) => LINE.exec(l)?.[1] !== DEPOSIT_SEED_PREVIOUS),
    );
    return "removed";
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
    balances: {
        feePayerLamports: bigint;
        payToLamports: bigint;
        payToUsdc: bigint;
        payToAtaExists?: boolean;
    },
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
    if (balances.payToAtaExists ?? true) {
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
    }
    if (instructions.length > 0) plan(instructions);
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
    const refuse = () =>
        new Error(`refusing to write the test seller's keys to ${path}: use a file of its own`);
    if (basename(path) === ".env" || resolve(path) === PAYMENTS_ENV_FILE) throw refuse();
    const existed = existsSync(path);
    const text = existed ? readFileSync(path, "utf8") : "";
    const lines = linesOf(text);
    const current = parseEnvText(text);
    if (Object.keys(current).some((k) => k.startsWith("BUGNET_"))) throw refuse();
    const added: string[] = [];
    for (const variable of TESTSELLER_KEYS) {
        if ((current[variable] ?? "") !== "") continue;
        const value = (await generateExportableKeypair()).secretBase58;
        setLine(lines, variable, value);
        current[variable] = value;
        added.push(variable);
    }
    if (added.length > 0) {
        writeEnvFile(path, lines);
    } else {
        chmodSync(path, 0o600);
    }
    const [feePayer, payTo] = await Promise.all(
        TESTSELLER_KEYS.map((v) => loadKeypair(current[v]!, v)),
    );
    return { added, feePayer: feePayer!.address, payTo: payTo!.address };
}
