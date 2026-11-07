import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBase58Encoder, type Instruction, type KeyPairSigner } from "@solana/kit";
import {
    SYSTEM_PROGRAM_ADDRESS,
    getTransferSolInstructionDataDecoder,
} from "@solana-program/system";
import {
    getCloseAccountInstructionDataDecoder,
    getTransferCheckedInstructionDataDecoder,
} from "@solana-program/token";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliMain } from "../cli.ts";
import { usdcAta } from "../solana/accounts.ts";
import { generateExportableKeypair } from "../solana/keys.ts";
import { TEST_RENT_EXEMPT_MIN_LAMPORTS } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { KEYS_USAGE } from "./commands.ts";
import { drainPlan, fundingPlan, type PlannedTx, parseEnvText } from "./tool.ts";

const ABANDON =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

let dir: string;
let testPayer: KeyPairSigner;
let feePayer: KeyPairSigner;
let refundSigner: KeyPairSigner;
let recipient: KeyPairSigner;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "bn-pay-keys-"));
    [testPayer, feePayer, refundSigner, recipient] = await Promise.all([
        testSigner(1),
        testSigner(2),
        testSigner(3),
        testSigner(4),
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

    it("adds only the three service secrets to a .env shaped like the founder's", async () => {
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
            "added=BUGNET_ORDER_PRIVATE_KEY,BUGNET_CLAIM_KEY,BUGNET_PAYMENTS_TOKEN",
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

describe("keys commands without settings", () => {
    const missingConfig = ["-config", join(tmpdir(), "bn-pay-no-such-file.toml")];

    it("pubkey, show --no-balances and generate never parse TOML", async () => {
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
