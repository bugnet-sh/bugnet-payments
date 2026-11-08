/**
 * Payments settings and secrets.
 *
 * Settings come from a TOML file decoded strictly, so an unknown or misspelt key is an error that
 * names it. Secrets come only from the environment, and an error names the variable, never its
 * value. config/example.toml lists every setting with its default.
 */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { parse } from "smol-toml";
import { z } from "zod";
import { isCanonicalAddress } from "./solana/base58.ts";

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ONLY_V0 = "only [0] is supported";
const MIN_TOKEN_LENGTH = 32;

const duration = z
    .string()
    .regex(/^\d+(ms|s|m|h)$/, "a duration such as 500ms, 30s, 10m or 1h")
    .transform(parseDuration);

const hostPort = z
    .string()
    .regex(/^(\[[0-9a-fA-F:.]+\]|[^:[\]\s]+):\d{1,5}$/, "host:port such as 127.0.0.1:8450");

const jobEvery = duration.refine((ms) => ms >= 1 && ms <= 86_400_000, "from 1ms to 24h");

const timeout = duration.refine((ms) => ms >= 1 && ms <= 2_147_483_647, "from 1ms to 2147483647ms");

const count = z.int().min(1);
const nonEmpty = z.string().min(1);
const amount = z.int().min(0);

const key32 = z
    .string()
    .refine((s) => s === "" || isBase64Of32(s), "standard base64 of 32 bytes, or empty");

type X402Ordered =
    | "min_spend_per_minute_micros"
    | "default_spend_per_minute_micros"
    | "max_spend_per_minute_micros"
    | "min_allowance_micros"
    | "suggested_allowance_micros"
    | "max_allowance_per_sandbox_micros"
    | "seller_compute_unit_price_micro_lamports"
    | "seller_compute_unit_price_max_micro_lamports"
    | "pool_unpaid_max_micros"
    | "pool_max_micros";

type X402Input = Record<X402Ordered, number> & {
    enabled: boolean;
    allowance_wallet: string;
};

// Each pair reads "low must be at most high"; the issue lands on the low key
const X402_ORDER: readonly (readonly [X402Ordered, X402Ordered])[] = [
    ["min_spend_per_minute_micros", "default_spend_per_minute_micros"],
    ["default_spend_per_minute_micros", "max_spend_per_minute_micros"],
    ["min_allowance_micros", "suggested_allowance_micros"],
    ["suggested_allowance_micros", "max_allowance_per_sandbox_micros"],
    ["seller_compute_unit_price_micro_lamports", "seller_compute_unit_price_max_micro_lamports"],
    ["pool_unpaid_max_micros", "pool_max_micros"],
];

function checkX402(x: X402Input, ctx: z.RefinementCtx): void {
    for (const [low, high] of X402_ORDER) {
        if (x[low] > x[high]) {
            ctx.addIssue({ code: "custom", path: [low], message: `must be at most ${high}` });
        }
    }
    if (x.enabled && x.allowance_wallet === "") {
        ctx.addIssue({ code: "custom", path: ["enabled"], message: "needs allowance_wallet" });
    }
}

