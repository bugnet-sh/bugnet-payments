import { createHash, randomBytes, randomUUID } from "node:crypto";
import { address } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { memoryLog } from "../log.ts";
import { usdcAta } from "../solana/accounts.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { startFakeChain, type FakeChain } from "../testing/fake-chain.ts";
import { testSigner } from "../testing/keys.ts";
import {
    resetLedger,
    seedAccount,
    seedFunding,
    seedService,
    seedX402Payment,
    TEST_PAYTO,
} from "../testing/x402.ts";
import { buildSellerPayment, randomSellerMemo, signSellerPayment } from "./build.ts";
import { base32Lower, newX402PaymentId } from "./ids.ts";
import { applyExpiry } from "./match.ts";
import { fastPassNeeded, runFastPass, type FastPassDeps } from "./fastpass.ts";
import { reserve, findX402Payment } from "./reserve.ts";
import type { X402PaymentRow } from "./types.ts";

const NOW = new Date("2030-01-01T12:00:00Z");
const DAY = "2030-01-01";

let db: TestDb;
let chain: FakeChain;
let fastDeps: FastPassDeps;
let x402: Settings["x402"];
let log: ReturnType<typeof memoryLog>;
let hot: string;
let payToAta: string;
let allowance: Awaited<ReturnType<typeof testSigner>>;
let seller: Awaited<ReturnType<typeof testSigner>>;
let accountId: string;
let placementId: string;

beforeAll(async () => {
    db = await testDb();
    x402 = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t").x402;
    allowance = await testSigner(11);
    seller = await testSigner(21);
    hot = await usdcAta(allowance.address);
    payToAta = await usdcAta(address(TEST_PAYTO));
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await resetLedger(db.pool);
    await db.pool.query("truncate x402_chain_txs, x402_payto_days, x402_outflow_days cascade");
    chain = await startFakeChain();
    chain.setTokenAccount({ address: hot, owner: allowance.address, amount: 1_000_000n });
    chain.setTokenAccount({ address: payToAta, owner: TEST_PAYTO, amount: 0n });
    log = memoryLog();
    fastDeps = {
        pool: db.pool,
        rpc: chain.rpc,
        hotTokenAccount: address(hot),
        x402,
        log,
        now: () => NOW,
        rpcTimeoutMs: 2_000,
    };
    const account = await seedAccount(db.pool, {
        handleSha256: randomBytes(32).toString("hex"),
        fundedMicros: 1_000_000,
        heldMicros: 0,
        spentMicros: 0,
    });
    accountId = account.id;
    placementId = randomUUID();
    const funding = await seedFunding(db.pool, { accountId, allowanceMicros: 1_000_000 });
    await seedService(db.pool, { accountId, orderId: funding.orderId });
    await db.pool.query("update x402_pool set committed_micros = 1000000 where id = 1");
});
afterEach(async () => {
    await chain.close();
});

async function landPayment() {
    const { value } = await chain.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const tx = buildSellerPayment({
        feePayer: seller.address,
        hotTokenAccount: address(hot),
        destination: address(payToAta),
        authority: allowance.address,
        amount: 10_000n,
        memo: randomSellerMemo(),
        computeUnitLimit: 20_000,
        computeUnitPriceMicroLamports: 1n,
        blockhash: value.blockhash,
        lastValidBlockHeight: value.lastValidBlockHeight,
    });
    const signed = await signSellerPayment(tx, allowance);
    const txSignature = await chain.cosignAndSubmit(signed.wireBase64, seller);
    return {
        txSignature,
        ourHash: createHash("sha256").update(signed.signature).digest(),
        messageHash: signed.messageHash,
        lastValidBlockHeight: value.lastValidBlockHeight,
    };
}

async function signedRow(o: Partial<X402PaymentRow> = {}): Promise<X402PaymentRow> {
    await db.pool.query(
        "update x402_accounts set held_micros = held_micros + 10000 where id = $1",
        [accountId],
    );
    return seedX402Payment(db.pool, {
        accountId,
        placementId,
        amountMicros: 10_000,
        payTo: TEST_PAYTO,
        payToTokenAccount: payToAta,
        listed: "indexed",
        capDay: DAY,
        state: "signed",
        signedAt: NOW,
        signingSlot: 0n,
        ...o,
    });
}

const paymentRow = async (id: string) => (await findX402Payment(db.pool, id))!;
const serviceFailures = async (row: X402PaymentRow) =>
    Number(
        (
            await db.pool.query(
                "select failures from x402_services where account_id = $1 and service_id = $2",
                [row.accountId, row.serviceId],
            )
        ).rows[0].failures,
    );

