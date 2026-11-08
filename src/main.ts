/**
 * Payments service entry point.
 *
 * startService opens the database and migrates it, builds the Solana and router clients, refuses
 * to start when a boot check fails, then opens the internal listener (gateway and router) and the
 * public one (pay.bugnet.sh) and starts the periodic jobs. main reads -config and the environment,
 * runs the service until SIGTERM or SIGINT, then stops the jobs, the listeners and the pool in
 * that order.
 *
 * With [x402] allowance_wallet set it also checks the allowance wallet and the signer's TLS files
 * at boot, opens the signer listener (mTLS, loopback) and starts the x402 jobs, each under a
 * database lock so two processes never run the same one. SIGHUP reloads the indexed-services copy
 * and the TLS files.
 */
import { readFileSync } from "node:fs";
import { format } from "node:util";
import { type Address, address, type KeyPairSigner } from "@solana/kit";
import type pg from "pg";
import {
    BootCheckError,
    bootChecks,
    refuseUnfinishedAllowanceOrders,
    x402BootChecks,
} from "./boot.ts";
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
import { createHttpApp, type HttpX402Parts } from "./http/app.ts";
import { startServer } from "./http/server.ts";
import { type AlarmSnapshot, checkAlarms } from "./jobs/alarms.ts";
import { auditInflows } from "./jobs/audit.ts";
import { dailyAt, every, paced } from "./jobs/every.ts";
import { reconcileSettling } from "./jobs/reconciler.ts";
import { RUNNER_KEYS, singleRunner } from "./jobs/single-runner.ts";
import { sweep } from "./jobs/sweeper.ts";
import { jsonLog, type Log } from "./log.ts";
import { orderPublicKeyBase64 } from "./orders/token.ts";
import { runRefunds } from "./refunds/executor.ts";
import type { RouterClient } from "./router/client.ts";
import { usdcAta } from "./solana/accounts.ts";
import { countingRpc } from "./solana/budget.ts";
import { loadKeypair } from "./solana/keys.ts";
import { createRpc, type SolanaRpc } from "./solana/rpc.ts";
import { auditX402 } from "./x402/audit.ts";
import { runCloseCheck, runCloseJob } from "./x402/close.ts";
import { advanceColdTransfers, runColdTransfer } from "./x402/cold.ts";
import { fastPassNeeded, runFastPass } from "./x402/fastpass.ts";
import { createAllowanceFunding, type AllowanceFunding } from "./x402/funding.ts";
import { bugnetAddresses } from "./x402/ids.ts";
import { type IndexCopy, loadIndex, parseIndex } from "./x402/index-file.ts";
import {
    certExpiryAlarm,
    checkTlsFiles,
    SERVER_NAME,
    SignerGate,
    type SignerListener,
    startSignerListener,
    type TlsFiles,
} from "./x402/listener.ts";
import { type MirrorDeps, mirrorBusy, mirrorInterval, runMirror } from "./x402/mirror.ts";
import { runOutbox } from "./x402/outbox.ts";
import { runReleaseJob } from "./x402/reserve.ts";
import { createSignerService } from "./x402/signer.ts";

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
    x402Port: number | null;
    pool: pg.Pool;
    stop(): Promise<void>;
}

const USAGE = "usage: main.js -config FILE";
const EMPTY_INDEX = parseIndex('{"v":1,"services":[]}', "none");

export function installReload(onReload: () => void): () => void {
    process.on("SIGHUP", onReload);
    return () => {
        process.off("SIGHUP", onReload);
    };
}

// A bad file keeps the copy in use and alarms, so a typo never empties the index
export function indexHolder(
    path: string,
    log: Log,
    initial: IndexCopy,
): { current(): IndexCopy; reload(): boolean } {
    let copy = initial;
    return {
        current: () => copy,
        reload() {
            try {
                copy = loadIndex(path);
                return true;
            } catch (err) {
                const problem = err instanceof Error ? err.message : String(err);
                log.alarm("x402_reload_failed", { file: path, problem });
                return false;
            }
        },
    };
}

