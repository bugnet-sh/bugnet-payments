/**
 * What the two mainnet live files share: the live settings, the balance reads, the signed router
 * events, the paying x402 client, and the x402 account helpers (orders, signing, termination).
 */
import { createHash, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { create as createMessage } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { type Address, address, type KeyPairSigner } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { ExactSvmScheme, SOLANA_MAINNET_CAIP2 } from "@x402/svm";
import { parse, stringify } from "smol-toml";
import { expect } from "vitest";
import { parseSettings, readSecrets, type Secrets, type Settings } from "../../src/config.ts";
import {
    ReserveAndSignRequestSchema,
    type ReserveAndSignResponse,
    type Signed,
    X402SignerService,
} from "../../src/gen/bugnet/payments/v1/x402_pb.ts";
import type { RunningService } from "../../src/main.ts";
import { orderKey, orderPublicKeyBase64 } from "../../src/orders/token.ts";
import { usdcAta } from "../../src/solana/accounts.ts";
import type { SolanaRpc } from "../../src/solana/rpc.ts";
import { startFakeRouter, type FakeRouter } from "../../src/testing/fake-router.ts";
import { makeTestPki } from "../../src/testing/pki.ts";
import { base32Lower, serviceIdFor } from "../../src/x402/ids.ts";
import type { HttpMethod, Listed } from "../../src/x402/types.ts";
import { TEST_SELLER, type TestSeller } from "./test-seller.ts";

export const REPO = resolve(import.meta.dirname, "../..");
export const RPC_PACE_MS = 1_000;

type Tables = Record<string, Record<string, unknown>>;

export interface Balances {
    payerUsdc: bigint;
    recipientUsdc: bigint;
    refundUsdc: bigint;
    feePayerLamports: bigint;
}

function freePort(): Promise<number> {
    return new Promise((done, fail) => {
        const server = createServer();
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };
            server.close(() => done(port));
        });
    });
}

// The public URL names the public port, so that port is picked before the service starts
async function liveTables(dbUrl: string, eventSeed: Buffer): Promise<Tables> {
    const dev = parse(readFileSync(resolve(REPO, "config/dev.toml"), "utf8")) as Tables;
    const port = await freePort();
    return {
        ...dev,
        http: {
            ...dev.http,
            internal_listen: "127.0.0.1:0",
            public_listen: `127.0.0.1:${port}`,
            public_url: `http://127.0.0.1:${port}`,
        },
        database: { ...dev.database, url: dbUrl },
        router: { ...dev.router, event_public_key: orderPublicKeyBase64(eventSeed) },
    };
}

export async function liveSettings(dbUrl: string, eventSeed: Buffer): Promise<Settings> {
    return parseSettings(stringify(await liveTables(dbUrl, eventSeed)), "live");
}

// until polls every 20 ms, far above what the RPC plan allows
export function paced(read: () => Promise<boolean>, ms = RPC_PACE_MS): () => Promise<boolean> {
    return async () => {
        if (await read()) return true;
        await sleep(ms);
        return false;
    };
}

export async function usdcOf(rpc: SolanaRpc, owner: Address): Promise<bigint> {
    const ata = await usdcAta(owner);
    const { value } = await rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send();
    return BigInt(value.amount);
}

export async function lamportsOf(rpc: SolanaRpc, owner: Address): Promise<bigint> {
    return (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
}

export async function balances(
    rpc: SolanaRpc,
    w: {
        testPayer: KeyPairSigner;
        recipient: string;
        refundWallet: KeyPairSigner;
        feePayer: KeyPairSigner;
    },
): Promise<Balances> {
    return {
        payerUsdc: await usdcOf(rpc, w.testPayer.address),
        recipientUsdc: await usdcOf(rpc, address(w.recipient)),
        refundUsdc: await usdcOf(rpc, w.refundWallet.address),
        feePayerLamports: await lamportsOf(rpc, w.feePayer.address),
    };
}

export async function postOrder<T>(s: RunningService, token: string, body: unknown): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${s.internalPort}/v1/orders`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
}

export async function postSignedEvent(
    s: RunningService,
    eventSeed: Buffer,
    e: { type: string; payload: Record<string, unknown> },
): Promise<void> {
    const id = `evt_live_${randomBytes(8).toString("hex")}`;
    const raw = Buffer.from(
        JSON.stringify({
            id,
            type: e.type,
            created_at: new Date().toISOString(),
            payload: e.payload,
        }),
    );
    const res = await fetch(`http://127.0.0.1:${s.internalPort}/v1/events`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bugnet-event-id": id,
            "x-bugnet-signature": sign(null, raw, orderKey(eventSeed)).toString("base64"),
        },
        body: new Uint8Array(raw),
    });
    expect(res.status).toBe(200);
}

