import { createHash } from "node:crypto";
import { type Address, getAddressDecoder, isSolanaError, type KeyPairSigner } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTx } from "../db/pool.ts";
import { memoryLog } from "../log.ts";
import { newOrderId } from "../orders/ids.ts";
import { usdcAta } from "../solana/accounts.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { type FakeChain, startFakeChain } from "../testing/fake-chain.ts";
import { testSigner } from "../testing/keys.ts";
import { seedOrder } from "../testing/orders.ts";
import { DepositKeys } from "./keys.ts";
import {
    type AccountRead,
    type CachedTx,
    expectedBalanceAt,
    needsScan,
    readDepositBalances,
    ReadTrail,
    recordRead,
    scanDeposit,
    type ScanDeps,
    scanStep,
    TxCache,
    unexplainedIn,
} from "./scan.ts";
import { depositLedger, ensureDeposit, findDeposit, insertMove } from "./store.ts";
import type { DepositRow, MoveRow, MoveState, NewMove, TransferRow } from "./types.ts";

const ORDER_A = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORDER_B = "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_A = "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley";
const TOKEN_A = "D2mAKdUVEHvizHThmG57bTCiASiiYj5gQbMeMoyWtQo1";
const ADDRESS_B = "Fvkkb7d7zpJZcyUsygPojncsHASt2VtQB6hLRTHKp4aB";
const CREATED = new Date("2030-01-01T00:00:00Z");
const EXPIRES = new Date("2030-01-01T00:15:00Z");
const T0 = new Date("2030-01-01T00:05:00Z");
const AT_0400 = 1_893_456_240;
const TIMEOUT = 10_000;
const CFG: ScanDeps["cfg"] = {
    scan_page_size: 1_000,
    scan_max_pages: 10,
    scan_max_transactions: 200,
    index_lag_alarm_after: 30_000,
};

const keys = new DepositKeys(new Map([[1, Buffer.alloc(32, 7)]]), 1);

let db: TestDb;
let chain: FakeChain;
let clock: Date;
let log: ReturnType<typeof memoryLog>;
let cache: TxCache;
let payer: KeyPairSigner;
let feePayer: KeyPairSigner;
let payerAta: string;
let tokenB: string;

beforeAll(async () => {
    db = await testDb();
    [payer, feePayer] = await Promise.all([testSigner(31), testSigner(22)]);
    payerAta = await usdcAta(payer.address);
    tokenB = await usdcAta(ADDRESS_B as Address);
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    chain = await startFakeChain();
    chain.setTokenAccount({ address: payerAta, owner: payer.address, amount: 100_000n });
    clock = T0;
    log = memoryLog();
    cache = new TxCache(10_000);
    await db.pool.query(
        `delete from deposit_transfers; delete from deposit_moves; delete from deposit_holds;
         delete from deposits; delete from orders`,
    );
});
afterEach(async () => {
    await chain.close();
});

const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
};

function deps(over: Partial<ScanDeps["cfg"]> = {}): ScanDeps {
    return {
        pool: db.pool,
        rpc: chain.rpc,
        rpcTimeoutMs: TIMEOUT,
        cfg: { ...CFG, ...over },
        cache,
        log,
        now: () => clock,
    };
}

const padding = (n: number): string[] =>
    Array.from({ length: n }, (_, i) =>
        getAddressDecoder().decode(createHash("sha256").update(`padding ${i}`).digest()),
    );

// Reads one account, then moves to a new slot so nothing lands in the slot that was read
async function readNow(account = TOKEN_A): Promise<AccountRead> {
    const r = (
        await readDepositBalances(chain.rpc, [account as Address], { timeoutMs: TIMEOUT })
    ).get(account)!;
    chain.advance(1);
    return r;
}

async function scanNow(dep: DepositRow, trail: ReadTrail, d = deps()) {
    trail.push(await readNow(dep.tokenAccount));
    return await scanDeposit(d, dep, trail);
}

// The golden deposit of the order: by default its token account is created by the fee payer and
// scanned once, so the creator is known and the cursor and the anchor are set
async function deposit(
    id = ORDER_A,
    o: { create?: boolean } = {},
): Promise<{ dep: DepositRow; trail: ReadTrail }> {
    const { order } = await seedOrder(db.pool, {
        id,
        amountMicros: 50_000,
        createdAt: CREATED,
        expiresAt: EXPIRES,
    });
    const dep = (await ensureDeposit(db.pool, keys, order, T0, () => Buffer.alloc(16, 1)))!;
    const trail = new ReadTrail(null);
    if (o.create !== false) {
        await chain.createAta({ owner: dep.address, payer: feePayer });
        expect((await scanNow(dep, trail)).invariant).toBe("held");
    }
    return { dep, trail };
}

// The memo keeps equal transfers apart, which would otherwise share one signature
const send = (micros: bigint, to = TOKEN_A, memo?: string) =>
    chain.transfer({
        authority: payer,
        feePayer: payer,
        source: payerAta,
        destination: to,
        micros,
        ...(memo === undefined ? {} : { memo }),
    });

const ledger = async (orderId = ORDER_A) => (await depositLedger(db.pool, orderId))!;

const callsSince = (mark: number, method: string) =>
    chain
        .calls()
        .slice(mark)
        .filter((c) => c.method === method);

const alarms = (name: string) => log.lines.filter((l) => l.alarm === name);

