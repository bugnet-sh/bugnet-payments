import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
    ConfigError,
    loadSettings,
    parseSettings,
    readSecrets,
    SECRET_VARS,
    secretsEnv,
    secretValues,
    type Settings,
} from "./config.ts";
import { jsonLog } from "./log.ts";

const ADDR = "11111111111111111111111111111111";
const ORDER_SEED = Buffer.alloc(32, 1);
const CLAIM_KEY = Buffer.alloc(32, 2);
const PAYMENTS_TOKEN = "gateway-to-payments-0123456789abcdef";
const ROUTER_TOKEN = "payments-to-router-0123456789abcdef";

function settings(router: Partial<Settings["router"]> = {}): Settings {
    const s = parseSettings(`[solana]\nrecipient = "${ADDR}"`, "t.toml");
    return { ...s, router: { ...s.router, ...router } };
}

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        BUGNET_PAYMENTS_TOKEN: PAYMENTS_TOKEN,
        BUGNET_PAYMENTS_ROUTER_TOKEN: ROUTER_TOKEN,
        BUGNET_ORDER_PRIVATE_KEY: ORDER_SEED.toString("base64"),
        BUGNET_CLAIM_KEY: CLAIM_KEY.toString("base64"),
        BUGNET_FEE_PAYER_KEY: "fee-payer-key",
        BUGNET_REFUND_KEY: "refund-key",
        BUGNET_SOLANA_RPC_URL: "https://rpc.example/?api-key=k",
    };
    for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[name];
        else env[name] = value;
    }
    return env;
}