// An unreadable file gives "", which the TLS check then fails
function readOrEmpty(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

// What the x402 jobs and the signer listener share once the boot checks have passed
interface X402Wiring {
    allowance: KeyPairSigner;
    hotTokenAccount: Address;
    coldTokenAccount: Address;
    gate: SignerGate;
    mirrorDeps: MirrorDeps;
    mirrorOnce: () => ReturnType<typeof singleRunner<Awaited<ReturnType<typeof runMirror>>>>;
    index: { current(): IndexCopy; reload(): boolean };
    readTls: () => TlsFiles;
    listener: () => SignerListener | null;
    // startJobs points it at the fast pass, the signer calls it after a commit
    wakeFastPass: { run: () => void };
}

export async function startService(o: StartOptions): Promise<RunningService> {
    const { settings: s, secrets } = o;
    const now = o.now ?? (() => new Date());
    const log =
        o.log ?? jsonLog("payments", { secrets: secretValues(secretsEnv(secrets), process.env) });
    const pool = createPool(s.database.url, log, s.database.pool_max);
    const closers: Array<() => Promise<void>> = [() => pool.end()];
    const closeAll = async () => {
        for (const close of [...closers].reverse()) {
            await close().catch((err: unknown) => log.warn("close failed", { err }));
        }
    };
    let removeReload = () => {};
    let reload: (() => void) | null = null;
    let stopping: Promise<void> | undefined;
    let opening: Promise<void> | undefined;
    try {
        const migrations = await migrate(pool);
        removeReload = installReload(() => {
            if (reload === null) log.info("reload ignored before start");
            else reload();
        });
        if (s.x402.allowance_wallet === "") await refuseUnfinishedAllowanceOrders(pool);

        const feePayer = await loadKeypair(secrets.feePayerKey, "BUGNET_FEE_PAYER_KEY");
        const refundSigner = await loadKeypair(secrets.refundKey, "BUGNET_REFUND_KEY");
        const x402On = s.x402.allowance_wallet !== "";
        const rpc0 = o.rpc ?? createRpc(secrets.rpcUrl);
        const rpc = x402On
            ? countingRpc(rpc0, {
                  limitPerHour: s.x402.rpc_calls_per_hour_alarm,
                  log,
                  now: () => now().getTime(),
              })
            : rpc0;
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

        const funding = createAllowanceFunding({ x402: s.x402, log });
        const addresses = bugnetAddresses({
            feePayer: feePayer.address,
            allowanceWallet: s.x402.allowance_wallet,
            refundWallet: refundSigner.address,
            recipient: s.solana.recipient,
        });
        let wiring: X402Wiring | null = null;
        const signer: { current: SignerListener | null } = { current: null };
        let parts: HttpX402Parts = {
            index: () => EMPTY_INDEX,
            signer: { open: () => false },
            addresses,
            funding,
        };
        if (x402On) {
            const gate = new SignerGate({
                staleAfterMs: s.x402.signer_check_stale_after,
                log,
                now,
            });
            const readTls = (): TlsFiles => ({
                certPem: readOrEmpty(s.x402.tls_cert_file),
                caPem: readOrEmpty(s.x402.client_ca_file),
                keyPem: secrets.x402TlsKey,
            });
            const allowanceWallet = address(s.x402.allowance_wallet);
            const mirrorDeps: MirrorDeps = {
                pool,
                rpc,
                allowanceWallet,
                hotTokenAccount: await usdcAta(allowanceWallet),
                coldTokenAccount: await usdcAta(recipient),
                x402: s.x402,
                gate,
                log,
                now,
                rpcTimeoutMs: s.solana.rpc_timeout,
            };
            const mirrorOnce = () =>
                singleRunner(pool, RUNNER_KEYS.mirror, () => runMirror(mirrorDeps));
            const checked = await x402BootChecks(rpc, {
                pool,
                allowanceKey: secrets.allowanceKey,
                x402: s.x402,
                others: {
                    feePayer: feePayer.address,
                    refundWallet: refundSigner.address,
                    recipient: s.solana.recipient,
                    orderPublicKeyBase64: orderPublicKeyBase64(secrets.orderSeed),
                },
                routerToken: secrets.routerToken,
                eventPublicKey: s.router.event_public_key,
                tls: readTls(),
                gate,
                runMirror: mirrorOnce,
                log,
                now,
            });
            const index = indexHolder(s.x402.indexed_services_file, log, checked.index);
            wiring = {
                allowance: checked.allowance,
                hotTokenAccount: checked.hotTokenAccount,
                coldTokenAccount: mirrorDeps.coldTokenAccount,
                gate,
                mirrorDeps,
                mirrorOnce,
                index,
                readTls,
                listener: () => signer.current,
                wakeFastPass: { run: () => {} },
            };
            parts = { index: index.current, signer: gate, addresses, funding };
        }
        const http = createHttpApp({
            settings: s,
            secrets,
            pool,
            rpc,
            feePayer,
            x402: parts,
            log,
            now,
        });

        const internal = await startServer(s.http.internal_listen, http.internalHandler, log);
        closers.push(internal.close);
        const publicServer = await startServer(s.http.public_listen, http.publicHandler, log);
        closers.push(publicServer.close);

        const openListener = (w: X402Wiring, files: TlsFiles): Promise<void> =>
            (opening ??= (async () => {
                try {
                    if (signer.current !== null || stopping !== undefined) return;
                    const started = await startSignerListener({
                        listen: s.x402.listen,
                        files,
                        clientName: s.x402.client_name,
                        gate: w.gate,
                        service: createSignerService({
                            pool,
                            rpc,
                            allowance: w.allowance,
                            hotTokenAccount: w.hotTokenAccount,
                            x402: s.x402,
                            addresses,
                            router: http.router,
                            log,
                            now,
                            wakeFastPass: () => w.wakeFastPass.run(),
                        }),
                        log,
                    });
                    signer.current = started;
                    closers.push(started.close);
                } finally {
                    opening = undefined;
                }
            })());
        if (wiring !== null) {
            const w = wiring;
            const files = w.readTls();
            if (checkTlsFiles(files, SERVER_NAME, now()).ok) await openListener(w, files);
            reload = () => {
                w.index.reload();
                const next = w.readTls();
                if (signer.current !== null) {
                    if (signer.current.reload(next)) w.gate.record("tls", "pass");
                } else {
                    const check = checkTlsFiles(next, SERVER_NAME, now());
                    if (!check.ok) {
                        log.alarm("x402_reload_failed", { file: "tls", problem: check.problem });
                        return;
                    }
                    openListener(w, next).then(
                        () => w.gate.record("tls", "pass"),
                        (err: unknown) => {
                            log.error("x402 listener failed to start", { err });
                            log.alarm("x402_reload_failed", {
                                file: "tls",
                                problem: err instanceof Error ? err.message : String(err),
                            });
                        },
                    );
                }
            };
        } else {
            reload = () => log.info("reload ignored: allowance_wallet is empty");
        }

        const jobs = startJobs({
            s,
            pool,
            rpc,
            router: http.router,
            feePayer,
            refundSigner,
            recipient,
            funding,
            x402: wiring,
            log,
            now,
        });
        log.info("payments started", {
            internalPort: internal.port,
            publicPort: publicServer.port,
            x402Port: signer.current?.port ?? null,
            migrations,
            feePayer: feePayer.address,
            feePayerLamports: boot.feePayerLamports,
            refunds: s.refunds.enabled,
        });

        return {
            internalPort: internal.port,
            publicPort: publicServer.port,
            x402Port: signer.current?.port ?? null,
            pool,
            stop: () =>
                (stopping ??= (async () => {
                    // A listener still starting would register its closer after closeAll ran
                    await opening?.catch(() => {});
                    await jobs.stop();
                    await closeAll();
                    removeReload();
                })()),
        };
    } catch (err) {
        await closeAll();
        removeReload();
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
    funding: AllowanceFunding;
    x402: X402Wiring | null;
    log: Log;
    now: () => Date;
}

function startJobs(d: JobDeps): { stop(): Promise<void> } {
    const { s, pool, rpc, log, now } = d;
    const x = d.x402;
    const rpcTimeoutMs = s.solana.rpc_timeout;
    // Each run is kept until it ends, so stop lets a running job finish before the pool closes
    const running = new Set<Promise<unknown>>();
    let stopped = false;
    const track = <T>(run: Promise<T>): Promise<T> => {
        running.add(run);
        const done = () => running.delete(run);
        run.then(done, done);
        return run;
    };
    const tracked = (fn: () => Promise<unknown>) => (): Promise<unknown> =>
        stopped ? Promise.resolve() : track(fn());

    const funding = x === null ? null : d.funding;
    const paid = funding === null ? null : { funding, x402: s.x402, log };
    const reconcile = tracked(() =>
        reconcileSettling({ pool, rpc, rpcTimeoutMs, log, now, paid, x402: s.x402 }),
    );
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
                    funding,
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
                if (x === null) return;
                try {
                    await auditX402({
                        pool,
                        rpc,
                        hotTokenAccount: x.hotTokenAccount,
                        x402: s.x402,
                        rpcTimeoutMs,
                        log,
                        now,
                    });
                } finally {
                    const tls = checkTlsFiles(x.readTls(), SERVER_NAME, now());
                    if (tls.ok) {
                        certExpiryAlarm({
                            serverNotAfter: tls.serverNotAfter,
                            caNotAfter: tls.caNotAfter,
                            clientNotAfter: x.listener()?.lastClientCertNotAfter() ?? null,
                            beforeMs: s.x402.cert_expiry_alarm_before,
                            now: now(),
                            log,
                        });
                    }
                }
            }),
            log,
            now,
        ),
    ];
    const refundDeps = {
        pool,
        rpc,
        feePayer: d.feePayer,
        refundSigner: d.refundSigner,
        x402: s.x402,
        cfg: s.refunds,
        rpcTimeoutMs,
        log,
        now,
    };
    if (s.refunds.enabled) {
        stops.push(
            every(
                s.jobs.refunds_every,
                "refunds",
                tracked(() =>
                    runRefunds(
                        { ...refundDeps, allowanceSigner: null, hotTokenAccount: null },
                        "refund",
                    ),
                ),
                log,
            ),
        );
    }
    if (x !== null) stops.push(...startX402Jobs(d, x, tracked, track, refundDeps));
    return {
        async stop() {
            stopped = true;
            for (const stop of stops) stop();
            await Promise.allSettled([...running]);
        },
    };
}

