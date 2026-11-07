import type pg from "pg";
import type { Settings } from "../config.ts";
import type { Log } from "../log.ts";
import { setOrderState } from "../orders/store.ts";
import type { OrderRow, PaymentRow } from "../orders/types.ts";
import type { AllowanceFunding } from "./funding.ts";
import {
    ceilingUsedMicros,
    feeDue,
    findAccountByHandle,
    insertAccount,
    lockAccount,
    movePool,
    placementEnded,
    readPool,
} from "./ledger.ts";
import type { AccountRow, FundingRow, StoredPin, StoredX402Setup, X402Refusal } from "./types.ts";

export interface PaidDeps {
    funding: AllowanceFunding;
    x402: Settings["x402"];
    log: Log;
}

export type PaidOutcome =
    { kind: "funded"; funding: FundingRow } | { kind: "refused"; refusal: X402Refusal };

type RefundReason = "late" | "x402_closed" | "x402_ceiling";

const REFUND_REASON: Record<X402Refusal, RefundReason> = {
    order_expired: "late",
    sandbox_ended: "x402_closed",
    allowance_ceiling: "x402_ceiling",
    allowance_pool_full: "x402_ceiling",
};

// Runs in the transaction that moved the order settling -> paid, with the order row locked
export async function onOrderPaid(
    c: pg.PoolClient,
    d: PaidDeps,
    order: OrderRow,
    payment: PaymentRow,
    at: Date,
): Promise<PaidOutcome> {
    const setup = order.x402Setup;
    if (order.kind === "start") {
        await insertAccount(c, {
            id: order.id,
            handleSha256: null,
            placementId: null,
            packageId: order.packageId,
            spendPerMinuteMicros:
                setup?.spendPerMinuteMicros ?? d.x402.default_spend_per_minute_micros,
            deadline: null,
            createdAt: at,
        });
    }
    const found =
        order.kind === "start"
            ? { id: order.id }
            : await findAccountByHandle(c, order.handleSha256 ?? "");
    const account = found === null ? null : await lockAccount(c, found.id);

    const refusal = await refusalFor(c, d, order, account);
    if (refusal !== null) {
        await c.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                from_wallet, created_at)
             values ($1, 'full', $2, $3, $4, $5, 'pending', 'allowance', $6)
             on conflict do nothing`,
            [
                order.id,
                REFUND_REASON[refusal],
                payment.amountMicros,
                payment.sourceTokenAccount,
                payment.payer,
                at,
            ],
        );
        await setOrderState(c, order.id, "paid", "refunding", { x402Refusal: refusal });
        await movePool(c, { unpaid: -order.allowanceMicros }, d.x402, d.log);
        d.log.info("allowance funding refused", { orderId: order.id, refusal });
        return { kind: "refused", refusal };
    }

    if (setup !== null && (setup.services.length > 0 || setup.disable.length > 0)) {
        await storePins(c, account!.id, order.id, setup, at);
    }
    if (setup?.spendPerMinuteMicros != null) {
        await c.query("update x402_accounts set spend_per_minute_micros = $2 where id = $1", [
            account!.id,
            setup.spendPerMinuteMicros,
        ]);
    }
    const funding = await d.funding.fund(c, order, payment, account!, at);
    if (order.kind === "allowance") {
        await setOrderState(c, order.id, "paid", "redeemed", { redeemedAt: at });
    }
    return { kind: "funded", funding };
}

async function refusalFor(
    c: pg.PoolClient,
    d: PaidDeps,
    order: OrderRow,
    account: AccountRow | null,
): Promise<X402Refusal | null> {
    if (
        order.kind === "allowance" &&
        order.paidAt !== null &&
        order.paidAt.getTime() > order.expiresAt.getTime()
    ) {
        return "order_expired";
    }
    if (account === null || account.state !== "open" || (await placementEnded(c, account.id))) {
        return "sandbox_ended";
    }
    const ceiling = d.x402.max_allowance_per_sandbox_micros;
    if ((await ceilingUsedMicros(c, account.id)) + order.allowanceMicros > ceiling) {
        return "allowance_ceiling";
    }
    const credit = order.feeMicros > 0 && !(await feeDue(c, account.id)) ? order.feeMicros : 0;
    // Create check 12 already bounds the sum; this guards the credited fee
    const pool = await readPool(c);
    if (pool.committedMicros + order.allowanceMicros + credit > d.x402.pool_max_micros) {
        return "allowance_pool_full";
    }
    return null;
}

export async function storePins(
    c: pg.PoolClient,
    accountId: string,
    orderId: string,
    setup: StoredX402Setup,
    at: Date,
): Promise<void> {
    const pins = new Map<string, StoredPin>(setup.services.map((p) => [p.serviceId, p]));
    const disable = new Set(setup.disable);
    const ids = [...new Set([...pins.keys(), ...disable])].sort();
    for (const id of ids) {
        const pin = pins.get(id);
        if (pin?.newPin) {
            await c.query(
                `insert into x402_services (account_id, service_id, method, host, prefix, url,
                    max_price_micros, pay_to, listed, paid_path, pinned_from, probe, order_id,
                    state, failures, updated_at)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13,
                    'enabled', 0, $14)
                 on conflict (account_id, service_id) do update set method = excluded.method,
                    host = excluded.host, prefix = excluded.prefix, url = excluded.url,
                    max_price_micros = excluded.max_price_micros, pay_to = excluded.pay_to,
                    listed = excluded.listed, paid_path = excluded.paid_path,
                    pinned_from = excluded.pinned_from, probe = excluded.probe,
                    order_id = excluded.order_id, state = 'enabled', failures = 0,
                    updated_at = excluded.updated_at`,
                [
                    accountId,
                    id,
                    pin.method,
                    pin.host,
                    pin.prefix,
                    pin.url,
                    pin.maxPriceMicros,
                    pin.payTo,
                    pin.listed,
                    pin.paidPath,
                    pin.pinnedFrom,
                    JSON.stringify(pin.probe),
                    orderId,
                    at,
                ],
            );
        } else if (pin !== undefined) {
            await c.query(
                `update x402_services set max_price_micros = $3, state = 'enabled', updated_at = $4
                 where account_id = $1 and service_id = $2`,
                [accountId, id, pin.maxPriceMicros, at],
            );
        }
        if (disable.has(id)) {
            await c.query(
                `update x402_services set state = 'disabled', updated_at = $3
                 where account_id = $1 and service_id = $2`,
                [accountId, id, at],
            );
        }
    }
}