export function payClient(testPayer: KeyPairSigner, rpcUrl: string): x402HTTPClient {
    return new x402HTTPClient(
        new x402Client().register(
            SOLANA_MAINNET_CAIP2,
            new ExactSvmScheme(testPayer, { rpcUrl, transactionVersions: [0] }),
        ),
    );
}

export async function challenge(http: x402HTTPClient, payUrl: string): Promise<PaymentRequired> {
    const res = await fetch(payUrl, { headers: { accept: "application/json" } });
    expect(res.status).toBe(402);
    return http.getPaymentRequiredResponse((n) => res.headers.get(n), await res.json());
}

export function decodedAccepts(header: string): PaymentRequired["accepts"] {
    return decodePaymentRequiredHeader(header).accepts;
}

export function decodedPaymentResponse(header: string): { success: boolean; transaction: string } {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        success: boolean;
        transaction: string;
    };
}

export function ref(): string {
    return base32Lower(randomBytes(10));
}

export function signedOf(answer: ReserveAndSignResponse): Signed {
    if (answer.result.case !== "signed") {
        throw new Error(`expected a signed answer, got ${JSON.stringify(answer.result.case)}`);
    }
    return answer.result.value;
}

const sha256 = (v: string | Buffer): Buffer => createHash("sha256").update(v).digest();

export interface PinTerms {
    method: HttpMethod;
    url: string;
    maxPriceMicros: number;
    payTo: string;
    listed: Listed;
    accepted: unknown;
}

export interface SignOptions {
    ref: string;
    body: string;
    paymentRequired: string;
    method?: HttpMethod;
    url?: string;
}

export interface X402Live {
    settings(over?: Tables): Settings;
    secrets(settings: Settings): Secrets;
    placementOf(accountId: string): string;
    startOrderWithX402(
        svc: RunningService,
        seller: TestSeller,
        maxPriceMicros: number,
    ): Promise<string>;
    startOrderWithPin(svc: RunningService, pin: PinTerms): Promise<string>;
    sign(svc: RunningService, accountId: string, o: SignOptions): Promise<ReserveAndSignResponse>;
    terminate(svc: RunningService, accountId: string): Promise<void>;
    close(): Promise<void>;
}

function hostAndPrefix(url: string): { host: string; prefix: string } {
    const u = new URL(url);
    return { host: u.host, prefix: u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1) };
}

