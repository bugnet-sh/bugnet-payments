import { create } from "@bufbuild/protobuf";
import { DurationSchema, TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
    type Address,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getSignatureFromTransaction,
    getTransactionDecoder,
    type KeyPairSigner,
    signature as toSignature,
} from "@solana/kit";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    expectTypeOf,
    it,
} from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { PayerVerdict } from "../gen/bugnet/router/v1/payments_pb.ts";
import { auditInflows } from "../jobs/audit.ts";
import { memoryLog, silentLog } from "../log.ts";
import { findOrder, findPaymentByOrder } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { createRouterClient, type RouterClient } from "../router/client.ts";
import { usdcAta } from "../solana/accounts.ts";
import { TOKEN_PROGRAM } from "../solana/constants.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { type FakeChain, startFakeChain } from "../testing/fake-chain.ts";
import { type FakeRouter, startFakeRouter } from "../testing/fake-router.ts";
import { testSigner } from "../testing/keys.ts";
import { seedAllowanceOrder, seedOrder } from "../testing/orders.ts";
import { resetLedger, seedAccount, TEST_HANDLE_SHA256 } from "../testing/x402.ts";
import { createAllowanceFunding } from "../x402/funding.ts";
import { matchInTx, parseChainTx } from "../x402/match.ts";
import type { PaidDeps } from "../x402/paid.ts";
import { DepositKeys } from "./keys.ts";
import { advanceMoves, type MoveDeps, type MoveTick } from "./moves.ts";
import { type Plan, planDeposit } from "./plan.ts";
import { expectedBalanceAt, readDepositBalances, ReadTrail, scanDeposit, TxCache } from "./scan.ts";
import type { ScanResult } from "./scan.ts";
import { type SettleDeps, settleDeposit, sweepHooks } from "./settle.ts";
import {
    clearHolds,
    depositLedger,
    ensureDeposit,
    findDeposit,
    holdsOf,
    insertMove,
    insertWriteOff,
    setTransferOutcomes,
    sharesOf,
    updateDeposit,
} from "./store.ts";
import type { DepositRow, MoveRow, TransferRow } from "./types.ts";

const ORDER_A = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORDER_B = "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN_A = "D2mAKdUVEHvizHThmG57bTCiASiiYj5gQbMeMoyWtQo1";
const CREATED = new Date("2030-01-01T00:00:00Z");
const EXPIRES = new Date("2030-01-01T00:15:00Z");
const PAID_AT = new Date("2030-01-01T00:04:00Z");
const T0 = new Date("2030-01-01T00:05:00Z");
const BLOCKED_UNTIL = "2030-01-02T00:00:00.000Z";
const TIMEOUT = 10_000;
const HOUR = 3_600_000;

type Owner = "A" | "B" | "C";
type Verdict = "ok" | "blocked" | "busy" | "rate_limited" | "invalid" | "unavailable";
type SettlePlan = Extract<Plan, { kind: "settle" }>;

const keys = new DepositKeys(new Map([[1, Buffer.alloc(32, 7)]]), 1);

let db: TestDb;
let chain: FakeChain;
let router: FakeRouter;
let routerClient: RouterClient;
let clock: Date;
let log: ReturnType<typeof memoryLog>;
let cache: TxCache;
let cfg: Settings["deposits"];
let x402: Settings["x402"];
let paid: PaidDeps;
let feePayer: KeyPairSigner;
let challengeFeePayer: string;
let owners: Record<Owner, KeyPairSigner>;
let sources: Record<Owner, string>;
let recipient: KeyPairSigner;
let allowanceWallet: KeyPairSigner;
let recipientAta: Address;
let hotAta: Address;
let signerOpen: boolean;
let verdicts: Map<string, Verdict>;
let checks: { payer: string; feePayer: string; packageId: string; kind: string }[];
let events: string[];
let lanes: { lane: string; method: string }[];
let onCheck: (() => Promise<void>) | null;
let memoSeq = 0;

