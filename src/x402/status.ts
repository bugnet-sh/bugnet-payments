import type { Address } from "@solana/kit";
import type { Settings } from "../config.ts";
import type { Queryable } from "../db/pool.ts";
import { inspectTokenAccount } from "../solana/accounts.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { readControls } from "./controls.ts";
import { openIncidents } from "./incidents.ts";
import { liabilities } from "./liabilities.ts";
import { readPool } from "./ledger.ts";
import { readTail } from "./tail.ts";

const dash = (v: unknown): string => (v === null || v === undefined ? "-" : String(v));
const iso = (d: Date | null): string => (d === null ? "-" : d.toISOString());

async function chainBalance(
    rpc: SolanaRpc | null,
    hot: Address | null,
): Promise<{ line: string; slot: bigint | null }> {
    if (rpc === null || hot === null) return { line: "chain balance: unavailable", slot: null };
    try {
        const info = await inspectTokenAccount(rpc, hot, {
            commitment: "finalized",
            abortSignal: AbortSignal.timeout(10_000),
        });
        if (info === null) return { line: "chain balance: account missing", slot: null };
        return {
            line: `chain balance: ${info.amount} at slot ${info.contextSlot}`,
            slot: info.contextSlot,
        };
    } catch {
        return { line: "chain balance: unavailable", slot: null };
    }
}

export async function x402Status(
    db: Queryable,
    rpc: SolanaRpc | null,
    hotTokenAccount: Address | null,
    x402: Settings["x402"],
    now: Date,
): Promise<string[]> {
    const controls = await readControls(db);
    const pool = await readPool(db);
    const tail = await readTail(db);
    const chain = await chainBalance(rpc, hotTokenAccount);
    const lag = chain.slot === null ? "-" : String(chain.slot - tail.verifiedSlot);
    const lines = [
        `disabled: ${controls.disabled}`,
        `paused: ${controls.paused}`,
        `refunds_held: ${controls.refundsHeld}`,
        `reason: ${dash(controls.reason)}`,
        `pool committed=${pool.committedMicros} unpaid=${pool.unpaidMicros}`,
        `liabilities: ${await liabilities(db)}`,
        chain.line,
        `verified_slot: ${tail.verifiedSlot} verified_at: ${iso(tail.verifiedAt)} lag_slots: ${lag}`,
    ];
    const accounts = await db.query<{ open: string; closing: string }>(
        `select count(*) filter (where state = 'open') as open,
            count(*) filter (where state = 'closing') as closing
         from x402_accounts`,
    );
    lines.push(`accounts open=${accounts.rows[0]!.open} closing=${accounts.rows[0]!.closing}`);
    const cutoff = new Date(now.getTime() - x402.unresolved_alarm_after);
    const signed = await db.query<{
        id: string;
        signed_at: Date;
        signing_slot: string | null;
        last_valid_block_height: string | null;
    }>(
        `select id, signed_at, signing_slot, last_valid_block_height from x402_payments
         where state = 'signed' and signed_at <= $1 order by signed_at, id`,
        [cutoff],
    );
    for (const r of signed.rows) {
        lines.push(
            `signed ${r.id} signed_at=${iso(r.signed_at)} signing_slot=${dash(r.signing_slot)} ` +
                `last_valid_block_height=${dash(r.last_valid_block_height)}`,
        );
    }
    const events = await db.query<{ n: string }>(
        "select count(*) as n from x402_router_events where state = 'pending'",
    );
    lines.push(`events pending=${events.rows[0]!.n}`);
    for (const i of await openIncidents(db)) {
        lines.push(
            `incident ${i.id} ${i.kind} ${i.subject} loss=${i.lossMicros} at=${iso(i.createdAt)}`,
        );
    }
    return lines;
}
