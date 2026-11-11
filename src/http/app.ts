import type { KeyPairSigner } from "@solana/kit";
import type pg from "pg";
import type { Secrets, Settings } from "../config.ts";
import { eventPublicKey, handleEvent } from "../events/handler.ts";
import type { Log } from "../log.ts";
import { createPayDeps, payOrder } from "../orders/pay.ts";
import { orderKey } from "../orders/token.ts";
import { RateLimiter } from "../ratelimit.ts";
import { createRouterClient, type RouterClient } from "../router/client.ts";
import { BlockhashCache } from "../solana/blockhash.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { parseIndex, type IndexCopy } from "../x402/index-file.ts";
import { bugnetAddresses } from "../x402/ids.ts";
import type { BugnetAddresses, SignerHealth } from "../x402/types.ts";
import { type AllowanceFunding, createAllowanceFunding } from "../x402/funding.ts";
import { createSettler } from "../x402/settler.ts";
import { createInternalHandler } from "./internal.ts";
import { createPublicHandler } from "./public.ts";
import type { Handler } from "./server.ts";

export interface HttpX402Parts {
    index: () => IndexCopy;
    signer: SignerHealth;
    addresses: BugnetAddresses;
    // Shared with the jobs; built here when absent
    funding?: AllowanceFunding;
}

export interface HttpAppDeps {
    settings: Settings;
    secrets: Secrets;
    pool: pg.Pool;
    rpc: SolanaRpc;
    feePayer: KeyPairSigner;
    x402?: HttpX402Parts;
    log: Log;
    now: () => Date;
}

export interface HttpAppOptions {
    // Without one the rate limiters count on their own monotonic clock
    limiterClock?: () => number;
    checkoutJsPath?: string;
}

export interface HttpApp {
    router: RouterClient;
    internalHandler: Handler;
    publicHandler: Handler;
}

const MINUTE_MS = 60_000;
const CHECKOUT_JS = "dist/checkout.js";

export function createHttpApp(d: HttpAppDeps, o: HttpAppOptions = {}): HttpApp {
    const { settings: s, secrets, pool, rpc, feePayer, log, now } = d;
    const emptyIndex = parseIndex('{"v":1,"services":[]}', "none");
    const x402: HttpX402Parts = d.x402 ?? {
        signer: { open: () => false },
        index: () => emptyIndex,
        addresses: bugnetAddresses({
            feePayer: feePayer.address,
            allowanceWallet: s.x402.allowance_wallet,
            refundWallet: "",
            recipient: s.solana.recipient,
        }),
    };
    const perMinute = (limit: number) => new RateLimiter(limit, MINUTE_MS, o.limiterClock);
    const hints = new BlockhashCache(rpc, s.solana.blockhash_cache_ttl, () => now().getTime());
    const settler = createSettler({
        feePayer,
        rpc,
        hints,
        caps: {
            maxComputeUnits: s.solana.max_compute_units,
            maxPriorityFeeMicroLamports: s.solana.max_priority_fee_micro_lamports,
            maxRequiredSignatures: s.solana.max_required_signatures,
        },
        transactionVersions: s.solana.transaction_versions,
        rpcTimeoutMs: s.solana.rpc_timeout,
        log,
    });
    const router = createRouterClient({
        url: s.router.url,
        token: secrets.routerToken,
        timeoutMs: s.router.timeout,
        checkPayer: s.router.check_payer,
        getOrder: s.router.get_order,
        log,
    });
    const challenge = {
        publicUrl: s.http.public_url,
        recipient: s.solana.recipient,
        allowanceWallet: s.x402.allowance_wallet,
        feePayer: feePayer.address,
        transactionVersions: s.solana.transaction_versions,
    };
    const allowanceFunding = x402.funding ?? createAllowanceFunding({ x402: s.x402, log });
    const pay = createPayDeps({
        pool,
        settler,
        router,
        attempts: perMinute(s.orders.attempts_per_order_per_minute),
        challenge,
        x402: {
            x402: s.x402,
            signer: x402.signer,
            paid: { funding: allowanceFunding, x402: s.x402, log },
        },
        log,
        now,
    });
    const funding = s.x402.allowance_wallet === "" ? null : allowanceFunding;
    const eventKey =
        s.router.event_public_key === "" ? null : eventPublicKey(s.router.event_public_key);
    const internalHandler = createInternalHandler({
        service: {
            pool,
            settings: s,
            challenge,
            hints,
            orderKey: orderKey(secrets.orderSeed),
            claimKey: secrets.claimKey,
            pay: (orderId, raw, signal, key, via) => payOrder(pay, orderId, raw, signal, key, via),
            x402: {
                x402: s.x402,
                allowanceClaim: s.router.allowance_claim,
                router,
                rpc,
                index: x402.index,
                signer: x402.signer,
                addresses: x402.addresses,
                rpcTimeoutMs: s.solana.rpc_timeout,
                log,
                now,
            },
            log,
            now,
        },
        token: secrets.paymentsToken,
        routerToken: secrets.routerToken,
        events: (raw, headers) =>
            handleEvent({ pool, key: eventKey, log, now, funding, x402: s.x402 }, raw, headers),
        maxBodyBytes: s.http.max_body_bytes,
        log,
    });
    const publicHandler = createPublicHandler({
        pool,
        challenge,
        hints,
        pay,
        perIp: perMinute(s.limits.public_per_ip_per_minute),
        statusPerIp: perMinute(s.limits.status_per_ip_per_minute),
        trustedProxies: s.http.trusted_proxies,
        maxBodyBytes: s.http.max_body_bytes,
        checkoutJsPath: o.checkoutJsPath ?? CHECKOUT_JS,
        deposits: s.deposits,
        log,
        now,
    });
    return { router, internalHandler, publicHandler };
}
