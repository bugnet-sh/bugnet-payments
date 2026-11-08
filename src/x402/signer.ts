import { createHash } from "node:crypto";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { address, type Address, type KeyPairSigner } from "@solana/kit";
import type pg from "pg";
import type { Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import {
    SellerHint,
    X402SignerService,
    type ReportOutcomeRequest,
    type ReportOutcomeResponseSchema,
    type ReserveAndSignRequest,
    type ReserveAndSignResponseSchema,
} from "../gen/bugnet/payments/v1/x402_pb.ts";
import type { Log } from "../log.ts";
import type { RouterClient } from "../router/client.ts";
import { usdcAta } from "../solana/accounts.ts";
import { isCanonicalSignature } from "../solana/base58.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import {
    buildSellerPayment,
    randomSellerMemo,
    signSellerPayment,
    type SellerPaymentParts,
} from "./build.ts";
import { blockedAmong, readControls } from "./controls.ts";
import { newPaymentIdentifier, newX402PaymentId, REF, SERVICE_ID } from "./ids.ts";
import { findAccount, leftMicros, storePlacement } from "./ledger.ts";
import {
    findX402Payment,
    releaseReserved,
    reserve,
    toX402Payment,
    X402_PAYMENT_COLUMNS,
} from "./reserve.ts";
import {
    chooseEntry,
    decodeChallenge,
    type AcceptedEntry,
    type DecodedChallenge,
    type SellerRules,
} from "./seller.ts";
import type {
    BugnetAddresses,
    SellerHintText,
    ServiceRow,
    SignerRefusal,
    X402PaymentRow,
} from "./types.ts";

export interface SignerDeps {
    pool: pg.Pool;
    rpc: SolanaRpc;
    allowance: KeyPairSigner;
    hotTokenAccount: Address;
    x402: Settings["x402"];
    addresses: BugnetAddresses;
    router: RouterClient;
    log: Log;
    now: () => Date;
    wakeFastPass: () => void;
    hooks?: {
        afterCommit?: () => Promise<void>;
        beforeSign?: (paymentId: string) => Promise<void>;
    };
}

type Answer = MessageInitShape<typeof ReserveAndSignResponseSchema>;

interface PaymentIdentifierPart {
    id: string;
    required: unknown;
    schema: unknown;
}

const PAYMENT_IDENTIFIER = "payment-identifier";
const HINT_ERROR = /^[a-z_]{1,64}$/;
const HINT_TEXT: Partial<Record<SellerHint, SellerHintText>> = {
    [SellerHint.SUCCESS]: "success",
    [SellerHint.FAILURE]: "failure",
    [SellerHint.ABSENT]: "absent",
    [SellerHint.REJECTED]: "rejected",
};
const SIGNATURE_UNIQUE_CONSTRAINTS = [
    "x402_payments_message_hash_key",
    "x402_payments_our_signature_sha256_key",
];

class SigningAbandoned extends Error {}

function sha256(b: Uint8Array): Buffer {
    return createHash("sha256").update(b).digest();
}

export function paymentSignatureHeader(p: {
    resourceJson: string;
    acceptedJson: string;
    wireBase64: string;
    paymentIdentifier: PaymentIdentifierPart | null;
}): string {
    const identifier = p.paymentIdentifier;
    const text =
        `{"x402Version":2,"resource":${p.resourceJson},"accepted":${p.acceptedJson},` +
        `"payload":{"transaction":${JSON.stringify(p.wireBase64)}}` +
        (identifier === null
            ? ""
            : `,"extensions":{"${PAYMENT_IDENTIFIER}":{"info":{"required":${JSON.stringify(identifier.required)},"id":${JSON.stringify(identifier.id)}},"schema":${JSON.stringify(identifier.schema)}}}`) +
        "}";
    return Buffer.from(text, "utf8").toString("base64");
}

export function refConflictError(): ConnectError {
    const value = new BinaryWriter()
        .tag(1, WireType.LengthDelimited)
        .string("REF_CONFLICT")
        .tag(2, WireType.LengthDelimited)
        .string("bugnet.payments")
        .finish();
    const err = new ConnectError("ref conflict", Code.FailedPrecondition);
    err.details.push({ type: "google.rpc.ErrorInfo", value });
    return err;
}

