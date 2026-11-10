/**
 * Whether each endpoint's own answers agree (spec 8.10). An endpoint that is not "yes" never
 * votes for a missing signature and never gets a listing. Its verdict is saved by URL
 * fingerprint, so a restart or a reordered list never gives a vote back before the hour.
 */

export type Consistency = "unknown" | "yes" | "no";

export type DisagreeReason = "found_then_missing" | "slot_went_back" | "check_disagreed";

export interface Verdict {
    noAt: number | null;
    reason: DisagreeReason | null;
    historyPassed: boolean;
}

// A stored row: fingerprint matches the URL, endpoint is the position when written
export interface VerdictRow extends Verdict {
    fingerprint: string;
    endpoint: string;
}

export interface VerdictStore {
    load(): Promise<VerdictRow[]>;
    save(row: VerdictRow): Promise<void>;
}

export const FOUND_KEPT = 4_096;
export const IDENTITIES_KEPT = 16;

interface Entry {
    state: Consistency;
    noAt: number | null;
    reason: DisagreeReason | null;
    historyPassed: boolean;
    // Oldest first
    found: Set<string>;
}

// Moves value to the newest end of a set kept in insertion order, dropping the oldest past max
function keepNewest(set: Set<string>, value: string, max: number): void {
    set.delete(value);
    set.add(value);
    if (set.size > max) set.delete(set.values().next().value!);
}

export class ConsistencyBook {
    private readonly entries = new Map<string, Entry>();
    private readonly listeners: ((endpoint: string, v: Verdict) => void)[] = [];
    private readonly size: number;

    // size: found signatures kept per endpoint; clearAfterMs: history_check_every
    constructor(private readonly o: { now: () => number; clearAfterMs: number; size?: number }) {
        this.size = o.size ?? FOUND_KEPT;
    }

    // A confirmed or finalized status, or a found getTransaction at confirmed or finalized
    found(endpoint: string, signature: string): void {
        keepNewest(this.entry(endpoint).found, signature, this.size);
    }

    // A null or -32011 of a history read; true when it contradicts a found answer
    nullFor(endpoint: string, signature: string): boolean {
        if (this.entries.get(endpoint)?.found.has(signature) !== true) return false;
        this.markNo(endpoint, "found_then_missing", this.o.now());
        return true;
    }

    disagree(endpoint: string, reason: DisagreeReason): void {
        this.markNo(endpoint, reason, this.o.now());
    }

    // A check run whose history repeats all answered; a disagreeing one dates from its start, so
    // the next hourly run can clear it
    checkRun(endpoint: string, agreed: boolean, startedAt: number): void {
        if (!agreed) {
            this.markNo(endpoint, "check_disagreed", startedAt);
            return;
        }
        const e = this.entry(endpoint);
        if (e.state === "yes") return;
        // One lucky probe sooner than the hour cannot give the vote back
        if (e.noAt !== null && startedAt < e.noAt + this.o.clearAfterMs) return;
        e.state = "yes";
        e.noAt = null;
        e.reason = null;
        this.changed(endpoint, e);
    }

    passHistory(endpoint: string): void {
        const e = this.entry(endpoint);
        if (e.historyPassed) return;
        e.historyPassed = true;
        this.changed(endpoint, e);
    }

    historyPassed(endpoint: string): boolean {
        return this.entries.get(endpoint)?.historyPassed ?? false;
    }

    // A stored row, before any traffic. It only ever adds a mark or a passed check, so a row that
    // loads late never gives back a vote taken in this process
    load(endpoint: string, v: Verdict): void {
        const e = this.entry(endpoint);
        e.historyPassed ||= v.historyPassed;
        if (v.noAt !== null && (e.noAt === null || v.noAt > e.noAt)) {
            e.state = "no";
            e.noAt = v.noAt;
            e.reason = v.reason;
        }
    }

    onChange(cb: (endpoint: string, v: Verdict) => void): void {
        this.listeners.push(cb);
    }

    state(endpoint: string): Consistency {
        return this.entries.get(endpoint)?.state ?? "unknown";
    }

    // A later mark starts the hour again; an earlier one changes nothing
    private markNo(endpoint: string, reason: DisagreeReason, at: number): void {
        const e = this.entry(endpoint);
        if (e.noAt !== null && e.noAt >= at) return;
        e.state = "no";
        e.noAt = at;
        e.reason = reason;
        this.changed(endpoint, e);
    }

    private changed(endpoint: string, e: Entry): void {
        for (const cb of this.listeners) {
            cb(endpoint, { noAt: e.noAt, reason: e.reason, historyPassed: e.historyPassed });
        }
    }

    private entry(endpoint: string): Entry {
        let e = this.entries.get(endpoint);
        if (e === undefined) {
            e = {
                state: "unknown",
                noAt: null,
                reason: null,
                historyPassed: false,
                found: new Set(),
            };
            this.entries.set(endpoint, e);
        }
        return e;
    }
}

function pairOf(a: string, b: string): string {
    return JSON.stringify(a < b ? [a, b] : [b, a]);
}

// The node identities each endpoint reported (at most 16 each). Two endpoints that ever reported
// one identity share a node from then on, even after it left their lists
export class IdentityBook {
    private readonly seen = new Map<string, Set<string>>();
    private readonly pairs = new Set<string>();

    // The other endpoints that now share a node with this one, each only the first time
    saw(endpoint: string, identity: string): string[] {
        let ids = this.seen.get(endpoint);
        if (ids === undefined) {
            ids = new Set();
            this.seen.set(endpoint, ids);
        }
        keepNewest(ids, identity, IDENTITIES_KEPT);
        const shared: string[] = [];
        for (const [other, theirs] of this.seen) {
            if (other === endpoint || !theirs.has(identity)) continue;
            const pair = pairOf(endpoint, other);
            if (this.pairs.has(pair)) continue;
            this.pairs.add(pair);
            shared.push(other);
        }
        return shared;
    }

    shares(a: string, b: string): boolean {
        return a === b || this.pairs.has(pairOf(a, b));
    }
}
