import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Address, getAddressEncoder, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BootCheckError } from "./boot.ts";
import { parseSettings, SECRET_VARS, type Secrets, secretsEnv, type Settings } from "./config.ts";
import { jsonLog, memoryLog, silentLog } from "./log.ts";
import { main, routeConsole, startService } from "./main.ts";
import { findOrder } from "./orders/store.ts";
import { orderPublicKeyBase64 } from "./orders/token.ts";
import { usdcAta } from "./solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "./solana/constants.ts";
import { create, until } from "./testing/app.ts";
import { testDb, type TestDb } from "./testing/db.ts";
import { createFakeRpc, type FakeRpcScript } from "./testing/fake-rpc.ts";
import { testSigner } from "./testing/keys.ts";
import { seedOrder, seedPayment } from "./testing/orders.ts";

type Tables = Record<string, Record<string, unknown>>;

const MIN = 60_000;
const API_KEY = "main-test-api-key";
const EVENT_KEY = orderPublicKeyBase64(Buffer.alloc(32, 9));

let db: TestDb;
let configDir: string;
let refundWallet: KeyPairSigner;
let recipient: KeyPairSigner;
let owners: Map<string, Address>;
let settings: Settings;
let secrets: Secrets;

async function secretKey(seed: number): Promise<string> {
    const signer = await testSigner(seed);
    const bytes = new Uint8Array(64);
    bytes.fill(seed, 0, 32);
    bytes.set(getAddressEncoder().encode(signer.address), 32);
    return getBase58Decoder().decode(bytes);
}

function tables(over: Tables = {}): Tables {
    const base: Tables = {
        http: { internal_listen: "127.0.0.1:0", public_listen: "127.0.0.1:0" },
        database: { url: db.url },
        solana: { recipient: recipient.address },
        router: { event_public_key: EVENT_KEY },
    };
    for (const [table, fields] of Object.entries(over)) base[table] = { ...base[table], ...fields };
    return base;
}

function testSettings(over: Tables = {}): Settings {
    return parseSettings(stringify(tables(over)), "main.test");
}

function writeConfig(over: Tables = {}): string {
    const file = path.join(configDir, `payments-${randomBytes(4).toString("hex")}.toml`);
    writeFileSync(file, stringify(tables(over)));
    return file;
}

function tokenAccount(owner: Address) {
    return {
        owner: TOKEN_PROGRAM,
        data: {
            program: "spl-token",
            parsed: {
                type: "account",
                info: {
                    mint: USDC_MINT,
                    owner,
                    state: "initialized",
                    tokenAmount: { amount: "50000000", decimals: 6 },
                },
            },
        },
    };
}

function accountAt(ata: string) {
    const owner = owners.get(ata);
    return owner === undefined ? null : tokenAccount(owner);
}

function okRpc(script: Partial<FakeRpcScript> = {}) {
    return createFakeRpc({
        getAccountInfo: (ata: string) => ({ value: accountAt(ata) }),
        ...script,
    });
}

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

