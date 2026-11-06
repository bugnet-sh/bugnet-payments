import {
    getBase58Decoder,
    getBase64Encoder,
    getSignatureFromTransaction,
    getTransactionDecoder,
} from "@solana/kit";
import type { SolanaRpc } from "../solana/rpc.ts";

export const TEST_BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(1));
export const TEST_LVBH = 900n;
export const TEST_RENT_EXEMPT_MIN_LAMPORTS = 650_240n;
export const TEST_ATA_RENT_LAMPORTS = 1_488_440n;

type Handler = (...args: never[]) => unknown;

export interface FakeRpcScript {
    getLatestBlockhash: Handler;
    getBlockHeight: Handler;
    getBalance: Handler;
    getAccountInfo: Handler;
    getTokenAccountBalance: Handler;
    getSignatureStatuses: Handler;
    getTransaction: Handler;
    getSignaturesForAddress: Handler;
    getMinimumBalanceForRentExemption: Handler;
    sendTransaction: Handler;
    simulateTransaction: Handler;
}

export type FakeRpc = SolanaRpc & { calls: Record<string, number>; sent: string[] };

export function createFakeRpc(script: Partial<FakeRpcScript> = {}): FakeRpc {
    const calls: Record<string, number> = {};
    const sent: string[] = [];
    const defaults: FakeRpcScript = {
        getLatestBlockhash: () => ({
            value: { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: TEST_LVBH },
        }),
        getBlockHeight: () => 1000n,
        getBalance: () => ({ value: 1_000_000_000n }),
        getAccountInfo: () => ({ value: null }),
        getTokenAccountBalance: () => ({
            value: { amount: "1000000000", decimals: 6, uiAmount: 1000, uiAmountString: "1000" },
        }),
        getSignatureStatuses: () => ({
            value: [{ confirmationStatus: "confirmed", err: null, slot: 1n, confirmations: 1n }],
        }),
        getTransaction: () => null,
        getSignaturesForAddress: () => [],
        getMinimumBalanceForRentExemption: (space: bigint) =>
            space === 0n ? TEST_RENT_EXEMPT_MIN_LAMPORTS : TEST_ATA_RENT_LAMPORTS,
        sendTransaction: (wire: string) => {
            sent.push(wire);
            return getSignatureFromTransaction(
                getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
            );
        },
        simulateTransaction: () => ({ value: { err: null, logs: [], unitsConsumed: 13_000n } }),
    };
    const handlers: FakeRpcScript = { ...defaults, ...script };
    const rpc: Record<string, unknown> = { calls, sent };
    for (const name of Object.keys(handlers) as (keyof FakeRpcScript)[]) {
        calls[name] = 0;
        rpc[name] = (...args: unknown[]) => ({
            send: async () => {
                calls[name]!++;
                return (handlers[name] as (...a: unknown[]) => unknown)(...args);
            },
        });
    }
    return rpc as unknown as FakeRpc;
}
