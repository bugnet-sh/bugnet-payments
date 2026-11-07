import type pg from "pg";
import { loadSettings } from "./config.ts";
import { createPool, withTx } from "./db/pool.ts";
import { isKeysCommand, KEYS_USAGE, runKeys } from "./keys/commands.ts";
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
// The router never said how much of these to refund, so a full refund could overpay
const NEEDS_AMOUNT = ["refund_amount_pending", "refund_amount_invalid"];

const USAGE = [
    "usage: cli [-config FILE] <command>",
    "  manual list                              id, reason, amount, payer, destination per order",
    "  manual retry <orderId>                   refund a manual order again",
    "  manual refund <orderId> <amount_micros>  refund this much of a manual order's payment",
    "  manual dismiss <orderId>                 router holds the parked order, back to redeemed",
    "  manual resolve <orderId>                 refund done by hand, mark the order refunded",
    "  refunds status",
    "  refunds resume",
    KEYS_USAGE,
].join("\n");

type Param = "orderId" | "amountMicros";

const PARAMS: Record<Param, { valid: (s: string) => boolean; what: string }> = {
    orderId: { valid: isOrderId, what: "an order id" },
    amountMicros: {
        valid: (s) => /^[1-9][0-9]*$/.test(s) && Number.isSafeInteger(Number(s)),
        what: "a positive whole number of micro-USDC",
    },
};

interface DbCommand {
    params: readonly Param[];
    run(pool: pg.Pool, io: CliIo, args: readonly string[]): Promise<number>;
}

const DB_COMMANDS = new Map<string, DbCommand>([
    ["manual list", { params: [], run: listManual }],
    ["manual retry", { params: ["orderId"], run: retryManual }],
    ["manual refund", { params: ["orderId", "amountMicros"], run: refundManual }],
    ["manual dismiss", { params: ["orderId"], run: dismissManual }],
    ["manual resolve", { params: ["orderId"], run: resolveManual }],
    ["refunds status", { params: [], run: refundsStatus }],
    ["refunds resume", { params: [], run: refundsResume }],
]);

export async function cliMain(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
    const args = splitConfig(argv);
    if (args === null) return usage(io, "-config needs a file");
    const [group, action, ...rest] = args.words;
    if (isKeysCommand(group)) return runKeys(action, rest, args.config, env, io);
    const cmd = DB_COMMANDS.get(`${group} ${action}`);
    if (cmd === undefined || rest.length !== cmd.params.length) return usage(io);
    for (const [i, param] of cmd.params.entries()) {
        const { valid, what } = PARAMS[param];
        if (!valid(rest[i]!)) return usage(io, `${JSON.stringify(rest[i])} is not ${what}`);
    }
    let pool: pg.Pool | undefined;
    try {
        const settings = loadSettings(args.config);
        pool = createPool(settings.database.url, jsonLog("payments-cli", { write: io.err }));
        return await cmd.run(pool, io, rest);
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

function needsAmount(order: OrderRow): boolean {
    return order.manualReason !== null && NEEDS_AMOUNT.includes(order.manualReason);
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
        const amount = row.reason !== null && NEEDS_AMOUNT.includes(row.reason) ? null : row.amount;
        const cells = [row.id, row.reason, amount, row.payer, row.destination];
        io.out(cells.map((c) => c ?? "-").join("\t"));
    }
    return 0;
}

async function retryManual(
    pool: pg.Pool,
    io: CliIo,
    [orderId = ""]: readonly string[],
): Promise<number> {
    const outcome = await withTx(
        pool,
        async (c): Promise<{ refused: string } | "reset" | "no_refund"> => {
            const order = await lockOrder(c, orderId);
            const refused = notManual(order);
            if (refused !== null) return { refused };
            if (order !== null && needsAmount(order)) {
                return {
                    refused:
                        `manual_reason ${order.manualReason} has no refund amount, ` +
                        `use manual refund ${orderId} <amount_micros>`,
                };
            }
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
        const created = await requestRefund(pool, orderId, "operator", {
            eligible: (o) => o.state === "manual" && !needsAmount(o),
        });
        if (created !== "created") return refuse(io, orderId, `no refund created (${created})`);
    }
    io.out(`${orderId}: refunding`);
    return 0;
}

async function refundManual(
    pool: pg.Pool,
    io: CliIo,
    [orderId = "", amount = ""]: readonly string[],
): Promise<number> {
    const refused = notManual(await findOrder(pool, orderId));
    if (refused !== null) return refuse(io, orderId, refused);
    const created = await requestRefund(pool, orderId, "operator", {
        amountMicros: Number(amount),
        eligible: (o) => o.state === "manual",
    });
    switch (created) {
        case "created":
            io.out(`${orderId}: refunding ${amount} micros`);
            return 0;
        case "exists":
            return refuse(io, orderId, "already has a refund row, use manual retry");
        case "invalid_amount":
            return refuse(io, orderId, `${amount} micros is more than the payment`);
        default:
            return refuse(io, orderId, `no refund created (${created})`);
    }
}

async function dismissManual(
    pool: pg.Pool,
    io: CliIo,
    [orderId = ""]: readonly string[],
): Promise<number> {
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

async function resolveManual(
    pool: pg.Pool,
    io: CliIo,
    [orderId = ""]: readonly string[],
): Promise<number> {
    const refused = await withTx(pool, async (c) => {
        const notInQueue = notManual(await lockOrder(c, orderId));
        if (notInQueue !== null) return notInQueue;
        const refund = await findRefund(c, orderId);
        if (refund !== null && IN_FLIGHT.includes(refund.state)) {
            return `its refund is ${refund.state} and the executor still owns it`;
        }
        // The row stays manual, and this reason keeps anything from reading it as paid
        if (refund !== null) {
            await c.query("update refunds set manual_reason = 'resolved_by_hand' where id = $1", [
                refund.id,
            ]);
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
