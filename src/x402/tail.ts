import type { Queryable } from "../db/pool.ts";

export interface Tail {
    tokenAccount: string | null;
    openingBalanceMicros: bigint;
    openingSlot: bigint;
    openedAt: Date | null;
    verifiedSlot: bigint;
    verifiedAt: Date | null;
    finalizedHeight: bigint;
    mismatchSince: Date | null;
}

interface TailDbRow {
    token_account: string | null;
    opening_balance_micros: string;
    opening_slot: string;
    opened_at: Date | null;
    verified_slot: string;
    verified_at: Date | null;
    finalized_height: string;
    mismatch_since: Date | null;
}

export async function readTail(db: Queryable): Promise<Tail> {
    const res = await db.query<TailDbRow>("select * from x402_tail where id = 1");
    const r = res.rows[0]!;
    return {
        tokenAccount: r.token_account,
        openingBalanceMicros: BigInt(r.opening_balance_micros),
        openingSlot: BigInt(r.opening_slot),
        openedAt: r.opened_at,
        verifiedSlot: BigInt(r.verified_slot),
        verifiedAt: r.verified_at,
        finalizedHeight: BigInt(r.finalized_height),
        mismatchSince: r.mismatch_since,
    };
}

export async function openTail(
    db: Queryable,
    tokenAccount: string,
    balanceMicros: bigint,
    slot: bigint,
    at: Date,
): Promise<void> {
    await db.query(
        `update x402_tail set token_account = $1, opening_balance_micros = $2, opening_slot = $3,
            opened_at = $4, verified_slot = $3, verified_at = $4, mismatch_since = null
         where id = 1`,
        [tokenAccount, balanceMicros.toString(), slot.toString(), at],
    );
}

export async function advanceVerified(db: Queryable, slot: bigint, at: Date): Promise<boolean> {
    const res = await db.query(
        `update x402_tail set verified_slot = $1, verified_at = $2
         where id = 1 and verified_slot < $1`,
        [slot.toString(), at],
    );
    return res.rowCount === 1;
}

export async function raiseFinalizedHeight(db: Queryable, h0: bigint): Promise<void> {
    await db.query(
        "update x402_tail set finalized_height = $1 where id = 1 and finalized_height < $1",
        [h0.toString()],
    );
}

export async function setMismatchSince(db: Queryable, at: Date | null): Promise<void> {
    await db.query("update x402_tail set mismatch_since = $1 where id = 1", [at]);
}

// Every account closed, every allowance-wallet refund settled, no hot share settling, and every
// cold transfer done: nothing is left in the hot wallet that Bugnet still owes or must move.
export async function hotLedgerEmpty(db: Queryable): Promise<boolean> {
    const res = await db.query<{ empty: boolean }>(
        `select
            not exists (select 1 from x402_accounts where state <> 'closed')
            and not exists (select 1 from refunds where from_wallet = 'allowance'
                and state <> 'confirmed' and manual_reason is distinct from 'resolved_by_hand')
            and not exists (select 1 from orders where pay_into = 'allowance' and state = 'settling')
            and not exists (select 1 from x402_cold_transfers
                where state not in ('confirmed', 'failed'))
            as empty`,
    );
    return res.rows[0]!.empty;
}
