import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getBase58Encoder, type Instruction, type KeyPairSigner } from "@solana/kit";
import {
    SYSTEM_PROGRAM_ADDRESS,
    getTransferSolInstructionDataDecoder,
} from "@solana-program/system";
import {
    getCloseAccountInstructionDataDecoder,
    getTransferCheckedInstructionDataDecoder,
} from "@solana-program/token";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliMain } from "../cli.ts";
import { usdcAta } from "../solana/accounts.ts";
import { generateExportableKeypair } from "../solana/keys.ts";
import { type FakeChain, startFakeChain } from "../testing/fake-chain.ts";
import { TEST_RENT_EXEMPT_MIN_LAMPORTS } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { KEYS_USAGE } from "./commands.ts";
import { loadKeypair } from "../solana/keys.ts";
import {
    allowanceDrainPlan,
    drainPlan,
    fundingPlan,
    generateSecrets,
    type PlannedTx,
    parseEnvText,
    retireDepositSeed,
    rotateDepositSeed,
    testSellerDrainPlan,
    testSellerPlan,
    writeTestSellerEnv,
} from "./tool.ts";

const ABANDON =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

let dir: string;
let testPayer: KeyPairSigner;
let feePayer: KeyPairSigner;
let refundSigner: KeyPairSigner;
let recipient: KeyPairSigner;
let allowance: KeyPairSigner;
let payTo: KeyPairSigner;
let sellerFeePayer: KeyPairSigner;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "bn-pay-keys-"));
    [testPayer, feePayer, refundSigner, recipient, allowance, payTo, sellerFeePayer] =
        await Promise.all([
            testSigner(1),
            testSigner(2),
            testSigner(3),
            testSigner(4),
            testSigner(5),
            testSigner(6),
            testSigner(7),
        ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function tmpEnv(text: string, mode: number): string {
    const path = join(dir, `env-${counter++}`);
    writeFileSync(path, text);
    chmodSync(path, mode);
    return path;
}

function captureIo() {
    const out: string[] = [];
    const err: string[] = [];
    return {
        out: (s: string) => out.push(s),
        err: (s: string) => err.push(s),
        outText: () => out.join("\n"),
        errText: () => err.join("\n"),
    };
}

const parseEnv = parseEnvText;

function instructionsOf(txs: PlannedTx[]): Instruction[] {
    return txs.flatMap((t) => t.instructions);
}

function systemTransfers(txs: PlannedTx[]) {
    return instructionsOf(txs)
        .filter((i) => i.programAddress === SYSTEM_PROGRAM_ADDRESS)
        .map((i) => ({
            source: i.accounts![0]!.address,
            destination: i.accounts![1]!.address,
            amount: getTransferSolInstructionDataDecoder().decode(i.data!).amount,
        }));
}

function tokenTransfers(txs: PlannedTx[]) {
    return instructionsOf(txs)
        .filter((i) => i.programAddress === TOKEN_PROGRAM && i.data![0] === 12)
        .map((i) => ({
            source: i.accounts![0]!.address,
            destination: i.accounts![2]!.address,
            authority: i.accounts![3]!.address,
            amount: getTransferCheckedInstructionDataDecoder().decode(i.data!).amount,
        }));
}

function closes(txs: PlannedTx[]) {
    return instructionsOf(txs)
        .filter((i) => i.programAddress === TOKEN_PROGRAM && i.data![0] === 9)
        .map((i) => {
            getCloseAccountInstructionDataDecoder().decode(i.data!);
            return {
                account: i.accounts![0]!.address,
                destination: i.accounts![1]!.address,
                authority: i.accounts![2]!.address,
            };
        });
}

const feePayersOf = (txs: PlannedTx[]) => txs.map((t) => t.feePayer);

function fundOptions() {
    return {
        testPayer,
        feePayer: feePayer.address,
        refundWallet: refundSigner.address,
        recipient: recipient.address,
        feePayerLamports: 100_000_000n,
        feePayerBalance: 0n,
        rentExemptMin: TEST_RENT_EXEMPT_MIN_LAMPORTS,
        refundUsdcMicros: 5_000_000n,
        createRecipientAta: false,
        allowanceWallet: null as Address | null,
    };
}

describe("keys generate", () => {
    it("fills missing secrets only, keeps 0600 and prints no secret", async () => {
        const p = tmpEnv("BUGNET_TEST_PAYER_KEY=\nBUGNET_PAYMENTS_TOKEN=keep\n", 0o600);
        const io = captureIo();
        expect(await cliMain(["keys", "generate", "--env", p], {}, io)).toBe(0);
        const env = parseEnv(readFileSync(p, "utf8"));
        expect(env.BUGNET_PAYMENTS_TOKEN).toBe("keep");
        expect(Buffer.from(env.BUGNET_ORDER_PRIVATE_KEY!, "base64")).toHaveLength(32);
        expect(Buffer.from(env.BUGNET_CLAIM_KEY!, "base64")).toHaveLength(32);
        expect(getBase58Encoder().encode(env.BUGNET_FEE_PAYER_KEY!)).toHaveLength(64);
        expect(getBase58Encoder().encode(env.BUGNET_REFUND_KEY!)).toHaveLength(64);
        expect(getBase58Encoder().encode(env.BUGNET_RECIPIENT_KEY!)).toHaveLength(64);
        expect(env.BUGNET_TEST_PAYER_KEY).toBe("");
        expect(statSync(p).mode & 0o777).toBe(0o600);
        for (const v of Object.values(env)) {
            if (v && v !== "keep") expect(io.outText() + io.errText()).not.toContain(v);
        }
        expect(io.outText()).toMatch(/fee_payer=[1-9A-HJ-NP-Za-km-z]{32,44}/);
        expect(io.outText()).not.toMatch(/test_payer=/);
    });

    it("tightens a looser file mode and is a no-op when nothing is missing", async () => {
        const p = tmpEnv("", 0o644);
        await cliMain(["keys", "generate", "--env", p], {}, captureIo());
        expect(statSync(p).mode & 0o777).toBe(0o600);
        const before = readFileSync(p, "utf8");
        const io = captureIo();
        expect(await cliMain(["keys", "generate", "--env", p], {}, io)).toBe(0);
        expect(readFileSync(p, "utf8")).toBe(before);
        expect(io.outText()).toContain("added=none");
    });

    it("adds only the service secrets to a .env shaped like the founder's", async () => {
        const fee = await generateExportableKeypair();
        const refund = await generateExportableKeypair();
        const cold = await generateExportableKeypair();
        const text = [
            "# keep this comment",
            `BUGNET_FEE_PAYER_KEY=${fee.secretBase58}`,
            `BUGNET_REFUND_KEY=${refund.secretBase58}`,
            `BUGNET_RECIPIENT_KEY=${cold.secretBase58}`,
            "BUGNET_TEST_PAYER_KEY=",
            `BUGNET_TEST_PAYER_MNEMONIC="abandon, abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon  about."`,
            "BUGNET_TEST_PAYER_ACCOUNT_INDEX=1",
            "",
        ].join("\n");
        const p = tmpEnv(text, 0o600);
        const io = captureIo();
        expect(await cliMain(["keys", "generate", "--env", p], {}, io)).toBe(0);
        expect(io.outText()).toContain(
            "added=BUGNET_ORDER_PRIVATE_KEY,BUGNET_CLAIM_KEY,BUGNET_PAYMENTS_TOKEN,BUGNET_DEPOSIT_SEED",
        );
        expect(io.outText()).toContain("test_payer=Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb");
        expect(io.outText()).toContain(`fee_payer=${fee.signer.address}`);
        expect(io.outText()).toContain(`refund=${refund.signer.address}`);
        expect(io.outText()).toContain(`recipient=${cold.signer.address}`);
        expect(io.outText() + io.errText()).not.toContain("abandon");
        const after = readFileSync(p, "utf8");
        expect(after.startsWith(text.replace(/\n$/, ""))).toBe(true);
        expect(after).not.toContain("BUGNET_TEST_RECIPIENT_KEY");
        expect(parseEnv(after).BUGNET_TEST_PAYER_KEY).toBe("");
    });
});

describe("keys generate", () => {
    async function fullTask24Env(over: Record<string, string> = {}): Promise<string> {
        const k = async () => (await generateExportableKeypair()).secretBase58;
        const vars: Record<string, string> = {
            BUGNET_FEE_PAYER_KEY: await k(),
            BUGNET_REFUND_KEY: await k(),
            BUGNET_RECIPIENT_KEY: await k(),
            BUGNET_ORDER_PRIVATE_KEY: Buffer.alloc(32, 1).toString("base64"),
            BUGNET_CLAIM_KEY: Buffer.alloc(32, 2).toString("base64"),
            BUGNET_PAYMENTS_TOKEN: "token",
            BUGNET_DEPOSIT_SEED: Buffer.alloc(32, 3).toString("base64"),
            BUGNET_ALLOWANCE_KEY: await k(),
            ...over,
        };
        return Object.entries(vars)
            .map(([n, v]) => `${n}=${v}`)
            .join("\n");
    }

    it("generate adds only BUGNET_ALLOWANCE_KEY when empty and prints its address, never the key", async () => {
        const p = tmpEnv(await fullTask24Env({ BUGNET_ALLOWANCE_KEY: "" }), 0o600);
        const io = captureIo();
        expect(await cliMain(["keys", "generate", "--env", p], {}, io)).toBe(0);
        const env = parseEnv(readFileSync(p, "utf8"));
        const key = await loadKeypair(env.BUGNET_ALLOWANCE_KEY!, "BUGNET_ALLOWANCE_KEY");
        expect(io.outText()).toContain("added=BUGNET_ALLOWANCE_KEY");
        expect(io.outText()).toContain(`allowance=${key.address}`);
        expect(io.outText()).not.toContain(env.BUGNET_ALLOWANCE_KEY);
        expect(statSync(p).mode & 0o777).toBe(0o600);
        expect((await generateSecrets(p)).added).toEqual([]);
        expect(parseEnv(readFileSync(p, "utf8")).BUGNET_ALLOWANCE_KEY).toBe(
            env.BUGNET_ALLOWANCE_KEY,
        );
        expect(env.BUGNET_X402_TLS_KEY ?? "").toBe("");
    });

    it("first generate on a fresh file adds BUGNET_ALLOWANCE_KEY too", async () => {
        expect((await generateSecrets(tmpEnv("", 0o600))).added).toContain("BUGNET_ALLOWANCE_KEY");
    });
});

describe("deposit seed commands", () => {
    const A = Buffer.alloc(32, 7).toString("base64");
    const CURRENT = Buffer.alloc(32, 8).toString("base64");
    const THIRD = Buffer.alloc(32, 9).toString("base64");
    const DRAINING = "BUGNET_DEPOSIT_SEED_PREVIOUS is set: a rotation is still draining";
    const printed = (...ios: ReturnType<typeof captureIo>[]) =>
        ios.map((io) => io.outText() + io.errText()).join("\n");

    it("generate writes BUGNET_DEPOSIT_SEED", async () => {
        const p = tmpEnv("", 0o600);
        const io = captureIo();
        expect(await cliMain(["keys", "generate", "--env", p], {}, io)).toBe(0);
        const seed = parseEnv(readFileSync(p, "utf8")).BUGNET_DEPOSIT_SEED!;
        expect(seed).toHaveLength(44);
        expect(Buffer.from(seed, "base64")).toHaveLength(32);
        expect(Buffer.from(seed, "base64").toString("base64")).toBe(seed);
        expect(printed(io)).not.toContain(seed);
        expect(await cliMain(["keys", "generate", "--env", p], {}, captureIo())).toBe(0);
        expect(parseEnv(readFileSync(p, "utf8")).BUGNET_DEPOSIT_SEED).toBe(seed);
    });

    it("rotate-deposit-seed moves the seed and makes a new one", async () => {
        const text = [
            "# keep this comment",
            "BUGNET_CLAIM_KEY=claim",
            `BUGNET_DEPOSIT_SEED=${A}`,
            "BUGNET_FEE_PAYER_KEY=fee",
            "",
        ].join("\n");
        const p = tmpEnv(text, 0o644);
        const io = captureIo();
        expect(await cliMain(["keys", "rotate-deposit-seed", "--env", p], {}, io)).toBe(0);
        const after = readFileSync(p, "utf8");
        const env = parseEnv(after);
        expect(env.BUGNET_DEPOSIT_SEED_PREVIOUS).toBe(A);
        const fresh = env.BUGNET_DEPOSIT_SEED!;
        expect(fresh).not.toBe(A);
        expect(Buffer.from(fresh, "base64")).toHaveLength(32);
        expect(Buffer.from(fresh, "base64").toString("base64")).toBe(fresh);
        expect(statSync(p).mode & 0o777).toBe(0o600);
        const others = (t: string) => t.split("\n").filter((l) => !l.startsWith("BUGNET_DEPOSIT"));
        expect(others(after)).toEqual(others(text));

        const again = captureIo();
        expect(await cliMain(["keys", "rotate-deposit-seed", "--env", p], {}, again)).toBe(1);
        expect(again.errText()).toContain(DRAINING);
        expect(() => rotateDepositSeed(p)).toThrow(DRAINING);
        expect(readFileSync(p, "utf8")).toBe(after);
        for (const value of [A, fresh]) expect(printed(io, again)).not.toContain(value);
    });

    it("rotate-deposit-seed fills an empty previous line in place", () => {
        const text = `BUGNET_DEPOSIT_SEED=${A}\nBUGNET_DEPOSIT_SEED_PREVIOUS=\nBUGNET_CLAIM_KEY=c\n`;
        const p = tmpEnv(text, 0o600);
        rotateDepositSeed(p);
        const lines = readFileSync(p, "utf8").split("\n");
        expect(lines[1]).toBe(`BUGNET_DEPOSIT_SEED_PREVIOUS=${A}`);
        expect(lines.slice(2)).toEqual(["BUGNET_CLAIM_KEY=c", ""]);
    });

    it("rotate-deposit-seed refuses an empty seed and needs --env", async () => {
        const text = "BUGNET_DEPOSIT_SEED=\n";
        const p = tmpEnv(text, 0o600);
        const io = captureIo();
        expect(await cliMain(["keys", "rotate-deposit-seed", "--env", p], {}, io)).toBe(1);
        expect(io.errText()).toContain("BUGNET_DEPOSIT_SEED is empty");
        expect(readFileSync(p, "utf8")).toBe(text);
        const usage = captureIo();
        expect(await cliMain(["keys", "rotate-deposit-seed"], {}, usage)).toBe(2);
        expect(usage.errText()).toContain("keys rotate-deposit-seed needs --env FILE");
    });

    it("retire-deposit-seed archives, then removes the previous seed", async () => {
        const text = [
            "# keep this comment",
            `BUGNET_DEPOSIT_SEED=${CURRENT}`,
            `BUGNET_DEPOSIT_SEED_PREVIOUS=${A}`,
            "BUGNET_CLAIM_KEY=claim",
            "",
        ].join("\n");
        const removed = text.replace(`BUGNET_DEPOSIT_SEED_PREVIOUS=${A}\n`, "");
        const p = tmpEnv(text, 0o600);
        const archive = join(dir, `archive-${counter++}`);
        const args = (version = "1") => [
            "keys",
            "retire-deposit-seed",
            "--env",
            p,
            "--archive",
            archive,
            "--version",
            version,
        ];
        const io = captureIo();
        expect(await cliMain(args(), {}, io)).toBe(0);
        expect(readFileSync(archive, "utf8")).toBe(`BUGNET_DEPOSIT_SEED_V1=${A}\n`);
        expect(statSync(archive).mode & 0o777).toBe(0o600);
        expect(readFileSync(p, "utf8")).toBe(removed);
        expect(statSync(p).mode & 0o777).toBe(0o600);

        // A run that stopped between the two writes
        writeFileSync(p, text);
        const resumed = captureIo();
        expect(await cliMain(args(), {}, resumed)).toBe(0);
        expect(readFileSync(archive, "utf8")).toBe(`BUGNET_DEPOSIT_SEED_V1=${A}\n`);
        expect(readFileSync(p, "utf8")).toBe(removed);

        const nothing = captureIo();
        expect(await cliMain(args(), {}, nothing)).toBe(0);
        expect(nothing.outText()).toBe("nothing to retire");
        expect(readFileSync(archive, "utf8")).toBe(`BUGNET_DEPOSIT_SEED_V1=${A}\n`);
        expect(readFileSync(p, "utf8")).toBe(removed);

        const bad = captureIo();
        expect(await cliMain(args("0"), {}, bad)).toBe(2);
        expect(bad.errText()).toContain("--version needs a whole number of at least 1");
        for (const value of [A, CURRENT]) {
            expect(printed(io, resumed, nothing, bad)).not.toContain(value);
        }
    });

    it("retire-deposit-seed --archive - prints only the archive line and removes nothing", async () => {
        const text = `BUGNET_DEPOSIT_SEED=${CURRENT}\nBUGNET_DEPOSIT_SEED_PREVIOUS=${A}\n`;
        const p = tmpEnv(text, 0o600);
        const args = [
            "keys",
            "retire-deposit-seed",
            "--env",
            p,
            "--archive",
            "-",
            "--version",
            "1",
        ];
        const io = captureIo();
        expect(await cliMain(args, {}, io)).toBe(0);
        expect(io.outText()).toBe(`BUGNET_DEPOSIT_SEED_V1=${A}`);
        expect(io.errText()).toBe("");
        expect(readFileSync(p, "utf8")).toBe(text);

        const empty = tmpEnv(`BUGNET_DEPOSIT_SEED=${CURRENT}\n`, 0o600);
        const nothing = captureIo();
        expect(
            await cliMain(
                args.map((a) => (a === p ? empty : a)),
                {},
                nothing,
            ),
        ).toBe(0);
        expect(nothing.outText()).toBe("");
        expect(nothing.errText()).toBe("nothing to retire");
    });

    it("retire-deposit-seed --remove-previous drops the seed only once stdin holds it", async () => {
        const text = `BUGNET_DEPOSIT_SEED=${CURRENT}\nBUGNET_DEPOSIT_SEED_PREVIOUS=${A}\n`;
        const p = tmpEnv(text, 0o600);
        const args = [
            "keys",
            "retire-deposit-seed",
            "--env",
            p,
            "--archive",
            "-",
            "--version",
            "1",
            "--remove-previous",
        ];
        const piped = (stdin: string) => ({ ...captureIo(), stdin: async () => stdin });
        const refused: ReturnType<typeof captureIo>[] = [];
        for (const stdin of [
            "",
            `BUGNET_DEPOSIT_SEED_V1=${THIRD}\n`,
            `BUGNET_DEPOSIT_SEED_V2=${A}\n`,
        ]) {
            const io = piped(stdin);
            expect(await cliMain(args, {}, io)).toBe(1);
            expect(io.errText()).toContain(
                "BUGNET_DEPOSIT_SEED_V1 on stdin does not match BUGNET_DEPOSIT_SEED_PREVIOUS; " +
                    "nothing removed",
            );
            expect(readFileSync(p, "utf8")).toBe(text);
            refused.push(io);
        }

        const io = piped(`# deposit-seeds.env\nBUGNET_DEPOSIT_SEED_V1=${A}\n`);
        expect(await cliMain(args, {}, io)).toBe(0);
        expect(io.outText()).toBe("");
        expect(io.errText()).toContain("removed BUGNET_DEPOSIT_SEED_PREVIOUS");
        expect(readFileSync(p, "utf8")).toBe(`BUGNET_DEPOSIT_SEED=${CURRENT}\n`);
        expect(statSync(p).mode & 0o777).toBe(0o600);

        const again = piped(`BUGNET_DEPOSIT_SEED_V1=${A}\n`);
        expect(await cliMain(args, {}, again)).toBe(0);
        expect(again.outText()).toBe("");
        expect(again.errText()).toContain("nothing to retire");
        for (const value of [A, CURRENT, THIRD]) {
            expect(printed(io, again, ...refused)).not.toContain(value);
        }

        const archive = join(dir, `archive-${counter++}`);
        const withFile = captureIo();
        const fileArgs = args.map((a) => (a === "-" ? archive : a));
        expect(await cliMain(fileArgs, {}, withFile)).toBe(2);
        expect(withFile.errText()).toContain("--remove-previous takes the archive on stdin");
    });

    it("retire-deposit-seed appends to an archive of earlier versions", () => {
        const p = tmpEnv(
            `BUGNET_DEPOSIT_SEED=${CURRENT}\nBUGNET_DEPOSIT_SEED_PREVIOUS=${A}\n`,
            0o600,
        );
        const archive = tmpEnv(`BUGNET_DEPOSIT_SEED_V1=${THIRD}`, 0o644);
        retireDepositSeed({ envPath: p, archivePath: archive, version: 2 });
        expect(readFileSync(archive, "utf8")).toBe(
            `BUGNET_DEPOSIT_SEED_V1=${THIRD}\nBUGNET_DEPOSIT_SEED_V2=${A}\n`,
        );
        expect(statSync(archive).mode & 0o777).toBe(0o600);
        expect(readFileSync(p, "utf8")).toBe(`BUGNET_DEPOSIT_SEED=${CURRENT}\n`);
    });

    it("retire-deposit-seed refuses a version archived with another value", async () => {
        const text = `BUGNET_DEPOSIT_SEED=${CURRENT}\nBUGNET_DEPOSIT_SEED_PREVIOUS=${A}\n`;
        const p = tmpEnv(text, 0o600);
        const kept = `BUGNET_DEPOSIT_SEED_V1=${THIRD}\n`;
        const archive = tmpEnv(kept, 0o600);
        const message = "BUGNET_DEPOSIT_SEED_V1 is already archived with another value";
        expect(() => retireDepositSeed({ envPath: p, archivePath: archive, version: 1 })).toThrow(
            message,
        );
        const io = captureIo();
        const args = ["--env", p, "--archive", archive, "--version", "1"];
        expect(await cliMain(["keys", "retire-deposit-seed", ...args], {}, io)).toBe(1);
        expect(io.errText()).toContain(message);
        expect(readFileSync(p, "utf8")).toBe(text);
        expect(readFileSync(archive, "utf8")).toBe(kept);
        for (const value of [A, CURRENT, THIRD]) expect(printed(io)).not.toContain(value);
    });
});

describe("allowance and test seller plans", () => {
    it("fund --create-allowance-ata uses the idempotent create", async () => {
        const txs = await fundingPlan({
            ...fundOptions(),
            feePayerLamports: 0n,
            refundUsdcMicros: 0n,
            createRecipientAta: false,
            allowanceWallet: allowance.address,
        });
        const ix = instructionsOf(txs);
        expect(ix.map((i) => i.programAddress)).toEqual([ATA_PROGRAM, ATA_PROGRAM]);
        expect(ix[1]!.data![0]).toBe(1);
        expect(ix[1]!.accounts![1]!.address).toBe(await usdcAta(allowance.address));
        expect(ix[1]!.accounts![2]!.address).toBe(allowance.address);
        expect(feePayersOf(txs).every((a) => a === testPayer.address)).toBe(true);
    });

    it("drain never touches the hot USDC account", async () => {
        const txs = await drainPlan(
            { testPayer, feePayer, refundSigner, recipient, closeAtas: true },
            {
                feePayerLamports: 1n,
                refundLamports: 1n,
                recipientLamports: 1n,
                refundUsdc: 1n,
                recipientUsdc: 1n,
            },
        );
        const hot = await usdcAta(allowance.address);
        const touched = instructionsOf(txs)
            .flatMap((i) => i.accounts ?? [])
            .map((a) => a.address);
        expect(touched).not.toContain(hot);
    });

    it("allowanceDrainPlan moves the whole balance with the test payer paying", async () => {
        const txs = await allowanceDrainPlan({ testPayer, allowance }, 970_000n);
        expect(txs).toHaveLength(1);
        expect(txs[0]!.feePayer).toBe(testPayer.address);
        expect(tokenTransfers(txs)).toEqual([
            {
                source: await usdcAta(allowance.address),
                destination: await usdcAta(testPayer.address),
                authority: allowance.address,
                amount: 970_000n,
            },
        ]);
        expect(await allowanceDrainPlan({ testPayer, allowance }, 0n)).toEqual([]);
    });

    it("testseller refuses the Payments env file and writes 0600", async () => {
        await expect(writeTestSellerEnv(join(dir, ".env"))).rejects.toThrow(
            /use a file of its own/,
        );
        await expect(writeTestSellerEnv("/etc/bugnet/payments.env")).rejects.toThrow(
            /use a file of its own/,
        );
        const production = join(dir, ".env.production");
        writeFileSync(production, "BUGNET_ALLOWANCE_KEY=x\n");
        await expect(writeTestSellerEnv(production)).rejects.toThrow(/use a file of its own/);
        expect(readFileSync(production, "utf8")).toBe("BUGNET_ALLOWANCE_KEY=x\n");
        const p = join(dir, "testseller.env");
        const r = await writeTestSellerEnv(p);
        expect(r.added).toEqual(["TESTSELLER_FEE_PAYER_KEY", "TESTSELLER_PAYTO_KEY"]);
        expect(statSync(p).mode & 0o777).toBe(0o600);
        const env = parseEnv(readFileSync(p, "utf8"));
        expect((await loadKeypair(env.TESTSELLER_FEE_PAYER_KEY!, "f")).address).toBe(r.feePayer);
        expect((await loadKeypair(env.TESTSELLER_PAYTO_KEY!, "p")).address).toBe(r.payTo);
        expect((await writeTestSellerEnv(p)).added).toEqual([]);
        expect(parseEnv(readFileSync(p, "utf8"))).toEqual(env);
    });

    it("testSellerPlan creates ATA(payTo) idempotently, the test payer paying", async () => {
        const txs = await testSellerPlan({ testPayer, payTo: payTo.address });
        const ix = instructionsOf(txs);
        expect(ix).toHaveLength(1);
        expect(ix[0]!.programAddress).toBe(ATA_PROGRAM);
        expect(ix[0]!.data![0]).toBe(1);
        expect(ix[0]!.accounts![0]!.address).toBe(testPayer.address);
        expect(ix[0]!.accounts![2]!.address).toBe(payTo.address);
        expect(feePayersOf(txs)).toEqual([testPayer.address]);
    });

    it("testSellerDrainPlan returns the seller's USDC, its ATA rent and its SOL to the test payer", async () => {
        const txs = await testSellerDrainPlan(
            { testPayer, feePayer: sellerFeePayer, payTo },
            { feePayerLamports: 9_000_000n, payToLamports: 0n, payToUsdc: 150_000n },
        );
        expect(tokenTransfers(txs).map((t) => t.amount)).toEqual([150_000n]);
        expect(systemTransfers(txs)).toEqual([
            { source: sellerFeePayer.address, destination: testPayer.address, amount: 9_000_000n },
        ]);
        expect(closes(txs)).toEqual([
            {
                account: await usdcAta(payTo.address),
                destination: testPayer.address,
                authority: payTo.address,
            },
        ]);
        const first = txs[0]!.instructions.map((i) => i.data![0]);
        expect(first).toEqual([12, 9]);
        expect(feePayersOf(txs).every((a) => a === testPayer.address)).toBe(true);
    });
});

describe("keys commands without settings", () => {
    const missingConfig = ["-config", join(tmpdir(), "bn-pay-no-such-file.toml")];

    it("pubkey, show --no-balances, generate and the seed commands never parse TOML", async () => {
        const seed = Buffer.alloc(32, 7).toString("base64");
        const env = {
            BUGNET_ORDER_PRIVATE_KEY: seed,
            BUGNET_TEST_PAYER_MNEMONIC: ABANDON,
        };
        const pub = captureIo();
        expect(await cliMain([...missingConfig, "keys", "pubkey"], env, pub)).toBe(0);
        expect(pub.outText()).toBe("6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=");

        const show = captureIo();
        expect(await cliMain([...missingConfig, "keys", "show", "--no-balances"], env, show)).toBe(
            0,
        );
        expect(show.outText()).toBe("test_payer=HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");

        const generate = captureIo();
        const p = tmpEnv("", 0o600);
        expect(
            await cliMain([...missingConfig, "keys", "generate", "--env", p], {}, generate),
        ).toBe(0);

        // With no RPC variable set, a command that built its router would fail
        const depositSeed = Buffer.alloc(32, 8).toString("base64");
        const seeds = tmpEnv(`BUGNET_DEPOSIT_SEED=${depositSeed}\n`, 0o600);
        const rotate = captureIo();
        expect(
            await cliMain(
                [...missingConfig, "keys", "rotate-deposit-seed", "--env", seeds],
                {},
                rotate,
            ),
        ).toBe(0);
        const retire = captureIo();
        const archive = join(dir, `archive-${counter++}`);
        const retireArgs = ["--env", seeds, "--archive", archive, "--version", "1"];
        expect(
            await cliMain(
                [...missingConfig, "keys", "retire-deposit-seed", ...retireArgs],
                {},
                retire,
            ),
        ).toBe(0);
        expect(parseEnv(readFileSync(archive, "utf8")).BUGNET_DEPOSIT_SEED_V1).toBe(depositSeed);
    });

    it("names the variable when the test payer is missing and leaks no secret", async () => {
        const io = captureIo();
        const key = (await generateExportableKeypair()).secretBase58;
        const rpcUrl = "http://127.0.0.1:1/secret-api-key";
        const env = { BUGNET_FEE_PAYER_KEY: key, BUGNET_SOLANA_RPC_URL: rpcUrl };
        expect(await cliMain(["keys", "drain"], env, io)).toBe(1);
        expect(io.errText()).toContain("BUGNET_TEST_PAYER_KEY");
        for (const secret of [key, rpcUrl, "secret-api-key"]) {
            expect(io.outText()).not.toContain(secret);
            expect(io.errText()).not.toContain(secret);
        }
    });

    describe("through the router", () => {
        let chain: FakeChain;
        beforeAll(async () => {
            chain = await startFakeChain();
        });
        afterAll(() => chain.close());
        // Every balance is zero, so drain only reads before it says so
        async function drainEnv(rpc: Record<string, string>): Promise<NodeJS.ProcessEnv> {
            return {
                BUGNET_TEST_PAYER_MNEMONIC: ABANDON,
                BUGNET_FEE_PAYER_KEY: (await generateExportableKeypair()).secretBase58,
                BUGNET_REFUND_KEY: (await generateExportableKeypair()).secretBase58,
                ...rpc,
            };
        }
        const balanceReads = () => chain.calls().filter((c) => c.method === "getBalance").length;

        it("keys commands use the router", async () => {
            const io = captureIo();
            const before = balanceReads();
            // Nothing listens on port 1, so rpc1 fails and rpc2 serves
            const env = await drainEnv({
                BUGNET_SOLANA_RPC_URLS: `http://127.0.0.1:1/,${chain.url}`,
            });
            expect(await cliMain(["keys", "drain"], env, io)).toBe(0);
            expect(io.outText()).toBe("nothing to drain");
            expect(balanceReads()).toBeGreaterThan(before);
        });

        it("keys commands work without a config file", async () => {
            const both: Record<string, string>[] = [
                { BUGNET_SOLANA_RPC_URL: chain.url },
                { BUGNET_SOLANA_RPC_URLS: `http://127.0.0.1:1/,${chain.url}` },
            ];
            for (const rpc of both) {
                const io = captureIo();
                const before = balanceReads();
                expect(await cliMain(["keys", "drain"], await drainEnv(rpc), io)).toBe(0);
                expect(io.outText()).toBe("nothing to drain");
                expect(balanceReads()).toBeGreaterThan(before);
            }
        });

        it("a send that may have been delivered is checked by its landing", async () => {
            const a = await chain.addEndpoint();
            const b = await chain.addEndpoint();
            // rpc1 lands the transfer and never answers; rpc2's preflight then finds it processed
            a.stall("after", { methods: ["sendTransaction"] });
            b.alreadyProcessed(true);
            const funded = await generateExportableKeypair();
            chain.fundLamports(funded.signer.address, 1_000_000n);
            const env = {
                ...(await drainEnv({ BUGNET_SOLANA_RPC_URLS: `${a.url},${b.url}` })),
                BUGNET_FEE_PAYER_KEY: funded.secretBase58,
            };
            const file = join(dir, "keys-send.toml");
            writeFileSync(
                file,
                stringify({
                    solana: { recipient: recipient.address, rpc: { attempt_timeout: "2s" } },
                }),
            );
            const before = chain.submitted().length;
            const io = captureIo();
            expect(await cliMain(["-config", file, "keys", "drain"], env, io)).toBe(0);
            const landed = chain.submitted().slice(before);
            expect(landed).toHaveLength(1);
            expect(io.outText()).toBe(`confirmed ${landed[0]!.signature}`);
            expect(b.calls().some((c) => c.method === "sendTransaction")).toBe(true);
        });

        it("keys commands take the router settings from -config", async () => {
            // rpc1 takes each request and never answers, so each of its attempts runs to the
            // attempt timeout
            const held: { at: number; ms: number | null }[] = [];
            const stalling = createServer((req, res) => {
                const call = { at: Date.now(), ms: null as number | null };
                held.push(call);
                res.on("close", () => {
                    call.ms = Date.now() - call.at;
                });
                req.resume();
            });
            await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", resolve));
            const port = (stalling.address() as AddressInfo).port;
            try {
                const file = join(dir, "keys-rpc.toml");
                writeFileSync(
                    file,
                    stringify({
                        solana: { recipient: recipient.address, rpc: { attempt_timeout: "2s" } },
                    }),
                );
                const env = await drainEnv({
                    BUGNET_SOLANA_RPC_URLS: `http://127.0.0.1:${port}/,${chain.url}`,
                });
                const io = captureIo();
                expect(await cliMain(["-config", file, "keys", "drain"], env, io)).toBe(0);
                expect(io.outText()).toBe("nothing to drain");
                const first = held[0]!.ms;
                expect(first).not.toBeNull();
                // 2 s from the file, not the 3 s default
                expect(first!).toBeGreaterThanOrEqual(1_900);
                expect(first!).toBeLessThan(2_900);
            } finally {
                stalling.closeAllConnections();
                await new Promise<void>((resolve) => stalling.close(() => resolve()));
            }
        });
    });

    it("lists --create-refund-ata in the usage text", () => {
        expect(KEYS_USAGE).toContain("--create-refund-ata");
    });

    it("leaves the env file untouched when the mnemonic is bad", async () => {
        const bad = ABANDON.replace("about", "abandon");
        const text = `BUGNET_TEST_PAYER_MNEMONIC="${bad}"\n`;
        const p = tmpEnv(text, 0o600);
        const io = captureIo();
        expect(await cliMain(["keys", "generate", "--env", p], {}, io)).toBe(1);
        expect(readFileSync(p, "utf8")).toBe(text);
    });

    it("rejects an unknown keys command and an unknown option", async () => {
        const unknown = captureIo();
        expect(await cliMain(["keys", "nope"], {}, unknown)).toBe(2);
        const option = captureIo();
        expect(await cliMain(["keys", "show", "--bogus"], {}, option)).toBe(2);
        expect(option.errText()).toContain("--bogus");
    });
});

describe("fundingPlan", () => {
    it("plans funding without ever creating a refund destination account", async () => {
        const txs = await fundingPlan(fundOptions());
        expect(instructionsOf(txs).map((i) => i.programAddress)).toEqual([
            SYSTEM_PROGRAM_ADDRESS,
            ATA_PROGRAM,
            TOKEN_PROGRAM,
        ]);
        expect(systemTransfers(txs)).toEqual([
            { source: testPayer.address, destination: feePayer.address, amount: 100_000_000n },
        ]);
        expect(tokenTransfers(txs)).toEqual([
            {
                source: await usdcAta(testPayer.address),
                destination: await usdcAta(refundSigner.address),
                authority: testPayer.address,
                amount: 5_000_000n,
            },
        ]);
        expect(feePayersOf(txs)).toEqual([testPayer.address]);
    });

    it("creates the recipient's account too when asked", async () => {
        const txs = await fundingPlan({ ...fundOptions(), createRecipientAta: true });
        const creates = instructionsOf(txs).filter((i) => i.programAddress === ATA_PROGRAM);
        expect(creates.map((i) => i.accounts![2]!.address)).toEqual([
            refundSigner.address,
            recipient.address,
        ]);
        expect(creates.every((i) => i.accounts![0]!.address === testPayer.address)).toBe(true);
    });

    it("refuses a first SOL transfer below rent exemption", async () => {
        await expect(fundingPlan({ ...fundOptions(), feePayerLamports: 650_239n })).rejects.toThrow(
            /650240/,
        );
    });

    it("accepts the smallest first transfer that is rent exempt", async () => {
        const txs = await fundingPlan({ ...fundOptions(), feePayerLamports: 650_240n });
        expect(systemTransfers(txs)[0]!.amount).toBe(650_240n);
    });

    it("tops up the fee payer only", async () => {
        const txs = await fundingPlan({
            ...fundOptions(),
            feePayerBalance: 50_000_000n,
            feePayerLamports: 60_000_000n,
            refundUsdcMicros: 0n,
        });
        expect(systemTransfers(txs)).toEqual([
            { source: testPayer.address, destination: feePayer.address, amount: 60_000_000n },
        ]);
        expect(instructionsOf(txs).map((i) => i.programAddress)).toEqual([
            SYSTEM_PROGRAM_ADDRESS,
            ATA_PROGRAM,
        ]);
        expect(tokenTransfers(txs)).toEqual([]);
    });

    it("sends no SOL when the amount is zero, even for an empty fee payer", async () => {
        const txs = await fundingPlan({ ...fundOptions(), feePayerLamports: 0n });
        expect(systemTransfers(txs)).toEqual([]);
        expect(tokenTransfers(txs)).toHaveLength(1);
    });
});

describe("drainPlan", () => {
    const balances = {
        feePayerLamports: 50_000_000n,
        refundLamports: 20_000_000n,
        recipientLamports: 10_000_000n,
        refundUsdc: 5_000_000n,
        recipientUsdc: 10_000n,
    };

    it("drains the full balances so each account ends at zero", async () => {
        const txs = await drainPlan(
            { testPayer, feePayer, refundSigner, recipient, closeAtas: false },
            balances,
        );
        expect(systemTransfers(txs)).toEqual([
            { source: feePayer.address, destination: testPayer.address, amount: 50_000_000n },
            { source: refundSigner.address, destination: testPayer.address, amount: 20_000_000n },
            { source: recipient.address, destination: testPayer.address, amount: 10_000_000n },
        ]);
        const toTestPayer = await usdcAta(testPayer.address);
        expect(tokenTransfers(txs)).toEqual([
            {
                source: await usdcAta(refundSigner.address),
                destination: toTestPayer,
                authority: refundSigner.address,
                amount: 5_000_000n,
            },
            {
                source: await usdcAta(recipient.address),
                destination: toTestPayer,
                authority: recipient.address,
                amount: 10_000n,
            },
        ]);
        expect(closes(txs)).toEqual([]);
        expect(feePayersOf(txs).every((a) => a === testPayer.address)).toBe(true);
    });

    it("moves all USDC before any SOL", async () => {
        const txs = await drainPlan(
            { testPayer, feePayer, refundSigner, recipient, closeAtas: false },
            balances,
        );
        const kinds = txs.map((t) => (systemTransfers([t]).length > 0 ? "sol" : "usdc"));
        expect(kinds).toEqual(["usdc", "usdc", "sol", "sol", "sol"]);
    });

    it("closes the emptied ATAs into the test payer with --close-atas", async () => {
        const txs = await drainPlan(
            { testPayer, feePayer, refundSigner, recipient, closeAtas: true },
            balances,
        );
        expect(closes(txs)).toEqual([
            {
                account: await usdcAta(refundSigner.address),
                destination: testPayer.address,
                authority: refundSigner.address,
            },
            {
                account: await usdcAta(recipient.address),
                destination: testPayer.address,
                authority: recipient.address,
            },
        ]);
        for (const tx of txs.filter((t) => closes([t]).length > 0)) {
            const order = tx.instructions.map((i) => i.data![0]);
            expect(order.indexOf(12)).toBeLessThan(order.indexOf(9));
        }
    });

    it("skips an absent recipient and empty balances", async () => {
        const txs = await drainPlan(
            { testPayer, feePayer, refundSigner, closeAtas: true },
            { ...balances, refundUsdc: 0n, refundLamports: 0n },
        );
        expect(systemTransfers(txs).map((t) => t.source)).toEqual([feePayer.address]);
        expect(tokenTransfers(txs)).toEqual([]);
        expect(closes(txs)).toEqual([]);
    });
});
