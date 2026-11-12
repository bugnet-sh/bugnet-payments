/**
 * The deposit move executor (spec 11.1, 11.2, 6.3): store before send, a guard read pinned to the
 * ledger before any move that takes money out, and a re-sign only after the deposit's own proof.
 *
 * A pending move is checked, guarded, signed and stored as `signed` in one database transaction,
 * then sent; nothing is broadcast before COMMIT. A move a scan listed as landed is confirmed at
 * once. Any other move in flight is checked once `move_check_after` has passed since its send:
 * confirmed when it landed, failed when it failed on chain, resent unchanged while it is missing
 * and its blockhash is valid, and signed again once the blockhash expired only when a pinned
 * balance read and a history scan both show that none of its signatures landed. Every call runs
 * on `rpc`, the money lane. An RPC error leaves the row for the next tick.
 */
import {
    address,
    type Address,
    type Base64EncodedWireTransaction,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    type Instruction,
    isAddress,
    isSolanaError,
    type KeyPairSigner,
    SOLANA_ERROR__INSTRUCTION_ERROR__UNKNOWN,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from "@solana/kit";
import {
    getCloseAccountInstruction,
    getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token";
import { transactionMessageHash } from "@x402/svm";
import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import type { Log } from "../log.ts";
import { lockOrder, lockPayment } from "../orders/store.ts";
import { FRESH_SEND, RESEND, RpcUnavailable, viaRpc } from "../refunds/executor.ts";
import { ownedUsdcAccount, usdcAta } from "../solana/accounts.ts";
import type { BlockhashHint } from "../solana/blockhash.ts";
import { MEMO_PROGRAM, USDC_MINT } from "../solana/constants.ts";
import { readLanding } from "../solana/landing.ts";
import { deadline, rpcErrorFields, type SolanaRpc } from "../solana/rpc.ts";
import { signV0Transaction, usdcTransferChecked } from "../solana/transfer.ts";
import type { PaidDeps } from "../x402/paid.ts";
import type { DepositKeys } from "./keys.ts";
import {
    createdBy,
    expectedBalanceAt,
    fetchTx,
    readDepositBalances,
    ReadTrail,
    type ScanDeps,
    scanStep,
    type TxCache,
} from "./scan.ts";
import {
    deletePendingMove,
    depositLedger,
    findDeposit,
    findMove,
    lockDeposit,
    lockMove,
    setTransferOutcomes,
    updateDeposit,
} from "./store.ts";
import type { DepositRow, MoveRow, MoveState, TransferRow } from "./types.ts";

export interface MoveDeps {
    // The money lane: every executor call, the re-sign proof's read and scan included
    pool: pg.Pool;
    rpc: SolanaRpc;
    feePayer: KeyPairSigner;
    keys: DepositKeys;
    cfg: Settings["deposits"];
    recipientTokenAccount: Address;
    floatTokenAccount: Address;
    hotTokenAccount: Address | null;
    paid: PaidDeps | null;
    rpcTimeoutMs: number;
    log: Log;
    now: () => Date;
    cache: TxCache;
    confirmSweep: (
        c: pg.PoolClient,
        move: MoveRow,
        landed: { signature: string; slot: bigint },
    ) => Promise<void>;
    onSweepSigned: (c: pg.PoolClient, move: MoveRow, signed: SignedMove) => Promise<void>;
}

export interface SignedMove {
    wire: string;
    signature: string;
    lastValidBlockHeight: bigint;
    messageHash: string;
    blockhash: string;
    contextSlot: bigint;
}

// dropped: a closing move the account no longer matches; a pending row was deleted
export type GuardVerdict = "sign" | "below_ledger" | "dropped";

export interface MoveTick {
    signed: number;
    resent: number;
    resigned: number;
    confirmed: number;
    failed: number;
    manual: number;
    // pending rows deleted: a closing move against new money, or a return to an invalid account
    dropped: number;
    waitingProof: number;
}

type Ledger = { transfers: readonly TransferRow[]; moves: readonly MoveRow[] };
type Landed = { signature: string; slot: bigint };
type Proof = { kind: "absent" } | { kind: "wait" } | ({ kind: "landed" } & Landed);
// onchain: the chain failed it; refused: refused at preflight and proven never landed; expired:
// out of attempts; race: a closing move whose account changed before it could be signed again
type FailCause = "onchain" | "refused" | "expired" | "race";

// One attempt's re-sign proof, kept across ticks as the job keeps its trails: the cursor cannot
// move while the move is in flight, so a proof that listed from the top on every tick would never
// reach the cursor once more than scan_max_pages pages sit above it
interface ProofScan {
    orderId: string;
    signature: string | null;
    trail: ReadTrail;
    // Only once a scan finished: an unfinished listing goes on from the read it started on
    readAgain: boolean;
}

const SIGNATURE_LAMPORTS = 5_000n;
const IN_FLIGHT: ReadonlySet<MoveState> = new Set(["pending", "signed", "sent"]);
const SENT: ReadonlySet<MoveState> = new Set(["signed", "sent"]);
// Per database, by move id
const proofScans = new WeakMap<pg.Pool, Map<number, ProofScan>>();

function proofScansOf(pool: pg.Pool): Map<number, ProofScan> {
    let scans = proofScans.get(pool);
    if (scans === undefined) {
        scans = new Map();
        proofScans.set(pool, scans);
    }
    return scans;
}

const takesOut = (m: Pick<MoveRow, "amountMicros" | "keepMicros" | "heldMicros">): bigint =>
    BigInt(m.amountMicros + m.keepMicros + m.heldMicros);
const memo = (text: string): Instruction => ({
    programAddress: MEMO_PROGRAM,
    data: new TextEncoder().encode(text),
});
const maxOf = (values: readonly bigint[]): bigint => values.reduce((a, b) => (b > a ? b : a), 0n);

// signers x 5,000 plus the priority fee; a move refused at preflight never landed (spec 11.4)
export function moveFeeLamports(
    m: Pick<MoveRow, "kind" | "preflightRefusedAt">,
    cfg: Pick<Settings["deposits"], "compute_unit_limit" | "compute_unit_price_micro_lamports">,
): bigint {
    if (m.preflightRefusedAt !== null) return 0n;
    const signers = m.kind === "create" ? 1n : 2n;
    const units = BigInt(cfg.compute_unit_limit) * BigInt(cfg.compute_unit_price_micro_lamports);
    return signers * SIGNATURE_LAMPORTS + (units + 999_999n) / 1_000_000n;
}

export async function buildMoveTransaction(
    d: Pick<MoveDeps, "feePayer" | "cfg" | "recipientTokenAccount" | "floatTokenAccount">,
    m: Pick<
        MoveRow,
        | "kind"
        | "amountMicros"
        | "keepMicros"
        | "heldMicros"
        | "destination"
        | "memo"
        | "closes"
        | "closeTo"
        | "orderId"
    >,
    deposit: { owner: KeyPairSigner | null; address: Address },
    hint: BlockhashHint & { contextSlot: bigint },
): Promise<SignedMove> {
    const instructions: Instruction[] = [];
    if (m.kind === "create") {
        instructions.push(
            await getCreateAssociatedTokenIdempotentInstructionAsync({
                payer: d.feePayer,
                owner: deposit.address,
                mint: USDC_MINT,
            }),
        );
    } else {
        const owner = deposit.owner;
        if (owner === null) throw new Error(`a ${m.kind} move needs the deposit key`);
        if (m.amountMicros > 0) {
            if (m.destination === null) throw new Error(`a ${m.kind} move needs a destination`);
            instructions.push(
                await usdcTransferChecked(owner, address(m.destination), BigInt(m.amountMicros)),
            );
            if (m.memo !== null) instructions.push(memo(m.memo));
        }
        if (m.closes) {
            if (m.keepMicros > 0) {
                instructions.push(
                    await usdcTransferChecked(owner, d.recipientTokenAccount, BigInt(m.keepMicros)),
                    memo(`bugnet-kept ${m.orderId}`),
                );
            }
            if (m.heldMicros > 0) {
                instructions.push(
                    await usdcTransferChecked(owner, d.floatTokenAccount, BigInt(m.heldMicros)),
                    memo(`bugnet-held ${m.orderId}`),
                );
            }
            if (m.closeTo === null) throw new Error(`a closing ${m.kind} move needs close_to`);
            instructions.push(
                getCloseAccountInstruction({
                    account: await usdcAta(deposit.address),
                    destination: address(m.closeTo),
                    owner,
                }),
            );
        }
    }
    const signed = await signV0Transaction({
        feePayer: d.feePayer,
        blockhash: hint.blockhash,
        lastValidBlockHeight: hint.lastValidBlockHeight,
        computeUnitLimit: d.cfg.compute_unit_limit,
        computeUnitPrice: d.cfg.compute_unit_price_micro_lamports,
        instructions,
    });
    return {
        wire: getBase64EncodedWireTransaction(signed),
        signature: getSignatureFromTransaction(signed),
        lastValidBlockHeight: hint.lastValidBlockHeight,
        messageHash: transactionMessageHash(signed),
        blockhash: hint.blockhash,
        contextSlot: hint.contextSlot,
    };
}

/**
 * Reads the account pinned to the newest slot the ledger relies on (spec 6.3). Below the ledger,
 * the ledger expects money that is not there: an invariant failure for the scan, never review.
 * A closing move is signed only when the read is exactly what it takes out, because CloseAccount
 * fails against any other balance; a pending closing row is then deleted and its transfers freed,
 * so the planner plans again from the next read. Settle calls this before the first sweep.
 */
export async function guardRead(
    d: Pick<MoveDeps, "pool" | "rpc" | "rpcTimeoutMs" | "log">,
    deposit: DepositRow,
    move: Pick<
        MoveRow,
        "id" | "orderId" | "state" | "closes" | "amountMicros" | "keepMicros" | "heldMicros"
    >,
    ledger: Ledger,
): Promise<{ verdict: GuardVerdict; slot: bigint; micros: bigint }> {
    const pin = maxOf([
        deposit.checkedSlot ?? 0n,
        ...ledger.transfers.map((t) => t.slot),
        ...ledger.moves.flatMap((m) => (m.landedSlot === null ? [] : [m.landedSlot])),
    ]);
    const read = (
        await viaRpc(() =>
            readDepositBalances(d.rpc, [address(deposit.tokenAccount)], {
                timeoutMs: d.rpcTimeoutMs,
                minContextSlot: pin,
            }),
        )
    ).get(deposit.tokenAccount)!;
    const out = (verdict: GuardVerdict) => ({
        verdict,
        slot: read.contextSlot,
        micros: read.micros,
    });
    if (read.micros < expectedBalanceAt(ledger.transfers, ledger.moves, read.contextSlot)) {
        return out("below_ledger");
    }
    if (move.closes && read.micros !== takesOut(move)) {
        if (move.state === "pending") {
            await withTx(
                d.pool,
                async (c) => {
                    await lockDeposit(c, move.orderId);
                    await deletePendingMove(c, move.id);
                },
                d.log,
            );
        }
        return out("dropped");
    }
    return out("sign");
}

export async function pinnedBlockhash(
    d: Pick<MoveDeps, "rpc" | "rpcTimeoutMs">,
    guardSlot: bigint,
): Promise<BlockhashHint & { contextSlot: bigint }> {
    const { context, value } = await d.rpc
        .getLatestBlockhash({ commitment: "confirmed", minContextSlot: guardSlot })
        .send(deadline(d.rpcTimeoutMs));
    return {
        blockhash: value.blockhash,
        lastValidBlockHeight: value.lastValidBlockHeight,
        contextSlot: context.slot,
    };
}

export async function advanceMoves(d: MoveDeps, orderIds?: readonly string[]): Promise<MoveTick> {
    const tick: MoveTick = {
        signed: 0,
        resent: 0,
        resigned: 0,
        confirmed: 0,
        failed: 0,
        manual: 0,
        dropped: 0,
        waitingProof: 0,
    };
    const { rows } = await d.pool.query<{ id: string; order_id: string }>(
        `select id, order_id from deposit_moves
         where state in ('pending', 'signed', 'sent')
            and ($1::text[] is null or order_id = any($1::text[]))
         order by id`,
        [orderIds ?? null],
    );
    // Proofs share one scan_time_box a call, as the job's scans do, so a padded proof never
    // holds up the reads and settles after it (spec 6.4)
    const proofUntilMs = d.now().getTime() + d.cfg.scan_time_box;
    // A move no longer in flight drops its proof, however it left
    const live = new Set(rows.map((r) => Number(r.id)));
    const scans = proofScansOf(d.pool);
    for (const [id, p] of scans) {
        if (!live.has(id) && (orderIds === undefined || orderIds.includes(p.orderId))) {
            scans.delete(id);
        }
    }
    for (const r of rows) {
        const ids = { moveId: Number(r.id), orderId: r.order_id };
        try {
            await advanceOne(d, Number(r.id), tick, proofUntilMs);
        } catch (err) {
            if (err instanceof RpcUnavailable) {
                d.log.warn("deposit move rpc call failed, retrying next tick", {
                    ...ids,
                    ...rpcErrorFields(err.cause),
                });
            } else {
                d.log.error("deposit move step failed, retrying next tick", { ...ids, err });
            }
        }
    }
    return tick;
}

async function advanceOne(
    d: MoveDeps,
    id: number,
    tick: MoveTick,
    proofUntilMs: number,
): Promise<void> {
    const move = await findMove(d.pool, id);
    if (move === null || !IN_FLIGHT.has(move.state)) return;
    if (move.state === "pending") {
        await signPending(d, move, tick);
        return;
    }
    await checkInFlight(d, move, tick, proofUntilMs);
}

async function loadLedger(d: MoveDeps, orderId: string) {
    const ledger = await depositLedger(d.pool, orderId);
    if (ledger === null) throw new Error(`no deposit for ${orderId}`);
    return ledger;
}

async function signPending(d: MoveDeps, move: MoveRow, tick: MoveTick): Promise<void> {
    if (move.kind === "return" && !(await destinationValid(d, move))) {
        if (await dropInvalidReturn(d, move)) tick.dropped++;
        return;
    }
    const ledger = await loadLedger(d, move.orderId);
    const result = await signMove(d, ledger.deposit, move, ledger);
    if (result === "signed") tick.signed++;
    if (result === "dropped") tick.dropped++;
}

// Spec 11.2 step 1: a return goes back only to an initialized USDC account its sender owns
async function destinationValid(d: MoveDeps, move: MoveRow): Promise<boolean> {
    const { destination, payer } = move;
    if (destination === null || payer === null || !isAddress(destination)) return false;
    return viaRpc(() => ownedUsdcAccount(d.rpc, destination, payer, d.rpcTimeoutMs));
}

// Only the returned group goes to review; kept and held transfers riding along are freed for
// the next closing move, which carries them as before
async function dropInvalidReturn(d: MoveDeps, move: MoveRow): Promise<boolean> {
    const signatures = await withTx(
        d.pool,
        async (c) => {
            await lockDeposit(c, move.orderId);
            // The returned group is the money owed back, as the planner counts it: kept dust
            // and held review money of the same account only rode along
            const carried = await c.query<{ signature: string; source_token_account: string }>(
                `select signature, source_token_account from deposit_transfers
                 where order_id = $1 and move_id = $2
                    and (outcome = 'return'
                        or (outcome = 'paid' and reason is distinct from 'below_minimum'))
                 order by slot, seq`,
                [move.orderId, move.id],
            );
            if (!(await deletePendingMove(c, move.id))) return null;
            const group = carried.rows
                .filter((t) => t.source_token_account === move.destination)
                .map((t) => t.signature);
            await setTransferOutcomes(
                c,
                move.orderId,
                group.map((signature) => ({
                    signature,
                    outcome: "review" as const,
                    reason: "return_destination_invalid" as const,
                })),
            );
            return group;
        },
        d.log,
    );
    if (signatures === null) return false;
    d.log.alarm("deposit_review", {
        orderId: move.orderId,
        moveId: move.id,
        signatures,
        reason: "return_destination_invalid",
    });
    return true;
}

/**
 * Guard, pinned blockhash, then one transaction that locks in the spec 7 order (payment and order
 * first for a sweep), checks the row is still what was read, stores the signed move and, for a
 * sweep, moves the payments row to it. The send after COMMIT is pinned to the guard read.
 */
async function signMove(
    d: MoveDeps,
    deposit: DepositRow,
    move: MoveRow,
    ledger: Ledger,
): Promise<"signed" | "wait" | "dropped"> {
    let guardSlot = 0n;
    if (move.kind !== "create") {
        const guard = await guardRead(d, deposit, move, ledger);
        if (guard.verdict === "dropped") return "dropped";
        if (guard.verdict === "below_ledger") {
            d.log.info("deposit guard read is below the ledger, waiting for the scan", {
                orderId: move.orderId,
                moveId: move.id,
                slot: guard.slot,
                micros: guard.micros,
            });
            return "wait";
        }
        guardSlot = guard.slot;
    }
    const hint = await viaRpc(() => pinnedBlockhash(d, guardSlot));
    const owner =
        move.kind === "create"
            ? null
            : await d.keys.signer(move.orderId, deposit.salt, deposit.keyVersion);
    const signed = await buildMoveTransaction(
        d,
        move,
        { owner, address: address(deposit.address) },
        hint,
    );
    const stored = await withTx(
        d.pool,
        async (c) => {
            if (move.kind === "sweep") {
                await lockPayment(c, move.orderId);
                await lockOrder(c, move.orderId);
            }
            await lockDeposit(c, move.orderId);
            const current = await lockMove(c, move.id);
            if (
                current === null ||
                current.state !== move.state ||
                current.txSignature !== move.txSignature
            ) {
                return null;
            }
            // The same move under the same blockhash is the same transaction
            const twin = await c.query(
                `select 1 from deposit_moves
                 where tx_signature = $1 or $1 = any(previous_signatures)`,
                [signed.signature],
            );
            if (twin.rowCount !== 0) {
                d.log.info("identical deposit move already stored, signing on a later blockhash", {
                    orderId: move.orderId,
                    moveId: move.id,
                });
                return null;
            }
            // A new attempt clears expiry_seen_slot so its own proof pins its own expiry
            await c.query(
                `update deposit_moves set state = 'signed', wire_tx = $2, tx_signature = $3,
                    last_valid_block_height = $4, signed_at = $5, sent_at = null,
                    attempts = attempts + 1, expiry_seen_slot = null,
                    previous_signatures = case when tx_signature is null then previous_signatures
                        else array_append(previous_signatures, tx_signature) end
                 where id = $1`,
                [
                    move.id,
                    signed.wire,
                    signed.signature,
                    signed.lastValidBlockHeight.toString(),
                    d.now(),
                ],
            );
            const updated = (await lockMove(c, move.id))!;
            if (move.kind === "sweep") await d.onSweepSigned(c, updated, signed);
            return updated;
        },
        d.log,
    );
    if (stored === null) return "wait";
    const pin = guardSlot > signed.contextSlot ? guardSlot : signed.contextSlot;
    await sendMove(d, stored, signed.wire, FRESH_SEND, pin);
    return "signed";
}

function refusedAtPreflight(err: unknown): boolean {
    if (
        !isSolanaError(err, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
    ) {
        return false;
    }
    const cause: unknown = err.cause;
    if (!isSolanaError(cause)) return false;
    const code = Number(cause.context.__code);
    return code >= SOLANA_ERROR__INSTRUCTION_ERROR__UNKNOWN && code < 4_616_000;
}

/**
 * A simulation error naming an instruction was probably not forwarded, so the move is never
 * resent; its landing proof, not this mark, decides whether a fee counts (spec 11.2). A
 * BlockhashNotFound or any other send error leaves the row for the next check.
 */
export async function sendMove(
    d: Pick<MoveDeps, "pool" | "rpc" | "rpcTimeoutMs" | "log" | "now">,
    move: Pick<MoveRow, "id" | "orderId" | "txSignature">,
    wire: string,
    config: typeof FRESH_SEND | typeof RESEND,
    minContextSlot?: bigint,
): Promise<boolean> {
    const ids = { orderId: move.orderId, moveId: move.id, signature: move.txSignature };
    const now = d.now();
    try {
        const answered = await d.rpc
            .sendTransaction(
                wire as Base64EncodedWireTransaction,
                minContextSlot === undefined ? config : { ...config, minContextSlot },
            )
            .send(deadline(d.rpcTimeoutMs));
        if (answered !== move.txSignature) {
            d.log.warn("rpc answered another signature", { ...ids, answered });
        }
    } catch (err) {
        if (refusedAtPreflight(err)) {
            await d.pool.query(
                `update deposit_moves set preflight_refused_at = coalesce(preflight_refused_at, $3)
                 where id = $1 and tx_signature = $2 and state = 'signed'`,
                [move.id, move.txSignature, now],
            );
            d.log.warn("deposit move refused at preflight, it is never resent", ids);
            return false;
        }
        d.log.warn("deposit move send failed, checking it next tick", {
            ...ids,
            ...rpcErrorFields(err),
        });
        return false;
    }
    await d.pool.query(
        `update deposit_moves set state = 'sent', sent_at = coalesce(sent_at, $3)
         where id = $1 and tx_signature = $2 and state in ('signed', 'sent')`,
        [move.id, move.txSignature, now],
    );
    return true;
}

async function checkInFlight(
    d: MoveDeps,
    move: MoveRow,
    tick: MoveTick,
    proofUntilMs: number,
): Promise<void> {
    // A scan listed one of its signatures as landed (spec 10.3), which no status read can undo
    if (move.landedSlot !== null) {
        const signature = await landedSignature(d, move);
        if (signature !== null) {
            const landed = { signature, slot: move.landedSlot };
            if (await confirmMove(d, move, landed)) tick.confirmed++;
            return;
        }
    }
    const now = d.now().getTime();
    const since = move.sentAt ?? move.signedAt;
    if (since === null || now - since.getTime() < d.cfg.move_check_after) return;
    const { txSignature, wireTx, lastValidBlockHeight } = move;
    if (txSignature === null || wireTx === null || lastValidBlockHeight === null) {
        throw new Error(`deposit move ${move.id} is ${move.state} without a stored transaction`);
    }
    // An earlier attempt can still land after a re-sign, and then this move is done already
    const read = await viaRpc(() =>
        readLanding(
            d.rpc,
            txSignature,
            lastValidBlockHeight,
            d.rpcTimeoutMs,
            move.previousSignatures,
        ),
    );
    switch (read.landing) {
        case "processed":
            return;
        case "landed": {
            const landed = { signature: read.signature, slot: read.slot };
            if (await confirmMove(d, move, landed)) tick.confirmed++;
            return;
        }
        case "onchain_failed":
            if (await failMove(d, move, "onchain")) tick.failed++;
            return;
        case "not_found":
            if (move.preflightRefusedAt !== null) return;
            if (now - since.getTime() < d.cfg.resend_after) return;
            if (await sendMove(d, move, wireTx, RESEND)) tick.resent++;
            return;
        case "blockhash_expired":
            await expired(d, move, read.slot, tick, proofUntilMs);
            return;
    }
}

async function expired(
    d: MoveDeps,
    move: MoveRow,
    slot: bigint,
    tick: MoveTick,
    proofUntilMs: number,
): Promise<void> {
    let current = move;
    if (move.expirySeenSlot === null) {
        await d.pool.query(
            `update deposit_moves set expiry_seen_slot = $3
             where id = $1 and tx_signature = $2 and expiry_seen_slot is null`,
            [move.id, move.txSignature, slot.toString()],
        );
        current = { ...move, expirySeenSlot: slot };
    }
    const deposit = await findDeposit(d.pool, move.orderId);
    if (deposit === null) throw new Error(`no deposit for ${move.orderId}`);
    const proof = await proveAbsent(d, deposit, current, proofUntilMs);
    if (proof.kind === "wait") {
        tick.waitingProof++;
        return;
    }
    proofScansOf(d.pool).delete(move.id);
    if (proof.kind === "landed") {
        const landed = { signature: proof.signature, slot: proof.slot };
        if (await confirmMove(d, current, landed)) tick.confirmed++;
        return;
    }
    if (current.preflightRefusedAt !== null) {
        if (await failMove(d, current, "refused")) tick.failed++;
        return;
    }
    if (current.attempts >= d.cfg.max_attempts) {
        if (current.kind === "sweep") {
            if (await sweepToManual(d, current)) tick.manual++;
        } else if (await failMove(d, current, "expired")) {
            tick.failed++;
        }
        return;
    }
    const ledger = await loadLedger(d, move.orderId);
    const result = await signMove(d, ledger.deposit, current, ledger);
    if (result === "signed") tick.resigned++;
    // A signed row cannot be deleted; it never landed, so it fails like a closing move that lost
    // the race, and the planner plans again from a fresh read
    if (result === "dropped" && (await failMove(d, current, "race"))) tick.failed++;
}

async function viaScan<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (err) {
        const timedOut =
            err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (isSolanaError(err) || timedOut)
            throw new RpcUnavailable("rpc call failed", { cause: err });
        throw err;
    }
}

/**
 * Spec 11.2: a balance read pinned to expiry_seen_slot that equals the ledger with this move not
 * landed, and a history scan through that slot that finds none of its signatures. A deposit can
 * hold several senders' money, so a node that answers null for a transaction that did land must
 * never be enough to pay twice. A signature the scan finds landed confirms the move instead. The
 * balance is judged at the read the scan was pinned to, the newest moment its listing proves.
 * Each proof makes at least one scan call a tick, and goes on past it only until proofUntilMs;
 * an unfinished scan keeps its listing and its read for the next tick.
 */
async function proveAbsent(
    d: MoveDeps,
    deposit: DepositRow,
    move: MoveRow,
    proofUntilMs: number,
): Promise<Proof> {
    const scans = proofScansOf(d.pool);
    let p = scans.get(move.id);
    if (p === undefined || p.signature !== move.txSignature) {
        const anchor =
            deposit.checkedSlot === null
                ? null
                : { slot: deposit.checkedSlot, micros: deposit.balanceMicros };
        p = {
            orderId: move.orderId,
            signature: move.txSignature,
            trail: new ReadTrail(anchor),
            readAgain: true,
        };
        scans.set(move.id, p);
    }
    const { trail } = p;
    if (p.readAgain) {
        const read = (
            await viaRpc(() =>
                readDepositBalances(d.rpc, [address(deposit.tokenAccount)], {
                    timeoutMs: d.rpcTimeoutMs,
                    minContextSlot: move.expirySeenSlot ?? 0n,
                }),
            )
        ).get(deposit.tokenAccount)!;
        trail.push(read);
        p.readAgain = trail.latest() === null;
    }
    if (trail.latest() === null) return { kind: "wait" };
    const scanDeps: ScanDeps = {
        pool: d.pool,
        rpc: d.rpc,
        rpcTimeoutMs: d.rpcTimeoutMs,
        cfg: d.cfg,
        cache: d.cache,
        log: d.log,
        now: d.now,
    };
    let step = await viaScan(() => scanStep(scanDeps, deposit, trail));
    while (!step.done) {
        if (d.now().getTime() >= proofUntilMs) return { kind: "wait" };
        step = await viaScan(() => scanStep(scanDeps, deposit, trail));
    }
    const { result } = step;
    p.readAgain = result.complete;
    const ledger = await loadLedger(d, deposit.orderId);
    const scanned = ledger.moves.find((m) => m.id === move.id);
    if (scanned === undefined) return { kind: "wait" };
    if (scanned.landedSlot !== null) {
        const signature = await landedSignature(d, scanned);
        if (signature === null) return { kind: "wait" };
        return { kind: "landed", signature, slot: scanned.landedSlot };
    }
    if (!result.complete) return { kind: "wait" };
    const { read } = result;
    const expected = expectedBalanceAt(ledger.transfers, ledger.moves, read.contextSlot);
    return read.micros === expected ? { kind: "absent" } : { kind: "wait" };
}

// The scan marks the move landed, not which of its attempts did
async function landedSignature(d: MoveDeps, move: MoveRow): Promise<string | null> {
    const signatures = [move.txSignature, ...move.previousSignatures].filter(
        (s): s is string => s !== null,
    );
    if (signatures.length === 1) return signatures[0]!;
    for (const signature of signatures) {
        const tx = await viaRpc(() =>
            fetchTx(d.rpc, d.cache, signature, move.landedSlot!, d.rpcTimeoutMs),
        );
        if (tx !== null && !tx.noMeta && !tx.failed) return signature;
    }
    return null;
}

// The row is still the attempt that was read, signed or sent and not yet decided
async function lockSent(c: pg.PoolClient, move: MoveRow): Promise<MoveRow | null> {
    if (move.kind === "sweep") {
        await lockPayment(c, move.orderId);
        await lockOrder(c, move.orderId);
    }
    await lockDeposit(c, move.orderId);
    const current = await lockMove(c, move.id);
    if (current === null || !SENT.has(current.state)) return null;
    return current.txSignature === move.txSignature ? current : null;
}

/**
 * landed_slot is set only here and by the scan, from a successful landing. tx_signature names
 * the attempt that moved the money and the others stay in previous_signatures. A landing clears
 * preflight_refused_at, so its fee counts. A create sets rent_payer to the fee payer only when its
 * own meta shows it made the account; otherwise a sender's transaction did, and the scan finds it.
 * A landed close forgets rent_payer at once, as confirmSweep does: whoever opens the account
 * before the next read is then found as its creator and gets its own rent back (spec 5, 6.7).
 */
async function confirmMove(d: MoveDeps, move: MoveRow, landed: Landed): Promise<boolean> {
    let madeAccount = false;
    if (move.kind === "create") {
        const deposit = await findDeposit(d.pool, move.orderId);
        if (deposit === null) throw new Error(`no deposit for ${move.orderId}`);
        const tx = await viaRpc(() =>
            fetchTx(d.rpc, d.cache, landed.signature, landed.slot, d.rpcTimeoutMs),
        );
        madeAccount = tx !== null && createdBy(tx, deposit.tokenAccount) !== null;
    }
    const now = d.now();
    return await withTx(
        d.pool,
        async (c) => {
            const current = await lockSent(c, move);
            if (current === null) return false;
            if (move.kind === "sweep") {
                await c.query(
                    "update deposit_moves set preflight_refused_at = null where id = $1",
                    [move.id],
                );
                await d.confirmSweep(c, { ...current, preflightRefusedAt: null }, landed);
                return true;
            }
            await c.query(
                `update deposit_moves set state = 'confirmed', confirmed_at = $2, landed_slot = $3,
                    preflight_refused_at = null, tx_signature = $4,
                    previous_signatures = case when tx_signature = $4 then previous_signatures
                        else array_append(array_remove(previous_signatures, $4), tx_signature) end
                 where id = $1`,
                [move.id, now, landed.slot.toString(), landed.signature],
            );
            if (move.kind === "create") {
                await c.query(
                    `update deposits set ready_at = coalesce(ready_at, $2),
                        rent_payer = case when $3::boolean and rent_payer is null then $4
                            else rent_payer end
                     where order_id = $1`,
                    [move.orderId, now, madeAccount, d.feePayer.address],
                );
            }
            if (current.closes) {
                await updateDeposit(c, move.orderId, {
                    state: "closed",
                    closedAt: now,
                    watchUntil: new Date(now.getTime() + d.cfg.watch_after_close),
                    rentPayer: null,
                });
            }
            return true;
        },
        d.log,
    );
}

/**
 * A failed move keeps no landing slot. A move that carried CloseAccount makes the planner close
 * separately, or for a `close` backs off by close_retry_after; close failures never review. A
 * move refused at preflight keeps preflight_refused_at only when it is proven never to have
 * landed, so its fee is not counted (spec 11.4).
 */
async function failMove(d: MoveDeps, move: MoveRow, cause: FailCause): Promise<boolean> {
    const now = d.now();
    return await withTx(
        d.pool,
        async (c) => {
            const current = await lockSent(c, move);
            if (current === null) return false;
            await c.query(
                `update deposit_moves set state = 'failed', failed_at = $2,
                    preflight_refused_at = case when $3::boolean then preflight_refused_at end
                 where id = $1`,
                [move.id, now, cause === "refused"],
            );
            if (!current.closes) return true;
            if (current.kind !== "close") {
                await updateDeposit(c, move.orderId, { closeSeparately: true });
                return true;
            }
            const deposit = await lockDeposit(c, move.orderId);
            const failures = (deposit?.closeFailures ?? 0) + 1;
            const delays = d.cfg.close_retry_after;
            const delay = delays[Math.min(failures, delays.length) - 1]!;
            await updateDeposit(c, move.orderId, {
                closeFailures: failures,
                closeAfter: new Date(now.getTime() + delay),
            });
            return true;
        },
        d.log,
    );
}

// The money stays safe in the deposit while a person looks; the order stays settling (spec 10.4)
async function sweepToManual(d: MoveDeps, move: MoveRow): Promise<boolean> {
    const done = await withTx(
        d.pool,
        async (c) => {
            const current = await lockSent(c, move);
            if (current === null) return false;
            await c.query(
                `update deposit_moves set state = 'manual', manual_reason = 'move_expired_repeatedly'
                 where id = $1`,
                [move.id],
            );
            await updateDeposit(c, move.orderId, { reviewReason: "move_expired_repeatedly" });
            return true;
        },
        d.log,
    );
    if (done) {
        d.log.alarm("deposit_review", {
            orderId: move.orderId,
            moveId: move.id,
            reason: "move_expired_repeatedly",
        });
    }
    return done;
}
