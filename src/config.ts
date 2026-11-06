/**
 * Payments settings and secrets.
 *
 * Settings come from a TOML file decoded strictly, so an unknown or misspelt key is an error that
 * names it. Secrets come only from the environment, and an error names the variable, never its
 * value. config/example.toml lists every setting with its default.
 */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAddress } from "@solana/kit";
import { parse } from "smol-toml";
import { z } from "zod";

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ONLY_V0 = "only [0] is supported";

const duration = z
    .string()
    .regex(/^\d+(ms|s|m|h)$/, "a duration such as 500ms, 30s, 10m or 1h")
    .transform(parseDuration);

const hostPort = z
    .string()
    .regex(/^(\[[0-9a-fA-F:.]+\]|[^:[\]\s]+):\d{1,5}$/, "host:port such as 127.0.0.1:8446");

const count = z.int().min(1);
const amount = z.int().min(0);

const key32 = z
    .string()
    .refine((s) => s === "" || isBase64Of32(s), "standard base64 of 32 bytes, or empty");

const settingsSchema = z
    .object({
        http: z
            .object({
                public_listen: hostPort.default("127.0.0.1:8446"),
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
                    .refine((s) => isAddress(s), "the base58 address of the cold USDC owner")
                    .prefault(""),
                // The builder makes v0 only and the decoder reads v0 instructions
                transaction_versions: z
                    .tuple([z.literal(0, { error: ONLY_V0 })], { error: ONLY_V0 })
                    .default([0]),
                max_compute_units: count.default(50_000),
                max_priority_fee_micro_lamports: amount.default(10_000),
                max_required_signatures: count.default(2),
                blockhash_cache_ttl: duration.prefault("8s"),
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
                url: z.url().default("http://127.0.0.1:8080"),
                timeout: duration.prefault("3s"),
                check_payer: z.boolean().default(false),
                get_order: z.boolean().default(false),
                event_public_key: key32.default(""),
            })
            .strict()
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
                sweep_every: duration.prefault("30s"),
                reconcile_every: duration.prefault("10s"),
                refunds_every: duration.prefault("15s"),
                alarms_every: duration.prefault("5m"),
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
}

export class ConfigError extends Error {}

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

    const routerName = "BUGNET_PAYMENTS_ROUTER_TOKEN";
    const routerToken = env[routerName] ?? "";
    if (s.router.check_payer || s.router.get_order) text(routerName);
    // Spec section 4 keeps the router caller token apart from the gateway's token
    if (routerToken !== "" && routerToken === paymentsToken) {
        bad.set(routerName, "must differ from BUGNET_PAYMENTS_TOKEN");
    }

    if (bad.size > 0) {
        const lines = [...bad].sort(([a], [b]) => a.localeCompare(b));
        throw new ConfigError(lines.map(([name, problem]) => `${name} ${problem}`).join("\n"));
    }
    return { paymentsToken, routerToken, orderSeed, claimKey, feePayerKey, refundKey, rpcUrl };
}
