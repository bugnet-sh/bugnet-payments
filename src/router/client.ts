import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { PayerVerdict, PaymentsService } from "../gen/bugnet/router/v1/payments_pb.ts";
import type { Log } from "../log.ts";
import type { OrderKind } from "../orders/types.ts";

export type PayerCheck =
    | { verdict: "ok" }
    | { verdict: "skipped" }
    | { verdict: "blocked"; blockedUntil?: string }
    | { verdict: "busy"; retryAfterSeconds: number }
    | { verdict: "rate_limited"; retryAfterSeconds: number }
    | { verdict: "invalid" }
    | { verdict: "unavailable" };

export type RouterOrder =
    | { kind: "found"; orderKind: string; placementState: string; refundable: boolean }
    | { kind: "absent" }
    | { kind: "disabled" }
    | { kind: "unavailable" };

export interface RouterClient {
    checkPayer(
        r: { payer: string; feePayer: string; packageId: string; kind: OrderKind },
        signal: AbortSignal,
    ): Promise<PayerCheck>;
    getOrder(orderId: string, signal: AbortSignal): Promise<RouterOrder>;
}

export interface RouterClientOptions {
    url: string;
    token: string;
    timeoutMs: number;
    checkPayer: boolean;
    getOrder: boolean;
    log: Log;
}

const DEFAULT_RETRY_AFTER_SECONDS = 30;

export function createRouterClient(o: RouterClientOptions): RouterClient {
    const auth: Interceptor = (next) => (req) => {
        req.header.set("Authorization", `Bearer ${o.token}`);
        return next(req);
    };
    const client = createClient(
        PaymentsService,
        createConnectTransport({
            baseUrl: o.url,
            httpVersion: "2",
            defaultTimeoutMs: o.timeoutMs,
            interceptors: [auth],
        }),
    );

    return {
        async checkPayer(r, signal) {
            if (!o.checkPayer) return { verdict: "skipped" };
            try {
                const res = await client.checkPayer(r, { signal });
                const retryAfterSeconds = res.retryAfter
                    ? Number(res.retryAfter.seconds)
                    : DEFAULT_RETRY_AFTER_SECONDS;
                switch (res.verdict) {
                    case PayerVerdict.OK:
                        return { verdict: "ok" };
                    case PayerVerdict.BLOCKED:
                        return res.blockedUntil
                            ? {
                                  verdict: "blocked",
                                  blockedUntil: new Date(
                                      Number(res.blockedUntil.seconds) * 1000 +
                                          Math.floor(res.blockedUntil.nanos / 1e6),
                                  ).toISOString(),
                              }
                            : { verdict: "blocked" };
                    case PayerVerdict.BUSY:
                        return { verdict: "busy", retryAfterSeconds };
                    case PayerVerdict.RATE_LIMITED:
                        return { verdict: "rate_limited", retryAfterSeconds };
                    default:
                        o.log.warn("router check_payer returned no verdict");
                        return { verdict: "unavailable" };
                }
            } catch (err) {
                if (ConnectError.from(err).code === Code.InvalidArgument) {
                    return { verdict: "invalid" };
                }
                o.log.warn("router check_payer failed", { error: ConnectError.from(err).message });
                return { verdict: "unavailable" };
            }
        },

        async getOrder(orderId, signal) {
            if (!o.getOrder) return { kind: "disabled" };
            try {
                const res = await client.getOrder({ orderId }, { signal });
                if (!res.redeemed) return { kind: "absent" };
                return {
                    kind: "found",
                    orderKind: res.kind,
                    placementState: res.placementState,
                    refundable: res.refundable,
                };
            } catch (err) {
                o.log.warn("router get_order failed", { error: ConnectError.from(err).message });
                return { kind: "unavailable" };
            }
        },
    };
}
