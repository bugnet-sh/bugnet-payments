import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { newOrderId } from "../orders/ids.ts";
import { findOrder } from "../orders/store.ts";
import { base32Lower, newX402PaymentId, serviceIdFor } from "../x402/ids.ts";
import { toFunding } from "../x402/funding.ts";
import { findAccount } from "../x402/ledger.ts";
import type { AccountRow, FundingRow, ServiceRow, X402PaymentRow } from "../x402/types.ts";
import { seedOrder, seedPayment } from "./orders.ts";

export const TEST_PAYTO = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
export const TEST_HANDLE_SHA256 = "ab".repeat(32);

export async function seedAccount(
    pool: pg.Pool,
    over: Partial<AccountRow> = {},
): Promise<AccountRow> {
    const id = over.id ?? newOrderId();
    if (!(await findOrder(pool, id))) {
        await seedOrder(pool, {
            id,
            kind: "start",
            state: "redeemed",
            packageId: "cpu-small",
            amountMicros: 1_013_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            payInto: "allowance",
        });
    }
    const a: AccountRow = {
        id,
        handleSha256: TEST_HANDLE_SHA256,
        placementId: null,
        packageId: "cpu-small",
        state: "open",
        fundedMicros: 0,
        spentMicros: 0,
        heldMicros: 0,
        refundedMicros: 0,
        keptMicros: 0,
        keptColdTransferId: null,
        spendPerMinuteMicros: 500_000,
        minuteStart: new Date(),
        minuteMicros: 0,
        deadline: null,
        closeCheckFailingSince: null,
        createdAt: new Date(),
        closingAt: null,
        closedAt: null,
        ...over,
    };
    await pool.query(
        `insert into x402_accounts (id, handle_sha256, placement_id, package_id, state,
            funded_micros, spent_micros, held_micros, refunded_micros, kept_micros,
            kept_cold_transfer_id, spend_per_minute_micros, minute_start, minute_micros, deadline,
            close_check_failing_since, created_at, closing_at, closed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19)`,
        [
            a.id,
            a.handleSha256,
            a.placementId,
            a.packageId,
            a.state,
            a.fundedMicros,
            a.spentMicros,
            a.heldMicros,
            a.refundedMicros,
            a.keptMicros,
            a.keptColdTransferId,
            a.spendPerMinuteMicros,
            a.minuteStart,
            a.minuteMicros,
            a.deadline,
            a.closeCheckFailingSince,
            a.createdAt,
            a.closingAt,
            a.closedAt,
        ],
    );
    return (await findAccount(pool, id))!;
}

