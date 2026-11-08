import { signature as toSignature } from "@solana/kit";
import type { Queryable } from "../db/pool.ts";
import { toRefund, type RefundDbRow } from "../refunds/request.ts";
import { deadline, type SolanaRpc } from "../solana/rpc.ts";
import { findAccount } from "./ledger.ts";

export interface LedgerCheck {
    ok: boolean;
    lines: string[];
}

interface ParsedTransaction {
    transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } };
    meta: {
        err: unknown;
        preTokenBalances?: TokenBalance[] | null;
        postTokenBalances?: TokenBalance[] | null;
    } | null;
}

interface TokenBalance {
    accountIndex: number;
    uiTokenAmount: { amount: string };
}

// What the chain says one transaction did to one token account: its change, "missing" when the
// node has no such transaction, or "failed" when it ended in an error
async function chainChange(
    rpc: SolanaRpc,
    rpcTimeoutMs: number,
    sig: string | null,
    tokenAccount: string,
): Promise<bigint | "missing" | "failed"> {
    if (sig === null) return "missing";
    const raw = await rpc
        .getTransaction(toSignature(sig), {
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
        })
        .send(deadline(rpcTimeoutMs));
    if (raw === null) return "missing";
    const tx = raw as unknown as ParsedTransaction;
    if (tx.meta === null || tx.meta.err !== null) return "failed";
    const keys = tx.transaction.message.accountKeys.map((k) =>
        typeof k === "string" ? k : k.pubkey,
    );
    const index = keys.indexOf(tokenAccount);
    const at = (balances: TokenBalance[] | null | undefined): bigint => {
        const entry = balances?.find((b) => b.accountIndex === index);
        return entry === undefined ? 0n : BigInt(entry.uiTokenAmount.amount);
    };
    return at(tx.meta.postTokenBalances) - at(tx.meta.preTokenBalances);
}

export async function ledgerCheck(
    db: Queryable,
    rpc: SolanaRpc,
    accountId: string,
    rpcTimeoutMs: number,
): Promise<LedgerCheck> {
    const account = await findAccount(db, accountId);
    if (account === null) throw new Error(`unknown account ${accountId}`);
    const result: LedgerCheck = { ok: true, lines: [] };

    const verdict = (
        kind: "payment" | "refund",
        id: string | number,
        ledger: number,
        chain: bigint | "missing" | "failed",
    ) => {
        if (chain === BigInt(ledger)) {
            result.lines.push(`${kind} ${id} ok ${ledger}`);
            return;
        }
        result.ok = false;
        result.lines.push(`${kind} ${id} MISMATCH ledger=${ledger} chain=${chain}`);
    };

    const payments = await db.query<{
        id: string;
        amount_micros: string;
        pay_to_token_account: string;
        tx_signature: string | null;
    }>(
        `select id, amount_micros, pay_to_token_account, tx_signature from x402_payments
         where account_id = $1 and state = 'confirmed' order by created_at, id`,
        [accountId],
    );
    for (const p of payments.rows) {
        const chain = await chainChange(rpc, rpcTimeoutMs, p.tx_signature, p.pay_to_token_account);
        verdict("payment", p.id, Number(p.amount_micros), chain);
    }

    const refunds = await db.query<RefundDbRow>(
        `select r.* from refunds r join x402_fundings f on f.order_id = r.order_id
         where f.account_id = $1 and r.kind = 'allowance' and r.reason = 'x402_unspent'
            and r.from_wallet = 'allowance'
         order by r.id`,
        [accountId],
    );
    for (const row of refunds.rows.map(toRefund)) {
        if (row.manualReason === "resolved_by_hand") {
            result.lines.push(`refund ${row.id} resolved by hand ${row.handTx}`);
            continue;
        }
        if (row.state !== "confirmed") {
            // The closed-account totals count a refund from the moment its row exists, so only
            // the row's state shows that the money has not moved
            result.lines.push(`refund ${row.id} ${row.state}`);
            if (account.state === "closed") result.ok = false;
            continue;
        }
        const chain = await chainChange(rpc, rpcTimeoutMs, row.txSignature, row.destination);
        verdict("refund", row.id, row.amountMicros, chain);
    }

    const { fundedMicros: f, spentMicros: s, refundedMicros: r, keptMicros: k } = account;
    const balanced = account.state !== "closed" || f === s + r + k;
    if (!balanced) result.ok = false;
    result.lines.push(
        `account ${account.id} funded=${f} spent=${s} refunded=${r} kept=${k} ` +
            (balanced ? "ok" : "MISMATCH"),
    );
    return result;
}
