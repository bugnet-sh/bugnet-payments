/**
 * The router's settings: the [solana.rpc] knobs, which apply to every endpoint alike, and the
 * ordered URL list from BUGNET_SOLANA_RPC_URLS. Endpoints are named by position only, and no
 * problem, log or stored value ever holds any part of a URL.
 */
import { isIP } from "node:net";
import { z } from "zod";
import { METHODS } from "./methods.ts";

export const MAX_RPC_URLS = 6;

export const ROLES = ["read", "history", "send"] as const;
export type Role = (typeof ROLES)[number];

export interface RpcSettings {
    attempt_timeout: number;
    first_attempt_timeouts: Record<string, number>;
    max_attempts: number;
    max_slot_lag: number;
    probe_every: number;
    history_check_every: number;
    absence_quorum?: number;
    send_fanout?: number;
    breaker_failures: number;
    breaker_open: number;
    all_down_alarm_after: number;
    lag_alarm_after: number;
    limited_alarm_after: number;
    background_share: number;
    usage_flush_every: number;
    snapshot_every: number;
}

// Copies of src/config.ts's duration grammar and loopback rule: the router imports nothing
// outside its folder
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

function durationMs(s: string): number {
    const m = /^(\d+)(ms|s|m|h)$/.exec(s)!;
    return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

// The upper bound is the longest delay a Node timer takes
const duration = z
    .string()
    .regex(/^\d+(ms|s|m|h)$/, "a duration such as 500ms, 30s, 10m or 1h")
    .transform(durationMs)
    .refine((ms) => ms >= 1 && ms <= 2_147_483_647, "from 1ms to 2147483647ms");

// Only a real 127.0.0.0/8 literal counts, a name such as 127.0.0.1.nip.io resolves anywhere
function isLoopbackHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1") return true;
    return isIP(host) === 4 && host.startsWith("127.");
}

const FIRST_ATTEMPT_TIMEOUTS: Readonly<Record<string, number>> = {
    getAccountInfo: 1000,
    getBalance: 1000,
    getBlockHeight: 1000,
    getEpochInfo: 1000,
    getLatestBlockhash: 1000,
    getMultipleAccounts: 1500,
    getSlot: 1000,
    getTokenAccountBalance: 1000,
    simulateTransaction: 1500,
};

const lagMessage = "from 1 to 80";
const shareMessage = "above 0 and at most 1";

export const rpcSettingsSchema: z.ZodType<RpcSettings> = z
    .object({
        attempt_timeout: duration.prefault("3s"),
        // A written table keeps the defaults of the methods it does not name, as every table does
        first_attempt_timeouts: z
            .record(z.string(), duration)
            .transform((given) => ({ ...FIRST_ATTEMPT_TIMEOUTS, ...given }))
            .prefault({}),
        max_attempts: z.int().min(1).default(3),
        // The settler's last valid height, getBlockHeight + 300, stays 20 blocks above the real one
        // up to a lag of 80
        max_slot_lag: z.int().min(1, lagMessage).max(80, lagMessage).default(50),
        probe_every: duration.prefault("60s"),
        history_check_every: duration.prefault("1h"),
        absence_quorum: z.int().min(1).optional(),
        send_fanout: z.int().min(0).optional(),
        breaker_failures: z.int().min(1).default(5),
        breaker_open: duration.prefault("30s"),
        all_down_alarm_after: duration.prefault("30s"),
        lag_alarm_after: duration.prefault("2m"),
        limited_alarm_after: duration.prefault("5m"),
        background_share: z.number().gt(0, shareMessage).max(1, shareMessage).default(0.6),
        usage_flush_every: duration.prefault("60s"),
        snapshot_every: duration.prefault("15s"),
    })
    .strict()
    .superRefine((rpc, ctx) => {
        for (const [method, ms] of Object.entries(rpc.first_attempt_timeouts)) {
            if (!Object.hasOwn(METHODS, method)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["first_attempt_timeouts", method],
                    message: "not a routed method",
                });
            } else if (ms > rpc.attempt_timeout) {
                ctx.addIssue({
                    code: "custom",
                    path: ["first_attempt_timeouts", method],
                    message: "at most solana.rpc.attempt_timeout",
                });
            }
        }
    });

export function endpointName(index: number): string {
    return `rpc${index + 1}`;
}