// The 402's payment-identifier offer, or null when it offers none
function offeredIdentifier(
    extensions: Record<string, unknown> | null,
): { required: boolean; schema: unknown } | null {
    const offer = extensions?.[PAYMENT_IDENTIFIER];
    if (typeof offer !== "object" || offer === null || Array.isArray(offer)) return null;
    const { info, schema } = offer as { info?: unknown; schema?: unknown };
    const required =
        typeof info === "object" && info !== null && (info as { required?: unknown }).required;
    return { required: required === true, schema: schema ?? {} };
}

function partsOf(row: X402PaymentRow, d: SignerDeps): SellerPaymentParts {
    return {
        feePayer: address(row.feePayer),
        hotTokenAccount: d.hotTokenAccount,
        destination: address(row.payToTokenAccount),
        authority: d.allowance.address,
        amount: BigInt(row.amountMicros),
        memo: row.memo!,
        computeUnitLimit: row.computeUnitLimit!,
        computeUnitPriceMicroLamports: row.computeUnitPriceMicroLamports!,
        blockhash: row.blockhash!,
        lastValidBlockHeight: row.lastValidBlockHeight!,
    };
}

// The wire transaction of a stored row, only when it hashes to the signature hash stored with it
async function resign(row: X402PaymentRow, d: SignerDeps): Promise<string | null> {
    if (row.ourSignatureSha256 === null || row.memo === null || row.acceptedJson === null) {
        return null;
    }
    const signed = await signSellerPayment(buildSellerPayment(partsOf(row, d)), d.allowance);
    return sha256(signed.signature).equals(row.ourSignatureSha256) ? signed.wireBase64 : null;
}

function headerOfRow(row: X402PaymentRow, wireBase64: string, c: DecodedChallenge): string {
    const offer = offeredIdentifier(c.extensions);
    return paymentSignatureHeader({
        resourceJson: c.resourceJson,
        acceptedJson: row.acceptedJson!,
        wireBase64,
        paymentIdentifier:
            offer !== null && row.paymentIdentifier !== null
                ? { id: row.paymentIdentifier, required: offer.required, schema: offer.schema }
                : null,
    });
}

function validRequest(req: ReserveAndSignRequest): boolean {
    return (
        REF.test(req.ref) &&
        SERVICE_ID.test(req.serviceId) &&
        (req.method === "GET" || req.method === "POST") &&
        req.bodySha256.length === 32 &&
        req.targetSha256.length === 32
    );
}

function sameRequest(row: X402PaymentRow, req: ReserveAndSignRequest): boolean {
    return (
        row.serviceId === req.serviceId &&
        row.method === req.method &&
        row.host === req.host &&
        row.path === req.path &&
        row.targetSha256.equals(req.targetSha256) &&
        row.bodySha256.equals(req.bodySha256)
    );
}

