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
import { BootCheckError, bootChecks } from "./boot.ts";
import { ConfigError, loadSettings, readSecrets, type Secrets, type Settings } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { eventPublicKey, handleEvent } from "./events/handler.ts";
import { createInternalHandler } from "./http/internal.ts";
import { createPublicHandler } from "./http/public.ts";
import { startServer } from "./http/server.ts";
import { type AlarmSnapshot, checkAlarms } from "./jobs/alarms.ts";
import { auditInflows } from "./jobs/audit.ts";
import { dailyAt, every } from "./jobs/every.ts";
import { reconcileSettling } from "./jobs/reconciler.ts";
import { sweep } from "./jobs/sweeper.ts";
import { jsonLog, type Log } from "./log.ts";
import { createPayDeps, payOrder } from "./orders/pay.ts";
import { orderKey } from "./orders/token.ts";
import { RateLimiter } from "./ratelimit.ts";
import { runRefunds } from "./refunds/executor.ts";
import { createRouterClient, type RouterClient } from "./router/client.ts";
import { BlockhashCache } from "./solana/blockhash.ts";
import { loadKeypair } from "./solana/keys.ts";
import { createRpc, type SolanaRpc } from "./solana/rpc.ts";
import { createSettler } from "./x402/settler.ts";

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

const MINUTE_MS = 60_000;
const CHECKOUT_JS = "dist/checkout.js";
const USAGE = "usage: main.js -config FILE";
const SECRET_VARS = [
    "BUGNET_SOLANA_RPC_URL",
    "BUGNET_PAYMENTS_TOKEN",
    "BUGNET_PAYMENTS_ROUTER_TOKEN",
    "BUGNET_FEE_PAYER_KEY",
    "BUGNET_REFUND_KEY",
];

export async function startService(o: StartOptions): Promise<RunningService> {
    const { settings: s, secrets } = o;
    const now = o.now ?? (() => new Date());
    const log =
        o.log ??
        jsonLog("payments", {
            secrets: [
                secrets.rpcUrl,
                secrets.paymentsToken,
                secrets.routerToken,
                secrets.feePayerKey,
                secrets.refundKey,
            ].filter(Boolean),
        });
    const pool = createPool(s.database.url, log);
    const closers: Array<() => Promise<void>> = [() => pool.end()];
    const closeAll = async () => {
        for (const close of closers.reverse()) {
            await close().catch((err: unknown) => log.warn("close failed", { err }));
        }
    };
    try {
        const migrations = await migrate(pool);

        const feePayer = await loadKeypair(secrets.feePayerKey, "BUGNET_FEE_PAYER_KEY");
        const refundSigner = await loadKeypair(secrets.refundKey, "BUGNET_REFUND_KEY");
        const rpc = o.rpc ?? createRpc(secrets.rpcUrl);
        const hints = new BlockhashCache(rpc, s.solana.blockhash_cache_ttl, () => now().getTime());
        const settler = createSettler({
            feePayer,
            rpc,
            hints,
            caps: {
                maxComputeUnits: s.solana.max_compute_units,
                maxPriorityFeeMicroLamports: s.solana.max_priority_fee_micro_lamports,
                maxRequiredSignatures: s.solana.max_required_signatures,
            },
            transactionVersions: s.solana.transaction_versions,
            log,
        });
        const router = createRouterClient({
            url: s.router.url,
            token: secrets.routerToken,
            timeoutMs: s.router.timeout,
            checkPayer: s.router.check_payer,
            getOrder: s.router.get_order,
            log,
        });
        const key = orderKey(secrets.orderSeed);
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

        const challenge = {
            publicUrl: s.http.public_url,
            recipient: s.solana.recipient,
            feePayer: feePayer.address,
            transactionVersions: s.solana.transaction_versions,
        };
        const pay = createPayDeps({
            pool,
            settler,
            router,
            attempts: new RateLimiter(s.orders.attempts_per_order_per_minute, MINUTE_MS),
            challenge,
            log,
            now,
        });
        const eventKey =
            s.router.event_public_key === "" ? null : eventPublicKey(s.router.event_public_key);
        const internal = await startServer(
            s.http.internal_listen,
            createInternalHandler({
                service: {
                    pool,
                    settings: s,
                    challenge,
                    hints,
                    orderKey: key,
                    claimKey: secrets.claimKey,
                    pay: (orderId, raw, signal) => payOrder(pay, orderId, raw, signal),
                    log,
                    now,
                },
                token: secrets.paymentsToken,
                events: (raw, headers) =>
                    handleEvent({ pool, key: eventKey, log, now }, raw, headers),
                maxBodyBytes: s.http.max_body_bytes,
                log,
            }),
            log,
        );
        closers.push(internal.close);
        const publicServer = await startServer(
            s.http.public_listen,
            createPublicHandler({
                pool,
                challenge,
                hints,
                pay,
                perIp: new RateLimiter(s.limits.public_per_ip_per_minute, MINUTE_MS),
                statusPerIp: new RateLimiter(s.limits.status_per_ip_per_minute, MINUTE_MS),
                trustedProxies: s.http.trusted_proxies,
                maxBodyBytes: s.http.max_body_bytes,
                checkoutJsPath: CHECKOUT_JS,
                log,
                now,
            }),
            log,
        );
        closers.push(publicServer.close);

        const jobs = startJobs({
            s,
            pool,
            rpc,
            router,
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

    const reconcile = tracked(() => reconcileSettling({ pool, rpc, rpcTimeoutMs, log, now }));
    const first = reconcile().catch((err: unknown) =>
        log.error("job failed", { job: "reconcile", err }),
    );
    let snapshot: AlarmSnapshot | null = null;
    const stops = [
        every(
            s.jobs.sweep_every,
            "sweep",
            tracked(() => sweep({ pool, router: d.router, orders: s.orders, log, now })),
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
                    runRefunds({
                        pool,
                        rpc,
                        feePayer: d.feePayer,
                        refundSigner: d.refundSigner,
                        cfg: s.refunds,
                        rpcTimeoutMs,
                        log,
                        now,
                    }),
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

// An Error prints as its name and message, a stack or cause may hold the RPC URL in another form
function formatArgs(args: unknown[]): string {
    return format(...args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : a)));
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
    const log = jsonLog("payments", {
        secrets: SECRET_VARS.map((name) => env[name] ?? "").filter(Boolean),
    });
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