describe("runFastPass", () => {
    it("sets landed_slot and frees the open-payment place", async () => {
        const p = await landPayment();
        const first = await signedRow({
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
        });
        for (let i = 0; i < 7; i++) await signedRow();
        const ninth = {
            id: newX402PaymentId(),
            ref: base32Lower(randomBytes(10)),
            accountId,
            placementId,
            serviceId: first.serviceId,
            method: "POST",
            host: first.host,
            path: first.path,
            targetSha256: Buffer.alloc(32),
            bodySha256: Buffer.alloc(32),
            amountMicros: 10_000,
            payTo: TEST_PAYTO,
            payToTokenAccount: payToAta,
            feePayer: seller.address,
            listed: "indexed" as const,
        };
        expect(await reserve(db.pool, ninth, x402, log, NOW)).toMatchObject({
            ok: false,
            reason: "too_many_open_payments",
        });
        expect(await runFastPass(fastDeps)).toEqual({ landed: 1, ignoredHints: 0 });
        expect(await paymentRow(first.id)).toMatchObject({
            state: "signed",
            landedSlot: chain.slot(),
            txSignature: p.txSignature,
        });
        expect((await reserve(db.pool, ninth, x402, log, NOW)).ok).toBe(true);
    });

    it("never confirms or expires", async () => {
        const p = await landPayment();
        const landed = await signedRow({
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
        });
        const expired = await signedRow({ lastValidBlockHeight: 1n, expirySeenSlot: 1n });
        const heldBefore = (await db.pool.query("select held_micros from x402_accounts")).rows;
        await runFastPass(fastDeps);
        expect((await paymentRow(landed.id)).state).toBe("signed");
        expect((await paymentRow(expired.id)).state).toBe("signed");
        const count = await db.pool.query("select count(*) as n from x402_chain_txs");
        expect(count.rows[0].n).toBe("0");
        expect((await db.pool.query("select held_micros from x402_accounts")).rows).toEqual(
            heldBefore,
        );
    });

    it("reads hint_tx first", async () => {
        const p = await landPayment();
        for (let i = 0; i < 3; i++) chain.credit(hot, 1n);
        await signedRow({
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
            hintTx: p.txSignature,
        });
        await runFastPass(fastDeps);
        const reads = chain.calls().filter((c) => c.method === "getTransaction");
        expect(reads[0]!.params[0]).toBe(p.txSignature);
    });

    it("counts a hint pointing at another transaction once", async () => {
        const other = chain.credit(hot, 1n);
        const row = await signedRow({ hintTx: other });
        expect(await runFastPass(fastDeps)).toEqual({ landed: 0, ignoredHints: 1 });
        expect((await paymentRow(row.id)).landedSlot).toBeNull();
        expect(await serviceFailures(row)).toBe(1);
        await runFastPass(fastDeps);
        expect(await serviceFailures(row)).toBe(1);
    });

    it("makes no RPC call when no signed row lacks landed_slot", async () => {
        await signedRow({ landedSlot: 1_000n, txSignature: "1".repeat(63) + "2" });
        expect(await fastPassNeeded(db.pool)).toBe(false);
        const before = chain.calls().length;
        expect(await runFastPass(fastDeps)).toEqual({ landed: 0, ignoredHints: 0 });
        expect(chain.calls()).toHaveLength(before);
    });

    it("skips a candidate it cannot read and goes on to the next", async () => {
        const bad = "1".repeat(63) + "2";
        const p = await landPayment();
        await signedRow({ hintTx: bad });
        const good = await signedRow({
            ourSignatureSha256: p.ourHash,
            messageHash: p.messageHash,
        });
        const rpc = new Proxy(chain.rpc, {
            get(target, prop, receiver) {
                if (prop !== "getTransaction") return Reflect.get(target, prop, receiver);
                return (sig: string, cfg: never) =>
                    sig === bad
                        ? {
                              send: async () => {
                                  throw new Error("unsupported transaction version");
                              },
                          }
                        : target.getTransaction(sig as never, cfg);
            },
        });
        expect(await runFastPass({ ...fastDeps, rpc })).toEqual({ landed: 1, ignoredHints: 0 });
        expect((await paymentRow(good.id)).landedSlot).toBe(chain.slot());
        expect(log.lines.some((l) => String(l.msg).includes("could not read"))).toBe(true);
    });

    it("a hint failure row stays signed after the fast pass and the expiry", async () => {
        const row = await signedRow({ hint: "failure", lastValidBlockHeight: 10_000n });
        await runFastPass(fastDeps);
        const matchDeps = {
            x402,
            hotTokenAccount: hot,
            coldTokenAccount: hot,
            log,
            now: () => NOW,
            rpcTimeoutMs: 2_000,
        };
        await applyExpiry(
            db.pool,
            chain.rpc,
            { h0: 2_000n, c0: 2_000n, verifiedSlot: 5_000n },
            matchDeps,
        );
        expect((await paymentRow(row.id)).state).toBe("signed");
    });
});
