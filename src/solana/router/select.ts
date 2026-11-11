/**
 * Which endpoints may take a request, and in what order (spec 6.1, 6.2). The list order is the
 * priority: latency, errors and load only make an endpoint ineligible, they never reorder it.
 */
import type { Breaker, Lane } from "./health.ts";
import type { RouterRequest } from "./payload.ts";
import type { Role } from "./settings.ts";

// A node below a pin catches up in a few slots, so after this it is worth asking again
export const BEHIND_PIN_MS = 5_000;

export interface EndpointView {
    readonly name: string;
    // read and send always; history only while its last check passed
    readonly roles: ReadonlySet<Role>;
    // The genesis check passed
    readonly checked: boolean;
    readonly consistent: boolean;
    readonly pinnedSignatures: boolean;
    readonly breaker: Breaker;
    readonly openUntil: number;
    readonly lastProbeGood: boolean;
    readonly inflight: number;
    readonly lagging: boolean;
    // This request's method or the whole endpoint, whichever ends later; 0 when nothing cools
    readonly coolingUntil: number;
    // Under its learned limits for this request's method and lane
    readonly room: boolean;
    readonly rateLimited: boolean;
    readonly backgroundOut: boolean;
    // The pin of the endpoint's last -32016
    readonly behindPin: { slot: bigint; at: number } | null;
    readonly methodsOff: ReadonlySet<string>;
}

export function roleOf(req: RouterRequest): Role {
    if (req.spec.kind === "send") return "send";
    return req.needsHistory ? "history" : "read";
}

// breaker: only the breaker or probation excludes it, which may be relaxed. busy: only room or
// a cooldown excludes it, and neither is ever relaxed. out: anything else excludes it
type Fit = "ok" | "out" | "breaker" | "busy";

function fitOf(req: RouterRequest, v: EndpointView, o: { now: number; lane: Lane }): Fit {
    const listing = req.method === "getSignaturesForAddress";
    if (
        !v.roles.has(roleOf(req)) ||
        !v.checked ||
        v.methodsOff.has(req.method) ||
        v.lagging ||
        (listing && !v.consistent) ||
        // That answer has no context slot, so only the pinned-signatures check proves the pin
        (listing && req.minContextSlot !== null && !v.pinnedSignatures) ||
        (o.lane === "background" && (v.rateLimited || v.backgroundOut))
    ) {
        return "out";
    }
    const busy = v.coolingUntil > o.now || !v.room;
    if (v.breaker !== "closed") return busy ? "out" : "breaker";
    return busy ? "busy" : "ok";
}

function behind(req: RouterRequest, v: EndpointView, now: number): boolean {
    const pin = v.behindPin;
    return (
        pin !== null &&
        req.minContextSlot !== null &&
        req.minContextSlot >= pin.slot &&
        now - pin.at <= BEHIND_PIN_MS
    );
}

function ordered(req: RouterRequest, views: EndpointView[], now: number): EndpointView[] {
    const preferred = req.spec.history === "preferred";
    const rank = (v: EndpointView) =>
        (behind(req, v, now) ? 2 : 0) + (preferred && !v.roles.has("history") ? 1 : 0);
    return views.toSorted((a, b) => rank(a) - rank(b));
}

// One request in flight each, so a dead endpoint costs at most one attempt per endpoint
function relaxed(views: EndpointView[]): EndpointView[] {
    const idle = views.filter((v) => v.inflight === 0);
    const good = idle.filter((v) => v.breaker === "probation" && v.lastProbeGood);
    const rest = idle
        .filter((v) => !good.includes(v))
        .toSorted((a, b) => a.openUntil - b.openUntil);
    return [...good, ...rest];
}

export function choose(
    req: RouterRequest,
    views: readonly EndpointView[],
    o: { now: number; lane: Lane },
): EndpointView[] {
    if (req.spec.kind === "send" && o.lane === "background") return [];
    const eligible: EndpointView[] = [];
    const relaxable: EndpointView[] = [];
    for (const v of views) {
        const fit = fitOf(req, v, o);
        if (fit === "ok") eligible.push(v);
        else if (fit === "breaker") relaxable.push(v);
        // A background read waits for a busy endpoint, so it never spends a later URL's rate
        // that money calls and the second quorum voter need (D-R12)
        else if (fit === "busy" && o.lane === "background") return ordered(req, eligible, o.now);
    }
    return eligible.length > 0 ? ordered(req, eligible, o.now) : relaxed(relaxable);
}