export async function reserveAndSign(d: SignerDeps, req: ReserveAndSignRequest): Promise<Answer> {
    if (!validRequest(req)) throw new ConnectError("bad request", Code.InvalidArgument);
    const { pool, x402, log } = d;
    let askedMicros = 0n;
    let maxMicros = 0n;
    let allowanceLeft = 0n;
    const refuse = (reason: SignerRefusal, left?: number): Answer => ({
        result: {
            case: "refused",
            value: {
                reason,
                askedMicros,
                maxMicros,
                allowanceLeftMicros: left === undefined ? allowanceLeft : BigInt(left),
            },
        },
    });
    const conflict = (row: X402PaymentRow, alarm: boolean): Answer => {
        if (alarm) log.alarm("x402_ref_conflict", { ref: req.ref, paymentId: row.id });
        return refuse("ref_conflict");
    };
    const signed = (
        row: Pick<X402PaymentRow, "id" | "amountMicros" | "payTo" | "ref">,
        header: string,
        keepUntil: Date,
        left: number,
        resend: boolean,
    ): Answer => {
        log.info("x402 signed", {
            paymentId: row.id,
            ref: req.ref,
            amountMicros: row.amountMicros,
            payTo: row.payTo,
            resend,
        });
        return {
            result: {
                case: "signed",
                value: {
                    paymentId: row.id,
                    paymentSignature: header,
                    amountMicros: BigInt(row.amountMicros),
                    payTo: row.payTo,
                    keepUntil: timestampFromDate(keepUntil),
                    allowanceLeftMicros: BigInt(left),
                    resend,
                    paymentRef: row.ref,
                },
            },
        };
    };
    const leftOf = async (accountId: string): Promise<number> => {
        const a = await findAccount(pool, accountId);
        return a ? leftMicros(a) : 0;
    };

    const controls = await readControls(pool);
    if (!x402.enabled || controls.disabled) return refuse("x402_disabled");
    if (controls.paused) return refuse("outflow_paused");

    const byRef = async (): Promise<X402PaymentRow | null> => {
        const same = await pool.query(
            `select ${X402_PAYMENT_COLUMNS} from x402_payments where ref = $1`,
            [req.ref],
        );
        return same.rows[0] ? toX402Payment(same.rows[0]) : null;
    };
    const answerExisting = async (existing: X402PaymentRow): Promise<Answer> => {
        if (!sameRequest(existing, req)) return conflict(existing, true);
        if (existing.state === "reserved") return refuse("payments_unavailable");
        if (existing.state !== "signed") return conflict(existing, false);
        const c = decodeChallenge(req.paymentRequired);
        if ("refusal" in c) return refuse(c.refusal);
        const wire = await resign(existing, d);
        if (wire === null) return conflict(existing, true);
        return signed(
            existing,
            headerOfRow(existing, wire, c),
            existing.keepUntil!,
            await leftOf(existing.accountId),
            false,
        );
    };
    const existing = await byRef();
    if (existing !== null) return answerExisting(existing);

    const account = await findAccount(pool, req.accountId);
    if (account === null) return refuse("service_not_enabled");
    allowanceLeft = BigInt(leftMicros(account));
    let placementId = account.placementId;
    if (placementId === null) {
        const found = await d.router.lookupPlacement(
            { startOrderId: account.id },
            AbortSignal.timeout(x402.lookup_timeout),
        );
        if (found.kind === "unavailable") return refuse("payments_unavailable");
        if (found.kind === "unknown") return refuse("service_not_enabled");
        await storePlacement(pool, account.id, {
            placementId: found.placementId,
            deadline: found.deadline,
        });
        placementId = found.placementId;
    }
    if (placementId !== req.placementId) return refuse("service_not_enabled");

    const serviceRes = await pool.query(
        `select pay_to, max_price_micros, listed, paid_path, state, method, host, prefix
         from x402_services where account_id = $1 and service_id = $2`,
        [account.id, req.serviceId],
    );
    const s = serviceRes.rows[0] as
        | (Pick<ServiceRow, "state" | "method" | "host" | "prefix" | "listed"> & {
              pay_to: string;
              max_price_micros: string;
              paid_path: string | null;
          })
        | undefined;
    if (
        !s ||
        s.state === "disabled" ||
        s.method !== req.method ||
        s.host !== req.host ||
        !(req.path + "/").startsWith(s.prefix)
    ) {
        return refuse("service_not_enabled");
    }
    maxMicros = BigInt(s.max_price_micros);
    if (s.paid_path !== null && s.paid_path !== req.path) return refuse("path_not_paid");
    if (s.state === "unreliable") return refuse("payee_unreliable");

    const c = decodeChallenge(req.paymentRequired);
    if ("refusal" in c) return refuse(c.refusal);
    const payTos = c.accepts.flatMap(({ value }) => {
        const p = (value as { payTo?: unknown } | null)?.payTo;
        return typeof p === "string" ? [p] : [];
    });
    const rules: SellerRules = {
        bugnet: d.addresses.all,
        sellerMemoMaxBytes: x402.seller_memo_max_bytes,
    };
    const choice = chooseEntry(
        c,
        {
            payTo: s.pay_to,
            maxPriceMicros: Number(s.max_price_micros),
            maxPricePerCallMicros: x402.max_price_per_call_micros,
            blocked: await blockedAmong(pool, payTos),
        },
        rules,
    );
    if (!choice.ok) {
        askedMicros = choice.askedMicros;
        return refuse(choice.code);
    }
    const { entry } = choice;
    askedMicros = entry.amountMicros;

    const open = await pool.query(
        `select ${X402_PAYMENT_COLUMNS} from x402_payments
         where placement_id = $1 and method = $2 and host = $3 and target_sha256 = $4
            and body_sha256 = $5 and state in ('signed', 'confirmed') and not ended_clean
            and last_valid_block_height >= (select finalized_height from x402_tail)
         order by created_at desc limit 1`,
        [req.placementId, req.method, req.host, req.targetSha256, req.bodySha256],
    );
    if (open.rows[0]) {
        const row = toX402Payment(open.rows[0]);
        const wire = await resign(row, d);
        if (wire === null) return conflict(row, true);
        return signed(
            row,
            headerOfRow(row, wire, c),
            row.keepUntil!,
            await leftOf(row.accountId),
            true,
        );
    }

    const id = newX402PaymentId();
    const now = d.now();
    let reserved;
    try {
        reserved = await reserve(
            pool,
            {
                id,
                ref: req.ref,
                accountId: account.id,
                placementId: req.placementId,
                serviceId: req.serviceId,
                method: req.method,
                host: req.host,
                path: req.path,
                targetSha256: Buffer.from(req.targetSha256),
                bodySha256: Buffer.from(req.bodySha256),
                amountMicros: Number(entry.amountMicros),
                payTo: entry.payTo,
                payToTokenAccount: await usdcAta(address(entry.payTo)),
                feePayer: entry.feePayer,
                listed: s.listed,
            },
            x402,
            log,
            now,
        );
    } catch (err) {
        // Another call with the same ref reserved between our ref lookup and our insert
        const e = err as { code?: string; constraint?: string };
        if (e.code !== "23505" || e.constraint !== "x402_payments_ref_key") throw err;
        const raced = await byRef();
        if (raced === null) throw err;
        return answerExisting(raced);
    }
    if (!reserved.ok) {
        // A call with the same ref may have taken the room this one was refused for
        const raced = await byRef();
        if (raced !== null) return answerExisting(raced);
        return refuse(reserved.reason, reserved.leftMicros);
    }

    const failed = async (reason: SignerRefusal): Promise<Answer> => {
        await releaseReserved(pool, id, d.now());
        return refuse(reason, await leftOf(account.id));
    };
    let outcome: { header: string; keepUntil: Date };
    try {
        const stored = await signAndStore(d, c, entry, id, now);
        if (stored.kind === "refused") return refuse(stored.reason, await leftOf(account.id));
        outcome = stored;
    } catch (err) {
        log.warn("x402 signing failed", {
            paymentId: id,
            err: err instanceof Error ? err.name : "unknown",
        });
        return failed("payments_unavailable");
    }
    // A throw here leaves the row signed: the answer is lost and the retry re-signs it
    await d.hooks?.afterCommit?.();
    return signed(
        { id, amountMicros: Number(entry.amountMicros), payTo: entry.payTo, ref: req.ref },
        outcome.header,
        outcome.keepUntil,
        reserved.leftMicros,
        false,
    );
}