async function storedMove(
    m: Partial<NewMove> & Pick<NewMove, "kind">,
    sig: string,
    state: MoveState = "sent",
): Promise<MoveRow> {
    const move = await withTx(db.pool, (c) =>
        insertMove(
            c,
            {
                orderId: ORDER_A,
                amountMicros: 0,
                keepMicros: 0,
                heldMicros: 0,
                destination: null,
                payer: null,
                memo: null,
                closes: false,
                closeTo: null,
                ...m,
            },
            [],
            clock,
        ),
    );
    await db.pool.query("update deposit_moves set state = $2, tx_signature = $3 where id = $1", [
        move.id,
        state,
        sig,
    ]);
    return move;
}

describe("readDepositBalances", () => {
    it("readDepositBalances batches 100 per call", async () => {
        const missing = padding(149);
        const mark = chain.calls().length;
        const reads = await readDepositBalances(
            chain.rpc,
            [...missing, payerAta].map((a) => a as Address),
            { timeoutMs: TIMEOUT },
        );
        expect(callsSince(mark, "getMultipleAccounts")).toHaveLength(2);
        expect(reads.size).toBe(150);
        expect(reads.get(missing[0]!)).toEqual({
            exists: false,
            micros: 0n,
            contextSlot: chain.slot(),
        });
        expect(reads.get(payerAta)).toEqual({
            exists: true,
            micros: 100_000n,
            contextSlot: chain.slot(),
        });
    });

    it("a system account at the token account address reads as missing", async () => {
        chain.fundLamports(tokenB, 890_880n);
        expect(await readNow(tokenB)).toMatchObject({ exists: false, micros: 0n });
    });

    it("balance reads carry minContextSlot", async () => {
        const pin = chain.slot() + 5n;
        const err = await readDepositBalances(chain.rpc, [payerAta as Address], {
            timeoutMs: TIMEOUT,
            minContextSlot: pin,
        }).catch((e: unknown) => e);
        expect(isSolanaError(err)).toBe(true);
        const sent = chain
            .calls()
            .filter((c) => c.method === "getMultipleAccounts")
            .at(-1)!;
        expect(sent.params[1]).toMatchObject({
            encoding: "jsonParsed",
            commitment: "confirmed",
            minContextSlot: Number(pin),
        });
    });
});

