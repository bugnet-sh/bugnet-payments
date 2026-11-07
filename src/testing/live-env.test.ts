import { describe, expect, it } from "vitest";
import { missingLiveEnv } from "./live-env.ts";

const PAYER = "BUGNET_TEST_PAYER_KEY or BUGNET_TEST_PAYER_MNEMONIC";

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
        ...over,
    };
}

describe("missingLiveEnv", () => {
    it("names every missing live variable", () => {
        expect(missingLiveEnv({ BUGNET_TEST_PAYER_KEY: "" })).toEqual(
            expect.arrayContaining(["BUGNET_SOLANA_RPC_URL", "BUGNET_RECIPIENT_KEY", PAYER]),
        );
        expect(
            missingLiveEnv(fullEnv({ BUGNET_TEST_PAYER_KEY: "", BUGNET_TEST_PAYER_MNEMONIC: "w" })),
        ).toEqual([]);
    });

    it("lists all eight names for an empty environment", () => {
        expect(missingLiveEnv({})).toEqual([
            "BUGNET_SOLANA_RPC_URL",
            "BUGNET_FEE_PAYER_KEY",
            "BUGNET_REFUND_KEY",
            "BUGNET_RECIPIENT_KEY",
            "BUGNET_ORDER_PRIVATE_KEY",
            "BUGNET_CLAIM_KEY",
            "BUGNET_PAYMENTS_TOKEN",
            PAYER,
        ]);
    });

    it("accepts the test payer key without a mnemonic", () => {
        expect(missingLiveEnv(fullEnv())).toEqual([]);
    });

    it("counts a whitespace-only value as missing", () => {
        expect(
            missingLiveEnv(fullEnv({ BUGNET_CLAIM_KEY: "  ", BUGNET_TEST_PAYER_KEY: " " })),
        ).toEqual(["BUGNET_CLAIM_KEY", PAYER]);
    });
});