beforeAll(async () => {
    db = await testDb();
    let a, b, c;
    [feePayer, a, b, c, recipient, allowanceWallet] = await Promise.all([
        testSigner(22),
        testSigner(31),
        testSigner(32),
        testSigner(33),
        testSigner(1),
        testSigner(11),
    ]);
    owners = { A: a, B: b, C: c };
    challengeFeePayer = (await testSigner(24)).address;
    sources = {
        A: await usdcAta(a.address),
        B: await usdcAta(b.address),
        C: await usdcAta(c.address),
    };
    recipientAta = await usdcAta(recipient.address);
    hotAta = await usdcAta(allowanceWallet.address);
    const settings = parseSettings(`[solana]\nrecipient = "${recipient.address}"`, "t.toml");
    cfg = settings.deposits;
    x402 = { ...settings.x402, enabled: true, allowance_wallet: allowanceWallet.address };
    paid = { funding: createAllowanceFunding({ x402, log: silentLog }), x402, log: silentLog };
    router = await startFakeRouter({
        checkPayer: async (r) => {
            events.push(`checkPayer:${r.payer}`);
            checks.push({
                payer: r.payer,
                feePayer: r.feePayer,
                packageId: r.packageId,
                kind: r.kind,
            });
            if (onCheck !== null) await onCheck();
            const verdict = verdicts.get(r.payer) ?? "ok";
            if (verdict === "invalid") throw new ConnectError("bad payer", Code.InvalidArgument);
            if (verdict === "unavailable") throw new ConnectError("down", Code.Unavailable);
            const code = {
                ok: PayerVerdict.OK,
                blocked: PayerVerdict.BLOCKED,
                busy: PayerVerdict.BUSY,
                rate_limited: PayerVerdict.RATE_LIMITED,
            }[verdict];
            return {
                verdict: code,
                retryAfter: create(DurationSchema, { seconds: 7n }),
                blockedUntil: create(TimestampSchema, {
                    seconds: BigInt(Date.parse(BLOCKED_UNTIL) / 1000),
                }),
            };
        },
    });
    routerClient = clientFor(router.url, true);
});
afterAll(async () => {
    await router.close();
    await db.close();
});
beforeEach(async () => {
    chain = await startFakeChain();
    for (const k of ["A", "B", "C"] as const) {
        chain.setTokenAccount({ address: sources[k], owner: owners[k].address, amount: 10n ** 8n });
    }
    chain.setTokenAccount({ address: recipientAta, owner: recipient.address, amount: 0n });
    chain.setTokenAccount({ address: hotAta, owner: allowanceWallet.address, amount: 0n });
    chain.setBlockTime(PAID_AT.getTime() / 1000);
    clock = T0;
    log = memoryLog();
    cache = new TxCache(10_000);
    signerOpen = true;
    verdicts = new Map();
    checks = [];
    events = [];
    lanes = [];
    onCheck = null;
    await resetLedger(db.pool);
});
afterEach(async () => {
    await chain.close();
});

function clientFor(url: string, checkPayer: boolean): RouterClient {
    return createRouterClient({
        url,
        token: "rt",
        timeoutMs: 2_000,
        checkPayer,
        getOrder: false,
        log: silentLog,
    });
}

const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
};