export async function seedFunding(
    pool: pg.Pool,
    over: Partial<FundingRow> & { accountId: string },
): Promise<FundingRow> {
    const account = (await findAccount(pool, over.accountId))!;
    const f: FundingRow = {
        orderId: "",
        allowanceMicros: 1_000_000,
        feeCreditedMicros: 0,
        payer: "payer-test",
        sourceTokenAccount: "source-test",
        createdAt: new Date(),
        voidedAt: null,
        ...over,
    };
    let order = over.orderId ? await findOrder(pool, over.orderId) : null;
    if (!order) {
        order = (
            await seedOrder(pool, {
                ...(over.orderId ? { id: over.orderId } : {}),
                kind: "allowance",
                state: "redeemed",
                packageId: "x402-allowance",
                handleSha256: account.handleSha256 ?? TEST_HANDLE_SHA256,
                amountMicros: f.allowanceMicros,
                allowanceMicros: f.allowanceMicros,
                feeMicros: 0,
                payInto: "allowance",
            })
        ).order;
    }
    f.orderId = order.id;
    const paid = await pool.query("select 1 from payments where order_id = $1", [order.id]);
    if (paid.rows.length === 0) {
        await seedPayment(pool, order.id, {
            status: "confirmed",
            payer: f.payer,
            sourceTokenAccount: f.sourceTokenAccount,
        });
    }
    const res = await pool.query(
        `insert into x402_fundings (order_id, account_id, allowance_micros, fee_credited_micros,
            payer, source_token_account, created_at, voided_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [
            f.orderId,
            f.accountId,
            f.allowanceMicros,
            f.feeCreditedMicros,
            f.payer,
            f.sourceTokenAccount,
            f.createdAt,
            f.voidedAt,
        ],
    );
    if (f.voidedAt === null) {
        await pool.query(
            "update x402_accounts set funded_micros = funded_micros + $2 where id = $1",
            [f.accountId, f.allowanceMicros],
        );
    }
    return toFunding(res.rows[0]);
}

export async function seedService(
    pool: pg.Pool,
    over: Partial<ServiceRow> & { accountId: string },
): Promise<ServiceRow> {
    const s: ServiceRow = {
        serviceId: serviceIdFor("POST", "agent402.tools", "/v1/auto/"),
        method: "POST",
        host: "agent402.tools",
        prefix: "/v1/auto/",
        url: "https://agent402.tools/v1/auto/chat/completions",
        maxPriceMicros: 10_000,
        payTo: TEST_PAYTO,
        listed: "indexed",
        paidPath: null,
        pinnedFrom: "probe",
        probe: { at: "2030-01-01T00:00:00.000Z", status: 402, accepted: null },
        orderId: over.accountId,
        state: "enabled",
        failures: 0,
        updatedAt: new Date(),
        ...over,
    };
    await pool.query(
        `insert into x402_services (account_id, service_id, method, host, prefix, url,
            max_price_micros, pay_to, listed, paid_path, pinned_from, probe, order_id, state,
            failures, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16)`,
        [
            s.accountId,
            s.serviceId,
            s.method,
            s.host,
            s.prefix,
            s.url,
            s.maxPriceMicros,
            s.payTo,
            s.listed,
            s.paidPath,
            s.pinnedFrom,
            JSON.stringify(s.probe),
            s.orderId,
            s.state,
            s.failures,
            s.updatedAt,
        ],
    );
    return s;
}

export async function seedX402Payment(
    pool: pg.Pool,
    over: Partial<X402PaymentRow> & { accountId: string },
): Promise<X402PaymentRow> {
    const p: X402PaymentRow = {
        id: newX402PaymentId(),
        ref: base32Lower(randomBytes(10)),
        serviceId: serviceIdFor("POST", "agent402.tools", "/v1/auto/"),
        placementId: randomUUID(),
        method: "POST",
        host: "agent402.tools",
        path: "/v1/auto/chat/completions",
        targetSha256: Buffer.alloc(32),
        bodySha256: Buffer.alloc(32),
        amountMicros: 10_000,
        payTo: TEST_PAYTO,
        payToTokenAccount: TEST_PAYTO,
        feePayer: TEST_PAYTO,
        listed: "indexed",
        capDay: "2030-01-01",
        state: "confirmed",
        blockhash: null,
        lastValidBlockHeight: null,
        signingSlot: null,
        memo: null,
        computeUnitLimit: null,
        computeUnitPriceMicroLamports: null,
        acceptedJson: null,
        messageHash: null,
        ourSignatureSha256: null,
        paymentIdentifier: null,
        keepUntil: null,
        landedSlot: null,
        expirySeenSlot: null,
        txSignature: null,
        lateLanded: false,
        hint: null,
        hintTx: null,
        hintError: null,
        httpStatus: null,
        streamCut: false,
        endedClean: false,
        createdAt: new Date(),
        signedAt: null,
        resolvedAt: null,
        ...over,
    };
    await pool.query(
        `insert into x402_payments (id, ref, account_id, service_id, placement_id, method, host,
            path, target_sha256, body_sha256, amount_micros, pay_to, pay_to_token_account,
            fee_payer, listed, cap_day, state, blockhash, last_valid_block_height, signing_slot,
            memo, compute_unit_limit, compute_unit_price_microlamports, accepted_json,
            message_hash, our_signature_sha256, payment_identifier, keep_until, landed_slot,
            expiry_seen_slot, tx_signature, late_landed, hint, hint_tx, hint_error, http_status,
            stream_cut, ended_clean, created_at, signed_at, resolved_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35,
            $36, $37, $38, $39, $40, $41)`,
        [
            p.id,
            p.ref,
            p.accountId,
            p.serviceId,
            p.placementId,
            p.method,
            p.host,
            p.path,
            p.targetSha256,
            p.bodySha256,
            p.amountMicros,
            p.payTo,
            p.payToTokenAccount,
            p.feePayer,
            p.listed,
            p.capDay,
            p.state,
            p.blockhash,
            p.lastValidBlockHeight?.toString() ?? null,
            p.signingSlot?.toString() ?? null,
            p.memo,
            p.computeUnitLimit,
            p.computeUnitPriceMicroLamports?.toString() ?? null,
            p.acceptedJson,
            p.messageHash,
            p.ourSignatureSha256,
            p.paymentIdentifier,
            p.keepUntil,
            p.landedSlot?.toString() ?? null,
            p.expirySeenSlot?.toString() ?? null,
            p.txSignature,
            p.lateLanded,
            p.hint,
            p.hintTx,
            p.hintError,
            p.httpStatus,
            p.streamCut,
            p.endedClean,
            p.createdAt,
            p.signedAt,
            p.resolvedAt,
        ],
    );
    return p;
}

export async function resetLedger(pool: pg.Pool): Promise<void> {
    await pool.query("truncate orders, events cascade");
    await pool.query("update x402_pool set committed_micros = 0, unpaid_micros = 0 where id = 1");
    await pool.query(
        `update x402_controls set disabled = false, paused = false, refunds_held = false,
            reason = null, changed_at = null where id = 1`,
    );
}
