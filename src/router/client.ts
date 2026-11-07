import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { PayerVerdict, PaymentsService } from "../gen/bugnet/router/v1/payments_pb.ts";
import type { Log } from "../log.ts";
import type { OrderKind } from "../orders/types.ts";
import { SOLANA_MAINNET, USDC_MINT } from "../solana/constants.ts";

export type PayerCheck =
    | { verdict: "ok" }
    | { verdict: "skipped" }
    | { verdict: "blocked"; blockedUntil?: string }
    | { verdict: "busy"; retryAfterSeconds: number }
    | { verdict: "rate_limited"; retryAfterSeconds: number }
    | { verdict: "invalid" }
    | { verdict: "unavailable" };

export type RouterOrder =
    | {
          kind: "found";
          orderKind: string;
          placementState: string;
          refundable: boolean;
          failureReason: string;
          terminationReason: string;
          endedAt?: Date;
      }
    | { kind: "absent" }
    | { kind: "disabled" }
    | { kind: "unavailable" };

export type PlacementState = "placing" | "ready" | "terminating" | "terminated" | "failed";

export type PlacementLookup =
    | {
          kind: "found";
          placementId: string;
          startOrderId: string;
          state: PlacementState;
          deadline: Date | null;
          endedAt: Date | null;
          x402Capable: boolean;
          packageId: string;
      }
    | { kind: "unknown" }
    | { kind: "unavailable" };

export type LookupKey = { handleSha256: string } | { startOrderId: string };

export interface AllowanceEventInput {
    orderId: string;
    startOrderId: string;
    phase: "paid" | "refunded" | "kept";
    amountMicros: number;
    keptMicros: number;
    tx: string;
}

export interface X402ResolvedInput {
    startOrderId: string;
    ref: string;
    status: "paid" | "released";
    amountMicros: number;
    tx: string;
    at: Date;
    host: string;
    method: string;
    path: string;
    payTo: string;
}

export type AppendResult = "ok" | "order_unknown" | "invalid" | "retry";

const PLACEMENT_STATES: readonly string[] = [
    "placing",
    "ready",
    "terminating",
    "terminated",
    "failed",
];

export interface RouterClient {
    checkPayer(
        r: { payer: string; feePayer: string; packageId: string; kind: OrderKind },
        signal: AbortSignal,
    ): Promise<PayerCheck>;
    getOrder(orderId: string, signal?: AbortSignal): Promise<RouterOrder>;
    lookupPlacement(key: LookupKey, signal?: AbortSignal): Promise<PlacementLookup>;
    appendAllowanceEvent(e: AllowanceEventInput, signal?: AbortSignal): Promise<AppendResult>;
    appendX402Resolved(e: X402ResolvedInput, signal?: AbortSignal): Promise<AppendResult>;
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

    function appendResult(err: unknown, call: string): AppendResult {
        const ce = ConnectError.from(err);
        if (ce.code === Code.NotFound) return "order_unknown";
        if (ce.code === Code.InvalidArgument) return "invalid";
        o.log.warn(`router ${call} failed`, { code: Code[ce.code] });
        return "retry";
    }

    let warnedUnimplemented = false;
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
                    failureReason: res.failureReason,
                    terminationReason: res.terminationReason,
                    ...(res.endedAt ? { endedAt: timestampDate(res.endedAt) } : {}),
                };
            } catch (err) {
                const ce = ConnectError.from(err);
                if (ce.code === Code.Unimplemented) {
                    if (!warnedUnimplemented) {
                        warnedUnimplemented = true;
                        o.log.warn("router does not serve GetOrder", { code: Code[ce.code] });
                    }
                    return { kind: "disabled" };
                }
                o.log.warn("router get_order failed", { code: Code[ce.code], error: ce.message });
                return { kind: "unavailable" };
            }
        },

        async lookupPlacement(key, signal) {
            try {
                const res = await client.lookupPlacement(
                    {
                        key:
                            "handleSha256" in key
                                ? { case: "handleSha256", value: key.handleSha256 }
                                : { case: "startOrderId", value: key.startOrderId },
                    },
                    { signal },
                );
                if (!PLACEMENT_STATES.includes(res.state)) {
                    o.log.warn("router lookup_placement returned an unknown state", {
                        state: res.state,
                    });
                    return { kind: "unavailable" };
                }
                return {
                    kind: "found",
                    placementId: res.placementId,
                    startOrderId: res.startOrderId,
                    state: res.state as PlacementState,
                    deadline: res.deadline ? timestampDate(res.deadline) : null,
                    endedAt: res.endedAt ? timestampDate(res.endedAt) : null,
                    x402Capable: res.x402Capable,
                    packageId: res.packageId,
                };
            } catch (err) {
                const ce = ConnectError.from(err);
                if (ce.code === Code.NotFound) return { kind: "unknown" };
                o.log.warn("router lookup_placement failed", { code: Code[ce.code] });
                return { kind: "unavailable" };
            }
        },

        async appendAllowanceEvent(e, signal) {
            try {
                await client.appendAllowanceEvent(
                    {
                        orderId: e.orderId,
                        startOrderId: e.startOrderId,
                        event: {
                            phase: e.phase,
                            amountMicros: BigInt(e.amountMicros),
                            asset: USDC_MINT,
                            network: SOLANA_MAINNET,
                            tx: e.tx,
                            keptMicros: BigInt(e.keptMicros),
                        },
                    },
                    { signal },
                );
                return "ok";
            } catch (err) {
                return appendResult(err, "append_allowance_event");
            }
        },

        async appendX402Resolved(e, signal) {
            try {
                await client.appendX402Resolved(
                    {
                        startOrderId: e.startOrderId,
                        ref: e.ref,
                        status: e.status,
                        amountMicros: BigInt(e.amountMicros),
                        tx: e.tx,
                        at: timestampFromDate(e.at),
                        host: e.host,
                        method: e.method,
                        path: e.path,
                        payTo: e.payTo,
                    },
                    { signal },
                );
                return "ok";
            } catch (err) {
                return appendResult(err, "append_x402_resolved");
            }
        },
    };
}