// Names every call it passes on, so a test can see which lane a call took and in what order
function recording(rpc: SolanaRpc, lane: string): SolanaRpc {
    return new Proxy(rpc, {
        get: (target, prop, recv) => {
            const value: unknown = Reflect.get(target, prop, recv);
            if (typeof prop !== "string" || typeof value !== "function") return value;
            return (...args: unknown[]) => {
                events.push(prop);
                lanes.push({ lane, method: prop });
                return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    });
}

function settleDeps(over: Partial<SettleDeps> = {}): SettleDeps {
    return {
        pool: db.pool,
        router: routerClient,
        feePayer,
        challengeFeePayer,
        x402: { x402, signer: { open: () => signerOpen } },
        keys,
        cfg,
        recipientTokenAccount: recipientAta,
        hotTokenAccount: hotAta,
        rpc: recording(chain.rpc, "rpc"),
        rpcTimeoutMs: TIMEOUT,
        log,
        now: () => clock,
        routerCalls: { left: cfg.max_split_owners + 1 },
        ...over,
    };
}

function moveDeps(over: Partial<MoveDeps> = {}): MoveDeps {
    const base = {
        pool: db.pool,
        rpc: chain.rpc,
        feePayer,
        keys,
        cfg,
        recipientTokenAccount: recipientAta,
        floatTokenAccount: recipientAta,
        hotTokenAccount: hotAta,
        paid,
        rpcTimeoutMs: TIMEOUT,
        log,
        now: () => clock,
        cache,
    };
    return { ...base, ...sweepHooks(base), ...over };
}

const moves = (d: MoveDeps = moveDeps()): Promise<MoveTick> => advanceMoves(d);

async function deposit(
    id = ORDER_A,
    o: { allowance?: boolean; over?: Partial<OrderRow> } = {},
): Promise<DepositRow> {
    const fields = { id, createdAt: CREATED, expiresAt: EXPIRES, ...o.over };
    const { order } = o.allowance
        ? await seedAllowanceOrder(db.pool, { handleSha256: TEST_HANDLE_SHA256, ...fields })
        : await seedOrder(db.pool, { amountMicros: 50_000, ...fields });
    const dep = (await ensureDeposit(db.pool, keys, order, T0, () => Buffer.alloc(16, 1)))!;
    await chain.createAta({ owner: dep.address, payer: feePayer });
    await withTx(db.pool, (c) => updateDeposit(c, id, { readyAt: T0 }));
    return dep;
}

// The memo keeps equal transfers apart, which would otherwise share one signature
async function send(from: Owner, micros: bigint, id = ORDER_A): Promise<string> {
    const dep = (await findDeposit(db.pool, id))!;
    const signature = await chain.transfer({
        authority: owners[from],
        feePayer: owners[from],
        source: sources[from],
        destination: dep.tokenAccount,
        micros,
        memo: `t${++memoSeq}`,
    });
    chain.advance(1);
    return signature;
}

// Reads the account, moves to a new slot so nothing lands in the slot read, and scans
async function scan(id = ORDER_A): Promise<ScanResult> {
    const dep = (await findDeposit(db.pool, id))!;
    const trail = new ReadTrail(
        dep.checkedSlot === null ? null : { slot: dep.checkedSlot, micros: dep.balanceMicros },
    );
    const read = (
        await readDepositBalances(chain.rpc, [dep.tokenAccount as Address], { timeoutMs: TIMEOUT })
    ).get(dep.tokenAccount)!;
    chain.advance(1);
    trail.push(read);
    return await scanDeposit(
        { pool: db.pool, rpc: chain.rpc, rpcTimeoutMs: TIMEOUT, cfg, cache, log, now: () => clock },
        dep,
        trail,
    );
}

async function planFor(id: string, r: ScanResult): Promise<Plan> {
    const order = (await findOrder(db.pool, id))!;
    const ledger = (await depositLedger(db.pool, id))!;
    return planDeposit({
        order,
        deposit: ledger.deposit,
        read: { ...r.read, invariant: r.invariant },
        expectedMicros: expectedBalanceAt(
            ledger.transfers,
            ledger.moves,
            ledger.writeOffs,
            r.read.contextSlot,
        ),
        transfers: ledger.transfers,
        moves: ledger.moves,
        holds: ledger.holds,
        bugnetOwners: new Set([feePayer.address, recipient.address, allowanceWallet.address]),
        viewer: { seen: false, ipRented: 0, blockRented: 0 },
        rentHolding: 0,
        unpaidCreateLeft: 10n ** 9n,
        feeBudgetLeft: 10n ** 9n,
        ownerReturns: new Map(),
        feePayer: feePayer.address,
        now: clock,
        cfg,
    });
}

async function nextPlan(id = ORDER_A): Promise<{ plan: Plan; read: ScanResult }> {
    const read = await scan(id);
    return { plan: await planFor(id, read), read };
}

function asSettle(plan: Plan): SettlePlan {
    if (plan.kind !== "settle") throw new Error(`expected a settle plan, got ${plan.kind}`);
    return plan;
}

const signal = () => AbortSignal.timeout(5_000);

async function settle(id = ORDER_A, d: SettleDeps = settleDeps(), timeout = signal) {
    const { plan, read } = await nextPlan(id);
    return await settleDeposit(d, id, asSettle(plan), read.read.contextSlot, timeout);
}

// What the job does with each step (Task 11), enough to carry a deposit to its close
async function apply(id: string, plan: Plan, read: ScanResult): Promise<void> {
    switch (plan.kind) {
        case "wait":
            return;
        case "settle":
            await settleDeposit(settleDeps(), id, plan, read.read.contextSlot, signal);
            return;
        case "assign":
            await withTx(db.pool, async (c) => {
                await setTransferOutcomes(c, id, plan.rows);
                if (plan.clearHolds) {
                    await updateDeposit(c, id, { holdReason: null, recheckAt: null });
                    await clearHolds(c, id);
                }
            });
            return;
        case "move":
            await withTx(db.pool, (c) => insertMove(c, plan.move, plan.transfers, clock));
            return;
        case "ready":
            await withTx(db.pool, (c) => updateDeposit(c, id, { readyAt: clock }));
            return;
        case "closed":
            await withTx(db.pool, (c) =>
                updateDeposit(c, id, {
                    state: "closed",
                    closedAt: clock,
                    watchUntil: new Date(clock.getTime() + cfg.watch_after_close),
                    rentPayer: null,
                }),
            );
            return;
        default:
            throw new Error(`the test does not apply ${plan.kind}`);
    }
}

async function driveToClose(id = ORDER_A): Promise<void> {
    for (let i = 0; i < 20; i++) {
        later(3_000);
        await moves();
        if ((await findDeposit(db.pool, id))!.state === "closed") return;
        const { plan, read } = await nextPlan(id);
        await apply(id, plan, read);
    }
    throw new Error("the deposit never closed");
}

const ledgerOf = async (id = ORDER_A) => (await depositLedger(db.pool, id))!;
const transferOf = async (signature: string, id = ORDER_A): Promise<TransferRow> =>
    (await ledgerOf(id)).transfers.find((t) => t.signature === signature)!;
const sweepOf = async (id = ORDER_A): Promise<MoveRow> =>
    (await ledgerOf(id)).moves.find((m) => m.kind === "sweep")!;
const orderOf = async (id = ORDER_A) => (await findOrder(db.pool, id))!;
const paidVia = async (id = ORDER_A) =>
    (await db.pool.query<{ paid_via: string }>("select paid_via from orders where id = $1", [id]))
        .rows[0]!.paid_via;
const callsOf = (method: string, mark = 0) =>
    chain
        .calls()
        .slice(mark)
        .filter((c) => c.method === method);
const alarms = (name: string) => log.lines.filter((l) => l.alarm === name);
const payers = () => checks.map((c) => c.payer);

const decoded = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire));
const closesIn = (wire: string) => {
    const msg = getCompiledTransactionMessageDecoder().decode(decoded(wire).messageBytes);
    if (msg.version !== 0) throw new Error(`expected a v0 message, got ${msg.version}`);
    return msg.instructions.some(
        (ix) => msg.staticAccounts[ix.programAddressIndex] === TOKEN_PROGRAM && ix.data?.[0] === 9,
    );
};

// The first send is lost on its way, as a dropped transaction is; later sends go through
function dropFirst(): SolanaRpc {
    let n = 0;
    return new Proxy(chain.rpc, {
        get: (target, prop, recv) => {
            if (prop !== "sendTransaction") return Reflect.get(target, prop, recv);
            return (wire: string, config: Record<string, unknown>) => ({
                send: async () =>
                    n++ === 0
                        ? getSignatureFromTransaction(decoded(wire))
                        : chain.rpc.sendTransaction(wire as never, config as never).send(),
            });
        },
    });
}