describe("scanDeposit", () => {
    it("a transfer is recorded with source, owner, balance and its block time", async () => {
        const { dep, trail } = await deposit();
        chain.setBlockTime(AT_0400);
        const sig = await send(6_000n);
        later(1_000);
        await scanNow(dep, trail);
        const l = await ledger();
        expect(l.transfers).toEqual([
            expect.objectContaining({
                signature: sig,
                amountMicros: 6_000,
                sourceTokenAccount: payerAta,
                sourceOwner: payer.address,
                sourceBalanceMicros: 94_000n,
                blockTime: new Date("2030-01-01T00:04:00Z"),
                seenAt: clock,
                outcome: "open",
            }),
        ]);
        expect(l.deposit.balanceMicros).toBe(6_000n);
        expect(l.deposit.checkedAt).toEqual(clock);
        expect(l.deposit.checkedSlot).toBe(chain.slot() - 1n);
    });

    it("the block time comes from getBlockTime when the answer has none", async () => {
        const { dep, trail } = await deposit();
        chain.setBlockTime(AT_0400);
        chain.advance(1);
        chain.setBlockTime(null);
        const first = await send(6_000n);
        await scanNow(dep, trail);
        expect((await ledger()).transfers[0]).toMatchObject({
            signature: first,
            blockTime: new Date("2030-01-01T00:04:00Z"),
        });

        chain.setBlockTime(AT_0400 + 30);
        chain.advance(1);
        chain.setBlockTime(null);
        const second = await send(1_000n);
        chain.withholdBlockTime(chain.slot(), 1);
        await scanNow(dep, trail);
        let l = await ledger();
        expect(l.transfers.map((t) => t.signature)).toEqual([first]);
        expect(l.deposit.lastSignature).toBe(first);
        await scanNow(dep, trail);
        l = await ledger();
        expect(l.transfers[1]).toMatchObject({
            signature: second,
            blockTime: new Date("2030-01-01T00:04:30Z"),
        });
        expect(l.deposit.lastSignature).toBe(second);
    });

    it("a second scan adds nothing", async () => {
        const { dep, trail } = await deposit();
        await send(6_000n);
        await scanNow(dep, trail);
        const mark = chain.calls().length;
        const r = await readNow();
        const l = await ledger();
        expect(needsScan(l.deposit, r, l.transfers, l.moves)).toBe(false);
        expect(callsSince(mark, "getSignaturesForAddress")).toHaveLength(0);
    });

    it("one transaction credits two deposits", async () => {
        const a = await deposit(ORDER_A);
        const b = await deposit(ORDER_B);
        const sig = await chain.transferMany({
            from: payer,
            to: [
                { tokenAccount: TOKEN_A, micros: 30_000n },
                { tokenAccount: tokenB, micros: 20_000n },
            ],
        });
        const reads = await readDepositBalances(
            chain.rpc,
            [TOKEN_A as Address, tokenB as Address],
            { timeoutMs: TIMEOUT },
        );
        chain.advance(1);
        a.trail.push(reads.get(TOKEN_A)!);
        b.trail.push(reads.get(tokenB)!);
        const mark = chain.calls().length;
        expect((await scanDeposit(deps(), a.dep, a.trail)).invariant).toBe("held");
        expect((await scanDeposit(deps(), b.dep, b.trail)).invariant).toBe("held");
        expect((await ledger(ORDER_A)).transfers.map((t) => [t.signature, t.amountMicros])).toEqual(
            [[sig, 30_000]],
        );
        expect((await ledger(ORDER_B)).transfers.map((t) => [t.signature, t.amountMicros])).toEqual(
            [[sig, 20_000]],
        );
        expect(callsSince(mark, "getTransaction").filter((c) => c.params[0] === sig)).toHaveLength(
            1,
        );
    });

    it("padding before a held read costs nothing", async () => {
        const { dep, trail } = await deposit();
        const others = padding(39);
        for (let i = 0; i < 900; i++) {
            await chain.noOp({ touching: [TOKEN_A, ...others], signer: payer });
        }
        // The job records a read that needs no scan, so the cursor stays behind the padding
        const held = await readNow();
        let l = await ledger();
        expect(needsScan(l.deposit, held, l.transfers, l.moves)).toBe(false);
        await recordRead(db.pool, l.deposit, held, "held", clock);
        trail.reanchor(held.contextSlot, held.micros);

        const sig = await send(50_000n);
        trail.push(await readNow());
        const mark = chain.calls().length;
        const res = await scanDeposit(deps(), dep, trail);
        expect(callsSince(mark, "getSignaturesForAddress")).toHaveLength(2);
        expect(callsSince(mark, "getTransaction").map((c) => c.params[0])).toEqual([sig]);
        expect(res).toMatchObject({ invariant: "held", complete: true });
        l = await ledger();
        expect(l.transfers.map((t) => t.signature)).toEqual([sig]);
        expect(l.deposit.lastSignature).toBe(sig);
    });

    it("padding in a quiet interval costs nothing", async () => {
        const { dep, trail } = await deposit();
        for (let i = 0; i < 10; i++) await chain.noOp({ touching: TOKEN_A, signer: payer });
        trail.push(await readNow());
        const sig = await send(20_000n);
        trail.push(await readNow());
        const mark = chain.calls().length;
        expect((await scanDeposit(deps(), dep, trail)).invariant).toBe("held");
        expect(callsSince(mark, "getTransaction").map((c) => c.params[0])).toEqual([sig]);
    });

    it("padding in the transfer's interval is fetched once per signature", async () => {
        const a = await deposit(ORDER_A);
        const b = await deposit(ORDER_B);
        const toA = await send(20_000n, TOKEN_A);
        const toB = await send(5_000n, tokenB);
        for (let i = 0; i < 10; i++) {
            await chain.noOp({ touching: [TOKEN_A, tokenB], signer: payer });
        }
        const reads = await readDepositBalances(
            chain.rpc,
            [TOKEN_A as Address, tokenB as Address],
            { timeoutMs: TIMEOUT },
        );
        chain.advance(1);
        a.trail.push(reads.get(TOKEN_A)!);
        b.trail.push(reads.get(tokenB)!);
        const mark = chain.calls().length;
        expect((await scanDeposit(deps(), a.dep, a.trail)).invariant).toBe("held");
        expect((await scanDeposit(deps(), b.dep, b.trail)).invariant).toBe("held");
        expect(callsSince(mark, "getTransaction")).toHaveLength(12);
        expect((await ledger(ORDER_A)).transfers.map((t) => t.signature)).toEqual([toA]);
        expect((await ledger(ORDER_B)).transfers.map((t) => t.signature)).toEqual([toB]);
    });

    it("entries above the read slot wait for the next scan", async () => {
        const { dep, trail } = await deposit();
        const first = await send(1_000n);
        trail.push(await readNow());
        const late = await send(2_000n);
        await scanDeposit(deps(), dep, trail);
        let l = await ledger();
        expect(l.transfers.map((t) => t.signature)).toEqual([first]);
        expect(l.deposit.lastSignature).toBe(first);

        await scanNow(dep, trail);
        l = await ledger();
        expect(l.transfers.map((t) => t.signature)).toEqual([first, late]);
        expect(l.deposit.lastSignature).toBe(late);
    });

    it("a listing that does not reach the cursor is not trusted", async () => {
        const { dep, trail } = await deposit();
        const cursor = (await ledger()).deposit;
        chain.advance(10);
        chain.pruneHistoryBefore(cursor.scanSlot! + 5n);
        const sig = await send(1_000n);
        expect(await scanNow(dep, trail)).toMatchObject({ complete: false, invariant: "above" });
        let l = await ledger();
        expect(l.transfers).toEqual([]);
        expect(l.deposit.lastSignature).toBe(cursor.lastSignature);
        expect(alarms("deposit_index_lag")).toHaveLength(0);

        later(31_000);
        expect((await scanDeposit(deps(), dep, trail)).complete).toBe(false);
        later(10_000);
        await scanDeposit(deps(), dep, trail);
        expect(alarms("deposit_index_lag")).toEqual([
            expect.objectContaining({ orderId: ORDER_A }),
        ]);

        chain.pruneHistoryBefore(null);
        expect(await scanDeposit(deps(), dep, trail)).toMatchObject({
            complete: true,
            invariant: "held",
        });
        l = await ledger();
        expect(l.transfers.map((t) => t.signature)).toEqual([sig]);
        expect(l.deposit.lastSignature).toBe(sig);
    });

    it("the cursor never passes an unexplained interval", async () => {
        const { dep, trail } = await deposit();
        const cursor = (await ledger()).deposit.lastSignature;
        const hidden = await send(7_000n);
        chain.hideFromIndex(hidden, 600_000);
        const pad = await chain.noOp({ touching: TOKEN_A, signer: payer });
        trail.push(await readNow());
        const mark = chain.calls().length;
        expect(await scanDeposit(deps(), dep, trail)).toMatchObject({
            complete: false,
            invariant: "above",
        });
        expect(callsSince(mark, "getTransaction").map((c) => c.params[0])).toEqual([pad]);
        let l = await ledger();
        expect(unexplainedIn(trail.intervals()[0]!, l.transfers, l.moves)).toBe(7_000n);
        expect(l.transfers).toEqual([]);
        expect(l.deposit.lastSignature).toBe(cursor);

        later(31_000);
        await scanDeposit(deps(), dep, trail);
        expect(alarms("deposit_index_lag")).toHaveLength(1);
        expect((await ledger()).deposit.lastSignature).toBe(cursor);

        chain.hideFromIndex(hidden, 0);
        expect((await scanDeposit(deps(), dep, trail)).invariant).toBe("held");
        l = await ledger();
        expect(l.transfers.map((t) => t.signature)).toEqual([hidden]);
        expect(l.deposit.lastSignature).toBe(pad);
    });

    it("the cursor waits while a move is in flight", async () => {
        const { dep, trail } = await deposit();
        const first = await send(2_000n);
        expect((await scanNow(dep, trail)).invariant).toBe("held");
        const cursor = (await ledger()).deposit.lastSignature;
        expect(cursor).toBe(first);

        const ret = chain.debit(TOKEN_A, 2_000n);
        const retSlot = chain.slot();
        // The return's own entry is not listed yet, so only the executor can know its landing
        chain.hideFromIndex(ret, 600_000);
        const move = await storedMove(
            { kind: "return", amountMicros: 2_000, destination: payerAta, payer: payer.address },
            ret,
        );
        const credit = await send(2_000n);
        const r = await readNow();
        expect(r.micros).toBe(2_000n);
        trail.push(r);
        expect((await scanDeposit(deps(), dep, trail)).invariant).not.toBe("held");
        let l = await ledger();
        expect(l.transfers.map((t) => t.signature)).toEqual([first]);
        expect(l.deposit.lastSignature).toBe(cursor);
        expect(l.deposit.checkedSlot).toBeLessThan(r.contextSlot);

        await db.pool.query(
            "update deposit_moves set state = 'confirmed', landed_slot = $2 where id = $1",
            [move.id, retSlot.toString()],
        );
        l = await ledger();
        expect(unexplainedIn(trail.intervals()[0]!, l.transfers, l.moves)).toBe(2_000n);
        expect((await scanDeposit(deps(), dep, trail)).invariant).toBe("held");
        l = await ledger();
        expect(l.transfers.map((t) => t.signature)).toEqual([first, credit]);
        expect(l.deposit.lastSignature).toBe(credit);
    });

    it("150 new signatures are all recorded", async () => {
        const { dep, trail } = await deposit();
        const sigs: string[] = [];
        for (let i = 0; i < 150; i++) sigs.push(await send(1n, TOKEN_A, `n${i}`));
        trail.push(await readNow());
        const mark = chain.calls().length;
        expect((await scanDeposit(deps({ scan_page_size: 100 }), dep, trail)).invariant).toBe(
            "held",
        );
        const l = await ledger();
        expect(l.transfers).toHaveLength(150);
        expect(l.transfers.find((t) => t.signature === sigs[0])?.seq).toBe(0);
        expect(l.transfers.find((t) => t.signature === sigs[149])?.seq).toBe(149);
        expect(l.deposit.lastSignature).toBe(sigs[149]);
        const pages = callsSince(mark, "getSignaturesForAddress").filter(
            (c) => (c.params[1] as { limit: number }).limit === 100,
        );
        expect(pages).toHaveLength(2);
        expect(pages[0]!.params[1]).not.toHaveProperty("before");
        expect(pages[1]!.params[1]).toHaveProperty("before");
    });

    it("a long listing goes on next tick", async () => {
        const { dep, trail } = await deposit();
        const pads: string[] = [];
        for (let i = 0; i < 150; i++) {
            pads.push(await chain.noOp({ touching: TOKEN_A, signer: payer }));
        }
        trail.push(await readNow());
        const d = deps({ scan_page_size: 100, scan_max_pages: 1 });
        expect((await scanDeposit(d, dep, trail)).complete).toBe(false);
        let row = (await findDeposit(db.pool, ORDER_A))!;
        expect(row.scanTop).toBe(pads[149]);
        expect(row.scanBefore).toBe(pads[50]);

        expect(await scanDeposit(d, dep, trail)).toMatchObject({
            complete: true,
            invariant: "held",
        });
        row = (await findDeposit(db.pool, ORDER_A))!;
        expect(row.scanTop).toBeNull();
        expect(row.scanBefore).toBeNull();
        expect(row.lastSignature).toBe(pads[149]);
    });

    it("scan_max_transactions bounds a tick and resumes", async () => {
        const { dep, trail } = await deposit();
        const cursor = (await ledger()).deposit.lastSignature;
        const sigs: string[] = [];
        for (let i = 0; i < 150; i++) sigs.push(await send(1n, TOKEN_A, `n${i}`));
        trail.push(await readNow());
        const d = deps({ scan_max_transactions: 100 });
        expect((await scanDeposit(d, dep, trail)).complete).toBe(false);
        let l = await ledger();
        expect(l.transfers.map((t) => t.signature).sort()).toEqual(sigs.slice(50).sort());
        expect(l.deposit.lastSignature).toBe(cursor);

        const mark = chain.calls().length;
        expect(await scanDeposit(d, dep, trail)).toMatchObject({
            complete: true,
            invariant: "held",
        });
        expect(callsSince(mark, "getTransaction")).toHaveLength(50);
        l = await ledger();
        expect(l.transfers).toHaveLength(150);
        expect(l.deposit.lastSignature).toBe(sigs[149]);
    });

    it("scanStep makes one call per step", async () => {
        const { dep, trail } = await deposit();
        await send(3_000n);
        await chain.noOp({ touching: TOKEN_A, signer: payer });
        trail.push(await readNow());
        const steps: { calls: number; done: boolean }[] = [];
        for (;;) {
            const s = await scanStep(deps(), dep, trail);
            steps.push({ calls: s.calls, done: s.done });
            if (s.done) {
                expect(s.result.invariant).toBe("held");
                break;
            }
        }
        expect(steps).toEqual([
            { calls: 1, done: false },
            { calls: 1, done: false },
            { calls: 1, done: false },
            { calls: 1, done: true },
        ]);
    });

    it("failed entries need no getTransaction", async () => {
        const { dep, trail } = await deposit();
        const hidden = await send(1_000n);
        chain.hideFromIndex(hidden, 600_000);
        for (let i = 0; i < 20; i++) {
            await chain.noOp({ touching: TOKEN_A, signer: payer, fail: true });
        }
        trail.push(await readNow());
        const mark = chain.calls().length;
        await scanDeposit(deps(), dep, trail);
        expect(callsSince(mark, "getTransaction")).toHaveLength(0);
        expect((await ledger()).transfers).toEqual([]);
    });

    it("our own move is read from the list", async () => {
        const { dep, trail } = await deposit();
        await send(50_000n);
        expect((await scanNow(dep, trail)).invariant).toBe("held");
        const sweep = chain.debit(TOKEN_A, 50_000n);
        const sweepSlot = chain.slot();
        const move = await storedMove(
            { kind: "sweep", amountMicros: 50_000, destination: payerAta, memo: ORDER_A },
            sweep,
        );
        trail.push(await readNow());
        const mark = chain.calls().length;
        await scanDeposit(deps(), dep, trail);
        expect((await ledger()).moves.find((m) => m.id === move.id)?.landedSlot).toBe(sweepSlot);
        expect(callsSince(mark, "getTransaction")).toHaveLength(0);
    });

    it("a failed own move leaves the invariant holding", async () => {
        const { dep, trail } = await deposit();
        await send(7_000n);
        expect((await scanNow(dep, trail)).invariant).toBe("held");
        await send(1n);
        chain.failNext();
        const failed = chain.debit(TOKEN_A, 7_000n);
        const move = await storedMove(
            {
                kind: "return",
                amountMicros: 7_000,
                destination: payerAta,
                payer: payer.address,
                closes: true,
                closeTo: feePayer.address,
            },
            failed,
        );
        const r = await readNow();
        trail.push(r);
        expect((await scanDeposit(deps(), dep, trail)).invariant).not.toBe("held");
        expect((await ledger()).moves.find((m) => m.id === move.id)?.landedSlot).toBeNull();

        await db.pool.query(
            "update deposit_moves set state = 'failed', failed_at = $2 where id = $1",
            [move.id, clock],
        );
        expect((await scanDeposit(deps(), dep, trail)).invariant).toBe("held");
        const l = await ledger();
        expect(l.moves.find((m) => m.id === move.id)?.landedSlot).toBeNull();
        expect(expectedBalanceAt(l.transfers, l.moves, r.contextSlot)).toBe(7_001n);
    });

    it("an equal return and deposit in one interval start a scan", async () => {
        const { dep, trail } = await deposit();
        await send(2_000n);
        expect((await scanNow(dep, trail)).invariant).toBe("held");
        const ret = chain.debit(TOKEN_A, 2_000n);
        const retSlot = chain.slot();
        const move = await storedMove(
            { kind: "return", amountMicros: 2_000, destination: payerAta, payer: payer.address },
            ret,
            "confirmed",
        );
        await db.pool.query("update deposit_moves set landed_slot = $2 where id = $1", [
            move.id,
            retSlot.toString(),
        ]);
        await send(2_000n);
        const r = await readNow();
        const l = await ledger();
        expect(r.micros).toBe(l.deposit.balanceMicros);
        expect(expectedBalanceAt(l.transfers, l.moves, r.contextSlot)).toBe(0n);
        expect(needsScan(l.deposit, r, l.transfers, l.moves)).toBe(true);
        trail.push(r);
        expect((await scanDeposit(deps(), dep, trail)).invariant).toBe("held");
    });

    it("a vault debit without the owner's signature has no source", async () => {
        const { dep, trail } = await deposit();
        const [vaultOwner, vault, signer] = await Promise.all([
            testSigner(51),
            testSigner(52),
            testSigner(53),
        ]);
        chain.setTokenAccount({
            address: vault.address,
            owner: vaultOwner.address,
            amount: 1_000_000n,
        });
        const sig = await chain.vaultTransfer({
            vault: vault.address,
            to: TOKEN_A,
            micros: 5_000n,
            signer,
        });
        expect((await scanNow(dep, trail)).invariant).toBe("held");
        expect((await ledger()).transfers).toEqual([
            expect.objectContaining({
                signature: sig,
                amountMicros: 5_000,
                sourceTokenAccount: null,
                sourceOwner: null,
                sourceBalanceMicros: null,
            }),
        ]);
    });

    it("the creator of the account becomes rent_payer", async () => {
        const wallet = await testSigner(23);
        const stranger = await testSigner(24);

        const a = await deposit(ORDER_A, { create: false });
        await chain.transfer({
            authority: payer,
            feePayer: wallet,
            source: payerAta,
            destination: TOKEN_A,
            micros: 5_000n,
            createDestinationFor: ADDRESS_A,
        });
        expect((await scanNow(a.dep, a.trail)).invariant).toBe("held");
        expect((await ledger(ORDER_A)).deposit.rentPayer).toBe(wallet.address);

        const b = await deposit(ORDER_B, { create: false });
        const created = await chain.createAta({ owner: ADDRESS_B, payer: stranger });
        for (let i = 0; i < 5; i++) await chain.noOp({ touching: tokenB, signer: payer });
        b.trail.push(await readNow(tokenB));
        const mark = chain.calls().length;
        await scanDeposit(deps(), b.dep, b.trail);
        expect(callsSince(mark, "getTransaction").map((c) => c.params[0])).toEqual([created]);
        expect((await ledger(ORDER_B)).deposit.rentPayer).toBe(stranger.address);

        const c = await deposit(newOrderId(), { create: false });
        await chain.createAta({ owner: c.dep.address, payer: stranger });
        const ours = await chain.createAta({ owner: c.dep.address, payer: feePayer });
        await storedMove({ orderId: c.dep.orderId, kind: "create" }, ours);
        c.trail.push(await readNow(c.dep.tokenAccount));
        await scanDeposit(deps(), c.dep, c.trail);
        expect((await ledger(c.dep.orderId)).deposit.rentPayer).toBe(stranger.address);
    });

    it("an unknown debit raises the alarm and review", async () => {
        const { dep, trail } = await deposit();
        await send(5_000n);
        expect((await scanNow(dep, trail)).invariant).toBe("held");
        const debit = chain.debit(TOKEN_A, 1_000n);
        expect((await scanNow(dep, trail)).invariant).toBe("below");
        expect(alarms("deposit_unknown_debit")).toEqual([
            expect.objectContaining({ orderId: ORDER_A, signature: debit, micros: "1000" }),
        ]);
        expect((await ledger()).deposit.reviewReason).toBe("unknown_debit");
        await scanDeposit(deps(), dep, trail);
        expect(alarms("deposit_unknown_debit")).toHaveLength(1);
    });

    it("a lagging index leaves the read above the ledger", async () => {
        const { dep, trail } = await deposit();
        const before = (await ledger()).deposit;
        const sig = await send(50_000n);
        chain.hideFromIndex(sig, 60_000);
        later(1_000);
        expect(await scanNow(dep, trail)).toMatchObject({ invariant: "above", complete: false });
        const after = (await ledger()).deposit;
        expect(after.balanceMicros).toBe(before.balanceMicros);
        expect(after.checkedAt).toEqual(before.checkedAt);
        expect(after.checkedSlot).toBe(before.checkedSlot);
        expect(alarms("deposit_index_lag")).toHaveLength(0);

        later(31_000);
        expect((await scanDeposit(deps(), dep, trail)).invariant).toBe("above");
        later(5_000);
        await scanDeposit(deps(), dep, trail);
        expect(alarms("deposit_index_lag")).toEqual([
            expect.objectContaining({ orderId: ORDER_A }),
        ]);
    });

    it("a missing transaction waits", async () => {
        const { dep, trail } = await deposit();
        const cursor = (await ledger()).deposit.lastSignature;
        const sig = await send(5_000n);
        chain.withholdTransaction(sig, 2);
        trail.push(await readNow());
        for (let i = 0; i < 2; i++) {
            expect((await scanDeposit(deps(), dep, trail)).complete).toBe(false);
            const l = await ledger();
            expect(l.transfers).toEqual([]);
            expect(l.deposit.lastSignature).toBe(cursor);
        }
        expect((await scanDeposit(deps(), dep, trail)).invariant).toBe("held");
        const l = await ledger();
        expect(l.transfers.map((t) => t.signature)).toEqual([sig]);
        expect(l.deposit.lastSignature).toBe(sig);
    });

    it("an undecodable transaction is recorded from its meta", async () => {
        const { dep, trail } = await deposit();
        const sig = await send(5_000n);
        chain.undecodable(sig);
        expect((await scanNow(dep, trail)).invariant).toBe("held");
        const l = await ledger();
        expect(l.transfers).toEqual([
            expect.objectContaining({
                signature: sig,
                amountMicros: 5_000,
                outcome: "review",
                reason: "unreadable",
                sourceTokenAccount: null,
                sourceOwner: null,
            }),
        ]);
        expect(alarms("deposit_review")).toEqual([
            expect.objectContaining({ orderId: ORDER_A, signature: sig, reason: "unreadable" }),
        ]);
        expect(l.deposit.lastSignature).toBe(sig);
    });

    it("an answer with no meta is never cached and is recorded only after two fetches 30 s apart", async () => {
        const { dep, trail } = await deposit();
        const sig = await send(5_000n);
        chain.badAnswer(sig, 3, { meta: "null" });
        trail.push(await readNow());
        let mark = chain.calls().length;
        expect((await scanDeposit(deps(), dep, trail)).complete).toBe(false);
        expect(callsSince(mark, "getTransaction")).toHaveLength(1);
        expect((await ledger()).transfers).toEqual([]);
        expect(cache.get(sig)).toBeUndefined();

        later(10_000);
        mark = chain.calls().length;
        await scanDeposit(deps(), dep, trail);
        expect(callsSince(mark, "getTransaction")).toHaveLength(1);
        expect((await ledger()).transfers).toEqual([]);

        later(21_000);
        expect((await scanDeposit(deps(), dep, trail)).invariant).toBe("held");
        expect((await ledger()).transfers).toEqual([
            expect.objectContaining({
                signature: sig,
                amountMicros: 5_000,
                outcome: "review",
                reason: "unreadable",
                sourceTokenAccount: null,
            }),
        ]);
        expect(cache.get(sig)).toBeUndefined();

        const whole = await send(4_000n);
        chain.badAnswer(whole, 1, { meta: "null" });
        trail.push(await readNow());
        expect((await scanDeposit(deps(), dep, trail)).complete).toBe(false);
        expect((await ledger()).transfers.map((t) => t.signature)).toEqual([sig]);
        expect((await scanDeposit(deps(), dep, trail)).invariant).toBe("held");
        expect((await ledger()).transfers[1]).toMatchObject({
            signature: whole,
            outcome: "open",
            sourceTokenAccount: payerAta,
            sourceOwner: payer.address,
        });
    });

    it("one fetch with no meta never records, however long its run lasts", async () => {
        const { dep, trail } = await deposit();
        for (let i = 0; i < 40; i++) await chain.noOp({ touching: TOKEN_A, signer: payer });
        const sig = await send(5_000n);
        chain.badAnswer(sig, 2, { meta: "null" });
        trail.push(await readNow());
        const mark = chain.calls().length;
        const fetchesOfSig = () =>
            callsSince(mark, "getTransaction").filter((c) => c.params[0] === sig);
        const run = async () => {
            for (;;) {
                later(1_000);
                const step = await scanStep(deps(), dep, trail);
                if (step.done) return step.result;
            }
        };

        const start = clock.getTime();
        expect((await run()).complete).toBe(false);
        expect(clock.getTime() - start).toBeGreaterThan(CFG.index_lag_alarm_after);
        expect(fetchesOfSig()).toHaveLength(1);
        expect((await ledger()).transfers).toEqual([]);

        expect((await run()).invariant).toBe("held");
        expect(fetchesOfSig()).toHaveLength(2);
        expect((await ledger()).transfers).toEqual([
            expect.objectContaining({
                signature: sig,
                amountMicros: 5_000,
                outcome: "review",
                reason: "unreadable",
            }),
        ]);
    });

    it("an interval left unexplained drops its cache entries", async () => {
        const { dep, trail } = await deposit();
        const sig = await send(7_000n);
        chain.badAnswer(sig, 1, { dropTokenEntryFor: TOKEN_A });
        for (let i = 0; i < 40; i++) await chain.noOp({ touching: TOKEN_A, signer: payer });
        trail.push(await readNow());

        let mark = chain.calls().length;
        expect((await scanDeposit(deps(), dep, trail)).complete).toBe(false);
        expect(callsSince(mark, "getTransaction")).toHaveLength(41);
        expect((await ledger()).transfers).toEqual([]);

        later(10_000);
        mark = chain.calls().length;
        expect((await scanDeposit(deps(), dep, trail)).complete).toBe(false);
        expect(callsSince(mark, "getTransaction")).toHaveLength(0);

        later(21_000);
        mark = chain.calls().length;
        expect((await scanDeposit(deps(), dep, trail)).invariant).toBe("held");
        expect(callsSince(mark, "getTransaction")).toHaveLength(41);
        expect((await ledger()).transfers.map((t) => [t.signature, t.amountMicros])).toEqual([
            [sig, 7_000],
        ]);
    });
});