function health(port: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/healthz`);
}

async function answersHealth(port: number): Promise<boolean> {
    return (await health(port).catch(() => null))?.status === 200;
}

function postEvent(port: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bugnet-event-id": "evt_1" },
        body: JSON.stringify({ id: "evt_1", type: "placement.failed", payload: {} }),
    });
}

function signature(): string {
    return getBase58Decoder().decode(randomBytes(64));
}

async function seedSettling(): Promise<string> {
    const now = Date.now();
    const { order } = await seedOrder(db.pool, {
        state: "settling",
        createdAt: new Date(now - 2 * MIN),
        expiresAt: new Date(now + 13 * MIN),
    });
    await seedPayment(db.pool, order.id, {
        txSignature: signature(),
        createdAt: new Date(now - MIN),
        lastValidBlockHeight: 2_000n,
    });
    return order.id;
}

async function stateOf(orderId: string): Promise<string | undefined> {
    return (await findOrder(db.pool, orderId))?.state;
}

// main builds its own RPC from BUGNET_SOLANA_RPC_URL, so its tests answer JSON-RPC over HTTP
async function rpcStub(withAccounts: boolean): Promise<{ url: string; close(): Promise<void> }> {
    const server = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => (body += chunk));
        req.on("end", () => {
            const call = JSON.parse(body) as { id: unknown; method: string; params: unknown[] };
            const context = { slot: 1 };
            const answer =
                call.method === "getBalance"
                    ? { result: { context, value: 1_000_000_000 } }
                    : call.method === "getAccountInfo"
                      ? {
                            result: {
                                context,
                                value: withAccounts ? accountAt(String(call.params[0])) : null,
                            },
                        }
                      : { error: { code: -32601, message: `unexpected ${call.method}` } };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...answer }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/?api-key=${API_KEY}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

function envFor(rpcUrl: string, over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        BUGNET_PAYMENTS_TOKEN: secrets.paymentsToken,
        BUGNET_ORDER_PRIVATE_KEY: secrets.orderSeed.toString("base64"),
        BUGNET_CLAIM_KEY: secrets.claimKey.toString("base64"),
        BUGNET_FEE_PAYER_KEY: secrets.feePayerKey,
        BUGNET_REFUND_KEY: secrets.refundKey,
        BUGNET_SOLANA_RPC_URL: rpcUrl,
    };
    for (const [name, value] of Object.entries(over)) {
        if (value === undefined) delete env[name];
        else env[name] = value;
    }
    return env;
}

// Signals main once both listeners answer, or when the wait fails, so it never outlives the test
async function runMain(
    env: NodeJS.ProcessEnv,
    signal: NodeJS.Signals,
    whileUp: () => void = () => {},
): Promise<{ code: number; ports: number[] }> {
    const ports = [await freePort(), await freePort()];
    const config = writeConfig({
        http: {
            internal_listen: `127.0.0.1:${ports[0]}`,
            public_listen: `127.0.0.1:${ports[1]}`,
        },
    });
    const exit = main(["-config", config], env);
    try {
        await until(
            async () => (await answersHealth(ports[0]!)) && (await answersHealth(ports[1]!)),
            10_000,
        );
        whileUp();
    } finally {
        process.emit(signal);
    }
    return { code: await exit, ports };
}

function captureStderr(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
    }) as typeof process.stderr.write);
    return lines;
}

function parsed(lines: string[]): Record<string, unknown>[] {
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(async () => {
    db = await testDb();
    configDir = mkdtempSync(path.join(tmpdir(), "bn-pay-main-"));
    refundWallet = await testSigner(6);
    recipient = await testSigner(1);
    owners = new Map([
        [await usdcAta(recipient.address), recipient.address],
        [await usdcAta(refundWallet.address), refundWallet.address],
    ]);
    settings = testSettings();
    secrets = {
        paymentsToken: "gateway-to-payments-main-test",
        routerToken: "",
        orderSeed: Buffer.alloc(32, 1),
        claimKey: Buffer.alloc(32, 2),
        feePayerKey: await secretKey(5),
        refundKey: await secretKey(6),
        rpcUrl: "",
    };
});
afterAll(async () => {
    rmSync(configDir, { recursive: true, force: true });
    await db.close();
});
beforeEach(async () => {
    await db.pool.query("truncate orders cascade");
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe("startService", () => {
    it("boots and answers health on both listeners", async () => {
        const s = await startService({ settings, secrets, rpc: okRpc(), log: silentLog });
        try {
            expect((await fetch(`http://127.0.0.1:${s.internalPort}/healthz`)).status).toBe(200);
            expect((await fetch(`http://127.0.0.1:${s.publicPort}/healthz`)).status).toBe(200);
        } finally {
            await s.stop();
        }
    });

    it("opens no listener when a boot check fails", async () => {
        const internal = await freePort();
        const pub = await freePort();
        const failing = testSettings({
            http: { internal_listen: `127.0.0.1:${internal}`, public_listen: `127.0.0.1:${pub}` },
        });
        const openDuringCheck: boolean[] = [];
        const rpc = createFakeRpc({
            getAccountInfo: async () => {
                openDuringCheck.push((await answersHealth(internal)) || (await answersHealth(pub)));
                return { value: null };
            },
        });
        const started = startService({ settings: failing, secrets, rpc });
        try {
            await expect(started).rejects.toBeInstanceOf(BootCheckError);
        } finally {
            await started.then(
                (s) => s.stop(),
                () => {},
            );
        }
        expect(openDuringCheck).toEqual([false]);
        await expect(fetch(`http://${failing.http.internal_listen}/healthz`)).rejects.toThrow();
        await expect(fetch(`http://${failing.http.public_listen}/healthz`)).rejects.toThrow();
    });

    it("takes orders on the internal listener and challenges them on the public one", async () => {
        const s = await startService({ settings, secrets, rpc: okRpc(), log: silentLog });
        try {
            const created = await fetch(`http://127.0.0.1:${s.internalPort}/v1/orders`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${secrets.paymentsToken}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify(create()),
            });
            expect(created.status).toBe(200);
            const { orderId } = (await created.json()) as { orderId: string };
            const res = await fetch(`http://127.0.0.1:${s.publicPort}/o/${orderId}`, {
                headers: { accept: "application/json" },
            });
            expect(res.status).toBe(402);
            const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
            expect(pr.resource.url).toBe(`${settings.http.public_url}/o/${orderId}`);
            expect(pr.accepts[0]).toMatchObject({
                payTo: recipient.address,
                extra: { feePayer: (await testSigner(5)).address, memo: orderId },
            });
        } finally {
            await s.stop();
        }
    });

    it("checks router event signatures with the configured key", async () => {
        const s = await startService({ settings, secrets, rpc: okRpc(), log: silentLog });
        try {
            const res = await postEvent(s.internalPort);
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ error: "bad_signature" });
        } finally {
            await s.stop();
        }
    });

    it("without refunds needs no event key, refuses events 503 and sends no refunds", async () => {
        const now = Date.now();
        const { order } = await seedOrder(db.pool, { state: "refunding" });
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                tx_signature, wire_tx, last_valid_block_height, signed_at, sent_at)
             values ($1, 'full', 'unredeemed', 10000, 'dest', 'payer', 'sent', $2, 'AAAA', 2000,
                $3, $3)`,
            [order.id, signature(), new Date(now - MIN)],
        );
        const rpc = okRpc();
        const s = await startService({
            settings: testSettings({
                router: { event_public_key: "" },
                refunds: { enabled: false },
                jobs: { refunds_every: "20ms" },
            }),
            secrets,
            rpc,
            log: silentLog,
        });
        try {
            const res = await postEvent(s.internalPort);
            expect(res.status).toBe(503);
            expect(await res.json()).toEqual({ error: "events_disabled" });
            await new Promise((resolve) => setTimeout(resolve, 200));
        } finally {
            await s.stop();
        }
        expect(await stateOf(order.id)).toBe("refunding");
        expect(rpc.calls.getSignatureStatuses).toBe(0);
    });

    it("reconciles settling orders once at start", async () => {
        const orderId = await seedSettling();
        const s = await startService({
            settings: testSettings({ jobs: { reconcile_every: "1h" } }),
            secrets,
            rpc: okRpc(),
            log: silentLog,
        });
        try {
            await until(async () => (await stateOf(orderId)) === "paid", 5_000);
        } finally {
            await s.stop();
        }
    });

    it("lets a running job finish before it closes the pool", async () => {
        const orderId = await seedSettling();
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const rpc = okRpc({ getBlockHeight: () => held.then(() => 1_000n) });
        const s = await startService({
            settings: testSettings({ jobs: { reconcile_every: "1h" } }),
            secrets,
            rpc,
            log: silentLog,
        });
        let stopped = false;
        try {
            await until(async () => rpc.calls.getBlockHeight === 1, 5_000);
            void s.stop().then(() => {
                stopped = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(stopped).toBe(false);
        } finally {
            release();
            await s.stop();
        }
        expect(await stateOf(orderId)).toBe("paid");
        await expect(health(s.internalPort)).rejects.toThrow();
        await expect(health(s.publicPort)).rejects.toThrow();
    });

    it("starts no job run once stop has begun", async () => {
        await seedSettling();
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const rpc = okRpc({
            getBlockHeight: () => held.then(() => 1_000n),
            getSignatureStatuses: () => ({ value: [null] }),
        });
        const s = await startService({
            settings: testSettings({ jobs: { reconcile_every: "20ms" } }),
            secrets,
            rpc,
            log: silentLog,
        });
        try {
            await until(async () => rpc.calls.getBlockHeight === 1, 5_000);
            await new Promise((resolve) => setTimeout(resolve, 100));
            void s.stop();
        } finally {
            release();
            await s.stop();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(rpc.calls.getBlockHeight).toBe(1);
    });

    it("runs the sweeper, the refund executor and the alarms on their schedules", async () => {
        const now = Date.now();
        const expiring = await seedOrder(db.pool, {
            createdAt: new Date(now - 20 * MIN),
            expiresAt: new Date(now - 5 * MIN),
        });
        const refunding = await seedOrder(db.pool, { state: "refunding" });
        await db.pool.query(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                tx_signature, wire_tx, last_valid_block_height, signed_at, sent_at)
             values ($1, 'full', 'unredeemed', 10000, 'dest', 'payer', 'sent', $2, 'AAAA', 2000,
                $3, $3)`,
            [refunding.order.id, signature(), new Date(now - MIN)],
        );
        const log = memoryLog();
        const s = await startService({
            settings: testSettings({
                alarms: { fee_payer_min_lamports: 2_000_000_000 },
                jobs: { sweep_every: "20ms", refunds_every: "20ms", alarms_every: "20ms" },
            }),
            secrets,
            rpc: okRpc(),
            log,
        });
        try {
            await until(async () => (await stateOf(expiring.order.id)) === "expired", 5_000);
            await until(async () => (await stateOf(refunding.order.id)) === "refunded", 5_000);
            await until(async () => log.lines.some((l) => l.alarm === "fee_payer_sol_low"), 5_000);
        } finally {
            await s.stop();
        }
    });

    it("redacts every loaded secret and every set test secret in its default log", async () => {
        await seedSettling();
        const all: Secrets = {
            ...secrets,
            routerToken: "router-token-start-test",
            rpcUrl: "https://rpc.example/?api-key=start-test",
        };
        vi.stubEnv("BUGNET_TEST_PAYER_MNEMONIC", "abandon ability able, about above absent");
        const values = [
            ...Object.values(secretsEnv(all)),
            process.env.BUGNET_TEST_PAYER_MNEMONIC!,
        ] as string[];
        const down = () => {
            throw new Error(`rpc down: ${values.join(" | ")}`);
        };
        const lines = captureStderr();
        const s = await startService({
            settings: testSettings({ jobs: { reconcile_every: "1h" } }),
            secrets: all,
            rpc: okRpc({ getBlockHeight: down, getSignatureStatuses: down }),
        });
        try {
            await until(async () => lines.some((l) => l.includes('"err"')), 5_000);
        } finally {
            await s.stop();
        }
        const failed = parsed(lines).filter((l) => l.err !== undefined);
        expect(failed).toHaveLength(1);
        expect(failed[0]!.err).toEqual({
            name: "Error",
            message: `rpc down: ${values.map(() => "[redacted]").join(" | ")}`,
        });
        for (const value of values) expect(lines.join("")).not.toContain(value);
    });
});

