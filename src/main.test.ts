import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { create as createMessage } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { type Address, getAddressEncoder, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type pg from "pg";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BootCheckError } from "./boot.ts";
import { parseSettings, SECRET_VARS, type Secrets, secretsEnv, type Settings } from "./config.ts";
import { jsonLog, memoryLog, silentLog } from "./log.ts";
import {
    ReserveAndSignRequestSchema,
    X402SignerService,
} from "./gen/bugnet/payments/v1/x402_pb.ts";
import { indexHolder, installReload, main, routeConsole, startService } from "./main.ts";
import { findOrder } from "./orders/store.ts";
import { orderPublicKeyBase64 } from "./orders/token.ts";
import { usdcAta } from "./solana/accounts.ts";
import type { SolanaRpc } from "./solana/rpc.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "./solana/constants.ts";
import { create, until } from "./testing/app.ts";
import { testDb, type TestDb } from "./testing/db.ts";
import { createFakeRpc, epochAt, type FakeRpcScript } from "./testing/fake-rpc.ts";
import { testSigner } from "./testing/keys.ts";
import { startFakeChain, type FakeChain } from "./testing/fake-chain.ts";
import { startFakeRouter, type FakeRouter } from "./testing/fake-router.ts";
import { seedOrder, seedPayment } from "./testing/orders.ts";
import { makeTestPki } from "./testing/pki.ts";
import { seedAccount, seedFunding, seedX402Payment, TEST_PAYTO } from "./testing/x402.ts";
import { newOrderId } from "./orders/ids.ts";
import { enqueueAllowanceEvent } from "./x402/outbox.ts";
import { resetMirrorState } from "./x402/mirror.ts";
import { parseIndex } from "./x402/index-file.ts";
import { readTail } from "./x402/tail.ts";

const slowListener = vi.hoisted(() => ({ ms: 0 }));
vi.mock("./x402/listener.ts", async (importOriginal) => {
    const real = await importOriginal<typeof import("./x402/listener.ts")>();
    return {
        ...real,
        startSignerListener: async (...args: Parameters<typeof real.startSignerListener>) => {
            await new Promise((r) => setTimeout(r, slowListener.ms));
            return real.startSignerListener(...args);
        },
    };
});

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