const settingsSchema = z
    .object({
        http: z
            .object({
                public_listen: hostPort.default("127.0.0.1:8450"),
                internal_listen: hostPort.default("127.0.0.1:8447"),
                public_url: z
                    .url()
                    .refine(httpsOrLoopback, "must be https unless the host is loopback")
                    .default("https://pay.bugnet.sh"),
                trusted_proxies: z
                    .array(
                        z.string().transform((s, ctx) => {
                            const rest = s.replace(/^::ffff:/i, "");
                            const ip = isIP(rest) === 4 ? rest : s;
                            if (isIP(ip) === 0) {
                                ctx.issues.push({
                                    code: "custom",
                                    message: `${JSON.stringify(s)} is not an IP address`,
                                    input: s,
                                });
                                return z.NEVER;
                            }
                            return ip;
                        }),
                    )
                    .default(["127.0.0.1", "::1"]),
                max_body_bytes: count.default(65536),
            })
            .strict()
            .prefault({}),
        database: z
            .object({
                url: z
                    .string()
                    .min(1)
                    .default("postgres:///bugnet_payments?host=/var/run/postgresql"),
                // Each single-runner job holds one client for its lock while its work takes others
                pool_max: count.default(20),
            })
            .strict()
            .prefault({}),
        solana: z
            .object({
                network: z
                    .literal(MAINNET, { error: `only Solana mainnet ${MAINNET} is supported` })
                    .default(MAINNET),
                usdc_mint: z
                    .literal(USDC_MINT, { error: `only USDC ${USDC_MINT} is supported` })
                    .default(USDC_MINT),
                recipient: z
                    .string()
                    .refine(isCanonicalAddress, "the base58 address of the cold USDC owner")
                    .prefault(""),
                // The builder makes v0 only and the decoder reads v0 instructions
                transaction_versions: z
                    .tuple([z.literal(0, { error: ONLY_V0 })], { error: ONLY_V0 })
                    .default([0]),
                max_compute_units: count.default(50_000),
                max_priority_fee_micro_lamports: amount.default(10_000),
                max_required_signatures: count.default(2),
                blockhash_cache_ttl: duration.prefault("8s"),
                rpc_timeout: duration
                    .refine((ms) => ms >= 1_000 && ms <= 60_000, "from 1s to 60s")
                    .prefault("10s"),
                fee_payer_boot_min_lamports: amount.default(100_000_000),
            })
            .strict()
            .prefault({}),
        orders: z
            .object({
                unpaid_ttl: duration.prefault("15m"),
                unredeemed_refund_after: duration.prefault("30m"),
                token_ttl: duration.prefault("10m"),
                router_grace: duration.prefault("2m"),
                max_amount_micros: count.default(100_000_000),
                attempts_per_order_per_minute: count.default(5),
                min_idempotency_key_length: count.default(16),
            })
            .strict()
            .prefault({}),
        limits: z
            .object({
                public_per_ip_per_minute: count.default(60),
                status_per_ip_per_minute: count.default(240),
            })
            .strict()
            .prefault({}),
        router: z
            .object({
                // Every router call carries BUGNET_PAYMENTS_ROUTER_TOKEN
                url: z
                    .url()
                    .refine(httpsOrLoopback, "must be https unless the host is loopback")
                    .default("http://127.0.0.1:8080"),
                timeout: duration.prefault("3s"),
                check_payer: z.boolean().default(false),
                get_order: z.boolean().default(false),
                allowance_claim: z.boolean().default(false),
                event_public_key: key32.default(""),
            })
            .strict()
            .prefault({}),
        x402: z
            .object({
                enabled: z.boolean().default(false),
                allowance_wallet: z
                    .string()
                    .refine(
                        (s) => s === "" || isCanonicalAddress(s),
                        "empty, or a base58 address that decodes to 32 bytes",
                    )
                    .default(""),
                listen: hostPort.default("127.0.0.1:8449"),
                tls_cert_file: nonEmpty.default("/etc/bugnet/payments/x402-server.pem"),
                client_ca_file: nonEmpty.default("/etc/bugnet/internal-ca.pem"),
                client_name: nonEmpty.default("bugnet-egress.internal"),
                indexed_services_file: nonEmpty.default("/etc/bugnet/payments/x402-index.json"),
                session_fee_micros: count.default(3000),
                min_allowance_micros: count.default(100000),
                suggested_allowance_micros: count.default(1000000),
                max_allowance_per_sandbox_micros: count.default(5000000),
                max_price_per_call_micros: count.default(500000),
                default_spend_per_minute_micros: count.default(500000),
                min_spend_per_minute_micros: count.default(10000),
                max_spend_per_minute_micros: count.default(5000000),
                max_services: count.default(5),
                max_new_services_per_order: count.default(5),
                refund_min_micros: count.default(10000),
                pool_max_micros: count.default(50000000),
                pool_unpaid_max_micros: count.default(10000000),
                pool_high_alarm_percent: z.int().min(1).max(100).default(80),
                unpaid_allowance_order_ttl: duration.prefault("5m"),
                outflow_daily_cap_micros: count.default(100000000),
                unlisted_daily_cap_micros: count.default(20000000),
                payto_daily_cap_unlisted_micros: count.default(20000000),
                payto_daily_cap_indexed_micros: count.default(200000000),
                refund_daily_cap_micros: count.default(50000000),
                max_open_payments_per_placement: count.default(8),
                unreliable_after: count.default(3),
                signed_payload_keep: duration
                    .refine((ms) => ms < 60_000, "below 60s")
                    .prefault("45s"),
                sign_timeout: timeout.prefault("2s"),
                lookup_timeout: timeout.prefault("500ms"),
                reserved_release_after: duration.prefault("30s"),
                release_every: jobEvery.prefault("5s"),
                seller_compute_unit_limit: count.default(20000),
                seller_compute_unit_price_micro_lamports: count.default(1),
                seller_compute_unit_price_max_micro_lamports: count.default(1000),
                seller_memo_max_bytes: count.default(32),
                fast_pass_every: jobEvery.prefault("5s"),
                fast_pass_limit: count.default(100),
                mirror_every: jobEvery.prefault("5s"),
                mirror_idle_every: jobEvery.prefault("60s"),
                mirror_page_size: count.default(1000),
                mirror_rescan_slots: count.default(300),
                balance_mismatch_after: duration.prefault("2m"),
                tail_lag_alarm_after: duration.prefault("60s"),
                rpc_calls_per_hour_alarm: count.default(5000),
                signer_check_stale_after: duration.prefault("2m"),
                unresolved_alarm_after: duration.prefault("10m"),
                close_check_every: jobEvery.prefault("60s"),
                close_check_after: duration.prefault("10m"),
                close_unverifiable_after: duration.prefault("30m"),
                close_every: jobEvery.prefault("5s"),
                close_slow_alarm_after: duration.prefault("10m"),
                resign_wait_alarm_after: duration.prefault("10m"),
                cold_transfer_check_every: jobEvery.prefault("5m"),
                cold_transfer_max_age: duration.prefault("1h"),
                cold_transfer_threshold_micros: count.default(20000000),
                cold_transfer_verify_age: duration.prefault("60s"),
                events_every: jobEvery.prefault("2s"),
                events_batch: count.default(50),
                events_max_backoff: duration.prefault("5m"),
                events_stuck_alarm_after: duration.prefault("10m"),
                cert_expiry_alarm_before: duration.prefault("720h"),
            })
            .strict()
            .superRefine(checkX402)
            .prefault({}),
        refunds: z
            .object({
                enabled: z.boolean().default(true),
                daily_cap_micros: amount.default(20_000_000),
                max_per_hour: count.default(10),
                float_low_micros: amount.default(10_000_000),
                compute_unit_limit: count.default(20_000),
                compute_unit_price_micro_lamports: amount.default(10_000),
                max_attempts: count.default(3),
            })
            .strict()
            .prefault({}),
        alarms: z
            .object({
                fee_payer_min_lamports: amount.default(100_000_000),
                max_lamports_per_order: count.default(20_000),
            })
            .strict()
            .prefault({}),
        jobs: z
            .object({
                sweep_every: jobEvery.prefault("30s"),
                reconcile_every: jobEvery.prefault("10s"),
                refunds_every: jobEvery.prefault("15s"),
                alarms_every: jobEvery.prefault("5m"),
                audit_at_utc: z
                    .string()
                    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a UTC time such as 03:30")
                    .default("03:30"),
            })
            .strict()
            .prefault({}),
    })
    .strict();

