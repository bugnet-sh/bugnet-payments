import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { DurationSchema, TimestampSchema } from "@bufbuild/protobuf/wkt";
import { type Address, getSignatureFromTransaction, getTransactionDecoder } from "@solana/kit";
import { getBase58Decoder, getBase64Encoder, type KeyPairSigner } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cliMain } from "../cli.ts";
import { parseSettings, type Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { PayerVerdict } from "../gen/bugnet/router/v1/payments_pb.ts";
import { ipKey, viewerHash } from "../http/ipkey.ts";
import { depositLamports } from "../jobs/alarms.ts";
import { reconcileSettling } from "../jobs/reconciler.ts";
import { sweep } from "../jobs/sweeper.ts";
import { memoryLog, silentLog } from "../log.ts";
import { newOrderId } from "../orders/ids.ts";
import { findOrder, findPaymentByOrder } from "../orders/store.ts";
import type { OrderRow } from "../orders/types.ts";
import { type RefundDeps, runRefunds } from "../refunds/executor.ts";
import { createRouterClient, type RouterClient } from "../router/client.ts";
import { usdcAta } from "../solana/accounts.ts";
import { RpcRouterError } from "../solana/router/errors.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedWriteOffPart } from "../testing/deposits.ts";
import { createFakeRpc, epochAt } from "../testing/fake-rpc.ts";
import { type FakeChain, startFakeChain } from "../testing/fake-chain.ts";
import { type FakeRouter, startFakeRouter } from "../testing/fake-router.ts";
import { testSecret, testSigner } from "../testing/keys.ts";
import { seedAllowanceOrder, seedOrder, seedPayment } from "../testing/orders.ts";
import { resetLedger, seedAccount, TEST_HANDLE_SHA256 } from "../testing/x402.ts";
import { createAllowanceFunding } from "../x402/funding.ts";
import { readPool } from "../x402/ledger.ts";
import type { PaidDeps } from "../x402/paid.ts";
import {
    countedLanes,
    createDepositWatch,
    type DepositJobDeps,
    type DepositRpcQueue,
    type DepositTick,
    type DepositWatch,
    depositInterval,
    depositRpcQueue,
    depositsBusy,
    runDepositTick,
    type ViewerFacts,
} from "./job.ts";
import { DepositKeys } from "./keys.ts";
import { moveFeeLamports } from "./moves.ts";
import { TxCache } from "./scan.ts";
import { sweepHooks } from "./settle.ts";
import {
    depositLedger,
    ensureDeposit,
    findDeposit,
    holdsOf,
    rentHolding,
    sharesOf,
    updateDeposit,
} from "./store.ts";
import type { DepositRow, MoveRow, TransferRow } from "./types.ts";
import { depositView } from "./view.ts";

const ORDER_A = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORDER_B = "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SEED = Buffer.alloc(32, 7);
const at = (hhmmss: string) => new Date(`2030-01-01T${hhmmss}Z`);
const CREATED = at("00:00:00");
const EXPIRES = at("00:15:00");
const PAID_AT = at("00:04:00");
const T0 = at("00:05:00");
const BLOCKED_UNTIL = "2030-01-02T00:00:00.000Z";
const TIMEOUT = 10_000;
const MIN = 60_000;
const OPEN: ViewerFacts = { state: "open", expiresAtMs: EXPIRES.getTime(), needsCreate: true };

type Owner = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
type Verdict = "ok" | "blocked" | "busy" | "rate_limited" | "unavailable";
type LaneCall = { lane: string; method: string; at: number };

const keys = new DepositKeys(new Map([[1, SEED]]), 1);

let db: TestDb;
let chain: FakeChain;
let router: FakeRouter;
let routerClient: RouterClient;
let clock: Date;
let log: ReturnType<typeof memoryLog>;
let cache: TxCache;
let settings: Settings;
let cfg: Settings["deposits"];
let x402: Settings["x402"];
let paid: PaidDeps;
let feePayer: KeyPairSigner;
let challengeFeePayer: string;
let owners: Record<Owner, KeyPairSigner>;
let sources: Record<Owner, string>;
let recipient: KeyPairSigner;
let refund: KeyPairSigner;
let allowanceWallet: KeyPairSigner;
let recipientAta: Address;
let floatAta: Address;
let hotAta: Address;
let verdicts: Map<string, Verdict>;
let checks: { payer: string; packageId: string; kind: string }[];
let laneCalls: LaneCall[];
let watch: DepositWatch;
let queue: DepositRpcQueue;
let lanes: { rpc: SolanaRpc; backgroundRpc: SolanaRpc };
// How far each RPC call moves the test clock
let perCallMs: number;
let memoSeq = 0;

beforeAll(async () => {
    db = await testDb();
    const signers = await Promise.all(
        [22, 31, 32, 33, 34, 35, 36, 37, 38, 1, 12, 11].map((n) => testSigner(n)),
    );
    feePayer = signers[0]!;
    const names: Owner[] = ["A", "B", "C", "D", "E", "F", "G", "H"];
    owners = Object.fromEntries(names.map((n, i) => [n, signers[i + 1]!])) as typeof owners;
    [recipient, refund, allowanceWallet] = signers.slice(9) as [
        KeyPairSigner,
        KeyPairSigner,
        KeyPairSigner,
    ];
    challengeFeePayer = (await testSigner(24)).address;
    sources = Object.fromEntries(
        await Promise.all(names.map(async (n) => [n, await usdcAta(owners[n].address)])),
    ) as typeof sources;
    recipientAta = await usdcAta(recipient.address);
    floatAta = await usdcAta(refund.address);
    hotAta = await usdcAta(allowanceWallet.address);
    settings = parseSettings(`[solana]\nrecipient = "${recipient.address}"`, "t.toml");
    x402 = { ...settings.x402, enabled: true, allowance_wallet: allowanceWallet.address };
    paid = { funding: createAllowanceFunding({ x402, log: silentLog }), x402, log: silentLog };
    router = await startFakeRouter({
        checkPayer: async (r) => {
            checks.push({ payer: r.payer, packageId: r.packageId, kind: r.kind });
            const verdict = verdicts.get(r.payer) ?? "ok";
            if (verdict === "unavailable") throw new Error("router down");
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
    routerClient = createRouterClient({
        url: router.url,
        token: "rt",
        timeoutMs: 2_000,
        checkPayer: true,
        getOrder: false,
        log: silentLog,
    });
});
afterAll(async () => {
    await router.close();
    await db.close();
});
beforeEach(async () => {
    chain = await startFakeChain();
    for (const n of Object.keys(owners) as Owner[]) {
        chain.setTokenAccount({ address: sources[n], owner: owners[n].address, amount: 10n ** 8n });
    }
    for (const [ata, owner] of [
        [recipientAta, recipient],
        [floatAta, refund],
        [hotAta, allowanceWallet],
    ] as const) {
        chain.setTokenAccount({ address: ata, owner: owner.address, amount: 0n });
    }
    chain.setBlockTime(PAID_AT.getTime() / 1000);
    clock = T0;
    log = memoryLog();
    cache = new TxCache(10_000);
    cfg = settings.deposits;
    verdicts = new Map();
    checks = [];
    laneCalls = [];
    perCallMs = 0;
    watch = createDepositWatch(cfg.viewer_ttl, cfg.busy_every);
    lanes = { rpc: recording(chain.rpc, "rpc"), backgroundRpc: recording(chain.rpc, "bg") };
    queue = fakeQueue();
    await resetLedger(db.pool);
});
afterEach(async () => {
    await chain.close();
});

const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
};

// Names every call it sends, so a test can see which lane a call took and when it went out. A
// read moves the chain to a new slot, as a confirmed read does: nothing lands in a slot read.
function recording(rpc: SolanaRpc, lane: string): SolanaRpc {
    return new Proxy(rpc, {
        get: (target, prop, recv) => {
            const value: unknown = Reflect.get(target, prop, recv);
            if (typeof prop !== "string" || typeof value !== "function") return value;
            return (...args: unknown[]) => {
                const pending = (
                    value as (...a: unknown[]) => { send: (...a: unknown[]) => Promise<unknown> }
                ).apply(target, args);
                return {
                    ...pending,
                    send: async (...sendArgs: unknown[]) => {
                        later(perCallMs);
                        laneCalls.push({ lane, method: prop, at: clock.getTime() });
                        const answer = await pending.send(...sendArgs);
                        if (prop === "getMultipleAccounts") chain.advance(1);
                        return answer;
                    },
                };
            };
        },
    });
}

// A queue on the test clock: waiting for room moves the clock, so nothing sleeps
function fakeQueue(o: { perSecond?: number; perDay?: number } = {}): DepositRpcQueue {
    return depositRpcQueue(lanes, {
        perSecond: o.perSecond ?? 1_000,
        perDay: o.perDay ?? 1_000_000,
        now: () => clock.getTime(),
        log,
        sleep: async (ms) => later(ms),
    });
}

function jobDeps(over: Partial<DepositJobDeps> = {}): DepositJobDeps {
    const base = {
        pool: db.pool,
        rpc: chain.rpc,
        feePayer,
        keys,
        cfg,
        recipientTokenAccount: recipientAta,
        floatTokenAccount: floatAta,
        hotTokenAccount: hotAta,
        paid,
        rpcTimeoutMs: TIMEOUT,
        log,
        now: () => clock,
        cache,
        router: routerClient,
        challengeFeePayer,
        x402: { x402, signer: { open: () => true } },
        watch,
        bugnetOwners: new Set([
            feePayer.address,
            recipient.address,
            refund.address,
            allowanceWallet.address,
        ]),
        seed: SEED,
        queue,
    };
    return { ...base, ...sweepHooks(base), ...over };
}

const tick = (over: Partial<DepositJobDeps> = {}): Promise<DepositTick> =>
    runDepositTick(jobDeps(over));

async function ticks(n: number, stepMs = 3_000, before?: () => void): Promise<void> {
    for (let i = 0; i < n; i++) {
        later(stepMs);
        before?.();
        await tick();
    }
}

interface DepositOptions {
    allowance?: boolean;
    // the deposit's token account is made by a wallet before the page runs
    account?: boolean;
    over?: Partial<OrderRow>;
}

async function deposit(id = ORDER_A, o: DepositOptions = {}): Promise<DepositRow> {
    const fields = { id, createdAt: CREATED, expiresAt: EXPIRES, ...o.over };
    const { order } = o.allowance
        ? await seedAllowanceOrder(db.pool, { handleSha256: TEST_HANDLE_SHA256, ...fields })
        : await seedOrder(db.pool, { amountMicros: 50_000, ...fields });
    const dep = (await ensureDeposit(db.pool, keys, order, CREATED, () => Buffer.alloc(16, 1)))!;
    if (o.account !== false) {
        await chain.createAta({ owner: dep.address, payer: feePayer });
        chain.advance(1);
    }
    return dep;
}

async function allowanceReady(id = ORDER_A): Promise<DepositRow> {
    await seedAccount(db.pool, { handleSha256: TEST_HANDLE_SHA256 });
    await db.pool.query(
        "update x402_pool set committed_micros = 0, unpaid_micros = 1003000 where id = 1",
    );
    return await deposit(id, { allowance: true });
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

function view(id: string, ip = "203.0.113.7", facts: Partial<ViewerFacts> = {}) {
    return watch.noteViewer(id, ipKey(ip), clock.getTime(), { ...OPEN, ...facts });
}

const ledgerOf = async (id = ORDER_A) => (await depositLedger(db.pool, id))!;
const depositOf = async (id = ORDER_A) => (await findDeposit(db.pool, id))!;
const orderOf = async (id = ORDER_A) => (await findOrder(db.pool, id))!;
const movesOf = async (id = ORDER_A): Promise<MoveRow[]> => (await ledgerOf(id)).moves;
const transferOf = async (signature: string, id = ORDER_A): Promise<TransferRow> =>
    (await ledgerOf(id)).transfers.find((t) => t.signature === signature)!;
const alarms = (name: string) => log.lines.filter((l) => l.alarm === name);
const creates = async (id: string) => (await movesOf(id)).filter((m) => m.kind === "create");
const methods = (lane: string, from = 0) =>
    laneCalls
        .slice(from)
        .filter((c) => c.lane === lane)
        .map((c) => c.method);

describe("depositInterval", () => {
    it("is busy_every when busy and idle_every otherwise", () => {
        expect(depositInterval(true, settings.deposits)).toBe(2_000);
        expect(depositInterval(false, settings.deposits)).toBe(20_000);
    });
});

describe("DepositWatch", () => {
    it("busy with a viewer, idle without", async () => {
        const t = clock.getTime();
        view(ORDER_A);
        expect(await depositsBusy(db.pool, watch, new Date(t + 29_000), cfg)).toBe(true);
        expect(await depositsBusy(db.pool, watch, new Date(t + 31_000), cfg)).toBe(false);
        // Past 80 % of the day's budget a viewer alone no longer makes the job busy
        expect(await depositsBusy(db.pool, watch, new Date(t + 29_000), cfg, 0.8)).toBe(false);
    });

    it("the viewer map takes facts and stays bounded", () => {
        const t = clock.getTime();
        expect(view(ORDER_A, "203.0.113.7", { state: "closed" })).toEqual({ first: false });
        expect(view(ORDER_A, "203.0.113.7", { expiresAtMs: t })).toEqual({ first: false });
        expect(watch.size()).toBe(0);
        expect(watch.viewerSeen(ORDER_A, t)).toBe(false);

        for (let i = 0; i < 10_001; i++) {
            watch.noteViewer(`ord_${i}`, ipKey("203.0.113.7"), t, { ...OPEN, needsCreate: false });
        }
        expect(watch.size()).toBe(10_000);
        expect(watch.viewerSeen("ord_0", t)).toBe(false);
        expect(watch.viewerSeen("ord_10000", t)).toBe(true);
        expect(watch.viewerOf("ord_10000")).toEqual({ key: "203.0.113.7", block: null });
    });

    it("wake fires once per first view that needs a create", async () => {
        let woken = 0;
        watch.wake.run = () => woken++;
        for (let i = 0; i < 30; i++) {
            expect(view(ORDER_A)).toEqual({ first: i === 0 });
            if (i === 0) view(ORDER_B, "203.0.113.8");
            later(2_000);
        }
        expect(woken).toBe(1);

        const other = createDepositWatch(cfg.viewer_ttl, cfg.busy_every);
        other.wake.run = () => woken++;
        other.noteViewer(ORDER_A, ipKey("203.0.113.7"), clock.getTime(), {
            ...OPEN,
            needsCreate: false,
        });
        expect(woken).toBe(1);
    });

    it("the first poll's create is signed and sent in the run it wakes", async () => {
        await deposit(ORDER_A, { account: false });
        const runs: Promise<DepositTick>[] = [];
        watch.wake.run = () => runs.push(tick());
        view(ORDER_A);
        // Called from inside noteViewer, not from a timer
        expect(runs).toHaveLength(1);
        const result = await runs[0]!;
        expect(result.moves.signed).toBe(1);
        const [move] = await creates(ORDER_A);
        expect(move).toMatchObject({ kind: "create", state: "sent" });
        expect(chain.submitted().map((s) => s.signature)).toContain(move!.txSignature);
    });
});

describe("depositRpcQueue", () => {
    it("serves moves, then reads, then scans, within the rate", async () => {
        const q = fakeQueue({ perSecond: 2 });
        const order: string[] = [];
        const call = (purpose: Parameters<DepositRpcQueue["rpc"]>[0], name: string) =>
            q
                .rpc(purpose)
                .getSlot()
                .send()
                .then(() => order.push(name));
        const start = clock.getTime();
        await Promise.all([
            call("deposits.scan", "scan1"),
            call("deposits.scan", "scan2"),
            call("deposits.scan", "scan3"),
            call("deposits.read", "read"),
            call("deposits.move", "move"),
        ]);
        // Two go at once; the rest wait for room and the move goes first, then the read
        expect(order).toEqual(["scan1", "scan2", "move", "read", "scan3"]);
        expect(clock.getTime() - start).toBe(2_000);
        expect(methods("rpc")).toEqual(["getSlot"]);
        expect(methods("bg")).toHaveLength(4);
    });

    it("counts the day without moves and alarms once at 80 % and once at 100 %", async () => {
        const q = fakeQueue({ perDay: 5 });
        for (let i = 0; i < 3; i++) await q.rpc("deposits.move").getSlot().send();
        expect(q.dayUsed()).toEqual({ calls: 0, fraction: 0 });
        for (let i = 0; i < 7; i++) await q.rpc("deposits.scan").getSlot().send();
        expect(q.dayUsed()).toEqual({ calls: 7, fraction: 1.4 });
        expect(alarms("deposit_rpc_budget")).toEqual([
            expect.objectContaining({ callsToday: 4, perDay: 5, mark: 0.8 }),
            expect.objectContaining({ callsToday: 5, perDay: 5, mark: 1 }),
        ]);
        // A new UTC day starts again
        clock = new Date("2030-01-02T00:00:00Z");
        expect(q.dayUsed()).toEqual({ calls: 0, fraction: 0 });
        await q.rpc("deposits.read").getSlot().send();
        expect(q.dayUsed().calls).toBe(1);
    });
});

describe("account creation caps", () => {
    const ids = () => [newOrderId(), newOrderId(), newOrderId()].sort();

    it("per-IP-key rented cap", async () => {
        const [a, b] = ids() as [string, string];
        await deposit(a, { account: false });
        await deposit(b, { account: false });
        view(a, "2a02:4780:c:ab47::1");
        view(b, "2a02:4780:c:ab47:ffff::2");
        await tick();
        expect(await creates(a)).toHaveLength(1);
        expect(await creates(b)).toHaveLength(0);
        expect((await depositOf(a)).viewerKey).toBe(viewerHash(SEED, "2a02:4780:c:ab47::/64"));
        expect((await depositOf(a)).viewerBlock).toBe(viewerHash(SEED, "2a02:4780:c::/48"));

        later(3_000);
        view(b, "2a02:4780:c:ab47:ffff::2");
        await tick();
        expect(await creates(b)).toHaveLength(0);

        await updateDeposit(db.pool, a, { state: "draining" });
        later(3_000);
        view(b, "2a02:4780:c:ab47:ffff::2");
        await tick();
        expect(await creates(b)).toHaveLength(1);
    });

    it("three /64s of one /48 get at most two creates", async () => {
        const all = ids();
        for (const id of all) await deposit(id, { account: false });
        for (const [i, id] of all.entries()) view(id, `2a02:4780:c:ab4${i}::1`);
        await tick();
        const made = await Promise.all(all.map(async (id) => (await creates(id)).length));
        expect(made).toEqual([1, 1, 0]);
    });

    it("rented counts survive a restart", async () => {
        const [a, b] = ids() as [string, string];
        await deposit(a, { account: false });
        await deposit(b, { account: false });
        view(a, "2a02:4780:c:ab47::1");
        await tick();
        expect(await creates(a)).toHaveLength(1);

        watch = createDepositWatch(cfg.viewer_ttl, cfg.busy_every);
        queue = fakeQueue();
        later(3_000);
        view(b, "2a02:4780:c:ab47::9");
        await tick();
        expect(await creates(b)).toHaveLength(0);
    });

    it("max_open counts open and settling deposits only", async () => {
        cfg = { ...cfg, max_open: 2 };
        const [a, b, c] = ids() as [string, string, string];
        for (const id of [a, b]) {
            await deposit(id);
            await updateDeposit(db.pool, id, { rentPayer: feePayer.address, readyAt: T0 });
        }
        // A settling deposit still holds its rent until the sweep lands
        await updateDeposit(db.pool, b, { state: "settling" });
        await deposit(c, { account: false });
        expect(await rentHolding(db.pool, feePayer.address)).toBe(2);
        view(c, "198.51.100.3");
        await tick();
        expect(await creates(c)).toHaveLength(0);

        await updateDeposit(db.pool, a, { state: "draining" });
        expect(await rentHolding(db.pool, feePayer.address)).toBe(1);
        later(3_000);
        view(c, "198.51.100.3");
        await tick();
        expect(await creates(c)).toHaveLength(1);
    });

    it("the unpaid-create budget stops creates and alarms once", async () => {
        cfg = { ...cfg, unpaid_create_lamports_per_hour: 31_600 };
        const [a, b, c] = ids() as [string, string, string];
        for (const id of [a, b, c]) await deposit(id, { account: false });
        view(a, "198.51.100.1");
        view(b, "198.51.100.2");
        await tick();
        expect((await creates(a)).length + (await creates(b)).length).toBe(2);
        await ticks(2, 3_000, () => {
            view(a, "198.51.100.1");
            view(b, "198.51.100.2");
        });
        expect((await creates(a))[0]!.state).toBe("confirmed");

        await ticks(3, 3_000, () => view(c, "198.51.100.3"));
        expect(await creates(c)).toHaveLength(0);
        expect(alarms("deposit_create_churn")).toHaveLength(1);

        await send("A", 2_000n, a);
        await ticks(3, 3_000, () => view(c, "198.51.100.3"));
        expect((await ledgerOf(a)).transfers).toHaveLength(1);
        expect(await creates(c)).toHaveLength(1);
        expect(alarms("deposit_create_churn")).toHaveLength(1);
    });

    it("deposit_capacity fires once an hour", async () => {
        cfg = { ...cfg, max_open: 1 };
        const far = { expiresAt: at("03:00:00") };
        const [a, b] = ids() as [string, string];
        await deposit(a, { over: far });
        await updateDeposit(db.pool, a, { rentPayer: feePayer.address, readyAt: T0 });
        await deposit(b, { account: false, over: far });
        const farOpen = { expiresAtMs: at("03:00:00").getTime() };
        for (let minute = 0; minute <= 59; minute += 1) {
            view(b, "198.51.100.3", farOpen);
            await tick();
            later(MIN);
        }
        expect(alarms("deposit_capacity")).toHaveLength(1);
        clock = new Date(T0.getTime() + 61 * MIN);
        view(b, "198.51.100.3", farOpen);
        await tick();
        expect(alarms("deposit_capacity")).toHaveLength(2);
        expect(await creates(b)).toHaveLength(0);
    });
});

describe("the job's RPC calls", () => {
    it("the deposit job's RPC calls have their own counter", async () => {
        const counted = countedLanes(lanes, {
            limitPerHour: 1,
            log,
            now: () => clock.getTime(),
        });
        await counted.rpc.getSlot().send();
        expect(alarms("deposit_rpc_budget")).toHaveLength(0);
        await counted.backgroundRpc.getSlot().send();
        expect(alarms("deposit_rpc_budget")).toHaveLength(1);

        log = memoryLog();
        const fresh = countedLanes(lanes, { limitPerHour: 1, log, now: () => clock.getTime() });
        queue = depositRpcQueue(fresh, {
            perSecond: 1_000,
            perDay: 1_000_000,
            now: () => clock.getTime(),
            log,
        });
        await deposit(ORDER_A, { account: false });
        view(ORDER_A);
        await tick();
        later(3_000);
        await tick();
        expect(alarms("deposit_rpc_budget").length).toBeGreaterThanOrEqual(1);
        expect(alarms("x402_rpc_budget")).toHaveLength(0);
        expect(new Set(laneCalls.map((c) => c.lane))).toEqual(new Set(["rpc", "bg"]));
    });

    it("the job's calls keep their order", async () => {
        queue = fakeQueue({ perSecond: 2 });
        await deposit(ORDER_A, { account: false });
        await deposit(ORDER_B);
        await ticks(3);
        expect((await depositOf(ORDER_B)).rentPayer).toBe(feePayer.address);
        view(ORDER_A);
        await tick();
        expect((await creates(ORDER_A))[0]!.state).toBe("sent");
        await send("B", 2_000n, ORDER_B);
        later(3_000);
        // A page watches B, so B is read on this busy tick
        view(ORDER_B, "198.51.100.9", { needsCreate: false });
        const mark = laneCalls.length;
        await tick();

        const calls = laneCalls.slice(mark);
        const kinds = calls.map((c) =>
            c.method === "getMultipleAccounts"
                ? "read"
                : c.method === "getSignaturesForAddress" || c.lane === "bg"
                  ? "scan"
                  : "move",
        );
        const firstRead = kinds.indexOf("read");
        expect(kinds.slice(0, firstRead).every((k) => k === "move")).toBe(true);
        expect(firstRead).toBeGreaterThan(0);
        expect(kinds.slice(firstRead + 1).every((k) => k === "scan")).toBe(true);
        expect(kinds.lastIndexOf("scan")).toBeGreaterThan(firstRead);
        // No more than two calls in any second of the job's clock
        const busiest = Math.max(
            ...calls.map((c) => calls.filter((o) => o.at >= c.at && o.at < c.at + 1_000).length),
        );
        expect(busiest).toBe(2);
        expect((await creates(ORDER_A))[0]!.state).toBe("confirmed");
        // The time box ends this tick's scan; the next one goes on and records the transfer
        view(ORDER_B, "198.51.100.9", { needsCreate: false });
        await ticks(1);
        expect((await ledgerOf(ORDER_B)).transfers).toHaveLength(1);
    });
});

// Fails every call, as a router with no endpoint left does
function failing(): SolanaRpc {
    return new Proxy(chain.rpc, {
        get: (target, prop, recv) => {
            const value: unknown = Reflect.get(target, prop, recv);
            if (typeof value !== "function") return value;
            return () => ({
                send: async () => {
                    throw new RpcRouterError("no_endpoint");
                },
            });
        },
    });
}

describe("lanes", () => {
    it("the job's calls name their lane", async () => {
        // The first send of every transaction is lost on its way, so the create needs a re-sign
        let sends = 0;
        const lossy = new Proxy(chain.rpc, {
            get: (target, prop, recv) => {
                if (prop !== "sendTransaction") return Reflect.get(target, prop, recv);
                return (wire: string, config: Record<string, unknown>) => ({
                    send: async () =>
                        sends++ === 0
                            ? getSignatureFromTransaction(
                                  getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
                              )
                            : chain.rpc.sendTransaction(wire as never, config as never).send(),
                });
            },
        });
        lanes = { rpc: recording(lossy, "rpc"), backgroundRpc: recording(chain.rpc, "bg") };
        queue = fakeQueue();
        await deposit(ORDER_A, { account: false });
        view(ORDER_A);
        const createMark = laneCalls.length;
        await tick();
        expect((await creates(ORDER_A))[0]!.state).toBe("sent");
        // The lost create's blockhash expires; the proof reads and scans on the money lane
        chain.advance(200);
        chain.finalize();
        const proofMark = laneCalls.length;
        await ticks(1, 3_000, () => view(ORDER_A));
        expect((await creates(ORDER_A))[0]).toMatchObject({ state: "sent", attempts: 2 });
        expect(methods("rpc", proofMark)).toEqual(
            expect.arrayContaining([
                "getEpochInfo",
                "getSignatureStatuses",
                "getMultipleAccounts",
                "getSignaturesForAddress",
                "getLatestBlockhash",
                "sendTransaction",
            ]),
        );
        // The create's own meta is read on the money lane, not from a background scan's cache
        cache = new TxCache(10_000);
        const metaMark = laneCalls.length;
        await ticks(1, 3_000, () => view(ORDER_A));
        expect((await creates(ORDER_A))[0]!.state).toBe("confirmed");
        expect(laneCalls.slice(metaMark).find((c) => c.method === "getTransaction")?.lane).toBe(
            "rpc",
        );
        expect(methods("rpc", createMark).slice(0, 2)).toEqual([
            "getLatestBlockhash",
            "sendTransaction",
        ]);

        await send("A", 50_000n);
        const settleMark = laneCalls.length;
        await ticks(1, 3_000, () => view(ORDER_A));
        expect((await orderOf()).state).toBe("settling");
        expect(checks.map((c) => c.payer)).toContain(owners.A.address);
        const settleRpc = methods("rpc", settleMark);
        expect(settleRpc.slice(-3)).toEqual([
            "getMultipleAccounts",
            "getLatestBlockhash",
            "sendTransaction",
        ]);

        // An unpaid deposit past its grace pins its expiry slot on the background lane
        await deposit(ORDER_B);
        clock = at("00:16:05");
        chain.setBlockTime(at("00:16:00").getTime() / 1000);
        const pinMark = laneCalls.length;
        await tick();
        expect((await depositOf(ORDER_B)).expiryMinSlot).not.toBeNull();
        expect(methods("bg", pinMark)).toEqual(expect.arrayContaining(["getSlot", "getBlockTime"]));
        expect(methods("rpc", pinMark)).not.toContain("getSlot");

        const bg = new Set(methods("bg"));
        expect(bg).toEqual(
            new Set([
                "getMultipleAccounts",
                "getSignaturesForAddress",
                "getSlot",
                "getBlockTime",
                ...(bg.has("getTransaction") ? ["getTransaction"] : []),
            ]),
        );
        expect(methods("bg")).toContain("getSignaturesForAddress");
        expect(methods("bg")).not.toContain("sendTransaction");
    });

    it("settle goes on while the background lane fails", async () => {
        await deposit();
        await send("A", 50_000n);
        verdicts.set(owners.A.address, "busy");
        await ticks(2, 3_000, () => view(ORDER_A, "203.0.113.7", { needsCreate: false }));
        expect((await holdsOf(db.pool, ORDER_A)).map((h) => h.reason)).toEqual(["payer_busy"]);
        expect((await depositOf()).checkedAt).not.toBeNull();

        verdicts.clear();
        lanes = { rpc: recording(chain.rpc, "rpc"), backgroundRpc: failing() };
        queue = fakeQueue();
        later(11_000);
        const mark = laneCalls.length;
        const result = await tick();
        expect(result.settled).toBe(1);
        expect((await orderOf()).state).toBe("settling");
        expect((await findPaymentByOrder(db.pool, ORDER_A))!.payerCounted).toBe(true);
        expect(methods("rpc", mark)).toEqual([
            "getMultipleAccounts",
            "getLatestBlockhash",
            "sendTransaction",
        ]);
        expect(laneCalls.slice(mark).every((c) => c.lane === "rpc")).toBe(true);
        expect(log.lines).toContainEqual(
            expect.objectContaining({ msg: "deposit balance read failed, retrying next tick" }),
        );
    });

    it("expiry_due_at is set without the RPC", async () => {
        await deposit();
        await send("A", 30_000n);
        lanes = { rpc: failing(), backgroundRpc: failing() };
        queue = fakeQueue();
        clock = at("00:16:05");
        const before = await depositOf();
        await tick();
        const after = await depositOf();
        expect(after).toEqual({
            ...before,
            expiryDueAt: at("00:16:05"),
            hardStopAt: at("00:21:05"),
        });
        expect((await orderOf()).state).toBe("unpaid");
        expect((await ledgerOf()).transfers).toEqual([]);
    });

    it("the balance batch is pinned to the expiry slot when it is the highest", async () => {
        await deposit();
        await ticks(1);
        const pin = (await depositOf()).checkedSlot! + 5n;
        chain.advance(10);
        await updateDeposit(db.pool, ORDER_A, { expiryMinSlot: pin });
        const mark = chain.calls().length;
        later(cfg.idle_every);
        await tick();
        const read = chain
            .calls()
            .slice(mark)
            .find((x) => x.method === "getMultipleAccounts")!;
        expect((read.params[1] as { minContextSlot: number }).minContextSlot).toBe(Number(pin));
    });

    it("a fault that is no RPC error is logged as an error with its message", async () => {
        await deposit();
        await ticks(1);
        const broken = (method: string): DepositRpcQueue => ({
            rpc: (purpose) =>
                new Proxy(queue.rpc(purpose), {
                    get: (target, prop, recv) =>
                        prop === method
                            ? () => ({
                                  send: () => Promise.reject(new TypeError(`${method} bug`)),
                              })
                            : Reflect.get(target, prop, recv),
                }),
            dayUsed: () => queue.dayUsed(),
        });
        later(cfg.idle_every);
        await tick({ queue: broken("getMultipleAccounts") });
        clock = at("00:16:05");
        await tick({ queue: broken("getSlot") });
        const errors = log.lines.filter((l) => l.level === "error");
        expect(errors).toContainEqual(
            expect.objectContaining({
                msg: "deposit balance read failed, retrying next tick",
                err: expect.objectContaining({ message: "getMultipleAccounts bug" }),
            }),
        );
        expect(errors).toContainEqual(
            expect.objectContaining({
                msg: "deposit expiry pin failed, retrying next tick",
                orderId: ORDER_A,
                err: expect.objectContaining({ message: "getSlot bug" }),
            }),
        );
    });
});

function sweepDeps(now: Date) {
    return {
        pool: db.pool,
        router: routerClient,
        orders: settings.orders,
        funding: paid.funding,
        x402,
        log,
        now: () => now,
        unavailableAlarmed: new Set<string>(),
    };
}

// A ledger row the chain never saw keeps every read below the ledger until it is deleted
async function phantom(id: string, slot: bigint): Promise<string> {
    const signature = `phantom${++memoSeq}`;
    await db.pool.query(
        `insert into deposit_transfers (order_id, signature, slot, seq, block_time, seen_at,
            amount_micros, outcome, reason)
         values ($1, $2, $3, 99, $4, $4, 1000, 'review', 'unattributed')`,
        [id, signature, slot.toString(), PAID_AT],
    );
    return signature;
}

describe("holds and the hard stop", () => {
    it("held money after the hard stop keeps its hold's reason", async () => {
        await deposit();
        const a1 = await send("A", 30_000n);
        const b1 = await send("B", 30_000n);
        verdicts.set("", "busy");
        await ticks(2, 3_000, () => view(ORDER_A, "203.0.113.7", { needsCreate: false }));
        expect((await holdsOf(db.pool, ORDER_A)).map((h) => [h.owner, h.reason])).toEqual([
            ["", "anonymous_busy"],
        ]);
        const fake = await phantom(ORDER_A, (await transferOf(b1)).slot);

        clock = at("00:16:05");
        await tick();
        expect(await depositOf()).toMatchObject({
            expiryDueAt: at("00:16:05"),
            hardStopAt: at("00:21:05"),
        });
        clock = at("00:21:05");
        expect((await sweep(sweepDeps(clock))).expired).toBe(1);
        expect((await orderOf()).state).toBe("expired");
        expect(alarms("deposit_review")).toContainEqual(
            expect.objectContaining({ orderId: ORDER_A, reason: "expired_unchecked" }),
        );

        while (clock < at("00:22:00")) {
            later(2_000);
            await tick();
        }
        expect((await depositOf()).state).toBe("draining");
        expect((await transferOf(a1)).outcome).toBe("open");
        expect((await transferOf(b1)).outcome).toBe("open");

        await db.pool.query("delete from deposit_transfers where signature = $1", [fake]);
        later(2_000);
        await tick();
        expect(await transferOf(a1)).toMatchObject({ outcome: "return", reason: "pool_busy" });
        expect(await transferOf(b1)).toMatchObject({ outcome: "return", reason: "pool_busy" });
        expect(await holdsOf(db.pool, ORDER_A)).toEqual([]);
        expect((await movesOf()).filter((m) => m.kind === "return")).toEqual([
            expect.objectContaining({ amountMicros: 30_000, destination: sources.A }),
        ]);
    });
});

describe("the scan queue", () => {
    it("the scan queue is fair and time-boxed", async () => {
        const x = await deposit(ORDER_A);
        const y = await deposit(ORDER_B, { over: { expiresAt: at("00:14:00") } });
        const viewBoth = () => {
            view(ORDER_A, "198.51.100.1", { needsCreate: false });
            view(ORDER_B, "198.51.100.2", { needsCreate: false });
        };
        await ticks(2, 3_000, viewBoth);
        expect((await depositOf(ORDER_A)).lastSignature).not.toBeNull();
        expect((await depositOf(ORDER_B)).lastSignature).not.toBeNull();

        await send("C", 2_000n, ORDER_A);
        for (let i = 0; i < 40; i++) {
            await chain.noOp({ touching: x.tokenAccount, signer: owners.D });
        }
        chain.advance(1);
        const y1 = await send("B", 2_000n, ORDER_B);
        const mark = chain.calls().length;
        await ticks(1, 3_000, viewBoth);
        expect(await transferOf(y1, ORDER_B)).toMatchObject({ outcome: "open" });
        const scanCalls = chain
            .calls()
            .slice(mark)
            .filter((c) => c.method === "getSignaturesForAddress" || c.method === "getTransaction")
            .map((c) => {
                const p0 = String(c.params[0]);
                if (p0 === x.tokenAccount) return "X";
                if (p0 === y.tokenAccount) return "Y";
                return c.method === "getTransaction" ? "tx" : "?";
            });
        // Y comes first, then the two alternate: Y and X list, Y and X prove, then each fetches
        expect(scanCalls.slice(0, 4)).toEqual(["Y", "X", "Y", "X"]);
        expect(scanCalls.slice(4, 6)).toEqual(["tx", "tx"]);

        // With time passing on every call, a tick stops scanning once the box is spent
        cfg = { ...cfg, scan_time_box: 500 };
        perCallMs = 100;
        await send("C", 2_000n, ORDER_A);
        for (let i = 0; i < 40; i++) {
            await chain.noOp({ touching: x.tokenAccount, signer: owners.D });
        }
        chain.advance(1);
        const counts: number[] = [];
        const firsts: string[] = [];
        for (let i = 0; i < 3; i++) {
            const before = chain.calls().length;
            await ticks(1, 3_000, viewBoth);
            const scans = chain
                .calls()
                .slice(before)
                .filter(
                    (c) => c.method === "getSignaturesForAddress" || c.method === "getTransaction",
                );
            counts.push(scans.length);
            firsts.push(scans[0]?.method ?? "none");
        }
        expect(Math.max(...counts)).toBeLessThanOrEqual(5);
        expect(counts[0]).toBe(5);
        // The next tick goes on fetching where the last one stopped, with no new listing
        expect(firsts.slice(1)).toEqual(["getTransaction", "getTransaction"]);
    });

    it("the scan round goes on across ticks, so no deposit starves", async () => {
        const ids = Array.from({ length: 6 }, () => newOrderId()).sort();
        const deps: DepositRow[] = [];
        for (const [i, id] of ids.entries()) {
            const expiresAt = new Date(at("00:10:00").getTime() + i * MIN);
            deps.push(await deposit(id, { over: { expiresAt } }));
        }
        const viewAll = () => {
            for (const [i, id] of ids.entries()) {
                view(id, `198.51.100.${i + 1}`, { needsCreate: false });
            }
        };
        await ticks(2, 3_000, viewAll);
        // Every deposit gets a transfer and padding that takes many scan calls to fetch
        for (const [i, dep] of deps.entries()) {
            await send((["A", "B", "C", "D", "E", "F"] as const)[i]!, 2_000n, dep.orderId);
            for (let n = 0; n < 10; n++) {
                await chain.noOp({ touching: dep.tokenAccount, signer: owners.H });
            }
        }
        chain.advance(1);

        // A box that admits two scan calls a tick
        cfg = { ...cfg, scan_time_box: 200 };
        perCallMs = 100;
        const listed = new Set<string>();
        for (let i = 0; i < 3; i++) {
            const before = chain.calls().length;
            await ticks(1, 3_000, viewAll);
            const scans = chain
                .calls()
                .slice(before)
                .filter(
                    (c) => c.method === "getSignaturesForAddress" || c.method === "getTransaction",
                );
            expect(scans.length).toBeLessThanOrEqual(2);
            for (const c of scans) {
                if (c.method === "getSignaturesForAddress") listed.add(String(c.params[0]));
            }
        }
        // Each scan's first call is its listing: all six had theirs within three ticks
        expect([...listed].sort()).toEqual(deps.map((d) => d.tokenAccount).sort());
    });
});

describe("the daily budget", () => {
    it("the job's daily RPC budget falls back", async () => {
        const ids = [newOrderId(), newOrderId(), newOrderId(), newOrderId(), newOrderId()].sort();
        const [v, u, c, p, m] = ids as [string, string, string, string, string];
        await deposit(v);
        await deposit(u);
        await deposit(c);
        await deposit(p);
        await deposit(m, { account: false });
        const viewAll = () => {
            view(v, "198.51.100.1", { needsCreate: false });
            view(u, "198.51.100.2", { needsCreate: false });
        };
        await ticks(2, 3_000, viewAll);
        // U holds money its scan cannot record yet
        const hidden = await send("A", 2_000n, u);
        chain.withholdTransaction(hidden, 1_000);
        await ticks(2, 3_000, viewAll);
        expect((await ledgerOf(u)).transfers).toEqual([]);

        queue = fakeQueue({ perDay: 20 });
        for (let i = 0; i < 16; i++) await queue.rpc("deposits.read").getSlot().send();
        expect(alarms("deposit_rpc_budget")).toHaveLength(1);
        const account = async (id: string) => (await depositOf(id)).tokenAccount;
        const readOf = (from: number) =>
            chain
                .calls()
                .slice(from)
                .filter((x) => x.method === "getMultipleAccounts")
                .flatMap((x) => x.params[0] as string[]);
        let mark = chain.calls().length;
        await ticks(1, 3_000, viewAll);
        expect(readOf(mark)).toContain(await account(u));
        expect(readOf(mark)).not.toContain(await account(v));
        mark = chain.calls().length;
        clock = new Date(clock.getTime() + cfg.idle_every);
        viewAll();
        await tick();
        expect(readOf(mark)).toContain(await account(v));

        while (queue.dayUsed().calls < 20) await queue.rpc("deposits.read").getSlot().send();
        expect(alarms("deposit_rpc_budget")).toHaveLength(2);
        // C is closed and gets late money; P is unpaid and paid in full; M has a move to sign
        await db.pool.query("update orders set state = 'expired' where id = $1", [c]);
        await updateDeposit(db.pool, c, { state: "closed", checkedAt: null });
        await send("B", 2_000n, c);
        await send("C", 50_000n, p);
        await withTx(db.pool, async (tx) => {
            await tx.query(
                `insert into deposit_moves (order_id, kind, created_at) values ($1, 'create', $2)`,
                [m, clock],
            );
        });
        // Reads keep the idle pace
        mark = chain.calls().length;
        await ticks(1, cfg.idle_every, viewAll);
        const scanned = chain
            .calls()
            .slice(mark)
            .filter((x) => x.method === "getSignaturesForAddress")
            .map((x) => x.params[0]);
        expect(scanned).toContain(await account(p));
        expect(scanned).not.toContain(await account(c));
        expect((await creates(m))[0]!.state).toBe("sent");
        expect((await orderOf(p)).state).toBe("settling");
        expect((await movesOf(p)).find((x) => x.kind === "sweep")!.state).toBe("sent");
        expect(alarms("deposit_rpc_budget")).toHaveLength(2);
    });
});

describe("a deposit in review", () => {
    it("is read at the closed pace and never keeps the job busy", async () => {
        const dep = await deposit();
        await send("A", 30_000n);
        await ticks(2, 3_000, () => view(ORDER_A, "203.0.113.7", { needsCreate: false }));
        expect((await ledgerOf()).transfers).toHaveLength(1);
        // A debit only a leaked key could sign, which no ledger row explains
        chain.debit(dep.tokenAccount, 30_000n);
        chain.advance(1);
        later(cfg.idle_every);
        await tick();
        expect((await depositOf()).reviewReason).toBe("unknown_debit");
        expect(alarms("deposit_unknown_debit")).toHaveLength(1);
        // The page's viewer is gone, and the next tick sees the review
        later(cfg.viewer_ttl);
        await tick();

        const mark = chain.calls().length;
        const reads = () =>
            chain
                .calls()
                .slice(mark)
                .filter(
                    (x) =>
                        x.method === "getMultipleAccounts" &&
                        (x.params[0] as string[]).includes(dep.tokenAccount),
                ).length;
        expect(await depositsBusy(db.pool, watch, clock, cfg)).toBe(false);
        await ticks(30, cfg.busy_every);
        expect(reads()).toBeLessThanOrEqual(1);
        expect(await depositsBusy(db.pool, watch, clock, cfg)).toBe(false);
        await ticks(1, cfg.closed_every);
        expect(reads()).toBeGreaterThanOrEqual(1);
    });
});

describe("money a write-off took", () => {
    it("is owed by the float, so it keeps no deposit busy", async () => {
        await deposit(ORDER_A, { account: false });
        await db.pool.query("update orders set state = 'expired' where id = $1", [ORDER_A]);
        await db.pool.query("update deposits set state = 'draining' where order_id = $1", [
            ORDER_A,
        ]);
        await db.pool.query(
            `insert into deposit_transfers (order_id, signature, slot, seq, block_time, seen_at,
                amount_micros, source_token_account, source_owner, outcome, reason)
             values ($1, 'stolen-from', 100, 0, $2, $2, 5000, $3, $4, 'return', 'unpaid')`,
            [ORDER_A, PAID_AT, sources.A, owners.A.address],
        );
        expect(await depositsBusy(db.pool, watch, clock, cfg)).toBe(true);
        await seedWriteOffPart(db.pool, ORDER_A, {
            transferSignature: "stolen-from",
            micros: 5_000,
        });
        expect(await depositsBusy(db.pool, watch, clock, cfg)).toBe(false);
    });
});

describe("early blocked check", () => {
    it("a blocked owner's money is returned when it arrives", async () => {
        await deposit();
        verdicts.set(owners.B.address, "blocked");
        const b1 = await send("B", 2_000n);
        const result = await (async () => {
            later(3_000);
            view(ORDER_A, "203.0.113.7", { needsCreate: false });
            return await tick();
        })();
        expect(result.blockedEarly).toBe(1);
        expect(await transferOf(b1)).toMatchObject({
            outcome: "return",
            reason: "payer_blocked",
            blockedUntil: new Date(BLOCKED_UNTIL),
        });
        const shown = (await depositView(db.pool, await orderOf(), clock, cfg))!;
        expect(shown).toMatchObject({ receivedMicros: 0, remainingMicros: 50_000 });
        expect(result.settled).toBe(0);
        expect((await movesOf()).some((x) => x.kind === "sweep")).toBe(false);
        expect(checks).toEqual([{ payer: owners.B.address, packageId: "pkg-test", kind: "start" }]);

        const b2 = await send("B", 3_000n);
        const a1 = await send("A", 2_000n);
        await ticks(3, 3_000, () => view(ORDER_A, "203.0.113.7", { needsCreate: false }));
        expect(await transferOf(b2)).toMatchObject({ outcome: "return", reason: "payer_blocked" });
        expect((await transferOf(a1)).outcome).toBe("open");
        const a2 = await send("A", 2_000n);
        await ticks(3, 3_000, () => view(ORDER_A, "203.0.113.7", { needsCreate: false }));
        expect((await transferOf(a2)).outcome).toBe("open");
        expect(checks.map((x) => x.payer)).toEqual([owners.B.address, owners.A.address]);

        // Seven new owners of another deposit: at most max_split_owners + 1 are checked early
        await deposit(ORDER_B);
        checks = [];
        for (const n of ["C", "D", "E", "F", "G", "H", "A"] as const)
            await send(n, 2_000n, ORDER_B);
        await ticks(3, 3_000, () => view(ORDER_B, "203.0.113.8", { needsCreate: false }));
        expect((await ledgerOf(ORDER_B)).transfers).toHaveLength(7);
        expect(checks).toHaveLength(cfg.max_split_owners + 1);
    });

    it("an owner the router could not check is asked again", async () => {
        await deposit();
        verdicts.set(owners.B.address, "unavailable");
        const b1 = await send("B", 2_000n);
        const viewA = () => view(ORDER_A, "203.0.113.7", { needsCreate: false });
        await ticks(1, 3_000, viewA);
        expect(checks.map((x) => x.payer)).toEqual([owners.B.address]);
        expect((await transferOf(b1)).outcome).toBe("open");
        verdicts.set(owners.B.address, "blocked");
        await ticks(1, 3_000, viewA);
        expect(checks.map((x) => x.payer)).toEqual([owners.B.address, owners.B.address]);
        expect(await transferOf(b1)).toMatchObject({ outcome: "return", reason: "payer_blocked" });
    });

    it("an allowance order's early check sends extend", async () => {
        await allowanceReady();
        verdicts.set(owners.B.address, "blocked");
        const b1 = await send("B", 2_000n);
        later(3_000);
        view(ORDER_A, "203.0.113.7", { needsCreate: false });
        await tick();
        expect(checks).toEqual([
            { payer: owners.B.address, packageId: "cpu-small", kind: "extend" },
        ]);
        expect(await transferOf(b1)).toMatchObject({ outcome: "return", reason: "payer_blocked" });
        const shown = (await depositView(db.pool, await orderOf(), clock, cfg))!;
        expect(shown.receivedMicros).toBe(0);
    });
});

describe("the free-move budget", () => {
    it("the budget alarm fires once", async () => {
        cfg = { ...cfg, free_moves_lamports_per_hour: 20_000 };
        const ids = [newOrderId(), newOrderId(), newOrderId(), newOrderId()].sort();
        const senders: Owner[] = ["A", "B", "C"];
        for (const [i, id] of ids.slice(0, 3).entries()) {
            await deposit(id, { account: false });
            const dep = await depositOf(id);
            await chain.transfer({
                authority: owners[senders[i]!],
                feePayer: owners[senders[i]!],
                source: sources[senders[i]!],
                destination: dep.tokenAccount,
                micros: 2_000n,
                memo: `t${++memoSeq}`,
                createDestinationFor: dep.address,
            });
            chain.advance(1);
        }
        // The fourth account was made by Bugnet, so its closing return pays the rent back
        await deposit(ids[3]!);
        await send("D", 2_000n, ids[3]!);
        await ticks(2);
        for (const id of ids) {
            expect((await ledgerOf(id)).transfers).toHaveLength(1);
            await db.pool.query("update orders set state = 'expired' where id = $1", [id]);
        }
        await ticks(4);
        const returns = await Promise.all(
            ids.map(async (id) => (await movesOf(id)).filter((x) => x.kind === "return")),
        );
        expect(returns.map((r) => r.length)).toEqual([1, 1, 0, 1]);
        expect(returns[3]![0]).toMatchObject({ closes: true, closeTo: feePayer.address });
        expect(returns[3]![0]!.state).not.toBe("pending");
        expect(returns[0]![0]).toMatchObject({ closes: true, closeTo: owners.A.address });
        expect(alarms("deposit_fee_budget")).toHaveLength(1);
        await ticks(5);
        expect(alarms("deposit_fee_budget")).toHaveLength(1);
        expect((await movesOf(ids[2]!)).filter((x) => x.kind === "return")).toEqual([]);
    });
});

describe("the hard stop and a scan that is catching up", () => {
    const busyView = () => view(ORDER_A, "203.0.113.7", { needsCreate: false });

    it("the hard stop waits for a scan that is catching up", async () => {
        queue = fakeQueue({ perSecond: 1 });
        const dep = await deposit();
        await ticks(2);
        // The payment, then 400 padding entries with a small transfer every 100 of them
        const a1 = await send("A", 50_000n);
        for (const small of ["C", "D", "E"] as const) {
            for (let i = 0; i < 100; i++) {
                await chain.noOp({ touching: dep.tokenAccount, signer: owners.H });
            }
            await send(small, 1_000n);
        }
        for (let i = 0; i < 100; i++) {
            await chain.noOp({ touching: dep.tokenAccount, signer: owners.H });
        }
        chain.advance(1);

        clock = at("00:16:00");
        const stops: number[] = [];
        let sweeps = 0;
        while ((await orderOf()).state === "unpaid") {
            busyView();
            await tick();
            const d = await depositOf();
            if (d.hardStopAt !== null) stops.push(d.hardStopAt.getTime());
            if (++sweeps % 15 === 0) expect((await sweep(sweepDeps(clock))).expired).toBe(0);
            expect(clock.getTime()).toBeLessThan(at("00:46:00").getTime());
            later(cfg.busy_every);
        }
        const due = (await depositOf()).expiryDueAt!.getTime();
        expect(new Set(stops).size).toBeGreaterThan(1);
        expect(Math.max(...stops)).toBeLessThanOrEqual(due + cfg.expire_hard_max);
        expect(alarms("deposit_index_lag").filter((l) => "hardStopAt" in l).length).toBe(
            new Set(stops).size - 1,
        );
        expect((await orderOf()).state).toBe("settling");
        expect((await findPaymentByOrder(db.pool, ORDER_A))!.createdAt).toEqual(PAID_AT);
        expect((await transferOf(a1)).outcome).toBe("paid");
    }, 300_000);

    it("the hard stop waits while a scan fetches padding before the payment", async () => {
        cfg = { ...cfg, expire_hard_after: MIN };
        queue = fakeQueue({ perSecond: 1 });
        const dep = await deposit();
        await ticks(2);
        // Newest first, the scan reaches the payment only after every padding entry
        const a1 = await send("A", 50_000n);
        for (let i = 0; i < 300; i++) {
            await chain.noOp({ touching: dep.tokenAccount, signer: owners.H });
        }
        chain.advance(1);

        clock = at("00:16:00");
        let sweeps = 0;
        while ((await orderOf()).state === "unpaid") {
            busyView();
            await tick();
            if (++sweeps % 15 === 0) expect((await sweep(sweepDeps(clock))).expired).toBe(0);
            expect(clock.getTime()).toBeLessThan(at("00:46:00").getTime());
            later(cfg.busy_every);
        }
        expect((await orderOf()).state).toBe("settling");
        expect((await findPaymentByOrder(db.pool, ORDER_A))!.createdAt).toEqual(PAID_AT);
        expect((await transferOf(a1)).outcome).toBe("paid");
    }, 300_000);

    it("a push never loses the race with the sweeper", async () => {
        await deposit();
        await ticks(2);
        const a1 = await send("A", 50_000n);
        chain.withholdTransaction(a1, 10_000);
        await send("C", 1_000n);
        await updateDeposit(db.pool, ORDER_A, {
            expiryDueAt: at("00:16:00"),
            hardStopAt: at("00:21:00"),
            expiryMinSlot: chain.slot(),
        });
        // This tick starts just before the stop's last busy_every. Ticks come busy_every after
        // the previous one ends, so the next one starts after the stop, when the sweeper may
        // already have run.
        clock = new Date(at("00:21:00").getTime() - cfg.busy_every - 1);
        perCallMs = 100;
        busyView();
        await tick();
        expect((await ledgerOf()).transfers).toHaveLength(1);
        clock = at("00:21:00");
        expect((await sweep(sweepDeps(clock))).expired).toBe(0);
        expect((await orderOf()).state).toBe("unpaid");
        expect((await depositOf()).hardStopAt!.getTime()).toBeGreaterThan(at("00:21:00").getTime());
        expect(alarms("deposit_index_lag").filter((l) => "hardStopAt" in l)).toHaveLength(1);
    });

    it("a scan that stalls after progress lets the sweeper expire the order", async () => {
        await deposit();
        await ticks(2);
        const a1 = await send("A", 50_000n);
        chain.withholdTransaction(a1, 100_000);
        await send("C", 1_000n);
        clock = at("00:20:00");
        await updateDeposit(db.pool, ORDER_A, {
            expiryDueAt: at("00:16:00"),
            hardStopAt: at("00:21:00"),
            expiryMinSlot: chain.slot(),
        });
        // C1 is recorded at 00:20:00, and after it nothing more is
        busyView();
        await tick();
        expect((await ledgerOf()).transfers).toHaveLength(1);
        while (clock < at("00:30:00")) {
            later(10_000);
            await tick();
        }
        // The last move is within expire_hard_after of the last progress, and the stop comes
        // expire_hard_after after it
        const stop = (await depositOf()).hardStopAt!;
        expect(stop.getTime()).toBeLessThanOrEqual(at("00:20:00").getTime() + 2 * 5 * MIN);
        expect((await sweep(sweepDeps(new Date(stop.getTime() - 1)))).expired).toBe(0);
        expect((await sweep(sweepDeps(stop))).expired).toBe(1);
        expect((await orderOf()).state).toBe("expired");
    });

    it("with the scan making no progress, the sweeper expires the order", async () => {
        await deposit();
        await ticks(2);
        const a1 = await send("A", 50_000n);
        chain.withholdTransaction(a1, 10_000);
        clock = at("00:16:00");
        while (clock < at("00:21:10")) {
            busyView();
            await tick();
            later(10_000);
        }
        expect((await depositOf()).hardStopAt).toEqual(at("00:21:00"));
        expect((await sweep(sweepDeps(clock))).expired).toBe(1);
        expect(alarms("deposit_index_lag").filter((l) => "hardStopAt" in l)).toEqual([]);
    });

    it("a read above the ledger by less than the price lacks is not pushed", async () => {
        await deposit();
        await ticks(2);
        // The newer small transfer is recorded while the older one stays unindexed
        const a1 = await send("A", 10_000n);
        chain.withholdTransaction(a1, 10_000);
        await send("C", 1_000n);
        clock = at("00:20:50");
        await updateDeposit(db.pool, ORDER_A, {
            expiryDueAt: at("00:16:00"),
            hardStopAt: at("00:21:00"),
            expiryMinSlot: chain.slot(),
        });
        for (let i = 0; i < 6; i++) {
            busyView();
            await tick();
            later(2_000);
        }
        expect((await ledgerOf()).transfers).toHaveLength(1);
        expect((await depositOf()).hardStopAt).toEqual(at("00:21:00"));
    });

    it("the hard stop never moves past expiry_due_at + expire_hard_max", async () => {
        await deposit();
        await ticks(2);
        const a1 = await send("A", 50_000n);
        chain.withholdTransaction(a1, 10_000);
        await send("C", 1_000n);
        // A push at 00:41:58 would move the stop to 00:46:58, past 00:16:00 + 30 min
        clock = at("00:41:50");
        await updateDeposit(db.pool, ORDER_A, {
            expiryDueAt: at("00:16:00"),
            hardStopAt: at("00:42:00"),
        });
        for (let i = 0; i < 6; i++) {
            busyView();
            await tick();
            later(2_000);
        }
        expect((await ledgerOf()).transfers).toHaveLength(1);
        expect((await depositOf()).hardStopAt).toEqual(at("00:42:00"));
    });
});

describe("expiry", () => {
    it("an x402 failure after the deadline reverts to unpaid when a deposit is live", async () => {
        await deposit();
        await ticks(1);
        await db.pool.query("update orders set state = 'settling', payer = $2 where id = $1", [
            ORDER_A,
            owners.B.address,
        ]);
        await seedPayment(db.pool, ORDER_A, {
            txSignature: getBase58Decoder().decode(randomBytes(64)),
            createdAt: at("00:14:50"),
            lastValidBlockHeight: 1_000n,
        });
        const a1 = await send("A", 50_000n);
        await ticks(2, 3_000, () => view(ORDER_A, "203.0.113.7", { needsCreate: false }));
        expect((await transferOf(a1)).outcome).toBe("open");

        const expired = createFakeRpc({
            getEpochInfo: () => epochAt(1_001n),
            getSignatureStatuses: () => ({ value: [null] }),
        });
        const reconciled = await reconcileSettling({
            pool: db.pool,
            rpc: expired,
            rpcTimeoutMs: TIMEOUT,
            log,
            now: () => at("00:16:30"),
            paid: null,
            x402,
            deposits: cfg,
        });
        expect(reconciled.reverted).toBe(1);
        expect((await orderOf()).state).toBe("unpaid");
        expect((await depositOf()).hardStopAt).toEqual(at("00:21:30"));

        clock = at("00:16:32");
        await tick();
        expect((await orderOf()).state).toBe("settling");
        expect((await findPaymentByOrder(db.pool, ORDER_A))!.createdAt).toEqual(PAID_AT);
        await ticks(2);
        expect((await orderOf()).paidAt).toEqual(PAID_AT);
    });

    it("the expiry pin uses the highest slot and its block time", async () => {
        await deposit();
        await ticks(1);
        // A slot whose block time is just before the deadline, then later slots
        chain.setBlockTime(at("00:14:58").getTime() / 1000);
        await chain.noOp({ touching: recipientAta, signer: owners.H });
        const early = chain.slot();
        chain.advance(5);
        chain.setBlockTime(at("00:16:00").getTime() / 1000);
        clock = at("00:16:01");
        // Each read moves the chain one slot, so getSlot answers early after it
        chain.lagNode(Number(chain.slot() + 1n - early), { methods: ["getSlot"] });
        await tick();
        const pinned = (await depositOf()).expiryMinSlot;
        expect(pinned).not.toBeNull();
        expect(pinned!).toBeGreaterThan(early);

        // With only the lagging answer known, nothing is stored and the next tick tries again
        await db.pool.query("truncate orders cascade");
        watch = createDepositWatch(cfg.viewer_ttl, cfg.busy_every);
        await deposit(ORDER_A, { over: { createdAt: CREATED } });
        chain.lagNode(0);
        clock = at("00:05:00");
        await ticks(1);
        chain.setBlockTime(at("00:14:58").getTime() / 1000);
        await chain.noOp({ touching: recipientAta, signer: owners.H });
        const lagging = chain.slot();
        chain.advance(5);
        chain.setBlockTime(at("00:16:00").getTime() / 1000);
        // The reads lag as well, so no later slot is known
        chain.lagNode(Number(chain.slot() + 1n - lagging), {
            methods: ["getSlot", "getMultipleAccounts"],
        });
        clock = at("00:16:01");
        await tick();
        expect((await depositOf()).expiryMinSlot).toBeNull();
        chain.lagNode(0);
        later(2_000);
        await tick();
        expect((await depositOf()).expiryMinSlot).toBeGreaterThan(lagging);
    });

    it.each([
        ["a cold order", false],
        ["an allowance order", true],
    ])("the deposit job expires after the grace and returns the money: %s", async (_, hot) => {
        if (hot) await allowanceReady();
        else await deposit();
        const order = await orderOf();
        const a1 = await send("A", 30_000n);
        await ticks(2, 3_000, () => view(ORDER_A, "203.0.113.7", { needsCreate: false }));
        expect((await transferOf(a1)).outcome).toBe("open");

        chain.setBlockTime(at("00:16:00").getTime() / 1000);
        clock = at("00:16:01");
        await tick();
        expect((await depositOf()).expiryMinSlot).not.toBeNull();
        clock = at("00:16:03");
        await tick();
        expect((await orderOf()).state).toBe("expired");
        expect((await depositOf()).state).toBe("draining");
        if (hot) {
            expect((await readPool(db.pool)).unpaidMicros).toBe(1_003_000 - order.allowanceMicros);
        }
        expect(await transferOf(a1)).toMatchObject({ outcome: "return", reason: "unpaid" });
        await ticks(1);
        const [ret] = (await movesOf()).filter((m) => m.kind === "return");
        expect(ret).toMatchObject({ amountMicros: 30_000, destination: sources.A });
        expect(["sent", "confirmed"]).toContain(ret!.state);
        await ticks(1);
        expect((await movesOf()).find((m) => m.kind === "return")!.state).toBe("confirmed");
        expect(chain.accountExists((await depositOf()).tokenAccount)).toBe(false);
        // A deposit with nothing left to move is read at the idle pace
        await ticks(1, cfg.idle_every);
        expect((await depositOf()).state).toBe("closed");
    });

    it("enabled = false keeps existing deposits going", async () => {
        cfg = { ...cfg, enabled: false };
        await deposit();
        const a1 = await send("A", 30_000n);
        await ticks(2);
        chain.setBlockTime(at("00:16:00").getTime() / 1000);
        clock = at("00:16:01");
        await ticks(5, 2_000);
        expect((await orderOf()).state).toBe("expired");
        expect(await transferOf(a1)).toMatchObject({ outcome: "return", reason: "unpaid" });
        expect((await movesOf()).some((m) => m.kind === "return" && m.state === "confirmed")).toBe(
            true,
        );
    });
});

describe("flows on FakeChain", () => {
    const watching =
        (id = ORDER_A) =>
        () =>
            view(id, "203.0.113.7", { needsCreate: false });

    // Ticks until the condition holds, at most n ticks apart by stepMs
    async function until(
        cond: () => Promise<boolean>,
        n = 20,
        stepMs = 3_000,
        before?: () => void,
    ) {
        for (let i = 0; i < n; i++) {
            if (await cond()) return;
            await ticks(1, stepMs, before);
        }
        expect(await cond()).toBe(true);
    }

    it("full flow on FakeChain", async () => {
        const dep = await deposit(ORDER_A, { account: false });
        view(ORDER_A);
        await tick();
        await until(
            async () => (await creates(ORDER_A))[0]?.state === "confirmed",
            5,
            3_000,
            watching(),
        );
        expect((await depositOf()).rentPayer).toBe(feePayer.address);
        const recipientBefore = chain.balance(recipientAta);
        const payerBefore = chain.balance(sources.A);

        await send("A", 30_000n);
        await ticks(1, 3_000, watching());
        expect((await depositView(db.pool, await orderOf(), clock, cfg))!.status).toBe("partial");

        await send("A", 30_000n);
        await ticks(1, 3_000, watching());
        expect((await orderOf()).state).toBe("settling");
        expect((await depositView(db.pool, await orderOf(), clock, cfg))!.status).toBe(
            "confirming",
        );
        await until(async () => (await orderOf()).state === "paid", 5, 3_000, watching());
        await until(async () => (await depositOf()).state === "closed", 10, cfg.idle_every);
        const returns = (await movesOf()).filter((m) => m.kind === "return");
        expect(returns).toEqual([
            expect.objectContaining({ amountMicros: 10_000, state: "confirmed", closes: true }),
        ]);
        expect(chain.accountExists(dep.tokenAccount)).toBe(false);
        expect(chain.balance(recipientAta) - recipientBefore).toBe(50_000n);
        expect(payerBefore - chain.balance(sources.A)).toBe(50_000n);
    });

    it("a viewed, never-paid deposit is closed after the deadline", async () => {
        const dep = await deposit(ORDER_A, { account: false });
        view(ORDER_A);
        await tick();
        await until(
            async () => (await creates(ORDER_A))[0]?.state === "confirmed",
            5,
            3_000,
            watching(),
        );
        chain.setBlockTime(at("00:16:00").getTime() / 1000);
        clock = at("00:16:01");
        await tick();
        await until(async () => (await orderOf()).state === "expired", 3, 2_000);
        expect((await depositOf()).state).toBe("draining");
        await until(
            async () => (await movesOf()).some((m) => m.kind === "close"),
            5,
            cfg.idle_every,
        );
        // The close waited for held reads that kept the balance still
        const stable = (await depositOf()).stableSince;
        expect(stable).not.toBeNull();
        expect(stable!.getTime()).toBeLessThanOrEqual(clock.getTime() - cfg.busy_every);
        const close = (await movesOf()).find((m) => m.kind === "close")!;
        expect(close).toMatchObject({ closeTo: feePayer.address, amountMicros: 0 });
        await until(async () => (await depositOf()).state === "closed", 5, cfg.idle_every);
        expect(chain.accountExists(dep.tokenAccount)).toBe(false);
        expect((await movesOf()).find((m) => m.kind === "close")!.state).toBe("confirmed");
    });

    it("one transaction pays two orders", async () => {
        const a = await deposit(ORDER_A);
        const b = await deposit(ORDER_B);
        await ticks(1);
        await chain.transferMany({
            from: owners.A,
            to: [
                { tokenAccount: a.tokenAccount, micros: 50_000n },
                { tokenAccount: b.tokenAccount, micros: 50_000n },
            ],
        });
        chain.advance(1);
        const both = () => {
            watching(ORDER_A)();
            watching(ORDER_B)();
        };
        await until(
            async () =>
                (await orderOf(ORDER_A)).state === "paid" &&
                (await orderOf(ORDER_B)).state === "paid",
            8,
            3_000,
            both,
        );
    });

    it("a paid deposit holding an unattributed micro still closes", async () => {
        const dep = await deposit();
        // As after a closing sweep failed: the sweep does not close, so the account stays open
        await updateDeposit(db.pool, ORDER_A, { closeSeparately: true });
        await ticks(1, 3_000, watching());
        expect(await rentHolding(db.pool, feePayer.address)).toBe(1);
        await send("A", 50_000n);
        await until(async () => (await orderOf()).state === "paid", 6, 3_000, watching());
        expect((await depositOf()).state).toBe("draining");
        expect(await rentHolding(db.pool, feePayer.address)).toBe(0);

        const vault = sources.H;
        await chain.vaultTransfer({ vault, to: dep.tokenAccount, micros: 1n, signer: owners.G });
        chain.advance(1);
        await until(async () => (await depositOf()).state === "closed", 10, cfg.idle_every);
        const close = (await movesOf()).find((m) => m.kind === "close")!;
        expect(close).toMatchObject({ keepMicros: 1, state: "confirmed" });
        const kept = (await ledgerOf()).transfers.find((t) => t.amountMicros === 1)!;
        expect(kept).toMatchObject({ outcome: "keep", reason: "below_minimum" });
        expect(alarms("deposit_review")).toContainEqual(
            expect.objectContaining({ signature: kept.signature, reason: "unattributed" }),
        );
        expect(chain.accountExists(dep.tokenAccount)).toBe(false);
        expect(await rentHolding(db.pool, feePayer.address)).toBe(0);
    });

    it("a return-to between the planner's read and its move is never carried to the float", async () => {
        const dep = await deposit();
        await updateDeposit(db.pool, ORDER_A, { closeSeparately: true });
        await ticks(1, 3_000, watching());
        await send("A", 50_000n);
        await until(async () => (await orderOf()).state === "paid", 6, 3_000, watching());
        const held = await chain.vaultTransfer({
            vault: sources.H,
            to: dep.tokenAccount,
            micros: 2_000n,
            signer: owners.G,
        });
        chain.advance(1);
        await until(
            async () => (await transferOf(held))?.outcome === "review",
            6,
            3_000,
            watching(),
        );
        expect((await movesOf()).filter((m) => m.kind === "close")).toEqual([]);
        const floatBefore = chain.balance(floatAta);
        const ownerBefore = chain.balance(sources.C);
        // The operator's return-to commits right after the planner read the ledger
        let fired = false;
        const pool = new Proxy(db.pool, {
            get(target, prop) {
                const value: unknown = Reflect.get(target, prop);
                if (prop !== "query") {
                    return typeof value === "function" ? value.bind(target) : value;
                }
                return async (...args: Parameters<typeof db.pool.query>) => {
                    const text = typeof args[0] === "string" ? args[0] : "";
                    const planning =
                        text.startsWith("select * from deposit_moves where order_id") &&
                        (new Error().stack ?? "").includes("planAndApply");
                    const result = await (target.query as (...a: unknown[]) => unknown)(...args);
                    if (planning && !fired) {
                        fired = true;
                        await db.pool.query(
                            `update deposit_transfers set outcome = 'return', reason = 'operator',
                                source_token_account = $2, source_owner = $3, move_id = null
                             where signature = $1`,
                            [held, sources.C, owners.C.address],
                        );
                    }
                    return result;
                };
            },
        });
        // A draining deposit with only review money is read at the idle pace
        later(cfg.idle_every);
        await tick({ pool });
        expect(fired).toBe(true);
        const carrierOf = async () => {
            const { moveId } = await transferOf(held);
            return (await movesOf()).find((m) => m.id === moveId);
        };
        await until(async () => (await carrierOf())?.state === "confirmed", 6, 3_000, watching());
        const carrier = (await carrierOf())!;
        expect(carrier).toMatchObject({
            kind: "return",
            destination: sources.C,
            amountMicros: 2_000,
        });
        expect((await movesOf()).filter((m) => m.heldMicros > 0)).toEqual([]);
        expect(chain.balance(sources.C) - ownerBefore).toBe(2_000n);
        expect(chain.balance(floatAta)).toBe(floatBefore);
    });

    // Paid and closed with Bugnet's rent, the order's watch window then open for late money
    async function paidAndClosed(): Promise<DepositRow> {
        const dep = await deposit();
        await send("A", 50_000n);
        await until(async () => (await depositOf()).state === "closed", 10, 3_000, watching());
        expect((await depositOf()).rentPayer).toBeNull();
        chain.setBlockTime(at("00:20:00").getTime() / 1000);
        return dep;
    }

    it("late money after close is returned", async () => {
        const dep = await paidAndClosed();
        await chain.transfer({
            authority: owners.B,
            feePayer: owners.B,
            source: sources.B,
            destination: dep.tokenAccount,
            micros: 2_000n,
            memo: `t${++memoSeq}`,
            createDestinationFor: dep.address,
        });
        chain.advance(1);
        await until(
            async () => (await movesOf()).some((m) => m.kind === "return"),
            4,
            cfg.closed_every,
        );
        const late = (await ledgerOf()).transfers.find((t) => t.amountMicros === 2_000)!;
        expect(late).toMatchObject({ outcome: "return", reason: "late" });
        expect(await depositOf()).toMatchObject({ state: "draining", lateReturns: 1 });
        const ret = (await movesOf()).find((m) => m.kind === "return")!;
        expect(ret).toMatchObject({ closes: true, closeTo: owners.B.address, amountMicros: 2_000 });
        await until(async () => (await depositOf()).state === "closed", 10, cfg.idle_every);
        expect(await depositOf()).toMatchObject({ lateReturns: 1, rentPayer: null });
    });

    it("a closed deposit forgets its rent payer", async () => {
        const dep = await paidAndClosed();
        const closedAt = clock;
        const stranger = owners.F;
        const strangerBefore = chain.lamports(stranger.address);
        const feePayerBefore = chain.lamports(feePayer.address);
        await chain.createAta({ owner: dep.address, payer: stranger });
        chain.advance(1);
        await send("B", 2_000n);
        await until(
            async () => (await movesOf()).some((m) => m.kind === "return"),
            4,
            cfg.closed_every,
        );
        const ret = (await movesOf()).find((m) => m.kind === "return")!;
        expect(ret).toMatchObject({ closes: true, closeTo: stranger.address, amountMicros: 2_000 });
        await until(async () => (await depositOf()).state === "closed", 10, cfg.idle_every);
        // The rent goes back to the stranger who paid it, none of it to Bugnet's fee payer
        expect(chain.lamports(stranger.address) - strangerBefore).toBe(2_039_280n);
        expect(chain.lamports(feePayer.address)).toBe(feePayerBefore);
        // The fee payer alarm counts the late return's fee and no rent back for it
        const spent = await depositLamports(
            db.pool,
            closedAt,
            new Date(clock.getTime() + 1),
            feePayer.address,
            cfg,
        );
        expect(spent).toBe(moveFeeLamports({ kind: "return", preflightRefusedAt: null }, cfg));
    });

    it("an account opened again before its close is read gives the rent to the new creator", async () => {
        const dep = await deposit(ORDER_A, { account: false });
        view(ORDER_A);
        await tick();
        await until(
            async () => (await creates(ORDER_A))[0]?.state === "confirmed",
            5,
            3_000,
            watching(),
        );
        chain.setBlockTime(at("00:16:00").getTime() / 1000);
        clock = at("00:16:01");
        await tick();
        await until(async () => (await orderOf()).state === "expired", 3, 2_000);
        await until(
            async () => (await movesOf()).some((m) => m.kind === "close"),
            5,
            cfg.idle_every,
        );
        // The close has landed on chain, and the job has not read its landing yet
        expect((await movesOf()).find((m) => m.kind === "close")!.state).toBe("sent");
        expect(chain.accountExists(dep.tokenAccount)).toBe(false);
        const stranger = owners.F;
        const strangerBefore = chain.lamports(stranger.address);
        const feePayerBefore = chain.lamports(feePayer.address);
        await chain.createAta({ owner: dep.address, payer: stranger });
        chain.advance(1);
        await send("B", 2_000n);
        await until(
            async () => (await movesOf()).some((m) => m.kind === "return"),
            6,
            cfg.closed_every,
        );
        const ret = (await movesOf()).find((m) => m.kind === "return")!;
        expect(ret).toMatchObject({ closes: true, closeTo: stranger.address, amountMicros: 2_000 });
        expect((await depositOf()).lateReturns).toBe(1);
        await until(async () => (await depositOf()).state === "closed", 10, cfg.idle_every);
        expect(chain.lamports(stranger.address) - strangerBefore).toBe(2_039_280n);
        // The fee payer got its own rent back from the first close, none of the stranger's
        expect(chain.lamports(feePayer.address) - feePayerBefore).toBe(0n);
    });

    it("a close of a re-opened closed account forgets that creator for the next one", async () => {
        const dep = await paidAndClosed();
        const first = owners.F;
        await chain.createAta({ owner: dep.address, payer: first });
        chain.advance(1);
        // Money the scan cannot attribute rides to the float in a close to its creator
        await chain.vaultTransfer({
            vault: sources.H,
            to: dep.tokenAccount,
            micros: 2_000n,
            signer: owners.G,
        });
        chain.advance(1);
        await until(
            async () =>
                (await movesOf()).some((m) => m.kind === "close" && m.state === "confirmed"),
            12,
            cfg.closed_every,
        );
        expect((await movesOf()).find((m) => m.kind === "close")).toMatchObject({
            closeTo: first.address,
            heldMicros: 2_000,
        });
        expect(chain.accountExists(dep.tokenAccount)).toBe(false);
        const firstBefore = chain.lamports(first.address);
        const payerBefore = chain.lamports(owners.B.address);
        // The next sender's wallet creates the account and pays its rent
        await chain.transfer({
            authority: owners.B,
            feePayer: owners.B,
            source: sources.B,
            destination: dep.tokenAccount,
            micros: 2_000n,
            memo: `t${++memoSeq}`,
            createDestinationFor: dep.address,
        });
        chain.advance(1);
        await until(
            async () => (await movesOf()).some((m) => m.kind === "return"),
            6,
            cfg.closed_every,
        );
        const ret = (await movesOf()).find((m) => m.kind === "return")!;
        expect(ret).toMatchObject({ closes: true, closeTo: owners.B.address, amountMicros: 2_000 });
        await until(async () => (await depositOf()).state === "closed", 10, cfg.idle_every);
        expect(chain.lamports(owners.B.address) - payerBefore).toBe(2_039_280n);
        expect(chain.lamports(first.address)).toBe(firstBefore);
    });

    it("a closed deposit put in review is read at the closed pace and never keeps the job busy", async () => {
        const dep = await paidAndClosed();
        // Late money opens the account again, and a leaked key takes part of it before the job
        // reads, so every later read stays below the ledger
        await chain.transfer({
            authority: owners.B,
            feePayer: owners.B,
            source: sources.B,
            destination: dep.tokenAccount,
            micros: 2_000n,
            memo: `t${++memoSeq}`,
            createDestinationFor: dep.address,
        });
        chain.advance(1);
        chain.debit(dep.tokenAccount, 1_500n);
        chain.advance(1);
        await until(
            async () => (await depositOf()).reviewReason === "unknown_debit",
            4,
            cfg.closed_every,
        );
        // The next tick that watches the deposit sees the review
        await ticks(1, cfg.closed_every);
        expect(await depositOf()).toMatchObject({ state: "closed", reviewReason: "unknown_debit" });
        expect(await depositsBusy(db.pool, watch, clock, cfg)).toBe(false);

        // No read is held, so checked_at stays put and watchedDeposits returns it every tick
        const mark = chain.calls().length;
        const calls = (method: string) =>
            chain
                .calls()
                .slice(mark)
                .filter((x) => x.method === method && x.params[0] !== undefined)
                .filter((x) => JSON.stringify(x.params[0]).includes(dep.tokenAccount)).length;
        await ticks(30, cfg.busy_every);
        expect(calls("getMultipleAccounts")).toBeLessThanOrEqual(1);
        expect(calls("getSignaturesForAddress")).toBeLessThanOrEqual(2);
        await ticks(1, cfg.closed_every);
        expect(calls("getMultipleAccounts")).toBeGreaterThanOrEqual(1);
    });

    describe("a write-off (spec 23.1)", () => {
        let dir: string;
        let config: string;

        beforeAll(() => {
            dir = mkdtempSync(join(tmpdir(), "bn-pay-write-off-"));
            config = join(dir, "test.toml");
            writeFileSync(
                config,
                stringify({ database: { url: db.url }, solana: { recipient: recipient.address } }),
            );
        });
        afterAll(() => {
            rmSync(dir, { recursive: true, force: true });
        });

        async function writeOff(signature: string, id = ORDER_A) {
            const out: string[] = [];
            const err: string[] = [];
            // Bugnet's fee payer and refund wallet, whose money the write-off keeps
            const env = {
                BUGNET_FEE_PAYER_KEY: testSecret(22, feePayer),
                BUGNET_REFUND_KEY: testSecret(12, refund),
            };
            const code = await cliMain(
                ["-config", config, "deposits", "write-off", id, signature],
                env,
                { out: (x) => out.push(x), err: (x) => err.push(x) },
                { rpc: chain.rpc, now: () => clock },
            );
            return { code, out, err: err.join("\n") };
        }

        // The refund float pays the written-off parts under its own rules
        async function payRefunds(): Promise<void> {
            const refundDeps = (at: Date): RefundDeps => ({
                pool: db.pool,
                rpc: chain.rpc,
                feePayer,
                refundSigner: refund,
                allowanceSigner: allowanceWallet,
                x402,
                hotTokenAccount: hotAta,
                cfg: settings.refunds,
                rpcTimeoutMs: TIMEOUT,
                log,
                now: () => at,
            });
            await runRefunds(refundDeps(clock), "refund");
            chain.advance(1);
            later(30_000);
            await runRefunds(refundDeps(clock), "refund");
        }

        const writeOffRows = async () =>
            (
                await db.pool.query<{ state: string; amount_micros: string; destination: string }>(
                    `select state, amount_micros, destination from refunds
                     where order_id = $1 and reason = 'deposit_write_off' order by part`,
                    [ORDER_A],
                )
            ).rows.map((r) => [r.destination, Number(r.amount_micros), r.state]);

        async function expireAndClose(): Promise<void> {
            chain.setBlockTime(at("00:16:00").getTime() / 1000);
            clock = at("00:16:01");
            await tick();
            await until(async () => (await orderOf()).state === "expired", 5, 2_000);
            await until(async () => (await depositOf()).state === "closed", 10, cfg.idle_every);
        }

        async function toDone(): Promise<void> {
            const closed = await depositOf();
            clock = new Date(closed.watchUntil!.getTime() + 1_000);
            await until(async () => (await depositOf()).state === "done", 3, cfg.closed_every);
        }

        it("a theft from an open deposit of two senders is written off and every sender made whole", async () => {
            const dep = await deposit();
            chain.credit(floatAta, 100_000n);
            const startA = chain.balance(sources.A);
            const startB = chain.balance(sources.B);
            await send("A", 20_000n);
            await send("B", 15_000n);
            await ticks(2, 3_000, watching());
            expect((await ledgerOf()).transfers).toHaveLength(2);

            const stolen = chain.debit(dep.tokenAccount, 25_000n);
            chain.advance(1);
            later(cfg.idle_every);
            await tick();
            expect((await depositOf()).reviewReason).toBe("unknown_debit");
            expect(alarms("deposit_unknown_debit")).toHaveLength(1);

            const done = await writeOff(stolen);
            expect(done.err).not.toContain("error:");
            expect(done.code).toBe(0);
            expect(done.out.at(-1)).toBe("review cleared");
            expect(await writeOffRows()).toEqual([
                [sources.A, 10_000, "pending"],
                [sources.B, 15_000, "pending"],
            ]);

            // A new process reads the deposit from the anchor before the debit, and the debit
            // is explained: no alarm and no review again
            watch = createDepositWatch(cfg.viewer_ttl, cfg.busy_every);
            cache = new TxCache(10_000);
            later(cfg.idle_every);
            await tick();
            await ticks(2, cfg.idle_every);
            expect(alarms("deposit_unknown_debit")).toHaveLength(1);
            expect(await depositOf()).toMatchObject({ reviewReason: null, balanceMicros: 10_000n });

            await expireAndClose();
            const returns = (await movesOf()).filter((m) => m.kind === "return");
            expect(returns).toEqual([
                expect.objectContaining({
                    destination: sources.A,
                    amountMicros: 10_000,
                    state: "confirmed",
                    closes: true,
                }),
            ]);
            expect(chain.accountExists(dep.tokenAccount)).toBe(false);

            await payRefunds();
            expect(await writeOffRows()).toEqual([
                [sources.A, 10_000, "confirmed"],
                [sources.B, 15_000, "confirmed"],
            ]);
            expect(chain.balance(sources.A)).toBe(startA);
            expect(chain.balance(sources.B)).toBe(startB);
            expect(chain.balance(floatAta)).toBe(75_000n);

            await toDone();
            const view = await depositView(db.pool, await orderOf(), clock, cfg);
            expect(view).toMatchObject({ status: "refunded", returnedMicros: 35_000 });
        });

        it("a theft of a settling payment's money expires the order and returns every sender's money", async () => {
            const dep = await deposit();
            chain.credit(floatAta, 100_000n);
            const startA = chain.balance(sources.A);
            const startB = chain.balance(sources.B);
            await send("A", 30_000n);
            await ticks(1, 3_000, watching());
            await send("B", 25_000n);
            // The sweep fails on chain, and before it is signed again a leaked key takes money
            chain.failNext();
            await ticks(1, 3_000, watching());
            expect((await orderOf()).state).toBe("settling");
            expect((await sharesOf(db.pool, ORDER_A)).map((x) => x.owner)).toEqual([
                owners.A.address,
                owners.B.address,
            ]);
            const stolen = chain.debit(dep.tokenAccount, 20_000n);
            chain.advance(1);
            later(cfg.idle_every);
            await tick();
            expect((await depositOf()).reviewReason).toBe("unknown_debit");
            const sweep = (await movesOf()).find((m) => m.kind === "sweep")!;
            expect(sweep.state).toBe("failed");

            const done = await writeOff(stolen);
            expect(done.err).not.toContain("error:");
            expect(done.code).toBe(0);
            expect(done.out).toContain(`order ${ORDER_A} expired: its payment was written off`);
            expect(await orderOf()).toMatchObject({ state: "expired" });
            expect(await findPaymentByOrder(db.pool, ORDER_A)).toBeNull();
            const failed = await db.pool.query<{ reason: string; tx_signature: string }>(
                "select reason, tx_signature from failed_payments where order_id = $1",
                [ORDER_A],
            );
            expect(failed.rows).toEqual([
                { reason: "written_off", tx_signature: sweep.txSignature },
            ]);
            expect(await sharesOf(db.pool, ORDER_A)).toEqual([]);
            expect(await depositOf()).toMatchObject({
                state: "draining",
                settledAt: null,
                reviewReason: null,
            });
            expect((await movesOf()).find((m) => m.id === sweep.id)).toMatchObject({
                state: "failed",
                manualReason: "written_off",
            });
            expect(
                (await ledgerOf()).transfers.map((t) => [t.outcome, t.reason, t.appliedMicros]),
            ).toEqual([
                ["return", "written_off", 0],
                ["return", "written_off", 0],
            ]);
            expect(await writeOffRows()).toEqual([[sources.B, 20_000, "pending"]]);

            await until(async () => (await depositOf()).state === "closed", 10, cfg.idle_every);
            expect((await movesOf()).filter((m) => m.kind === "sweep")).toHaveLength(1);
            expect(
                (await movesOf())
                    .filter((m) => m.kind === "return")
                    .map((m) => [m.destination, m.amountMicros, m.state]),
            ).toEqual([
                [sources.A, 30_000, "confirmed"],
                [sources.B, 5_000, "confirmed"],
            ]);
            expect((await depositOf()).reviewReason).toBeNull();

            await payRefunds();
            expect(chain.balance(sources.A)).toBe(startA);
            expect(chain.balance(sources.B)).toBe(startB);
            await toDone();
        });

        it("a write-off made before the scan recorded a later credit clears the review when run again", async () => {
            const dep = await deposit();
            chain.credit(floatAta, 100_000n);
            const startA = chain.balance(sources.A);
            const startB = chain.balance(sources.B);
            await send("A", 20_000n);
            await ticks(2, 3_000, watching());
            expect((await ledgerOf()).transfers).toHaveLength(1);

            const stolen = chain.debit(dep.tokenAccount, 5_000n);
            chain.advance(1);
            later(cfg.idle_every);
            await tick();
            expect((await depositOf()).reviewReason).toBe("unknown_debit");

            // B's money lands after the theft, before the scan reads it
            const b1 = await send("B", 3_000n);
            const first = await writeOff(stolen);
            expect(first.err).not.toContain("error:");
            expect(first.code).toBe(0);
            expect(first.out.at(-1)).toBe(
                "review stays unknown_debit: the chain holds 18000, the ledger 15000",
            );
            expect(await writeOffRows()).toEqual([[sources.A, 5_000, "pending"]]);

            later(cfg.closed_every);
            await tick();
            await until(
                async () => (await ledgerOf()).transfers.some((t) => t.signature === b1),
                5,
                cfg.closed_every,
            );
            expect((await depositOf()).reviewReason).toBe("unknown_debit");
            expect(alarms("deposit_unknown_debit")).toHaveLength(1);
            const second = await writeOff(stolen);
            expect(second.err).not.toContain("error:");
            expect(second.code).toBe(0);
            expect(second.out).toEqual([
                `deposit ${ORDER_A} already wrote off ${stolen}; nothing new recorded`,
                "review cleared",
            ]);
            const third = await writeOff(stolen);
            expect(third.out).toEqual([
                `deposit ${ORDER_A} already wrote off ${stolen}; nothing new recorded`,
                "no review to clear",
            ]);
            expect(await depositOf()).toMatchObject({ reviewReason: null });
            expect((await ledgerOf()).writeOffs).toHaveLength(1);
            expect(await writeOffRows()).toEqual([[sources.A, 5_000, "pending"]]);

            await expireAndClose();
            expect(
                (await movesOf())
                    .filter((m) => m.kind === "return")
                    .map((m) => [m.destination, m.amountMicros, m.state])
                    .sort(),
            ).toEqual(
                [
                    [sources.A, 15_000, "confirmed"],
                    [sources.B, 3_000, "confirmed"],
                ].sort(),
            );
            expect(chain.accountExists(dep.tokenAccount)).toBe(false);
            await payRefunds();
            expect(await writeOffRows()).toEqual([[sources.A, 5_000, "confirmed"]]);
            expect(chain.balance(sources.A)).toBe(startA);
            expect(chain.balance(sources.B)).toBe(startB);
            expect(chain.balance(floatAta)).toBe(95_000n);

            await toDone();
            const view = await depositView(db.pool, await orderOf(), clock, cfg);
            expect(view).toMatchObject({ status: "refunded", returnedMicros: 23_000 });
        });

        it("parts Bugnet keeps get no payout and keep no deposit from done", async () => {
            const dep = await deposit();
            chain.credit(floatAta, 100_000n);
            const startA = chain.balance(sources.A);
            const startB = chain.balance(sources.B);
            await send("A", 20_000n);
            const own = await chain.transfer({
                authority: refund,
                feePayer: refund,
                source: floatAta,
                destination: dep.tokenAccount,
                micros: 5_000n,
                memo: `t${++memoSeq}`,
            });
            chain.advance(1);
            const dust = await send("B", 600n);
            await ticks(2, 3_000, watching());
            expect((await transferOf(own)).reason).toBe("from_bugnet");

            const stolen = chain.debit(dep.tokenAccount, 10_600n);
            chain.advance(1);
            later(cfg.idle_every);
            await tick();
            expect((await depositOf()).reviewReason).toBe("unknown_debit");

            const done = await writeOff(stolen);
            expect(done.err).not.toContain("error:");
            expect(done.code).toBe(0);
            expect(done.out).toContain(`part ${own} 5000 refund=- kept: Bugnet's own money`);
            expect(done.out).toContain(`part ${dust} 600 refund=- kept: below refund_min_micros`);
            expect(done.out.at(-1)).toBe("review cleared");
            expect(await writeOffRows()).toEqual([[sources.A, 5_000, "pending"]]);

            await expireAndClose();
            expect(chain.accountExists(dep.tokenAccount)).toBe(false);
            await payRefunds();
            expect(await writeOffRows()).toEqual([[sources.A, 5_000, "confirmed"]]);
            expect(chain.balance(sources.A)).toBe(startA);
            expect(chain.balance(sources.B)).toBe(startB - 600n);
            expect(chain.balance(floatAta)).toBe(90_000n);

            await toDone();
            const view = await depositView(db.pool, await orderOf(), clock, cfg);
            expect(view).toMatchObject({
                status: "refunded",
                returnedMicros: 20_000,
                keptMicros: 0,
                reviewMicros: 0,
            });
        });
    });
});
