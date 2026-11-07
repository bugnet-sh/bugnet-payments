import { describe, expect, it } from "vitest";
import { ConfigError } from "../config.ts";
import { generateExportableKeypair } from "../solana/keys.ts";
import { deriveSolanaKey, loadTestPayer, normalizeMnemonic } from "./test-payer.ts";

// The public BIP39 test phrase
const ABANDON =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ACCOUNT_0 = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const ACCOUNT_1 = "Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb";

describe("test payer", () => {
    it("derives Phantom accounts 0 and 1", async () => {
        expect((await deriveSolanaKey(ABANDON, 0)).address).toBe(ACCOUNT_0);
        expect((await deriveSolanaKey(ABANDON, 1)).address).toBe(ACCOUNT_1);
    });

    it("normalizes stray punctuation before the checksum", async () => {
        const typed =
            "abandon, abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon  about.";
        expect(normalizeMnemonic(typed)).toBe(ABANDON);
        const payer = await loadTestPayer({
            BUGNET_TEST_PAYER_KEY: "",
            BUGNET_TEST_PAYER_MNEMONIC: typed,
        });
        expect(payer!.address).toBe(ACCOUNT_0);
    });

    it("uses the account index and prefers a non-empty key", async () => {
        const indexed = await loadTestPayer({
            BUGNET_TEST_PAYER_MNEMONIC: ABANDON,
            BUGNET_TEST_PAYER_ACCOUNT_INDEX: "1",
        });
        expect(indexed!.address).toBe(ACCOUNT_1);
        const { signer, secretBase58 } = await generateExportableKeypair();
        const keyed = await loadTestPayer({
            BUGNET_TEST_PAYER_KEY: secretBase58,
            BUGNET_TEST_PAYER_MNEMONIC: ABANDON,
        });
        expect(keyed!.address).toBe(signer.address);
        expect(await loadTestPayer({ BUGNET_TEST_PAYER_KEY: "" })).toBeNull();
    });

    it("names the variable, never a word, on a bad checksum", async () => {
        const bad = ABANDON.replace("about", "abandon");
        await expect(loadTestPayer({ BUGNET_TEST_PAYER_MNEMONIC: bad })).rejects.toThrow(
            /BUGNET_TEST_PAYER_MNEMONIC/,
        );
        await expect(loadTestPayer({ BUGNET_TEST_PAYER_MNEMONIC: bad })).rejects.not.toThrow(
            /abandon/,
        );
    });

    it("names the index variable on a bad index", async () => {
        const env = { BUGNET_TEST_PAYER_MNEMONIC: ABANDON, BUGNET_TEST_PAYER_ACCOUNT_INDEX: "-1" };
        await expect(loadTestPayer(env)).rejects.toThrow(ConfigError);
        await expect(loadTestPayer(env)).rejects.toThrow(/BUGNET_TEST_PAYER_ACCOUNT_INDEX/);
    });

    it("names the key variable, not the key, when it does not parse", async () => {
        await expect(loadTestPayer({ BUGNET_TEST_PAYER_KEY: "0OIl" })).rejects.toThrow(
            /BUGNET_TEST_PAYER_KEY/,
        );
    });
});
