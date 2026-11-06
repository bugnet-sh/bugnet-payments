import {
    createKeyPairSignerFromPrivateKeyBytes,
    generateKeyPairSigner,
    getBase58Decoder,
    getBase58Encoder,
    type KeyPairSigner,
} from "@solana/kit";

function parseBytes(secret: string): Uint8Array {
    const trimmed = secret.trim();
    if (trimmed.startsWith("[")) {
        const arr: unknown = JSON.parse(trimmed);
        if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
            throw new Error("not a byte array");
        }
        return Uint8Array.from(arr as number[]);
    }
    return Uint8Array.from(getBase58Encoder().encode(trimmed));
}

export async function loadKeypair(secret: string, name: string): Promise<KeyPairSigner> {
    let bytes: Uint8Array;
    try {
        bytes = parseBytes(secret);
    } catch {
        throw new Error(`${name}: not a base58 string or JSON byte array`);
    }
    if (bytes.length === 32) {
        return createKeyPairSignerFromPrivateKeyBytes(bytes);
    }
    if (bytes.length !== 64) {
        throw new Error(`${name}: expected 32 or 64 bytes, got ${bytes.length}`);
    }
    const signer = await createKeyPairSignerFromPrivateKeyBytes(bytes.slice(0, 32));
    if (signer.address !== getBase58Decoder().decode(bytes.slice(32))) {
        throw new Error(`${name}: public half does not match the secret half`);
    }
    return signer;
}

export async function generateExportableKeypair(): Promise<{
    signer: KeyPairSigner;
    secretBase58: string;
}> {
    const signer = await generateKeyPairSigner(true);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", signer.keyPair.privateKey));
    const publicKey = new Uint8Array(
        await crypto.subtle.exportKey("raw", signer.keyPair.publicKey),
    );
    const secret = new Uint8Array(64);
    secret.set(pkcs8.slice(16), 0);
    secret.set(publicKey, 32);
    return { signer, secretBase58: getBase58Decoder().decode(secret) };
}
