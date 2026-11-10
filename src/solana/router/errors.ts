export type RouterErrorReason =
    | "no_endpoint"
    | "stale"
    | "absence_unconfirmed"
    | "status_conflict"
    | "cursor_unverified"
    | "send_unconfirmed"
    | "wrong_network";

// The message holds the reason and a position name only, never a URL or an endpoint's own words
export class RpcRouterError extends Error {
    override readonly name = "RpcRouterError";

    constructor(
        readonly reason: RouterErrorReason,
        readonly endpoint?: string,
        // absence_unconfirmed only: the merged answers of the endpoints that did answer
        readonly partial?: unknown,
    ) {
        super(
            endpoint === undefined
                ? `rpc router: ${reason}`
                : `rpc router: ${reason} on ${endpoint}`,
        );
    }
}