export type Settings = z.infer<typeof settingsSchema>;

export interface Secrets {
    paymentsToken: string;
    routerToken: string;
    orderSeed: Buffer;
    claimKey: Buffer;
    feePayerKey: string;
    refundKey: string;
    rpcUrl: string;
    allowanceKey: string;
    x402TlsKey: string;
}

export class ConfigError extends Error {}

// Every secret in .env.example, the test payer's account index is a small number and no secret
export const SECRET_VARS = [
    "BUGNET_PAYMENTS_TOKEN",
    "BUGNET_PAYMENTS_ROUTER_TOKEN",
    "BUGNET_ORDER_PRIVATE_KEY",
    "BUGNET_CLAIM_KEY",
    "BUGNET_FEE_PAYER_KEY",
    "BUGNET_REFUND_KEY",
    "BUGNET_ALLOWANCE_KEY",
    "BUGNET_X402_TLS_KEY",
    "BUGNET_SOLANA_RPC_URL",
    "BUGNET_TEST_PAYER_KEY",
    "BUGNET_TEST_PAYER_MNEMONIC",
    "BUGNET_RECIPIENT_KEY",
    "BUGNET_TEST_PG_URL",
] as const;

export function secretsEnv(s: Secrets): Partial<Record<(typeof SECRET_VARS)[number], string>> {
    return {
        BUGNET_PAYMENTS_TOKEN: s.paymentsToken,
        BUGNET_PAYMENTS_ROUTER_TOKEN: s.routerToken,
        BUGNET_ORDER_PRIVATE_KEY: s.orderSeed.toString("base64"),
        BUGNET_CLAIM_KEY: s.claimKey.toString("base64"),
        BUGNET_FEE_PAYER_KEY: s.feePayerKey,
        BUGNET_REFUND_KEY: s.refundKey,
        BUGNET_ALLOWANCE_KEY: s.allowanceKey,
        BUGNET_X402_TLS_KEY: Buffer.from(s.x402TlsKey).toString("base64"),
        BUGNET_SOLANA_RPC_URL: s.rpcUrl,
    };
}

