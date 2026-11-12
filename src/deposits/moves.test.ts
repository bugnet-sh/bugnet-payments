import {
    type Address,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getSignatureFromTransaction,
    getSolanaErrorFromJsonRpcError,
    getTransactionDecoder,
    type KeyPairSigner,
} from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { type Queryable, withTx } from "../db/pool.ts";
import { memoryLog } from "../log.ts";
import { findPaymentByOrder, lockPayment } from "../orders/store.ts";
import { readTokenAccount, usdcAta } from "../solana/accounts.ts";
import { MEMO_PROGRAM, TOKEN_PROGRAM } from "../solana/constants.ts";
import { RpcRouterError } from "../solana/router/errors.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { type FakeChain, startFakeChain } from "../testing/fake-chain.ts";
import { testSigner } from "../testing/keys.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import { DepositKeys } from "./keys.ts";
import { advanceMoves, guardRead, type MoveDeps, moveFeeLamports, type MoveTick } from "./moves.ts";
import { readDepositBalances, ReadTrail, scanDeposit, TxCache } from "./scan.ts";
import {
    depositLedger,
    ensureDeposit,
    findDeposit,
    findMove,
    insertMove,
    insertWriteOff,
    lockDeposit,
    setTransferOutcomes,
    updateDeposit,
} from "./store.ts";
import type { DepositRow, MoveRow, NewMove, TransferOutcome, TransferReason } from "./types.ts";
import { depositViewFrom } from "./view.ts";

const ORDER_A = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORDER_B = "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_A = "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley";
const TOKEN_A = "D2mAKdUVEHvizHThmG57bTCiASiiYj5gQbMeMoyWtQo1";
const CREATED = new Date("2030-01-01T00:00:00Z");
const EXPIRES = new Date("2030-01-01T00:15:00Z");
const T0 = new Date("2030-01-01T00:05:00Z");
const TIMEOUT = 10_000;

const keys = new DepositKeys(new Map([[1, Buffer.alloc(32, 7)]]), 1);

let db: TestDb;
let chain: FakeChain;
let clock: Date;
let log: ReturnType<typeof memoryLog>;
let cache: TxCache;
let cfg: Settings["deposits"];
let feePayer: KeyPairSigner;
let ownB: KeyPairSigner;
let ownC: KeyPairSigner;
let stranger: KeyPairSigner;
let recipient: KeyPairSigner;
let float: KeyPairSigner;
let srcB: string;
let srcC: string;
let recipientAta: string;
let floatAta: string;
let swept: { move: MoveRow; landed: { signature: string; slot: bigint } }[];
let hooked: { signature: string; inTx: string | null; outside: string | null }[];
let memoSeq = 0;

beforeAll(async () => {
    db = await testDb();
    [feePayer, ownB, ownC, stranger, recipient, float] = await Promise.all([
        testSigner(22),
        testSigner(32),
        testSigner(33),
        testSigner(35),
        testSigner(1),
        testSigner(5),
    ]);
    [srcB, srcC, recipientAta, floatAta] = await Promise.all([
        usdcAta(ownB.address),
        usdcAta(ownC.address),
        usdcAta(recipient.address),
        usdcAta(float.address),
    ]);
    cfg = parseSettings(`[solana]\nrecipient = "${recipient.address}"`, "t.toml").deposits;
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    chain = await startFakeChain();
    chain.setTokenAccount({ address: srcB, owner: ownB.address, amount: 1_000_000n });
    chain.setTokenAccount({ address: srcC, owner: ownC.address, amount: 1_000_000n });
    chain.setTokenAccount({ address: recipientAta, owner: recipient.address, amount: 0n });
    chain.setTokenAccount({ address: floatAta, owner: float.address, amount: 0n });
    clock = T0;
    log = memoryLog();
    cache = new TxCache(10_000);
    swept = [];
    hooked = [];
    await db.pool.query("truncate orders cascade");
});
afterEach(async () => {
    await chain.close();
});

const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
};

async function txSignatureIn(q: Queryable, id: number): Promise<string | null> {
    const { rows } = await q.query<{ tx_signature: string | null }>(
        "select tx_signature from deposit_moves where id = $1",
        [id],
    );
    return rows[0]?.tx_signature ?? null;
}

function deps(over: Partial<MoveDeps> = {}): MoveDeps {
    return {
        pool: db.pool,
        rpc: chain.rpc,
        feePayer,
        keys,
        cfg,
        recipientTokenAccount: recipientAta as Address,
        floatTokenAccount: floatAta as Address,
        hotTokenAccount: null,
        paid: null,
        rpcTimeoutMs: TIMEOUT,
        log,
        now: () => clock,
        cache,
        confirmSweep: async (_c, move, landed) => {
            swept.push({ move, landed });
        },
        // Records what the storing transaction and an outside reader see, and moves the payment
        // to the new signature as the real hook does
        onSweepSigned: async (c, move, signed) => {
            hooked.push({
                signature: signed.signature,
                inTx: await txSignatureIn(c, move.id),
                outside: await txSignatureIn(db.pool, move.id),
            });
            await c.query("update payments set tx_signature = $2 where order_id = $1", [
                move.orderId,
                signed.signature,
            ]);
        },
        ...over,
    };
}

const run = (d: MoveDeps = deps()): Promise<MoveTick> => advanceMoves(d);

async function deposit(id = ORDER_A, o: { create?: boolean } = {}): Promise<DepositRow> {
    const { order } = await seedOrder(db.pool, {
        id,
        amountMicros: 50_000,
        createdAt: CREATED,
        expiresAt: EXPIRES,
    });
    const dep = (await ensureDeposit(db.pool, keys, order, T0, () => Buffer.alloc(16, 1)))!;
    if (o.create !== false) await chain.createAta({ owner: dep.address, payer: feePayer });
    return dep;
}