describe("parseSettings", () => {
    it("database.pool_max defaults to 20", () => {
        expect(parseSettings(`[solana]\nrecipient = "${ADDR}"`, "t").database.pool_max).toBe(20);
    });

    it("defaults match the spec", () => {
        const s = parseSettings(`[solana]\nrecipient = "${ADDR}"`, "t.toml");
        expect(s.solana.network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
        expect(s.solana.usdc_mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        expect(s.solana.max_compute_units).toBe(50_000);
        expect(s.solana.max_priority_fee_micro_lamports).toBe(10_000);
        expect(s.solana.max_required_signatures).toBe(2);
        expect(s.solana.transaction_versions).toEqual([0]);
        expect(s.solana.blockhash_cache_ttl).toBe(8_000);
        expect(s.solana.rpc_timeout).toBe(10_000);
        expect(s.orders.unpaid_ttl).toBe(900_000);
        expect(s.orders.unredeemed_refund_after).toBe(1_800_000);
        expect(s.orders.token_ttl).toBe(600_000);
        expect(s.orders.router_grace).toBe(120_000);
        expect(s.orders.attempts_per_order_per_minute).toBe(5);
        expect(s.solana.fee_payer_boot_min_lamports).toBe(100_000_000);
        expect(s.alarms.fee_payer_min_lamports).toBe(100_000_000);
        expect(s.alarms.max_lamports_per_order).toBe(20_000);
        expect(s.limits.status_per_ip_per_minute).toBe(240);
        expect(s.router.check_payer).toBe(false);
        expect(s.router.get_order).toBe(false);
        expect(s.router.token_payer_claims).toBe(false);
        expect(s.http.public_listen).toBe("127.0.0.1:8450");
        expect(s.http.internal_listen).toBe("127.0.0.1:8447");
    });

    it("dev.toml lowers the fee-payer thresholds to fit the funded test wallet", () => {
        const s = loadSettings("config/dev.toml");
        expect(s.solana.fee_payer_boot_min_lamports).toBe(20_000_000);
        expect(s.alarms.fee_payer_min_lamports).toBe(20_000_000);
        expect(s.solana.recipient).toBe("Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw");
        expect(s.http.public_url).toBe("http://127.0.0.1:8450");
    });

    it("refuses transaction versions other than [0]", () => {
        expect(() =>
            parseSettings(`[solana]\nrecipient = "${ADDR}"\ntransaction_versions = [0, 1]`, "t"),
        ).toThrow(/solana.transaction_versions: only \[0\] is supported/);
    });

    it("example.toml lists every setting at exactly its schema default", () => {
        const text = readFileSync("config/example.toml", "utf8");
        expect(text).toContain('recipient = ""');
        const filled = text.replace('recipient = ""', `recipient = "${ADDR}"`);
        const defaults = parseSettings(`[solana]\nrecipient = "${ADDR}"`, "minimal.toml");
        expect(parseSettings(filled, "example.toml")).toEqual(defaults);
        const listed = parse(text) as Record<string, Record<string, unknown>>;
        const keys = (doc: object) =>
            Object.fromEntries(
                Object.entries(doc).map(([table, fields]) => [table, Object.keys(fields).sort()]),
            );
        expect(keys(listed)).toEqual(keys(defaults));
    });

    it("names an unknown key", () => {
        expect(() =>
            parseSettings(`[solana]\nrecipient = "${ADDR}"\nmax_compute_unit = 1`, "t"),
        ).toThrow(/unknown key solana.max_compute_unit/);
    });

    it("refuses a network other than mainnet", () => {
        const devnet = `network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"`;
        expect(() => parseSettings(`[solana]\nrecipient = "${ADDR}"\n${devnet}`, "t")).toThrow(
            /solana.network/,
        );
    });

    it("requires https public_url unless loopback", () => {
        const solana = `[solana]\nrecipient = "${ADDR}"`;
        expect(() =>
            parseSettings(`[http]\npublic_url = "http://pay.bugnet.sh"\n${solana}`, "t"),
        ).toThrow(/http.public_url/);
        expect(() =>
            parseSettings(`[http]\npublic_url = "http://127.0.0.1:8450"\n${solana}`, "t"),
        ).not.toThrow();
    });

    it("bounds solana.rpc_timeout from 1s to 60s", () => {
        const timeout = (value: string) =>
            parseSettings(`[solana]\nrecipient = "${ADDR}"\nrpc_timeout = "${value}"`, "t").solana
                .rpc_timeout;
        expect(timeout("1s")).toBe(1_000);
        expect(timeout("1000ms")).toBe(1_000);
        expect(timeout("60s")).toBe(60_000);
        expect(timeout("1m")).toBe(60_000);
        for (const value of ["999ms", "61s", "0s", "2m"]) {
            expect(() => timeout(value)).toThrow(/solana.rpc_timeout: from 1s to 60s/);
        }
        expect(() => timeout("10")).toThrow(/solana.rpc_timeout: a duration/);
    });

    it("bounds every jobs interval from 1ms to 24h", () => {
        const every = (key: string, value: string) =>
            parseSettings(`[solana]\nrecipient = "${ADDR}"\n[jobs]\n${key} = "${value}"`, "t").jobs;
        for (const key of ["sweep_every", "reconcile_every", "refunds_every", "alarms_every"]) {
            expect(every(key, "1ms")).toMatchObject({ [key]: 1 });
            expect(every(key, "24h")).toMatchObject({ [key]: 86_400_000 });
            for (const value of ["0s", "0ms", "1441m", "25h", "999999h"]) {
                expect(() => every(key, value)).toThrow(`jobs.${key}: from 1ms to 24h`);
            }
        }
    });

    it("requires an https router.url unless loopback, as every call carries the router token", () => {
        const router = (url: string) =>
            parseSettings(`[solana]\nrecipient = "${ADDR}"\n[router]\nurl = "${url}"`, "t").router
                .url;
        expect(() => router("http://10.0.0.5:8080")).toThrow(
            "t: router.url: must be https unless the host is loopback",
        );
        expect(() => router("http://router.bugnet.internal:8080")).toThrow(/router.url/);
        expect(router("http://127.0.0.1:38080")).toBe("http://127.0.0.1:38080");
        expect(router("http://[::1]:8080")).toBe("http://[::1]:8080");
        expect(router("https://10.0.0.5:8443")).toBe("https://10.0.0.5:8443");
    });

    it("accepts router.get_order = true", () => {
        const s = parseSettings(`[solana]\nrecipient = "${ADDR}"\n[router]\nget_order = true`, "t");
        expect(s.router.get_order).toBe(true);
    });
});

describe("readSecrets", () => {
    it("decodes the 32-byte keys and keeps the rest as given", () => {
        const s = readSecrets(validEnv(), settings());
        expect(s.orderSeed.equals(ORDER_SEED)).toBe(true);
        expect(s.claimKey.equals(CLAIM_KEY)).toBe(true);
        expect(s.paymentsToken).toBe(PAYMENTS_TOKEN);
        expect(s.routerToken).toBe(ROUTER_TOKEN);
        expect(s.feePayerKey).toBe("fee-payer-key");
        expect(s.refundKey).toBe("refund-key");
        expect(s.rpcUrl).toBe("https://rpc.example/?api-key=k");
    });

    it("names every bad secret and never echoes a value", () => {
        const env = validEnv({ BUGNET_FEE_PAYER_KEY: undefined, BUGNET_ORDER_PRIVATE_KEY: "AAAA" });
        expect(() => readSecrets(env, settings())).toThrow(
            /BUGNET_FEE_PAYER_KEY[\s\S]*BUGNET_ORDER_PRIVATE_KEY/,
        );
        try {
            readSecrets(env, settings());
        } catch (e) {
            expect(String(e)).not.toContain("AAAA");
        }
    });

    it.each(["BUGNET_PAYMENTS_TOKEN", "BUGNET_PAYMENTS_ROUTER_TOKEN", "BUGNET_SOLANA_RPC_URL"])(
        "refuses %s with whitespace inside, such as a comment kept by systemd",
        (name) => {
            const value = "s3cr3t-value           # shared with the gateway";
            const env = validEnv({ [name]: value });
            expect(() => readSecrets(env, settings())).toThrow(
                `${name} must not contain whitespace`,
            );
            try {
                readSecrets(env, settings());
            } catch (e) {
                expect(String(e)).not.toContain("s3cr3t");
            }
        },
    );

    it("needs a router token only when a router flag is on, and it must differ", () => {
        expect(() =>
            readSecrets(validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: undefined }), settings()),
        ).not.toThrow();
        const on = settings({ check_payer: true });
        expect(() =>
            readSecrets(validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: undefined }), on),
        ).toThrow(/BUGNET_PAYMENTS_ROUTER_TOKEN/);
        expect(() =>
            readSecrets(validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: PAYMENTS_TOKEN }), on),
        ).toThrow(/must differ/);
    });

    it("refuses a gateway token shorter than 32 characters, naming it, never its value", () => {
        const short = "s3cr3t-0123456789abcdef-0123456";
        expect(short).toHaveLength(31);
        const env = validEnv({ BUGNET_PAYMENTS_TOKEN: short });
        expect(() => readSecrets(env, settings())).toThrow(
            /^BUGNET_PAYMENTS_TOKEN must be at least 32 characters$/,
        );
        expect(() => readSecrets(env, settings())).not.toThrow(/s3cr3t/);
        expect(() =>
            readSecrets(validEnv({ BUGNET_PAYMENTS_TOKEN: `${short}x` }), settings()),
        ).not.toThrow();
    });

    it("refuses a router token shorter than 32 characters whenever one is set", () => {
        const short = "s3cr3t-0123456789abcdef-0123456";
        const env = validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: short });
        for (const flag of ["check_payer", "get_order"] as const) {
            expect(() => readSecrets(env, settings({ [flag]: true }))).toThrow(
                /^BUGNET_PAYMENTS_ROUTER_TOKEN must be at least 32 characters$/,
            );
            expect(() => readSecrets(env, settings({ [flag]: true }))).not.toThrow(/s3cr3t/);
        }
        // With no router flag the token still guards stats totals
        expect(() => readSecrets(env, settings())).toThrow(
            /^BUGNET_PAYMENTS_ROUTER_TOKEN must be at least 32 characters$/,
        );
        expect(() =>
            readSecrets(validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: "dev" }), settings()),
        ).toThrow(/^BUGNET_PAYMENTS_ROUTER_TOKEN must be at least 32 characters$/);
        expect(() =>
            readSecrets(validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: "" }), settings()),
        ).not.toThrow();
        expect(() =>
            readSecrets(
                validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: `${short}x` }),
                settings({ get_order: true }),
            ),
        ).not.toThrow();
    });
});

