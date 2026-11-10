import {
    createSolanaRpc,
    isSolanaError,
    mainnet,
    type RpcMainnet,
    type SolanaRpcApiMainnet,
} from "@solana/kit";
import { RpcRouterError } from "./router/errors.ts";

export type SolanaRpc = RpcMainnet<SolanaRpcApiMainnet>;

export function createRpc(url: string): SolanaRpc {
    return createSolanaRpc(mainnet(url));
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