describe("pure parts", () => {
    const read = (slot: bigint, micros: bigint): AccountRead => ({
        exists: true,
        micros,
        contextSlot: slot,
    });

    it("the trail merges when full", () => {
        const trail = new ReadTrail({ slot: 100n, micros: 5n });
        for (let i = 1n; i <= 70n; i++) trail.push(read(100n + i, i));
        const intervals = trail.intervals();
        expect(intervals).toHaveLength(63);
        expect(trail.anchor()).toEqual({ slot: 100n, micros: 5n });
        expect(intervals[0]!.from).toEqual({ slot: 100n, micros: 5n });
        expect(intervals[0]!.to.contextSlot).toBe(108n);
        expect(intervals[1]!.from).toEqual({ slot: 108n, micros: 8n });
        expect(intervals.at(-1)!.to.contextSlot).toBe(170n);

        trail.reanchor(150n, 50n);
        expect(trail.intervals()[0]!.from).toEqual({ slot: 150n, micros: 50n });
        expect(trail.intervals()).toHaveLength(20);
    });

    it("a trail with no anchor starts at the account's empty beginning", () => {
        const trail = new ReadTrail(null);
        trail.push(read(10n, 7n));
        trail.push(read(10n, 9n));
        expect(trail.intervals()).toEqual([{ from: { slot: 0n, micros: 0n }, to: read(10n, 7n) }]);
    });

    it("the cache keeps the newest", () => {
        const tx = (signature: string): CachedTx => ({
            signature,
            slot: 1n,
            blockTime: CREATED,
            failed: false,
            feePayer: null,
            signers: [],
            tokenAccounts: new Map(),
            ownerDeltas: new Map(),
            undecodable: false,
            noMeta: false,
        });
        const c = new TxCache(2);
        c.put(tx("a"));
        c.put(tx("b"));
        c.put(tx("c"));
        expect(c.get("a")).toBeUndefined();
        expect(c.get("b")?.signature).toBe("b");
        expect(c.get("c")?.signature).toBe("c");
        expect(c.size()).toBe(2);
        c.put({ ...tx("d"), noMeta: true });
        expect(c.get("d")).toBeUndefined();
        c.drop(["b"]);
        expect(c.size()).toBe(1);
    });

    const transfer = (slot: bigint, micros: number): TransferRow => ({
        orderId: ORDER_A,
        signature: `t${slot}-${micros}`,
        slot,
        seq: 0,
        blockTime: CREATED,
        seenAt: CREATED,
        amountMicros: micros,
        sourceTokenAccount: null,
        sourceOwner: null,
        sourceBalanceMicros: null,
        outcome: "open",
        appliedMicros: 0,
        reason: null,
        blockedUntil: null,
        moveId: null,
        refundId: null,
    });
    const move = (over: Partial<MoveRow>): MoveRow => ({
        id: 1,
        orderId: ORDER_A,
        kind: "return",
        amountMicros: 0,
        keepMicros: 0,
        heldMicros: 0,
        destination: null,
        payer: null,
        memo: null,
        closes: false,
        closeTo: null,
        state: "confirmed",
        txSignature: null,
        wireTx: null,
        lastValidBlockHeight: null,
        previousSignatures: [],
        attempts: 1,
        landedSlot: null,
        expirySeenSlot: null,
        preflightRefusedAt: null,
        manualReason: null,
        createdAt: CREATED,
        signedAt: null,
        sentAt: null,
        confirmedAt: null,
        failedAt: null,
        ...over,
    });

    it("expectedBalanceAt", () => {
        const transfers = [transfer(10n, 30_000), transfer(11n, 30_000)];
        const sweep = move({ kind: "sweep", amountMicros: 50_000, landedSlot: 12n });
        expect(expectedBalanceAt(transfers, [sweep], 12n)).toBe(10_000n);
        const failed = move({ amountMicros: 7_000, state: "failed" });
        expect(expectedBalanceAt(transfers, [sweep, failed], 12n)).toBe(10_000n);
        const close = move({
            kind: "close",
            keepMicros: 500,
            heldMicros: 7_000,
            closes: true,
            landedSlot: 13n,
        });
        expect(expectedBalanceAt(transfers, [close], 13n)).toBe(52_500n);
        expect(expectedBalanceAt(transfers, [close], 12n)).toBe(60_000n);
    });

    it("unexplainedIn", () => {
        const interval = { from: { slot: 10n, micros: 0n }, to: read(20n, 7_000n) };
        expect(unexplainedIn(interval, [], [])).toBe(7_000n);
        expect(unexplainedIn(interval, [transfer(15n, 7_000)], [])).toBe(0n);
        expect(unexplainedIn(interval, [transfer(10n, 7_000)], [])).toBe(7_000n);
        const unchanged = { from: { slot: 10n, micros: 7_000n }, to: read(20n, 7_000n) };
        const landed = move({ amountMicros: 2_000, landedSlot: 15n });
        expect(unexplainedIn(unchanged, [], [landed])).toBe(2_000n);
    });

    it("needsScan names every reason to scan", async () => {
        const { dep } = await deposit(ORDER_A, { create: false });
        const quiet: DepositRow = { ...dep, rentPayer: "Fee", scanSlot: 20n };
        const r = read(30n, 0n);
        expect(needsScan(quiet, r, [], [])).toBe(false);
        expect(needsScan(quiet, read(30n, 5n), [], [])).toBe(true);
        expect(needsScan({ ...quiet, balanceMicros: 5n }, r, [], [])).toBe(true);
        expect(needsScan({ ...quiet, scanTop: "x" }, r, [], [])).toBe(true);
        expect(needsScan({ ...quiet, rentPayer: null }, r, [], [])).toBe(true);
        expect(needsScan(quiet, r, [], [move({ state: "sent" })])).toBe(true);
        expect(needsScan(quiet, r, [], [move({ kind: "create", landedSlot: 25n })])).toBe(true);
        expect(needsScan(quiet, r, [], [move({ kind: "create", landedSlot: 15n })])).toBe(false);
    });

    it("stable_since follows the balance", async () => {
        await deposit(ORDER_A, { create: false });
        const at = (s: number) => new Date(T0.getTime() + s * 1_000);
        const row = async () => (await findDeposit(db.pool, ORDER_A))!;
        await recordRead(db.pool, await row(), read(10n, 100n), "held", at(1));
        expect((await row()).stableSince).toEqual(at(1));
        await recordRead(db.pool, await row(), read(11n, 100n), "held", at(2));
        expect(await row()).toMatchObject({
            stableSince: at(1),
            checkedAt: at(2),
            checkedSlot: 11n,
        });
        await recordRead(db.pool, await row(), read(12n, 200n), "held", at(3));
        expect((await row()).stableSince).toEqual(at(3));
        await recordRead(db.pool, await row(), read(13n, 300n), "above", at(4));
        expect(await row()).toMatchObject({
            stableSince: at(3),
            balanceMicros: 200n,
            checkedAt: at(3),
            checkedSlot: 12n,
        });
    });
});
