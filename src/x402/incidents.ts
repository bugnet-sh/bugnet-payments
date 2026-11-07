import type pg from "pg";
import type { Queryable } from "../db/pool.ts";
import type { Log } from "../log.ts";
import type { IncidentKind } from "./types.ts";

export interface IncidentFact {
    kind: IncidentKind;
    subject: string;
    lossMicros?: number;
    paymentId?: string;
    refundId?: number;
    coldTransferId?: number;
    detail: Record<string, unknown>;
}

export interface IncidentRow extends Required<
    Omit<IncidentFact, "paymentId" | "refundId" | "coldTransferId">
> {
    id: number;
    paymentId: string | null;
    refundId: number | null;
    coldTransferId: number | null;
    createdAt: Date;
    resolvedAt: Date | null;
    resolution: string | null;
}

const orNull = (v: string | null): number | null => (v === null ? null : Number(v));

interface Row {
    id: string;
    kind: IncidentKind;
    subject: string;
    loss_micros: string;
    payment_id: string | null;
    refund_id: string | null;
    cold_transfer_id: string | null;
    detail: Record<string, unknown>;
    created_at: Date;
    resolved_at: Date | null;
    resolution: string | null;
}

function toIncident(r: Row): IncidentRow {
    return {
        id: Number(r.id),
        kind: r.kind,
        subject: r.subject,
        lossMicros: Number(r.loss_micros),
        paymentId: r.payment_id,
        refundId: orNull(r.refund_id),
        coldTransferId: orNull(r.cold_transfer_id),
        detail: r.detail,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
        resolution: r.resolution,
    };
}

export async function recordIncident(
    c: pg.PoolClient,
    f: IncidentFact,
    log: Log,
    at: Date,
): Promise<boolean> {
    const lossMicros = f.lossMicros ?? 0;
    const { rows } = await c.query<{ id: string }>(
        `insert into x402_incidents (kind, subject, loss_micros, payment_id, refund_id,
            cold_transfer_id, detail, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (kind, subject) where resolved_at is null do nothing
         returning id`,
        [
            f.kind,
            f.subject,
            lossMicros,
            f.paymentId ?? null,
            f.refundId ?? null,
            f.coldTransferId ?? null,
            JSON.stringify(f.detail),
            at,
        ],
    );
    if (rows.length === 0) return false;
    await c.query(
        "update x402_controls set paused = true, reason = $1, changed_at = $2 where id = 1",
        [`incident ${f.kind}`, at],
    );
    log.alarm("x402_incident", {
        kind: f.kind,
        subject: f.subject,
        incidentId: Number(rows[0]!.id),
        lossMicros,
    });
    return true;
}

export async function openIncidents(db: Queryable): Promise<IncidentRow[]> {
    const { rows } = await db.query<Row>(
        "select * from x402_incidents where resolved_at is null order by id",
    );
    return rows.map(toIncident);
}

export async function resolveIncident(
    db: Queryable,
    id: number,
    finding: string,
    at: Date,
): Promise<boolean> {
    const { rowCount } = await db.query(
        "update x402_incidents set resolved_at = $2, resolution = $3 where id = $1 and resolved_at is null",
        [id, at, finding],
    );
    return rowCount === 1;
}
