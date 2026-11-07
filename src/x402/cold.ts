/**
 * Transfers of Bugnet's share from the hot wallet to cold (spec 7.11).
 *
 * A transfer is stored `signed` before it is broadcast, and the shares it carries are marked with
 * its id under their order locks, so a refund and a transfer never both use one share. It is sent
 * only against a verified balance (7.3), never while x402 is paused, and signed again only after
 * the 7.10 proof.
 */
import { type Address, type Base64EncodedWireTransaction, type KeyPairSigner } from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import { type Queryable, withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import { lockOrders } from "../orders/store.ts";
import {
    buildRefundTransaction,
    clearResignWait,
    FRESH_SEND,
    noteResignWait,
    RESEND,
    RpcUnavailable,
    type SignedRefund,
    viaRpc,
} from "../refunds/executor.ts";
import { readLanding } from "../solana/landing.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";
import { readControls } from "./controls.ts";
import { recordIncident } from "./incidents.ts";
import { lockAccount } from "./ledger.ts";
import {
    liabilitiesAt,
    transferableParts,
    type TransferPart,
    unsettledColdTransfersAt,
} from "./liabilities.ts";
import { confirmColdTransfer } from "./match.ts";
import type { MirrorRun } from "./mirror.ts";
import { resignProof } from "./resign.ts";
import { readTail, type Tail } from "./tail.ts";

export interface ColdDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    feePayer: KeyPairSigner;
    allowance: KeyPairSigner;
    hotTokenAccount: Address;
    coldTokenAccount: Address;
    refunds: Settings["refunds"];
    x402: Settings["x402"];
    rpcTimeoutMs: number;
    log: Log;
    now: () => Date;
    requestMirror: () => Promise<MirrorRun | null>;
}

export type ColdSkip =
    "paused" | "below_threshold" | "unverified" | "balance_short" | "in_flight" | "empty";

const sum = (parts: readonly TransferPart[]) => parts.reduce((total, p) => total + p.micros, 0);

// The hot account's USDC at slot C: its opening balance and every stored change after it
export async function balanceAt(db: Queryable, slotC: bigint, tail: Tail): Promise<bigint> {
    const res = await db.query<{ delta: string }>(
        `select coalesce(sum(delta_micros), 0) as delta from x402_chain_txs
         where slot > $1 and slot <= $2`,
        [tail.openingSlot.toString(), slotC.toString()],
    );
    return tail.openingBalanceMicros + BigInt(res.rows[0]!.delta);
}

async function sign(
    d: ColdDeps,
    id: number,
    amountMicros: number,
): Promise<{ signed: SignedRefund; signingSlot: bigint }> {
    const { context, value } = await viaRpc(() =>
        d.rpc.getLatestBlockhash({ commitment: "confirmed" }).send(deadline(d.rpcTimeoutMs)),
    );
    const signed = await buildRefundTransaction(
        { feePayer: d.feePayer, cfg: d.refunds },
        {
            destination: d.coldTokenAccount,
            amountMicros,
            source: d.allowance,
            memo: `bugnet-cold ${id}`,
        },
        value,
    );
    return { signed, signingSlot: context.slot };
}

