import { randomBytes } from "node:crypto";
import type { ServiceImpl } from "@connectrpc/connect";
import { getAddressEncoder, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import type pg from "pg";
import { stringify } from "smol-toml";
import { parseSettings, type Secrets, type Settings } from "../config.ts";
import { createInternalHandler } from "../http/internal.ts";
import { createPublicHandler } from "../http/public.ts";
import { startServer } from "../http/server.ts";
import type { PaymentsService } from "../gen/bugnet/router/v1/payments_pb.ts";
import { memoryLog } from "../log.ts";
import { type PayDeps, payOrder } from "../orders/pay.ts";
import type { OrderServiceDeps } from "../orders/service.ts";
import { orderKey, orderPublicKeyBase64 } from "../orders/token.ts";
import type { OrderRequest, OrderRow } from "../orders/types.ts";
import { RateLimiter } from "../ratelimit.ts";
import { createRouterClient } from "../router/client.ts";
import { BlockhashCache } from "../solana/blockhash.ts";
import { createSettler } from "../x402/settler.ts";
import { testDb } from "./db.ts";
import { createFakeRpc, type FakeRpc, TEST_BLOCKHASH, TEST_LVBH } from "./fake-rpc.ts";
import { startFakeRouter } from "./fake-router.ts";
import { testSigner } from "./keys.ts";

export interface TestAppOptions {
    now?: Date;
    routerImpl?: Partial<ServiceImpl<typeof PaymentsService>>;
    checkPayer?: boolean;
    trustedProxies?: string[];
    checkoutJsPath?: string;
}

export interface TestApp {
    internalUrl: string;
    publicOrigin: string;
    publicUrl: string;
    pool: pg.Pool;
    rpc: FakeRpc;
    router: { url: string; close(): Promise<void> };
    log: ReturnType<typeof memoryLog>;
    payer: KeyPairSigner;
    feePayer: KeyPairSigner;
    settings: Settings;
    secrets: Secrets;
    now: { set(d: Date): void };
    close(): Promise<void>;
}

const DEFAULT_NOW = new Date("2030-01-01T00:00:00Z");
// Router events in tests are signed with this seed
const EVENT_SEED = Buffer.alloc(32, 9);
const FEE_PAYER_SEED = 5;

let clock = DEFAULT_NOW;

export function now(): Date {
    return new Date(clock.getTime());
}

function keypairSecret(seed: number, signer: KeyPairSigner): string {
    const bytes = new Uint8Array(64);
    bytes.fill(seed, 0, 32);
    bytes.set(getAddressEncoder().encode(signer.address), 32);
    return getBase58Decoder().decode(bytes);
}

export async function testApp(over: TestAppOptions = {}): Promise<TestApp> {
    clock = over.now ?? DEFAULT_NOW;
    const log = memoryLog();
    const db = await testDb();
    const router = await startFakeRouter(over.routerImpl ?? {});
    const payer = await testSigner(3);
    const feePayer = await testSigner(FEE_PAYER_SEED);
    const recipient = await testSigner(1);
    const settings = parseSettings(
        stringify({
            http: {
                internal_listen: "127.0.0.1:0",
                public_listen: "127.0.0.1:0",
                ...(over.trustedProxies === undefined
                    ? {}
                    : { trusted_proxies: over.trustedProxies }),
            },
            database: { url: db.url },
            solana: { recipient: recipient.address },
            router: {
                url: router.url,
                event_public_key: orderPublicKeyBase64(EVENT_SEED),
                check_payer: over.checkPayer ?? false,
            },
        }),
        "testApp",
    );
    const secrets: Secrets = {
        paymentsToken: randomBytes(16).toString("hex"),
        routerToken: randomBytes(16).toString("hex"),
        orderSeed: randomBytes(32),
        claimKey: randomBytes(32),
        feePayerKey: keypairSecret(FEE_PAYER_SEED, feePayer),
        refundKey: "",
        rpcUrl: "",
    };
    const appNow = () => now();
    const rpc = createFakeRpc();
    const hints = new BlockhashCache(rpc, settings.solana.blockhash_cache_ttl, () =>
        clock.getTime(),
    );
    const challenge = {
        publicUrl: settings.http.public_url,
        recipient: settings.solana.recipient,
        feePayer: feePayer.address,
        transactionVersions: settings.solana.transaction_versions,
    };
    const settler = createSettler({
        feePayer,
        rpc,
        hints,
        caps: {
            maxComputeUnits: settings.solana.max_compute_units,
            maxPriorityFeeMicroLamports: settings.solana.max_priority_fee_micro_lamports,
            maxRequiredSignatures: settings.solana.max_required_signatures,
        },
        transactionVersions: settings.solana.transaction_versions,
        log,
    });
    const pay: PayDeps = {
        pool: db.pool,
        settler,
        router: createRouterClient({
            url: settings.router.url,
            token: secrets.routerToken,
            timeoutMs: settings.router.timeout,
            checkPayer: settings.router.check_payer,
            getOrder: settings.router.get_order,
            log,
        }),
        attempts: new RateLimiter(settings.orders.attempts_per_order_per_minute, 60_000, () =>
            clock.getTime(),
        ),
        challenge,
        log,
        now: appNow,
    };
    const service: OrderServiceDeps = {
        pool: db.pool,
        settings,
        challenge,
        hints,
        orderKey: orderKey(secrets.orderSeed),
        claimKey: secrets.claimKey,
        pay: (orderId, raw, signal) => payOrder(pay, orderId, raw, signal),
        log,
        now: appNow,
    };
    const internal = await startServer(
        settings.http.internal_listen,
        createInternalHandler({
            service,
            token: secrets.paymentsToken,
            maxBodyBytes: settings.http.max_body_bytes,
            log,
        }),
        log,
    );
    const publicServer = await startServer(
        settings.http.public_listen,
        createPublicHandler({
            pool: db.pool,
            challenge,
            hints,
            pay,
            perIp: new RateLimiter(settings.limits.public_per_ip_per_minute, 60_000, () =>
                clock.getTime(),
            ),
            statusPerIp: new RateLimiter(settings.limits.status_per_ip_per_minute, 60_000, () =>
                clock.getTime(),
            ),
            trustedProxies: settings.http.trusted_proxies,
            maxBodyBytes: settings.http.max_body_bytes,
            checkoutJsPath: over.checkoutJsPath ?? "dist/checkout.js",
            log,
            now: appNow,
        }),
        log,
    );
    return {
        publicOrigin: `http://127.0.0.1:${publicServer.port}`,
        internalUrl: `http://127.0.0.1:${internal.port}`,
        publicUrl: settings.http.public_url,
        pool: db.pool,
        rpc,
        router,
        log,
        payer,
        feePayer,
        settings,
        secrets,
        now: {
            set(d: Date) {
                clock = d;
            },
        },
        async close() {
            await publicServer.close();
            await internal.close();
            await router.close();
            await db.close();
        },
    };
}

export async function post(
    app: TestApp,
    path: string,
    body: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers of every shape
): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.internalUrl}${path}`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.secrets.paymentsToken}`,
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

export function get(
    app: TestApp,
    path: string,
    headers: Record<string, string> = {},
): Promise<Response> {
    return fetch(`${app.publicOrigin}${path}`, { headers });
}

export function totalCalls(rpc: FakeRpc): number {
    return Object.values(rpc.calls).reduce((a, b) => a + b, 0);
}

export function create(over: Partial<OrderRequest> = {}): OrderRequest {
    return {
        kind: "start",
        packageId: "pkg-test",
        amountMicros: 10_000,
        description: "Bugnet sandbox 2 vCPU / 2 GiB, 10 min",
        ...over,
    };
}

export function terms(o: OrderRow): OrderRequest {
    const out: OrderRequest = {
        kind: o.kind,
        packageId: o.packageId,
        amountMicros: o.amountMicros,
        description: o.description,
    };
    if (o.handleSha256 !== null) out.handleSha256 = o.handleSha256;
    return out;
}

export function withHints(req: PaymentRequirements): PaymentRequirements {
    return {
        ...req,
        extra: {
            ...req.extra,
            recentBlockhash: TEST_BLOCKHASH,
            lastValidBlockHeight: String(TEST_LVBH),
        },
    };
}

export async function until(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await cond())) {
        if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
