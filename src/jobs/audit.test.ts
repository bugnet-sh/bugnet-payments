import { randomBytes } from "node:crypto";
import { address, getBase58Decoder } from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { memoryLog } from "../log.ts";
import { MEMO_PROGRAM } from "../solana/constants.ts";
import { usdcAta } from "../solana/accounts.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { createFakeRpc, type FakeRpc, neverAnswers } from "../testing/fake-rpc.ts";
import { seedOrder, seedPayment } from "../testing/orders.ts";
import type { OrderRow } from "../orders/types.ts";
import { auditInflows } from "./audit.ts";

const MIN = 60_000;
const t0 = new Date("2030-01-01T12:00:00Z");
const RECIPIENT = address("Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw");
const sigOf = () => getBase58Decoder().decode(randomBytes(64));
const RPC_TIMEOUT_MS = 10_000;
const STALL_MS = 100;

let db: TestDb;
let log: ReturnType<typeof memoryLog>;
let ata: string;
let order: OrderRow;
const sigs: Record<string, string> = {};
const sig = (name: string) => (sigs[name] ??= sigOf());

interface Inflow {
    name: string;
    memo: string | null;
    amount: string;
    pre?: string | null;
    err?: unknown;
}
const inflow = (i: Inflow): Inflow => i;

function parsedTx(i: Inflow) {
    const balance = (accountIndex: number, amount: string) => ({
        accountIndex,
        uiTokenAmount: { amount, decimals: 6, uiAmountString: amount },
    });
    return {
        meta: {
            err: i.err ?? null,
            preTokenBalances: i.pre === null ? [] : [balance(1, i.pre ?? "0")],
            postTokenBalances: [
                balance(0, "777"),
                balance(1, (BigInt(i.pre ?? "0") + BigInt(i.amount)).toString()),
            ],
        },
        transaction: {
            message: {
                accountKeys: [{ pubkey: "OtherAccount" }, { pubkey: ata }],
                instructions: [
                    { programId: "11111111111111111111111111111111", parsed: { type: "x" } },
                    ...(i.memo === null ? [] : [{ programId: MEMO_PROGRAM, parsed: i.memo }]),
                ],
            },
        },
    };
}

interface Seen {
    sigConfigs: unknown[];
    txConfigs: unknown[];
}

function rpcWith(
    list: Inflow[],
    seen: Seen = { sigConfigs: [], txConfigs: [] },
    pages?: Inflow[][],
): FakeRpc {
    const all = [...list, ...(pages ?? []).flat()];
    let page = 0;
    return createFakeRpc({
        getSignaturesForAddress: (_a: string, config: unknown) => {
            seen.sigConfigs.push(config);
            const rows = pages ? (pages[page++] ?? []) : list;
            return rows.map((i) => ({
                signature: sig(i.name),
                err: i.err ?? null,
                memo: i.memo,
                slot: 1n,
            }));
        },
        getTransaction: (s: string, config: unknown) => {
            seen.txConfigs.push(config);
            const i = all.find((x) => sig(x.name) === s);
            return i ? parsedTx(i) : null;
        },
    });
}

const deps = (rpc: FakeRpc, now = t0) => ({
    pool: db.pool,
    rpc,
    recipient: RECIPIENT,
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    log,
    now: () => now,
});

beforeAll(async () => {
    db = await testDb();
    ata = await usdcAta(RECIPIENT);
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await db.pool.query("truncate orders cascade");
    await db.pool.query("truncate audit_checkpoints");
    for (const k of Object.keys(sigs)) delete sigs[k];
    log = memoryLog();
    order = (await seedOrder(db.pool, { state: "paid", amountMicros: 10_000 })).order;
    await seedPayment(db.pool, order.id, {
        txSignature: sig("S1"),
        status: "confirmed",
        confirmedAt: new Date(t0.getTime() - 10 * MIN),
        createdAt: new Date(t0.getTime() - 10 * MIN),
    });
});

const alarms = (name: string) => log.lines.filter((l) => l.alarm === name);