// The hot executor and the rest run whatever refunds.enabled says: switching refunds off pauses
// refunds from the refund wallet only, and a hot refund still owes the funder its money
function startX402Jobs(
    d: JobDeps,
    x: X402Wiring,
    tracked: (fn: () => Promise<unknown>) => () => Promise<unknown>,
    track: <T>(run: Promise<T>) => Promise<T>,
    refundDeps: Omit<Parameters<typeof runRefunds>[0], "allowanceSigner" | "hotTokenAccount">,
): Array<() => void> {
    const { s, pool, rpc, log, now } = d;
    const rpcTimeoutMs = s.solana.rpc_timeout;
    const x402 = s.x402;
    const alone = (key: number, fn: () => Promise<unknown>) =>
        tracked(() => singleRunner(pool, key, fn));
    const closeDeps = {
        pool,
        router: d.router,
        funding: d.funding,
        x402,
        orders: s.orders,
        log,
        now,
    };
    const coldDeps = {
        pool,
        rpc,
        feePayer: d.feePayer,
        allowance: x.allowance,
        hotTokenAccount: x.hotTokenAccount,
        coldTokenAccount: x.coldTokenAccount,
        refunds: s.refunds,
        x402,
        rpcTimeoutMs,
        log,
        now,
        requestMirror: () => x.mirrorOnce().then((r) => (r === "skipped" ? null : r)),
    };
    const fastPass = alone(RUNNER_KEYS.fastPass, () =>
        runFastPass({
            pool,
            rpc,
            hotTokenAccount: x.hotTokenAccount,
            x402,
            log,
            now,
            rpcTimeoutMs,
        }),
    );
    x.wakeFastPass.run = () => {
        fastPass().catch((err: unknown) => log.error("job failed", { job: "x402_fast_pass", err }));
    };
    return [
        every(
            x402.release_every,
            "x402_release",
            alone(RUNNER_KEYS.release, () => runReleaseJob(pool, x402, log, now())),
            log,
        ),
        every(
            x402.fast_pass_every,
            "x402_fast_pass",
            tracked(async () => ((await fastPassNeeded(pool)) ? fastPass() : undefined)),
            log,
        ),
        paced(
            "x402_mirror",
            tracked(() => x.mirrorOnce()),
            () =>
                track(mirrorBusy(pool)).then(
                    (busy) => mirrorInterval(busy, x402),
                    () => x402.mirror_every,
                ),
            log,
        ),
        every(
            x402.close_check_every,
            "x402_close_check",
            alone(RUNNER_KEYS.closeCheck, () => runCloseCheck(closeDeps)),
            log,
        ),
        every(
            x402.close_every,
            "x402_close",
            alone(RUNNER_KEYS.close, () => runCloseJob(closeDeps)),
            log,
        ),
        every(
            s.jobs.refunds_every,
            "x402_hot_refunds",
            alone(RUNNER_KEYS.hotRefunds, () =>
                runRefunds(
                    {
                        ...refundDeps,
                        allowanceSigner: x.allowance,
                        hotTokenAccount: x.hotTokenAccount,
                    },
                    "allowance",
                ),
            ),
            log,
        ),
        every(
            x402.cold_transfer_check_every,
            "x402_cold",
            alone(RUNNER_KEYS.cold, () => runColdTransfer(coldDeps)),
            log,
        ),
        every(
            s.jobs.refunds_every,
            "x402_cold_advance",
            alone(RUNNER_KEYS.cold, () => advanceColdTransfers(coldDeps)),
            log,
        ),
        every(
            x402.events_every,
            "x402_outbox",
            alone(RUNNER_KEYS.outbox, () => runOutbox({ pool, router: d.router, x402, log, now })),
            log,
        ),
        every(
            s.jobs.alarms_every,
            "x402_tls_check",
            tracked(async () => {
                const tls = checkTlsFiles(x.readTls(), SERVER_NAME, now());
                x.gate.record("tls", tls.ok ? "pass" : "fail", tls.ok ? undefined : tls.problem);
            }),
            log,
        ),
    ];
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
