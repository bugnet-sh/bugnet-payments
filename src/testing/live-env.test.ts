import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingDepositEnv, missingLiveEnv, missingX402Env } from "./live-env.ts";

const PAYER = "BUGNET_TEST_PAYER_KEY or BUGNET_TEST_PAYER_MNEMONIC";
const RPC = "BUGNET_SOLANA_RPC_URLS or BUGNET_SOLANA_RPC_URL";

function fullEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        BUGNET_SOLANA_RPC_URL: "https://rpc.example",
        BUGNET_FEE_PAYER_KEY: "fee",
        BUGNET_REFUND_KEY: "refund",
        BUGNET_RECIPIENT_KEY: "recipient",
        BUGNET_ORDER_PRIVATE_KEY: "order",
        BUGNET_CLAIM_KEY: "claim",
        BUGNET_PAYMENTS_TOKEN: "token",
        BUGNET_TEST_PAYER_KEY: "payer",
        BUGNET_TEST_PAYER_MNEMONIC: "",
        BUGNET_ALLOWANCE_KEY: "allowance",
        BUGNET_SPIKE_SELLER_URL: "https://s.example/x",
        ...over,
    };
}

describe("missingLiveEnv", () => {
    it("names every missing live variable", () => {
        expect(missingLiveEnv({ BUGNET_TEST_PAYER_KEY: "" })).toEqual(
            expect.arrayContaining([RPC, "BUGNET_RECIPIENT_KEY", PAYER]),
        );
        expect(
            missingLiveEnv(fullEnv({ BUGNET_TEST_PAYER_KEY: "", BUGNET_TEST_PAYER_MNEMONIC: "w" })),
        ).toEqual([]);
    });

    it("lists every name for an empty environment", () => {
        expect(missingLiveEnv({})).toEqual([
            RPC,
            "BUGNET_FEE_PAYER_KEY",
            "BUGNET_REFUND_KEY",
            "BUGNET_RECIPIENT_KEY",
            "BUGNET_ORDER_PRIVATE_KEY",
            "BUGNET_CLAIM_KEY",
            "BUGNET_PAYMENTS_TOKEN",
            PAYER,
        ]);
    });

    it("live env takes either RPC variable", () => {
        const list = fullEnv({
            BUGNET_SOLANA_RPC_URL: "",
            BUGNET_SOLANA_RPC_URLS: "https://a.example/,https://b.example/",
        });
        expect(missingLiveEnv(list)).toEqual([]);
        expect(missingLiveEnv(fullEnv({ BUGNET_SOLANA_RPC_URL: " " }))).toEqual([RPC]);
    });

    it("accepts the test payer key without a mnemonic", () => {
        expect(missingLiveEnv(fullEnv())).toEqual([]);
    });

    it("counts a whitespace-only value as missing", () => {
        expect(
            missingLiveEnv(fullEnv({ BUGNET_CLAIM_KEY: "  ", BUGNET_TEST_PAYER_KEY: " " })),
        ).toEqual(["BUGNET_CLAIM_KEY", PAYER]);
    });

    it("asks for no x402 variable or file for the v1 live test", () => {
        const env = fullEnv({ BUGNET_ALLOWANCE_KEY: "", BUGNET_SPIKE_SELLER_URL: "" });
        expect(missingLiveEnv(env)).toEqual([]);
    });

    it("needs the allowance key, the spike seller and the test seller file", () => {
        const env = fullEnv({ BUGNET_ALLOWANCE_KEY: "", BUGNET_SPIKE_SELLER_URL: "" });
        const file = join(homedir(), ".config/bugnet/testseller.env");
        expect(missingX402Env(env, () => false)).toEqual(
            expect.arrayContaining([
                "BUGNET_ALLOWANCE_KEY",
                "BUGNET_SPIKE_SELLER_URL",
                `${file} missing`,
            ]),
        );
        expect(
            missingX402Env(
                fullEnv({ BUGNET_TESTSELLER_ENV: "/tmp/ts.env" }),
                (p) => p !== "/tmp/ts.env",
            ),
        ).toContain("/tmp/ts.env missing");
        expect(
            missingX402Env(
                fullEnv({
                    BUGNET_ALLOWANCE_KEY: "k",
                    BUGNET_SPIKE_SELLER_URL: "https://s.example/x",
                }),
                () => true,
            ),
        ).toEqual([]);
    });
});

describe("missingDepositEnv", () => {
    it("missingDepositEnv names the seed", () => {
        expect(missingDepositEnv({})).toEqual(["BUGNET_DEPOSIT_SEED"]);
        expect(missingDepositEnv({ BUGNET_DEPOSIT_SEED: " " })).toEqual(["BUGNET_DEPOSIT_SEED"]);
        expect(missingDepositEnv({ BUGNET_DEPOSIT_SEED: "seed" })).toEqual([]);
        // The v1 and x402 live files never ask for it
        expect(missingLiveEnv(fullEnv())).toEqual([]);
    });
});
