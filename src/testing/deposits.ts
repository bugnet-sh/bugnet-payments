import { randomBytes } from "node:crypto";
import type pg from "pg";

const AT = new Date("2030-01-01T00:20:00Z");

// A transfer held in review whose money a closing move carried to the refund float (spec 10.9).
// The deposit row is made on first use; its address only has to be unique.
export async function seedHeldTransfer(
    pool: pg.Pool,
    orderId: string,
    o: {
        signature?: string;
        amountMicros?: number;
        appliedMicros?: number;
        moveState?: "confirmed" | "sent";
    } = {},
): Promise<{ signature: string; moveId: number }> {
    const signature = o.signature ?? randomBytes(32).toString("hex");
    const amount = o.amountMicros ?? 7_000;
    const applied = o.appliedMicros ?? 0;
    await pool.query(
        `insert into deposits (order_id, address, token_account, key_version, salt, created_at)
         values ($1, $2, $3, 1, $4, $5) on conflict (order_id) do nothing`,
        [
            orderId,
            `addr-${randomBytes(8).toString("hex")}`,
            `ata-${randomBytes(8).toString("hex")}`,
            Buffer.alloc(16, 1),
            AT,
        ],
    );
    const move = await pool.query<{ id: string }>(
        `insert into deposit_moves (order_id, kind, held_micros, closes, state, created_at)
         values ($1, 'close', $2, true, $3, $4) returning id`,
        [orderId, amount - applied, o.moveState ?? "confirmed", AT],
    );
    const moveId = Number(move.rows[0]!.id);
    await pool.query(
        `insert into deposit_transfers (order_id, signature, slot, seq, block_time, seen_at,
            amount_micros, outcome, applied_micros, reason, move_id)
         values ($1, $2, 1000, 0, $3, $3, $4, 'review', $5, 'unattributed', $6)`,
        [orderId, signature, AT, amount, applied, moveId],
    );
    return { signature, moveId };
}

export async function heldRefundId(
    pool: pg.Pool,
    orderId: string,
    signature: string,
): Promise<number | null> {
    const res = await pool.query<{ refund_id: string | null }>(
        "select refund_id from deposit_transfers where order_id = $1 and signature = $2",
        [orderId, signature],
    );
    const id = res.rows[0]?.refund_id ?? null;
    return id === null ? null : Number(id);
}

// A part of a written-off debit taken from one transfer, and the float payout naming it
export async function seedWriteOffPart(
    pool: pg.Pool,
    orderId: string,
    o: {
        transferSignature: string;
        micros: number;
        refund?: { amountMicros: number; destination: string; payer: string };
        signature?: string;
    },
): Promise<{ signature: string; refundId: number | null }> {
    const signature = o.signature ?? randomBytes(32).toString("hex");
    await pool.query(
        `insert into deposit_write_offs (order_id, signature, slot, micros, written_at)
         values ($1, $2, 1001, $3, $4)`,
        [orderId, signature, o.micros, AT],
    );
    let refundId: number | null = null;
    if (o.refund !== undefined) {
        const part = await pool.query<{ part: number }>(
            `select coalesce(max(part) + 1, 0)::int as part from refunds
             where order_id = $1 and kind = 'deposit'`,
            [orderId],
        );
        const res = await pool.query<{ id: string }>(
            `insert into refunds (order_id, kind, part, reason, amount_micros, destination, payer,
                state, from_wallet, deposit_signature, created_at)
             values ($1, 'deposit', $2, 'deposit_write_off', $3, $4, $5, 'pending', 'refund', $6,
                $7)
             returning id`,
            [
                orderId,
                part.rows[0]!.part,
                o.refund.amountMicros,
                o.refund.destination,
                o.refund.payer,
                o.transferSignature,
                AT,
            ],
        );
        refundId = Number(res.rows[0]!.id);
    }
    await pool.query(
        `insert into deposit_write_off_parts (order_id, signature, transfer_signature, micros,
            refund_id)
         values ($1, $2, $3, $4, $5)`,
        [orderId, signature, o.transferSignature, o.micros, refundId],
    );
    return { signature, refundId };
}
