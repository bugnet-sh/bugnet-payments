import {
    createDefaultRpcTransport,
    createSolanaRpc,
    createSolanaRpcFromTransport,
    isSolanaError,
    mainnet,
    type RpcMainnet,
    type RpcTransportMainnet,
    type SolanaRpcApiMainnet,
} from "@solana/kit";
import { RpcRouterError } from "./router/errors.ts";
import {
    createRouterTransport,
    type RouterDeps,
    type RouterTransport,
    type RpcSettings,
} from "./router/index.ts";

export type SolanaRpc = RpcMainnet<SolanaRpcApiMainnet>;

export function createRpc(url: string): SolanaRpc {
    return createSolanaRpc(mainnet(url));
}

export interface RoutedRpc {
    // The money lane: payments, refunds, transfers, the mirror, boot and the CLI
    rpc: SolanaRpc;
    // The background lane: alarms and audits, held to its share of each endpoint
    backgroundRpc: SolanaRpc;
    router: RouterTransport;
}

export function createRouterRpc(
    settings: RpcSettings,
    urls: readonly string[],
    deps: Omit<RouterDeps, "transportFor"> & Partial<Pick<RouterDeps, "transportFor">>,
): RoutedRpc {
    const router = createRouterTransport(settings, urls, {
        ...deps,
        transportFor:
            deps.transportFor ?? ((_name, url) => createDefaultRpcTransport({ url: mainnet(url) })),
    });
    return {
        rpc: createSolanaRpcFromTransport(router as unknown as RpcTransportMainnet),
        backgroundRpc: createSolanaRpcFromTransport(
            router.background as unknown as RpcTransportMainnet,
        ),
        router,
    };
}

// A fresh signal per call, so a stalled RPC fails like an unavailable one
export function deadline(timeoutMs: number): { abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(timeoutMs) };
}

export interface RpcErrorFields {
    err: string;
    code?: number;
    status?: number;
    reason?: string;
    cause?: string;
}

// Only the numeric code and HTTP status, a router error's reason and a failed fetch's system code:
// an error's message or cause can carry the RPC URL's key, and a router error's partial is answers
export function rpcErrorFields(err: unknown): RpcErrorFields {
    if (err instanceof RpcRouterError) return { err: err.name, reason: err.reason };
    if (!isSolanaError(err)) {
        if (!(err instanceof Error)) return { err: "error" };
        const code = err instanceof TypeError ? systemCodeOf(err.cause) : null;
        return { err: err.name, ...(code === null ? {} : { cause: code }) };
    }
    const status = (err.context as { statusCode?: unknown }).statusCode;
    return {
        err: err.name,
        code: err.context.__code,
        ...(typeof status === "number" ? { status } : {}),
    };
}

// Node's fetch fails with a TypeError whose cause carries a code such as ECONNREFUSED; anything
// that is not shaped like one could be free text
function systemCodeOf(cause: unknown): string | null {
    if (typeof cause !== "object" || cause === null) return null;
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
}
