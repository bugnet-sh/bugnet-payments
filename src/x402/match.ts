import { createHash } from "node:crypto";
import {
    type Address,
    getBase58Decoder,
    getBase58Encoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    signature as toSignature,
} from "@solana/kit";
import { transactionMessageHash } from "@x402/svm";
import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx, type Queryable } from "../db/pool.ts";
import { isRecord } from "../is-record.ts";
import type { Log } from "../log.ts";
import { lockPayment, setPaymentLandedSlot } from "../orders/store.ts";
import type { X402ResolvedInput } from "../router/client.ts";
import { confirmHotRefund } from "../refunds/hot.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "../solana/constants.ts";
import { deadline, rpcErrorFields, type SolanaRpc } from "../solana/rpc.ts";
import { recordIncident, type IncidentFact } from "./incidents.ts";
import { lockAccount } from "./ledger.ts";
import { enqueueX402Resolved } from "./outbox.ts";
import { resolveSigned, toX402Payment, X402_PAYMENT_COLUMNS } from "./reserve.ts";
import type { X402PaymentRow } from "./types.ts";

type TokenInstructionName =
    | "Transfer"
    | "TransferChecked"
    | "Approve"
    | "SetAuthority"
    | "CloseAccount"
    | "FreezeAccount"
    | "other";

export interface ChainTx {
    signature: string;
    slot: bigint;
    signatures: string[];
    failed: boolean;
    deltaMicros: bigint;
    messageHash: string;
    tokenDeltas: ReadonlyMap<string, bigint>;
    tokenInstructions: readonly { name: TokenInstructionName; writable: readonly string[] }[];
}

const TOKEN_INSTRUCTION_NAMES: Readonly<Record<number, TokenInstructionName>> = {
    3: "Transfer",
    12: "TransferChecked",
    4: "Approve",
    6: "SetAuthority",
    9: "CloseAccount",
    10: "FreezeAccount",
};

interface RawBalance {
    accountIndex: number;
    mint: string;
    uiTokenAmount: { amount: string };
}

interface RawInstruction {
    programIdIndex: number;
    accounts: readonly number[];
    data: string;
}

function usdcBalances(list: unknown): Map<number, bigint> {
    const out = new Map<number, bigint>();
    if (!Array.isArray(list)) return out;
    for (const b of list as RawBalance[]) {
        if (b.mint === USDC_MINT) out.set(Number(b.accountIndex), BigInt(b.uiTokenAmount.amount));
    }
    return out;
}

