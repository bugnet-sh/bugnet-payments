import { address } from "@solana/kit";
import type pg from "pg";
import { loadSettings, secretValues, type Settings } from "./config.ts";
import { createPool, withTx } from "./db/pool.ts";
import { isKeysCommand, KEYS_USAGE, runKeys } from "./keys/commands.ts";
import { jsonLog, type Log } from "./log.ts";
import { isOrderId } from "./orders/ids.ts";
import { findOrder, lockOrder, setOrderState } from "./orders/store.ts";
import type { OrderRow } from "./orders/types.ts";
import { refundsPaused, resumeRefunds } from "./refunds/executor.ts";
import { resolveHotRefundByHand, writeHotPartial } from "./refunds/hot.ts";
import {
    findOrderRefund,
    findRefundById,
    type RefundRow,
    requestRefund,
    returnManualToRedeemed,
} from "./refunds/request.ts";
import { usdcAta } from "./solana/accounts.ts";
import { isCanonicalAddress, isCanonicalSignature } from "./solana/base58.ts";
import { createRpc, type SolanaRpc } from "./solana/rpc.ts";
import { blockPayTo, readControls, setControls, unblockPayTo } from "./x402/controls.ts";
import { type AllowanceFunding, createAllowanceFunding } from "./x402/funding.ts";
import { openIncidents, resolveIncident } from "./x402/incidents.ts";
import { SERVICE_ID } from "./x402/ids.ts";
import { type ResignProof, resignProof } from "./x402/resign.ts";
import { x402Status } from "./x402/status.ts";

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
    "  manual list                              orders, then hot-wallet rows as 'refund' lines",
    "  manual retry <orderId>                   refund a manual order again",
    "  manual retry <refundId>                  hot-wallet row back to pending once its last",
    "                                           transaction is proven absent",
    "  manual refund <orderId> <amount_micros>  refund this much of a manual order's payment",
    "  manual dismiss <orderId>                 router holds the parked order, back to redeemed",
    "  manual resolve <orderId>                 refund done by hand, mark the order refunded",
    "  manual resolve <refundId> [--tx <signature>]",
    "                                           refund-wallet row: mark it done by hand;",
    "                                           allowance-wallet row: record the transfer",
    "  refunds status",
    "  refunds resume",
    "  x402 pause <reason>                      stop new x402 payments",
    "  x402 resume                              allow them again; refused while an incident is open",
    "  x402 kill                                disable x402 payments",
    "  x402 unkill                              enable them again",
    "  x402 block-payto <address> <reason>      refuse payments to this address",
    "  x402 unblock-payto <address>",
    "  x402 service reset <accountId> <serviceId>",
    "                                           make an unreliable service enabled again",
    "  x402 refunds hold                        hold the allowance-wallet refunds",
    "  x402 refunds release",
    "  x402 incident list                       the open incidents",
    "  x402 incident resolve <id> <finding>     close an incident with what was found",
    "  x402 status                              controls, pool, balances and open facts",
    KEYS_USAGE,
].join("\n");

type Param =
    | "orderId"
    | "amountMicros"
    | "refundId"
    | "orderOrRefund"
    | "text"
    | "address"
    | "accountId"
    | "serviceId"
    | "incidentId";

const isCount = (s: string): boolean => /^[1-9][0-9]*$/.test(s) && Number.isSafeInteger(Number(s));

const PARAMS: Record<Param, { valid: (s: string) => boolean; what: string }> = {
    orderId: { valid: isOrderId, what: "an order id" },
    amountMicros: { valid: isCount, what: "a positive whole number of micro-USDC" },
    refundId: { valid: isCount, what: "a refund id" },
    orderOrRefund: {
        valid: (s) => isOrderId(s) || isCount(s),
        what: "an order id or a refund id",
    },
    text: {
        valid: (s) => s.length >= 1 && s.length <= 200 && !/\p{Cc}/u.test(s),
        what: "1 to 200 characters without control characters",
    },
    address: { valid: (s) => s !== "", what: "an address" },
    accountId: { valid: isOrderId, what: "an account id" },
    serviceId: { valid: (s) => SERVICE_ID.test(s), what: "a service id" },
    incidentId: { valid: isCount, what: "an incident id" },
};

