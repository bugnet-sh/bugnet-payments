import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import {
    address,
    getBase58Encoder,
    getBase64EncodedWireTransaction,
    getPublicKeyFromAddress,
    getSignatureFromTransaction,
    type Instruction,
    type KeyPairSigner,
    type SignatureBytes,
    signature as toSignature,
    verifySignature,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCloseAccountInstruction } from "@solana-program/token";
import type pg from "pg";
import { isBase64Of32, loadSettings, rpcUrlsOf, secretValues, type Settings } from "./config.ts";
import { createPool, withTx, type Queryable } from "./db/pool.ts";
import { DepositKeys, depositKeysFrom } from "./deposits/keys.ts";
import { type CachedTx, classifyTx, createdBy, fetchTx, TxCache } from "./deposits/scan.ts";
import {
    depositLedger,
    findDeposit,
    lockDeposit,
    sharesOf,
    updateDeposit,
} from "./deposits/store.ts";
import type { DepositRow, NewTransfer, TransferRow } from "./deposits/types.ts";
import { isRecord } from "./is-record.ts";
import { isKeysCommand, KEYS_USAGE, runKeys, waitForLanding } from "./keys/commands.ts";
import { parseEnvText } from "./keys/tool.ts";
import { jsonLog, type Log, makeScrubber } from "./log.ts";
import { isOrderId } from "./orders/ids.ts";
import { findOrder, findPaymentByOrder, lockOrder, setOrderState } from "./orders/store.ts";
import type { OrderRow } from "./orders/types.ts";
import { refundsPaused, resumeRefunds } from "./refunds/executor.ts";
import { resolveHotRefundByHand, writeHotPartial } from "./refunds/hot.ts";
import {
    findOrderRefund,
    findRefundById,
    refundGroup,
    type RefundDbRow,
    type RefundRow,
    requestRefund,
    returnManualToRedeemed,
    toRefund,
} from "./refunds/request.ts";
import {
    groupComplete,
    insertDepositRefund,
    lockRefund,
    lockRefundGroup,
} from "./refunds/split.ts";
import { inspectTokenAccount, ownedUsdcAccount, usdcAta } from "./solana/accounts.ts";
import { isCanonicalAddress, isCanonicalSignature } from "./solana/base58.ts";
import { cliRouter, startOrStop } from "./solana/cli-router.ts";
import { MEMO_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "./solana/constants.ts";
import { loadKeypair } from "./solana/keys.ts";
import {
    domainOf,
    type CheckReport,
    type RouterDeps,
    type RouterSnapshot,
} from "./solana/router/index.ts";
import { deadline, type RoutedRpc, type SolanaRpc } from "./solana/rpc.ts";
import { readSnapshot } from "./solana/rpc-store.ts";
import { signV0Transaction, usdcTransferChecked } from "./solana/transfer.ts";
import { blockPayTo, readControls, setControls, unblockPayTo } from "./x402/controls.ts";
import { type AllowanceFunding, createAllowanceFunding } from "./x402/funding.ts";
import { openIncidents, resolveIncident } from "./x402/incidents.ts";
import { SERVICE_ID } from "./x402/ids.ts";
import { type ResignProof, resignProof } from "./x402/resign.ts";
import { ledgerCheck } from "./x402/ledger-check.ts";
import { x402Status } from "./x402/status.ts";

export interface CliIo {
    out: (s: string) => void;
    err: (s: string) => void;
    // All of standard input, for --archive -
    stdin?: () => Promise<string>;
}

const DEFAULT_CONFIG = "config/dev.toml";
const DISMISSABLE = ["no_event_unverifiable", "abandon_unverifiable"];
const IN_FLIGHT = ["pending", "signed", "sent"];
// The router never said how much of these to refund, so a full refund could overpay
const NEEDS_AMOUNT = ["refund_amount_pending", "refund_amount_invalid"];

const USAGE = [
    "usage: cli [-config FILE] <command>",
    "  manual list                              orders, then one 'refund' line per manual part",
    "  manual retry <orderId>                   refund a manual order again, every manual part",
    "  manual retry <refundId>                  one part back to pending; a hot-wallet row once its",
    "                                           last transaction is proven absent",
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
    "  x402 ledger-check <accountId>            check an account's rows against the chain",
    "  rpc status [--outcomes]                  each RPC endpoint's health, from the service",
    "  rpc probe                                check every RPC endpoint now",
    "  deposits list [--state S] [--review] [--version N]",
    "                                           one line per deposit and its money",
    "  deposits show <orderId>                  transfers, moves, shares and refund parts",
    "  deposits retry <orderId>                 clear review, requeue the manual sweep",
    "  deposits return-to <orderId> <signature> <tokenAccount> [--signed FILE]",
    "                                           return a transfer in review to this account",
    "  deposits return-late <orderId> [--signature SIG]... [--archive FILE|-]",
    "                                           list late credits, or return the named ones",
    "  deposits return-sol <orderId> <to> [--archive FILE|-]",
    "                                           send the deposit address's SOL to <to>",
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
    | "incidentId"
    | "signature"
    | "account";

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
    signature: { valid: isCanonicalSignature, what: "a signature" },
    account: { valid: isCanonicalAddress, what: "an address" },
};

type FlagName =
    | "--tx"
    | "--outcomes"
    | "--state"
    | "--review"
    | "--version"
    | "--signed"
    | "--signature"
    | "--archive";

interface Flags {
    tx?: string;
    outcomes?: boolean;
    state?: string;
    review?: boolean;
    version?: string;
    signed?: string;
    signatures?: string[];
    archive?: string;
}

const DEPOSIT_STATES: readonly string[] = ["open", "settling", "draining", "closed", "done"];

// A switch takes no value; only --signature may be given more than once
const FLAG_SPECS: Record<
    FlagName,
    | { switch: "outcomes" | "review" }
    | {
          key: "tx" | "state" | "version" | "signed" | "archive" | "signatures";
          valid: (s: string) => boolean;
          what: string;
      }
> = {
    "--tx": { key: "tx", valid: () => true, what: "a signature" },
    "--outcomes": { switch: "outcomes" },
    "--review": { switch: "review" },
    "--state": { key: "state", valid: (s) => DEPOSIT_STATES.includes(s), what: "a deposit state" },
    "--version": { key: "version", valid: isCount, what: "a key version" },
    "--signed": { key: "signed", valid: (s) => s !== "", what: "a file" },
    "--signature": { key: "signatures", valid: isCanonicalSignature, what: "a signature" },
    "--archive": { key: "archive", valid: (s) => s !== "", what: "a file or -" },
};

export { cliRouter };

export interface CliOptions {
    rpc?: SolanaRpc;
    now?: () => Date;
    // Tests map each list position to their own endpoint
    rpcTransportFor?: RouterDeps["transportFor"];
}

interface CliContext {
    pool: pg.Pool;
    settings: Settings;
    log: Log;
    now: () => Date;
    funding: AllowanceFunding;
    env: NodeJS.ProcessEnv;
    // The retired seeds --archive names, never logged
    archive: Readonly<Record<string, string>> | null;
    rpcTransportFor?: RouterDeps["transportFor"];
    // Built and started on first use, then reused for the rest of the command
    rpc(): Promise<SolanaRpc>;
    rpcOrNull(): Promise<SolanaRpc | null>;
}

const NO_RPC = "BUGNET_SOLANA_RPC_URLS or BUGNET_SOLANA_RPC_URL must be set";
// The service writes its snapshot every 15 s; older ones may be from a stopped service
const SNAPSHOT_FRESH_MS = 60_000;

interface DbCommand {
    params: readonly Param[];
    flags?: readonly FlagName[];
    run(ctx: CliContext, io: CliIo, args: readonly string[], flags: Flags): Promise<number>;
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
    ["x402 ledger-check", { params: ["accountId"], run: x402LedgerCheck }],
    ["rpc status", { params: [], flags: ["--outcomes"], run: rpcStatus }],
    ["rpc probe", { params: [], run: rpcProbe }],
    [
        "deposits list",
        { params: [], flags: ["--state", "--review", "--version"], run: depositsList },
    ],
    ["deposits show", { params: ["orderId"], run: depositsShow }],
    ["deposits retry", { params: ["orderId"], run: depositsRetry }],
    [
        "deposits return-to",
        {
            params: ["orderId", "signature", "account"],
            flags: ["--signed"],
            run: depositsReturnTo,
        },
    ],
    [
        "deposits return-late",
        { params: ["orderId"], flags: ["--signature", "--archive"], run: depositsReturnLate },
    ],
    [
        "deposits return-sol",
        { params: ["orderId", "account"], flags: ["--archive"], run: depositsReturnSol },
    ],
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
    if (isKeysCommand(group)) return runKeys(action, keysWords, env, io, args.config);
    const configFile = args.config ?? DEFAULT_CONFIG;
    let cmd: DbCommand | undefined;
    let used = 0;
    for (const n of [3, 2]) {
        cmd = DB_COMMANDS.get(args.words.slice(0, n).join(" "));
        used = n;
        if (cmd !== undefined) break;
    }
    if (cmd === undefined) return usage(io);
    const parsed = parseFlags(cmd, args.words.slice(used));
    if (typeof parsed === "string") return usage(io, parsed);
    const { rest, flags } = parsed;
    if (rest.length !== cmd.params.length) return usage(io);
    for (const [i, param] of cmd.params.entries()) {
        const { valid, what } = PARAMS[param];
        if (!valid(rest[i]!)) return usage(io, `${JSON.stringify(rest[i])} is not ${what}`);
    }
    let pool: pg.Pool | undefined;
    let routed: Promise<RoutedRpc | null> | undefined;
    let secrets: string[] = [];
    try {
        secrets = secretValues(env);
        const settings = loadSettings(configFile);
        const archive = flags.archive === undefined ? null : await readArchive(flags.archive, io);
        secrets = [...secrets, ...Object.values(archive ?? {})]
            .filter((v) => v.trim() !== "")
            .sort((a, b) => b.length - a.length);
        const log = jsonLog("payments-cli", { secrets, write: io.err });
        const db = createPool(settings.database.url, log);
        pool = db;
        const openRouter = (): Promise<RoutedRpc | null> =>
            (routed ??= (async () => {
                const r = cliRouter(env, settings.solana.rpc, {
                    log,
                    rpcTimeoutMs: settings.solana.rpc_timeout,
                    pool: db,
                    recipientAta: await usdcAta(address(settings.solana.recipient)),
                    ...(o.rpcTransportFor === undefined ? {} : { transportFor: o.rpcTransportFor }),
                });
                if (r === null) return null;
                await startOrStop(r);
                await warnOtherList(db, r, log, o.now ?? (() => new Date()));
                return r;
            })());
        const ctx: CliContext = {
            pool: db,
            settings,
            log,
            now: o.now ?? (() => new Date()),
            funding: createAllowanceFunding({ x402: settings.x402, log }),
            env,
            archive,
            ...(o.rpcTransportFor === undefined ? {} : { rpcTransportFor: o.rpcTransportFor }),
            async rpc() {
                if (o.rpc !== undefined) return o.rpc;
                const r = await openRouter();
                if (r === null) throw new Error(NO_RPC);
                return r.rpc;
            },
            async rpcOrNull() {
                if (o.rpc !== undefined) return o.rpc;
                return (await openRouter())?.rpc ?? null;
            },
        };
        return await cmd.run(ctx, io, rest, flags);
    } catch (err) {
        // An RPC or library error can echo what it was given, a key or an endpoint URL included
        const scrub = makeScrubber(secrets);
        io.err(`error: ${scrub(err instanceof Error ? err.message : String(err))}`);
        return 1;
    } finally {
        // The router flushes its usage into the pool, so it stops first
        const r = await routed?.catch(() => null);
        await r?.router.stop();
        await pool?.end();
    }
}

// A shell that dropped part of the list while loading the env file shows here, by count only
async function warnOtherList(
    pool: pg.Pool,
    r: RoutedRpc,
    log: Log,
    now: () => Date,
): Promise<void> {
    const stored = await readSnapshot(pool).catch(() => null);
    if (stored === null) return;
    if (now().getTime() - stored.writtenAt.getTime() >= SNAPSHOT_FRESH_MS) return;
    const mine = r.router.snapshot().endpoints.length;
    const theirs = stored.snapshot.endpoints.length;
    if (stored.snapshot.mode === r.router.mode && mine === theirs) return;
    log.warn(`rpc the CLI reads ${mine} URL${mine === 1 ? "" : "s"}, the service ${theirs}`);
}

function parseFlags(
    cmd: DbCommand,
    words: readonly string[],
): { rest: string[]; flags: Flags } | string {
    const rest: string[] = [];
    const flags: Flags = {};
    for (let i = 0; i < words.length; i++) {
        const flag = cmd.flags?.find((f) => f === words[i]);
        if (flag === undefined) {
            rest.push(words[i]!);
            continue;
        }
        const spec = FLAG_SPECS[flag];
        if ("switch" in spec) {
            flags[spec.switch] = true;
            continue;
        }
        const value = words[++i];
        if (value === undefined) return `${flag} needs ${spec.what}`;
        if (!spec.valid(value)) return `${JSON.stringify(value)} is not ${spec.what}`;
        if (spec.key === "signatures") {
            flags.signatures = [...(flags.signatures ?? []), value];
            continue;
        }
        if (flags[spec.key] !== undefined) return `${flag} is given twice`;
        flags[spec.key] = value;
    }
    return { rest, flags };
}

// Spec 4.3, D8 A: "-" takes the archive from stdin, so no seed file is left on the server
async function readArchive(path: string, io: CliIo): Promise<Readonly<Record<string, string>>> {
    if (path !== "-") return parseEnvText(readFileSync(path, "utf8"));
    if (io.stdin === undefined) throw new Error("--archive - needs the archive on stdin");
    return parseEnvText(await io.stdin());
}

// config is null when no -config was given, so the keys commands can tell
function splitConfig(argv: readonly string[]): { config: string | null; words: string[] } | null {
    const at = argv.findIndex((a) => a === "-config" || a === "--config");
    if (at === -1) return { config: null, words: [...argv] };
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
const LANDED =
    "its refund was paid on chain; the confirm path will record it, so retry or resolve is not needed";

// Why a proof short of "absent" blocks the operator's change
const unproven = (proof: Exclude<ResignProof, "absent">): string =>
    proof === "landed" ? LANDED : NOT_ABSENT;

function refuseRefund(io: CliIo, refundId: number, why: string): number {
    io.err(`refund ${refundId}: ${why}`);
    return 1;
}

// The rows the refund-id commands manage: hot-wallet rows, the parts of a cold refund split among
// owners and every deposit row. Every other row has an order-level command.
async function isListed(pool: pg.Pool, r: RefundRow): Promise<boolean> {
    if (r.state !== "manual" || r.manualReason === BY_HAND) return false;
    if (r.kind === "allowance" || r.kind === "deposit") return true;
    if ((await findOrder(pool, r.orderId))?.payInto === "allowance") return r.kind === "partial";
    return (await findPaymentByOrder(pool, r.orderId))?.multiSender === true;
}

// Neither paid nor resolved by hand
const isOpen = (r: RefundRow): boolean => r.state !== "confirmed" && r.manualReason !== BY_HAND;

// A part of a cold order's refund left the queue: a complete refund refunds the order, and once no
// part waits for an operator the order goes back to refunding, so the executor's confirm of the
// parts still in flight finishes it. Deposit rows and hot orders never move the order this way.
async function partLeftQueue(c: pg.PoolClient, r: RefundRow): Promise<void> {
    if (r.kind !== "full" && r.kind !== "partial") return;
    const order = await lockOrder(c, r.orderId);
    if (order === null || order.payInto === "allowance") return;
    if (order.state !== "manual" && order.state !== "refunding") return;
    if (await groupComplete(c, r.orderId, r.kind)) {
        await setOrderState(c, r.orderId, order.state, "refunded");
        return;
    }
    const group = await refundGroup(c, r.orderId, r.kind);
    if (order.state === "manual" && !group.some((p) => p.state === "manual" && isOpen(p))) {
        await setOrderState(c, r.orderId, "manual", "refunding", { manualReason: null });
    }
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
        await ctx.rpc(),
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
        `select o.id, o.manual_reason as reason,
            coalesce(p.amount_micros, o.amount_micros)::text as amount,
            coalesce(p.payer, o.payer) as payer, p.source_token_account as destination
         from orders o
         left join payments p on p.order_id = o.id
         where o.state = 'manual'
         order by o.created_at, o.id`,
    );
    for (const row of res.rows) {
        const amount = row.reason !== null && NEEDS_AMOUNT.includes(row.reason) ? null : row.amount;
        const cells = [row.id, row.reason, amount, row.payer, row.destination];
        io.out(cells.map((c) => c ?? "-").join("\t"));
    }
    // One line per part, so a part in the queue shows its own owner's amount and destination
    const rows = await ctx.pool.query<{
        id: string;
        kind: string;
        part: number;
        parts: number;
        from_wallet: string;
        state: string;
        manual_reason: string | null;
        amount: string;
        destination: string;
    }>(
        `select r.id, r.kind, r.part, r.from_wallet, r.state, r.manual_reason,
            r.amount_micros::text as amount, r.destination,
            (select count(*) from refunds g where g.order_id = r.order_id and g.kind = r.kind)::int
                as parts
         from refunds r join orders o on o.id = r.order_id
         where r.state = 'manual' and r.manual_reason is distinct from 'resolved_by_hand'
            and (r.kind in ('allowance', 'deposit')
                or (r.kind = 'partial' and o.pay_into = 'allowance')
                or o.state = 'manual')
         order by r.id`,
    );
    for (const r of rows.rows) {
        const cells = [
            "refund",
            r.id,
            r.kind,
            `part ${r.part}/${r.parts}`,
            r.from_wallet,
            r.state,
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
    let proven: string | null = null;
    if (r.fromWallet === "allowance") {
        const proof = await proofOf(ctx, r);
        if (proof !== "absent") return refuseRefund(io, id, unproven(proof));
        proven = provenKey(r);
    }
    const done = await withTx(ctx.pool, async (c) => {
        const cur = await lockRefund(c, id);
        if (cur === null || (proven !== null && provenKey(cur) !== proven)) return false;
        const res = await c.query(
            `update refunds set state = 'pending', attempts = 0, budget_waived = true,
                manual_reason = null
             where id = $1 and state = 'manual'
                and manual_reason is distinct from 'resolved_by_hand'`,
            [id],
        );
        if (res.rowCount !== 1) return false;
        await partLeftQueue(c, cur);
        return true;
    });
    if (!done) return refuseRefund(io, id, "changed while retrying");
    io.out(`refund ${id}: pending`);
    return 0;
}

// Every part of the order's refund that waits in the queue goes back to pending; a part already
// paid or still in flight is left as it is
async function retryOrder(ctx: CliContext, io: CliIo, orderId: string): Promise<number> {
    const { pool } = ctx;
    const seen = await findOrder(pool, orderId);
    const head = seen === null ? null : await findOrderRefund(pool, orderId);
    const peek = head === null ? [] : await refundGroup(pool, orderId, head.kind);
    // Each allowance-wallet part needs its own proof that no transaction of it can still land
    const proven = new Map<number, string>();
    if (seen?.state === "manual" && seen.payInto === "allowance") {
        for (const p of peek) {
            if (p.kind !== "full" || p.state !== "manual" || p.manualReason === BY_HAND) continue;
            if (p.fromWallet !== "allowance") continue;
            const proof = await proofOf(ctx, p);
            if (proof !== "absent") return refuse(io, orderId, unproven(proof));
            proven.set(p.id, provenKey(p));
        }
    }
    const outcome = await withTx(
        pool,
        async (
            c,
        ): Promise<{ refused: string } | { noRefund: { coldShare: boolean } } | "reset"> => {
            const order = await lockOrder(c, orderId);
            const hot = order?.payInto === "allowance";
            const refund = order === null ? null : await findOrderRefund(c, orderId);
            const group = refund === null ? [] : await lockRefundGroup(c, orderId, refund.kind);
            const open = group.filter(isOpen);
            if (open.length === 0 && group.some((p) => p.manualReason === BY_HAND)) {
                return { refused: "resolved by hand" };
            }
            if (hot && refund?.kind === "partial") {
                const ids = (open.length > 0 ? open : group).map((p) => `manual retry ${p.id}`);
                return { refused: `hot-wallet refund: use ${ids.join(", ")}` };
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
            const manual = open.filter((p) => p.state === "manual");
            if (manual.length === 0) {
                return { refused: `its refund is ${(open[0] ?? refund).state}` };
            }
            const unprovenPart = manual.some(
                (p) => hot && p.fromWallet === "allowance" && proven.get(p.id) !== provenKey(p),
            );
            if (unprovenPart) return { refused: "changed while retrying" };
            await c.query(
                `update refunds set state = 'pending', attempts = 0, manual_reason = null,
                    budget_waived = budget_waived or $2
                 where id = any($1::bigint[])`,
                [manual.map((p) => p.id), hot],
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
    if (!(await returnManualToRedeemed(pool, orderId, ctx.now(), DISMISSABLE))) {
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
    if (flags.tx !== undefined) {
        return usage(io, "--tx belongs to a refund id; an order id takes manual resolve <orderId>");
    }
    const refused = await withTx(ctx.pool, async (c) => {
        const order = await lockOrder(c, arg);
        const refund = order === null ? null : await findOrderRefund(c, arg);
        const group = refund === null ? [] : await lockRefundGroup(c, arg, refund.kind);
        const open = group.filter(isOpen);
        if (open.length === 0 && group.some((p) => p.manualReason === BY_HAND)) {
            return "resolved by hand";
        }
        // A hot part resolved without its transfer would leave the pool's committed too high, so
        // each one is proven with its own --tx
        const hot = order?.payInto === "allowance";
        if (open.some((p) => p.fromWallet === "allowance") || (hot && open.length > 0)) {
            const each = open.map((p) =>
                p.fromWallet === "allowance"
                    ? `manual resolve ${p.id} --tx <signature>`
                    : `manual resolve ${p.id}`,
            );
            return `hot-wallet refund: use ${each.join(", ")}`;
        }
        const notInQueue = notManual(order);
        if (notInQueue !== null) return notInQueue;
        const busy = open.find((p) => IN_FLIGHT.includes(p.state));
        if (busy !== undefined) {
            return `its refund is ${busy.state} and the executor still owns it`;
        }
        // The rows stay manual, and this reason keeps anything from reading them as paid
        if (open.length > 0) {
            await c.query(
                "update refunds set manual_reason = 'resolved_by_hand' where id = any($1::bigint[])",
                [open.map((p) => p.id)],
            );
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
        const done = await withTx(pool, async (c) => {
            const cur = await lockRefund(c, id);
            if (cur === null) return false;
            const res = await c.query(
                `update refunds set manual_reason = 'resolved_by_hand'
                 where id = $1 and state = 'manual' and from_wallet = 'refund'
                    and manual_reason is distinct from 'resolved_by_hand'`,
                [id],
            );
            if (res.rowCount !== 1) return false;
            await partLeftQueue(c, cur);
            return true;
        });
        if (!done) return refuseRefund(io, id, "changed while resolving");
        io.out(`refund ${id}: resolved by hand`);
        return 0;
    }
    if (r.fromWallet !== "allowance") {
        return refuseRefund(io, id, `a refund-wallet row: use manual resolve ${id} without --tx`);
    }
    if (!isCanonicalSignature(tx)) return refuseRefund(io, id, "not a 64-byte signature");
    let proven: string | null = null;
    if (r.state === "manual") {
        const proof = await proofOf(ctx, r);
        if (proof !== "absent") return refuseRefund(io, id, unproven(proof));
        proven = provenKey(r);
    } else if (r.state === "pending") {
        if (!(await readControls(pool)).refundsHeld) {
            return refuseRefund(io, id, "pending rows only while refunds are held");
        }
    } else {
        return refuseRefund(io, id, `its refund is ${r.state} and the executor still owns it`);
    }
    const done = await withTx(pool, async (c) => {
        const cur = await lockRefund(c, id);
        if (cur === null || (proven !== null && provenKey(cur) !== proven)) return false;
        return resolveHotRefundByHand(c, id, tx, ctx.now(), ctx.settings.x402, ctx.log);
    });
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

// The reason column is shared by all three controls, so it is only cleared once none is left set.
async function releaseControl(
    c: Queryable,
    field: "paused" | "disabled" | "refundsHeld",
    at: Date,
): Promise<void> {
    const { rows } = await c.query<{ paused: boolean; disabled: boolean; refunds_held: boolean }>(
        "select paused, disabled, refunds_held from x402_controls where id = 1 for update",
    );
    const row = rows[0]!;
    const others = {
        paused: row.paused,
        disabled: row.disabled,
        refundsHeld: row.refunds_held,
        [field]: false,
    };
    const stillSet = others.paused || others.disabled || others.refundsHeld;
    if (stillSet) {
        await c.query(
            `update x402_controls set ${field === "refundsHeld" ? "refunds_held" : field} = false,
             changed_at = $1 where id = 1`,
            [at],
        );
        return;
    }
    await setControls(c, { [field]: false }, null, at);
}

// An earlier control's reason stays, so the row keeps explaining why it is not running.
async function engageControl(
    c: Queryable,
    field: "disabled" | "refundsHeld",
    reason: string,
    at: Date,
): Promise<void> {
    const { rows } = await c.query<{ reason: string | null }>(
        "select reason from x402_controls where id = 1 for update",
    );
    await setControls(c, { [field]: true }, rows[0]!.reason ?? reason, at);
}

async function x402Resume(ctx: CliContext, io: CliIo): Promise<number> {
    const refused = await withTx(ctx.pool, async (c) => {
        // recordIncident updates this row, so the check and the resume cannot interleave with one
        await c.query("select 1 from x402_controls where id = 1 for update");
        const [oldest] = await openIncidents(c);
        if (oldest !== undefined) return `unresolved incident ${oldest.id} ${oldest.kind}`;
        await releaseControl(c, "paused", ctx.now());
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
    await withTx(ctx.pool, (c) => engageControl(c, "disabled", "x402 kill", ctx.now()));
    io.out("x402 killed");
    return 0;
}

async function x402Unkill(ctx: CliContext, io: CliIo): Promise<number> {
    await withTx(ctx.pool, (c) => releaseControl(c, "disabled", ctx.now()));
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
    if (!isCanonicalAddress(payTo)) {
        io.err(`${JSON.stringify(payTo)} is not a 32-byte address`);
        return 1;
    }
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
    await withTx(ctx.pool, (c) => engageControl(c, "refundsHeld", "x402 refunds hold", ctx.now()));
    io.out("x402 refunds held");
    return 0;
}

async function x402RefundsRelease(ctx: CliContext, io: CliIo): Promise<number> {
    await withTx(ctx.pool, (c) => releaseControl(c, "refundsHeld", ctx.now()));
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
        await ctx.rpcOrNull(),
        hot,
        ctx.settings.x402,
        ctx.now(),
    )) {
        io.out(line);
    }
    return 0;
}

async function x402LedgerCheck(
    ctx: CliContext,
    io: CliIo,
    [accountId = ""]: readonly string[],
): Promise<number> {
    const result = await ledgerCheck(
        ctx.pool,
        await ctx.rpc(),
        accountId,
        ctx.settings.solana.rpc_timeout,
    );
    for (const line of result.lines) io.out(line);
    return result.ok ? 0 : 1;
}

async function rpcStatus(
    ctx: CliContext,
    io: CliIo,
    _args: readonly string[],
    flags: { outcomes?: boolean },
): Promise<number> {
    const stored = await readSnapshot(ctx.pool);
    if (stored === null) {
        io.err("no router snapshot: is the service running?");
        return 1;
    }
    const lines = formatRpcStatus(
        stored.snapshot,
        stored.writtenAt,
        ctx.now(),
        flags.outcomes === true,
    );
    for (const line of lines) io.out(line);
    return 0;
}

export function formatRpcStatus(
    s: RouterSnapshot,
    writtenAt: Date,
    now: Date,
    outcomes: boolean,
): string[] {
    const age = Math.round((now.getTime() - writtenAt.getTime()) / 1000);
    const lines = [
        `snapshot: ${writtenAt.toISOString()} (age ${age}s${age * 1000 > SNAPSHOT_FRESH_MS ? ", stale" : ""})`,
        `serving: ${s.serving ?? "none"}  domains: ${s.domains}  quorum: ${s.absenceQuorum}  copies: ${s.sendFanout}`,
    ];
    for (const e of s.endpoints) {
        const background =
            e.monthRequests === 0 ? 0 : Math.round((e.monthBackground * 100) / e.monthRequests);
        lines.push(
            [
                e.name,
                `state: ${stateText(e.state, e.untilMs, now)}`,
                `roles: ${e.roles.join(" ")}`,
                `latency: ${Math.round(e.latencyMs)}ms`,
                `errors: ${Math.round(e.errorRate * 100)}%`,
                `slot: ${e.confirmedSlot ?? "none"}`,
                `lag: ${e.lag ?? "none"}`,
                `month: ${e.monthRequests}`,
                `background: ${background}%`,
                `limits: ${limitsText(e.limits)}`,
                `genesis: ${e.checks.genesis}`,
                `history: ${e.checks.history}`,
                `consistent: ${e.consistent}`,
                `pinned-accounts: ${e.checks.pinnedAccounts}`,
                `pinned-signatures: ${e.checks.pinnedSignatures}`,
            ].join("  "),
        );
    }
    if (outcomes) {
        for (const e of s.endpoints) {
            for (const [method, counts] of Object.entries(e.outcomes)) {
                const parts = Object.entries(counts).map(([outcome, n]) => `${outcome}: ${n}`);
                lines.push(`  ${e.name} ${method}  ${parts.join("  ")}`);
            }
        }
    }
    return lines;
}

function stateText(state: string, untilMs: number | null, now: Date): string {
    if (state === "wrong_network") return "wrong-network";
    if ((state === "cooling" || state === "open") && untilMs !== null) {
        return `${state} ${Math.max(0, Math.ceil((untilMs - now.getTime()) / 1000))}s`;
    }
    return state;
}

function limitsText(limits: Readonly<Record<string, number>>): string {
    const entries = Object.entries(limits);
    if (entries.length === 0) return "none";
    entries.sort(([a], [b]) => (a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b)));
    return entries.map(([m, n]) => `${m === "*" ? "all" : m} ${n}/10s`).join(", ");
}

// A probe is not traffic: no usage store, verdicts read only, and no start()
async function rpcProbe(ctx: CliContext, io: CliIo): Promise<number> {
    const r = cliRouter(ctx.env, ctx.settings.solana.rpc, {
        log: ctx.log,
        rpcTimeoutMs: ctx.settings.solana.rpc_timeout,
        pool: ctx.pool,
        recipientAta: await usdcAta(address(ctx.settings.solana.recipient)),
        usage: false,
        verdictsReadOnly: true,
        ...(ctx.rpcTransportFor === undefined ? {} : { transportFor: ctx.rpcTransportFor }),
    });
    if (r === null) {
        io.err(NO_RPC);
        return 1;
    }
    try {
        const report = await r.router.check();
        const snap = r.router.snapshot();
        const consistent: Record<string, string> = {};
        for (const e of snap.endpoints) consistent[e.name] = e.consistent;
        const urls = rpcUrlsOf(ctx.env);
        const ready = new Set<string>();
        report.endpoints.forEach((c, i) => {
            if (c.history === "ok" && consistent[c.name] === "yes") ready.add(domainOf(urls[i]!));
        });
        const quorum =
            r.router.mode === "single" ? null : { ready: ready.size, needed: snap.absenceQuorum };
        for (const line of formatRpcProbe(report, consistent, quorum)) io.out(line);
        return probeFails(report, consistent, quorum) ? 1 : 0;
    } finally {
        await r.router.stop();
    }
}

export function formatRpcProbe(
    r: CheckReport,
    consistent: Readonly<Record<string, string>>,
    quorum: { ready: number; needed: number } | null,
): string[] {
    const lines = r.endpoints.map((c) =>
        [
            c.name,
            `genesis: ${c.genesis}${c.genesisError === null ? "" : ` ${c.genesisError}`}`,
            `pinned-accounts: ${c.pinnedAccounts}`,
            `pinned-signatures: ${c.pinnedSignatures}`,
            `history: ${c.history}`,
            `consistent: ${consistent[c.name] ?? "unknown"}`,
            `slot: ${c.slot ?? "none"}`,
            `latency: ${c.latencyMs === null ? "none" : `${Math.round(c.latencyMs)}ms`}`,
        ].join("  "),
    );
    lines.push(
        quorum === null
            ? "quorum: off (one URL)"
            : `quorum: ${quorum.ready} of ${quorum.needed} domains ready`,
    );
    const listings = r.endpoints
        .filter(
            (c) =>
                consistent[c.name] === "yes" && c.history === "ok" && c.pinnedSignatures === "ok",
        )
        .map((c) => c.name);
    lines.push(`listings: ${listings.length === 0 ? "none" : listings.join(" ")}`);
    return lines;
}

// A missing history or consistent: no alone still serves reads, sends and found answers
function probeFails(
    r: CheckReport,
    consistent: Readonly<Record<string, string>>,
    quorum: { ready: number; needed: number } | null,
): boolean {
    for (const c of r.endpoints) {
        if (c.genesis === "wrong" || c.genesis === "error") return true;
        if (c.history === "error") return true;
        if (consistent[c.name] === "yes") {
            for (const pinned of [c.pinnedAccounts, c.pinnedSignatures]) {
                if (pinned === "ignored" || pinned === "error") return true;
            }
        }
    }
    return quorum !== null && quorum.ready < quorum.needed;
}

const SEED = "BUGNET_DEPOSIT_SEED";
const SEED_PREVIOUS = "BUGNET_DEPOSIT_SEED_PREVIOUS";
const FEE_PAYER_KEY = "BUGNET_FEE_PAYER_KEY";
// Each credit return-late sends back carries this memo with the credit's signature, so a later
// run sees it was returned
const LATE_MEMO = "bugnet-late ";
const LISTING_PAGE = 1_000;
const MAX_TRANSACTION_BYTES = 1_232;

const noDeposit = (orderId: string): string => `no deposit for ${orderId}`;
const inFlight = (orderId: string): string =>
    `deposit ${orderId} has a move in flight; try again shortly`;
const orDash = (v: string | number | bigint | null): string =>
    v === null || v === "" ? "-" : String(v);

function fail(io: CliIo, why: string): number {
    io.err(why);
    return 1;
}

async function moveInFlight(c: Queryable, orderId: string): Promise<boolean> {
    const res = await c.query(
        `select 1 from deposit_moves
         where order_id = $1 and state in ('pending', 'signed', 'sent')`,
        [orderId],
    );
    return (res.rowCount ?? 0) > 0;
}

// Review money no deposit refund row is returning: none yet, or one that went manual
const WAITING = `t.outcome = 'review' and (r.id is null
    or (r.state = 'manual' and r.manual_reason is distinct from 'resolved_by_hand'))`;
const REST = "t.amount_micros - t.applied_micros";

// review is review money still in the deposit, held the review money at the refund float
async function depositsList(
    ctx: CliContext,
    io: CliIo,
    _args: readonly string[],
    flags: Flags,
): Promise<number> {
    const { rows } = await ctx.pool.query<{
        order_id: string;
        state: string;
        review_reason: string | null;
        received: string;
        returned: string;
        kept: string;
        review: string;
        held: string;
        manual_move: boolean;
    }>(
        `select d.order_id, d.state, d.review_reason,
            coalesce(sum(t.amount_micros), 0)::text as received,
            coalesce(sum(${REST}) filter (where
                (m.state = 'confirmed' and (t.outcome = 'return'
                    or (t.outcome = 'paid' and t.reason is distinct from 'below_minimum')))
                or (t.outcome = 'review' and (r.state = 'confirmed'
                    or r.manual_reason = 'resolved_by_hand'))), 0)::text as returned,
            coalesce(sum(${REST}) filter (where t.outcome = 'keep'
                or (t.outcome = 'paid' and t.reason = 'below_minimum')), 0)::text as kept,
            coalesce(sum(${REST}) filter (where ${WAITING}
                and m.state is distinct from 'confirmed'), 0)::text as review,
            coalesce(sum(${REST}) filter (where ${WAITING}
                and m.state = 'confirmed'), 0)::text as held,
            exists (select 1 from deposit_moves x
                where x.order_id = d.order_id and x.state = 'manual') as manual_move
         from deposits d
         left join deposit_transfers t on t.order_id = d.order_id
         left join deposit_moves m on m.id = t.move_id
         left join refunds r on r.id = t.refund_id
         where ($1::text is null or d.state = $1) and ($2::int is null or d.key_version = $2)
         group by d.order_id
         order by d.created_at, d.order_id`,
        [flags.state ?? null, flags.version === undefined ? null : Number(flags.version)],
    );
    for (const r of rows) {
        const flagged =
            r.review_reason !== null || r.manual_move || r.review !== "0" || r.held !== "0";
        if (flags.review === true && !flagged) continue;
        io.out(
            [
                r.order_id,
                `state=${r.state}`,
                `received=${r.received}`,
                `returned=${r.returned}`,
                `kept=${r.kept}`,
                `review=${r.review}`,
                `held=${r.held}`,
                `reason=${orDash(r.review_reason)}`,
            ].join(" "),
        );
    }
    return 0;
}

// Spec 10.9: every refund part with its owner, so a share is never worked out by hand
async function depositsShow(
    ctx: CliContext,
    io: CliIo,
    [orderId = ""]: readonly string[],
): Promise<number> {
    const ledger = await depositLedger(ctx.pool, orderId);
    if (ledger === null) return fail(io, noDeposit(orderId));
    const d = ledger.deposit;
    io.out(
        [
            `deposit ${d.orderId}`,
            `state=${d.state}`,
            `key_version=${d.keyVersion}`,
            `address=${d.address}`,
            `token_account=${d.tokenAccount}`,
            `balance=${d.balanceMicros}`,
            `review=${orDash(d.reviewReason)}`,
            `hold=${orDash(d.holdReason)}`,
            `rent_payer=${orDash(d.rentPayer)}`,
        ].join(" "),
    );
    for (const t of ledger.transfers) {
        io.out(
            [
                `transfer ${t.signature} ${t.amountMicros} ${t.outcome}`,
                `reason=${orDash(t.reason)}`,
                `applied=${t.appliedMicros}`,
                `owner=${orDash(t.sourceOwner)}`,
                `source=${orDash(t.sourceTokenAccount)}`,
                `move=${orDash(t.moveId)}`,
                `refund=${orDash(t.refundId)}`,
            ].join(" "),
        );
    }
    for (const m of ledger.moves) {
        io.out(
            [
                `move ${m.id} ${m.kind} ${m.state}`,
                `amount=${m.amountMicros}`,
                `keep=${m.keepMicros}`,
                `held=${m.heldMicros}`,
                `to=${orDash(m.destination)}`,
                `close_to=${orDash(m.closeTo)}`,
                `attempts=${m.attempts}`,
                `signature=${orDash(m.txSignature)}`,
                `previous=${orDash(m.previousSignatures.join(","))}`,
                `reason=${orDash(m.manualReason)}`,
            ].join(" "),
        );
    }
    for (const h of ledger.holds) {
        const owner = h.owner === "" ? "shared" : h.owner;
        io.out(`hold ${owner} ${h.reason} until=${h.recheckAt.toISOString()}`);
    }
    for (const s of await sharesOf(ctx.pool, orderId)) {
        io.out(`share ${s.part} ${s.owner} ${s.appliedMicros} source=${s.sourceTokenAccount}`);
    }
    const { rows } = await ctx.pool.query<RefundDbRow>(
        "select * from refunds where order_id = $1 order by kind, part",
        [orderId],
    );
    const parts = rows.map(toRefund);
    for (const r of parts) {
        // Deposit rows each return one transfer, so they are not parts of one split
        const n = parts.filter((p) => p.kind === r.kind).length;
        const part = r.kind === "deposit" ? `${r.part}` : `${r.part}/${n}`;
        io.out(
            [
                `refund ${r.kind} part ${part} ${r.payer} ${r.amountMicros} ${r.state}`,
                `to=${r.destination}`,
                `id=${r.id}`,
                `reason=${orDash(r.manualReason)}`,
                `signature=${orDash(r.txSignature)}`,
            ].join(" "),
        );
    }
    return 0;
}

/**
 * Spec 17: the planner counts only sweeps that fail after this, so the sweep gets a fresh
 * max_attempts while the failures stay on record. The requeued sweep no longer closes: money may
 * have come during review, a closing move is then dropped by the guard, and a row with
 * signatures can never be deleted, so it would stay pending for good. The planner closes the
 * account separately once the sweep lands (spec 10.4).
 */
async function depositsRetry(
    ctx: CliContext,
    io: CliIo,
    [orderId = ""]: readonly string[],
): Promise<number> {
    const outcome = await withTx(
        ctx.pool,
        async (c): Promise<string | number> => {
            const deposit = await lockDeposit(c, orderId);
            if (deposit === null) return noDeposit(orderId);
            if (await moveInFlight(c, orderId)) return inFlight(orderId);
            const requeued = await c.query(
                `update deposit_moves set state = 'pending', attempts = 0, manual_reason = null,
                    closes = false, close_to = null
                 where id = (select max(id) from deposit_moves
                    where order_id = $1 and kind = 'sweep' and state = 'manual')`,
                [orderId],
            );
            const moved = requeued.rowCount ?? 0;
            if (deposit.reviewReason === null && moved === 0) {
                return `deposit ${orderId} has nothing to retry`;
            }
            await updateDeposit(c, orderId, { reviewReason: null, movesFailingResetAt: ctx.now() });
            return moved;
        },
        ctx.log,
    );
    if (typeof outcome === "string") return fail(io, outcome);
    io.out(`deposit ${orderId} retried: ${outcome} move${outcome === 1 ? "" : "s"} requeued`);
    return 0;
}

/**
 * Spec 17: the order id and the amount are public on chain, so whoever writes to support proves
 * nothing. Held money goes only to an account its sender owns, or where a message the sender
 * signed says.
 */
async function depositsReturnTo(
    ctx: CliContext,
    io: CliIo,
    [orderId = "", sig = "", account = ""]: readonly string[],
    flags: Flags,
): Promise<number> {
    const ledger = await depositLedger(ctx.pool, orderId);
    if (ledger === null) return fail(io, noDeposit(orderId));
    const t = ledger.transfers.find((x) => x.signature === sig);
    if (t === undefined) return fail(io, `${sig} is not a transfer of ${orderId}`);
    if (t.outcome !== "review") return fail(io, `transfer ${sig} is not in review`);
    const rpc = await ctx.rpc();
    const timeoutMs = ctx.settings.solana.rpc_timeout;
    const info = await inspectTokenAccount(rpc, address(account), deadline(timeoutMs));
    if (
        info === null ||
        info.programOwner !== TOKEN_PROGRAM ||
        info.mint !== USDC_MINT ||
        info.state !== "initialized"
    ) {
        return fail(io, `account ${account} is not a USDC token account`);
    }
    let proof: "owner" | "signed" = "owner";
    let proofSha256: string | null = null;
    if (t.sourceOwner === null || info.owner !== t.sourceOwner) {
        if (flags.signed === undefined) {
            return fail(io, "destination is not the sender's; pass --signed");
        }
        const signers =
            t.sourceOwner === null ? await transactionSigners(rpc, t, timeoutMs) : [t.sourceOwner];
        if (signers === null) {
            return fail(io, `transaction ${sig} cannot be decoded, so it has no signer to check`);
        }
        const file = readFileSync(flags.signed);
        const message = `bugnet return-to ${orderId} ${sig} ${account}`;
        const refused = await checkSigned(file, message, signers);
        if (refused !== null) return fail(io, refused);
        proof = "signed";
        proofSha256 = createHash("sha256").update(file).digest("hex");
    }
    const decided = await withTx(
        ctx.pool,
        (c) =>
            returnHeld(c, { orderId, signature: sig, account, owner: info.owner, at: ctx.now() }),
        ctx.log,
    );
    const refused = "refused" in decided;
    ctx.log.info("deposit return-to", {
        orderId,
        signature: sig,
        destination: account,
        proof,
        proofSha256,
        outcome: refused ? "refused" : decided.outcome,
        ...(refused ? { refused: decided.refused } : {}),
    });
    if (refused) return fail(io, decided.refused);
    io.out(decided.line);
    return 0;
}

type ReturnOutcome = "return" | "refund" | "repointed";

// Decided under the deposit lock, so no move of the deposit can start in between
async function returnHeld(
    c: pg.PoolClient,
    o: { orderId: string; signature: string; account: string; owner: string; at: Date },
): Promise<{ refused: string } | { line: string; outcome: ReturnOutcome }> {
    if ((await lockDeposit(c, o.orderId)) === null) return { refused: noDeposit(o.orderId) };
    if (await moveInFlight(c, o.orderId)) return { refused: inFlight(o.orderId) };
    const { rows } = await c.query<{
        outcome: string;
        move_id: string | null;
        move_state: string | null;
        refund_id: string | null;
        refund_state: string | null;
        refund_reason: string | null;
    }>(
        `select t.outcome, t.move_id, m.state as move_state, t.refund_id,
            r.state as refund_state, r.manual_reason as refund_reason
         from deposit_transfers t
         left join deposit_moves m on m.id = t.move_id
         left join refunds r on r.id = t.refund_id
         where t.order_id = $1 and t.signature = $2
         for no key update of t`,
        [o.orderId, o.signature],
    );
    const t = rows[0];
    if (t?.outcome !== "review") return { refused: `transfer ${o.signature} is not in review` };
    // A failed move carried nothing, so that money is still in the deposit too
    if (t.move_id === null || t.move_state === "failed") {
        await c.query(
            `update deposit_transfers set outcome = 'return', reason = 'operator',
                source_token_account = $3, source_owner = $4, move_id = null
             where order_id = $1 and signature = $2`,
            [o.orderId, o.signature, o.account, o.owner],
        );
        return { line: `transfer ${o.signature} returns to ${o.account}`, outcome: "return" };
    }
    if (t.refund_id !== null && (t.refund_state !== "manual" || t.refund_reason === BY_HAND)) {
        const state = t.refund_reason === BY_HAND ? "resolved by hand" : t.refund_state;
        return { refused: `refund ${t.refund_id} is ${state}` };
    }
    const r = await insertDepositRefund(c, {
        orderId: o.orderId,
        signature: o.signature,
        destination: o.account,
        payer: o.owner,
        at: o.at,
    });
    if (r === "refused") {
        if (t.move_state !== "confirmed") {
            const move = `move ${t.move_id} carrying ${o.signature}`;
            return { refused: `${move} is ${t.move_state}; try again shortly` };
        }
        return { refused: `transfer ${o.signature} was not carried to the refund float` };
    }
    return {
        line: `refund ${r.id} ${r.repointed ? "now pays" : "pays"} ${o.account}`,
        outcome: r.repointed ? "repointed" : "refund",
    };
}

// Null when the transaction cannot be decoded: it then names no signer (spec 17)
async function transactionSigners(
    rpc: SolanaRpc,
    t: TransferRow,
    timeoutMs: number,
): Promise<readonly string[] | null> {
    const tx = await fetchTx(rpc, new TxCache(1), t.signature, t.slot, timeoutMs);
    if (tx === null || tx.noMeta) {
        throw new Error(`transaction ${t.signature} is not available yet; try again shortly`);
    }
    return tx.undecodable ? null : tx.signers;
}

// The file holds {message, signature}: the exact message, signed (ed25519, base58) by one of them
async function checkSigned(
    file: Buffer,
    message: string,
    signers: readonly string[],
): Promise<string | null> {
    let proof: unknown = null;
    try {
        proof = JSON.parse(file.toString("utf8"));
    } catch {
        // answered below
    }
    if (
        !isRecord(proof) ||
        typeof proof.message !== "string" ||
        typeof proof.signature !== "string"
    ) {
        return 'the --signed file holds no {"message", "signature"}';
    }
    if (proof.message !== message || !isCanonicalSignature(proof.signature)) {
        return "signature does not match";
    }
    const bytes = getBase58Encoder().encode(proof.signature) as SignatureBytes;
    const data = new TextEncoder().encode(message);
    for (const signer of signers) {
        if (await signedBy(signer, bytes, data)) return null;
    }
    return "signature does not match";
}

async function signedBy(signer: string, sig: SignatureBytes, data: Uint8Array): Promise<boolean> {
    try {
        return await verifySignature(await getPublicKeyFromAddress(address(signer)), sig, data);
    } catch {
        // An address off the ed25519 curve is no key, so it signed nothing
        return false;
    }
}

function seedOf(env: Readonly<Record<string, string | undefined>>, name: string): Buffer | null {
    const value = env[name] ?? "";
    if (value === "") return null;
    if (!isBase64Of32(value)) {
        throw new Error(`${name} must be standard base64 of exactly 32 bytes`);
    }
    return Buffer.from(value, "base64");
}

// The seed of the deposit's key version from .env, or from the archive once it was retired; it
// must derive the stored address, as the boot check requires (spec 4.3, 4.4)
async function depositSigner(
    ctx: CliContext,
    deposit: DepositRow,
): Promise<KeyPairSigner | string> {
    const version = deposit.keyVersion;
    const current = ctx.settings.deposits.seed_version;
    const loaded = depositKeysFrom(
        { depositSeed: seedOf(ctx.env, SEED), depositSeedPrevious: seedOf(ctx.env, SEED_PREVIOUS) },
        current,
    );
    let keys = loaded ?? new DepositKeys(new Map(), current);
    let from = version === current ? SEED : SEED_PREVIOUS;
    if (!keys.has(version)) {
        if (ctx.archive === null) {
            return `seed for key version ${version} is not loaded; pass --archive`;
        }
        from = `${SEED}_V${version}`;
        const seed = seedOf(ctx.archive, from);
        if (seed === null) return `the archive has no ${from}`;
        keys = keys.withSeed(version, seed);
    }
    const signer = await keys.signer(deposit.orderId, deposit.salt, version);
    if (signer.address !== deposit.address) {
        return `${from} does not derive the stored deposit address of ${deposit.orderId}`;
    }
    return signer;
}

async function feePayerOf(env: NodeJS.ProcessEnv): Promise<KeyPairSigner> {
    const key = (env[FEE_PAYER_KEY] ?? "").trim();
    if (key === "") throw new Error(`${FEE_PAYER_KEY} must be set`);
    return loadKeypair(key, FEE_PAYER_KEY);
}

/**
 * Signed by the deposit key with Bugnet's fee payer, sent, and followed until it lands. A send
 * can error after the endpoint forwarded the transaction, so an error never ends the command:
 * only the landing or the expired blockhash says whether a second run would pay twice.
 */
async function sendSigned(
    ctx: CliContext,
    io: CliIo,
    rpc: SolanaRpc,
    feePayer: KeyPairSigner,
    instructions: readonly Instruction[],
    computeUnits: number,
): Promise<string> {
    const timeoutMs = ctx.settings.solana.rpc_timeout;
    const { value: latest } = await rpc
        .getLatestBlockhash({ commitment: "confirmed" })
        .send(deadline(timeoutMs));
    const signed = await signV0Transaction({
        feePayer,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        computeUnitLimit: computeUnits,
        computeUnitPrice: ctx.settings.deposits.compute_unit_price_micro_lamports,
        instructions,
    });
    const wire = getBase64EncodedWireTransaction(signed);
    const bytes = Buffer.from(wire, "base64").length;
    if (bytes > MAX_TRANSACTION_BYTES) {
        throw new Error(`the transaction is ${bytes} bytes, above ${MAX_TRANSACTION_BYTES}`);
    }
    const sent = getSignatureFromTransaction(signed);
    io.err(`sending ${sent}`);
    try {
        await rpc
            .sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" })
            .send(deadline(timeoutMs));
    } catch (err) {
        ctx.log.warn("send failed, waiting for the transaction to land or expire", {
            signature: sent,
            err,
        });
    }
    await waitForLanding(rpc, sent, latest.lastValidBlockHeight);
    return sent;
}

interface LateCredit {
    signature: string;
    micros: bigint;
    source: string | null;
    owner: string | null;
    // the source's owner signed the transaction, so the money can go back there
    signed: boolean;
    // the return-late transaction that sent it back
    returnedIn: string | null;
}

// A credit with no signer-owned source still names the account that fell most, so the operator
// sees who sent it
function creditOf(tx: CachedTx, row: NewTransfer, tokenAccount: string): LateCredit {
    const base = { signature: row.signature, micros: BigInt(row.amountMicros), returnedIn: null };
    if (row.sourceTokenAccount !== null) {
        return { ...base, source: row.sourceTokenAccount, owner: row.sourceOwner, signed: true };
    }
    let fell: { account: string; owner: string | null; micros: bigint } | null = null;
    for (const [account, e] of tx.tokenAccounts) {
        const micros = (e.pre ?? 0n) - (e.post ?? 0n);
        if (account === tokenAccount || micros <= 0n) continue;
        if (fell === null || micros > fell.micros) fell = { account, owner: e.owner, micros };
    }
    return { ...base, source: fell?.account ?? null, owner: fell?.owner ?? null, signed: false };
}

// The credits a return-late transaction names in its memos
async function lateMemos(rpc: SolanaRpc, sig: string, timeoutMs: number): Promise<string[]> {
    const raw: unknown = await rpc
        .getTransaction(toSignature(sig), {
            encoding: "jsonParsed",
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        })
        .send(deadline(timeoutMs));
    const tx = isRecord(raw) ? raw.transaction : null;
    const message = isRecord(tx) ? tx.message : null;
    if (!isRecord(message) || !Array.isArray(message.instructions)) {
        throw new Error(`transaction ${sig} is not available yet; run again shortly`);
    }
    const credits: string[] = [];
    for (const ix of message.instructions as unknown[]) {
        if (isRecord(ix) && ix.programId === MEMO_PROGRAM && typeof ix.parsed === "string") {
            if (ix.parsed.startsWith(LATE_MEMO)) credits.push(ix.parsed.slice(LATE_MEMO.length));
        }
    }
    return credits;
}

/**
 * Every credit since the deposit's cursor that the job never recorded, oldest first, read like a
 * scan entry (spec 6.1), and the account's creator: the fee payer of its newest creation, which
 * made the account that holds the money now.
 */
async function lateCredits(
    ctx: CliContext,
    rpc: SolanaRpc,
    deposit: DepositRow,
): Promise<{ credits: LateCredit[]; creator: string | null }> {
    const timeoutMs = ctx.settings.solana.rpc_timeout;
    const entries: { signature: string; slot: bigint; failed: boolean }[] = [];
    for (;;) {
        const before = entries.at(-1)?.signature;
        const page = await rpc
            .getSignaturesForAddress(address(deposit.tokenAccount), {
                commitment: "confirmed",
                limit: LISTING_PAGE,
                ...(deposit.lastSignature === null
                    ? {}
                    : { until: toSignature(deposit.lastSignature) }),
                ...(before === undefined ? {} : { before: toSignature(before) }),
            })
            .send(deadline(timeoutMs));
        for (const e of page) {
            entries.push({ signature: e.signature, slot: BigInt(e.slot), failed: e.err !== null });
        }
        if (page.length < LISTING_PAGE) break;
    }
    const { rows } = await ctx.pool.query<{ signature: string }>(
        "select signature from deposit_transfers where order_id = $1",
        [deposit.orderId],
    );
    const recorded = new Set(rows.map((r) => r.signature));
    const cache = new TxCache(entries.length + 1);
    const credits: LateCredit[] = [];
    const returned = new Map<string, string>();
    let creator: string | null = null;
    for (const e of entries) {
        if (e.failed || recorded.has(e.signature)) continue;
        const tx = await fetchTx(rpc, cache, e.signature, e.slot, timeoutMs);
        if (tx === null || tx.noMeta) {
            throw new Error(`transaction ${e.signature} is not available yet; run again shortly`);
        }
        creator ??= createdBy(tx, deposit.tokenAccount);
        const item = classifyTx(tx, deposit, ctx.now(), 0);
        if (item.kind === "transfer" || item.kind === "unreadable") {
            credits.push(creditOf(tx, item.row, deposit.tokenAccount));
        } else if (item.kind === "unknown_debit" && tx.signers.includes(deposit.address)) {
            // Only the deposit key signs a debit, so only Bugnet's own memos count here
            for (const credit of await lateMemos(rpc, e.signature, timeoutMs)) {
                returned.set(credit, e.signature);
            }
        }
    }
    credits.reverse();
    for (const c of credits) c.returnedIn = returned.get(c.signature) ?? null;
    return { credits, creator };
}

const creditLine = (c: LateCredit): string =>
    [
        c.signature,
        c.micros,
        `source=${orDash(c.source)}`,
        `owner=${orDash(c.owner)}`,
        `signed=${c.signed ? "yes" : "no"}`,
        ...(c.returnedIn === null ? [] : [`returned=${c.returnedIn}`]),
    ].join(" ");

/**
 * Spec 6.7, 17: USDC sent to a done address goes back by hand. Each named credit goes to its own
 * signer-owned source for its own amount, so two people's late money never goes to one of them,
 * and the account closes to its creator only when nothing else is left in it.
 */
async function depositsReturnLate(
    ctx: CliContext,
    io: CliIo,
    [orderId = ""]: readonly string[],
    flags: Flags,
): Promise<number> {
    const deposit = await findDeposit(ctx.pool, orderId);
    if (deposit === null) return fail(io, noDeposit(orderId));
    if (deposit.state !== "done") {
        return fail(io, `deposit ${orderId} is ${deposit.state}, not done`);
    }
    const named = [...new Set(flags.signatures ?? [])];
    const signer = named.length === 0 ? null : await depositSigner(ctx, deposit);
    if (typeof signer === "string") return fail(io, signer);
    const feePayer = signer === null ? null : await feePayerOf(ctx.env);
    const rpc = await ctx.rpc();
    const { credits, creator } = await lateCredits(ctx, rpc, deposit);
    if (signer === null || feePayer === null) {
        for (const c of credits) io.out(creditLine(c));
        if (credits.length === 0) io.out("no credits since the cursor");
        return 0;
    }
    const picked: (LateCredit & { source: string; owner: string })[] = [];
    for (const sig of named) {
        const c = credits.find((x) => x.signature === sig);
        if (c === undefined) {
            return fail(io, `${sig} is not a credit of ${orderId} since its cursor`);
        }
        if (c.returnedIn !== null) return fail(io, `credit ${sig} was returned in ${c.returnedIn}`);
        if (!c.signed || c.source === null || c.owner === null) {
            return fail(io, `credit ${sig} has no signer-owned source`);
        }
        picked.push({ ...c, source: c.source, owner: c.owner });
    }
    const timeoutMs = ctx.settings.solana.rpc_timeout;
    for (const c of picked) {
        if (!(await ownedUsdcAccount(rpc, address(c.source), c.owner, timeoutMs))) {
            return fail(
                io,
                `source ${c.source} of ${c.signature} is not a USDC account of its owner`,
            );
        }
    }
    const account = await inspectTokenAccount(
        rpc,
        address(deposit.tokenAccount),
        deadline(timeoutMs),
    );
    const total = picked.reduce((sum, c) => sum + c.micros, 0n);
    const held = account?.amount ?? 0n;
    if (held < total) {
        return fail(
            io,
            `the deposit account holds ${held}, less than the named credits (${total})`,
        );
    }
    const closeTo = held === total ? (creator ?? deposit.rentPayer) : null;
    const instructions: Instruction[] = [];
    for (const c of picked) {
        instructions.push(await usdcTransferChecked(signer, address(c.source), c.micros), {
            programAddress: MEMO_PROGRAM,
            data: new TextEncoder().encode(`${LATE_MEMO}${c.signature}`),
        });
    }
    if (closeTo !== null) {
        instructions.push(
            getCloseAccountInstruction({
                account: address(deposit.tokenAccount),
                destination: address(closeTo),
                owner: signer,
            }),
        );
    }
    // One return move's budget per credit: each carries a transfer and a memo
    const units = ctx.settings.deposits.compute_unit_limit * picked.length;
    const sent = await sendSigned(ctx, io, rpc, feePayer, instructions, units);
    io.out(`confirmed ${sent}`);
    for (const c of picked) io.out(`returned ${c.signature} ${c.micros} to ${c.source}`);
    if (closeTo !== null) io.out(`closed the account to ${closeTo}`);
    else if (held === total) io.out("the account stays open: its creator is unknown");
    else io.out(`the account keeps ${held - total}`);
    return 0;
}

// Spec 12: the deposit address is a wallet with no data, so it needs no rent-exempt minimum and
// all of its SOL goes back
async function depositsReturnSol(
    ctx: CliContext,
    io: CliIo,
    [orderId = "", to = ""]: readonly string[],
): Promise<number> {
    const deposit = await findDeposit(ctx.pool, orderId);
    if (deposit === null) return fail(io, noDeposit(orderId));
    const signer = await depositSigner(ctx, deposit);
    if (typeof signer === "string") return fail(io, signer);
    const feePayer = await feePayerOf(ctx.env);
    const rpc = await ctx.rpc();
    const { value: lamports } = await rpc
        .getBalance(address(deposit.address), { commitment: "confirmed" })
        .send(deadline(ctx.settings.solana.rpc_timeout));
    if (lamports === 0n) return fail(io, `deposit ${orderId} holds no SOL`);
    const transfer = getTransferSolInstruction({
        source: signer,
        destination: address(to),
        amount: lamports,
    });
    const sent = await sendSigned(
        ctx,
        io,
        rpc,
        feePayer,
        [transfer],
        ctx.settings.deposits.compute_unit_limit,
    );
    io.out(`confirmed ${sent}`);
    io.out(`returned ${lamports} lamports to ${to}`);
    return 0;
}

if (import.meta.main) {
    process.exitCode = await cliMain(process.argv.slice(2), process.env, {
        out: (s) => process.stdout.write(`${s}\n`),
        err: (s) => process.stderr.write(`${s}\n`),
        stdin: () => text(process.stdin),
    });
}