// The memo keeps equal transfers apart, which would otherwise share one signature
const send = (micros: bigint, to: string, from: "B" | "C" = "B") => {
    const owner = from === "B" ? ownB : ownC;
    return chain.transfer({
        authority: owner,
        feePayer: owner,
        source: from === "B" ? srcB : srcC,
        destination: to,
        micros,
        memo: `t${++memoSeq}`,
    });
};

// Reads the account, moves to a new slot so nothing lands in the slot read, and scans
async function scan(orderId = ORDER_A) {
    const dep = (await findDeposit(db.pool, orderId))!;
    const trail = new ReadTrail(
        dep.checkedSlot === null ? null : { slot: dep.checkedSlot, micros: dep.balanceMicros },
    );
    const read = (
        await readDepositBalances(chain.rpc, [dep.tokenAccount as Address], {
            timeoutMs: TIMEOUT,
        })
    ).get(dep.tokenAccount)!;
    chain.advance(1);
    trail.push(read);
    return await scanDeposit(
        { pool: db.pool, rpc: chain.rpc, rpcTimeoutMs: TIMEOUT, cfg, cache, log, now: () => clock },
        dep,
        trail,
    );
}

// A deposit whose account the fee payer made, holding the given transfers, recorded by a scan
async function funded(
    transfers: { micros: bigint; from?: "B" | "C" }[],
    id = ORDER_A,
): Promise<{ dep: DepositRow; sigs: string[] }> {
    const made = await deposit(id);
    const sigs: string[] = [];
    for (const t of transfers) sigs.push(await send(t.micros, made.tokenAccount, t.from));
    expect((await scan(id)).invariant).toBe("held");
    return { dep: (await findDeposit(db.pool, id))!, sigs };
}

async function outcome(
    orderId: string,
    rows: { signature: string; outcome: TransferOutcome; reason: TransferReason }[],
) {
    await withTx(db.pool, (c) => setTransferOutcomes(c, orderId, rows));
}

// FakeChain lists every send that reached it, the test's own transfers included
const landing = (signature: string | null) =>
    chain.submitted().find((s) => s.signature === signature);

async function pending(
    m: Partial<NewMove> & Pick<NewMove, "kind">,
    transfers: string[] = [],
    orderId = ORDER_A,
): Promise<MoveRow> {
    return await withTx(db.pool, (c) =>
        insertMove(
            c,
            {
                orderId,
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
            transfers,
            clock,
        ),
    );
}

const returnTo = (
    micros: number,
    o: Partial<NewMove> = {},
): Partial<NewMove> & Pick<NewMove, "kind"> => ({
    kind: "return",
    amountMicros: micros,
    destination: srcB,
    payer: ownB.address,
    memo: `bugnet-return ${o.orderId ?? ORDER_A}`,
    ...o,
});

const closing = () => ({ closes: true, closeTo: feePayer.address });

const sweepOf = (o: Partial<NewMove> = {}): Partial<NewMove> & Pick<NewMove, "kind"> => ({
    kind: "sweep",
    amountMicros: 50_000,
    destination: recipientAta,
    memo: o.orderId ?? ORDER_A,
    ...o,
});

const moveRow = async (id: number) => (await findMove(db.pool, id))!;
const depositRow = async (id = ORDER_A) => (await findDeposit(db.pool, id))!;
const callsOf = (method: string, mark = 0) =>
    chain
        .calls()
        .slice(mark)
        .filter((c) => c.method === method);
const alarms = (name: string) => log.lines.filter((l) => l.alarm === name);

const decoded = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire));
const signatureOf = (wire: string) => getSignatureFromTransaction(decoded(wire));

function instructionsOf(wire: string) {
    const msg = getCompiledTransactionMessageDecoder().decode(decoded(wire).messageBytes);
    if (msg.version !== 0) throw new Error(`expected a v0 message, got ${msg.version}`);
    return msg.instructions.map((ix) => ({
        program: msg.staticAccounts[ix.programAddressIndex]!,
        data: new Uint8Array(ix.data ?? []),
    }));
}

const memosOf = (wire: string) =>
    instructionsOf(wire)
        .filter((ix) => ix.program === MEMO_PROGRAM)
        .map((ix) => new TextDecoder().decode(ix.data));

const closesIn = (wire: string) =>
    instructionsOf(wire).some((ix) => ix.program === TOKEN_PROGRAM && ix.data[0] === 9);

type Sent = { wire: string; config: Record<string, unknown> };
const forward = (wire: string, config: Record<string, unknown>): Promise<string> =>
    chain.rpc.sendTransaction(wire as never, config as never).send();

function onSend(
    fn: (wire: string, config: Record<string, unknown>, n: number) => Promise<string>,
    over: Record<string, unknown> = {},
): SolanaRpc {
    let n = 0;
    return new Proxy(chain.rpc, {
        get: (target, prop, recv) => {
            if (prop === "sendTransaction") {
                return (wire: string, config: Record<string, unknown>) => ({
                    send: () => fn(wire, config, n++),
                });
            }
            if (typeof prop === "string" && prop in over) return over[prop];
            return Reflect.get(target, prop, recv);
        },
    });
}

// The first send is lost on its way, as a dropped transaction is; later sends go through
function dropFirst(sends: Sent[] = []): SolanaRpc {
    return onSend(async (wire, config, n) => {
        sends.push({ wire, config });
        return n === 0 ? signatureOf(wire) : forward(wire, config);
    });
}

// Money that reaches the account after the guard read and before the transaction lands
function racing(micros: bigint, account = TOKEN_A): SolanaRpc {
    return onSend(async (wire, config, n) => {
        if (n === 0) chain.credit(account, micros);
        return forward(wire, config);
    });
}

