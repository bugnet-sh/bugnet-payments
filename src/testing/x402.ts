import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { newOrderId } from "../orders/ids.ts";
import { findOrder } from "../orders/store.ts";
import { base32Lower, newX402PaymentId, serviceIdFor } from "../x402/ids.ts";
import { toFunding } from "../x402/funding.ts";
import { findAccount } from "../x402/ledger.ts";
import type { AccountRow, FundingRow, ServiceRow, X402PaymentRow } from "../x402/types.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "../solana/constants.ts";
import { parseIndex, type IndexCopy } from "../x402/index-file.ts";
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

export function usdcAccountAnswer(
    owner: string,
    over: { programOwner?: string; mint?: string; state?: string } = {},
): unknown {
    return {
        value: {
            owner: over.programOwner ?? TOKEN_PROGRAM,
            data: {
                parsed: {
                    info: {
                        mint: over.mint ?? USDC_MINT,
                        owner,
                        state: over.state ?? "initialized",
                        tokenAmount: { amount: "0" },
                    },
                },
            },
        },
    };
}

export function testIndex(): IndexCopy {
    return parseIndex(
        JSON.stringify({
            v: 1,
            services: [
                {
                    method: "POST",
                    host: "agent402.tools",
                    prefix: "/v1/auto/",
                    url: "https://agent402.tools/v1/auto/chat/completions",
                    payTo: TEST_PAYTO,
                },
            ],
        }),
        "test index",
    );
}