describe("auditInflows", () => {
    it("matches an inflow to its paid order by memo and amount", async () => {
        const r = await auditInflows(
            deps(rpcWith([inflow({ name: "S1", memo: order.id, amount: "10000" })])),
        );
        expect(r).toMatchObject({
            scanned: 1,
            matched: 1,
            mismatches: [],
            missing: [],
            checkpoint: sig("S1"),
        });
        expect(alarms("inflow_mismatch")).toHaveLength(0);
    });

    it.each([
        ["unknown memo", { name: "S2", memo: "ord_zzzzzzzzzzzzzzzzzzzzzzzzzz", amount: "10000" }],
        ["wrong amount", { name: "S1", memo: "ORDER", amount: "9999" }],
        ["no memo", { name: "S3", memo: null, amount: "5" }],
    ])("alarms on %s", async (_n, tx) => {
        const t = inflow({ ...tx, memo: tx.memo === "ORDER" ? order.id : tx.memo });
        const r = await auditInflows(deps(rpcWith([t])));
        expect(r.mismatches).toEqual([sig(t.name)]);
        expect(r.matched).toBe(0);
        const [a] = alarms("inflow_mismatch");
        expect(a).toMatchObject({
            signature: sig(t.name),
            amountMicros: t.amount,
            memos: t.memo === null ? [] : [t.memo],
        });
    });

    it("alarms when the memo names the order but the signature belongs to no payment", async () => {
        const r = await auditInflows(
            deps(rpcWith([inflow({ name: "S9", memo: order.id, amount: "10000" })])),
        );
        expect(r.mismatches).toEqual([sig("S9")]);
    });

    it("reads a missing pre balance as zero and a pre balance as a difference", async () => {
        const first = await auditInflows(
            deps(rpcWith([inflow({ name: "S1", memo: order.id, amount: "10000", pre: null })])),
        );
        expect(first.matched).toBe(1);
        await db.pool.query("truncate audit_checkpoints");
        const second = await auditInflows(
            deps(rpcWith([inflow({ name: "S1", memo: order.id, amount: "10000", pre: "500" })])),
        );
        expect(second.matched).toBe(1);
    });

    it("skips failed transactions and reads memos from parsed strings", async () => {
        const seen: Seen = { sigConfigs: [], txConfigs: [] };
        const rpc = rpcWith(
            [
                inflow({
                    name: "BAD",
                    memo: "ord_zzzzzzzzzzzzzzzzzzzzzzzzzz",
                    amount: "1",
                    err: {},
                }),
                inflow({ name: "S1", memo: order.id, amount: "10000" }),
            ],
            seen,
        );
        const r = await auditInflows(deps(rpc));
        expect(rpc.calls.getTransaction).toBe(1);
        expect(r).toMatchObject({ scanned: 1, matched: 1, mismatches: [] });
    });

    it("ignores a memo that is only in the signature row prefilter", async () => {
        const rpc = createFakeRpc({
            getSignaturesForAddress: () => [
                { signature: sig("S1"), err: null, memo: `[40] ${order.id}`, slot: 1n },
            ],
            getTransaction: () => parsedTx(inflow({ name: "S1", memo: null, amount: "10000" })),
        });
        const r = await auditInflows(deps(rpc));
        expect(r.mismatches).toEqual([sig("S1")]);
    });

    it("alarms on a confirmed payment with no inflow", async () => {
        const r = await auditInflows(deps(rpcWith([])));
        expect(r.missing).toEqual([order.id]);
        expect(alarms("payment_missing_inflow")).toEqual([
            expect.objectContaining({ orderId: order.id, signature: sig("S1") }),
        ]);
    });

    it("does not call a payment missing when it is newer than five minutes or already audited", async () => {
        await db.pool.query("update payments set confirmed_at = $1", [
            new Date(t0.getTime() - 30 * MIN),
        ]);
        const fresh = (await seedOrder(db.pool, { state: "paid" })).order;
        await seedPayment(db.pool, fresh.id, {
            txSignature: sigOf(),
            status: "confirmed",
            confirmedAt: new Date(t0.getTime() - 4 * MIN),
        });
        await db.pool.query(
            `insert into audit_checkpoints (name, signature, updated_at)
             values ('recipient_inflows', $1, $2)`,
            [sigOf(), new Date(t0.getTime() - 60 * MIN)],
        );
        const r = await auditInflows(deps(rpcWith([])));
        expect(r.missing).toEqual([order.id]);
        await db.pool.query(
            "update audit_checkpoints set updated_at = $1 where name = 'recipient_inflows'",
            [new Date(t0.getTime() - MIN)],
        );
        expect((await auditInflows(deps(rpcWith([])))).missing).toEqual([]);
    });

    it("pages with before and resumes from the checkpoint", async () => {
        const page1 = Array.from({ length: 1000 }, (_, k) =>
            inflow({ name: `P${k}`, memo: null, amount: "0" }),
        );
        const page2 = [inflow({ name: "S1", memo: order.id, amount: "10000" })];
        const seen: Seen = { sigConfigs: [], txConfigs: [] };
        await db.pool.query(
            `insert into audit_checkpoints (name, signature) values ('recipient_inflows', $1)`,
            [sigOf()],
        );
        const stored = (await db.pool.query("select signature from audit_checkpoints")).rows[0]
            .signature;
        const r = await auditInflows(deps(rpcWith([], seen, [page1, page2])));
        expect(seen.sigConfigs).toHaveLength(2);
        expect(seen.sigConfigs[0]).toMatchObject({
            limit: 1000,
            until: stored,
            commitment: "finalized",
        });
        expect(seen.sigConfigs[1]).toMatchObject({ before: sig("P999"), until: stored });
        expect(r).toMatchObject({ scanned: 1001, matched: 1, checkpoint: sig("P0") });

        const seen2: Seen = { sigConfigs: [], txConfigs: [] };
        await auditInflows(deps(rpcWith([], seen2)));
        expect(seen2.sigConfigs).toHaveLength(1);
        expect(seen2.sigConfigs[0]).toMatchObject({ until: sig("P0") });
    });

    it("scans one page on the first run even when it is full", async () => {
        const page1 = Array.from({ length: 1000 }, (_, k) =>
            inflow({ name: `P${k}`, memo: null, amount: "0" }),
        );
        const seen: Seen = { sigConfigs: [], txConfigs: [] };
        await auditInflows(
            deps(rpcWith([], seen, [page1, [inflow({ name: "X", memo: null, amount: "0" })]])),
        );
        expect(seen.sigConfigs).toHaveLength(1);
        expect(seen.sigConfigs[0]).not.toHaveProperty("until");
    });

    it("keeps the checkpoint when the scan finds nothing new", async () => {
        await auditInflows(
            deps(rpcWith([inflow({ name: "S1", memo: order.id, amount: "10000" })])),
        );
        const r = await auditInflows(deps(rpcWith([]), new Date(t0.getTime() + 60 * MIN)));
        expect(r.checkpoint).toBe(sig("S1"));
    });

    it.each([
        ["getSignaturesForAddress", { getSignaturesForAddress: neverAnswers }],
        [
            "getTransaction",
            {
                getSignaturesForAddress: () => [
                    { signature: sig("S1"), err: null, memo: null, slot: 1n },
                ],
                getTransaction: neverAnswers,
            },
        ],
    ] as const)(
        "gives up on a stalled %s within solana.rpc_timeout and saves nothing",
        async (_, script) => {
            const payments = await db.pool.query("select * from payments order by order_id");
            const started = performance.now();
            await expect(
                auditInflows({ ...deps(createFakeRpc(script)), rpcTimeoutMs: STALL_MS }),
            ).rejects.toMatchObject({ name: "TimeoutError" });
            expect(performance.now() - started).toBeLessThan(STALL_MS + 900);
            expect((await db.pool.query("select * from audit_checkpoints")).rows).toEqual([]);
            expect((await db.pool.query("select * from payments order by order_id")).rows).toEqual(
                payments.rows,
            );
            expect(log.lines.filter((l) => l.alarm)).toEqual([]);
        },
    );

    it("asks for version-1 transactions in jsonParsed", async () => {
        const seen: Seen = { sigConfigs: [], txConfigs: [] };
        await auditInflows(
            deps(rpcWith([inflow({ name: "S1", memo: order.id, amount: "10000" })], seen)),
        );
        expect(seen.txConfigs[0]).toMatchObject({
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 1,
            commitment: "finalized",
        });
    });
});