describe("secret redaction list", () => {
    it("names every variable of .env.example except the account index", () => {
        const names = [...readFileSync(".env.example", "utf8").matchAll(/^([A-Z0-9_]+)=/gm)].map(
            (m) => m[1],
        );
        expect(names).toContain("BUGNET_TEST_PAYER_ACCOUNT_INDEX");
        expect([...SECRET_VARS].sort()).toEqual(
            names.filter((n) => n !== "BUGNET_TEST_PAYER_ACCOUNT_INDEX").sort(),
        );
    });

    it("gives every loaded secret back in its variable's form", () => {
        const env = validEnv({ BUGNET_ALLOWANCE_KEY: "", BUGNET_X402_TLS_KEY: "" });
        const secrets = readSecrets(env, settings());
        expect(secretsEnv(secrets)).toEqual(env);
        expect(Object.keys(secretsEnv(secrets))).toHaveLength(Object.keys(secrets).length);
    });

    it("keeps each set secret once, longest first, and nothing else", () => {
        const values = secretValues(
            { BUGNET_PAYMENTS_TOKEN: "abc", BUGNET_REFUND_KEY: "  ", HOME: "/home/x" },
            { BUGNET_TEST_PAYER_MNEMONIC: "w1 w2 w3", BUGNET_CLAIM_KEY: "abc", PATH: "/bin" },
            { BUGNET_TEST_PG_URL: "postgres://u:abc@h/db", BUGNET_FEE_PAYER_KEY: "" },
        );
        expect(values).toEqual(["postgres://u:abc@h/db", "w1 w2 w3", "abc"]);
    });
});

