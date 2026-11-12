/**
 * Coverage of the price by a deposit's on-time open money (spec 9, rule 11), shared by the live
 * status view and the planner.
 *
 * One owner who reaches the price alone always settles alone, so a stranger's transfer can never
 * stop or share a full payment. Several owners share only when none reaches it alone, and an
 * owner below refund_min_micros never takes part in any mode.
 */
import type { Settings } from "../config.ts";
import type { OwnerHoldReason, TransferRow } from "./types.ts";

export interface Coverage {
    mode: "single" | "shared" | "short";
    // single and shared: applied plus the crossing rest; short: the owners that would be taken
    countedMicros: number;
    largestMicros: number;
    largestOwner: string | null;
    // short: every owner but the largest; single and shared: every owner outside the coverage
    otherMicros: number;
    applied: ReadonlyMap<string, number>;
    extra: ReadonlyMap<string, number>;
    notApplied: readonly string[];
    // shared or short only: transfers of owners whose on-time sum is below refund_min_micros
    dust: readonly string[];
    owners: readonly { owner: string; sourceTokenAccount: string; appliedMicros: number }[];
    crossing: TransferRow | null;
    // short only: the coverage would reach the price with a held owner or the shared mode
    heldCovers: OwnerHoldReason | null;
}

export interface Held {
    owners: ReadonlyMap<string, OwnerHoldReason>;
    shared: boolean;
}

type CoverageCfg = Pick<Settings["deposits"], "refund_min_micros" | "max_split_owners">;
type Owned = TransferRow & { sourceOwner: string; sourceTokenAccount: string };

interface Take {
    reached: boolean;
    crossing: Owned | null;
    applied: Map<string, number>;
    extra: Map<string, number>;
    // owners whose transfers the walk took, in the order of their first transfer
    taken: string[];
    countedMicros: number;
}

export function chainOrder(
    a: Pick<TransferRow, "slot" | "seq">,
    b: Pick<TransferRow, "slot" | "seq">,
): number {
    if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
    return a.seq - b.seq;
}

function owned(t: TransferRow): t is Owned {
    return t.sourceOwner !== null && t.sourceTokenAccount !== null;
}

// A transfer counts only with what a written-off debit left of it (spec 23.1)
const unlost = (t: TransferRow): TransferRow =>
    t.lostMicros === 0 ? t : { ...t, amountMicros: t.amountMicros - t.lostMicros };

// Per-owner sums in the order of each owner's first transfer
function totals(transfers: readonly Owned[]): Map<string, number> {
    const sums = new Map<string, number>();
    for (const t of transfers) {
        sums.set(t.sourceOwner, (sums.get(t.sourceOwner) ?? 0) + t.amountMicros);
    }
    return sums;
}

// Applies the transfers of the taken owners in chain order until the price is covered
function walk(price: number, transfers: readonly Owned[], take: (owner: string) => boolean): Take {
    const applied = new Map<string, number>();
    const extra = new Map<string, number>();
    const taken: string[] = [];
    let sum = 0;
    for (const t of transfers) {
        if (!take(t.sourceOwner)) continue;
        if (!taken.includes(t.sourceOwner)) taken.push(t.sourceOwner);
        const before = sum;
        sum += t.amountMicros;
        if (sum < price) {
            applied.set(t.signature, t.amountMicros);
            continue;
        }
        applied.set(t.signature, price - before);
        if (sum > price) extra.set(t.signature, sum - price);
        return { reached: true, crossing: t, applied, extra, taken, countedMicros: sum };
    }
    return { reached: false, crossing: null, applied, extra, taken, countedMicros: sum };
}

// The first transfer that brings its own owner's sum to the price settles with that owner alone
function single(price: number, transfers: readonly Owned[], skip: (owner: string) => boolean) {
    const sums = new Map<string, number>();
    for (const t of transfers) {
        if (skip(t.sourceOwner)) continue;
        const sum = (sums.get(t.sourceOwner) ?? 0) + t.amountMicros;
        sums.set(t.sourceOwner, sum);
        if (sum >= price) {
            const owner = t.sourceOwner;
            const upTo = transfers.filter((x) => x.sourceOwner === owner && chainOrder(x, t) <= 0);
            return walk(price, upTo, () => true);
        }
    }
    return null;
}

function sharedOwners(
    transfers: readonly Owned[],
    skip: (owner: string) => boolean,
    cfg: CoverageCfg,
): { taken: Set<string>; dust: Set<string> } {
    const taken = new Set<string>();
    const dust = new Set<string>();
    for (const [owner, sum] of totals(transfers)) {
        if (skip(owner)) continue;
        if (sum < cfg.refund_min_micros) dust.add(owner);
        else if (taken.size < cfg.max_split_owners) taken.add(owner);
    }
    return { taken, dust };
}