type Stored =
    | { kind: "signed"; header: string; keepUntil: Date }
    | { kind: "refused"; reason: SignerRefusal };

// Steps 10 to 13: any throw lets the caller release the reservation
async function signAndStore(
    d: SignerDeps,
    c: DecodedChallenge,
    entry: AcceptedEntry,
    id: string,
    now: Date,
): Promise<Stored> {
    const { pool, x402 } = d;
    const signal = AbortSignal.timeout(x402.sign_timeout);
    const { context, value } = await d.rpc
        .getLatestBlockhash({ commitment: "confirmed" })
        .send({ abortSignal: signal });
    await d.hooks?.beforeSign?.(id);
    const memo = entry.memo !== null ? new TextEncoder().encode(entry.memo) : randomSellerMemo();
    const offer = offeredIdentifier(c.extensions);
    const identifier = offer === null ? null : newPaymentIdentifier();
    const keepUntil = new Date(now.getTime() + x402.signed_payload_keep);
    const payToTokenAccount = await usdcAta(address(entry.payTo));
    const ceiling = BigInt(x402.seller_compute_unit_price_max_micro_lamports);
    for (let price = BigInt(x402.seller_compute_unit_price_micro_lamports); ; price++) {
        if (price > ceiling) throw new SigningAbandoned("compute unit price ceiling reached");
        const s = await signSellerPayment(
            buildSellerPayment({
                feePayer: address(entry.feePayer),
                hotTokenAccount: d.hotTokenAccount,
                destination: payToTokenAccount,
                authority: d.allowance.address,
                amount: entry.amountMicros,
                memo,
                computeUnitLimit: x402.seller_compute_unit_limit,
                computeUnitPriceMicroLamports: price,
                blockhash: value.blockhash,
                lastValidBlockHeight: value.lastValidBlockHeight,
            }),
            d.allowance,
        );
        const taken = await pool.query("select 1 from x402_payments where message_hash = $1", [
            s.messageHash,
        ]);
        if (taken.rows.length > 0) continue;
        signal.throwIfAborted();
        let updated: number | null;
        try {
            const res = await pool.query(
                `update x402_payments set state = 'signed', blockhash = $2,
                    last_valid_block_height = $3, signing_slot = $4, memo = $5,
                    compute_unit_limit = $6, compute_unit_price_microlamports = $7,
                    accepted_json = $8, message_hash = $9, our_signature_sha256 = $10,
                    payment_identifier = $11, keep_until = $12, signed_at = $13
                 where id = $1 and state = 'reserved'
                    and not (select paused or disabled from x402_controls)`,
                [
                    id,
                    value.blockhash,
                    value.lastValidBlockHeight.toString(),
                    context.slot.toString(),
                    Buffer.from(memo),
                    x402.seller_compute_unit_limit,
                    price.toString(),
                    entry.json,
                    s.messageHash,
                    sha256(s.signature),
                    identifier,
                    keepUntil,
                    now,
                ],
            );
            updated = res.rowCount;
        } catch (err) {
            const e = err as { code?: string; constraint?: string };
            if (e.code === "23505" && SIGNATURE_UNIQUE_CONSTRAINTS.includes(e.constraint ?? "")) {
                continue;
            }
            throw err;
        }
        if (updated === 0) return { kind: "refused", reason: await whyNotSigned(d, id) };
        const header = paymentSignatureHeader({
            resourceJson: c.resourceJson,
            acceptedJson: entry.json,
            wireBase64: s.wireBase64,
            paymentIdentifier:
                offer !== null && identifier !== null
                    ? { id: identifier, required: offer.required, schema: offer.schema }
                    : null,
        });
        return { kind: "signed", header, keepUntil };
    }
}