// What every log redacts, longest first so a secret inside another is never half scrubbed.
// The TLS key is also redacted as the PEM text it decodes to.
export function secretValues(...envs: NodeJS.ProcessEnv[]): string[] {
    const values = envs.flatMap((env) => [
        ...SECRET_VARS.map((name) => env[name] ?? ""),
        decodedPem(env.BUGNET_X402_TLS_KEY ?? ""),
    ]);
    return [...new Set(values.filter((v) => v.trim() !== ""))].sort((a, b) => b.length - a.length);
}

function decodedPem(b64: string): string {
    const text = Buffer.from(b64, "base64").toString("utf8");
    return text.includes("PRIVATE KEY-----") ? text : "";
}

export function parseDuration(s: string): number {
    const m = /^(\d+)(ms|s|m|h)$/.exec(s);
    if (!m) throw new ConfigError(`bad duration ${JSON.stringify(s)}`);
    const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
    return Number(m[1]) * unit;
}

// Only a real 127.0.0.0/8 literal counts, a name such as 127.0.0.1.nip.io resolves anywhere
function isLoopbackHost(host: string): boolean {
    if (host === "localhost" || host === "::1") return true;
    return isIP(host) === 4 && host.startsWith("127.");
}

function httpsOrLoopback(url: string): boolean {
    // z.url reports an unparsable URL itself and zod still runs this refinement
    if (!URL.canParse(url)) return true;
    const u = new URL(url);
    return u.protocol === "https:" || isLoopbackHost(u.hostname.replace(/^\[|\]$/g, ""));
}

// The round trip refuses padding errors and stray characters that Buffer.from skips silently
function isBase64Of32(s: string): boolean {
    const b = Buffer.from(s, "base64");
    return b.length === 32 && b.toString("base64") === s;
}