// Past every stored blockhash, and finalized, so a missing status counts as expired
function expireAll() {
    chain.advance(160);
    chain.finalize();
    later(2_000);
}

const ledgerOf = async (id = ORDER_A) => {
    const l = (await depositLedger(db.pool, id))!;
    return { transfers: l.transfers, moves: l.moves, writeOffs: l.writeOffs };
};

describe("moveFeeLamports", () => {
    it("moveFeeLamports", () => {
        const fee = (kind: MoveRow["kind"], preflightRefusedAt: Date | null = null) =>
            moveFeeLamports({ kind, preflightRefusedAt }, cfg);
        expect(fee("create")).toBe(5_400n);
        expect(fee("sweep")).toBe(10_400n);
        expect(fee("return")).toBe(10_400n);
        expect(fee("close")).toBe(10_400n);
        expect(fee("return", T0)).toBe(0n);
        expect(fee("create", T0)).toBe(0n);
    });
});

describe("create", () => {
    it("create lands and readies the deposit", async () => {
        await deposit(ORDER_A, { create: false });
        const move = await pending({ kind: "create" });
        expect((await run()).signed).toBe(1);
        const signed = await moveRow(move.id);
        expect(signed.state).toBe("sent");
        expect(Object.keys(decoded(signed.wireTx!).signatures)).toEqual([feePayer.address]);
        expect(chain.accountExists(TOKEN_A)).toBe(true);

        later(2_000);
        expect((await run()).confirmed).toBe(1);
        const done = await moveRow(move.id);
        expect(done.state).toBe("confirmed");
        expect(done.landedSlot).not.toBeNull();
        const dep = await depositRow();
        expect(dep.readyAt).toEqual(clock);
        expect(dep.rentPayer).toBe(feePayer.address);
        expect(
            callsOf("getTransaction").filter((c) => c.params[0] === signed.txSignature),
        ).toHaveLength(1);
        const account = await readTokenAccount(chain.rpc, TOKEN_A as Address);
        expect(account.info?.owner).toBe(ADDRESS_A);
    });

    it("a create that lands as a no-op leaves rent_payer to the scan", async () => {
        await deposit(ORDER_A, { create: false });
        const move = await pending({ kind: "create" });
        const rpc = onSend(async (wire, config) => {
            await chain.createAta({ owner: ADDRESS_A, payer: stranger });
            return forward(wire, config);
        });
        await run(deps({ rpc }));
        later(2_000);
        expect((await run()).confirmed).toBe(1);
        expect((await moveRow(move.id)).state).toBe("confirmed");
        expect((await depositRow()).readyAt).not.toBeNull();
        expect((await depositRow()).rentPayer).toBeNull();
        await scan();
        expect((await depositRow()).rentPayer).toBe(stranger.address);

        const b = await deposit(ORDER_B, { create: false });
        const create = await pending({ kind: "create" }, [], ORDER_B);
        await run();
        chain.withholdTransaction((await moveRow(create.id)).txSignature!, 1);
        later(2_000);
        expect((await run()).confirmed).toBe(1);
        expect((await moveRow(create.id)).state).toBe("confirmed");
        expect((await depositRow(ORDER_B)).readyAt).not.toBeNull();
        expect((await depositRow(ORDER_B)).rentPayer).toBeNull();
        expect(chain.accountExists(b.tokenAccount)).toBe(true);
    });
});

