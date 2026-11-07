import type { Queryable } from "../db/pool.ts";

export interface Controls {
    disabled: boolean;
    paused: boolean;
    refundsHeld: boolean;
    reason: string | null;
    changedAt: Date | null;
}

export async function readControls(db: Queryable): Promise<Controls> {
    const { rows } = await db.query(
        "select disabled, paused, refunds_held, reason, changed_at from x402_controls where id = 1",
    );
    const r = rows[0];
    if (!r) throw new Error("x402_controls row 1 is missing");
    return {
        disabled: r.disabled,
        paused: r.paused,
        refundsHeld: r.refunds_held,
        reason: r.reason,
        changedAt: r.changed_at,
    };
}

export async function setControls(
    db: Queryable,
    change: Partial<Pick<Controls, "disabled" | "paused" | "refundsHeld">>,
    reason: string | null,
    at: Date,
): Promise<void> {
    const columns = {
        disabled: "disabled",
        paused: "paused",
        refundsHeld: "refunds_held",
    } as const;
    const sets = ["reason = $1", "changed_at = $2"];
    const params: unknown[] = [reason, at];
    for (const [field, column] of Object.entries(columns)) {
        const v = change[field as keyof typeof columns];
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${column} = $${params.length}`);
    }
    await db.query(`update x402_controls set ${sets.join(", ")} where id = 1`, params);
}

export async function isPayToBlocked(db: Queryable, payTo: string): Promise<boolean> {
    const { rowCount } = await db.query("select 1 from x402_blocked_payto where pay_to = $1", [
        payTo,
    ]);
    return rowCount === 1;
}

export async function blockedAmong(
    db: Queryable,
    payTos: readonly string[],
): Promise<ReadonlySet<string>> {
    const { rows } = await db.query<{ pay_to: string }>(
        "select pay_to from x402_blocked_payto where pay_to = any($1::text[])",
        [payTos],
    );
    return new Set(rows.map((r) => r.pay_to));
}

export async function blockPayTo(db: Queryable, payTo: string, reason: string): Promise<void> {
    await db.query(
        "insert into x402_blocked_payto (pay_to, reason) values ($1, $2) on conflict (pay_to) do nothing",
        [payTo, reason],
    );
}

export async function unblockPayTo(db: Queryable, payTo: string): Promise<boolean> {
    const { rowCount } = await db.query("delete from x402_blocked_payto where pay_to = $1", [
        payTo,
    ]);
    return rowCount === 1;
}