export interface CliOptions {
    rpc?: SolanaRpc;
    now?: () => Date;
}

interface CliContext {
    pool: pg.Pool;
    settings: Settings;
    log: Log;
    now: () => Date;
    funding: AllowanceFunding;
    rpc(): SolanaRpc;
    rpcOrNull(): SolanaRpc | null;
}

interface DbCommand {
    params: readonly Param[];
    flags?: readonly "--tx"[];
    run(
        ctx: CliContext,
        io: CliIo,
        args: readonly string[],
        flags: { tx?: string },
    ): Promise<number>;
}

const DB_COMMANDS = new Map<string, DbCommand>([
    ["manual list", { params: [], run: listManual }],
    ["manual retry", { params: ["orderOrRefund"], run: retryManual }],
    ["manual refund", { params: ["orderId", "amountMicros"], run: refundManual }],
    ["manual dismiss", { params: ["orderId"], run: dismissManual }],
    ["manual resolve", { params: ["orderOrRefund"], flags: ["--tx"], run: resolveManual }],
    ["refunds status", { params: [], run: refundsStatus }],
    ["refunds resume", { params: [], run: refundsResume }],
    ["x402 pause", { params: ["text"], run: x402Pause }],
    ["x402 resume", { params: [], run: x402Resume }],
    ["x402 kill", { params: [], run: x402Kill }],
    ["x402 unkill", { params: [], run: x402Unkill }],
    ["x402 block-payto", { params: ["address", "text"], run: x402Block }],
    ["x402 unblock-payto", { params: ["address"], run: x402Unblock }],
    ["x402 service reset", { params: ["accountId", "serviceId"], run: x402ServiceReset }],
    ["x402 refunds hold", { params: [], run: x402RefundsHold }],
    ["x402 refunds release", { params: [], run: x402RefundsRelease }],
    ["x402 incident list", { params: [], run: x402IncidentList }],
    ["x402 incident resolve", { params: ["incidentId", "text"], run: x402IncidentResolve }],
    ["x402 status", { params: [], run: x402StatusCommand }],
]);

