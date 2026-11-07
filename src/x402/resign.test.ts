import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { TEST_PAYTO } from "../testing/x402.ts";
import { resignProof } from "./resign.ts";
import { openTail } from "./tail.ts";

const T0 = new Date("2030-01-01T12:00:00Z");
const sigs = ["1".repeat(63) + "2", "1".repeat(63) + "3"];

let db: TestDb;
let x402: Settings["x402"];

beforeAll(async () => {
    db = await testDb();
    x402 = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t").x402;
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await db.pool.query("truncate x402_chain_txs");
});

const pool = () => db.pool;
const rpcAnswering = (slot: bigint, values: unknown[]) =>
    createFakeRpc({ getSignatureStatuses: () => ({ context: { slot }, value: values }) });
const storeChainTx = (signature: string, slot: bigint, failed: boolean) =>
    pool().query(
        `insert into x402_chain_txs (signature, slot, delta_micros, failed, matched)
         values ($1, $2, 0, $3, 'no_effect')`,
        [signature, slot.toString(), failed],
    );
const failedStatus = { err: { InstructionError: [0, { Custom: 1 }] } };

describe("resignProof", () => {
    it("absent only with both proofs", async () => {
        await openTail(pool(), "ATA", 0n, 1_300n, T0);
        const row = { signatures: sigs, expirySeenSlot: 1_000n };
        expect(
            await resignProof(pool(), rpcAnswering(1_000n, [null, failedStatus]), row, x402, 2_000),
        ).toBe("absent");
        expect(
            await resignProof(
                pool(),
                rpcAnswering(1_000n, [null, { err: null }]),
                row,
                x402,
                2_000,
            ),
        ).toBe("wait");
    });

    it("waits while verified_slot < expiry_seen_slot + 300, with no RPC call", async () => {
        await openTail(pool(), "ATA", 0n, 1_299n, T0);
        const rpc = rpcAnswering(1_000n, [null, null]);
        const row = { signatures: sigs, expirySeenSlot: 1_000n };
        expect(await resignProof(pool(), rpc, row, x402, 2_000)).toBe("wait");
        expect(rpc.calls.getSignatureStatuses).toBe(0);
    });

    it("waits when a status answers at a context slot below expiry_seen_slot", async () => {
        await openTail(pool(), "ATA", 0n, 1_300n, T0);
        const row = { signatures: sigs, expirySeenSlot: 1_000n };
        expect(await resignProof(pool(), rpcAnswering(999n, [null, null]), row, x402, 2_000)).toBe(
            "wait",
        );
    });

    it("waits without expiry_seen_slot, and on an RPC error", async () => {
        await openTail(pool(), "ATA", 0n, 1_300n, T0);
        const none = { signatures: sigs, expirySeenSlot: null };
        expect(
            await resignProof(pool(), rpcAnswering(1_000n, [null, null]), none, x402, 2_000),
        ).toBe("wait");
        const failing = createFakeRpc({
            getSignatureStatuses: () => {
                throw new Error("429");
            },
        });
        const row = { signatures: sigs, expirySeenSlot: 1_000n };
        expect(await resignProof(pool(), failing, row, x402, 2_000)).toBe("wait");
    });

    it("lands when a stored transaction without error carries one of the signatures", async () => {
        await storeChainTx(sigs[1]!, 1_100n, false);
        const row = { signatures: sigs, expirySeenSlot: 1_000n };
        expect(
            await resignProof(pool(), rpcAnswering(1_000n, [null, null]), row, x402, 2_000),
        ).toBe("landed");
    });

    it("is absent for signatures stored with meta.err", async () => {
        await openTail(pool(), "ATA", 0n, 0n, T0);
        await storeChainTx(sigs[0]!, 1_100n, true);
        await storeChainTx(sigs[1]!, 1_101n, true);
        const row = { signatures: sigs, expirySeenSlot: null };
        expect(await resignProof(pool(), createFakeRpc(), row, x402, 2_000)).toBe("absent");
    });
});