async function allowanceReady(id = ORDER_A): Promise<DepositRow> {
    await seedAccount(db.pool, { handleSha256: TEST_HANDLE_SHA256 });
    await db.pool.query(
        "update x402_pool set committed_micros = 0, unpaid_micros = 1003000 where id = 1",
    );
    return await deposit(id, { allowance: true });
}

describe("settle", () => {
    it("settles a cold order", async () => {
        await deposit();
        await send("A", 50_000n);
        const { plan, read } = await nextPlan();
        expect(plan).toMatchObject({ kind: "settle", multiSender: false, closes: true });
        const before = await ledgerOf();
        events = [];
        const mark = chain.calls().length;

        const outcome = await settleDeposit(
            settleDeps(),
            ORDER_A,
            asSettle(plan),
            read.read.contextSlot,
            signal,
        );
        expect(outcome).toBe("settling");
        expect(await orderOf()).toMatchObject({ state: "settling", payer: owners.A.address });
        expect(await paidVia()).toBe("transfer");
        const sweep = await sweepOf();
        expect(sweep).toMatchObject({
            destination: recipientAta,
            memo: ORDER_A,
            closes: true,
            state: "sent",
            amountMicros: 50_000,
            attempts: 1,
        });
        expect(closesIn(sweep.wireTx!)).toBe(true);
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toMatchObject({
            txSignature: sweep.txSignature,
            amountMicros: 50_000,
            payer: owners.A.address,
            sourceTokenAccount: sources.A,
            createdAt: PAID_AT,
            status: "settling",
            payerCounted: true,
            multiSender: false,
            splitMinMicros: null,
        });

        const transferSlot = before.transfers[0]!.slot;
        const checked = before.deposit.checkedSlot!;
        const pin = checked > transferSlot ? checked : transferSlot;
        const calls = chain.calls().slice(mark);
        expect(calls.map((c) => c.method)).toEqual([
            "getMultipleAccounts",
            "getLatestBlockhash",
            "sendTransaction",
        ]);
        expect(BigInt((calls[0]!.params[1] as { minContextSlot: number }).minContextSlot)).toBe(
            pin,
        );
        expect(calls[1]!.params[0]).toMatchObject({
            commitment: "confirmed",
            minContextSlot: Number(chain.slot()),
        });
        expect(events).toEqual([
            `checkPayer:${owners.A.address}`,
            "getMultipleAccounts",
            "getLatestBlockhash",
            "sendTransaction",
        ]);
        expect(await findDeposit(db.pool, ORDER_A)).toMatchObject({
            state: "settling",
            settledAt: clock,
        });
        expect(checks).toEqual([
            {
                payer: owners.A.address,
                feePayer: challengeFeePayer,
                packageId: "pkg-test",
                kind: "start",
            },
        ]);
        const a1 = (await ledgerOf()).transfers[0]!;
        expect(a1).toMatchObject({ outcome: "paid", appliedMicros: 50_000, reason: null });
    });

    it("sweep landing pays the order", async () => {
        await deposit();
        await send("A", 50_000n);
        const before = chain.balance(recipientAta);
        expect(await settle()).toBe("settling");
        later(3_000);
        expect((await moves()).confirmed).toBe(1);

        expect(await orderOf()).toMatchObject({ state: "paid", paidAt: PAID_AT });
        expect((await findPaymentByOrder(db.pool, ORDER_A))!.status).toBe("confirmed");
        const sweep = await sweepOf();
        expect(sweep.state).toBe("confirmed");
        expect(sweep.landedSlot).not.toBeNull();
        expect(await findDeposit(db.pool, ORDER_A)).toMatchObject({
            state: "closed",
            closedAt: clock,
            watchUntil: new Date(clock.getTime() + 24 * HOUR),
            rentPayer: null,
        });
        expect(chain.balance(recipientAta) - before).toBe(50_000n);
        expect(chain.accountExists(TOKEN_A)).toBe(false);
    });

    it("others are assigned only with the sweep", async () => {
        await deposit();
        const b1 = await send("B", 1n);
        const a1 = await send("A", 50_000n);
        verdicts.set(owners.A.address, "busy");
        expect(await settle()).toBe("held");
        expect((await transferOf(b1)).outcome).toBe("open");
        expect((await transferOf(a1)).outcome).toBe("open");
        expect(await holdsOf(db.pool, ORDER_A)).toMatchObject([
            { owner: owners.A.address, reason: "payer_busy" },
        ]);

        verdicts.set(owners.A.address, "ok");
        later(10_001);
        expect(await settle()).toBe("settling");
        expect(await transferOf(b1)).toMatchObject({
            outcome: "keep",
            reason: "below_minimum",
            appliedMicros: 0,
        });
        expect(await transferOf(a1)).toMatchObject({ outcome: "paid", appliedMicros: 50_000 });
        expect(await holdsOf(db.pool, ORDER_A)).toEqual([]);
    });

    it("the settle sweep never closes against new money", async () => {
        await deposit();
        await send("A", 50_000n);
        const { plan, read } = await nextPlan();
        expect(plan).toMatchObject({ kind: "settle", closes: true });
        chain.credit(TOKEN_A, 1n);

        expect(
            await settleDeposit(
                settleDeps(),
                ORDER_A,
                asSettle(plan),
                read.read.contextSlot,
                signal,
            ),
        ).toBe("settling");
        const sweep = await sweepOf();
        expect(sweep.closes).toBe(false);
        expect(closesIn(sweep.wireTx!)).toBe(false);
        later(3_000);
        expect((await moves()).confirmed).toBe(1);
        expect((await orderOf()).state).toBe("paid");
        expect((await findDeposit(db.pool, ORDER_A))!.state).toBe("draining");

        await driveToClose();
        const close = (await ledgerOf()).moves.find((m) => m.kind === "close")!;
        expect(close).toMatchObject({ state: "confirmed", keepMicros: 1, closes: true });
        expect(chain.accountExists(TOKEN_A)).toBe(false);
        expect(chain.submitted().filter((s) => s.failed)).toEqual([]);
    });

    it("a guard read below the ledger waits", async () => {
        await deposit();
        await send("A", 50_000n);
        const { plan, read } = await nextPlan();
        chain.debit(TOKEN_A, 1n);
        const mark = chain.calls().length;
        expect(
            await settleDeposit(
                settleDeps(),
                ORDER_A,
                asSettle(plan),
                read.read.contextSlot,
                signal,
            ),
        ).toBe("wait");
        expect(callsOf("sendTransaction", mark)).toHaveLength(0);
        expect(callsOf("getLatestBlockhash", mark)).toHaveLength(0);
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toBeNull();
        expect((await ledgerOf()).moves).toEqual([]);
        expect((await orderOf()).state).toBe("unpaid");
        expect((await findDeposit(db.pool, ORDER_A))!.state).toBe("open");
    });
});