const WALLET = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const SOLANA = `[solana]\nrecipient = "${ADDR}"`;
const PEM = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n";
const X402_DEFAULTS = {
    enabled: false,
    allowance_wallet: "",
    listen: "127.0.0.1:8449",
    tls_cert_file: "/etc/bugnet/payments/x402-server.pem",
    client_ca_file: "/etc/bugnet/internal-ca.pem",
    client_name: "bugnet-egress.internal",
    indexed_services_file: "/etc/bugnet/payments/x402-index.json",
    session_fee_micros: 3_000,
    min_allowance_micros: 100_000,
    suggested_allowance_micros: 1_000_000,
    max_allowance_per_sandbox_micros: 5_000_000,
    max_price_per_call_micros: 500_000,
    default_spend_per_minute_micros: 500_000,
    min_spend_per_minute_micros: 10_000,
    max_spend_per_minute_micros: 5_000_000,
    max_services: 5,
    max_new_services_per_order: 5,
    refund_min_micros: 10_000,
    pool_max_micros: 50_000_000,
    pool_unpaid_max_micros: 10_000_000,
    pool_high_alarm_percent: 80,
    unpaid_allowance_order_ttl: 300_000,
    outflow_daily_cap_micros: 100_000_000,
    unlisted_daily_cap_micros: 20_000_000,
    payto_daily_cap_unlisted_micros: 20_000_000,
    payto_daily_cap_indexed_micros: 200_000_000,
    refund_daily_cap_micros: 50_000_000,
    max_open_payments_per_placement: 8,
    unreliable_after: 3,
    signed_payload_keep: 45_000,
    sign_timeout: 2_000,
    lookup_timeout: 500,
    reserved_release_after: 30_000,
    release_every: 5_000,
    seller_compute_unit_limit: 20_000,
    seller_compute_unit_price_micro_lamports: 1,
    seller_compute_unit_price_max_micro_lamports: 1_000,
    seller_memo_max_bytes: 32,
    fast_pass_every: 5_000,
    fast_pass_limit: 100,
    mirror_every: 5_000,
    mirror_idle_every: 60_000,
    mirror_page_size: 1_000,
    mirror_rescan_slots: 300,
    balance_mismatch_after: 120_000,
    tail_lag_alarm_after: 180_000,
    rpc_calls_per_hour_alarm: 5_000,
    signer_check_stale_after: 120_000,
    unresolved_alarm_after: 600_000,
    close_check_every: 60_000,
    close_check_after: 600_000,
    close_unverifiable_after: 1_800_000,
    close_every: 5_000,
    close_slow_alarm_after: 600_000,
    resign_wait_alarm_after: 600_000,
    cold_transfer_check_every: 300_000,
    cold_transfer_max_age: 3_600_000,
    cold_transfer_threshold_micros: 20_000_000,
    cold_transfer_verify_age: 60_000,
    events_every: 2_000,
    events_batch: 50,
    events_max_backoff: 300_000,
    events_stuck_alarm_after: 600_000,
    cert_expiry_alarm_before: 2_592_000_000,
};
const x402 = (lines: string) => parseSettings(`${SOLANA}\n[x402]\n${lines}`, "t");
const withWallet = () => x402(`allowance_wallet = "${WALLET}"`);