// getTransaction with encoding base64, so meta carries the token balances and inner instructions
export function parseChainTx(
    signature: string,
    slot: bigint,
    raw: unknown,
    hotTokenAccount: string,
): ChainTx {
    if (
        !isRecord(raw) ||
        !Array.isArray(raw.transaction) ||
        raw.transaction[1] !== "base64" ||
        !isRecord(raw.meta)
    ) {
        throw new Error("getTransaction answer has no base64 transaction and meta");
    }
    const meta = raw.meta;
    const tx = getTransactionDecoder().decode(
        getBase64Encoder().encode(raw.transaction[0] as string),
    );
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (compiled.version === 1) throw new Error("version 1 transactions are not read");
    const loaded = isRecord(meta.loadedAddresses) ? meta.loadedAddresses : {};
    const loadedWritable = (loaded.writable ?? []) as string[];
    const loadedReadonly = (loaded.readonly ?? []) as string[];
    const statics = compiled.staticAccounts as readonly string[];
    const accounts = [...statics, ...loadedWritable, ...loadedReadonly];
    const header = compiled.header;

    const isWritable = (i: number): boolean => {
        if (i < header.numSignerAccounts) {
            return i < header.numSignerAccounts - header.numReadonlySignerAccounts;
        }
        if (i < statics.length) return i < statics.length - header.numReadonlyNonSignerAccounts;
        return i < statics.length + loadedWritable.length;
    };

    const zero = getBase58Decoder().decode(new Uint8Array(64));
    const signatures = statics
        .slice(0, header.numSignerAccounts)
        .map((signer) => tx.signatures[signer as Address])
        .map((s) => (s ? getBase58Decoder().decode(s) : zero));

    if (signatures[0] !== signature) {
        throw new Error("getTransaction answer is for a different signature");
    }

    const pre = usdcBalances(meta.preTokenBalances);
    const post = usdcBalances(meta.postTokenBalances);
    const tokenDeltas = new Map<string, bigint>();
    for (const index of new Set([...pre.keys(), ...post.keys()])) {
        const account = accounts[index];
        if (account === undefined) continue;
        tokenDeltas.set(account, (post.get(index) ?? 0n) - (pre.get(index) ?? 0n));
    }

    const tokenInstructions: { name: TokenInstructionName; writable: string[] }[] = [];
    const add = (programIndex: number, indices: readonly number[], data: Uint8Array) => {
        if (accounts[programIndex] !== TOKEN_PROGRAM) return;
        tokenInstructions.push({
            name: TOKEN_INSTRUCTION_NAMES[data[0] ?? -1] ?? "other",
            writable: indices.filter(isWritable).map((i) => accounts[i]!),
        });
    };
    for (const ix of compiled.instructions) {
        add(ix.programAddressIndex, ix.accountIndices ?? [], new Uint8Array(ix.data ?? []));
    }
    if (Array.isArray(meta.innerInstructions)) {
        for (const group of meta.innerInstructions as { instructions: RawInstruction[] }[]) {
            for (const ix of group.instructions) {
                add(
                    ix.programIdIndex,
                    ix.accounts,
                    new Uint8Array(getBase58Encoder().encode(ix.data)),
                );
            }
        }
    }

    return {
        signature,
        slot,
        signatures,
        failed: meta.err !== null && meta.err !== undefined,
        deltaMicros: tokenDeltas.get(hotTokenAccount) ?? 0n,
        messageHash: transactionMessageHash(tx),
        tokenDeltas,
        tokenInstructions,
    };
}

export interface MatchDeps {
    x402: Settings["x402"];
    hotTokenAccount: string;
    coldTokenAccount: string;
    log: Log;
    now: () => Date;
    rpcTimeoutMs: number;
}

export type MatchKind =
    "payment" | "order" | "refund" | "cold_transfer" | "inflow" | "no_effect" | "unknown";

interface Matched {
    kind: MatchKind;
    id: string | null;
    incidents: IncidentFact[];
    alarms?: Record<string, unknown>[];
}

const sha256 = (s: string): Buffer =>
    createHash("sha256")
        .update(Buffer.from(getBase58Encoder().encode(s)))
        .digest();

const lossOf = (tx: ChainTx): number => (tx.deltaMicros < 0n ? Number(-tx.deltaMicros) : 0);

function unknownChange(tx: ChainTx, extra: Partial<IncidentFact> = {}): IncidentFact {
    return {
        kind: "unknown_change",
        subject: tx.signature,
        lossMicros: lossOf(tx),
        detail: {
            signature: tx.signature,
            slot: tx.slot.toString(),
            deltaMicros: tx.deltaMicros.toString(),
        },
        ...extra,
    };
}

function hotInstructions(tx: ChainTx, d: MatchDeps) {
    return tx.tokenInstructions.filter((ix) => ix.writable.includes(d.hotTokenAccount));
}

// R5: the message, the hot debit, the seller's credit and the one TransferChecked all agree
function passesR5(tx: ChainTx, row: X402PaymentRow, d: MatchDeps): boolean {
    const amount = BigInt(row.amountMicros);
    const touching = hotInstructions(tx, d);
    return (
        tx.messageHash === row.messageHash &&
        tx.deltaMicros === -amount &&
        tx.tokenDeltas.get(row.payToTokenAccount) === amount &&
        touching.length === 1 &&
        touching[0]!.name === "TransferChecked"
    );
}