describe("returns and closes", () => {
    it("return moves money to the source and closes", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        await outcome(ORDER_A, [{ signature: sigs[0]!, outcome: "return", reason: "unpaid" }]);
        const move = await pending(returnTo(7_000, closing()), sigs);
        const before = chain.balance(srcB);
        expect((await run()).signed).toBe(1);
        later(2_000);
        expect((await run()).confirmed).toBe(1);

        expect(chain.balance(srcB) - before).toBe(7_000n);
        expect(chain.accountExists(TOKEN_A)).toBe(false);
        const done = await moveRow(move.id);
        expect(done.state).toBe("confirmed");
        expect(done.landedSlot).not.toBeNull();
        expect(memosOf(done.wireTx!)).toEqual([`bugnet-return ${ORDER_A}`]);
    });

    it("kept and held money ride in the closing move", async () => {
        const { sigs } = await funded([
            { micros: 7_000n },
            { micros: 500n, from: "C" },
            { micros: 7_000n, from: "C" },
        ]);
        const [returned, kept, held] = sigs as [string, string, string];
        await outcome(ORDER_A, [
            { signature: returned, outcome: "return", reason: "unpaid" },
            { signature: kept, outcome: "keep", reason: "below_minimum" },
            { signature: held, outcome: "review", reason: "unattributed" },
        ]);
        const move = await pending(
            returnTo(7_000, { keepMicros: 500, heldMicros: 7_000, ...closing() }),
            sigs,
        );
        const source = chain.balance(srcB);
        await run();
        later(2_000);
        expect((await run()).confirmed).toBe(1);

        expect(chain.balance(srcB) - source).toBe(7_000n);
        expect(chain.balance(recipientAta)).toBe(500n);
        expect(chain.balance(floatAta)).toBe(7_000n);
        expect(chain.accountExists(TOKEN_A)).toBe(false);
        const done = await moveRow(move.id);
        expect(memosOf(done.wireTx!)).toEqual([
            `bugnet-return ${ORDER_A}`,
            `bugnet-kept ${ORDER_A}`,
            `bugnet-held ${ORDER_A}`,
        ]);
        expect(closesIn(done.wireTx!)).toBe(true);
    });

    it("return to an invalid destination puts its transfers in review", async () => {
        const { sigs } = await funded([{ micros: 7_000n }, { micros: 5_000n, from: "C" }]);
        const [fromB, fromC] = sigs as [string, string];
        await outcome(ORDER_A, [
            { signature: fromB, outcome: "return", reason: "unpaid" },
            { signature: fromC, outcome: "return", reason: "unpaid" },
        ]);
        const bad = await pending(returnTo(7_000, { payer: ownC.address }), [fromB]);
        const mark = chain.calls().length;
        expect((await run()).dropped).toBe(1);

        expect(await findMove(db.pool, bad.id)).toBeNull();
        const t = (await ledgerOf()).transfers.find((r) => r.signature === fromB)!;
        expect(t).toMatchObject({
            outcome: "review",
            reason: "return_destination_invalid",
            moveId: null,
        });
        expect((await depositRow()).reviewReason).toBeNull();
        expect(alarms("deposit_review")).toHaveLength(1);
        expect(alarms("deposit_review")[0]).toMatchObject({
            orderId: ORDER_A,
            signatures: [fromB],
            reason: "return_destination_invalid",
        });
        expect(callsOf("sendTransaction", mark)).toHaveLength(0);

        const next = await pending(returnTo(5_000, { destination: srcC, payer: ownC.address }), [
            fromC,
        ]);
        expect((await run()).signed).toBe(1);
        expect((await moveRow(next.id)).state).toBe("sent");
        expect(alarms("deposit_review")).toHaveLength(1);
    });

    it("an invalid destination leaves kept money from the same account kept", async () => {
        const { sigs } = await funded([{ micros: 7_000n }, { micros: 500n }]);
        const [owed, dust] = sigs as [string, string];
        await outcome(ORDER_A, [
            { signature: owed, outcome: "return", reason: "unpaid" },
            { signature: dust, outcome: "keep", reason: "below_minimum" },
        ]);
        await pending(
            returnTo(7_000, {
                payer: ownC.address,
                keepMicros: 500,
                closes: true,
                closeTo: feePayer.address,
            }),
            [owed, dust],
        );
        expect((await run()).dropped).toBe(1);
        const bySig = new Map((await ledgerOf()).transfers.map((t) => [t.signature, t]));
        expect(bySig.get(owed)).toMatchObject({
            outcome: "review",
            reason: "return_destination_invalid",
            moveId: null,
        });
        expect(bySig.get(dust)).toMatchObject({
            outcome: "keep",
            reason: "below_minimum",
            moveId: null,
        });
    });

    it("a paid transfer whose rest cannot go back still counts", async () => {
        const { sigs } = await funded([{ micros: 60_000n }]);
        const crossing = sigs[0]!;
        await withTx(db.pool, (c) =>
            setTransferOutcomes(c, ORDER_A, [
                { signature: crossing, outcome: "paid", reason: "extra", appliedMicros: 50_000 },
            ]),
        );
        await pending(returnTo(10_000, { payer: ownC.address }), [crossing]);
        expect((await run()).dropped).toBe(1);

        const t = (await ledgerOf()).transfers[0]!;
        expect(t).toMatchObject({
            outcome: "review",
            reason: "return_destination_invalid",
            appliedMicros: 50_000,
            moveId: null,
        });
        await withTx(db.pool, (c) => updateDeposit(c, ORDER_A, { settledAt: clock }));
        const paid = { state: "paid" as const, amountMicros: 50_000, expiresAt: EXPIRES };
        const v = depositViewFrom(paid, (await depositLedger(db.pool, ORDER_A))!, clock, cfg);
        expect(v).toMatchObject({
            status: "paid",
            receivedMicros: 60_000,
            remainingMicros: 0,
            extraMicros: 0,
            reviewMicros: 10_000,
            reason: "return_destination_invalid",
            reasonMicros: 10_000,
        });
        expect(v.transfers[0]!.outcome).toBe("counted");
    });
});