describe("routeConsole", () => {
    it("routes console.error through the redacting logger", () => {
        const out: string[] = [];
        const restore = routeConsole(
            jsonLog("payments", { secrets: ["https://rpc/?api-key=K"], write: (l) => out.push(l) }),
        );
        console.error("Failed to send transaction:", new Error("POST https://rpc/?api-key=K: 429"));
        restore();
        expect(JSON.parse(out[0]!)).toMatchObject({ level: "error" });
        expect(out[0]).not.toContain("api-key=K");
    });

    it("routes console.warn too, keeps one line per call and restores both", () => {
        const { error, warn } = console;
        const log = memoryLog();
        const restore = routeConsole(log);
        console.warn("slow %s", "rpc", { attempt: 2 });
        console.error(new Error("boom"));
        restore();
        expect(log.lines).toMatchObject([
            { level: "warn", msg: "slow rpc { attempt: 2 }" },
            { level: "error", msg: "Error: boom" },
        ]);
        expect(console.error).toBe(error);
        expect(console.warn).toBe(warn);
    });

    it("prints an Error inside an argument as its name and message only", () => {
        const log = memoryLog();
        const restore = routeConsole(log);
        const err = new Error("POST failed", { cause: new Error("https://rpc/?api-key=K") });
        const loop: Record<string, unknown> = { errors: [err] };
        loop.self = loop;
        console.error("send failed", { attempt: 1, nested: loop });
        restore();
        expect(log.lines).toHaveLength(1);
        expect(log.lines[0]!.level).toBe("error");
        expect(String(log.lines[0]!.msg).replace(/\s+/g, " ")).toBe(
            "send failed { attempt: 1, nested: { errors: [ 'Error: POST failed' ], self: '[Circular]' } }",
        );
        expect(JSON.stringify(log.lines)).not.toMatch(/api-key|cause|\bat /);
    });
});