async function lateLanding(
    c: pg.PoolClient,
    tx: ChainTx,
    row: X402PaymentRow,
    d: MatchDeps,
): Promise<IncidentFact[]> {
    await lockAccount(c, row.accountId);
    const res = await c.query(
        `update x402_payments set state = 'confirmed', late_landed = true, landed_slot = $2,
            tx_signature = $3, resolved_at = $4
         where id = $1 and state = 'expired_unlanded'`,
        [row.id, tx.slot.toString(), tx.signatures[0], d.now()],
    );
    if (res.rowCount !== 1) return [];
    await c.query(
        `insert into x402_payto_days (pay_to, day, micros) values ($1, $2::date, $3)
         on conflict (pay_to, day) do update set micros = x402_payto_days.micros + excluded.micros`,
        [row.payTo, row.capDay, row.amountMicros],
    );
    if (row.listed === "unlisted") {
        await c.query(
            `insert into x402_unlisted_days (day, micros) values ($1::date, $2)
             on conflict (day) do update set micros = x402_unlisted_days.micros + excluded.micros`,
            [row.capDay, row.amountMicros],
        );
    }
    await c.query(
        `insert into x402_outflow_days (day, micros) values ($1::date, $2)
         on conflict (day) do update set micros = x402_outflow_days.micros + excluded.micros`,
        [row.capDay, row.amountMicros],
    );
    return [
        {
            kind: "late_landing",
            subject: tx.signature,
            lossMicros: row.amountMicros,
            paymentId: row.id,
            detail: {
                signature: tx.signature,
                slot: tx.slot.toString(),
                deltaMicros: tx.deltaMicros.toString(),
                paymentId: row.id,
            },
        },
    ];
}

function resolvedInput(
    row: X402PaymentRow,
    status: X402ResolvedInput["status"],
    tx: string,
    at: Date,
): X402ResolvedInput {
    return {
        startOrderId: row.accountId,
        ref: row.ref,
        status,
        amountMicros: row.amountMicros,
        tx,
        at,
        host: row.host,
        method: row.method,
        path: row.path,
        payTo: row.payTo,
    };
}

async function matchPayment(c: pg.PoolClient, tx: ChainTx, d: MatchDeps): Promise<Matched | null> {
    const found = await c.query(
        `select ${X402_PAYMENT_COLUMNS} from x402_payments
         where our_signature_sha256 = any($1::bytea[]) order by created_at limit 1`,
        [tx.signatures.map(sha256)],
    );
    if (found.rows.length === 0) return null;
    const row = toX402Payment(found.rows[0]!);
    const at = d.now();
    const resolved = async (to: "confirmed" | "failed_onchain", t: string) => {
        const landed = to === "confirmed" ? { landedSlot: tx.slot, txSignature: t } : {};
        const done = await resolveSigned(c, row.id, to, landed, at, d.x402, d.log);
        if (done === null) return;
        await enqueueX402Resolved(
            c,
            resolvedInput(done, to === "confirmed" ? "paid" : "released", t, at),
            at,
        );
    };
    const out = (kind: MatchKind, incidents: IncidentFact[] = []): Matched => ({
        kind,
        id: row.id,
        incidents,
    });

    if (row.state === "signed") {
        if (tx.failed) {
            await resolved("failed_onchain", "");
            return out("payment");
        }
        if (passesR5(tx, row, d)) {
            await resolved("confirmed", tx.signatures[0]!);
            return out("payment");
        }
        return out("unknown", [unknownChange(tx, { paymentId: row.id })]);
    }
    if (row.state === "expired_unlanded" && !tx.failed) {
        if (!passesR5(tx, row, d)) {
            return out("unknown", [unknownChange(tx, { paymentId: row.id })]);
        }
        return out("payment", await lateLanding(c, tx, row, d));
    }
    return out("payment");
}

async function matchOrder(c: pg.PoolClient, tx: ChainTx): Promise<Matched | null> {
    const found = await c.query<{ order_id: string }>(
        "select order_id from payments where tx_signature = any($1::text[]) limit 1",
        [tx.signatures],
    );
    const orderId = found.rows[0]?.order_id;
    if (orderId === undefined) return null;
    if (!tx.failed) {
        await lockPayment(c, orderId);
        await setPaymentLandedSlot(c, orderId, tx.slot);
    }
    return { kind: "order", id: orderId, incidents: [] };
}

async function matchLateOrder(c: pg.PoolClient, tx: ChainTx): Promise<Matched | null> {
    if (tx.failed) return null;
    const found = await c.query<{ order_id: string }>(
        `select f.order_id from failed_payments f join orders o on o.id = f.order_id
         where f.tx_signature = $1 and o.pay_into = 'allowance' limit 1`,
        [tx.signatures[0]],
    );
    const orderId = found.rows[0]?.order_id;
    if (orderId === undefined) return null;
    return {
        kind: "order",
        id: orderId,
        incidents: [],
        alarms: [{ orderId, signature: tx.signature, micros: Number(tx.deltaMicros) }],
    };
}