describe("the guard", () => {
    it("the guard read is pinned", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        const transferSlot = (await ledgerOf()).transfers[0]!.slot;
        const move = await pending(returnTo(7_000, closing()), sigs);
        chain.lagNode(3, { refuse: true });
        const mark = chain.calls().length;
        await run();
        const guard = callsOf("getMultipleAccounts", mark);
        expect(guard).toHaveLength(1);
        const pin = (guard[0]!.params[1] as { minContextSlot: number }).minContextSlot;
        expect(BigInt(pin)).toBeGreaterThanOrEqual(transferSlot);
        expect(callsOf("sendTransaction", mark)).toHaveLength(0);
        expect((await moveRow(move.id)).state).toBe("pending");
        expect((await depositRow()).reviewReason).toBeNull();

        chain.lagNode(0);
        expect((await run()).signed).toBe(1);
        expect((await moveRow(move.id)).state).toBe("sent");
    });

    it("the guard read is pinned to the newest landed move too", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        // On a real chain a move lands after the read the job holds; FakeChain lands it in that
        // slot, so the rows say so directly
        const landedAt = (await depositRow()).checkedSlot! + 3n;
        chain.advance(10);
        const create = await pending({ kind: "create" });
        await db.pool.query(
            `update deposit_moves set state = 'confirmed', confirmed_at = $2, landed_slot = $3,
                tx_signature = 'landed-create', attempts = 1
             where id = $1`,
            [create.id, clock, landedAt.toString()],
        );
        await pending(returnTo(7_000), sigs);
        const mark = chain.calls().length;
        await run();
        const guard = callsOf("getMultipleAccounts", mark);
        expect(guard).toHaveLength(1);
        expect((guard[0]!.params[1] as { minContextSlot: number }).minContextSlot).toBe(
            Number(landedAt),
        );
    });

    it("a low pinned read is an invariant failure, not review", async () => {
        const { dep, sigs } = await funded([{ micros: 7_000n }]);
        chain.debit(TOKEN_A, 1_000n);
        const move = await pending(returnTo(7_000), sigs);
        const verdict = await guardRead(deps(), dep, move, await ledgerOf());
        expect(verdict.verdict).toBe("below_ledger");
        expect(verdict.micros).toBe(6_000n);

        const mark = chain.calls().length;
        expect((await run()).signed).toBe(0);
        expect(callsOf("sendTransaction", mark)).toHaveLength(0);
        expect((await moveRow(move.id)).state).toBe("pending");
        expect((await depositRow()).reviewReason).toBeNull();
    });

    it("the guard counts a written-off debit and pins to its slot", async () => {
        const { dep, sigs } = await funded([{ micros: 7_000n }]);
        const debit = chain.debit(TOKEN_A, 1_000n);
        const { value } = await chain.rpc
            .getSignatureStatuses([debit as never], { searchTransactionHistory: true })
            .send();
        const slot = BigInt(value[0]!.slot);
        chain.advance(3);
        await withTx(db.pool, (c) =>
            insertWriteOff(
                c,
                { orderId: ORDER_A, signature: debit, slot, micros: 1_000, writtenAt: clock },
                [{ transferSignature: sigs[0]!, micros: 1_000, refundId: null }],
            ),
        );
        const move = await pending(returnTo(6_000), sigs);
        const mark = chain.calls().length;
        const verdict = await guardRead(deps(), dep, move, await ledgerOf());
        expect(verdict).toMatchObject({ verdict: "sign", micros: 6_000n });
        const guard = callsOf("getMultipleAccounts", mark);
        expect(
            (guard[0]!.params[1] as { minContextSlot: number }).minContextSlot,
        ).toBeGreaterThanOrEqual(Number(slot));
    });

    it("a closing move is never signed against new money", async () => {
        const { dep, sigs } = await funded([{ micros: 7_000n }]);
        chain.credit(TOKEN_A, 1n);
        const move = await pending(returnTo(7_000, closing()), sigs);
        const mark = chain.calls().length;
        expect((await run()).dropped).toBe(1);
        expect(await findMove(db.pool, move.id)).toBeNull();
        expect((await ledgerOf()).transfers[0]!.moveId).toBeNull();

        const again = await pending(returnTo(7_000, closing()), sigs);
        const verdict = await guardRead(deps(), dep, again, await ledgerOf());
        expect(verdict).toMatchObject({ verdict: "dropped", micros: 7_001n });
        expect(await findMove(db.pool, again.id)).toBeNull();
        expect((await ledgerOf()).transfers[0]!.moveId).toBeNull();
        expect(callsOf("sendTransaction", mark)).toHaveLength(0);
    });

    it("blockhash and send are pinned to the guard slot", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        await pending(returnTo(7_000, closing()), sigs);
        chain.advance(5);
        chain.lagNode(3);
        const guardSlot = chain.slot() - 3n;
        const mark = chain.calls().length;
        expect((await run()).signed).toBe(1);
        const blockhash = callsOf("getLatestBlockhash", mark);
        expect(blockhash).toHaveLength(1);
        expect(blockhash[0]!.params[0]).toMatchObject({
            commitment: "confirmed",
            minContextSlot: Number(guardSlot),
        });
        const sent = callsOf("sendTransaction", mark);
        expect(sent).toHaveLength(1);
        // The lagging node answers the blockhash at the guard's slot, so the max is that slot
        expect(sent[0]!.params[1]).toMatchObject({
            encoding: "base64",
            preflightCommitment: "confirmed",
            minContextSlot: Number(guardSlot),
        });

        chain.lagNode(0);
        const b = await funded([{ micros: 7_000n, from: "C" }], ORDER_B);
        const move = await pending(
            returnTo(7_000, {
                orderId: ORDER_B,
                destination: srcC,
                payer: ownC.address,
                ...closing(),
            }),
            b.sigs,
            ORDER_B,
        );
        chain.lagNode(3, { refuse: true, methods: ["getLatestBlockhash"] });
        const before = chain.calls().length;
        expect((await run()).signed).toBe(0);
        expect(callsOf("getLatestBlockhash", before)).toHaveLength(1);
        expect(callsOf("sendTransaction", before)).toHaveLength(0);
        expect((await moveRow(move.id)).state).toBe("pending");
    });

    it("sweep signing takes the payment and order locks first", async () => {
        await funded([{ micros: 50_000n }]);
        await db.pool.query("update orders set state = 'settling' where id = $1", [ORDER_A]);
        await seedPayment(db.pool, ORDER_A, { txSignature: "seeded" });
        const move = await pending(sweepOf());
        await run(deps({ rpc: dropFirst() }));
        const first = (await moveRow(move.id)).txSignature!;
        expect((await findPaymentByOrder(db.pool, ORDER_A))!.txSignature).toBe(first);
        expireAll();

        const c = await db.pool.connect();
        let failure: unknown = null;
        let tick: MoveTick | null = null;
        try {
            await c.query("begin");
            await lockPayment(c, ORDER_A);
            const advancing = run();
            await waitForLockWait();
            await lockDeposit(c, ORDER_A);
            await c.query("commit");
            tick = await advancing;
        } catch (err) {
            failure = err;
            await c.query("rollback").catch(() => {});
        } finally {
            c.release();
        }
        expect(failure).toBeNull();
        expect(tick?.resigned).toBe(1);
        expect(log.lines.filter((l) => String(l.msg).includes("deadlock"))).toHaveLength(0);
        const resigned = await moveRow(move.id);
        expect(resigned.previousSignatures).toEqual([first]);
        expect((await findPaymentByOrder(db.pool, ORDER_A))!.txSignature).toBe(
            resigned.txSignature,
        );
    });
});