function shared(
    price: number,
    transfers: readonly Owned[],
    skip: (owner: string) => boolean,
    cfg: CoverageCfg,
): { take: Take; owners: Set<string>; dust: Set<string> } {
    const { taken, dust } = sharedOwners(transfers, skip, cfg);
    return { take: walk(price, transfers, (o) => taken.has(o)), owners: taken, dust };
}

// Part 0 is the largest applied sum; a tie goes to the owner whose first transfer came first
function shares(transfers: readonly Owned[], applied: ReadonlyMap<string, number>) {
    const byOwner = new Map<string, { sum: number; accounts: Map<string, number> }>();
    for (const t of transfers) {
        const part = applied.get(t.signature);
        if (part === undefined) continue;
        const o = byOwner.get(t.sourceOwner) ?? { sum: 0, accounts: new Map<string, number>() };
        o.sum += part;
        o.accounts.set(t.sourceTokenAccount, (o.accounts.get(t.sourceTokenAccount) ?? 0) + part);
        byOwner.set(t.sourceOwner, o);
    }
    const list = [...byOwner].map(([owner, o], first) => {
        let source = "";
        let best = -1;
        for (const [account, sum] of o.accounts) {
            if (sum > best) [source, best] = [account, sum];
        }
        return { owner, sourceTokenAccount: source, appliedMicros: o.sum, first };
    });
    list.sort((a, b) => b.appliedMicros - a.appliedMicros || a.first - b.first);
    return list.map(({ owner, sourceTokenAccount, appliedMicros }) => ({
        owner,
        sourceTokenAccount,
        appliedMicros,
    }));
}

function heldCovers(
    price: number,
    transfers: readonly Owned[],
    held: Held,
    cfg: CoverageCfg,
): OwnerHoldReason | null {
    // Only a held owner can reach the price once holds are ignored, since free owners did not
    const alone = single(price, transfers, () => false);
    if (alone?.crossing) return held.owners.get(alone.crossing.sourceOwner) ?? null;
    if (held.shared && shared(price, transfers, (o) => held.owners.has(o), cfg).take.reached) {
        return "anonymous_busy";
    }
    const all = shared(price, transfers, () => false, cfg).take;
    if (!all.reached) return null;
    const completes = [all.crossing!.sourceOwner, ...all.taken].find((o) => held.owners.has(o));
    if (completes !== undefined) return held.owners.get(completes)!;
    return held.shared ? "anonymous_busy" : null;
}

export function coverage(
    priceMicros: number,
    transfers: readonly TransferRow[],
    expiresAt: Date,
    held: Held,
    cfg: CoverageCfg,
): Coverage {
    const deadline = expiresAt.getTime();
    const onTime = transfers
        .filter((t) => t.outcome === "open" && t.blockTime.getTime() <= deadline)
        .map(unlost)
        .filter((t) => t.amountMicros > 0)
        .filter(owned)
        .sort(chainOrder);
    const sums = totals(onTime);
    let largestOwner: string | null = null;
    let largestMicros = 0;
    for (const [owner, sum] of sums) {
        if (sum > largestMicros) [largestOwner, largestMicros] = [owner, sum];
    }
    const all = [...sums.values()].reduce((a, b) => a + b, 0);
    const isHeld = (o: string) => held.owners.has(o);

    const one = single(priceMicros, onTime, isHeld);
    const many = one === null && !held.shared ? shared(priceMicros, onTime, isHeld, cfg) : null;
    const settles = one ?? (many?.take.reached === true ? many.take : null);
    if (settles !== null) {
        const owners = shares(onTime, settles.applied);
        const inside = owners.reduce((a, o) => a + (sums.get(o.owner) ?? 0), 0);
        const dust = one === null ? many!.dust : new Set<string>();
        return {
            mode: one !== null ? "single" : "shared",
            countedMicros: settles.countedMicros,
            largestMicros,
            largestOwner,
            otherMicros: all - inside,
            applied: settles.applied,
            extra: settles.extra,
            notApplied: onTime
                .filter((t) => !settles.applied.has(t.signature) && !dust.has(t.sourceOwner))
                .map((t) => t.signature),
            dust: onTime.filter((t) => dust.has(t.sourceOwner)).map((t) => t.signature),
            owners,
            crossing: settles.crossing,
            heldCovers: null,
        };
    }

    const { taken, dust } = sharedOwners(onTime, isHeld, cfg);
    return {
        mode: "short",
        countedMicros: [...taken].reduce((a, o) => a + sums.get(o)!, 0),
        largestMicros,
        largestOwner,
        otherMicros: all - largestMicros,
        applied: new Map(),
        extra: new Map(),
        notApplied: onTime
            .filter((t) => !taken.has(t.sourceOwner) && !dust.has(t.sourceOwner))
            .map((t) => t.signature),
        dust: onTime.filter((t) => dust.has(t.sourceOwner)).map((t) => t.signature),
        owners: [],
        crossing: null,
        heldCovers: heldCovers(priceMicros, onTime, held, cfg),
    };
}
