import { randomBytes } from "node:crypto";
import type { SolanaRpc } from "../solana/rpc.ts";
import { createDepositWatch, type DepositWatch } from "../deposits/job.ts";
import { DepositKeys } from "../deposits/keys.ts";
import type { ServiceImpl } from "@connectrpc/connect";
import { getAddressEncoder, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import type pg from "pg";
import { stringify } from "smol-toml";
import { parseSettings, type Secrets, type Settings } from "../config.ts";
import type { PaymentsService } from "../gen/bugnet/router/v1/payments_pb.ts";
import { createHttpApp } from "../http/app.ts";
import { startServer } from "../http/server.ts";
import { memoryLog } from "../log.ts";
import { orderPublicKeyBase64 } from "../orders/token.ts";
import type { OrderRequest, OrderRow } from "../orders/types.ts";
import { testDb } from "./db.ts";
import { bugnetAddresses } from "../x402/ids.ts";
import type { IndexCopy } from "../x402/index-file.ts";
import {
    createFakeRpc,
    type FakeRpc,
    type FakeRpcScript,
    TEST_BLOCKHASH,
    TEST_LVBH,
} from "./fake-rpc.ts";
import { startFakeRouter } from "./fake-router.ts";
import { testSigner } from "./keys.ts";
import { TEST_PAYTO, testIndex, usdcAccountAnswer } from "./x402.ts";

export interface TestAppOptions {
    now?: Date;
    routerImpl?: Partial<ServiceImpl<typeof PaymentsService>>;
    checkPayer?: boolean;
    trustedProxies?: string[];
    checkoutJsPath?: string;
    x402?: Partial<Settings["x402"]>;
    allowanceClaim?: boolean;
    signerOpen?: boolean;
    rpc?: Partial<FakeRpcScript>;
    // Deposits with seed Buffer.alloc(32, 7) and salt Buffer.alloc(16, 1); off when left out
    deposits?: Partial<Settings["deposits"]>;
    // The balance route's reads; the scripted rpc when left out
    backgroundRpc?: SolanaRpc;
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
    allowance: KeyPairSigner;
    index: IndexCopy;
    settings: Settings;
    secrets: Secrets;
    now: { get(): Date; set(d: Date): void };
    // With deposits: the viewer watch the public status route notes viewers in
    watch: DepositWatch | null;
    close(): Promise<void>;
}

export const TEST_DEPOSIT_SEED = Buffer.alloc(32, 7);
export const TEST_DEPOSIT_SALT = Buffer.alloc(16, 1);

const DEFAULT_NOW = new Date("2030-01-01T00:00:00Z");
// Router events in tests are signed with this seed
const EVENT_SEED = Buffer.alloc(32, 9);
const FEE_PAYER_SEED = 5;
const ALLOWANCE_SEED = 11;
const REFUND_SEED = 6;

function keypairSecret(seed: number, signer: KeyPairSigner): string {
    const bytes = new Uint8Array(64);
    bytes.fill(seed, 0, 32);
    bytes.set(getAddressEncoder().encode(signer.address), 32);
    return getBase58Decoder().decode(bytes);
}

export async function testApp(over: TestAppOptions = {}): Promise<TestApp> {
    const stops: Array<() => Promise<void>> = [];
    try {
        return await buildApp(over, stops);
    } catch (err) {
        for (const stop of stops.reverse()) await stop().catch(() => undefined);
        throw err;
    }
}

async function buildApp(over: TestAppOptions, stops: Array<() => Promise<void>>): Promise<TestApp> {
    let clock = over.now ?? DEFAULT_NOW;
    const appNow = () => new Date(clock.getTime());
    const log = memoryLog();
    const db = await testDb();
    stops.push(() => db.close());
    const router = await startFakeRouter(over.routerImpl ?? {});
    stops.push(() => router.close());
    const payer = await testSigner(3);
    const feePayer = await testSigner(FEE_PAYER_SEED);
    const recipient = await testSigner(1);
    const allowance = await testSigner(ALLOWANCE_SEED);
    const refund = await testSigner(REFUND_SEED);
    const index = testIndex();
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
                allowance_claim: over.allowanceClaim ?? true,
            },
            x402: { enabled: true, allowance_wallet: allowance.address, ...over.x402 },
            ...(over.deposits === undefined ? {} : { deposits: { ...over.deposits } }),
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
        allowanceKey: keypairSecret(ALLOWANCE_SEED, allowance),
        x402TlsKey: "",
        depositSeed: over.deposits === undefined ? null : TEST_DEPOSIT_SEED,
        depositSeedPrevious: null,
    };
    const watch =
        over.deposits === undefined
            ? null
            : createDepositWatch(settings.deposits.viewer_ttl, settings.deposits.busy_every);
    const rpc = createFakeRpc({
        getAccountInfo: () => usdcAccountAnswer(TEST_PAYTO),
        ...over.rpc,
    });
    const http = createHttpApp(
        {
            settings,
            secrets,
            pool: db.pool,
            rpc,
            feePayer,
            x402: {
                signer: { open: () => over.signerOpen ?? true },
                index: () => index,
                addresses: bugnetAddresses({
                    feePayer: feePayer.address,
                    allowanceWallet: allowance.address,
                    refundWallet: refund.address,
                    recipient: recipient.address,
                }),
            },
            ...(over.backgroundRpc === undefined ? {} : { backgroundRpc: over.backgroundRpc }),
            deposits:
                watch === null
                    ? null
                    : {
                          keys: new DepositKeys(new Map([[1, TEST_DEPOSIT_SEED]]), 1),
                          watch,
                          enabled: settings.deposits.enabled,
                          salt: () => TEST_DEPOSIT_SALT,
                      },
            log,
            now: appNow,
        },
        { limiterClock: () => clock.getTime(), checkoutJsPath: over.checkoutJsPath },
    );
    const internal = await startServer(settings.http.internal_listen, http.internalHandler, log);
    stops.push(() => internal.close());
    const publicServer = await startServer(
        settings.http.public_listen,
        http.publicHandler,
        log,
        settings.http.trusted_proxies,
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
        allowance,
        index,
        settings,
        secrets,
        watch,
        now: {
            get: appNow,
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