async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 300; i++) {
        const { rows } = await db.pool.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if (rows[0]!.n > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("nothing waited on a lock");
}

describe("resends", () => {
    it("not_found younger than resend_after waits", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        const move = await pending(returnTo(7_000, closing()), sigs);
        const sends: Sent[] = [];
        const d = deps({ rpc: dropFirst(sends) });
        await run(d);
        const stored = await moveRow(move.id);
        expect(stored.state).toBe("sent");

        later(3_000);
        expect((await run(d)).resent).toBe(0);
        expect(sends).toHaveLength(1);

        later(8_000);
        expect((await run(d)).resent).toBe(1);
        expect(sends).toHaveLength(2);
        expect(sends[1]!.wire).toBe(stored.wireTx);
        expect(sends[1]!.config).toMatchObject({ encoding: "base64", skipPreflight: true });
        expect(landing(stored.txSignature)?.failed).toBe(false);
    });

    it("with the second quorum endpoint down, a dropped return is resent after 10 s", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        const move = await pending(returnTo(7_000, closing()), sigs);
        const sends: Sent[] = [];
        let n = 0;
        // The router while its second quorum endpoint is down: the one answer it has, unproven
        const rpc = onSend(
            async (wire, config) => {
                sends.push({ wire, config });
                return n++ === 0 ? signatureOf(wire) : forward(wire, config);
            },
            {
                getSignatureStatuses: (sigs: readonly string[]) => ({
                    send: async () => {
                        throw new RpcRouterError("absence_unconfirmed", undefined, {
                            jsonrpc: "2.0",
                            id: 1,
                            result: {
                                context: { slot: chain.slot() },
                                value: sigs.map(() => null),
                            },
                        });
                    },
                }),
            },
        );
        const d = deps({ rpc });
        await run(d);
        const stored = await moveRow(move.id);

        later(3_000);
        expect((await run(d)).resent).toBe(0);
        expect(sends).toHaveLength(1);

        await db.pool.query("update deposit_moves set preflight_refused_at = $2 where id = $1", [
            move.id,
            clock,
        ]);
        later(8_000);
        expect((await run(d)).resent).toBe(0);
        expect(sends).toHaveLength(1);
        await db.pool.query("update deposit_moves set preflight_refused_at = null where id = $1", [
            move.id,
        ]);

        expect((await run(d)).resent).toBe(1);
        expect(sends).toHaveLength(2);
        expect(sends[1]!.wire).toBe(stored.wireTx);
        expect(sends[1]!.config).toMatchObject({ skipPreflight: true, maxRetries: 0n });
        const after = await moveRow(move.id);
        expect(after).toMatchObject({ state: "sent", expirySeenSlot: null, attempts: 1 });
        expect(landing(stored.txSignature)?.failed).toBe(false);

        // Past the blockhash an unproven absence is no proof, so nothing is re-signed
        chain.advance(200);
        chain.finalize();
        later(11_000);
        expect((await run(d)).resigned).toBe(0);
        expect(log.lines).toContainEqual(
            expect.objectContaining({
                msg: "deposit move rpc call failed, retrying next tick",
                reason: "absence_unconfirmed",
            }),
        );
        expect(sends).toHaveLength(2);
        expect(await moveRow(move.id)).toMatchObject({
            state: "sent",
            txSignature: stored.txSignature,
            expirySeenSlot: null,
            attempts: 1,
        });
    });
});

