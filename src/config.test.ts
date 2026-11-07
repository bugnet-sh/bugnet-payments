import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSettings, parseSettings, readSecrets, type Settings } from "./config.ts";

const ADDR = "11111111111111111111111111111111";
const ORDER_SEED = Buffer.alloc(32, 1);
const CLAIM_KEY = Buffer.alloc(32, 2);

function settings(router: Partial<Settings["router"]> = {}): Settings {
    const s = parseSettings(`[solana]\nrecipient = "${ADDR}"`, "t.toml");
    return { ...s, router: { ...s.router, ...router } };
}

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        BUGNET_PAYMENTS_TOKEN: "gateway-to-payments",
        BUGNET_PAYMENTS_ROUTER_TOKEN: "payments-to-router",
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

    it("example.toml lists valid keys", () => {
        const text = readFileSync("config/example.toml", "utf8").replace(
            'recipient = ""',
            `recipient = "${ADDR}"`,
        );
        expect(() => parseSettings(text, "example.toml")).not.toThrow();
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
        expect(s.paymentsToken).toBe("gateway-to-payments");
        expect(s.routerToken).toBe("payments-to-router");
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

    it("needs a router token only when a router flag is on, and it must differ", () => {
        expect(() =>
            readSecrets(validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: undefined }), settings()),
        ).not.toThrow();
        const on = settings({ check_payer: true });
        expect(() =>
            readSecrets(validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: undefined }), on),
        ).toThrow(/BUGNET_PAYMENTS_ROUTER_TOKEN/);
        expect(() =>
            readSecrets(
                validEnv({ BUGNET_PAYMENTS_ROUTER_TOKEN: "same", BUGNET_PAYMENTS_TOKEN: "same" }),
                on,
            ),
        ).toThrow(/must differ/);
    });
});