// A hot refund or a transfer to cold: the one row that owns one of the transaction's signatures
async function matchOutgoing(c: pg.PoolClient, tx: ChainTx, d: MatchDeps): Promise<Matched | null> {
    const refund = await c.query<{
        id: string;
        amount_micros: string;
        destination: string;
        tx_signature: string | null;
        previous_signatures: string[];
    }>(
        `select id, amount_micros, destination, tx_signature, previous_signatures from refunds
         where from_wallet = 'allowance'
            and (tx_signature = any($1::text[]) or previous_signatures && $1::text[])
         order by id limit 1`,
        [tx.signatures],
    );
    let kind: "refund" | "cold_transfer";
    let row: {
        id: string;
        amount_micros: string;
        tx_signature: string | null;
        previous_signatures: string[];
    };
    let destination: string;
    if (refund.rows[0] !== undefined) {
        kind = "refund";
        row = refund.rows[0];
        destination = refund.rows[0].destination;
    } else {
        const cold = await c.query<typeof row>(
            `select id, amount_micros, tx_signature, previous_signatures from x402_cold_transfers
             where tx_signature = any($1::text[]) or previous_signatures && $1::text[]
             order by id limit 1`,
            [tx.signatures],
        );
        if (cold.rows[0] === undefined) return null;
        kind = "cold_transfer";
        row = cold.rows[0];
        destination = d.coldTokenAccount;
    }
    const id = Number(row.id);
    const result = (k: MatchKind, incidents: IncidentFact[] = []): Matched => ({
        kind: k,
        id: row.id,
        incidents,
    });
    if (tx.failed) return result(kind);

    const amount = BigInt(row.amount_micros);
    const owner = kind === "refund" ? { refundId: id } : { coldTransferId: id };
    if (tx.deltaMicros !== -amount || tx.tokenDeltas.get(destination) !== amount) {
        return result("unknown", [unknownChange(tx, owner)]);
    }
    const twin = await c.query(
        `select 1 from x402_chain_txs
         where matched = $1 and matched_id = $2 and not failed and signature <> $3 limit 1`,
        [kind, row.id, tx.signature],
    );
    if (twin.rows.length > 0) {
        return result(kind, [
            {
                kind: "double_transfer",
                subject: tx.signature,
                lossMicros: Number(amount),
                detail: {
                    signature: tx.signature,
                    slot: tx.slot.toString(),
                    deltaMicros: tx.deltaMicros.toString(),
                },
                ...owner,
            },
        ]);
    }
    const landedBy = tx.signatures.find(
        (s) => s === row.tx_signature || row.previous_signatures.includes(s),
    )!;
    const landed = { slot: tx.slot, signature: landedBy };
    const confirmed =
        kind === "refund"
            ? await confirmHotRefund(c, id, landed, d.now(), d.x402, d.log)
            : await confirmColdTransfer(c, id, landed, d.now());
    if (!confirmed) {
        await c.query(
            `update ${kind === "refund" ? "refunds" : "x402_cold_transfers"}
             set landed_slot = $2 where id = $1 and landed_slot is null`,
            [id, tx.slot.toString()],
        );
    }
    return result(kind);
}

