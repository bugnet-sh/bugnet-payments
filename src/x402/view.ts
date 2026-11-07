import type { Settings } from "../config.ts";
import type { Queryable } from "../db/pool.ts";
import { ceilingUsedMicros, findAccount, leftMicros } from "./ledger.ts";
import type {
    AccountRow,
    HttpMethod,
    Listed,
    ServiceState,
    X402AccountView,
    X402RefundView,
} from "./types.ts";

type RefundViewState = "pending" | "sent" | "confirmed" | "manual";

const RANK: Record<"pending" | "sent" | "confirmed", number> = {
    pending: 0,
    sent: 1,
    confirmed: 2,
};

interface RefundViewRow {
    state: string;
    manual_reason: string | null;
    tx_signature: string | null;
    hand_tx: string | null;
    amount: string | number;
}

interface ServiceDbRow {
    service_id: string;
    method: HttpMethod;
    host: string;
    prefix: string;
    url: string;
    paid_path: string | null;
    max_price_micros: string | number;
    pay_to: string;
    listed: Listed;
    state: ServiceState;
}

async function countPayments(db: Queryable, accountId: string, where: string): Promise<number> {
    const res = await db.query<{ n: string }>(
        `select count(*) as n from x402_payments where account_id = $1 and ${where}`,
        [accountId],
    );
    return Number(res.rows[0]!.n);
}

export async function accountView(
    db: Queryable,
    accountId: string,
    x402: Settings["x402"],
): Promise<X402AccountView> {
    const account = await findAccount(db, accountId);
    if (account === null) throw new Error(`x402 account ${accountId} not found`);
    const paidCalls = await countPayments(db, accountId, "state = 'confirmed' and not late_landed");
    const pendingCalls = await countPayments(db, accountId, "state in ('reserved', 'signed')");
    const used = await ceilingUsedMicros(db, accountId);
    const services = await db.query<ServiceDbRow>(
        `select service_id, method, host, prefix, url, paid_path, max_price_micros, pay_to,
            listed, state
         from x402_services where account_id = $1 order by service_id`,
        [accountId],
    );
    const view: X402AccountView = {
        state: account.state,
        fundedMicros: account.fundedMicros,
        spentMicros: account.spentMicros,
        heldMicros: account.heldMicros,
        leftMicros: leftMicros(account),
        allowanceRoomMicros: x402.max_allowance_per_sandbox_micros - used,
        paidCalls,
        pendingCalls,
        spendPerMinuteMicros: account.spendPerMinuteMicros,
        services: services.rows.map((s) => ({
            serviceId: s.service_id,
            method: s.method,
            host: s.host,
            prefix: s.prefix,
            url: s.url,
            paidPath: s.paid_path,
            maxPriceMicros: Number(s.max_price_micros),
            payTo: s.pay_to,
            listed: s.listed,
            state: s.state,
        })),
    };
    const refund = await refundView(db, account);
    if (refund !== undefined) view.refund = refund;
    return view;
}

function rowState(r: RefundViewRow): RefundViewState {
    switch (r.state) {
        case "pending":
        case "signed":
            return "pending";
        case "sent":
            return "sent";
        case "confirmed":
            return "confirmed";
        default:
            return r.manual_reason === "resolved_by_hand" ? "confirmed" : "manual";
    }
}

export async function refundView(
    db: Queryable,
    account: AccountRow,
): Promise<X402RefundView | undefined> {
    if (account.state === "open") return undefined;
    // A voided funding's allowance is what the buyer is owed back, not the full refund's gross
    const res = await db.query<RefundViewRow>(
        `select r.state, r.manual_reason, r.tx_signature, r.hand_tx,
            case when r.kind = 'full' then f.allowance_micros else r.amount_micros end as amount
         from refunds r join x402_fundings f on f.order_id = r.order_id
         where f.account_id = $1
            and (r.kind = 'allowance' or (r.kind = 'full' and f.voided_at is not null))
         order by r.id`,
        [account.id],
    );
    const states = res.rows.map(rowState);
    const txs: string[] = [];
    let amountMicros = 0;
    res.rows.forEach((r, i) => {
        amountMicros += Number(r.amount);
        if (states[i] !== "confirmed") return;
        const tx = r.state === "confirmed" ? r.tx_signature : r.hand_tx;
        if (tx !== null) txs.push(tx);
    });
    let state: X402RefundView["state"];
    if (states.length === 0) {
        state =
            account.state === "closing" ? "waiting" : account.keptMicros > 0 ? "kept" : "confirmed";
    } else if (states.includes("manual")) {
        state = "manual";
    } else {
        state = states.reduce<"pending" | "sent" | "confirmed">(
            (low, s) => (s !== "manual" && RANK[s] < RANK[low] ? s : low),
            "confirmed",
        );
    }
    return { state, amountMicros, keptMicros: account.keptMicros, txs };
}