describe("owners and the router", () => {
    it("a shared payment writes shares and names no payer", async () => {
        await deposit();
        await send("A", 30_000n);
        await send("B", 20_000n);
        expect(await settle()).toBe("settling");
        expect(payers()).toEqual([owners.A.address, owners.B.address, ""]);
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toMatchObject({
            payer: owners.A.address,
            sourceTokenAccount: sources.A,
            payerCounted: false,
            multiSender: true,
            splitMinMicros: 1_000,
        });
        expect(
            (await sharesOf(db.pool, ORDER_A)).map((s) => [
                s.part,
                s.owner,
                s.sourceTokenAccount,
                s.appliedMicros,
            ]),
        ).toEqual([
            [0, owners.A.address, sources.A, 30_000],
            [1, owners.B.address, sources.B, 20_000],
        ]);
        expect((await orderOf()).payer).toBe(owners.A.address);
    });

    it("each router call gets its own time limit", async () => {
        await deposit();
        await send("A", 30_000n);
        await send("B", 20_000n);
        let made = 0;
        // One limit for every owner would leave the later ones the time the first ones spent
        expect(
            await settle(ORDER_A, settleDeps(), () => {
                made++;
                return signal();
            }),
        ).toBe("settling");
        expect(payers()).toEqual([owners.A.address, owners.B.address, ""]);
        expect(made).toBe(3);
    });

    it("dust owners are kept, never applied", async () => {
        await deposit();
        await send("A", 30_000n);
        const c1 = await send("C", 500n);
        await send("B", 20_000n);
        expect(await settle()).toBe("settling");
        expect(payers()).toEqual([owners.A.address, owners.B.address, ""]);
        expect(await transferOf(c1)).toMatchObject({
            outcome: "keep",
            reason: "below_minimum",
            appliedMicros: 0,
        });
        expect((await sharesOf(db.pool, ORDER_A)).map((s) => s.owner)).toEqual([
            owners.A.address,
            owners.B.address,
        ]);
    });

    it("a blocked owner's money goes back, the rest waits", async () => {
        await deposit();
        const a1 = await send("A", 30_000n);
        const b1 = await send("B", 20_000n);
        verdicts.set(owners.B.address, "blocked");
        expect(await settle()).toBe("returned");
        expect(await transferOf(b1)).toMatchObject({
            outcome: "return",
            reason: "payer_blocked",
            blockedUntil: new Date(BLOCKED_UNTIL),
        });
        expect((await transferOf(a1)).outcome).toBe("open");
        expect((await orderOf()).state).toBe("unpaid");
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toBeNull();
        const { plan } = await nextPlan();
        expect(plan).toMatchObject({
            kind: "move",
            move: {
                kind: "return",
                amountMicros: 20_000,
                destination: sources.B,
                payer: owners.B.address,
                closes: false,
            },
        });
    });

    it("a shared payment acts only on blocks", async () => {
        for (const [id, verdict] of [
            [ORDER_A, "busy"],
            [ORDER_B, "rate_limited"],
        ] as const) {
            await deposit(id);
            await send("A", 30_000n, id);
            await send("B", 20_000n, id);
            verdicts.set(owners.B.address, verdict);
            expect(await settle(id)).toBe("settling");
            expect((await sharesOf(db.pool, id)).map((s) => s.owner)).toEqual([
                owners.A.address,
                owners.B.address,
            ]);
            expect(await holdsOf(db.pool, id)).toEqual([]);
        }
    });

    it("busy holds a single owner and checks again", async () => {
        for (const [id, verdict, reason] of [
            [ORDER_A, "busy", "payer_busy"],
            [ORDER_B, "rate_limited", "payer_rate_limited"],
        ] as const) {
            await deposit(id);
            const a1 = await send("A", 50_000n, id);
            verdicts.set(owners.A.address, verdict);
            expect(await settle(id)).toBe("held");
            expect(await holdsOf(db.pool, id)).toEqual([
                {
                    orderId: id,
                    owner: owners.A.address,
                    reason,
                    recheckAt: new Date(clock.getTime() + 10_000),
                    since: clock,
                },
            ]);
            expect((await findDeposit(db.pool, id))!.holdReason).toBeNull();
            expect((await transferOf(a1, id)).outcome).toBe("open");

            verdicts.set(owners.A.address, "ok");
            later(10_001);
            expect(await settle(id)).toBe("settling");
            expect(await holdsOf(db.pool, id)).toEqual([]);
        }
    });

    it("a held owner is left out and another owner settles", async () => {
        await deposit();
        const b1 = await send("B", 50_000n);
        verdicts.set(owners.B.address, "busy");
        expect(await settle()).toBe("held");
        await send("A", 50_000n);
        later(2_000);

        const { plan, read } = await nextPlan();
        expect(asSettle(plan).owners.map((o) => o.owner)).toEqual([owners.A.address]);
        expect(
            await settleDeposit(
                settleDeps(),
                ORDER_A,
                asSettle(plan),
                read.read.contextSlot,
                signal,
            ),
        ).toBe("settling");
        expect(await transferOf(b1)).toMatchObject({ outcome: "return", reason: "extra" });
        expect(await holdsOf(db.pool, ORDER_A)).toEqual([]);
        expect((await orderOf()).payer).toBe(owners.A.address);
    });

    it("every single owner is named", async () => {
        chain.setTokenAccount({
            address: sources.A,
            owner: owners.A.address,
            amount: 10_000_050_000n,
        });
        await deposit();
        const a1 = await send("A", 50_000n);
        expect(await settle()).toBe("settling");
        expect((await transferOf(a1)).sourceBalanceMicros).toBe(10_000_000_000n);
        expect(payers()).toEqual([owners.A.address]);
        expect((await findPaymentByOrder(db.pool, ORDER_A))!.payerCounted).toBe(true);
        expect(
            callsOf("getSignaturesForAddress").filter((c) => c.params[0] === owners.A.address),
        ).toEqual([]);

        await deposit(ORDER_B);
        const blocked = await send("A", 50_000n, ORDER_B);
        verdicts.set(owners.A.address, "blocked");
        expect(await settle(ORDER_B)).toBe("returned");
        expect(await transferOf(blocked, ORDER_B)).toMatchObject({
            outcome: "return",
            reason: "payer_blocked",
            blockedUntil: new Date(BLOCKED_UNTIL),
        });
        expect(alarms("deposit_review")).toEqual([]);
        const { plan } = await nextPlan(ORDER_B);
        expect(plan).toMatchObject({
            kind: "move",
            move: { kind: "return", amountMicros: 50_000, destination: sources.A },
        });
    });

    it("invalid sends the owner's money to review", async () => {
        await deposit();
        const a1 = await send("A", 50_000n);
        verdicts.set(owners.A.address, "invalid");
        expect(await settle()).toBe("returned");
        expect(await transferOf(a1)).toMatchObject({ outcome: "review", reason: "unattributed" });
        expect(alarms("deposit_review")).toEqual([
            expect.objectContaining({ orderId: ORDER_A, signatures: [a1] }),
        ]);
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toBeNull();
        expect((await orderOf()).state).toBe("unpaid");
    });

    it("skipped goes on", async () => {
        const skipped = settleDeps({ router: clientFor(router.url, false) });
        await deposit();
        await send("A", 50_000n);
        expect(await settle(ORDER_A, skipped)).toBe("settling");
        expect((await findPaymentByOrder(db.pool, ORDER_A))!.payerCounted).toBe(true);
        expect(await holdsOf(db.pool, ORDER_A)).toEqual([]);

        await deposit(ORDER_B);
        await send("A", 30_000n, ORDER_B);
        await send("B", 20_000n, ORDER_B);
        expect(await settle(ORDER_B, skipped)).toBe("settling");
        expect(await sharesOf(db.pool, ORDER_B)).toHaveLength(2);
        expect(await holdsOf(db.pool, ORDER_B)).toEqual([]);
        expect(checks).toEqual([]);
    });

    it("an allowance order is checked as extend", async () => {
        await allowanceReady();
        await send("A", 1_003_000n);
        expect(await settle()).toBe("settling");
        expect(checks).toEqual([
            {
                payer: owners.A.address,
                feePayer: challengeFeePayer,
                packageId: "cpu-small",
                kind: "extend",
            },
        ]);
    });

    it("settle's calls name their lane", async () => {
        expectTypeOf<SettleDeps>().not.toHaveProperty("backgroundRpc");
        await deposit();
        await send("A", 50_000n);
        const { plan, read } = await nextPlan();
        lanes = [];
        expect(
            await settleDeposit(
                settleDeps(),
                ORDER_A,
                asSettle(plan),
                read.read.contextSlot,
                signal,
            ),
        ).toBe("settling");
        expect(lanes).toEqual([
            { lane: "rpc", method: "getMultipleAccounts" },
            { lane: "rpc", method: "getLatestBlockhash" },
            { lane: "rpc", method: "sendTransaction" },
        ]);
    });

    it("the anonymous pool full holds the shared mode only", async () => {
        await deposit();
        const a1 = await send("A", 30_000n);
        const b1 = await send("B", 20_000n);
        verdicts.set("", "busy");
        expect(await settle()).toBe("held");
        expect(await holdsOf(db.pool, ORDER_A)).toMatchObject([
            { owner: "", reason: "anonymous_busy" },
        ]);
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toBeNull();

        checks = [];
        await send("C", 50_000n);
        expect(await settle()).toBe("settling");
        expect(payers()).toEqual([owners.C.address]);
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toMatchObject({
            payer: owners.C.address,
            payerCounted: true,
        });
        expect(await holdsOf(db.pool, ORDER_A)).toEqual([]);
        expect((await transferOf(a1)).outcome).toBe("return");
        expect((await transferOf(b1)).outcome).toBe("return");
    });

    it("router calls are capped", async () => {
        await deposit();
        await send("A", 20_000n);
        await send("B", 20_000n);
        await send("C", 20_000n);
        expect(await settle(ORDER_A, settleDeps({ routerCalls: { left: 2 } }))).toBe("wait");
        expect(checks).toHaveLength(2);
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toBeNull();

        const next = { left: cfg.max_split_owners + 1 };
        expect(await settle(ORDER_A, settleDeps({ routerCalls: next }))).toBe("settling");
        expect(checks).toHaveLength(6);
        expect(next.left).toBe(cfg.max_split_owners + 1 - 4);
        expect(await sharesOf(db.pool, ORDER_A)).toHaveLength(3);
    });

    it("router unavailable: start orders settle, allowance top-ups hold", async () => {
        const down = await startFakeRouter({});
        await down.close();
        const unreachable = settleDeps({ router: clientFor(down.url, true) });
        await deposit();
        await send("A", 50_000n);
        expect(await settle(ORDER_A, unreachable)).toBe("settling");

        await allowanceReady(ORDER_B);
        const b1 = await send("A", 1_003_000n, ORDER_B);
        expect(await settle(ORDER_B, unreachable)).toBe("held");
        expect(await findDeposit(db.pool, ORDER_B)).toMatchObject({
            holdReason: "router_unavailable",
            recheckAt: new Date(clock.getTime() + 10_000),
            state: "open",
        });
        expect((await transferOf(b1, ORDER_B)).outcome).toBe("open");
        expect(await findPaymentByOrder(db.pool, ORDER_B)).toBeNull();
    });
});