// The row was not reserved any more, or a control was set while signing
async function whyNotSigned(d: SignerDeps, id: string): Promise<SignerRefusal> {
    const state = await d.pool.query<{ state: string }>(
        "select state from x402_payments where id = $1",
        [id],
    );
    if (state.rows[0]?.state !== "reserved") return "payments_unavailable";
    await releaseReserved(d.pool, id, d.now());
    const controls = await readControls(d.pool);
    return controls.disabled ? "x402_disabled" : "outflow_paused";
}

export async function reportOutcome(
    d: SignerDeps,
    req: ReportOutcomeRequest,
): Promise<MessageInitShape<typeof ReportOutcomeResponseSchema>> {
    const row = await findX402Payment(d.pool, req.paymentId);
    if (row === null) throw new ConnectError("payment unknown", Code.NotFound);
    if (req.ref !== row.ref) {
        d.log.alarm("x402_ref_conflict", { paymentId: row.id });
        throw refConflictError();
    }
    const hint = HINT_TEXT[req.hint] ?? null;
    const hintTx = isCanonicalSignature(req.hintTx) ? req.hintTx : null;
    const hintError = HINT_ERROR.test(req.hintError) ? req.hintError : null;
    const clean =
        req.httpStatus >= 200 && req.httpStatus <= 399 && hint === "success" && !req.streamCut;
    const at = d.now();
    const counts = !req.resend && (hint === "failure" || hint === "absent" || hint === "rejected");
    const unreliableNow = await withTx(
        d.pool,
        async (c) => {
            await c.query(
                `update x402_payments set hint = $2, http_status = $3, stream_cut = $4,
                    hint_tx = coalesce($5, hint_tx), hint_error = $6, ended_clean = ended_clean or $7
                 where id = $1`,
                [row.id, hint, req.httpStatus, req.streamCut, hintTx, hintError, clean],
            );
            if (!counts) return false;
            const res = await c.query<{ failures: number; state: string }>(
                `update x402_services set failures = failures + 1,
                    state = case when state = 'enabled' and failures + 1 >= $3
                        then 'unreliable' else state end,
                    updated_at = $4
                 where account_id = $1 and service_id = $2 returning failures, state`,
                [row.accountId, row.serviceId, d.x402.unreliable_after, at],
            );
            const s = res.rows[0];
            return s?.state === "unreliable" && s.failures === d.x402.unreliable_after;
        },
        d.log,
    );
    if (unreliableNow) {
        d.log.alarm("x402_payee_unreliable", { serviceId: row.serviceId, payTo: row.payTo });
    }
    if (hintTx !== null) d.wakeFastPass();
    const account = await findAccount(d.pool, row.accountId);
    return { allowanceLeftMicros: BigInt(account ? leftMicros(account) : 0) };
}

export function createSignerService(d: SignerDeps): Partial<ServiceImpl<typeof X402SignerService>> {
    return {
        reserveAndSign: (req) => reserveAndSign(d, req),
        reportOutcome: (req) => reportOutcome(d, req),
    };
}