describe("expiry", () => {
    it("expired blockhash re-signs only with the deposit's proof", async () => {
        await funded([{ micros: 50_000n }]);
        const sweep = await pending(sweepOf());
        await run();
        const landed = (await moveRow(sweep.id)).txSignature!;
        chain.hideFromStatus(landed);

        const b = await funded([{ micros: 7_000n, from: "C" }], ORDER_B);
        const ret = await pending(
            returnTo(7_000, { orderId: ORDER_B, destination: srcC, payer: ownC.address }),
            b.sigs,
            ORDER_B,
        );
        const sends: Sent[] = [];
        await run(deps({ rpc: dropFirst(sends) }));
        const old = (await moveRow(ret.id)).txSignature!;
        const credit = chain.credit(b.dep.tokenAccount, 1n);
        chain.withholdTransaction(credit, 1);
        expireAll();

        const recorded = deps({
            rpc: onSend(async (wire, config) => {
                sends.push({ wire, config });
                return forward(wire, config);
            }),
        });
        const tick = await run(recorded);
        expect(tick).toMatchObject({ confirmed: 1, resigned: 0, waitingProof: 1 });
        expect(swept).toHaveLength(1);
        expect(swept[0]!.landed.signature).toBe(landed);
        expect(swept[0]!.move.id).toBe(sweep.id);
        expect((await moveRow(sweep.id)).attempts).toBe(1);
        expect(sends).toHaveLength(1);
        const waiting = await moveRow(ret.id);
        expect(waiting.txSignature).toBe(old);
        expect(waiting.expirySeenSlot).not.toBeNull();

        expect((await run(recorded)).resigned).toBe(1);
        expect(sends).toHaveLength(2);
        const resigned = await moveRow(ret.id);
        expect(resigned.txSignature).not.toBe(old);
        expect(resigned.previousSignatures).toEqual([old]);
        expect(resigned.attempts).toBe(2);
        // The new attempt pins its own expiry, so a proof never reads below its landing
        expect(resigned.expirySeenSlot).toBeNull();
    });

    it("a statuses answer short of one entry per signature is asked again, not expired", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        const move = await pending(returnTo(7_000), sigs);
        await run(deps({ rpc: dropFirst() }));
        const old = (await moveRow(move.id)).txSignature!;
        expireAll();

        // Past the blockhash, a missing entry read as null would start the expiry and its proof
        const short = onSend(forward, {
            getSignatureStatuses: (asked: readonly string[]) => ({
                send: async () => ({
                    context: { slot: chain.slot() },
                    value: asked.slice(1).map(() => null),
                }),
            }),
        });
        const mark = chain.calls().length;
        const tick = await run(deps({ rpc: short }));
        expect(tick).toMatchObject({ resent: 0, resigned: 0, failed: 0, waitingProof: 0 });
        expect(log.lines).toContainEqual(
            expect.objectContaining({
                msg: "deposit move rpc call failed, retrying next tick",
                moveId: move.id,
            }),
        );
        expect(await moveRow(move.id)).toMatchObject({
            state: "sent",
            txSignature: old,
            expirySeenSlot: null,
            attempts: 1,
        });
        expect(callsOf("getSignaturesForAddress", mark)).toHaveLength(0);

        expect((await run()).resigned).toBe(1);
        expect((await moveRow(move.id)).previousSignatures).toEqual([old]);
    });

    it("a proof whose listing spans several ticks goes on where it stopped", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        const move = await pending(returnTo(7_000), sigs);
        await run(deps({ rpc: dropFirst() }));
        const old = (await moveRow(move.id)).txSignature!;
        for (let i = 0; i < 3; i++) chain.credit(TOKEN_A, 1n);
        expireAll();

        const d = deps({ cfg: { ...cfg, scan_page_size: 1, scan_max_pages: 1 } });
        const mark = chain.calls().length;
        const ticks: MoveTick[] = [];
        while (ticks.length < 8 && ticks.at(-1)?.resigned !== 1) ticks.push(await run(d));
        expect(ticks.map((t) => [t.waitingProof, t.resigned])).toEqual([
            [1, 0],
            [1, 0],
            [1, 0],
            [0, 1],
        ]);
        const resigned = await moveRow(move.id);
        expect(resigned.previousSignatures).toEqual([old]);
        expect(resigned.attempts).toBe(2);
        expect((await ledgerOf()).transfers).toHaveLength(4);
        // Four pages of one entry and the completeness call, never the top again
        expect(callsOf("getSignaturesForAddress", mark)).toHaveLength(5);
        // The proof's one read, then the new attempt's guard read
        expect(callsOf("getMultipleAccounts", mark)).toHaveLength(2);
    });

    it("a proof's scan stops at the scan time box and goes on next tick", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        const move = await pending(returnTo(7_000), sigs);
        await run(deps({ rpc: dropFirst() }));
        const old = (await moveRow(move.id)).txSignature!;
        // New money, then padding beside it: the proof fetches every padding entry first
        chain.credit(TOKEN_A, 1n);
        for (let i = 0; i < 60; i++) await chain.noOp({ touching: TOKEN_A, signer: stranger });
        expireAll();

        // Each call costs 100 ms of the clock, as a rate-limited lane does
        const slow = new Proxy(chain.rpc, {
            get: (target, prop, recv) => {
                const value: unknown = Reflect.get(target, prop, recv);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                    const call = (
                        value as (...a: unknown[]) => { send: (...a: unknown[]) => unknown }
                    ).apply(target, args);
                    return {
                        ...call,
                        send: (...a: unknown[]) => {
                            later(100);
                            return call.send(...a);
                        },
                    };
                };
            },
        });
        const d = deps({ rpc: slow, cfg: { ...cfg, scan_time_box: 1_500 } });
        const fetches: number[] = [];
        let last: MoveTick | undefined;
        while (fetches.length < 12 && last?.resigned !== 1) {
            const mark = chain.calls().length;
            last = await run(d);
            fetches.push(callsOf("getTransaction", mark).length);
        }
        // Within one box of 1.5 s plus the call that crosses it, and done over several ticks
        expect(Math.max(...fetches)).toBeLessThanOrEqual(16);
        expect(fetches.length).toBeGreaterThan(3);
        expect(last!.resigned).toBe(1);
        expect((await moveRow(move.id)).previousSignatures).toEqual([old]);
    });

    it("every sweep signing calls the payments hook", async () => {
        await funded([{ micros: 50_000n }]);
        await seedPayment(db.pool, ORDER_A, { txSignature: "seeded" });
        const move = await pending(sweepOf());
        await run(deps({ rpc: dropFirst() }));
        const first = (await moveRow(move.id)).txSignature!;
        expect(hooked).toEqual([{ signature: first, inTx: first, outside: null }]);
        expireAll();

        expect((await run()).resigned).toBe(1);
        const second = (await moveRow(move.id)).txSignature!;
        expect(hooked).toHaveLength(2);
        expect(hooked[1]).toEqual({ signature: second, inTx: second, outside: first });

        await funded([{ micros: 50_000n, from: "C" }], ORDER_B);
        const failed = await pending(sweepOf({ orderId: ORDER_B }), [], ORDER_B);
        await db.pool.query(
            "update deposit_moves set state = 'failed', failed_at = $2 where id = $1",
            [failed.id, clock],
        );
        const next = await pending(sweepOf({ orderId: ORDER_B }), [], ORDER_B);
        expect((await run()).signed).toBe(1);
        const signed = (await moveRow(next.id)).txSignature!;
        expect(hooked).toHaveLength(3);
        expect(hooked[2]).toEqual({ signature: signed, inTx: signed, outside: null });
    });

    it("re-signing stops at max_attempts", async () => {
        await funded([{ micros: 50_000n }]);
        const sweep = await pending(sweepOf());
        const b = await funded([{ micros: 7_000n, from: "C" }], ORDER_B);
        const ret = await pending(
            returnTo(7_000, { orderId: ORDER_B, destination: srcC, payer: ownC.address }),
            b.sigs,
            ORDER_B,
        );
        const d = deps({ rpc: onSend(async (wire) => signatureOf(wire)) });
        expect((await run(d)).signed).toBe(2);
        await db.pool.query("update deposit_moves set attempts = 3 where id = any($1::bigint[])", [
            [sweep.id, ret.id],
        ]);
        expireAll();

        const tick = await run(d);
        expect(tick).toMatchObject({ manual: 1, failed: 1, resigned: 0 });
        expect(await moveRow(sweep.id)).toMatchObject({
            state: "manual",
            manualReason: "move_expired_repeatedly",
            landedSlot: null,
        });
        expect((await depositRow()).reviewReason).toBe("move_expired_repeatedly");
        expect(await moveRow(ret.id)).toMatchObject({ state: "failed", landedSlot: null });
        expect((await depositRow(ORDER_B)).reviewReason).toBeNull();
    });
});

