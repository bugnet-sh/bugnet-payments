/**
 * Payments service entry point.
 *
 * startService opens the database and migrates it, builds the Solana and router clients, refuses
 * to start when a boot check fails, then opens the internal listener (gateway and router) and the
 * public one (pay.bugnet.sh) and starts the periodic jobs. main reads -config and the environment,
 * runs the service until SIGTERM or SIGINT, then stops the jobs, the listeners and the pool in
 * that order.
 */
import { format } from "node:util";
import { type Address, address, type KeyPairSigner } from "@solana/kit";
import type pg from "pg";
import { BootCheckError, bootChecks, refuseUnfinishedAllowanceOrders } from "./boot.ts";
import {
    ConfigError,
    loadSettings,
    readSecrets,
    type Secrets,
    secretsEnv,
    secretValues,
    type Settings,
} from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { createHttpApp } from "./http/app.ts";
import { startServer } from "./http/server.ts";
import { type AlarmSnapshot, checkAlarms } from "./jobs/alarms.ts";
import { auditInflows } from "./jobs/audit.ts";
import { dailyAt, every } from "./jobs/every.ts";
import { reconcileSettling } from "./jobs/reconciler.ts";
import { sweep } from "./jobs/sweeper.ts";
import { jsonLog, type Log } from "./log.ts";
import { runRefunds } from "./refunds/executor.ts";
import { createAllowanceFunding } from "./x402/funding.ts";
import type { RouterClient } from "./router/client.ts";
import { loadKeypair } from "./solana/keys.ts";
import { createRpc, type SolanaRpc } from "./solana/rpc.ts";

export interface StartOptions {
    settings: Settings;
    secrets: Secrets;
    rpc?: SolanaRpc;
    log?: Log;
    now?: () => Date;
}

export interface RunningService {
    internalPort: number;
    publicPort: number;
    pool: pg.Pool;
    stop(): Promise<void>;
}

const USAGE = "usage: main.js -config FILE";

export async function startService(o: StartOptions): Promise<RunningService> {
    const { settings: s, secrets } = o;
    const now = o.now ?? (() => new Date());
    const log =
        o.log ?? jsonLog("payments", { secrets: secretValues(secretsEnv(secrets), process.env) });
    const pool = createPool(s.database.url, log);
    const closers: Array<() => Promise<void>> = [() => pool.end()];
    const closeAll = async () => {
        for (const close of [...closers].reverse()) {
            await close().catch((err: unknown) => log.warn("close failed", { err }));
        }
    };
    try {
        const migrations = await migrate(pool);
        if (s.x402.allowance_wallet === "") await refuseUnfinishedAllowanceOrders(pool);

        const feePayer = await loadKeypair(secrets.feePayerKey, "BUGNET_FEE_PAYER_KEY");
        const refundSigner = await loadKeypair(secrets.refundKey, "BUGNET_REFUND_KEY");
        const rpc = o.rpc ?? createRpc(secrets.rpcUrl);
        const http = createHttpApp({ settings: s, secrets, pool, rpc, feePayer, log, now });
        const recipient = address(s.solana.recipient);

        const boot = await bootChecks({
            rpc,
            recipient,
            feePayer: feePayer.address,
            refundWallet: refundSigner.address,
            feePayerMinLamports: BigInt(s.solana.fee_payer_boot_min_lamports),
            refundsEnabled: s.refunds.enabled,
            eventPublicKey: s.router.event_public_key,
        });
        if (s.orders.max_amount_micros > s.refunds.daily_cap_micros) {
            log.warn(
                "orders.max_amount_micros is above refunds.daily_cap_micros, " +
                    "a refund above the cap always goes to the manual queue",
                {
                    maxAmountMicros: s.orders.max_amount_micros,
                    dailyCapMicros: s.refunds.daily_cap_micros,
                    manualReason: "refund_exceeds_cap",
                },
            );
        }

        const internal = await startServer(s.http.internal_listen, http.internalHandler, log);
        closers.push(internal.close);
        const publicServer = await startServer(s.http.public_listen, http.publicHandler, log);
        closers.push(publicServer.close);

        const jobs = startJobs({
            s,
            pool,
            rpc,
            router: http.router,
            feePayer,
            refundSigner,
            recipient,
            log,
            now,
        });
        log.info("payments started", {
            internalPort: internal.port,
            publicPort: publicServer.port,
            migrations,
            feePayer: feePayer.address,
            feePayerLamports: boot.feePayerLamports,
            refunds: s.refunds.enabled,
        });

        let stopping: Promise<void> | undefined;
        return {
            internalPort: internal.port,
            publicPort: publicServer.port,
            pool,
            stop: () =>
                (stopping ??= (async () => {
                    await jobs.stop();
                    await closeAll();
                })()),
        };
    } catch (err) {
        await closeAll();
        throw err;
    }
}

interface JobDeps {
    s: Settings;
    pool: pg.Pool;
    rpc: SolanaRpc;
    router: RouterClient;
    feePayer: KeyPairSigner;
    refundSigner: KeyPairSigner;
    recipient: Address;
    log: Log;
    now: () => Date;
}