describe("main", () => {
    it("refuses to run without -config", async () => {
        const lines = captureStderr();
        expect(await main([], envFor("http://127.0.0.1:1"))).toBe(2);
        expect(parsed(lines)).toMatchObject([
            { level: "error", msg: "usage: main.js -config FILE" },
        ]);
    });

    it("names a missing secret in one line and returns 1", async () => {
        const lines = captureStderr();
        const env = envFor(`http://127.0.0.1:1/?api-key=${API_KEY}`, {
            BUGNET_CLAIM_KEY: undefined,
        });
        expect(await main(["-config", writeConfig()], env)).toBe(1);
        expect(lines).toHaveLength(1);
        expect(parsed(lines)[0]).toMatchObject({
            level: "error",
            msg: "configuration invalid",
            reason: "BUGNET_CLAIM_KEY must be set",
        });
    });

    it("logs a failed boot check as one line and returns 1", async () => {
        const rpc = await rpcStub(false);
        const lines = captureStderr();
        try {
            expect(await main(["-config", writeConfig()], envFor(rpc.url))).toBe(1);
        } finally {
            await rpc.close();
        }
        expect(lines).toHaveLength(1);
        expect(parsed(lines)[0]).toMatchObject({ level: "error", msg: "boot check failed" });
        expect(String(parsed(lines)[0]!.reason)).toMatch(
            /recipient USDC account \w+ does not exist/,
        );
        expect(lines[0]).not.toContain(API_KEY);
    });

    it.each(["SIGTERM", "SIGINT"] as const)(
        "runs until %s, then closes its listeners and returns 0",
        async (signal) => {
            const rpc = await rpcStub(true);
            const lines = captureStderr();
            let run: Awaited<ReturnType<typeof runMain>>;
            try {
                run = await runMain(envFor(rpc.url), signal);
            } finally {
                await rpc.close();
            }
            expect(run.code).toBe(0);
            for (const port of run.ports) await expect(health(port)).rejects.toThrow();
            const msgs = parsed(lines).map((l) => l.msg);
            expect(msgs).toContain("payments started");
            expect(msgs).toContain("payments stopped");
            expect(lines.join("")).not.toContain(API_KEY);
        },
    );

    it("redacts every secret variable, as a value and inside an Error in an object", async () => {
        const rpc = await rpcStub(true);
        const env = envFor(rpc.url, {
            BUGNET_PAYMENTS_ROUTER_TOKEN: "router-token-main-test",
            BUGNET_TEST_PAYER_KEY: "test-payer-key-main-test",
            BUGNET_TEST_PAYER_MNEMONIC: "abandon ability able, about above absent",
            BUGNET_RECIPIENT_KEY: "recipient-key-main-test",
            BUGNET_TEST_PG_URL: "postgres://tester:pw-main-test@localhost:5432/postgres",
        });
        const values = SECRET_VARS.map((name) => env[name] ?? "");
        expect(values).not.toContain("");
        const lines = captureStderr();
        let run: Awaited<ReturnType<typeof runMain>>;
        try {
            run = await runMain(env, "SIGTERM", () => {
                for (const value of values) {
                    console.error("leaked %s", value, { err: new Error(`call failed: ${value}`) });
                }
            });
        } finally {
            await rpc.close();
        }
        expect(run.code).toBe(0);
        const leaked = parsed(lines).filter((l) => String(l.msg).startsWith("leaked"));
        expect(leaked.map((l) => String(l.msg).replace(/\s+/g, " "))).toEqual(
            values.map(() => "leaked [redacted] { err: 'Error: call failed: [redacted]' }"),
        );
        for (const value of values) expect(lines.join("")).not.toContain(value);
    });
});

describe("deploy unit", () => {
    it("the unit runs the built service with the env file", () => {
        const unit = readFileSync("deploy/bugnet-payments@.service", "utf8");
        for (const line of [
            "User=bugnet-payments",
            "WorkingDirectory=/opt/bugnet/payments/%i",
            "ExecStart=/usr/bin/node /opt/bugnet/payments/%i/dist/main.js -config /etc/bugnet/payments.toml",
            "EnvironmentFile=/etc/bugnet/payments.env",
            "ProtectSystem=strict",
            "NoNewPrivileges=true",
            "Restart=on-failure",
        ]) {
            expect(unit).toContain(line);
        }
    });

    it("has no reload command and no MemoryDenyWriteExecute", () => {
        const unit = readFileSync("deploy/bugnet-payments@.service", "utf8");
        expect(unit).not.toMatch(/^ExecReload=/m);
        expect(unit).not.toMatch(/^MemoryDenyWriteExecute=/m);
    });
});