export async function startX402Live(o: {
    dbUrl: string;
    eventSeed: Buffer;
    allowanceWallet: Address;
    testPayer: KeyPairSigner;
    rpcUrl: string;
    paymentsToken: string;
}): Promise<X402Live> {
    const dir = mkdtempSync(join(tmpdir(), "bn-live-x402-"));
    mkdirSync(join(dir, "pki"));
    const pki = makeTestPki(join(dir, "pki"));
    const indexFile = join(dir, "x402-index.json");
    writeFileSync(indexFile, '{"v":1,"services":[]}');
    const placements = new Map<string, string>();
    const placementOf = (accountId: string): string => {
        const id = placements.get(accountId);
        if (id === undefined) throw new Error(`no placement was asked for ${accountId}`);
        return id;
    };
    const router: FakeRouter = await startFakeRouter({
        lookupPlacement: (req) => {
            const startOrderId = req.key.case === "startOrderId" ? req.key.value : "";
            let placementId = placements.get(startOrderId);
            if (placementId === undefined) {
                placementId = randomUUID();
                placements.set(startOrderId, placementId);
            }
            return {
                placementId,
                startOrderId,
                state: "ready",
                x402Capable: true,
                packageId: "live-test",
            };
        },
        appendAllowanceEvent: () => ({}),
        appendX402Resolved: () => ({}),
    });
    const tables = await liveTables(o.dbUrl, o.eventSeed);
    const routerToken = randomBytes(16).toString("hex");
    const http = payClient(o.testPayer, o.rpcUrl);
    const clients = new Map<number, ReturnType<typeof signerClient>>();

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

    const x402Over = (over: Tables): Tables => ({
        ...tables,
        x402: {
            ...tables.x402,
            enabled: true,
            allowance_wallet: o.allowanceWallet,
            listen: "127.0.0.1:0",
            tls_cert_file: pki.serverCert,
            client_ca_file: pki.ca,
            indexed_services_file: indexFile,
            min_allowance_micros: 50_000,
            cold_transfer_threshold_micros: 1,
            cold_transfer_check_every: "5s",
            close_every: "2s",
            ...over.x402,
        },
        router: {
            ...tables.router,
            url: router.url,
            allowance_claim: true,
            ...over.router,
        },
        jobs: { ...tables.jobs, refunds_every: "5s", ...over.jobs },
    });

    async function startOrderWithPin(svc: RunningService, pin: PinTerms): Promise<string> {
        const { host, prefix } = hostAndPrefix(pin.url);
        const created = await postOrder<{ status: string; orderId: string; payUrl: string }>(
            svc,
            o.paymentsToken,
            {
                kind: "start",
                packageId: "live-test",
                amountMicros: 63_000,
                allowanceMicros: 50_000,
                feeMicros: 3_000,
                description: "Bugnet live test x402",
                x402: {
                    services: [
                        {
                            serviceId: serviceIdFor(pin.method, host, prefix),
                            method: pin.method,
                            host,
                            prefix,
                            url: pin.url,
                            maxPriceMicros: pin.maxPriceMicros,
                            payTo: pin.payTo,
                            listed: pin.listed,
                            pinnedFrom: "probe",
                            probe: {
                                at: new Date().toISOString(),
                                status: 402,
                                accepted: pin.accepted,
                            },
                        },
                    ],
                },
            },
        );
        expect(created.status).toBe("payment_required");
        const payload = await http.createPaymentPayload(await challenge(http, created.payUrl));
        const paid = await fetch(created.payUrl, {
            headers: http.encodePaymentSignatureHeader(payload),
        });
        expect(paid.status).toBe(200);
        return created.orderId;
    }

    return {
        settings: (over = {}) => parseSettings(stringify(x402Over(over)), "live-x402"),
        secrets: (settings) =>
            readSecrets(
                {
                    ...process.env,
                    BUGNET_X402_TLS_KEY: Buffer.from(readFileSync(pki.serverKey, "utf8")).toString(
                        "base64",
                    ),
                    BUGNET_PAYMENTS_ROUTER_TOKEN: routerToken,
                },
                settings,
            ),
        placementOf,
        startOrderWithX402: (svc, seller, maxPriceMicros) => {
            const [accepted] = decodedAccepts(seller.paymentRequired());
            return startOrderWithPin(svc, {
                method: "POST",
                url: TEST_SELLER.url,
                maxPriceMicros,
                payTo: accepted!.payTo,
                listed: "unlisted",
                accepted,
            });
        },
        startOrderWithPin,
        async sign(svc, accountId, s) {
            const method = s.method ?? "POST";
            const url = new URL(s.url ?? TEST_SELLER.url);
            const { host, prefix } = hostAndPrefix(url.href);
            const placementId = placementOf(accountId);
            const port = svc.x402Port!;
            let client = clients.get(port);
            if (client === undefined) {
                client = signerClient(port);
                clients.set(port, client);
            }
            return client.reserveAndSign(
                createMessage(ReserveAndSignRequestSchema, {
                    accountId,
                    placementId,
                    ref: s.ref,
                    serviceId: serviceIdFor(method, host, prefix),
                    method,
                    host,
                    path: url.pathname,
                    bodySha256: sha256(s.body),
                    paymentRequired: s.paymentRequired,
                    targetSha256: sha256(
                        Buffer.concat([
                            Buffer.from(placementId),
                            Buffer.from([0]),
                            Buffer.from(`${url.pathname}${url.search}`),
                        ]),
                    ),
                }),
            );
        },
        terminate: (svc, accountId) =>
            postSignedEvent(svc, o.eventSeed, {
                type: "placement.terminated",
                payload: {
                    order_id: accountId,
                    placement_id: placementOf(accountId),
                    refundable: false,
                    reason: "stopped",
                    deadline: null,
                },
            }),
        async close() {
            await router.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