describe("refusals and races", () => {
    it("a preflight refusal is never resent and fails at no cost", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        await outcome(ORDER_A, [{ signature: sigs[0]!, outcome: "return", reason: "unpaid" }]);
        const move = await pending(returnTo(7_000, closing()), sigs);
        chain.preflight(true);
        const sends: Sent[] = [];
        const rpc = onSend(async (wire, config, n) => {
            sends.push({ wire, config });
            if (n === 0) chain.credit(TOKEN_A, 1n);
            return forward(wire, config);
        });
        const d = deps({ rpc });
        await run(d);
        const refused = await moveRow(move.id);
        expect(refused.state).toBe("signed");
        expect(refused.preflightRefusedAt).toEqual(clock);
        expect(landing(refused.txSignature)).toBeUndefined();

        later(11_000);
        expect((await run(d)).resent).toBe(0);
        expect(sends).toHaveLength(1);

        expireAll();
        expect((await run(d)).failed).toBe(1);
        const failed = await moveRow(move.id);
        expect(failed.state).toBe("failed");
        expect(failed.preflightRefusedAt).not.toBeNull();
        expect(failed.landedSlot).toBeNull();
        expect(moveFeeLamports(failed, cfg)).toBe(0n);
        expect((await depositRow()).closeSeparately).toBe(true);
        expect(sends).toHaveLength(1);
    });

    it("a refusal forwarded anyway counts its fee", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        const move = await pending(returnTo(7_000, closing()), sigs);
        const sends: Sent[] = [];
        // A URL that retries upstreams inside forwards the move, then answers another upstream's
        // simulation, which refused the close
        const rpc = onSend(async (wire, config, n) => {
            sends.push({ wire, config });
            if (n > 0) return forward(wire, config);
            chain.credit(TOKEN_A, 1n);
            await forward(wire, { encoding: "base64", skipPreflight: true });
            throw getSolanaErrorFromJsonRpcError({
                code: -32002,
                message:
                    "Transaction simulation failed: Error processing Instruction 4: custom program error: 0x1",
                data: {
                    err: { InstructionError: [4, { Custom: 1 }] },
                    logs: [],
                    accounts: null,
                    unitsConsumed: 0,
                    returnData: null,
                },
            });
        });
        const d = deps({ rpc });
        await run(d);
        const refused = await moveRow(move.id);
        expect(refused.state).toBe("signed");
        expect(refused.preflightRefusedAt).not.toBeNull();
        expect(landing(refused.txSignature)?.failed).toBe(true);

        later(2_000);
        expect((await run(d)).failed).toBe(1);
        const failed = await moveRow(move.id);
        expect(failed.state).toBe("failed");
        expect(failed.preflightRefusedAt).toBeNull();
        expect(failed.landedSlot).toBeNull();
        expect(moveFeeLamports(failed, cfg)).toBe(10_400n);
        expect((await depositRow()).closeSeparately).toBe(true);
        expect(sends).toHaveLength(1);
    });

    it("a closing move that loses the race closes separately later", async () => {
        const { sigs } = await funded([{ micros: 7_000n }]);
        const move = await pending(returnTo(7_000, closing()), sigs);
        const d = deps({ rpc: racing(1_000n) });
        await run(d);
        expect(landing((await moveRow(move.id)).txSignature)?.failed).toBe(true);
        later(2_000);
        expect((await run(d)).failed).toBe(1);

        const failed = await moveRow(move.id);
        expect(failed.state).toBe("failed");
        expect(failed.landedSlot).toBeNull();
        expect(failed.failedAt).toEqual(clock);
        const dep = await depositRow();
        expect(dep.closeSeparately).toBe(true);
        expect(dep.reviewReason).toBeNull();
        expect(chain.accountExists(TOKEN_A)).toBe(true);
        await expect(pending(returnTo(7_000), sigs)).resolves.toMatchObject({ state: "pending" });
    });

    it("a failed close backs off and never reviews", async () => {
        const { sigs } = await funded([{ micros: 500n }]);
        await outcome(ORDER_A, [{ signature: sigs[0]!, outcome: "keep", reason: "below_minimum" }]);
        const backoff = [120_000, 600_000, 3_600_000];
        let kept = 500;
        for (const [i, delay] of backoff.entries()) {
            const carried = (await ledgerOf()).transfers.map((t) => t.signature);
            const move = await pending({ kind: "close", keepMicros: kept, ...closing() }, carried);
            const d = deps({ rpc: racing(1n) });
            expect((await run(d)).signed).toBe(1);
            later(2_000);
            expect((await run(d)).failed).toBe(1);
            expect((await moveRow(move.id)).state).toBe("failed");
            const dep = await depositRow();
            expect(dep.closeFailures).toBe(i + 1);
            expect(dep.closeAfter).toEqual(new Date(clock.getTime() + delay));
            expect(dep.closeSeparately).toBe(false);
            expect(dep.reviewReason).toBeNull();

            await scan();
            const fresh = (await ledgerOf()).transfers.filter((t) => t.outcome === "open");
            await outcome(
                ORDER_A,
                fresh.map((t) => ({
                    signature: t.signature,
                    outcome: "keep",
                    reason: "below_minimum",
                })),
            );
            kept += 1;
        }
        expect((await depositRow()).reviewReason).toBeNull();
        expect(alarms("deposit_review")).toHaveLength(0);
    });
});
