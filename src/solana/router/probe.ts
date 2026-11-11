/**
 * The checks of spec 9, the same for every endpoint: its network, its slot, its node identity,
 * whether it honours minContextSlot, and whether it holds Payments' history. One endpoint's calls
 * go one after another, and a call that times out or fails on the network ends its run, so a
 * stalled endpoint costs one timeout, not one per call.
 */
import {
    isSolanaError,
    type RpcTransport,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { bigintOf, isObject, rpcErrorOf } from "./payload.ts";

export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// The first transaction of mainnet slot 70,000,000 (2021-03-20, finalized), a chain fact: the
// history check before Payments has a cold payment of its own
export const MAINNET_HISTORY_PROBE: { readonly signature: string; readonly slot: bigint } = {
    signature:
        "47hfaM921ZatWFkyjeEK1vECZX3mQPacw8XV5nHYrLtxKTiKo6azbqMMuj6RnMup2tsL3CS62u1B3nDx7qSsEEif",
    slot: 70_000_000n,
};
// Catches a load balancer with a large history-less share most of the time, and stays within
// the tight per-method limits some endpoints keep for history methods
export const CHECK_REPEATS = 3;
// The CLI waits this long for a whole run at most; a check still running then is an error
export const CHECK_TOTAL_MS = 20_000;

// Far past any node's slot, so an endpoint that honours the pin can only refuse it
const PIN_AHEAD = 1_000_000n;
const FULL_PAGE = 1_000;
const NOT_REACHED = -32016;
// Transaction history is not available from this node
const NO_HISTORY = -32011;

// Payments' own history (spec 9): its oldest confirmed cold payment and a later one
export interface HistoryProbe {
    // The recipient's USDC account, which every cold payment credits
    address: string;
    oldest: string;
    // Confirmed a minute or more after oldest, for the address index; null until there is one
    later: string | null;
}

export type CheckPart =
    "genesis" | "slot" | "identity" | "pinnedAccounts" | "pinnedSignatures" | "history";

// In run order
export const CHECK_PARTS: readonly CheckPart[] = [
    "genesis",
    "slot",
    "identity",
    "pinnedAccounts",
    "pinnedSignatures",
    "history",
];

export interface EndpointCheck {
    name: string;
    // unchecked: not part of this run
    genesis: "ok" | "wrong" | "error" | "unchecked";
    // What failed: http_<status>, timeout, network, code_<code>, ...
    genesisError: string | null;
    pinnedAccounts: "ok" | "ignored" | "error" | "unchecked";
    pinnedSignatures: "ok" | "ignored" | "error" | "unchecked";
    history: "ok" | "missing" | "error" | "unchecked";
    // null unless every history repeat answered
    repeatsAgree: boolean | null;
    // getIdentity's answer, or null on an error
    identity: string | null;
    slot: bigint | null;
    latencyMs: number | null;
}

export interface CheckReport {
    endpoints: EndpointCheck[];
}

export interface CheckOptions {
    timeoutMs: number;
    now: () => number;
    genesisOnly: boolean;
    // Every part when left out
    parts?: ReadonlySet<CheckPart>;
    // The slot the pinned checks ask past when the run reads none of its own
    slot?: bigint | null;
    // Ends the run: every call still to come is an error
    signal?: AbortSignal;
    // Once the genesis and slot reads are done, with the results so far
    onBoot?: (c: EndpointCheck) => void;
}

type Asked =
    | { readonly kind: "answer"; readonly answer: unknown; readonly ms: number }
    | { readonly kind: "failed"; readonly label: string; readonly ends: boolean };

// found and absent are answers; absent is null or -32011, which the checks read alike
type Seen = "found" | "absent" | "error" | "end";

let nextId = 0;

function failure(err: unknown, timedOut: boolean): string {
    if (timedOut) return "timeout";
    if (isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
        return `http_${err.context.statusCode}`;
    }
    return err instanceof TypeError ? "network" : "error";
}

function asker(transport: RpcTransport, o: CheckOptions) {
    return async (method: string, params: unknown[]): Promise<Asked> => {
        if (o.signal?.aborted) return { kind: "failed", label: "timeout", ends: true };
        const timer = AbortSignal.timeout(o.timeoutMs);
        const signal = o.signal === undefined ? timer : AbortSignal.any([o.signal, timer]);
        const started = o.now();
        const payload = { jsonrpc: "2.0", id: String(nextId++), method, params };
        try {
            const answer = await transport({ payload, signal });
            return { kind: "answer", answer, ms: o.now() - started };
        } catch (err) {
            // The run's own end counts as a timeout: the endpoint did not answer in time
            const timedOut = signal.aborted;
            return {
                kind: "failed",
                label: failure(err, timedOut),
                ends: timedOut || err instanceof TypeError,
            };
        }
    };
}

function resultOf(answer: unknown): { found: true; value: unknown } | { found: false } {
    return isObject(answer) && "result" in answer && rpcErrorOf(answer) === null
        ? { found: true, value: answer.result }
        : { found: false };
}

function codeLabel(code: number): string {
    return Number.isInteger(code) ? `code_${code}` : "code_invalid";
}

function seenOf(a: Asked, read: (result: unknown) => Seen): Seen {
    if (a.kind === "failed") return a.ends ? "end" : "error";
    const error = rpcErrorOf(a.answer);
    if (error !== null) return error.code === NO_HISTORY ? "absent" : "error";
    const r = resultOf(a.answer);
    return r.found ? read(r.value) : "error";
}

function mixed(seen: readonly Seen[]): boolean {
    return seen.includes("found") && seen.includes("absent");
}

export async function checkEndpoint(
    transport: RpcTransport,
    name: string,
    probe: HistoryProbe | null,
    o: CheckOptions,
): Promise<EndpointCheck> {
    const parts: ReadonlySet<CheckPart> = o.genesisOnly
        ? new Set(["genesis"])
        : (o.parts ?? new Set(CHECK_PARTS));
    const c: EndpointCheck = {
        name,
        genesis: "unchecked",
        genesisError: null,
        pinnedAccounts: "unchecked",
        pinnedSignatures: "unchecked",
        history: "unchecked",
        repeatsAgree: null,
        identity: null,
        slot: null,
        latencyMs: null,
    };
    const ask = asker(transport, o);
    const end = (): EndpointCheck => {
        for (const part of ["pinnedAccounts", "pinnedSignatures", "history"] as const) {
            if (parts.has(part) && c[part] === "unchecked") c[part] = "error";
        }
        return c;
    };

    if (parts.has("genesis")) {
        const a = await ask("getGenesisHash", []);
        if (a.kind === "failed") {
            c.genesis = "error";
            c.genesisError = a.label;
            return end();
        }
        const error = rpcErrorOf(a.answer);
        const r = resultOf(a.answer);
        if (!r.found || typeof r.value !== "string") {
            c.genesis = "error";
            c.genesisError = error === null ? "invalid" : codeLabel(error.code);
            return end();
        }
        // The rest says nothing about an endpoint on another network
        if (r.value !== MAINNET_GENESIS) {
            c.genesis = "wrong";
            return c;
        }
        c.genesis = "ok";
    }

    let slot = o.slot ?? null;
    if (parts.has("slot")) {
        const a = await ask("getEpochInfo", [{ commitment: "confirmed" }]);
        if (a.kind === "failed" && a.ends) return end();
        const r = a.kind === "answer" ? resultOf(a.answer) : null;
        const read = r?.found === true && isObject(r.value) ? bigintOf(r.value.absoluteSlot) : null;
        if (read !== null && a.kind === "answer") {
            c.slot = read;
            c.latencyMs = a.ms;
            slot = read;
        }
    }
    o.onBoot?.({ ...c });

    if (parts.has("identity")) {
        const a = await ask("getIdentity", []);
        if (a.kind === "failed" && a.ends) return end();
        const r = a.kind === "answer" ? resultOf(a.answer) : null;
        // An error or an odd answer says nothing, and is left out
        if (r?.found === true && isObject(r.value) && typeof r.value.identity === "string") {
            c.identity = r.value.identity;
        }
    }

    const pinned = async (method: string, options: Record<string, unknown>) => {
        if (slot === null) return "error";
        const minContextSlot = slot + PIN_AHEAD;
        const results: string[] = [];
        // A missing commitment is finalized, as kit sends it
        for (const commitment of [{}, { commitment: "confirmed" }]) {
            const params = [USDC_MINT_ADDRESS, { ...options, ...commitment, minContextSlot }];
            const a = await ask(method, params);
            if (a.kind === "failed") {
                if (a.ends) return "end";
                results.push("error");
                continue;
            }
            const error = rpcErrorOf(a.answer);
            if (error === null) results.push(resultOf(a.answer).found ? "ignored" : "error");
            else results.push(error.code === NOT_REACHED ? "ok" : "error");
        }
        if (results.includes("ignored")) return "ignored";
        return results.includes("error") ? "error" : "ok";
    };
    if (parts.has("pinnedAccounts")) {
        const result = await pinned("getAccountInfo", { encoding: "jsonParsed" });
        if (result === "end") return end();
        c.pinnedAccounts = result;
    }
    if (parts.has("pinnedSignatures")) {
        const result = await pinned("getSignaturesForAddress", { limit: 1 });
        if (result === "end") return end();
        c.pinnedSignatures = result;
    }

    if (!parts.has("history")) return c;
    const signature = probe?.oldest ?? MAINNET_HISTORY_PROBE.signature;
    const calls: { ask: () => Promise<Asked>; read: (result: unknown) => Seen }[] = [];
    for (let i = 0; i < CHECK_REPEATS; i++) {
        calls.push({
            ask: () =>
                ask("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]),
            read: (r) => {
                if (!isObject(r) || !Array.isArray(r.value) || r.value.length !== 1) return "error";
                return r.value[0] === null ? "absent" : isObject(r.value[0]) ? "found" : "error";
            },
        });
    }
    for (let i = 0; i < CHECK_REPEATS; i++) {
        calls.push({
            ask: () =>
                ask("getTransaction", [
                    signature,
                    {
                        encoding: "base64",
                        commitment: "confirmed",
                        maxSupportedTransactionVersion: 0,
                    },
                ]),
            read: (r) => (r === null ? "absent" : isObject(r) ? "found" : "error"),
        });
    }
    if (probe !== null && probe.later !== null) {
        const { address, later, oldest } = probe;
        calls.push({
            ask: () =>
                ask("getSignaturesForAddress", [
                    address,
                    { commitment: "confirmed", before: later, limit: FULL_PAGE },
                ]),
            // A full page without it is inconclusive, and passes
            read: (r) => {
                if (!Array.isArray(r)) return "error";
                const page: unknown[] = r;
                if (page.some((e) => isObject(e) && e.signature === oldest)) return "found";
                return page.length >= FULL_PAGE ? "found" : "absent";
            },
        });
    }
    const seen: Seen[] = [];
    for (const call of calls) {
        const s = seenOf(await call.ask(), call.read);
        if (s === "end") return end();
        // A repeat that did not answer decides nothing, so the rest would only spend calls
        if (s === "error") {
            c.history = "error";
            return c;
        }
        seen.push(s);
    }
    const statuses = seen.slice(0, CHECK_REPEATS);
    const transactions = seen.slice(CHECK_REPEATS, 2 * CHECK_REPEATS);
    const page = seen[2 * CHECK_REPEATS];
    c.repeatsAgree = !mixed(statuses) && !mixed(transactions);
    const none = (set: readonly Seen[]) => set.every((s) => s === "absent");
    c.history = none(statuses) || none(transactions) || page === "absent" ? "missing" : "ok";
    return c;
}