// The caller holds `c` inside withTx and runs `afterCommit` once the transaction committed
export async function storeAndMatch(
    c: pg.PoolClient,
    tx: ChainTx,
    d: MatchDeps,
    afterCommit: (() => void)[],
): Promise<MatchKind> {
    const stored = await c.query<{ matched: MatchKind }>(
        "select matched from x402_chain_txs where signature = $1",
        [tx.signature],
    );
    if (stored.rows[0] !== undefined) return stored.rows[0].matched;

    let m =
        (await matchPayment(c, tx, d)) ??
        (await matchOrder(c, tx)) ??
        (await matchLateOrder(c, tx)) ??
        (await matchOutgoing(c, tx, d));
    if (m === null) {
        const touching = hotInstructions(tx, d);
        const creditOnly = touching.every(
            (ix) => ix.name === "Transfer" || ix.name === "TransferChecked",
        );
        const bugnetDebit = [d.hotTokenAccount, d.coldTokenAccount].some(
            (a) => (tx.tokenDeltas.get(a) ?? 0n) < 0n,
        );
        if (tx.failed || (tx.deltaMicros === 0n && touching.length === 0)) {
            m = { kind: "no_effect", id: null, incidents: [] };
        } else if (tx.deltaMicros === 0n && creditOnly && !bugnetDebit) {
            m = { kind: "no_effect", id: null, incidents: [] };
            d.log.info("x402 zero-amount transfer into the hot account", {
                signature: tx.signature,
                slot: tx.slot.toString(),
            });
        } else if (tx.deltaMicros > 0n && creditOnly) {
            m = { kind: "inflow", id: null, incidents: [] };
            if (tx.deltaMicros >= BigInt(d.x402.refund_min_micros)) {
                m.alarms = [{ signature: tx.signature, micros: Number(tx.deltaMicros) }];
            }
        } else {
            m = { kind: "unknown", id: null, incidents: [unknownChange(tx)] };
        }
    }

    const inserted = await c.query(
        `insert into x402_chain_txs (signature, slot, delta_micros, failed, matched, matched_id)
         values ($1, $2, $3, $4, $5, $6) on conflict (signature) do nothing`,
        [tx.signature, tx.slot.toString(), tx.deltaMicros.toString(), tx.failed, m.kind, m.id],
    );
    if (inserted.rowCount !== 1) throw new Error("chain tx stored twice");
    for (const incident of m.incidents) await recordIncident(c, incident, d.log, d.now());
    for (const fields of m.alarms ?? []) {
        afterCommit.push(() => d.log.alarm("inflow_mismatch", fields));
    }
    return m.kind;
}

// One transaction: the match, then the alarms it asked for
export async function matchInTx(pool: pg.Pool, tx: ChainTx, d: MatchDeps): Promise<MatchKind> {
    const afterCommit: (() => void)[] = [];
    const kind = await withTx(pool, (c) => storeAndMatch(c, tx, d, afterCommit), d.log);
    for (const fire of afterCommit) fire();
    return kind;
}

// The swap of `confirm` in src/refunds/executor.ts
export async function confirmColdTransfer(
    c: pg.PoolClient,
    id: number,
    landed: { slot: bigint; signature: string },
    at: Date,
): Promise<boolean> {
    const res = await c.query(
        `update x402_cold_transfers set state = 'confirmed', landed_slot = $2, confirmed_at = $3,
            tx_signature = $4,
            previous_signatures = case when tx_signature = $4 then previous_signatures
                else array_append(array_remove(previous_signatures, $4), tx_signature) end
         where id = $1 and state in ('signed', 'sent')`,
        [id, landed.slot.toString(), at, landed.signature],
    );
    return res.rowCount === 1;
}

export interface VerifiedRun {
    h0: bigint;
    c0: bigint;
    verifiedSlot: bigint;
}

async function markExpirySeen(pool: pg.Pool, run: VerifiedRun): Promise<number> {
    const targets = [
        ["x402_payments", "state = 'signed'"],
        ["refunds", "from_wallet = 'allowance' and state in ('signed', 'sent')"],
        ["x402_cold_transfers", "state in ('signed', 'sent')"],
    ] as const;
    let seen = 0;
    for (const [table, live] of targets) {
        const res = await pool.query(
            `update ${table} set expiry_seen_slot = $1
             where expiry_seen_slot is null and last_valid_block_height < $2 and ${live}`,
            [run.c0.toString(), run.h0.toString()],
        );
        seen += res.rowCount ?? 0;
    }
    return seen;
}