describe("the allowance gate", () => {
    it("allowance order with the gate disabled returns the money", async () => {
        await allowanceReady();
        const a1 = await send("A", 1_003_000n);
        const off = settleDeps({
            x402: { x402: { ...x402, enabled: false }, signer: { open: () => true } },
        });
        expect(await settle(ORDER_A, off)).toBe("returned");
        expect(await transferOf(a1)).toMatchObject({
            outcome: "return",
            reason: "allowance_unavailable",
        });
        expect(checks).toEqual([]);
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toBeNull();
    });

    it("allowance order with the gate paused holds", async () => {
        await allowanceReady();
        const a1 = await send("A", 1_003_000n);
        await db.pool.query("update x402_controls set paused = true where id = 1");
        expect(await settle()).toBe("held");
        expect(await findDeposit(db.pool, ORDER_A)).toMatchObject({
            holdReason: "allowance_paused",
            recheckAt: new Date(clock.getTime() + 10_000),
        });
        expect((await transferOf(a1)).outcome).toBe("open");
        expect(checks).toEqual([]);

        await db.pool.query("update x402_controls set paused = false where id = 1");
        await deposit(ORDER_B, { allowance: true });
        await send("A", 1_003_000n, ORDER_B);
        signerOpen = false;
        expect(await settle(ORDER_B)).toBe("held");
        expect((await findDeposit(db.pool, ORDER_B))!.holdReason).toBe("allowance_paused");
        expect(checks).toEqual([]);
    });

    it("allowance sweep funds the account", async () => {
        const dep = await allowanceReady();
        const order = await orderOf();
        await send("A", 1_003_000n);
        const before = chain.balance(hotAta);
        expect(await settle()).toBe("settling");
        expect((await sweepOf()).destination).toBe(hotAta);
        later(3_000);
        expect((await moves()).confirmed).toBe(1);

        const sweep = await sweepOf();
        expect(chain.balance(hotAta) - before).toBe(1_003_000n);
        expect((await findPaymentByOrder(db.pool, ORDER_A))!.landedSlot).toBe(sweep.landedSlot);
        const fundings = await db.pool.query<{ allowance: number; source: string }>(
            `select allowance_micros::int as allowance, source_token_account as source
             from x402_fundings where order_id = $1`,
            [ORDER_A],
        );
        expect(fundings.rows).toEqual([{ allowance: order.allowanceMicros, source: sources.A }]);
        expect((await orderOf()).state).toBe("redeemed");
        expect((await findDeposit(db.pool, ORDER_A))!.state).toBe("closed");
        expect(dep.address).toBeDefined();

        const raw = await chain.rpc
            .getTransaction(toSignature(sweep.txSignature!), {
                encoding: "base64",
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
            })
            .send();
        const tx = parseChainTx(sweep.txSignature!, raw!.slot, raw, hotAta);
        const matchDeps = {
            x402,
            hotTokenAccount: hotAta,
            coldTokenAccount: recipientAta,
            log,
            now: () => clock,
            rpcTimeoutMs: TIMEOUT,
        };
        expect(await matchInTx(db.pool, tx, matchDeps)).toBe("order");
    });
});

