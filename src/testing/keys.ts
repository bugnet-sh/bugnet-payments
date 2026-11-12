import {
    createKeyPairSignerFromPrivateKeyBytes,
    getAddressEncoder,
    getBase58Decoder,
    type KeyPairSigner,
} from "@solana/kit";

export function testSigner(n: number): Promise<KeyPairSigner> {
    return createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(n));
}

// The 64-byte base58 secret of testSigner(seed), as a key variable holds it
export function testSecret(seed: number, signer: KeyPairSigner): string {
    const bytes = new Uint8Array(64);
    bytes.fill(seed, 0, 32);
    bytes.set(getAddressEncoder().encode(signer.address), 32);
    return getBase58Decoder().decode(bytes);
}
