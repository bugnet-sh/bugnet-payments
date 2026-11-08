import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
} from "@solana/kit";
import { getSetComputeUnitLimitInstructionDataDecoder } from "@solana-program/compute-budget";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cliMain } from "../cli.ts";
import { usdcAta } from "../solana/accounts.ts";
import { generateExportableKeypair } from "../solana/keys.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { TEST_ATA_RENT_LAMPORTS, TEST_RENT_EXEMPT_MIN_LAMPORTS } from "../testing/fake-rpc.ts";
import { seedAccount } from "../testing/x402.ts";
import { parseEnvText } from "./tool.ts";

interface Wallet {
    secret: string;
    address: string;
}

let server: Server;
let url: string;
let testPayer: Wallet;
let feePayer: Wallet;
let refund: Wallet;
let cold: Wallet;
let allowance: Wallet;
let otherKey: Wallet;
let db: TestDb;
let dir: string;
let config: string;
const sent: string[] = [];
let statusReply: () => unknown = () => ({
    context: { slot: 1 },
    value: [{ confirmationStatus: "confirmed", err: null, slot: 1, confirmations: 1 }],
});
let blockHeight = 100;
const lamports = new Map<string, number>();
const usdc = new Map<string, number>();
const tokenOwners = new Map<string, string>();

async function wallet(): Promise<Wallet> {
    const k = await generateExportableKeypair();
    return { secret: k.secretBase58, address: k.signer.address };
}

function result(method: string, params: unknown[]): unknown {
    const context = { slot: 1 };
    switch (method) {
        case "getMinimumBalanceForRentExemption":
            return params[0] === 0
                ? Number(TEST_RENT_EXEMPT_MIN_LAMPORTS)
                : Number(TEST_ATA_RENT_LAMPORTS);
        case "getBalance":
            return { context, value: lamports.get(params[0] as string) ?? 0 };
        case "getAccountInfo": {
            const amount = usdc.get(params[0] as string);
            if (amount === undefined) return { context, value: null };
            return {
                context,
                value: {
                    owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                    lamports: 2_039_280,
                    executable: false,
                    rentEpoch: 0,
                    space: 165,
                    data: {
                        program: "spl-token",
                        space: 165,
                        parsed: {
                            type: "account",
                            info: {
                                mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                                owner: tokenOwners.get(params[0] as string),
                                state: "initialized",
                                tokenAmount: { amount: String(amount), decimals: 6 },
                            },
                        },
                    },
                },
            };
        }
        case "getLatestBlockhash":
            return {
                context,
                value: {
                    blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
                    lastValidBlockHeight: 900,
                },
            };
        case "sendTransaction":
            sent.push(params[0] as string);
            return "5".repeat(87);
        case "getSignatureStatuses":
            return statusReply();
        case "getEpochInfo":
            return {
                absoluteSlot: 1,
                blockHeight,
                epoch: 0,
                slotIndex: 1,
                slotsInEpoch: 432_000,
                transactionCount: null,
            };
        default:
            throw new Error(`unscripted rpc method ${method}`);
    }
}