describe("[x402] settings", () => {
    it("parses the [x402] defaults of 7.16", () => {
        const s = parseSettings(SOLANA, "t");
        expect(s.x402).toEqual(X402_DEFAULTS);
        expect(s.router.allowance_claim).toBe(false);
        expect(s.http.public_listen).toBe("127.0.0.1:8450");
    });
    it("refuses an unknown [x402] key", () => {
        expect(() => x402("foo = 1")).toThrow(/unknown key x402.foo/);
    });
    it("refuses an allowance_wallet that is not 32 bytes", () => {
        expect(() => x402(`allowance_wallet = "1${WALLET}"`)).toThrow(/x402.allowance_wallet/);
    });
    it("refuses a minimum above the default minute limit", () => {
        expect(() => x402("min_spend_per_minute_micros = 600000")).toThrow(
            /x402.min_spend_per_minute_micros/,
        );
    });
    it("refuses a default minute limit above the maximum", () => {
        expect(() => x402("max_spend_per_minute_micros = 400000")).toThrow(
            /x402.default_spend_per_minute_micros/,
        );
    });
    it("refuses allowance bounds out of order", () => {
        expect(() => x402("min_allowance_micros = 2000000")).toThrow(/x402.min_allowance_micros/);
        expect(() => x402("max_allowance_per_sandbox_micros = 900000")).toThrow(
            /x402.suggested_allowance_micros/,
        );
    });
    it("refuses a compute unit price above its maximum", () => {
        expect(() => x402("seller_compute_unit_price_micro_lamports = 2000")).toThrow(
            /x402.seller_compute_unit_price_micro_lamports/,
        );
    });
    it("refuses an unpaid pool above the pool", () => {
        expect(() => x402("pool_unpaid_max_micros = 60000000")).toThrow(
            /x402.pool_unpaid_max_micros/,
        );
    });
    it("bounds the alarm percent to 1..100", () => {
        expect(() => x402("pool_high_alarm_percent = 101")).toThrow(/pool_high_alarm_percent/);
        expect(() => x402("pool_high_alarm_percent = 0")).toThrow(/pool_high_alarm_percent/);
    });
    it("refuses enabled without a wallet", () => {
        expect(() => x402("enabled = true")).toThrow(/x402.enabled/);
        expect(x402(`enabled = true\nallowance_wallet = "${WALLET}"`).x402.enabled).toBe(true);
    });
    it("refuses a signed_payload_keep of 60s or more", () => {
        expect(() => x402('signed_payload_keep = "60s"')).toThrow(/x402.signed_payload_keep/);
    });
    it.each([
        "release_every",
        "fast_pass_every",
        "mirror_every",
        "mirror_idle_every",
        "close_check_every",
        "close_every",
        "cold_transfer_check_every",
        "events_every",
    ])("bounds x402.%s from 1ms to 24h", (key) => {
        expect(() => x402(`${key} = "0ms"`)).toThrow(new RegExp(`x402.${key}`));
        expect(() => x402(`${key} = "25h"`)).toThrow(new RegExp(`x402.${key}`));
        expect(x402(`${key} = "1ms"`).x402).toHaveProperty(key, 1);
        expect(x402(`${key} = "24h"`).x402).toHaveProperty(key, 86_400_000);
    });
    it.each(["sign_timeout", "lookup_timeout"])(
        "bounds x402.%s above 0 and at most 2^31-1ms",
        (key) => {
            expect(() => x402(`${key} = "0ms"`)).toThrow(new RegExp(`x402.${key}`));
            expect(() => x402(`${key} = "2147484s"`)).toThrow(new RegExp(`x402.${key}`));
            expect(x402(`${key} = "1ms"`).x402).toHaveProperty(key, 1);
            expect(x402(`${key} = "2147483s"`).x402).toHaveProperty(key, 2_147_483_000);
        },
    );
    it.each(["tls_cert_file", "client_ca_file", "indexed_services_file"])(
        "refuses an empty x402.%s",
        (key) => {
            expect(() => x402(`${key} = ""`)).toThrow(new RegExp(`x402.${key}`));
        },
    );
    it("refuses an x402 integer key below its minimum", () => {
        expect(() => x402("session_fee_micros = 0")).toThrow(/x402.session_fee_micros/);
    });
    it("example.toml equals the defaults", () => {
        const text = readFileSync("config/example.toml", "utf8").replace(
            'recipient = ""',
            `recipient = "${ADDR}"`,
        );
        const s = parseSettings(text, "example.toml");
        expect(s.x402).toEqual(X402_DEFAULTS);
        expect(s.router.allowance_claim).toBe(false);
    });
    it("dev.toml parses", () => {
        const s = loadSettings("config/dev.toml");
        expect(s.x402.enabled).toBe(false);
        expect(s.x402.allowance_wallet).toBe("");
        expect(s.x402.tls_cert_file).toBe(".dev/x402/x402-server.pem");
        expect(s.x402.client_ca_file).toBe(".dev/x402/internal-ca.pem");
        expect(s.x402.indexed_services_file).toBe(".dev/x402/x402-index.json");
    });
});

