import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getSignatureFromTransaction,
    getTransactionDecoder,
    partiallySignTransaction,
    type Transaction,
} from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { type FacilitatorSvmSigner, transactionMessageHash } from "@x402/svm";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { jsonLog, type Log, memoryLog, silentLog } from "../log.ts";
import { BlockhashCache } from "../solana/blockhash.ts";
import { SOLANA_MAINNET } from "../solana/constants.ts";
import { createRpc } from "../solana/rpc.ts";
import { createFakeRpc, type FakeRpc, TEST_BLOCKHASH, TEST_LVBH } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { signedPayment } from "../testing/payment.ts";
import { type ChallengeContext, requirementsFor } from "./challenge.ts";
import {
    type BroadcastRecord,
    createSettler,
    type FeeCaps,
    recordingSigner,
    type SettleAttempt,
} from "./settler.ts";

const payer = await testSigner(3);
const feePayer = await testSigner(5);
const ctx: ChallengeContext = {
    publicUrl: "https://pay.bugnet.sh",
    recipient: (await testSigner(1)).address,
    allowanceWallet: (await testSigner(11)).address,
    feePayer: feePayer.address,
    transactionVersions: [0],
};
const requirements = requirementsFor(
    { id: "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa", amountMicros: 10_000, payInto: "cold" },
    ctx,
);
const reqWithHints: PaymentRequirements = {
    ...requirements,
    extra: {
        ...requirements.extra,
        recentBlockhash: TEST_BLOCKHASH,
        lastValidBlockHeight: String(TEST_LVBH),
    },
};
const caps: FeeCaps = {
    maxComputeUnits: 50_000,
    maxPriorityFeeMicroLamports: 10_000,
    maxRequiredSignatures: 2,
};

function decodeWire(wire: string): Transaction {
    return getTransactionDecoder().decode(getBase64Encoder().encode(wire));
}

const payload = await signedPayment(reqWithHints, payer);
const payerSigned = decodeWire((payload.payload as { transaction: string }).transaction);
const msgHash = transactionMessageHash(payerSigned);
const fullySigned = await partiallySignTransaction([feePayer.keyPair], payerSigned);
const wire = getBase64EncodedWireTransaction(fullySigned);
const wireSignature = getSignatureFromTransaction(fullySigned);

const hints = new BlockhashCache(createFakeRpc(), 8_000);
await hints.latest();

let records: BroadcastRecord[] = [];

function attempt(
    messageHash: string,
    commit: (r: BroadcastRecord) => Promise<void> = async (r) => {
        records.push(r);
    },
): SettleAttempt {
    return { messageHash, commit, committed: false };
}

function settler(rpc: FakeRpc, cache: BlockhashCache = hints, log: Log = silentLog) {
    return createSettler({
        feePayer,
        rpc,
        hints: cache,
        caps,
        transactionVersions: [0],
        rpcTimeoutMs: 10_000,
        log,
    });
}

function innerStub(send: FacilitatorSvmSigner["sendTransaction"]): FacilitatorSvmSigner {
    const unused = async (): Promise<never> => {
        throw new Error("not used by these tests");
    };
    return {
        getAddresses: () => [feePayer.address],
        signTransaction: unused,
        simulateTransaction: unused,
        sendTransaction: send,
        confirmTransaction: unused,
    };
}

interface JsonRpcStub {
    port: number;
    calls: Record<string, number>;
    close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
}

function stubAnswer(method: string, params: unknown[]): unknown {
    switch (method) {
        case "simulateTransaction":
            return {
                context: { slot: 1 },
                value: { err: null, logs: [], accounts: null, unitsConsumed: 13_000 },
            };
        case "sendTransaction":
            return getSignatureFromTransaction(decodeWire(params[0] as string));
        case "getSignatureStatuses":
            return {
                context: { slot: 1 },
                value: [
                    {
                        slot: 1,
                        confirmations: 1,
                        err: null,
                        status: { Ok: null },
                        confirmationStatus: "confirmed",
                    },
                ],
            };
        case "getBlockHeight":
            return 1000;
        default:
            return undefined;
    }
}