function startJobs(d: JobDeps): { stop(): Promise<void> } {
    const { s, pool, rpc, log, now } = d;
    const rpcTimeoutMs = s.solana.rpc_timeout;
    // Each run is kept until it ends, so stop lets a running job finish before the pool closes
    const running = new Set<Promise<unknown>>();
    let stopped = false;
    const tracked = (fn: () => Promise<unknown>) => (): Promise<unknown> => {
        if (stopped) return Promise.resolve();
        const run = fn();
        running.add(run);
        const done = () => running.delete(run);
        run.then(done, done);
        return run;
    };

    const funding = createAllowanceFunding({ x402: s.x402, log });
    const paid = { funding, x402: s.x402, log };
    const reconcile = tracked(() =>
        reconcileSettling({ pool, rpc, rpcTimeoutMs, log, now, paid, x402: s.x402 }),
    );
    const sweepFunding = s.x402.allowance_wallet === "" ? null : funding;
    const first = reconcile().catch((err: unknown) =>
        log.error("job failed", { job: "reconcile", err }),
    );
    let snapshot: AlarmSnapshot | null = null;
    const unavailableAlarmed = new Set<string>();
    const stops = [
        every(
            s.jobs.sweep_every,
            "sweep",
            tracked(() =>
                sweep({
                    pool,
                    router: d.router,
                    orders: s.orders,
                    funding: sweepFunding,
                    x402: s.x402,
                    log,
                    now,
                    unavailableAlarmed,
                }),
            ),
            log,
        ),
        // The first tick waits for the run at start, so the two never overlap
        every(s.jobs.reconcile_every, "reconcile", () => first.then(reconcile), log),
        every(
            s.jobs.alarms_every,
            "alarms",
            tracked(async () => {
                snapshot = await checkAlarms(
                    {
                        pool,
                        rpc,
                        feePayer: d.feePayer.address,
                        refundWallet: d.refundSigner.address,
                        alarms: s.alarms,
                        refunds: s.refunds,
                        rpcTimeoutMs,
                        log,
                        now,
                    },
                    snapshot,
                );
            }),
            log,
        ),
        dailyAt(
            s.jobs.audit_at_utc,
            "audit",
            tracked(async () => {
                const r = await auditInflows({
                    pool,
                    rpc,
                    recipient: d.recipient,
                    rpcTimeoutMs,
                    log,
                    now,
                });
                log.info("audit finished", {
                    scanned: r.scanned,
                    matched: r.matched,
                    mismatches: r.mismatches.length,
                    missing: r.missing.length,
                });
            }),
            log,
            now,
        ),
    ];
    if (s.refunds.enabled) {
        stops.push(
            every(
                s.jobs.refunds_every,
                "refunds",
                tracked(() =>
                    runRefunds(
                        {
                            pool,
                            rpc,
                            feePayer: d.feePayer,
                            refundSigner: d.refundSigner,
                            allowanceSigner: null,
                            x402: s.x402,
                            hotTokenAccount: null,
                            cfg: s.refunds,
                            rpcTimeoutMs,
                            log,
                            now,
                        },
                        "refund",
                    ),
                ),
                log,
            ),
        );
    }
    return {
        async stop() {
            stopped = true;
            for (const stop of stops) stop();
            await Promise.allSettled([...running]);
        },
    };
}

// An Error at any depth prints as its name and message, a stack or cause may hold a secret
function plain(value: unknown, seen: WeakSet<object>): unknown {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
        if (Array.isArray(value)) return value.map((v) => plain(v, seen));
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v, seen)]));
    } finally {
        seen.delete(value);
    }
}

function formatArgs(args: unknown[]): string {
    return format(...args.map((a) => plain(a, new WeakSet())));
}

export function routeConsole(log: Log): () => void {
    const { error, warn } = console;
    console.error = (...args: unknown[]) => log.error(formatArgs(args));
    console.warn = (...args: unknown[]) => log.warn(formatArgs(args));
    return () => {
        console.error = error;
        console.warn = warn;
    };
}

function configPath(argv: readonly string[]): string | null {
    if (argv.length !== 2 || (argv[0] !== "-config" && argv[0] !== "--config")) return null;
    return argv[1]!;
}

function untilSignal(): Promise<NodeJS.Signals> {
    return new Promise((resolve) => {
        const on = (signal: NodeJS.Signals) => {
            process.off("SIGTERM", on);
            process.off("SIGINT", on);
            resolve(signal);
        };
        process.on("SIGTERM", on);
        process.on("SIGINT", on);
    });
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
    const log = jsonLog("payments", { secrets: secretValues(env) });
    const restore = routeConsole(log);
    try {
        const config = configPath(argv);
        if (config === null) {
            log.error(USAGE);
            return 2;
        }
        const settings = loadSettings(config);
        const service = await startService({ settings, secrets: readSecrets(env, settings), log });
        const signal = await untilSignal();
        log.info("payments stopping", { signal });
        await service.stop();
        log.info("payments stopped");
        return 0;
    } catch (err) {
        if (err instanceof ConfigError) {
            log.error("configuration invalid", { reason: err.message });
        } else if (err instanceof BootCheckError) {
            log.error("boot check failed", { reason: err.message });
        } else {
            log.error("payments failed", { err });
        }
        return 1;
    } finally {
        restore();
    }
}

if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2), process.env);
}