export function parseSettings(text: string, source: string): Settings {
    let doc: unknown;
    try {
        doc = parse(text);
    } catch (e) {
        throw new ConfigError(`${source}: ${(e as Error).message}`);
    }
    const r = settingsSchema.safeParse(doc);
    if (!r.success) {
        const issues = r.error.issues.map((i) => {
            const at = i.path.join(".");
            if (i.code === "unrecognized_keys") {
                const keys = i.keys.map((k) => (at ? `${at}.${k}` : k));
                return `unknown key ${keys.join(", ")}`;
            }
            return `${at || "(root)"}: ${i.message}`;
        });
        throw new ConfigError(`${source}: ${issues.join("; ")}`);
    }
    return r.data;
}

export function loadSettings(path: string): Settings {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (e) {
        throw new ConfigError(`read ${path}: ${(e as Error).message}`);
    }
    return parseSettings(text, path);
}

export function readSecrets(env: NodeJS.ProcessEnv, s: Settings): Secrets {
    const bad = new Map<string, string>();
    // systemd's EnvironmentFile keeps a same-line "# comment" as part of the value
    const token = (name: string, v: string): void => {
        if (/\s/.test(v)) bad.set(name, "must not contain whitespace");
    };
    const bearer = (name: string, v: string): void => {
        token(name, v);
        if (!bad.has(name) && v.length < MIN_TOKEN_LENGTH) {
            bad.set(name, `must be at least ${MIN_TOKEN_LENGTH} characters`);
        }
    };
    const text = (name: string): string => {
        const v = env[name] ?? "";
        if (v.trim() === "") bad.set(name, "must be set");
        return v;
    };
    const key = (name: string): Buffer => {
        const v = env[name] ?? "";
        if (v === "") bad.set(name, "must be set");
        else if (!isBase64Of32(v)) bad.set(name, "must be standard base64 of exactly 32 bytes");
        return Buffer.from(v, "base64");
    };

    const paymentsToken = text("BUGNET_PAYMENTS_TOKEN");
    const orderSeed = key("BUGNET_ORDER_PRIVATE_KEY");
    const claimKey = key("BUGNET_CLAIM_KEY");
    const feePayerKey = text("BUGNET_FEE_PAYER_KEY");
    const refundKey = text("BUGNET_REFUND_KEY");
    const rpcUrl = text("BUGNET_SOLANA_RPC_URL");
    bearer("BUGNET_PAYMENTS_TOKEN", paymentsToken);
    token("BUGNET_SOLANA_RPC_URL", rpcUrl);

    const routerName = "BUGNET_PAYMENTS_ROUTER_TOKEN";
    const routerToken = env[routerName] ?? "";
    // The router client sends its token only while a router flag is on
    const x402On = s.x402.allowance_wallet !== "";
    if (s.router.check_payer || s.router.get_order || x402On) {
        text(routerName);
        bearer(routerName, routerToken);
    } else {
        token(routerName, routerToken);
    }
    // Spec section 4 keeps the router caller token apart from the gateway's token
    if (routerToken !== "" && routerToken === paymentsToken) {
        bad.set(routerName, "must differ from BUGNET_PAYMENTS_TOKEN");
    }

    let allowanceKey = "";
    let x402TlsKey = "";
    if (x402On) {
        allowanceKey = text("BUGNET_ALLOWANCE_KEY");
        const name = "BUGNET_X402_TLS_KEY";
        const v = env[name] ?? "";
        if (v === "") bad.set(name, "must be set");
        else {
            const pem = Buffer.from(v, "base64").toString("utf8");
            const ok =
                Buffer.from(v, "base64").toString("base64") === v &&
                pem.includes("-----BEGIN") &&
                pem.includes("PRIVATE KEY-----");
            if (ok) x402TlsKey = pem;
            else bad.set(name, "must be standard base64 of a PEM private key");
        }
    }

    if (bad.size > 0) {
        const lines = [...bad].sort(([a], [b]) => a.localeCompare(b));
        throw new ConfigError(lines.map(([name, problem]) => `${name} ${problem}`).join("\n"));
    }
    return {
        paymentsToken,
        routerToken,
        orderSeed,
        claimKey,
        feePayerKey,
        refundKey,
        rpcUrl,
        allowanceKey,
        x402TlsKey,
    };
}