export async function runColdTransfer(d: ColdDeps): Promise<{
    sent: boolean;
    amountMicros: number;
    parts: number;
    reason?: ColdSkip;
}> {
    const skip = (reason: ColdSkip) => ({ sent: false, amountMicros: 0, parts: 0, reason });
    const now = d.now();
    if ((await readControls(d.pool)).paused) return skip("paused");
    const open = await d.pool.query(
        "select 1 from x402_cold_transfers where state in ('signed', 'sent') limit 1",
    );
    if (open.rows.length > 0) return skip("in_flight");

    const stale = (t: Tail) =>
        t.verifiedAt === null ||
        now.getTime() - t.verifiedAt.getTime() > d.x402.cold_transfer_verify_age;
    let tail = await readTail(d.pool);
    if (stale(tail)) {
        await d.requestMirror();
        tail = await readTail(d.pool);
        if (stale(tail)) return skip("unverified");
    }
    const slot = tail.verifiedSlot;

    const found = await transferableParts(d.pool, slot, tail);
    if (found.length === 0) return skip("empty");
    const total = sum(found);
    const oldest = Math.min(...found.map((p) => p.since.getTime()));
    if (
        total < d.x402.cold_transfer_threshold_micros &&
        now.getTime() - oldest < d.x402.cold_transfer_max_age
    ) {
        return skip("below_threshold");
    }

    const balance = await balanceAt(d.pool, slot, tail);
    const liabilities = await liabilitiesAt(d.pool, slot, tail);
    const unsettled = await unsettledColdTransfersAt(d.pool, slot);
    if (balance < liabilities + unsettled + BigInt(total)) {
        await withTx(
            d.pool,
            (c) =>
                recordIncident(
                    c,
                    {
                        kind: "balance_short",
                        subject: "balance_short",
                        detail: {
                            slot: slot.toString(),
                            balanceMicros: balance.toString(),
                            liabilitiesMicros: liabilities.toString(),
                            unsettledMicros: unsettled.toString(),
                            amountMicros: total,
                        },
                    },
                    d.log,
                    now,
                ),
            d.log,
        );
        return skip("balance_short");
    }

    const orderIds = found.flatMap((p) => (p.orderId === null ? [] : [p.orderId]));
    const accountIds = [
        ...new Set(found.flatMap((p) => (p.accountId === null ? [] : [p.accountId]))),
    ].sort();
    let stored: { id: number; signed: SignedRefund; amountMicros: number; parts: number } | null =
        null;
    await withTx(
        d.pool,
        async (c) => {
            stored = null;
            await lockOrders(c, orderIds);
            for (const accountId of accountIds) await lockAccount(c, accountId);
            const orders = new Set(orderIds);
            const accounts = new Set(accountIds);
            const kept = (await transferableParts(c, slot, tail)).filter((p) =>
                p.orderId === null ? accounts.has(p.accountId!) : orders.has(p.orderId),
            );
            const amountMicros = sum(kept);
            if (amountMicros === 0) return;
            const next = await c.query<{ id: string }>(
                "select nextval(pg_get_serial_sequence('x402_cold_transfers', 'id')) as id",
            );
            const id = Number(next.rows[0]!.id);
            const { signed, signingSlot } = await sign(d, id, amountMicros);
            await c.query(
                `insert into x402_cold_transfers (id, amount_micros, state, tx_signature, wire_tx,
                    last_valid_block_height, signing_slot, attempts, created_at)
                 values ($1, $2, 'signed', $3, $4, $5, $6, 1, $7)`,
                [
                    id,
                    amountMicros,
                    signed.signature,
                    signed.wire,
                    signed.lastValidBlockHeight.toString(),
                    signingSlot.toString(),
                    now,
                ],
            );
            const orderParts = kept.flatMap((p) => (p.orderId === null ? [] : [p.orderId]));
            const accountParts = kept.flatMap((p) => (p.accountId === null ? [] : [p.accountId]));
            await c.query("update orders set cold_transfer_id = $1 where id = any($2::text[])", [
                id,
                orderParts,
            ]);
            await c.query(
                "update x402_accounts set kept_cold_transfer_id = $1 where id = any($2::text[])",
                [id, accountParts],
            );
            stored = { id, signed, amountMicros, parts: kept.length };
        },
        d.log,
    );
    const row = stored as {
        id: number;
        signed: SignedRefund;
        amountMicros: number;
        parts: number;
    } | null;
    if (row === null) return skip("empty");

    await broadcast(d, row.id, row.signed.wire, row.signed.signature, FRESH_SEND);
    return { sent: true, amountMicros: row.amountMicros, parts: row.parts };
}

// A send error or a pause leaves the row as it is, and advanceColdTransfers reads its landing next
// run. The pause is read again here because it may have been raised since the run began.
async function broadcast(
    d: ColdDeps,
    id: number,
    wire: string,
    signature: string,
    config: typeof FRESH_SEND | typeof RESEND,
): Promise<boolean> {
    if ((await readControls(d.pool)).paused) return false;
    try {
        await d.rpc
            .sendTransaction(wire as Base64EncodedWireTransaction, config)
            .send(deadline(d.rpcTimeoutMs));
    } catch (err) {
        d.log.warn("cold transfer send failed", { coldTransferId: id, err: String(err) });
        return false;
    }
    await d.pool.query(
        `update x402_cold_transfers set state = 'sent'
         where id = $1 and tx_signature = $2 and state = 'signed'`,
        [id, signature],
    );
    return true;
}

interface InFlightRow {
    id: string;
    amount_micros: string;
    tx_signature: string;
    wire_tx: string;
    last_valid_block_height: string;
    previous_signatures: string[];
    expiry_seen_slot: string | null;
    attempts: number;
}

export async function advanceColdTransfers(
    d: ColdDeps,
): Promise<{ confirmed: number; resent: number; resigned: number; failed: number }> {
    const tick = { confirmed: 0, resent: 0, resigned: 0, failed: 0 };
    const rows = await d.pool.query<{ id: string }>(
        "select id from x402_cold_transfers where state in ('signed', 'sent') order by id",
    );
    for (const { id } of rows.rows) {
        try {
            await advanceOne(d, Number(id), tick);
        } catch (err) {
            const ids = { coldTransferId: Number(id) };
            if (err instanceof RpcUnavailable) {
                d.log.warn("cold transfer rpc call failed, retrying next tick", {
                    ...ids,
                    err: err.cause,
                });
            } else {
                d.log.error("cold transfer step failed, retrying next tick", { ...ids, err });
            }
        }
    }
    return tick;
}