describe("changes under the settle", () => {
    it("the order changed under the settle", async () => {
        await deposit();
        await send("A", 50_000n);
        onCheck = async () => {
            await db.pool.query("update orders set state = 'settling' where id = $1", [ORDER_A]);
        };
        const mark = chain.calls().length;
        expect(await settle()).toBe("changed");
        expect(callsOf("sendTransaction", mark)).toHaveLength(0);
        expect((await ledgerOf()).moves).toEqual([]);
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toBeNull();
        expect((await ledgerOf()).transfers[0]!.outcome).toBe("open");
    });

    it("a write-off under the settle stops it", async () => {
        await deposit();
        const sent = await send("A", 50_000n);
        onCheck = async () => {
            await withTx(db.pool, (c) =>
                insertWriteOff(
                    c,
                    {
                        orderId: ORDER_A,
                        signature: "theft".padEnd(88, "1"),
                        slot: chain.slot(),
                        micros: 1_000,
                        writtenAt: clock,
                    },
                    [{ transferSignature: sent, micros: 1_000, refundId: null, keptReason: null }],
                ),
            );
        };
        const mark = chain.calls().length;
        expect(await settle()).toBe("changed");
        expect(callsOf("sendTransaction", mark)).toHaveLength(0);
        expect((await ledgerOf()).moves).toEqual([]);
        expect(await findPaymentByOrder(db.pool, ORDER_A)).toBeNull();
        expect((await findOrder(db.pool, ORDER_A))!.state).toBe("unpaid");
    });

    it("a failed sweep is replanned and the payment row follows", async () => {
        await deposit();
        await send("A", 50_000n);
        chain.failNext();
        expect(await settle()).toBe("settling");
        const first = (await findPaymentByOrder(db.pool, ORDER_A))!;
        later(3_000);
        expect((await moves()).failed).toBe(1);
        expect((await sweepOf()).state).toBe("failed");
        expect((await orderOf()).state).toBe("settling");
        const called = checks.length;

        const { plan, read } = await nextPlan();
        expect(plan).toMatchObject({ kind: "move", move: { kind: "sweep", closes: false } });
        await apply(ORDER_A, plan, read);
        expect((await moves()).signed).toBe(1);
        const again = (await ledgerOf()).moves.find(
            (m) => m.kind === "sweep" && m.state === "sent",
        )!;
        const payment = (await findPaymentByOrder(db.pool, ORDER_A))!;
        expect(payment.txSignature).toBe(again.txSignature);
        expect(payment.messageHash).not.toBe(first.messageHash);
        expect(payment.blockhash).not.toBe(first.blockhash);
        expect(payment.lastValidBlockHeight).not.toBe(first.lastValidBlockHeight);
        expect(checks).toHaveLength(called);

        later(3_000);
        expect((await moves()).confirmed).toBe(1);
        expect((await orderOf()).state).toBe("paid");
    });

    it("an expired sweep re-signed keeps the payments row on the live signature", async () => {
        await deposit();
        await send("A", 50_000n);
        expect(await settle(ORDER_A, settleDeps({ rpc: dropFirst() }))).toBe("settling");
        const old = (await sweepOf()).txSignature!;
        chain.advance(160);
        chain.finalize();
        later(2_000);

        const ticks: MoveTick[] = [];
        while (ticks.length < 5 && ticks.at(-1)?.resigned !== 1) ticks.push(await moves());
        expect(ticks.at(-1)?.resigned).toBe(1);
        later(3_000);
        expect((await moves()).confirmed).toBe(1);

        const sweep = await sweepOf();
        expect(sweep.previousSignatures).toEqual([old]);
        const payment = (await findPaymentByOrder(db.pool, ORDER_A))!;
        expect(payment.txSignature).toBe(sweep.txSignature);
        expect(payment.status).toBe("confirmed");
        expect((await orderOf()).state).toBe("paid");

        chain.finalize();
        const report = await auditInflows({
            pool: db.pool,
            rpc: chain.rpc,
            recipient: recipient.address,
            rpcTimeoutMs: TIMEOUT,
            log,
            now: () => new Date(clock.getTime() + 10 * 60_000),
        });
        expect(report).toMatchObject({ matched: 1, mismatches: [], missing: [] });
    });

    it("a sweep found landed by the scan pays the order", async () => {
        await deposit();
        await send("A", 50_000n);
        expect(await settle()).toBe("settling");
        const sweep = await sweepOf();
        chain.hideFromStatus(sweep.txSignature!);
        let confirms = 0;
        const base = moveDeps();
        const d = moveDeps({
            confirmSweep: async (c, move, landed) => {
                confirms++;
                await base.confirmSweep(c, move, landed);
            },
        });
        later(3_000);
        expect((await moves(d)).confirmed).toBe(0);
        expect(confirms).toBe(0);

        await scan();
        expect((await sweepOf()).landedSlot).not.toBeNull();
        expect((await moves(d)).confirmed).toBe(1);
        expect(confirms).toBe(1);
        expect((await orderOf()).state).toBe("paid");
        later(3_000);
        await moves(d);
        expect(confirms).toBe(1);
    });
});
