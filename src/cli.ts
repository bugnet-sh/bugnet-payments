import type pg from "pg";
import { loadSettings } from "./config.ts";
import { createPool, withTx } from "./db/pool.ts";
import { jsonLog } from "./log.ts";
import { isOrderId } from "./orders/ids.ts";
import { findOrder, lockOrder, setOrderState } from "./orders/store.ts";
import type { OrderRow } from "./orders/types.ts";
import { refundsPaused, resumeRefunds } from "./refunds/executor.ts";
import { findRefund, requestRefund, returnManualToRedeemed } from "./refunds/request.ts";

export interface CliIo {
    out: (s: string) => void;
    err: (s: string) => void;
}

const DEFAULT_CONFIG = "config/dev.toml";
const DISMISSABLE = ["no_event_unverifiable", "abandon_unverifiable"];
const IN_FLIGHT = ["pending", "signed", "sent"];

const USAGE = [
    "usage: cli [-config FILE] <command>",
    "  manual list               id, reason, amount, payer, destination of each manual order",
    "  manual retry <orderId>    refund a manual order again",
    "  manual dismiss <orderId>  the router holds a parked order, return it to redeemed",
    "  manual resolve <orderId>  the refund was done by hand, mark the order refunded",
    "  refunds status",
    "  refunds resume",
].join("\n");

interface DbCommand {
    takesOrderId: boolean;
    run(pool: pg.Pool, io: CliIo, orderId: string): Promise<number>;
}

const DB_COMMANDS = new Map<string, DbCommand>([
    ["manual list", { takesOrderId: false, run: listManual }],
    ["manual retry", { takesOrderId: true, run: retryManual }],
    ["manual dismiss", { takesOrderId: true, run: dismissManual }],
    ["manual resolve", { takesOrderId: true, run: resolveManual }],
    ["refunds status", { takesOrderId: false, run: refundsStatus }],
    ["refunds resume", { takesOrderId: false, run: refundsResume }],
]);

export async function cliMain(argv: string[], _env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
    const args = splitConfig(argv);
    if (args === null) return usage(io, "-config needs a file");
    const [group, action, ...rest] = args.words;
    const cmd = DB_COMMANDS.get(`${group} ${action}`);
    if (cmd === undefined || rest.length !== (cmd.takesOrderId ? 1 : 0)) return usage(io);
    const orderId = rest[0] ?? "";
    if (cmd.takesOrderId && !isOrderId(orderId)) {
        return usage(io, `${JSON.stringify(orderId)} is not an order id`);
    }
    let pool: pg.Pool | undefined;
    try {
        const settings = loadSettings(args.config);
        pool = createPool(settings.database.url, jsonLog("payments-cli", { write: io.err }));
        return await cmd.run(pool, io, orderId);
    } catch (err) {
        io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    } finally {
        await pool?.end();
    }
}

function splitConfig(argv: readonly string[]): { config: string; words: string[] } | null {
    const at = argv.findIndex((a) => a === "-config" || a === "--config");
    if (at === -1) return { config: DEFAULT_CONFIG, words: [...argv] };
    const config = argv[at + 1];
    if (config === undefined) return null;
    return { config, words: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

function usage(io: CliIo, problem?: string): number {
    if (problem !== undefined) io.err(problem);
    io.err(USAGE);
    return 2;
}

function refuse(io: CliIo, orderId: string, why: string): number {
    io.err(`${orderId}: ${why}`);
    return 1;
}

function notManual(order: OrderRow | null): string | null {
    if (order === null) return "unknown order";
    if (order.state !== "manual") return `not in the manual queue (state ${order.state})`;
    return null;
}

async function listManual(pool: pg.Pool, io: CliIo): Promise<number> {
    const res = await pool.query<{
        id: string;
        reason: string | null;
        amount: string | null;
        payer: string | null;
        destination: string | null;
    }>(
        `select o.id, coalesce(o.manual_reason, r.manual_reason) as reason,
            coalesce(r.amount_micros, p.amount_micros, o.amount_micros)::text as amount,
            coalesce(r.payer, p.payer, o.payer) as payer,
            coalesce(r.destination, p.source_token_account) as destination
         from orders o
         left join payments p on p.order_id = o.id
         left join lateral (
            select * from refunds where order_id = o.id order by id limit 1
         ) r on true
         where o.state = 'manual'
         order by o.created_at, o.id`,
    );
    for (const row of res.rows) {
        const cells = [row.id, row.reason, row.amount, row.payer, row.destination];
        io.out(cells.map((c) => c ?? "-").join("\t"));
    }
    return 0;
}

async function retryManual(pool: pg.Pool, io: CliIo, orderId: string): Promise<number> {
    const outcome = await withTx(
        pool,
        async (c): Promise<{ refused: string } | "reset" | "no_refund"> => {
            const refused = notManual(await lockOrder(c, orderId));
            if (refused !== null) return { refused };
            const refund = await findRefund(c, orderId);
            if (refund === null) return "no_refund";
            if (refund.state !== "manual") return { refused: `its refund is ${refund.state}` };
            await c.query(
                `update refunds set state = 'pending', attempts = 0, manual_reason = null
                 where id = $1`,
                [refund.id],
            );
            await setOrderState(c, orderId, "manual", "refunding", { manualReason: null });
            return "reset";
        },
    );
    if (typeof outcome === "object") return refuse(io, orderId, outcome.refused);
    if (outcome === "no_refund") {
        const created = await requestRefund(pool, orderId, "operator");
        if (created !== "created") return refuse(io, orderId, `no refund created (${created})`);
    }
    io.out(`${orderId}: refunding`);
    return 0;
}

async function dismissManual(pool: pg.Pool, io: CliIo, orderId: string): Promise<number> {
    const order = await findOrder(pool, orderId);
    const refused = notManual(order);
    if (refused !== null) return refuse(io, orderId, refused);
    const reason = order?.manualReason ?? null;
    if (reason === null || !DISMISSABLE.includes(reason)) {
        const allowed = DISMISSABLE.join(" or ");
        return refuse(io, orderId, `manual_reason ${reason} cannot be dismissed, only ${allowed}`);
    }
    if (!(await returnManualToRedeemed(pool, orderId, new Date(), DISMISSABLE))) {
        return refuse(io, orderId, "changed while dismissing or has a refund row");
    }
    io.out(`${orderId}: redeemed`);
    return 0;
}

async function resolveManual(pool: pg.Pool, io: CliIo, orderId: string): Promise<number> {
    const refused = await withTx(pool, async (c) => {
        const notInQueue = notManual(await lockOrder(c, orderId));
        if (notInQueue !== null) return notInQueue;
        const refund = await findRefund(c, orderId);
        if (refund !== null && IN_FLIGHT.includes(refund.state)) {
            return `its refund is ${refund.state} and the executor still owns it`;
        }
        await setOrderState(c, orderId, "manual", "refunded");
        return null;
    });
    if (refused !== null) return refuse(io, orderId, refused);
    io.out(`${orderId}: refunded`);
    return 0;
}

async function refundsStatus(pool: pg.Pool, io: CliIo): Promise<number> {
    const paused = await refundsPaused(pool);
    io.out(paused === null ? "refunds running" : `refunds paused: ${paused}`);
    return 0;
}

async function refundsResume(pool: pg.Pool, io: CliIo): Promise<number> {
    await resumeRefunds(pool);
    io.out("refunds resumed");
    return 0;
}

if (import.meta.main) {
    process.exitCode = await cliMain(process.argv.slice(2), process.env, {
        out: (s) => process.stdout.write(`${s}\n`),
        err: (s) => process.stderr.write(`${s}\n`),
    });
}