const SHELL_CHARACTER = /[&;|<>()$`'"\\]/;

// What is wrong with one URL, in words that hold no part of it, or null
export function urlProblem(item: string): string | null {
    // systemd's EnvironmentFile keeps a same-line "# comment" as part of the value
    if (/\s/.test(item)) return "must not contain whitespace";
    // The shell loaders of the env file read these as syntax, so they would see another list
    if (SHELL_CHARACTER.test(item)) return "holds a shell character (& ; | < > ( ) $ ` ' \" \\)";
    if (!URL.canParse(item)) return "is not a URL";
    const u = new URL(item);
    const loopbackHttp = u.protocol === "http:" && isLoopbackHost(u.hostname);
    if (u.protocol !== "https:" && !loopbackHttp) {
        return "must be an https URL (http only on a loopback host)";
    }
    // Node's fetch refuses a URL with credentials
    if (u.username !== "" || u.password !== "") return "must not hold a user or password";
    return null;
}

export function parseRpcUrls(value: string): { urls: string[]; problems: string[] } {
    const urls = value
        .split(",")
        .map((item) => item.replace(/^[ \t]+|[ \t]+$/g, ""))
        .filter((item) => item !== "");
    const problems: string[] = [];
    const seen = new Map<string, number>();
    urls.forEach((item, i) => {
        const problem = urlProblem(item);
        if (problem !== null) {
            problems.push(`${endpointName(i)} ${problem}`);
            return;
        }
        const href = new URL(item).href;
        const first = seen.get(href);
        if (first !== undefined) {
            problems.push(`${endpointName(i)} is the same URL as ${endpointName(first)}`);
        } else {
            seen.set(href, i);
        }
    });
    if (urls.length === 0) problems.push("lists no URL");
    if (urls.length > MAX_RPC_URLS) {
        problems.push(`lists ${urls.length} URLs, at most ${MAX_RPC_URLS}`);
    }
    return { urls, problems };
}

// Never logged, stored or shown: the domain names the provider behind a key
export function domainOf(url: string): string {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (isIP(host.replace(/^\[|\]$/g, "")) !== 0 || isLoopbackHost(host)) {
        return u.host.toLowerCase();
    }
    return host.replace(/\.$/, "").split(".").slice(-2).join(".");
}

const MIN_KEY_LENGTH = 16;

// A provider can put a key in a path segment, a query value or a subdomain, so a log line that
// holds only one of them is scrubbed too
export function urlSecretParts(url: string): string[] {
    if (!URL.canParse(url)) return [];
    const u = new URL(url);
    const path = u.pathname.split("/");
    const query = u.search
        .slice(1)
        .split("&")
        .map((pair) => pair.slice(pair.indexOf("=") + 1));
    const parts = [...path, ...query].filter((part) => part.length >= MIN_KEY_LENGTH);
    if (u.hostname !== "" && !isLoopbackHost(u.hostname)) parts.push(u.hostname);
    return [...new Set(parts)];
}

export function resolveRpcList(
    rpc: RpcSettings,
    urls: readonly string[],
): { domains: number; absenceQuorum: number; sendFanout: number } {
    const domains = new Set(urls.map(domainOf)).size;
    return {
        domains,
        absenceQuorum: rpc.absence_quorum ?? Math.min(2, domains),
        sendFanout: rpc.send_fanout ?? Math.min(1, domains - 1),
    };
}

export function checkRpcList(
    rpc: RpcSettings,
    rpcTimeoutMs: number,
    urls: readonly string[],
): string[] {
    const { domains } = resolveRpcList(rpc, urls);
    const lines: string[] = [];
    const quorum = rpc.absence_quorum;
    if (quorum !== undefined && quorum > domains) {
        lines.push(
            `solana.rpc.absence_quorum: ${quorum} needs URLs on ${quorum} different domains in BUGNET_SOLANA_RPC_URLS, found ${domains}`,
        );
    }
    const fanout = rpc.send_fanout;
    if (fanout !== undefined && fanout > domains - 1) {
        lines.push(
            `solana.rpc.send_fanout: ${fanout} needs URLs on ${fanout + 1} different domains, found ${domains}`,
        );
    }
    // Single mode puts no attempt timeout on a request, so any rpc_timeout fits there
    if (urls.length >= 2 && rpc.attempt_timeout * rpc.max_attempts > rpcTimeoutMs) {
        lines.push(
            "solana.rpc.attempt_timeout: times max_attempts must be at most solana.rpc_timeout",
        );
    }
    return lines;
}