// The PAYMENT-REQUIRED header of one real Solana exact seller, byte for byte; index 12 is its
// Solana USDC entry
export const RECORDED_402 = {
    header: "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9hZ2VudDQwMi50b29scy92MS9hdXRvL2NoYXQvY29tcGxldGlvbnMiLCJkZXNjcmlwdGlvbiI6Ik9wZW5BSS1jb21wYXRpYmxlIGNoYXQgY29tcGxldGlvbnMgd2l0aCB0aGUgbW9kZWwgY2hvc2VuIHNlcnZlci1zaWRlOiBvbWl0IG1vZGVsIGFuZCB0aGUgZ2F0ZXdheSByb3V0ZXMgdGhlIHByb21wdCB0byB0aGUgdG9wLXJhbmtlZCBtb2RlbCBmb3IgaXRzIHRhc2sgKGNvZGUsIHJlYXNvbmluZywgbG9uZy1jb250ZXh0LCBnZW5lcmFsKSBmcm9tIGEgZml4ZWQgZXZhbC1kZXJpdmVkIHJhbmtpbmcsIGZhaWxpbmcgb3ZlciBhdXRvbWF0aWNhbGx5IG9uIHByb3ZpZGVyIGVycm9ycy4iLCJtaW1lVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24iLCJzZXJ2aWNlTmFtZSI6IkNoYXQgY29tcGxldGlvbnMgLSBhdXRvIHRpZXIiLCJ0YWdzIjpbImxsbSIsImFpIiwiaW5mZXJlbmNlIiwiY2hhdCIsImdhdGV3YXkiXSwiaWNvblVybCI6Imh0dHBzOi8vYWdlbnQ0MDIudG9vbHMvZmF2aWNvbi5pY28ifSwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHg4MzM1ODlmQ0Q2ZURiNkUwOGY0YzdDMzJENGY3MWI1NGJkQTAyOTEzIiwicGF5VG8iOiIweGFCRjRGQWJkN2M0MTZmQjY3MjAyRTVmOTAwMjM4OUZjNzVlMmE5RDAiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAwLCJleHRyYSI6eyJuYW1lIjoiVVNEIENvaW4iLCJ2ZXJzaW9uIjoiMiJ9LCJvdXRwdXRTY2hlbWEiOnsidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsiaWQiOnsidHlwZSI6InN0cmluZyJ9LCJvYmplY3QiOnsidHlwZSI6InN0cmluZyJ9LCJjcmVhdGVkIjp7InR5cGUiOiJpbnRlZ2VyIn0sIm1vZGVsIjp7InR5cGUiOiJzdHJpbmcifSwiY2hvaWNlcyI6eyJ0eXBlIjoiYXJyYXkifSwidXNhZ2UiOnsidHlwZSI6Im9iamVjdCJ9LCJhZ2VudDQwMl9yb3V0ZXIiOnsidHlwZSI6Im9iamVjdCJ9fSwicmVxdWlyZWQiOlsiaWQiLCJvYmplY3QiLCJjcmVhdGVkIiwibW9kZWwiLCJjaG9pY2VzIiwidXNhZ2UiLCJhZ2VudDQwMl9yb3V0ZXIiXX19LHsic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1OjEzNyIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDNjNDk5YzU0MmNFRjVFMzgxMWUxMTkyY2U3MGQ4Y0MwM2Q1YzMzNTkiLCJwYXlUbyI6IjB4YUJGNEZBYmQ3YzQxNmZCNjcyMDJFNWY5MDAyMzg5RmM3NWUyYTlEMCIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImV4dHJhIjp7Im5hbWUiOiJVU0QgQ29pbiIsInZlcnNpb24iOiIyIn19LHsic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1OjQyMTYxIiwiYW1vdW50IjoiMTAwMDAiLCJhc3NldCI6IjB4YWY4OGQwNjVlNzdjOGNDMjIzOTMyN0M1RURiM0E0MzIyNjhlNTgzMSIsInBheVRvIjoiMHhhQkY0RkFiZDdjNDE2ZkI2NzIwMkU1ZjkwMDIzODlGYzc1ZTJhOUQwIiwibWF4VGltZW91dFNlY29uZHMiOjMwMCwiZXh0cmEiOnsibmFtZSI6IlVTRCBDb2luIiwidmVyc2lvbiI6IjIifX0seyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6MTQzIiwiYW1vdW50IjoiMTAwMDAiLCJhc3NldCI6IjB4NzU0NzA0QmMwNTlGOEM2NzAxMmZFZDY5QkM4QTMyN2E1YWFmYjYwMyIsInBheVRvIjoiMHhhQkY0RkFiZDdjNDE2ZkI2NzIwMkU1ZjkwMDIzODlGYzc1ZTJhOUQwIiwibWF4VGltZW91dFNlY29uZHMiOjMwMCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fSx7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo0MzExNCIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweEI5N0VGOUVmODczNEM3MTkwNEQ4MDAyRjhiNkJjNjZEZDljNDhhNkUiLCJwYXlUbyI6IjB4YUJGNEZBYmQ3YzQxNmZCNjcyMDJFNWY5MDAyMzg5RmM3NWUyYTlEMCIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImV4dHJhIjp7Im5hbWUiOiJVU0QgQ29pbiIsInZlcnNpb24iOiIyIn19LHsic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1OjEzMjkiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHhlMTVmQzM4RjZEOGM1NmFGMDdiYkNCZTNCQWY1NzA4QTJCZjQyMzkyIiwicGF5VG8iOiIweGFCRjRGQWJkN2M0MTZmQjY3MjAyRTVmOTAwMjM4OUZjNzVlMmE5RDAiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAwLCJleHRyYSI6eyJuYW1lIjoiVVNEQyIsInZlcnNpb24iOiIyIn19LHsic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1OjEwIiwiYW1vdW50IjoiMTEwMDAiLCJhc3NldCI6IjB4MGIyQzYzOWM1MzM4MTNmNEFhOUQ3ODM3Q0FmNjI2NTNkMDk3RmY4NSIsInBheVRvIjoiMHhhQkY0RkFiZDdjNDE2ZkI2NzIwMkU1ZjkwMDIzODlGYzc1ZTJhOUQwIiwibWF4VGltZW91dFNlY29uZHMiOjMwMCwiZXh0cmEiOnsibmFtZSI6IlVTRCBDb2luIiwidmVyc2lvbiI6IjIifX0seyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6NDY2MyIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDVmYzUzNjBEMDQwMGEwRmQ0ZjJhZjU1MkFERDA0MkQ3MTZGMWQxNjgiLCJwYXlUbyI6IjB4YUJGNEZBYmQ3YzQxNmZCNjcyMDJFNWY5MDAyMzg5RmM3NWUyYTlEMCIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImV4dHJhIjp7Im5hbWUiOiJHbG9iYWwgRG9sbGFyIiwidmVyc2lvbiI6IjEifX0seyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6NDIyMjAiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHhjZWJBOTMwMGYyYjk0ODcxMGQyNjUzZEQ3QjA3ZjMzQThCMzIxMThDIiwicGF5VG8iOiIweGFCRjRGQWJkN2M0MTZmQjY3MjAyRTVmOTAwMjM4OUZjNzVlMmE5RDAiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAwLCJleHRyYSI6eyJuYW1lIjoiVVNEQyIsInZlcnNpb24iOiIyIn19LHsic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1OjU3MDczIiwiYW1vdW50IjoiMTAwMDAiLCJhc3NldCI6IjB4MkQyNzBlNjg4NmQxMzBENzI0MjE1QTI2NjEwNmU2ODMyMTYxRUFFZCIsInBheVRvIjoiMHhhQkY0RkFiZDdjNDE2ZkI2NzIwMkU1ZjkwMDIzODlGYzc1ZTJhOUQwIiwibWF4VGltZW91dFNlY29uZHMiOjMwMCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fSx7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo1MDQyIiwiYW1vdW50IjoiMTAwMDAiLCJhc3NldCI6IjB4MzYwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsInBheVRvIjoiMHhhQkY0RkFiZDdjNDE2ZkI2NzIwMkU1ZjkwMDIzODlGYzc1ZTJhOUQwIiwibWF4VGltZW91dFNlY29uZHMiOjMwMCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fSx7InNjaGVtZSI6InVwdG8iLCJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHg4MzM1ODlmQ0Q2ZURiNkUwOGY0YzdDMzJENGY3MWI1NGJkQTAyOTEzIiwicGF5VG8iOiIweGFCRjRGQWJkN2M0MTZmQjY3MjAyRTVmOTAwMjM4OUZjNzVlMmE5RDAiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAwLCJleHRyYSI6eyJuYW1lIjoiVVNEIENvaW4iLCJ2ZXJzaW9uIjoiMiIsImFzc2V0VHJhbnNmZXJNZXRob2QiOiJwZXJtaXQyIiwiZmFjaWxpdGF0b3JBZGRyZXNzIjoiMHgxNGZEYTEzOTUzRmMzMDQyODkzOEU2QkY5NTBkMDM2ZTc3MjE0ZTUyIn19LHsic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoic29sYW5hOjVleWt0NFVzRnY4UDhOSmRUUkVwWTF2enFLcVpLdmRwIiwiYW1vdW50IjoiMTAwMDAiLCJhc3NldCI6IkVQakZXZGQ1QXVmcVNTcWVNMnFOMXh6eWJhcEM4RzR3RUdHa1p3eVREdDF2IiwicGF5VG8iOiJKN2FOM1BMSm5UQ0Y1cXBFbnZKSEpzbkNqY0d1cUMycll0RU04R3YzeHdnIiwibWF4VGltZW91dFNlY29uZHMiOjMwMCwiZXh0cmEiOnsiZmVlUGF5ZXIiOiJCRU5yTG9VYm5keG9OTVVTNUpYQXBHTXROeWtMakZYWGl4TXRwRHdEUjlTUCIsInRyYW5zYWN0aW9uVmVyc2lvbnMiOlswLDFdfX0seyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJzdGVsbGFyOnB1Ym5ldCIsImFtb3VudCI6IjEwMDAwMCIsImFzc2V0IjoiQ0NXNjdUU1pWM1NTUzJIWE1CUTVKRkdDS0pOWEtaTTdVUVVXVVpQVVRIWFNUWkxFTzdTSk1JNzUiLCJwYXlUbyI6IkdETkpYQ0tXN1pNN0dFRVZQNjc0VFdQVTI2WUpOQlEyRkk0WklQUktUUFROVUVKTURIRkpXV1JMIiwibWF4VGltZW91dFNlY29uZHMiOjMwMCwiZXh0cmEiOnsiYXJlRmVlc1Nwb25zb3JlZCI6dHJ1ZX19LHsic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiYWxnb3JhbmQ6d0dIRTJQd2R2ZDdTMTJCTDVGYU9QMjBFR1llc043M2siLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMzE1NjY3MDQiLCJwYXlUbyI6IkM3SUlIRzdTUExQWjVIN1pUNkhXM1VWMk9RTVFRRTZZMkhCTkdaWFNMUkpVTEU0MkJFRTJPWTJYSUUiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAwLCJleHRyYSI6eyJ0YWciOiJ4NDAyLWdsb2JhbC1jaGFsbGVuZ2UiLCJmZWVQYXllciI6IlpNRksyT0k3WkJEMlUyN0lTRVJaQzRTNkxLTTZXTUZKUFpRNE1ZTkpEWjJWTkJOTUJBNjdSQTIyQUEifX0seyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MyIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDgzMzU4OWZDRDZlRGI2RTA4ZjRjN0MzMkQ0ZjcxYjU0YmRBMDI5MTMiLCJwYXlUbyI6IjB4YUJGNEZBYmQ3YzQxNmZCNjcyMDJFNWY5MDAyMzg5RmM3NWUyYTlEMCIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MDQ5MDAsImV4dHJhIjp7Im5hbWUiOiJHYXRld2F5V2FsbGV0QmF0Y2hlZCIsInZlcnNpb24iOiIxIiwidmVyaWZ5aW5nQ29udHJhY3QiOiIweDc3Nzc3Nzc3ZGNjNGQ1YThiNmU0MThmZDA0ZDg5OTdlZjExMDAwZWUifX0seyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6NTA0MiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDM2MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJwYXlUbyI6IjB4YUJGNEZBYmQ3YzQxNmZCNjcyMDJFNWY5MDAyMzg5RmM3NWUyYTlEMCIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MDQ5MDAsImV4dHJhIjp7Im5hbWUiOiJHYXRld2F5V2FsbGV0QmF0Y2hlZCIsInZlcnNpb24iOiIxIiwidmVyaWZ5aW5nQ29udHJhY3QiOiIweDc3Nzc3Nzc3ZGNjNGQ1YThiNmU0MThmZDA0ZDg5OTdlZjExMDAwZWUifX1dLCJleHRlbnNpb25zIjp7ImJhemFhciI6eyJpbmZvIjp7ImlucHV0Ijp7InR5cGUiOiJodHRwIiwiYm9keVR5cGUiOiJqc29uIiwiYm9keSI6eyJtZXNzYWdlcyI6W3sicm9sZSI6InVzZXIiLCJjb250ZW50IjoiUmVwbHkgd2l0aCBleGFjdGx5OiBPSyJ9XSwibWF4X3Rva2VucyI6NX0sIm1ldGhvZCI6IlBPU1QifSwib3V0cHV0Ijp7InR5cGUiOiJqc29uIiwiZXhhbXBsZSI6eyJpZCI6Imdlbi3igKYiLCJvYmplY3QiOiJjaGF0LmNvbXBsZXRpb24iLCJjcmVhdGVkIjoxNzUwMDAwMDAwLCJtb2RlbCI6Im9wZW5haS9ncHQtNG8tbWluaSIsImNob2ljZXMiOlt7ImluZGV4IjowLCJtZXNzYWdlIjp7InJvbGUiOiJhc3Npc3RhbnQiLCJjb250ZW50IjoiT0sifSwiZmluaXNoX3JlYXNvbiI6InN0b3AifV0sInVzYWdlIjp7InByb21wdF90b2tlbnMiOjEyLCJjb21wbGV0aW9uX3Rva2VucyI6MSwidG90YWxfdG9rZW5zIjoxM30sImFnZW50NDAyX3JvdXRlciI6eyJjYXRlZ29yeSI6ImdlbmVyYWwiLCJxdWFsaXR5IjoiYmFsYW5jZWQiLCJzZXJ2ZWQiOiJvcGVuYWkvZ3B0LTUuNi1sdW5hIn19fX0sInNjaGVtYSI6eyIkc2NoZW1hIjoiaHR0cHM6Ly9qc29uLXNjaGVtYS5vcmcvZHJhZnQvMjAyMC0xMi9zY2hlbWEiLCJ0eXBlIjoib2JqZWN0IiwicHJvcGVydGllcyI6eyJpbnB1dCI6eyJ0eXBlIjoib2JqZWN0IiwicHJvcGVydGllcyI6eyJ0eXBlIjp7InR5cGUiOiJzdHJpbmciLCJjb25zdCI6Imh0dHAifSwibWV0aG9kIjp7InR5cGUiOiJzdHJpbmciLCJlbnVtIjpbIlBPU1QiXX0sImJvZHlUeXBlIjp7InR5cGUiOiJzdHJpbmciLCJlbnVtIjpbImpzb24iLCJmb3JtLWRhdGEiLCJ0ZXh0Il19LCJib2R5Ijp7InR5cGUiOiJvYmplY3QiLCJwcm9wZXJ0aWVzIjp7Im1lc3NhZ2VzIjp7InR5cGUiOiJhcnJheSJ9LCJtb2RlbCI6eyJ0eXBlIjoic3RyaW5nIn0sInF1YWxpdHkiOnsidHlwZSI6InN0cmluZyJ9LCJzZXJ2aWNlX3RpZXIiOnsidHlwZSI6InN0cmluZyJ9LCJtYXhfdG9rZW5zIjp7InR5cGUiOiJudW1iZXIifX0sInJlcXVpcmVkIjpbIm1lc3NhZ2VzIl19fSwicmVxdWlyZWQiOlsidHlwZSIsIm1ldGhvZCIsImJvZHlUeXBlIiwiYm9keSJdLCJhZGRpdGlvbmFsUHJvcGVydGllcyI6ZmFsc2V9LCJvdXRwdXQiOnsidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsidHlwZSI6eyJ0eXBlIjoic3RyaW5nIn0sImV4YW1wbGUiOnsidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsiaWQiOnsidHlwZSI6InN0cmluZyJ9LCJvYmplY3QiOnsidHlwZSI6InN0cmluZyJ9LCJjcmVhdGVkIjp7InR5cGUiOiJpbnRlZ2VyIn0sIm1vZGVsIjp7InR5cGUiOiJzdHJpbmcifSwiY2hvaWNlcyI6eyJ0eXBlIjoiYXJyYXkifSwidXNhZ2UiOnsidHlwZSI6Im9iamVjdCJ9LCJhZ2VudDQwMl9yb3V0ZXIiOnsidHlwZSI6Im9iamVjdCJ9fSwicmVxdWlyZWQiOlsiaWQiLCJvYmplY3QiLCJjcmVhdGVkIiwibW9kZWwiLCJjaG9pY2VzIiwidXNhZ2UiLCJhZ2VudDQwMl9yb3V0ZXIiXX19LCJyZXF1aXJlZCI6WyJ0eXBlIl19fSwicmVxdWlyZWQiOlsiaW5wdXQiXX19LCJidWlsZGVyLWNvZGUiOnsiaW5mbyI6eyJhIjoiYmNfYjRhdzR1emQifSwic2NoZW1hIjp7IiRzY2hlbWEiOiJodHRwczovL2pzb24tc2NoZW1hLm9yZy9kcmFmdC8yMDIwLTEyL3NjaGVtYSIsInR5cGUiOiJvYmplY3QiLCJwcm9wZXJ0aWVzIjp7ImEiOnsidHlwZSI6InN0cmluZyIsInBhdHRlcm4iOiJeW2EtejAtOV9dezEsMzJ9JCIsImRlc2NyaXB0aW9uIjoiQXBwIGJ1aWxkZXIgY29kZSJ9LCJ3Ijp7InR5cGUiOiJzdHJpbmciLCJwYXR0ZXJuIjoiXlthLXowLTlfXXsxLDMyfSQiLCJkZXNjcmlwdGlvbiI6IldhbGxldCBidWlsZGVyIGNvZGUifSwicyI6eyJ0eXBlIjoiYXJyYXkiLCJtYXhJdGVtcyI6MTEsIml0ZW1zIjp7InR5cGUiOiJzdHJpbmciLCJwYXR0ZXJuIjoiXlthLXowLTlfXXsxLDMyfSQifSwiZGVzY3JpcHRpb24iOiJTZXJ2aWNlIGJ1aWxkZXIgY29kZXMifX0sImFkZGl0aW9uYWxQcm9wZXJ0aWVzIjpmYWxzZX19LCJwYXltZW50LWlkZW50aWZpZXIiOnsiaW5mbyI6eyJyZXF1aXJlZCI6ZmFsc2V9LCJzY2hlbWEiOnsiJHNjaGVtYSI6Imh0dHBzOi8vanNvbi1zY2hlbWEub3JnL2RyYWZ0LzIwMjAtMTIvc2NoZW1hIiwidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsicmVxdWlyZWQiOnsidHlwZSI6ImJvb2xlYW4ifSwiaWQiOnsidHlwZSI6InN0cmluZyIsIm1pbkxlbmd0aCI6MTYsIm1heExlbmd0aCI6MTI4LCJwYXR0ZXJuIjoiXlthLXpBLVowLTlfLV0rJCJ9fSwicmVxdWlyZWQiOlsicmVxdWlyZWQiXX19fX0=",
    payTo: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg",
    amountMicros: 10_000,
    index: 12,
    recordedAt: "2026-11-07T07:08:55Z",
};
