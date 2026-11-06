import { createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from "@solana/kit";

export function testSigner(n: number): Promise<KeyPairSigner> {
    return createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(n));
}