// True when the row was dealt with and must not expire in this run
async function checkLanded(
    pool: pg.Pool,
    rpc: SolanaRpc,
    row: X402PaymentRow,
    d: MatchDeps,
): Promise<boolean> {
    const sig = toSignature(row.txSignature!);
    try {
        const raw = await rpc
            .getTransaction(sig, {
                commitment: "finalized",
                encoding: "base64",
                maxSupportedTransactionVersion: 0,
            })
            .send(deadline(d.rpcTimeoutMs));
        if (raw !== null) {
            const tx = parseChainTx(row.txSignature!, raw.slot, raw, d.hotTokenAccount);
            await matchInTx(pool, tx, d);
            return true;
        }
        const statuses = await rpc
            .getSignatureStatuses([sig], { searchTransactionHistory: true })
            .send(deadline(d.rpcTimeoutMs));
        const dropped =
            statuses.value[0] === null &&
            statuses.context.slot >= row.landedSlot! + BigInt(d.x402.mirror_rescan_slots);
        if (!dropped) return true;
        await pool.query(
            `update x402_payments set landed_slot = null, tx_signature = null
             where id = $1 and state = 'signed'`,
            [row.id],
        );
        return false;
    } catch (err) {
        d.log.warn("x402 expiry could not check a landed payment", {
            paymentId: row.id,
            ...rpcErrorFields(err),
        });
        return true;
    }
}

const alarmedElsewhere = new Set<string>();

// A signed payment whose signature names a stored transaction that belongs to another row
async function alarmMatchedElsewhere(
    pool: pg.Pool,
    row: X402PaymentRow,
    d: MatchDeps,
): Promise<boolean> {
    if (row.txSignature === null) return false;
    const res = await pool.query<{ matched: string; matched_id: string | null }>(
        "select matched, matched_id from x402_chain_txs where signature = $1",
        [row.txSignature],
    );
    const stored = res.rows[0];
    if (stored === undefined || stored.matched_id === row.id) return false;
    if (!alarmedElsewhere.has(row.id)) {
        alarmedElsewhere.add(row.id);
        d.log.alarm("x402_incident", {
            kind: "unknown_change",
            paymentId: row.id,
            signature: row.txSignature,
            matched: stored.matched,
            matchedId: stored.matched_id,
        });
    }
    return true;
}

export async function applyExpiry(
    pool: pg.Pool,
    rpc: SolanaRpc,
    run: VerifiedRun,
    d: MatchDeps,
): Promise<{ seen: number; expired: number }> {
    const seen = await markExpirySeen(pool, run);
    const due = await pool.query(
        `select ${X402_PAYMENT_COLUMNS} from x402_payments p
         where state = 'signed' and expiry_seen_slot + $1 <= $2
            and not exists (select 1 from x402_chain_txs t where t.matched_id = p.id)
         order by created_at`,
        [d.x402.mirror_rescan_slots, run.verifiedSlot.toString()],
    );
    let expired = 0;
    for (const raw of due.rows) {
        const row = toX402Payment(raw);
        if (await alarmMatchedElsewhere(pool, row, d)) continue;
        if (row.landedSlot !== null && row.txSignature !== null) {
            if (await checkLanded(pool, rpc, row, d)) continue;
        }
        const at = d.now();
        const done = await withTx(
            pool,
            async (c) => {
                const r = await resolveSigned(c, row.id, "expired_unlanded", {}, at, d.x402, d.log);
                if (r === null) return false;
                await enqueueX402Resolved(c, resolvedInput(r, "released", "", at), at);
                return true;
            },
            d.log,
        );
        if (done) expired++;
    }
    return { seen, expired };
}

const alarmedUnresolved = new Set<string>();

export async function alarmUnresolved(db: Queryable, d: MatchDeps): Promise<number> {
    const res = await db.query<{
        id: string;
        signed_at: Date;
        signing_slot: string | null;
        last_valid_block_height: string | null;
    }>(
        `select id, signed_at, signing_slot, last_valid_block_height from x402_payments
         where state = 'signed'
            and signed_at < $1::timestamptz - make_interval(secs => $2::float8 / 1000.0)
         order by signed_at`,
        [d.now(), d.x402.unresolved_alarm_after],
    );
    let fired = 0;
    for (const r of res.rows) {
        if (alarmedUnresolved.has(r.id)) continue;
        alarmedUnresolved.add(r.id);
        d.log.alarm("x402_unresolved", {
            paymentId: r.id,
            signedAt: r.signed_at.toISOString(),
            signingSlot: r.signing_slot,
            lastValidBlockHeight: r.last_valid_block_height,
        });
        fired++;
    }
    return fired;
}