beforeAll(async () => {
    db = await testDb();
    dir = mkdtempSync(join(tmpdir(), "bn-pay-keys-cmd-"));
    [testPayer, feePayer, refund, cold, allowance, otherKey] = await Promise.all([
        wallet(),
        wallet(),
        wallet(),
        wallet(),
        wallet(),
        wallet(),
        wallet(),
        wallet(),
    ]);
    config = join(dir, "config.toml");
    writeFileSync(
        config,
        `[database]\nurl = "${db.url}"\n\n[solana]\nrecipient = "${cold.address}"\n\n[x402]\nallowance_wallet = "${allowance.address}"\n`,
    );
    server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const { id, method, params } = JSON.parse(body) as {
                id: number;
                method: string;
                params: unknown[];
            };
            res.setHeader("content-type", "application/json");
            try {
                res.end(JSON.stringify({ jsonrpc: "2.0", id, result: result(method, params) }));
            } catch (err) {
                const message = err instanceof Error ? err.message : "error";
                res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
            }
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/secret-api-key`;
    tokenOwners.set(String(await usdcAta(testPayer.address as never)), testPayer.address);
});
afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
    rmSync(dir, { recursive: true, force: true });
});

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
        BUGNET_TEST_PAYER_KEY: testPayer.secret,
        BUGNET_FEE_PAYER_KEY: feePayer.secret,
        BUGNET_REFUND_KEY: refund.secret,
        BUGNET_RECIPIENT_KEY: cold.secret,
        BUGNET_SOLANA_RPC_URL: url,
        ...over,
    };
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

function decodeSent() {
    return sent.map((wire) => getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
}

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SET_COMPUTE_UNIT_LIMIT = 2;

function computeUnitLimits(): number[] {
    return decodeSent().map((tx) => {
        const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
        if (msg.version !== 0) throw new Error(`expected a v0 message, got ${msg.version}`);
        const limits = msg.instructions.filter(
            (i) =>
                msg.staticAccounts[i.programAddressIndex] === COMPUTE_BUDGET &&
                i.data?.[0] === SET_COMPUTE_UNIT_LIMIT,
        );
        expect(limits).toHaveLength(1);
        return getSetComputeUnitLimitInstructionDataDecoder().decode(limits[0]!.data!).units;
    });
}

describe("keys over a stub RPC", () => {
    it("funds from the test payer in one confirmed transaction", async () => {
        sent.length = 0;
        lamports.clear();
        usdc.clear();
        lamports.set(testPayer.address, 5_000_000_000);
        usdc.set(String(await usdcAta(testPayer.address as never)), 50_000_000);
        const io = captureIo();
        const code = await cliMain(
            [
                "keys",
                "fund",
                "--fee-payer-lamports",
                "100000000",
                "--refund-usdc-micros",
                "5000000",
            ],
            env(),
            io,
        );
        expect(io.errText()).not.toContain("secret-api-key");
        expect(code).toBe(0);
        expect(sent).toHaveLength(1);
        const [tx] = decodeSent();
        expect(Object.keys(tx!.signatures)).toEqual([testPayer.address]);
        expect(io.outText()).toMatch(/^confirmed [1-9A-HJ-NP-Za-km-z]{86,88}$/);
    });

    it("creates the USDC account of the recipient address it is given, not the config's", async () => {
        sent.length = 0;
        lamports.clear();
        usdc.clear();
        lamports.set(testPayer.address, 5_000_000_000);
        const io = captureIo();
        const code = await cliMain(
            ["keys", "fund", "--create-recipient-ata", cold.address],
            env(),
            io,
        );
        expect(io.errText()).not.toContain('"level":"error"');
        expect(code).toBe(0);
        const ata = String(await usdcAta(cold.address as never));
        const [tx] = decodeSent();
        const accounts = getCompiledTransactionMessageDecoder().decode(
            tx!.messageBytes,
        ).staticAccounts;
        expect(accounts).toContain(ata);
        expect(io.outText()).toContain(`recipient USDC account ${ata} of owner ${cold.address}`);
    });

    it.each([
        [["--create-recipient-ata"], "--create-recipient-ata needs a value"],
        [["--create-recipient-ata", "not-an-address"], "--create-recipient-ata needs"],
    ])("refuses %j without a recipient address", async (flags, want) => {
        sent.length = 0;
        const io = captureIo();
        expect(await cliMain(["keys", "fund", ...flags], env(), io)).toBe(2);
        expect(io.errText()).toContain(want);
        expect(sent).toHaveLength(0);
    });

    it("refuses, naming the shortfall, when the test payer cannot cover the rents", async () => {
        sent.length = 0;
        lamports.clear();
        usdc.clear();
        lamports.set(testPayer.address, 100_000_000);
        const io = captureIo();
        const code = await cliMain(
            ["keys", "fund", "--fee-payer-lamports", "100000000", "--create-refund-ata"],
            env(),
            io,
        );
        expect(code).toBe(1);
        expect(sent).toHaveLength(0);
        expect(io.errText()).toMatch(/short by 2144280/);
        expect(io.errText()).not.toContain("secret-api-key");
    });

    it("refuses a transfer that would leave the test payer below rent exemption", async () => {
        sent.length = 0;
        lamports.clear();
        usdc.clear();
        lamports.set(testPayer.address, 100_000_000 + 1_488_440 + 5_600 + 650_239);
        const io = captureIo();
        const code = await cliMain(
            ["keys", "fund", "--fee-payer-lamports", "100000000", "--create-refund-ata"],
            env(),
            io,
        );
        expect(code).toBe(1);
        expect(sent).toHaveLength(0);
        expect(io.errText()).toMatch(/short by 1/);
    });

    it("refuses when the test payer holds too little USDC", async () => {
        sent.length = 0;
        lamports.clear();
        usdc.clear();
        lamports.set(testPayer.address, 5_000_000_000);
        const io = captureIo();
        const code = await cliMain(["keys", "fund", "--refund-usdc-micros", "1"], env(), io);
        expect(code).toBe(1);
        expect(sent).toHaveLength(0);
        expect(io.errText()).toMatch(/short by 1/);
    });

    it("drains every wallet with the test payer paying, closing ATAs on request", async () => {
        sent.length = 0;
        lamports.clear();
        usdc.clear();
        lamports.set(feePayer.address, 50_000_000);
        lamports.set(refund.address, 20_000_000);
        lamports.set(cold.address, 10_000_000);
        const refundAta = String(await usdcAta(refund.address as never));
        usdc.set(refundAta, 5_000_000);
        tokenOwners.set(refundAta, refund.address);
        const io = captureIo();
        expect(await cliMain(["keys", "drain", "--close-atas"], env(), io)).toBe(0);
        const txs = decodeSent();
        expect(txs).toHaveLength(4);
        for (const tx of txs) expect(Object.keys(tx.signatures)[0]).toBe(testPayer.address);
        expect(io.outText().split("\n")).toHaveLength(4);
    });

    it("gives 60_000 compute units to a transaction that creates a USDC account, 20_000 to others", async () => {
        sent.length = 0;
        lamports.clear();
        usdc.clear();
        lamports.set(testPayer.address, 5_000_000_000);
        const funded = captureIo();
        expect(
            await cliMain(
                ["keys", "fund", "--create-recipient-ata", cold.address, "--create-refund-ata"],
                env(),
                funded,
            ),
        ).toBe(0);
        expect(computeUnitLimits()).toEqual([60_000]);

        sent.length = 0;
        lamports.clear();
        usdc.clear();
        lamports.set(feePayer.address, 50_000_000);
        const refundAta = String(await usdcAta(refund.address as never));
        usdc.set(refundAta, 5_000_000);
        tokenOwners.set(refundAta, refund.address);
        expect(await cliMain(["keys", "drain", "--close-atas"], env(), captureIo())).toBe(0);
        expect(computeUnitLimits()).toEqual([20_000, 20_000]);
    });

    it("shows balances for each wallet", async () => {
        lamports.clear();
        usdc.clear();
        lamports.set(feePayer.address, 42);
        const io = captureIo();
        expect(await cliMain(["keys", "show"], env(), io)).toBe(0);
        expect(io.outText()).toContain(`fee_payer=${feePayer.address} sol=42 usdc=0`);
        expect(io.outText()).toContain(`recipient=${cold.address} sol=0 usdc=0`);
    });

    it("show lists allowance= with SOL and USDC", async () => {
        lamports.clear();
        usdc.clear();
        tokenOwners.clear();
        lamports.set(allowance.address, 0);
        usdc.set(String(await usdcAta(allowance.address as never)), 970_000);
        tokenOwners.set(String(await usdcAta(allowance.address as never)), allowance.address);
        const io = captureIo();
        expect(
            await cliMain(["keys", "show"], env({ BUGNET_ALLOWANCE_KEY: allowance.secret }), io),
        ).toBe(0);
        expect(io.outText()).toContain(`allowance=${allowance.address} sol=0 usdc=970000`);
    });

    it("fund --create-allowance-ata creates the account and moves no funds", async () => {
        sent.length = 0;
        lamports.clear();
        usdc.clear();
        lamports.set(testPayer.address, 5_000_000_000);
        const io = captureIo();
        const code = await cliMain(
            ["keys", "fund", "--create-allowance-ata"],
            env({ BUGNET_ALLOWANCE_KEY: allowance.secret }),
            io,
        );
        expect(io.errText()).not.toContain('"level":"error"');
        expect(code).toBe(0);
        const [tx] = decodeSent();
        const accounts = getCompiledTransactionMessageDecoder().decode(
            tx!.messageBytes,
        ).staticAccounts;
        expect(accounts).toContain(String(await usdcAta(allowance.address as never)));
    });

    it("fund --create-allowance-ata exits 1 without BUGNET_ALLOWANCE_KEY", async () => {
        sent.length = 0;
        const io = captureIo();
        expect(await cliMain(["keys", "fund", "--create-allowance-ata"], env(), io)).toBe(1);
        expect(io.errText()).toContain("BUGNET_ALLOWANCE_KEY must be set: run keys generate first");
        expect(sent).toHaveLength(0);
    });

    describe("drain --allowance", () => {
        afterEach(() => db.pool.query("delete from x402_accounts"));

        it("exits 1 while the hot ledger is not empty, before any key or RPC call", async () => {
            sent.length = 0;
            await seedAccount(db.pool, { state: "open" });
            const io = captureIo();
            expect(await cliMain(["keys", "drain", "--allowance", "-config", config], {}, io)).toBe(
                1,
            );
            expect(io.errText()).toContain("hot ledger not empty");
            expect(sent).toHaveLength(0);
        });

        it("exits 1 when the key is not allowance_wallet", async () => {
            sent.length = 0;
            const io = captureIo();
            expect(
                await cliMain(
                    ["keys", "drain", "--allowance", "-config", config],
                    env({ BUGNET_ALLOWANCE_KEY: otherKey.secret }),
                    io,
                ),
            ).toBe(1);
            expect(io.errText()).toContain("BUGNET_ALLOWANCE_KEY is not [x402] allowance_wallet");
            expect(sent).toHaveLength(0);
        });

        it("moves the hot USDC to the test payer, signed by both wallets", async () => {
            sent.length = 0;
            lamports.clear();
            usdc.clear();
            const hot = String(await usdcAta(allowance.address as never));
            usdc.set(hot, 970_000);
            tokenOwners.set(hot, allowance.address);
            const io = captureIo();
            expect(
                await cliMain(
                    ["keys", "drain", "--allowance", "-config", config],
                    env({ BUGNET_ALLOWANCE_KEY: allowance.secret }),
                    io,
                ),
            ).toBe(0);
            expect(io.outText()).toMatch(/^confirmed [1-9A-HJ-NP-Za-km-z]{86,88}$/);
            const [tx] = decodeSent();
            expect(Object.keys(tx!.signatures).sort()).toEqual(
                [testPayer.address, allowance.address].sort(),
            );
        });
    });

    describe("the test seller", () => {
        it("testseller writes its env file, prints both addresses and creates the ATA", async () => {
            sent.length = 0;
            lamports.clear();
            usdc.clear();
            lamports.set(testPayer.address, 5_000_000_000);
            const file = join(dir, "seller.env");
            const io = captureIo();
            expect(await cliMain(["keys", "testseller", "--env", file], env(), io)).toBe(0);
            const keys = parseEnvText(readFileSync(file, "utf8"));
            expect(io.outText()).toMatch(/^testseller_fee_payer=[1-9A-HJ-NP-Za-km-z]{32,44}$/m);
            expect(io.outText()).toMatch(/^testseller_payto=[1-9A-HJ-NP-Za-km-z]{32,44}$/m);
            for (const v of Object.values(keys)) {
                expect(io.outText() + io.errText()).not.toContain(v);
            }
            expect(decodeSent()).toHaveLength(1);
        });

        it("testseller refuses a Payments env file name", async () => {
            const io = captureIo();
            expect(
                await cliMain(["keys", "testseller", "--env", join(dir, ".env")], env(), io),
            ).toBe(1);
            expect(io.errText()).toContain("use a file of its own");
        });

        it("drain --testseller sends the seller's funds back from the file's keys", async () => {
            const file = join(dir, "seller-drain.env");
            const made = captureIo();
            lamports.clear();
            usdc.clear();
            lamports.set(testPayer.address, 5_000_000_000);
            await cliMain(["keys", "testseller", "--env", file], env(), made);
            const keys = parseEnvText(readFileSync(file, "utf8"));
            const payToAddress = /testseller_payto=(\S+)/.exec(made.outText())![1]!;
            const feeAddress = /testseller_fee_payer=(\S+)/.exec(made.outText())![1]!;
            sent.length = 0;
            lamports.set(feeAddress, 9_000_000);
            const ata = String(await usdcAta(payToAddress as never));
            usdc.set(ata, 150_000);
            tokenOwners.set(ata, payToAddress);
            const io = captureIo();
            expect(await cliMain(["keys", "drain", "--testseller", "--env", file], env(), io)).toBe(
                0,
            );
            expect(io.outText().split("\n")).toHaveLength(2);
            expect(decodeSent()).toHaveLength(2);
            for (const v of Object.values(keys)) {
                expect(io.outText() + io.errText()).not.toContain(v);
            }
        });

        it("drain --testseller leaves out the close of a missing ATA and says when nothing is left", async () => {
            const file = join(dir, "seller-missing-ata.env");
            const made = captureIo();
            lamports.clear();
            usdc.clear();
            tokenOwners.clear();
            lamports.set(testPayer.address, 5_000_000_000);
            await cliMain(["keys", "testseller", "--env", file], env(), made);
            const feeAddress = /testseller_fee_payer=(\S+)/.exec(made.outText())![1]!;
            const ata = String(
                await usdcAta(/testseller_payto=(\S+)/.exec(made.outText())![1]! as never),
            );
            tokenOwners.delete(ata);
            usdc.delete(ata);
            sent.length = 0;
            lamports.set(feeAddress, 9_000_000);
            const io = captureIo();
            expect(await cliMain(["keys", "drain", "--testseller", "--env", file], env(), io)).toBe(
                0,
            );
            expect(decodeSent()).toHaveLength(1);
            lamports.set(feeAddress, 0);
            sent.length = 0;
            const again = captureIo();
            expect(
                await cliMain(["keys", "drain", "--testseller", "--env", file], env(), again),
            ).toBe(0);
            expect(again.outText()).toContain("nothing to drain");
            expect(sent).toHaveLength(0);
        });
    });

    it.each([
        [["fund", "--create-allowance-atas"], 2],
        [["drain", "--allowances"], 2],
        [["drain", "--allowance", "--testseller"], 2],
        [["testseller"], 2],
        [["drain", "--testseller"], 2],
        [["drain", "--env", "x.env"], 2],
        [["drain", "--allowance", "--env", "x.env"], 2],
        [["drain", "--close-atas", "--allowance"], 2],
        [["drain", "--close-atas", "--testseller", "--env", "x.env"], 2],
    ])("keys %j exits %i before reaching a command", async (words, want) => {
        sent.length = 0;
        expect(await cliMain(["keys", ...words], env(), captureIo())).toBe(want);
        expect(sent).toHaveLength(0);
    });

    describe("confirmation by block height", () => {
        const fundArgs = ["keys", "fund", "--fee-payer-lamports", "100000000"];

        async function runFund() {
            sent.length = 0;
            lamports.clear();
            usdc.clear();
            lamports.set(testPayer.address, 5_000_000_000);
            const io = captureIo();
            const code = await cliMain([...fundArgs, "--create-refund-ata"], env(), io);
            return { code, io };
        }

        afterEach(() => {
            blockHeight = 100;
            statusReply = () => ({
                context: { slot: 1 },
                value: [{ confirmationStatus: "confirmed", err: null, slot: 1, confirmations: 1 }],
            });
        });

        it("waits through a late landing while the blockhash is still valid", async () => {
            let polls = 0;
            statusReply = () => ({
                context: { slot: 1 },
                value: [
                    ++polls < 3
                        ? null
                        : {
                              confirmationStatus: "finalized",
                              err: null,
                              slot: 1,
                              confirmations: null,
                          },
                ],
            });
            const { code, io } = await runFund();
            expect(code).toBe(0);
            expect(polls).toBe(3);
            expect(io.outText()).toMatch(/^confirmed /);
        });

        it("reports a transaction that failed on chain", async () => {
            statusReply = () => ({
                context: { slot: 1 },
                value: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, "x"] } }],
            });
            const { code, io } = await runFund();
            expect(code).toBe(1);
            expect(io.errText()).toContain("failed on chain");
        });

        it("says safe to retry only once the blockhash has expired with no status", async () => {
            statusReply = () => ({ context: { slot: 1 }, value: [null] });
            blockHeight = 901;
            const { code, io } = await runFund();
            expect(code).toBe(1);
            expect(io.errText()).toContain("not landed, safe to retry");
        });

        it("retries transient polling errors and still confirms", async () => {
            let polls = 0;
            statusReply = () => {
                if (++polls <= 2) throw new Error("rpc hiccup");
                return {
                    context: { slot: 1 },
                    value: [{ confirmationStatus: "confirmed", err: null, slot: 1 }],
                };
            };
            const { code } = await runFund();
            expect(code).toBe(0);
            expect(polls).toBe(3);
        });

        it("says unknown, check the explorer, when polling keeps failing", async () => {
            statusReply = () => {
                throw new Error("rpc down");
            };
            const { code, io } = await runFund();
            expect(code).toBe(1);
            expect(io.errText()).toContain("unknown, check the explorer before retrying");
            expect(io.errText()).not.toContain("safe to retry");
        }, 20_000);
    });
});