describe("readSecrets for x402", () => {
    it("requires the allowance key, the TLS key and the router token when allowance_wallet is set", () => {
        const env = validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: undefined });
        expect(() => readSecrets(env, withWallet())).toThrow(
            new ConfigError(
                "BUGNET_ALLOWANCE_KEY must be set\nBUGNET_PAYMENTS_ROUTER_TOKEN must be set\nBUGNET_X402_TLS_KEY must be set",
            ),
        );
    });
    it("reads both secrets when allowance_wallet is set", () => {
        const s = readSecrets(
            validEnv({
                BUGNET_ALLOWANCE_KEY: "allowance-key",
                BUGNET_X402_TLS_KEY: Buffer.from(PEM).toString("base64"),
            }),
            withWallet(),
        );
        expect(s.allowanceKey).toBe("allowance-key");
        expect(s.x402TlsKey).toBe(PEM);
    });
    it("keeps the router token different from the gateway token when allowance_wallet is set", () => {
        const env = validEnv({
            BUGNET_ALLOWANCE_KEY: "k",
            BUGNET_X402_TLS_KEY: Buffer.from(PEM).toString("base64"),
            BUGNET_PAYMENTS_ROUTER_TOKEN: PAYMENTS_TOKEN,
        });
        expect(() => readSecrets(env, withWallet())).toThrow(/must differ/);
    });
    it.each(["not base64!", Buffer.from("hello").toString("base64")])(
        "refuses a TLS key that is not base64 of a PEM: %s",
        (value) => {
            const env = validEnv({ BUGNET_ALLOWANCE_KEY: "k", BUGNET_X402_TLS_KEY: value });
            let message = "";
            try {
                readSecrets(env, withWallet());
            } catch (e) {
                message = String(e);
            }
            expect(message).toContain(
                "BUGNET_X402_TLS_KEY must be standard base64 of a PEM private key",
            );
            expect(message).not.toContain(value);
        },
    );
    it.each([
        ["URL-safe characters", Buffer.from(PEM + "~~?>>").toString("base64url")],
        [
            "76-column wrapping",
            Buffer.from(PEM.repeat(3))
                .toString("base64")
                .replace(/(.{76})/g, "$1\n"),
        ],
        ["no BEGIN marker", Buffer.from("MC4CAQAwBQYDK2VwBCIEIA== PRIVATE KEY").toString("base64")],
    ])("refuses a TLS key with %s", (_name, value) => {
        const env = validEnv({ BUGNET_ALLOWANCE_KEY: "k", BUGNET_X402_TLS_KEY: value });
        expect(() => readSecrets(env, withWallet())).toThrow(
            "BUGNET_X402_TLS_KEY must be standard base64 of a PEM private key",
        );
    });
    it("needs neither secret when allowance_wallet is empty", () => {
        const s = readSecrets(
            validEnv({ BUGNET_ALLOWANCE_KEY: "set", BUGNET_X402_TLS_KEY: "set" }),
            settings(),
        );
        expect(s.allowanceKey).toBe("");
        expect(s.x402TlsKey).toBe("");
    });
});

describe("x402 secret redaction", () => {
    it("redacts the two new secrets, the TLS key also as its decoded PEM", () => {
        const env = {
            BUGNET_ALLOWANCE_KEY: "allowance-secret-value",
            BUGNET_X402_TLS_KEY: Buffer.from(PEM).toString("base64"),
        };
        const out: string[] = [];
        const log = jsonLog("payments", { secrets: secretValues(env), write: (l) => out.push(l) });
        log.error(`k=${env.BUGNET_ALLOWANCE_KEY} b=${env.BUGNET_X402_TLS_KEY} p=${PEM}`);
        expect(out[0]).not.toContain("allowance-secret-value");
        expect(out[0]).not.toContain(env.BUGNET_X402_TLS_KEY);
        expect(out[0]).not.toContain("MC4CAQAwBQYDK2VwBCIEIA==");
        expect(out[0]!.match(/\[redacted\]/g)).toHaveLength(3);
    });
    it("never adds a decoded value that is not a PEM", () => {
        expect(secretValues({ BUGNET_X402_TLS_KEY: "c2hvcnQ=" })).toEqual(["c2hvcnQ="]);
    });
});
