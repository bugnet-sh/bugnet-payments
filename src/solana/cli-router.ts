import type pg from "pg";
import { ConfigError, rpcUrlsOf } from "../config.ts";
import type { Log } from "../log.ts";
import { createRouterRpc, type RoutedRpc } from "./rpc.ts";
import {
    checkRpcList,
    type RouterDeps,
    type RpcSettings,
    type VerdictStore,
} from "./router/index.ts";
import { endpointFingerprint, historyProbe, pgUsageStore, pgVerdictStore } from "./rpc-store.ts";

export interface CliRouterOptions {
    log: Log;
    // settings.solana.rpc_timeout, or its default without a settings file
    rpcTimeoutMs: number;
    pool?: pg.Pool;
    // With pool: the recipient's USDC account, for the history check's own payments
    recipientAta?: string;
    // Default true with a pool; false for rpc probe, since a probe is not traffic
    usage?: boolean;
    // rpc probe reads the stored verdicts but never saves one
    verdictsReadOnly?: boolean;
    transportFor?: RouterDeps["transportFor"];
}

// The CLI's router over the same list as the service; null when neither RPC variable is set.
// It is never started here: a command starts it on first use and stops it before the pool closes.
export function cliRouter(
    env: NodeJS.ProcessEnv,
    rpc: RpcSettings,
    o: CliRouterOptions,
): RoutedRpc | null {
    const set = (name: string) => (env[name] ?? "").trim() !== "";
    if (!set("BUGNET_SOLANA_RPC_URLS") && !set("BUGNET_SOLANA_RPC_URL")) return null;
    const urls = rpcUrlsOf(env);
    const problems = checkRpcList(rpc, o.rpcTimeoutMs, urls);
    if (problems.length > 0) throw new ConfigError(problems.join("\n"));
    const pool = o.pool;
    const claimKey = claimKeyOf(env);
    const verdicts =
        pool === undefined || claimKey === null
            ? undefined
            : readOnly(
                  pgVerdictStore(pool, () => new Date()),
                  o.verdictsReadOnly === true,
              );
    const recipientAta = o.recipientAta;
    return createRouterRpc(rpc, urls, {
        log: o.log,
        now: () => Date.now(),
        random: Math.random,
        ...(pool !== undefined && o.usage !== false ? { usage: pgUsageStore(pool) } : {}),
        ...(verdicts === undefined || claimKey === null
            ? {}
            : { verdicts, fingerprint: endpointFingerprint(claimKey) }),
        ...(pool !== undefined && recipientAta !== undefined
            ? { historyProbe: () => historyProbe(pool, recipientAta) }
            : {}),
        ...(o.transportFor === undefined ? {} : { transportFor: o.transportFor }),
    });
}

function claimKeyOf(env: NodeJS.ProcessEnv): Buffer | null {
    const text = env.BUGNET_CLAIM_KEY ?? "";
    if (text === "") return null;
    const key = Buffer.from(text, "base64");
    return key.length === 32 ? key : null;
}

function readOnly(store: VerdictStore, on: boolean): VerdictStore {
    return on ? { load: () => store.load(), save: async () => {} } : store;
}