async function advanceOne(
    d: ColdDeps,
    id: number,
    tick: { confirmed: number; resent: number; resigned: number; failed: number },
): Promise<void> {
    const res = await d.pool.query<InFlightRow>(
        `select id, amount_micros, tx_signature, wire_tx, last_valid_block_height,
            previous_signatures, expiry_seen_slot, attempts
         from x402_cold_transfers where id = $1 and state in ('signed', 'sent')`,
        [id],
    );
    const r = res.rows[0];
    if (r === undefined) return;
    const now = d.now();
    const read = await viaRpc(() =>
        readLanding(
            d.rpc,
            r.tx_signature,
            BigInt(r.last_valid_block_height),
            d.rpcTimeoutMs,
            r.previous_signatures,
        ),
    );
    const key = `cold:${id}`;
    switch (read.landing) {
        case "processed":
            return;
        case "landed": {
            clearResignWait(key);
            const done = await withTx(
                d.pool,
                (c) =>
                    confirmColdTransfer(c, id, { slot: read.slot, signature: read.signature }, now),
                d.log,
            );
            if (done) tick.confirmed++;
            return;
        }
        case "onchain_failed":
            clearResignWait(key);
            if (await failAndAlarm(d, id, Number(r.amount_micros))) tick.failed++;
            return;
        case "not_found":
            if (await broadcast(d, id, r.wire_tx, r.tx_signature, RESEND)) tick.resent++;
            return;
        case "blockhash_expired":
            break;
    }

    const proof = await resignProof(
        d.pool,
        d.rpc,
        {
            signatures: [r.tx_signature, ...r.previous_signatures],
            expirySeenSlot: r.expiry_seen_slot === null ? null : BigInt(r.expiry_seen_slot),
        },
        d.x402,
        d.rpcTimeoutMs,
    );
    if (proof === "landed") return;
    if (proof === "wait") {
        noteResignWait(key, now, d.x402, d.log, { coldTransferId: id });
        return;
    }
    clearResignWait(key);
    if (r.attempts >= d.refunds.max_attempts) {
        if (await failAndAlarm(d, id, Number(r.amount_micros))) tick.failed++;
        return;
    }
    if ((await readControls(d.pool)).paused) return;

    let fresh: SignedRefund | null = null;
    await withTx(
        d.pool,
        async (c) => {
            fresh = null;
            const locked = await c.query<{ state: string; tx_signature: string }>(
                "select state, tx_signature from x402_cold_transfers where id = $1 for no key update",
                [id],
            );
            const cur = locked.rows[0];
            if (
                cur === undefined ||
                (cur.state !== "signed" && cur.state !== "sent") ||
                cur.tx_signature !== r.tx_signature
            ) {
                return;
            }
            const { signed, signingSlot } = await sign(d, id, Number(r.amount_micros));
            await c.query(
                `update x402_cold_transfers set state = 'signed', tx_signature = $2, wire_tx = $3,
                    last_valid_block_height = $4, signing_slot = $5, expiry_seen_slot = null,
                    attempts = attempts + 1,
                    previous_signatures = previous_signatures || $6::text
                 where id = $1`,
                [
                    id,
                    signed.signature,
                    signed.wire,
                    signed.lastValidBlockHeight.toString(),
                    signingSlot.toString(),
                    r.tx_signature,
                ],
            );
            fresh = signed;
        },
        d.log,
    );
    const signed = fresh as SignedRefund | null;
    if (signed === null) return;
    tick.resigned++;
    await broadcast(d, id, signed.wire, signed.signature, FRESH_SEND);
}

async function failAndAlarm(d: ColdDeps, id: number, amountMicros: number): Promise<boolean> {
    const failed = await withTx(d.pool, (c) => failColdTransfer(c, id), d.log);
    if (failed) d.log.alarm("x402_cold_transfer_failed", { coldTransferId: id, amountMicros });
    return failed;
}

// Orders first, then accounts (the order every other path takes), then the row itself. True when
// this call failed the row; the caller raises the alarm once the transaction has committed.
export async function failColdTransfer(c: pg.PoolClient, id: number): Promise<boolean> {
    await c.query(
        "select id from orders where cold_transfer_id = $1 order by id for no key update",
        [id],
    );
    await c.query(
        "select id from x402_accounts where kept_cold_transfer_id = $1 order by id for no key update",
        [id],
    );
    const res = await c.query<{ state: string }>(
        "select state from x402_cold_transfers where id = $1 for no key update",
        [id],
    );
    const row = res.rows[0];
    if (row === undefined || (row.state !== "signed" && row.state !== "sent")) return false;
    await c.query("update x402_cold_transfers set state = 'failed' where id = $1", [id]);
    await c.query("update orders set cold_transfer_id = null where cold_transfer_id = $1", [id]);
    await c.query(
        "update x402_accounts set kept_cold_transfer_id = null where kept_cold_transfer_id = $1",
        [id],
    );
    return true;
}
