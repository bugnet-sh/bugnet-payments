import { createHmac } from "node:crypto";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from "@solana/kit";
import { ConfigError } from "../config.ts";
import { loadKeypair } from "../solana/keys.ts";

const HARDENED = 0x80000000;
const KEY_VAR = "BUGNET_TEST_PAYER_KEY";
const MNEMONIC_VAR = "BUGNET_TEST_PAYER_MNEMONIC";
const INDEX_VAR = "BUGNET_TEST_PAYER_ACCOUNT_INDEX";

// Pasted phrases carry commas, periods, quotes and double spaces that BIP39 would reject
export function normalizeMnemonic(text: string): string {
    return text
        .split(/\s+/)
        .map((w) => w.toLowerCase().replace(/[^a-z]/g, ""))
        .filter((w) => w !== "")
        .join(" ");
}

// SLIP-0010 ed25519 derivation, where every level must be hardened
function slip10(seed: Uint8Array, path: readonly number[]): Uint8Array {
    let digest = createHmac("sha512", "ed25519 seed").update(seed).digest();
    for (const index of path) {
        const data = Buffer.alloc(37);
        digest.copy(data, 1, 0, 32);
        data.writeUInt32BE((index | HARDENED) >>> 0, 33);
        digest = createHmac("sha512", digest.subarray(32)).update(data).digest();
    }
    return Uint8Array.from(digest.subarray(0, 32));
}

// Phantom's path m/44'/501'/account'/0'
export async function deriveSolanaKey(mnemonic: string, account: number): Promise<KeyPairSigner> {
    if (!validateMnemonic(mnemonic, wordlist)) throw new Error("not a valid BIP39 phrase");
    const seed = mnemonicToSeedSync(mnemonic);
    return createKeyPairSignerFromPrivateKeyBytes(slip10(seed, [44, 501, account, 0]));
}

function accountIndex(raw: string | undefined): number {
    const text = (raw ?? "").trim();
    if (text === "") return 0;
    if (!/^[0-9]{1,9}$/.test(text)) {
        throw new ConfigError(`${INDEX_VAR}: expected a whole number of at most 9 digits`);
    }
    return Number(text);
}

export async function loadTestPayer(env: NodeJS.ProcessEnv): Promise<KeyPairSigner | null> {
    const key = (env[KEY_VAR] ?? "").trim();
    if (key !== "") {
        try {
            return await loadKeypair(key, KEY_VAR);
        } catch (err) {
            throw new ConfigError(err instanceof Error ? err.message : KEY_VAR);
        }
    }
    const phrase = normalizeMnemonic(env[MNEMONIC_VAR] ?? "");
    if (phrase === "") return null;
    const index = accountIndex(env[INDEX_VAR]);
    if (!validateMnemonic(phrase, wordlist)) {
        throw new ConfigError(`${MNEMONIC_VAR}: failed the BIP39 checksum`);
    }
    return deriveSolanaKey(phrase, index);
}