const PEM_MAIN_TEST =
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIMainTest\n-----END PRIVATE KEY-----\n";

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
        paymentsToken: "gateway-to-payments-main-test-0123456789",
        routerToken: "",
        orderSeed: Buffer.alloc(32, 1),
        claimKey: Buffer.alloc(32, 2),
        feePayerKey: await secretKey(5),
        refundKey: await secretKey(6),
        rpcUrl: "",
        allowanceKey: "",
        x402TlsKey: "",
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

    it("refuses to start with allowance_wallet empty while an allowance order is unfinished", async () => {
        await seedOrder(db.pool, {
            kind: "start",
            state: "paid",
            payInto: "allowance",
            amountMicros: 1_013_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
        });
        const internal = await freePort();
        const pub = await freePort();
        const failing = testSettings({
            http: { internal_listen: `127.0.0.1:${internal}`, public_listen: `127.0.0.1:${pub}` },
        });
        await expect(
            startService({ settings: failing, secrets, rpc: okRpc(), log: silentLog }),
        ).rejects.toThrow(/allowance_wallet is empty while 1 allowance order/);
        await expect(fetch(`http://${failing.http.internal_listen}/healthz`)).rejects.toThrow();
    });

    it("warns at boot when an order can be larger than the refund daily cap", async () => {
        const capWarnings = (log: ReturnType<typeof memoryLog>) =>
            log.lines.filter(
                (l) => typeof l.msg === "string" && l.msg.startsWith("orders.max_amount_micros"),
            );
        for (const [cap, warned] of [
            [100_000_000, false],
            [99_999_999, true],
        ] as const) {
            const log = memoryLog();
            const s = await startService({
                settings: testSettings({
                    orders: { max_amount_micros: 100_000_000 },
                    refunds: { daily_cap_micros: cap },
                }),
                secrets,
                rpc: okRpc(),
                log,
            });
            try {
                expect(log.lines.some((l) => l.msg === "payments started")).toBe(true);
            } finally {
                await s.stop();
            }
            expect(capWarnings(log)).toEqual(
                warned
                    ? [
                          expect.objectContaining({
                              level: "warn",
                              msg:
                                  "orders.max_amount_micros is above refunds.daily_cap_micros, " +
                                  "a refund above the cap always goes to the manual queue",
                              maxAmountMicros: 100_000_000,
                              dailyCapMicros: 99_999_999,
                              manualReason: "refund_exceeds_cap",
                          }),
                      ]
                    : [],
            );
        }
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
        const rpc = okRpc({ getEpochInfo: () => held.then(() => epochAt(1_000n)) });
        const s = await startService({
            settings: testSettings({ jobs: { reconcile_every: "1h" } }),
            secrets,
            rpc,
            log: silentLog,
        });
        let stopped = false;
        try {
            await until(async () => rpc.calls.getEpochInfo === 1, 5_000);
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
            getEpochInfo: () => held.then(() => epochAt(1_000n)),
            getSignatureStatuses: () => ({ value: [null] }),
        });
        const s = await startService({
            settings: testSettings({ jobs: { reconcile_every: "20ms" } }),
            secrets,
            rpc,
            log: silentLog,
        });
        try {
            await until(async () => rpc.calls.getEpochInfo === 1, 5_000);
            await new Promise((resolve) => setTimeout(resolve, 100));
            void s.stop();
        } finally {
            release();
            await s.stop();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(rpc.calls.getEpochInfo).toBe(1);
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
            allowanceKey: "allowance-key-start-test",
            x402TlsKey: PEM_MAIN_TEST,
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
            rpc: okRpc({ getEpochInfo: down, getSignatureStatuses: down }),
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
            BUGNET_PAYMENTS_ROUTER_TOKEN: "router-token-main-test-0123456789abcdef",
            BUGNET_TEST_PAYER_KEY: "test-payer-key-main-test",
            BUGNET_TEST_PAYER_MNEMONIC: "abandon ability able, about above absent",
            BUGNET_RECIPIENT_KEY: "recipient-key-main-test",
            BUGNET_ALLOWANCE_KEY: "allowance-key-main-test",
            BUGNET_X402_TLS_KEY: Buffer.from(PEM_MAIN_TEST).toString("base64"),
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

describe("x402 wiring", () => {
    let dir: string;
    let chain: FakeChain;
    let fakeRouter: FakeRouter;
    let pki: ReturnType<typeof makeTestPki>;
    let allowance: KeyPairSigner;
    let funder: KeyPairSigner;
    let indexPath: string;
    let x402Secrets: Secrets;
    const EMPTY_INDEX = '{"v":1,"services":[]}';

    function withBalance(rpc: SolanaRpc): SolanaRpc {
        return new Proxy(rpc, {
            get(target, prop, receiver) {
                if (prop === "getBalance") {
                    return () => ({ send: async () => ({ value: 1_000_000_000n }) });
                }
                return Reflect.get(target, prop, receiver) as unknown;
            },
        });
    }

    function x402Settings(over: Tables = {}): Settings {
        const merged: Tables = {
            x402: {
                enabled: true,
                allowance_wallet: allowance.address,
                listen: "127.0.0.1:0",
                tls_cert_file: pki.serverCert,
                client_ca_file: pki.ca,
                indexed_services_file: indexPath,
                release_every: "200ms",
                reserved_release_after: "1s",
                events_every: "200ms",
            },
            router: { url: fakeRouter.url },
        };
        for (const [table, fields] of Object.entries(over)) {
            merged[table] = { ...merged[table], ...fields };
        }
        return testSettings(merged);
    }

    function signerClient(port: number) {
        return createClient(
            X402SignerService,
            createConnectTransport({
                baseUrl: `https://127.0.0.1:${port}`,
                httpVersion: "2",
                nodeOptions: {
                    ca: readFileSync(pki.ca, "utf8"),
                    cert: readFileSync(pki.clientCert, "utf8"),
                    key: readFileSync(pki.clientKey, "utf8"),
                    servername: "bugnet-payments.internal",
                },
            }),
        );
    }

    function reserveRequest(over: { accountId: string }) {
        return createMessage(ReserveAndSignRequestSchema, {
            accountId: over.accountId,
            placementId: "00000000-0000-4000-8000-000000000001",
            ref: "abcdefghijklmnop",
            serviceId: "xs_abcdefghijklmnop",
            method: "POST",
            host: "agent402.tools",
            path: "/v1/auto/chat/completions",
            bodySha256: new Uint8Array(32).fill(2),
            targetSha256: new Uint8Array(32).fill(1),
            paymentRequired: "",
        });
    }

    async function rowState(pool: pg.Pool, table: string, id: string | number) {
        const res = await pool.query<{ state: string }>(
            `select state from ${table} where id = $1`,
            [id],
        );
        return res.rows[0]?.state;
    }

    async function seedAllowanceRefund(pool: pg.Pool, micros: number): Promise<number> {
        const source = await usdcAta(funder.address);
        chain.setTokenAccount({ address: source, owner: funder.address, amount: 0n });
        const account = await seedAccount(pool, {
            state: "open",
            handleSha256: randomBytes(32).toString("hex"),
        });
        const funding = await seedFunding(pool, {
            accountId: account.id,
            allowanceMicros: 1_000_000,
            payer: funder.address,
            sourceTokenAccount: source,
        });
        await pool.query("update x402_pool set committed_micros = 1000000");
        const res = await pool.query<{ id: string }>(
            `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
                from_wallet, budget_waived)
             values ($1, 'allowance', 'x402_unspent', $2, $3, $4, 'pending', 'allowance', false)
             returning id`,
            [funding.orderId, micros, source, funder.address],
        );
        return Number(res.rows[0]!.id);
    }

    beforeAll(async () => {
        dir = mkdtempSync(path.join(tmpdir(), "bn-pay-x402-main-"));
        mkdirSync(path.join(dir, "pki"));
        pki = makeTestPki(path.join(dir, "pki"));
        indexPath = path.join(dir, "x402-index.json");
        writeFileSync(indexPath, EMPTY_INDEX);
        allowance = await testSigner(11);
        funder = await testSigner(12);
        chain = await startFakeChain({ autoFinalize: true });
        for (const [address, owner] of [
            [await usdcAta(allowance.address), allowance.address],
            [await usdcAta(recipient.address), recipient.address],
            [await usdcAta(refundWallet.address), refundWallet.address],
        ] as const) {
            chain.setTokenAccount({
                address,
                owner,
                amount: address === (await usdcAta(allowance.address)) ? 5_000_000n : 0n,
            });
        }
        fakeRouter = await startFakeRouter({
            appendAllowanceEvent: () => ({}),
            appendX402Resolved: () => ({}),
        });
        x402Secrets = {
            ...secrets,
            allowanceKey: await secretKey(11),
            x402TlsKey: readFileSync(pki.serverKey, "utf8"),
            routerToken: "router-token-0123456789",
        };
    });
    afterAll(async () => {
        await chain.close();
        await fakeRouter.close();
        rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
        resetMirrorState();
        await db.pool.query(
            `update x402_tail set token_account = null, opening_balance_micros = 0,
                opening_slot = 0, opened_at = null, verified_slot = 0, verified_at = null,
                finalized_height = 0, mismatch_since = null`,
        );
    });

    it("starts the x402 listener and every job when allowance_wallet is set", async () => {
        const s = await startService({
            settings: x402Settings(),
            secrets: x402Secrets,
            rpc: withBalance(chain.rpc),
            log: silentLog,
        });
        try {
            expect(s.x402Port).not.toBeNull();
            const res = await signerClient(s.x402Port!).reserveAndSign(
                reserveRequest({ accountId: newOrderId() }),
            );
            expect(res.result.case).toBe("refused");
            expect((await readTail(s.pool)).tokenAccount).toBe(await usdcAta(allowance.address));

            const account = await seedAccount(s.pool, {
                fundedMicros: 1_000_000,
                heldMicros: 10_000,
            });
            const row = await seedX402Payment(s.pool, {
                accountId: account.id,
                state: "reserved",
                createdAt: new Date(Date.now() - 60_000),
            });
            await until(
                async () => (await rowState(s.pool, "x402_payments", row.id)) === "released",
                5_000,
            );

            await enqueueAllowanceEvent(
                s.pool,
                {
                    startOrderId: account.id,
                    orderId: account.id,
                    phase: "paid",
                    amountMicros: 1_000_000,
                    keptMicros: 0,
                    tx: signature(),
                },
                new Date(),
            );
            await until(
                async () =>
                    (
                        await s.pool.query(
                            "select state from x402_router_events where order_id = $1",
                            [account.id],
                        )
                    ).rows[0]?.state === "sent",
                5_000,
            );
        } finally {
            await s.stop();
        }
    });

    it("starts no x402 piece when allowance_wallet is empty", async () => {
        const rpc = okRpc();
        const s = await startService({ settings: testSettings(), secrets, rpc, log: silentLog });
        try {
            expect(s.x402Port).toBeNull();
            expect((await readTail(s.pool)).tokenAccount).toBeNull();
            expect(rpc.calls.getAccountInfo).toBe(2); // recipient and refund ATAs, as before
        } finally {
            await s.stop();
        }
    });

    it("SIGHUP is handled before the listeners open, and stop removes the handler", async () => {
        const before = process.listenerCount("SIGHUP");
        let atBoot = -1;
        const rpc = okRpc({
            getBalance: () => {
                atBoot = process.listenerCount("SIGHUP"); // bootChecks runs before any listener binds
                return { value: 1_000_000_000n };
            },
        });
        const s = await startService({ settings: testSettings(), secrets, rpc, log: silentLog });
        await s.stop();
        expect(atBoot).toBe(before + 1);
        expect(process.listenerCount("SIGHUP")).toBe(before);
    });

    it("a bad index on SIGHUP keeps the old copy and alarms x402_reload_failed", async () => {
        const log = memoryLog();
        const s = await startService({
            settings: x402Settings(),
            secrets: x402Secrets,
            rpc: withBalance(chain.rpc),
            log,
        });
        try {
            writeFileSync(indexPath, "not json");
            process.emit("SIGHUP");
            expect(log.lines.filter((l) => l.alarm === "x402_reload_failed")).toHaveLength(1);
        } finally {
            await s.stop();
            writeFileSync(indexPath, EMPTY_INDEX);
        }
    });

    it("a SIGHUP with the TLS files still bad alarms x402_reload_failed and opens no listener", async () => {
        const log = memoryLog();
        const certPath = path.join(mkdtempSync(path.join(tmpdir(), "bn-tls-")), "server.crt");
        writeFileSync(certPath, "not a certificate");
        const s = await startService({
            settings: x402Settings({ x402: { tls_cert_file: certPath } }),
            secrets: x402Secrets,
            rpc: withBalance(chain.rpc),
            log,
        });
        try {
            expect(s.x402Port).toBeNull();
            process.emit("SIGHUP");
            const alarms = log.lines.filter((l) => l.alarm === "x402_reload_failed");
            expect(alarms).toHaveLength(1);
            expect(alarms[0]?.problem).toBe("tls_cert_file does not parse");
        } finally {
            await s.stop();
        }
    });

    it("TLS files fixed without a SIGHUP keep terms disabled while no listener is open", async () => {
        const certPath = path.join(mkdtempSync(path.join(tmpdir(), "bn-tls-")), "server.crt");
        writeFileSync(certPath, "not a certificate");
        const s = await startService({
            settings: x402Settings({
                x402: { tls_cert_file: certPath },
                jobs: { alarms_every: "20ms" },
            }),
            secrets: x402Secrets,
            rpc: withBalance(chain.rpc),
            log: silentLog,
        });
        const terms = async () => {
            const res = await fetch(`http://127.0.0.1:${s.internalPort}/v1/x402/terms`, {
                headers: { authorization: `Bearer ${x402Secrets.paymentsToken}` },
            });
            return (await res.json()) as { enabled: boolean };
        };
        try {
            expect(s.x402Port).toBeNull();
            writeFileSync(certPath, readFileSync(pki.serverCert));
            await new Promise((r) => setTimeout(r, 200)); // the TLS check runs every 20ms
            expect((await terms()).enabled).toBe(false);
            process.emit("SIGHUP");
            await until(async () => (await terms()).enabled, 2_000);
        } finally {
            await s.stop();
        }
    });

    it("stop waits for a listener still opening and closes it", async () => {
        const probe = createServer();
        await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
        const port = (probe.address() as AddressInfo).port;
        await new Promise((r) => probe.close(r));
        const certPath = path.join(mkdtempSync(path.join(tmpdir(), "bn-tls-")), "server.crt");
        writeFileSync(certPath, "not a certificate");
        const s = await startService({
            settings: x402Settings({
                x402: { tls_cert_file: certPath, listen: `127.0.0.1:${port}` },
            }),
            secrets: x402Secrets,
            rpc: withBalance(chain.rpc),
            log: silentLog,
        });
        writeFileSync(certPath, readFileSync(pki.serverCert));
        slowListener.ms = 400;
        try {
            process.emit("SIGHUP");
            await s.stop();
            await new Promise((r) => setTimeout(r, 800));
        } finally {
            slowListener.ms = 0;
        }
        const open = await new Promise<boolean>((resolve) => {
            const c = netConnect(port, "127.0.0.1");
            c.once("connect", () => (c.destroy(), resolve(true)));
            c.once("error", () => resolve(false));
        });
        expect(open).toBe(false);
    });

    it("the hot executor runs with refunds.enabled false", async () => {
        const settings = x402Settings({
            refunds: { enabled: false },
            jobs: { refunds_every: "200ms" },
        });
        const s = await startService({
            settings,
            secrets: x402Secrets,
            rpc: withBalance(chain.rpc),
            log: silentLog,
        });
        try {
            const id = await seedAllowanceRefund(s.pool, 300_000);
            await until(
                async () =>
                    ["sent", "signed"].includes((await rowState(s.pool, "refunds", id)) ?? ""),
                5_000,
            );
        } finally {
            await s.stop();
        }
    });

    it("switched off still runs every job and refuses only signing", async () => {
        const s = await startService({
            settings: x402Settings({ x402: { enabled: false } }),
            secrets: x402Secrets,
            rpc: withBalance(chain.rpc),
            log: silentLog,
        });
        try {
            const res = await signerClient(s.x402Port!).reserveAndSign(
                reserveRequest({ accountId: newOrderId() }),
            );
            expect(res.result.case === "refused" && res.result.value.reason).toBe("x402_disabled");
            const account = await seedAccount(s.pool, {
                fundedMicros: 1_000_000,
                heldMicros: 10_000,
            });
            const row = await seedX402Payment(s.pool, {
                accountId: account.id,
                state: "reserved",
                createdAt: new Date(Date.now() - 60_000),
            });
            await until(
                async () => (await rowState(s.pool, "x402_payments", row.id)) === "released",
                5_000,
            );
            await enqueueAllowanceEvent(
                s.pool,
                {
                    startOrderId: account.id,
                    orderId: account.id,
                    phase: "paid",
                    amountMicros: 1_000_000,
                    keptMicros: 0,
                    tx: signature(),
                },
                new Date(),
            );
            await until(
                async () =>
                    (
                        await s.pool.query(
                            "select state from x402_router_events where order_id = $1",
                            [account.id],
                        )
                    ).rows[0]?.state === "sent",
                5_000,
            );
        } finally {
            await s.stop();
        }
    });
});

describe("installReload", () => {
    it("calls the handler on SIGHUP and the remover detaches it", () => {
        const before = process.listenerCount("SIGHUP");
        const onReload = vi.fn();
        const remove = installReload(onReload);
        process.emit("SIGHUP");
        expect(onReload).toHaveBeenCalledTimes(1);
        remove();
        process.emit("SIGHUP");
        expect(onReload).toHaveBeenCalledTimes(1);
        expect(process.listenerCount("SIGHUP")).toBe(before);
    });
});

describe("indexHolder", () => {
    const entry = (host: string) =>
        JSON.stringify({
            method: "POST",
            host,
            prefix: "/v1/",
            url: `https://${host}/v1/`,
            payTo: TEST_PAYTO,
        });

    it("keeps the old copy on a bad file and fires x402_reload_failed", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bn-pay-index-"));
        try {
            const file = path.join(dir, "x402-index.json");
            const text = (hosts: string[]) => `{"v":1,"services":[${hosts.map(entry).join(",")}]}`;
            writeFileSync(file, text(["a.example"]));
            const log = memoryLog();
            const holder = indexHolder(file, log, parseIndex(readFileSync(file, "utf8"), file));
            expect(holder.current().size).toBe(1);

            writeFileSync(file, "not json");
            expect(holder.reload()).toBe(false);
            expect(holder.current().size).toBe(1);
            expect(log.lines.filter((l) => l.alarm === "x402_reload_failed")).toHaveLength(1);

            writeFileSync(file, text(["a.example", "b.example"]));
            expect(holder.reload()).toBe(true);
            expect(holder.current().size).toBe(2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("deploy notes", () => {
    it("cover the x402 setup", () => {
        const readme = readFileSync("deploy/README.md", "utf8");
        for (const s of [
            "127.0.0.1:8449",
            "/etc/bugnet/internal-ca.pem",
            "/etc/bugnet/payments/x402-server.pem",
            "x402-index.json",
            "BUGNET_ALLOWANCE_KEY",
            "BUGNET_X402_TLS_KEY",
            "keys fund --create-allowance-ata",
            "systemctl kill -s HUP",
            "mtls init --renew --from",
            "allowance_claim = true",
            "payments_timeout",
            "x402 incident resolve",
            "x402 refunds hold",
            "keys drain --allowance",
            "x402_resign_waiting",
            "x402_cold_transfer_failed",
        ]) {
            expect(readme).toContain(s);
        }
    });

    it("run every database command against the deploy settings, never the dev default", () => {
        for (const file of ["README.md", "x402-mainnet-tests.md"]) {
            const text = readFileSync(path.join(import.meta.dirname, "..", "deploy", file), "utf8");
            const words = text.replace(/\s+/g, " ");
            expect(words, file).not.toMatch(
                /pnpm cli (x402|manual|refunds|keys drain --allowance)/,
            );
            expect(text, file).toContain("pcli() {");
            expect(text, file).toContain("-config /etc/bugnet/payments.toml");
        }
    });
});
