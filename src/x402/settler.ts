import { AsyncLocalStorage } from "node:async_hooks";
import {
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getSignatureFromTransaction,
    getTransactionDecoder,
    type KeyPairSigner,
} from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import {
    type FacilitatorSvmSigner,
    toFacilitatorSvmSigner,
    transactionMessageHash,
} from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import type { Log } from "../log.ts";
import type { BlockhashCache } from "../solana/blockhash.ts";
import { SOLANA_MAINNET, UNKNOWN_BLOCKHASH_MARGIN } from "../solana/constants.ts";
import type { SolanaRpc } from "../solana/rpc.ts";

export interface BroadcastRecord {
    messageHash: string;
    signature: string;
    blockhash: string;
    lastValidBlockHeight: bigint;
}

export type SettleFailure =
    "commit_conflict" | "block_height_unavailable" | "commit_failed" | "rpc_unavailable";

export interface SettleAttempt {
    messageHash: string;
    commit(r: BroadcastRecord): Promise<void>;
    committed: boolean;
    failure?: SettleFailure;
}

export interface FeeCaps {
    maxComputeUnits: number;
    maxPriorityFeeMicroLamports: number;
    maxRequiredSignatures: number;
}

export interface Settler {
    readonly feePayer: string;
    readonly transactionVersions: readonly (0 | 1)[];
    settle(
        attempt: SettleAttempt,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ): Promise<SettleResponse>;
}

interface RecordingDeps {
    als: AsyncLocalStorage<SettleAttempt>;
    rpc: SolanaRpc;
    hints: BlockhashCache;
    log: Log;
}

function isUniqueViolation(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

async function lastValidBlockHeightOf(
    blockhash: string,
    attempt: SettleAttempt,
    d: RecordingDeps,
): Promise<bigint> {
    const known = d.hints.lastValidBlockHeightOf(blockhash);
    if (known !== undefined) return known;
    try {
        const height = await d.rpc.getBlockHeight({ commitment: "confirmed" }).send();
        return height + UNKNOWN_BLOCKHASH_MARGIN;
    } catch (err) {
        attempt.failure = "block_height_unavailable";
        throw err;
    }
}

async function commitRecord(attempt: SettleAttempt, record: BroadcastRecord): Promise<void> {
    try {
        await attempt.commit(record);
    } catch (err) {
        attempt.failure = isUniqueViolation(err) ? "commit_conflict" : "commit_failed";
        throw err;
    }
    attempt.committed = true;
}

async function recordFor(
    wire: string,
    attempt: SettleAttempt,
    d: RecordingDeps,
): Promise<BroadcastRecord> {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    if (transactionMessageHash(tx) !== attempt.messageHash) {
        throw new Error("broadcast message is not the attempt's");
    }
    const { lifetimeToken } = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    return {
        messageHash: attempt.messageHash,
        signature: getSignatureFromTransaction(tx),
        blockhash: lifetimeToken,
        lastValidBlockHeight: await lastValidBlockHeightOf(lifetimeToken, attempt, d),
    };
}

export function recordingSigner(
    inner: FacilitatorSvmSigner,
    d: RecordingDeps,
): FacilitatorSvmSigner {
    const sendTransaction = async (wire: string, network: string): Promise<string> => {
        const attempt = d.als.getStore();
        if (attempt === undefined) throw new Error("broadcast outside an attempt");
        try {
            const record = await recordFor(wire, attempt, d);
            await commitRecord(attempt, record);
            const answered = await inner.sendTransaction(wire, network);
            if (answered !== record.signature) {
                d.log.warn("rpc answered another signature", {
                    signature: record.signature,
                    answered,
                });
            }
            return record.signature;
        } catch (err) {
            const failure = attempt.failure ?? "rpc_failed";
            d.log.error("broadcast failed", {
                messageHash: attempt.messageHash,
                failure,
                committed: attempt.committed,
                err,
            });
            // eslint-disable-next-line preserve-caught-error -- a cause would print RPC detail
            throw new Error(failure);
        }
    };
    return { ...inner, sendTransaction };
}

interface PendingCall {
    send(options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

/**
 * Every call of a settle gets its own `solana.rpc_timeout`: the order's row lock and a pool client
 * are held until the settling COMMIT, so a stalled RPC must fail rather than hold them. A failed
 * call before that COMMIT marks the attempt, so the payer is told to retry, not that the payment
 * is invalid.
 */
function deadlineRpc(
    rpc: SolanaRpc,
    timeoutMs: number,
    als: AsyncLocalStorage<SettleAttempt>,
): SolanaRpc {
    return new Proxy(rpc, {
        get(target, prop) {
            const method: unknown = Reflect.get(target, prop);
            if (typeof method !== "function") return method;
            return (...args: unknown[]): PendingCall => {
                const pending = (method as (...a: unknown[]) => PendingCall).apply(target, args);
                return {
                    async send(options = {}) {
                        const timeout = AbortSignal.timeout(timeoutMs);
                        const abortSignal = options.abortSignal
                            ? AbortSignal.any([options.abortSignal, timeout])
                            : timeout;
                        try {
                            return await pending.send({ ...options, abortSignal });
                        } catch (err) {
                            const attempt = als.getStore();
                            if (attempt && !attempt.committed && attempt.failure === undefined) {
                                attempt.failure = "rpc_unavailable";
                            }
                            throw err;
                        }
                    },
                };
            };
        },
    });
}

export function createSettler(o: {
    feePayer: KeyPairSigner;
    rpc: SolanaRpc;
    hints: BlockhashCache;
    caps: FeeCaps;
    transactionVersions: readonly (0 | 1)[];
    rpcTimeoutMs: number;
    log: Log;
}): Settler {
    const als = new AsyncLocalStorage<SettleAttempt>();
    const rpc = deadlineRpc(o.rpc, o.rpcTimeoutMs, als);
    // A kit RPC is a Proxy without a has trap, so x402 would misread it as a per-network map
    const inner = toFacilitatorSvmSigner(o.feePayer, { [SOLANA_MAINNET]: rpc });
    const signer = recordingSigner(inner, { als, rpc, hints: o.hints, log: o.log });
    const scheme = new ExactSvmScheme(signer, undefined, {
        ...o.caps,
        transactionVersions: o.transactionVersions,
        enableSmartWalletVerification: false,
    });
    const facilitator = new x402Facilitator().register(SOLANA_MAINNET, scheme);
    return {
        feePayer: o.feePayer.address,
        transactionVersions: o.transactionVersions,
        settle: (attempt, payload, requirements) =>
            als.run(attempt, () => facilitator.settle(payload, requirements)),
    };
}