async function startJsonRpcStub(): Promise<JsonRpcStub> {
    const calls: Record<string, number> = {};
    const server = createServer((req, res) => {
        void readBody(req).then((body) => {
            const { id, method, params } = JSON.parse(body) as {
                id: unknown;
                method: string;
                params: unknown[];
            };
            calls[method] = (calls[method] ?? 0) + 1;
            const result = stubAnswer(method, params);
            const answer =
                result === undefined
                    ? { jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method}` } }
                    : { jsonrpc: "2.0", id, result };
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(answer));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: (server.address() as AddressInfo).port,
        calls,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

describe("settler", () => {
    let consoleError: MockInstance<typeof console.error>;
    beforeEach(() => {
        records = [];
        consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("commits before it broadcasts", async () => {
        const rpc = createFakeRpc();
        const a = attempt(msgHash, async (r) => {
            expect(rpc.sent).toHaveLength(0);
            records.push(r);
        });
        const res = await settler(rpc).settle(a, payload, requirements);
        expect(res.success).toBe(true);
        expect(rpc.sent).toHaveLength(1);
        expect(res.transaction).toBe(records[0]!.signature);
        expect(records[0]!.messageHash).toBe(msgHash);
        expect(records[0]!.blockhash).toBe(TEST_BLOCKHASH);
        expect(records[0]!.lastValidBlockHeight).toBe(TEST_LVBH);
        expect(a.committed).toBe(true);
        expect(rpc.calls.getBlockHeight).toBe(0);
    });

    it("sends nothing when the commit fails, and names the cause", async () => {
        const rpc = createFakeRpc();
        const a = attempt(msgHash, async () => {
            throw Object.assign(new Error("dup"), { code: "23505" });
        });
        const res = await settler(rpc).settle(a, payload, requirements);
        expect(res.success).toBe(false);
        expect(res.transaction).toBe("");
        expect(a).toMatchObject({ committed: false, failure: "commit_conflict" });
        expect(rpc.calls.sendTransaction ?? 0).toBe(0);
        expect(consoleError).toHaveBeenCalledWith(
            "Failed to send transaction:",
            new Error("commit_conflict"),
        );
    });

    it("names commit_failed for any other commit error", async () => {
        const rpc = createFakeRpc();
        const a = attempt(msgHash, async () => {
            throw new Error("connection terminated");
        });
        const res = await settler(rpc).settle(a, payload, requirements);
        expect(res.success).toBe(false);
        expect(a).toMatchObject({ committed: false, failure: "commit_failed" });
        expect(rpc.calls.sendTransaction).toBe(0);
    });

    it("settles through a real kit RPC", async () => {
        const stub = await startJsonRpcStub();
        try {
            const s = createSettler({
                feePayer,
                rpc: createRpc(`http://127.0.0.1:${stub.port}`),
                hints,
                caps,
                transactionVersions: [0],
                rpcTimeoutMs: 10_000,
                log: silentLog,
            });
            const res = await s.settle(attempt(msgHash), payload, requirements);
            expect(res.success).toBe(true);
            expect(res.transaction).toBe(wireSignature);
            expect(stub.calls.simulateTransaction).toBe(1);
            expect(stub.calls.sendTransaction).toBe(1);
        } finally {
            await stub.close();
        }
    });

    it.each([
        [
            { computeUnitLimit: 50_001 },
            "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction_too_high",
        ],
        [
            { computeUnitPriceMicroLamports: 10_001n },
            "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
        ],
        [{ memo: "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb" }, "invalid_exact_svm_payload_memo_mismatch"],
    ])("enforces caps and memo %o", async (opts, reason) => {
        const rpc = createFakeRpc();
        const res = await settler(rpc).settle(
            attempt(msgHash),
            await signedPayment(reqWithHints, payer, opts),
            requirements,
        );
        expect(res.success).toBe(false);
        expect(res.errorReason).toBe(reason);
        expect(records).toHaveLength(0);
        expect(rpc.calls.sendTransaction ?? 0).toBe(0);
    });

    it("reports pending with the signature when confirmation fails", async () => {
        const rpc = createFakeRpc({
            getSignatureStatuses: () => {
                throw new Error("rpc down");
            },
        });
        const a = attempt(msgHash);
        const res = await settler(rpc).settle(a, payload, requirements);
        expect(res.errorReason).toBe("settlement_pending");
        expect(res.transaction).not.toBe("");
        expect(res.transaction).toBe(records[0]!.signature);
        expect(a.committed).toBe(true);
    });

    it("bounds an unknown blockhash by block height plus margin", async () => {
        const configs: unknown[] = [];
        const rpc = createFakeRpc({
            getBlockHeight: (config: never) => {
                configs.push(config);
                return 1000n;
            },
        });
        const res = await settler(rpc, new BlockhashCache(rpc, 8_000)).settle(
            attempt(msgHash),
            payload,
            requirements,
        );
        expect(res.success).toBe(true);
        expect(configs).toEqual([{ commitment: "confirmed" }]);
        expect(records[0]!.blockhash).toBe(TEST_BLOCKHASH);
        expect(records[0]!.lastValidBlockHeight).toBe(1300n);
    });

    it("names block_height_unavailable and sends nothing when the height is unknown", async () => {
        const rpc = createFakeRpc({
            getBlockHeight: () => {
                throw new Error("rpc down");
            },
        });
        const a = attempt(msgHash);
        const res = await settler(rpc, new BlockhashCache(rpc, 8_000)).settle(
            a,
            payload,
            requirements,
        );
        expect(res.success).toBe(false);
        expect(res.transaction).toBe("");
        expect(a).toMatchObject({ committed: false, failure: "block_height_unavailable" });
        expect(records).toHaveLength(0);
        expect(rpc.sent).toHaveLength(0);
        expect(rpc.calls.sendTransaction).toBe(0);
    });

    it("refuses a broadcast outside an attempt", async () => {
        const send = vi.fn(async () => wireSignature);
        const w = recordingSigner(innerStub(send), {
            als: new AsyncLocalStorage(),
            rpc: createFakeRpc(),
            hints,
            log: silentLog,
        });
        await expect(w.sendTransaction(wire, SOLANA_MAINNET)).rejects.toThrow(/outside an attempt/);
        expect(send).not.toHaveBeenCalled();
    });

    it("refuses a broadcast of another message than the attempt's", async () => {
        const als = new AsyncLocalStorage<SettleAttempt>();
        const send = vi.fn(async () => wireSignature);
        const w = recordingSigner(innerStub(send), {
            als,
            rpc: createFakeRpc(),
            hints,
            log: silentLog,
        });
        const a = attempt("another-message-hash");
        await expect(als.run(a, () => w.sendTransaction(wire, SOLANA_MAINNET))).rejects.toThrow(
            /^rpc_failed$/,
        );
        expect(records).toHaveLength(0);
        expect(a.committed).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    it("rethrows a bare failure name and logs the cause redacted", async () => {
        const lines: string[] = [];
        const log = jsonLog("payments", {
            secrets: ["https://rpc/?api-key=K"],
            write: (line) => lines.push(line),
        });
        const als = new AsyncLocalStorage<SettleAttempt>();
        const w = recordingSigner(
            innerStub(async () => {
                throw new Error("https://rpc/?api-key=K 429");
            }),
            { als, rpc: createFakeRpc(), hints, log },
        );
        const a = attempt(msgHash);
        await expect(als.run(a, () => w.sendTransaction(wire, SOLANA_MAINNET))).rejects.toThrow(
            /^rpc_failed$/,
        );
        expect(a.committed).toBe(true);
        expect(a.failure).toBeUndefined();
        const written = lines.join("\n");
        expect(written).toContain("[redacted] 429");
        expect(written).not.toContain("api-key=K");
    });

    it("returns its own signature and warns when the RPC answers another", async () => {
        const log = memoryLog();
        const als = new AsyncLocalStorage<SettleAttempt>();
        const w = recordingSigner(
            innerStub(async () => "another-signature"),
            { als, rpc: createFakeRpc(), hints, log },
        );
        const signature = await als.run(attempt(msgHash), () =>
            w.sendTransaction(wire, SOLANA_MAINNET),
        );
        expect(signature).toBe(wireSignature);
        expect(log.lines).toContainEqual(
            expect.objectContaining({ level: "warn", answered: "another-signature" }),
        );
    });
});