export async function cliMain(
    argv: string[],
    env: NodeJS.ProcessEnv,
    io: CliIo,
    o: CliOptions = {},
): Promise<number> {
    const args = splitConfig(argv);
    if (args === null) return usage(io, "-config needs a file");
    const [group, action, ...keysWords] = args.words;
    if (isKeysCommand(group)) return runKeys(action, keysWords, env, io);
    let cmd: DbCommand | undefined;
    let used = 0;
    for (const n of [3, 2]) {
        cmd = DB_COMMANDS.get(args.words.slice(0, n).join(" "));
        used = n;
        if (cmd !== undefined) break;
    }
    if (cmd === undefined) return usage(io);
    let rest = args.words.slice(used);
    const flags: { tx?: string } = {};
    if (cmd.flags?.includes("--tx")) {
        const at = rest.indexOf("--tx");
        if (at !== -1) {
            const value = rest[at + 1];
            if (value === undefined) return usage(io, "--tx needs a signature");
            flags.tx = value;
            rest = [...rest.slice(0, at), ...rest.slice(at + 2)];
        }
    }
    if (rest.length !== cmd.params.length) return usage(io);
    for (const [i, param] of cmd.params.entries()) {
        const { valid, what } = PARAMS[param];
        if (!valid(rest[i]!)) return usage(io, `${JSON.stringify(rest[i])} is not ${what}`);
    }
    let pool: pg.Pool | undefined;
    try {
        const settings = loadSettings(args.config);
        const log = jsonLog("payments-cli", { secrets: secretValues(env), write: io.err });
        pool = createPool(settings.database.url, log);
        const url = env.BUGNET_SOLANA_RPC_URL ?? "";
        const ctx: CliContext = {
            pool,
            settings,
            log,
            now: o.now ?? (() => new Date()),
            funding: createAllowanceFunding({ x402: settings.x402, log }),
            rpc() {
                if (o.rpc !== undefined) return o.rpc;
                if (url === "") throw new Error("BUGNET_SOLANA_RPC_URL must be set");
                return createRpc(url);
            },
            rpcOrNull() {
                return o.rpc ?? (url === "" ? null : createRpc(url));
            },
        };
        return await cmd.run(ctx, io, rest, flags);
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

const BY_HAND = "resolved_by_hand";
const NOT_ABSENT = "its last transaction is not yet proven absent";

function refuseRefund(io: CliIo, refundId: number, why: string): number {
    io.err(`refund ${refundId}: ${why}`);
    return 1;
}

// A hot-wallet row the refund-id commands manage; every other row has an order-level command
async function isListed(pool: pg.Pool, r: RefundRow): Promise<boolean> {
    if (r.state !== "manual" || r.manualReason === BY_HAND) return false;
    if (r.kind === "allowance") return true;
    if (r.kind !== "partial") return false;
    return (await findOrder(pool, r.orderId))?.payInto === "allowance";
}

// The first two refusals every refund-id command shares
async function refundForId(ctx: CliContext, io: CliIo, id: number): Promise<RefundRow | null> {
    const r = await findRefundById(ctx.pool, id);
    if (r === null) {
        refuseRefund(io, id, "unknown refund");
        return null;
    }
    if (r.manualReason === BY_HAND) {
        refuseRefund(io, id, "resolved by hand");
        return null;
    }
    return r;
}

async function proofOf(ctx: CliContext, r: RefundRow): Promise<ResignProof> {
    if (r.txSignature === null) return "absent";
    return resignProof(
        ctx.pool,
        ctx.rpc(),
        { signatures: [r.txSignature, ...r.previousSignatures], expirySeenSlot: r.expirySeenSlot },
        ctx.settings.x402,
        ctx.settings.solana.rpc_timeout,
    );
}

// What a proof was about, so the operator's change is applied only to the row that was proven
const provenKey = (r: RefundRow): string =>
    [r.txSignature, ...r.previousSignatures, r.expirySeenSlot].join(",");

async function listManual(ctx: CliContext, io: CliIo): Promise<number> {
    const res = await ctx.pool.query<{
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
            select * from refunds where order_id = o.id and kind in ('full', 'partial')
            order by id limit 1
         ) r on true
         where o.state = 'manual'
         order by o.created_at, o.id`,
    );
    for (const row of res.rows) {
        const amount = row.reason !== null && NEEDS_AMOUNT.includes(row.reason) ? null : row.amount;
        const cells = [row.id, row.reason, amount, row.payer, row.destination];
        io.out(cells.map((c) => c ?? "-").join("\t"));
    }
    const rows = await ctx.pool.query<{
        id: string;
        kind: string;
        from_wallet: string;
        manual_reason: string | null;
        amount: string;
        destination: string;
    }>(
        `select r.id, r.kind, r.from_wallet, r.manual_reason, r.amount_micros::text as amount,
            r.destination
         from refunds r join orders o on o.id = r.order_id
         where r.state = 'manual' and r.manual_reason is distinct from 'resolved_by_hand'
            and (r.kind = 'allowance' or (r.kind = 'partial' and o.pay_into = 'allowance'))
         order by r.id`,
    );
    for (const r of rows.rows) {
        const cells = [
            "refund",
            r.id,
            r.kind,
            r.from_wallet,
            r.manual_reason,
            r.amount,
            r.destination,
        ];
        io.out(cells.map((c) => c ?? "-").join("\t"));
    }
    return 0;
}

async function retryManual(
    ctx: CliContext,
    io: CliIo,
    [arg = ""]: readonly string[],
): Promise<number> {
    return isOrderId(arg) ? retryOrder(ctx, io, arg) : retryRefund(ctx, io, Number(arg));
}

async function retryRefund(ctx: CliContext, io: CliIo, id: number): Promise<number> {
    const r = await refundForId(ctx, io, id);
    if (r === null) return 1;
    if (!(await isListed(ctx.pool, r))) return refuseRefund(io, id, "use the order-level command");
    if (r.fromWallet === "allowance" && (await proofOf(ctx, r)) !== "absent") {
        return refuseRefund(io, id, NOT_ABSENT);
    }
    const res = await ctx.pool.query(
        `update refunds set state = 'pending', attempts = 0, budget_waived = true,
            manual_reason = null
         where id = $1 and state = 'manual' and manual_reason is distinct from 'resolved_by_hand'`,
        [id],
    );
    if (res.rowCount !== 1) return refuseRefund(io, id, "changed while retrying");
    io.out(`refund ${id}: pending`);
    return 0;
}

async function retryOrder(ctx: CliContext, io: CliIo, orderId: string): Promise<number> {
    const { pool } = ctx;
    const seen = await findOrder(pool, orderId);
    const peek = seen === null ? null : await findOrderRefund(pool, orderId);
    let proven: string | null = null;
    if (
        seen?.state === "manual" &&
        seen.payInto === "allowance" &&
        peek?.kind === "full" &&
        peek.state === "manual" &&
        peek.fromWallet === "allowance" &&
        peek.manualReason !== BY_HAND
    ) {
        if ((await proofOf(ctx, peek)) !== "absent") return refuse(io, orderId, NOT_ABSENT);
        proven = provenKey(peek);
    }
    const outcome = await withTx(
        pool,
        async (
            c,
        ): Promise<{ refused: string } | { noRefund: { coldShare: boolean } } | "reset"> => {
            const order = await lockOrder(c, orderId);
            const hot = order?.payInto === "allowance";
            const refund = order === null ? null : await findOrderRefund(c, orderId);
            if (refund?.manualReason === BY_HAND) return { refused: "resolved by hand" };
            if (hot && refund?.kind === "partial") {
                return { refused: `hot-wallet refund: use manual retry ${refund.id}` };
            }
            const refused = notManual(order);
            if (refused !== null || order === null) return { refused: refused ?? "unknown order" };
            if (needsAmount(order)) {
                return {
                    refused:
                        `manual_reason ${order.manualReason} has no refund amount, ` +
                        `use manual refund ${orderId} <amount_micros>`,
                };
            }
            if (refund === null)
                return { noRefund: { coldShare: hot && order.coldTransferId !== null } };
            if (refund.state !== "manual") return { refused: `its refund is ${refund.state}` };
            if (hot && refund.fromWallet === "allowance" && proven !== provenKey(refund)) {
                return { refused: "changed while retrying" };
            }
            await c.query(
                `update refunds set state = 'pending', attempts = 0, manual_reason = null,
                    budget_waived = budget_waived or $2
                 where id = $1`,
                [refund.id, hot],
            );
            await setOrderState(c, orderId, "manual", "refunding", { manualReason: null });
            return "reset";
        },
    );
    if (outcome !== "reset" && "refused" in outcome) return refuse(io, orderId, outcome.refused);
    if (outcome !== "reset") {
        const created = await requestRefund(pool, orderId, "operator", {
            eligible: (o) => o.state === "manual" && !needsAmount(o),
            funding: ctx.funding,
            at: ctx.now(),
            log: ctx.log,
        });
        if (created === "not_refundable" && outcome.noRefund.coldShare) {
            return refuse(io, orderId, "share already transferred to cold; refund by hand");
        }
        if (created !== "created") return refuse(io, orderId, `no refund created (${created})`);
    }
    io.out(`${orderId}: refunding`);
    return 0;
}

async function refundManual(
    ctx: CliContext,
    io: CliIo,
    [orderId = "", amount = ""]: readonly string[],
): Promise<number> {
    const order = await findOrder(ctx.pool, orderId);
    const refused = notManual(order);
    if (refused !== null || order === null) return refuse(io, orderId, refused ?? "unknown order");
    const hot = order.payInto === "allowance";
    const created = hot
        ? await writeHotPartial(ctx.pool, orderId, Number(amount), ctx.now(), {
              budgetWaived: true,
              log: ctx.log,
          })
        : await requestRefund(ctx.pool, orderId, "operator", {
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
            return refuse(
                io,
                orderId,
                hot
                    ? `invalid_amount: above amount_micros - allowance_micros ` +
                          `(${order.amountMicros - order.allowanceMicros})`
                    : `${amount} micros is more than the payment`,
            );
        default:
            return refuse(io, orderId, `no refund created (${created})`);
    }
}

async function dismissManual(
    ctx: CliContext,
    io: CliIo,
    [orderId = ""]: readonly string[],
): Promise<number> {
    const { pool } = ctx;
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
    ctx: CliContext,
    io: CliIo,
    [arg = ""]: readonly string[],
    flags: { tx?: string },
): Promise<number> {
    if (!isOrderId(arg)) return resolveRefund(ctx, io, Number(arg), flags.tx);
    const refused = await withTx(ctx.pool, async (c) => {
        const order = await lockOrder(c, arg);
        const refund = order === null ? null : await findOrderRefund(c, arg);
        if (order?.payInto === "allowance" && refund !== null) {
            return `hot-wallet refund: use manual resolve ${refund.id}`;
        }
        const notInQueue = notManual(order);
        if (notInQueue !== null) return notInQueue;
        if (refund !== null && IN_FLIGHT.includes(refund.state)) {
            return `its refund is ${refund.state} and the executor still owns it`;
        }
        // The row stays manual, and this reason keeps anything from reading it as paid
        if (refund !== null) {
            await c.query("update refunds set manual_reason = 'resolved_by_hand' where id = $1", [
                refund.id,
            ]);
        }
        await setOrderState(c, arg, "manual", "refunded");
        return null;
    });
    if (refused !== null) return refuse(io, arg, refused);
    io.out(`${arg}: refunded`);
    return 0;
}

async function resolveRefund(
    ctx: CliContext,
    io: CliIo,
    id: number,
    tx: string | undefined,
): Promise<number> {
    const { pool } = ctx;
    const r = await refundForId(ctx, io, id);
    if (r === null) return 1;
    if (tx === undefined) {
        if (!(await isListed(pool, r))) return refuseRefund(io, id, "use the order-level command");
        if (r.fromWallet === "allowance") {
            return refuseRefund(
                io,
                id,
                `an allowance-wallet row: use manual resolve ${id} --tx <signature>`,
            );
        }
        const res = await pool.query(
            `update refunds set manual_reason = 'resolved_by_hand'
             where id = $1 and state = 'manual' and from_wallet = 'refund'`,
            [id],
        );
        if (res.rowCount !== 1) return refuseRefund(io, id, "changed while resolving");
        io.out(`refund ${id}: resolved by hand`);
        return 0;
    }
    if (r.fromWallet !== "allowance") {
        return refuseRefund(io, id, `a refund-wallet row: use manual resolve ${id} without --tx`);
    }
    if (!isCanonicalSignature(tx)) return refuseRefund(io, id, "not a 64-byte signature");
    if (r.state === "manual") {
        if ((await proofOf(ctx, r)) !== "absent") return refuseRefund(io, id, NOT_ABSENT);
    } else if (r.state === "pending") {
        if (!(await readControls(pool)).refundsHeld) {
            return refuseRefund(io, id, "pending rows only while refunds are held");
        }
    } else {
        return refuseRefund(io, id, `its refund is ${r.state} and the executor still owns it`);
    }
    const done = await withTx(pool, (c) =>
        resolveHotRefundByHand(c, id, tx, ctx.now(), ctx.settings.x402, ctx.log),
    );
    if (!done) return refuseRefund(io, id, "changed while resolving");
    io.out(`refund ${id}: resolved by hand`);
    return 0;
}

async function refundsStatus(ctx: CliContext, io: CliIo): Promise<number> {
    const paused = await refundsPaused(ctx.pool);
    io.out(paused === null ? "refunds running" : `refunds paused: ${paused}`);
    return 0;
}

async function refundsResume(ctx: CliContext, io: CliIo): Promise<number> {
    await resumeRefunds(ctx.pool);
    io.out("refunds resumed");
    return 0;
}

async function x402Pause(
    ctx: CliContext,
    io: CliIo,
    [reason = ""]: readonly string[],
): Promise<number> {
    await setControls(ctx.pool, { paused: true }, reason, ctx.now());
    io.out("x402 paused");
    return 0;
}

async function x402Resume(ctx: CliContext, io: CliIo): Promise<number> {
    const refused = await withTx(ctx.pool, async (c) => {
        // recordIncident updates this row, so the check and the resume cannot interleave with one
        await c.query("select 1 from x402_controls where id = 1 for update");
        const [oldest] = await openIncidents(c);
        if (oldest !== undefined) return `unresolved incident ${oldest.id} ${oldest.kind}`;
        await setControls(c, { paused: false }, null, ctx.now());
        return null;
    });
    if (refused !== null) {
        io.err(refused);
        return 1;
    }
    io.out("x402 resumed");
    return 0;
}

async function x402Kill(ctx: CliContext, io: CliIo): Promise<number> {
    await setControls(ctx.pool, { disabled: true }, "x402 kill", ctx.now());
    io.out("x402 killed");
    return 0;
}

async function x402Unkill(ctx: CliContext, io: CliIo): Promise<number> {
    await setControls(ctx.pool, { disabled: false }, null, ctx.now());
    io.out("x402 unkilled");
    return 0;
}

async function x402Block(
    ctx: CliContext,
    io: CliIo,
    [payTo = "", reason = ""]: readonly string[],
): Promise<number> {
    if (!isCanonicalAddress(payTo)) {
        io.err(`${JSON.stringify(payTo)} is not a 32-byte address`);
        return 1;
    }
    await blockPayTo(ctx.pool, payTo, reason);
    io.out(`${payTo}: blocked`);
    return 0;
}

async function x402Unblock(
    ctx: CliContext,
    io: CliIo,
    [payTo = ""]: readonly string[],
): Promise<number> {
    io.out(
        (await unblockPayTo(ctx.pool, payTo)) ? `${payTo}: unblocked` : `${payTo}: was not blocked`,
    );
    return 0;
}

async function x402ServiceReset(
    ctx: CliContext,
    io: CliIo,
    [accountId = "", serviceId = ""]: readonly string[],
): Promise<number> {
    const res = await ctx.pool.query(
        `update x402_services set state = 'enabled', failures = 0, updated_at = $3
         where account_id = $1 and service_id = $2`,
        [accountId, serviceId, ctx.now()],
    );
    if (res.rowCount !== 1) {
        io.err(`${accountId} ${serviceId}: unknown service`);
        return 1;
    }
    io.out(`${serviceId}: enabled`);
    return 0;
}

async function x402RefundsHold(ctx: CliContext, io: CliIo): Promise<number> {
    await setControls(ctx.pool, { refundsHeld: true }, "x402 refunds hold", ctx.now());
    io.out("x402 refunds held");
    return 0;
}

async function x402RefundsRelease(ctx: CliContext, io: CliIo): Promise<number> {
    await setControls(ctx.pool, { refundsHeld: false }, null, ctx.now());
    io.out("x402 refunds released");
    return 0;
}

async function x402IncidentList(ctx: CliContext, io: CliIo): Promise<number> {
    for (const i of await openIncidents(ctx.pool)) {
        io.out(
            [
                i.id,
                i.kind,
                i.subject,
                i.lossMicros,
                i.createdAt.toISOString(),
                JSON.stringify(i.detail),
            ].join("\t"),
        );
    }
    return 0;
}

async function x402IncidentResolve(
    ctx: CliContext,
    io: CliIo,
    [id = "", finding = ""]: readonly string[],
): Promise<number> {
    if (!(await resolveIncident(ctx.pool, Number(id), finding, ctx.now()))) {
        io.err(`incident ${id}: unknown or resolved incident`);
        return 1;
    }
    io.out(`incident ${id}: resolved`);
    return 0;
}

async function x402StatusCommand(ctx: CliContext, io: CliIo): Promise<number> {
    const wallet = ctx.settings.x402.allowance_wallet;
    const hot = wallet === "" ? null : await usdcAta(address(wallet));
    for (const line of await x402Status(
        ctx.pool,
        ctx.rpcOrNull(),
        hot,
        ctx.settings.x402,
        ctx.now(),
    )) {
        io.out(line);
    }
    return 0;
}

if (import.meta.main) {
    process.exitCode = await cliMain(process.argv.slice(2), process.env, {
        out: (s) => process.stdout.write(`${s}\n`),
        err: (s) => process.stderr.write(`${s}\n`),
    });
}
