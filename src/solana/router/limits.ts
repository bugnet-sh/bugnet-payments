/**
 * One endpoint's limits, learned from its own 429s (spec 6.3), and the two lanes that share them.
 * No rate is configured: an endpoint that never answered 429 has no limit.
 */
import { JITTER, type Lane } from "./health.ts";
import type { RpcSettings } from "./settings.ts";

export const LIMIT_WINDOW_MS = 10_000;
export const LIMIT_CUT = 0.8;
export const LIMIT_GROW = 1.1;
export const LIMIT_GROW_MS = 60_000;
export const METHOD_SHARE = 0.5;
// One header from any URL must not take an endpoint out until a restart
export const RETRY_AFTER_MAX_MS = 60_000;
export const BACKOFF_START_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

const ENDPOINT = "*";

interface Sent {
    at: number;
    method: string;
    background: boolean;
}

interface Count {
    all: number;
    background: number;
}

interface Limit {
    value: number;
    learnedAt: number;
    // The growth period: it started at periodStart, and filled says the window reached the limit
    periodStart: number;
    filled: boolean;
}

export class LearnedLimits {
    // Requests of the last LIMIT_WINDOW_MS, oldest first from head
    private sent: Sent[] = [];
    private head = 0;
    private total: Count = { all: 0, background: 0 };
    private readonly byMethod = new Map<string, Count>();
    private readonly learned = new Map<string, Limit>();
    private endpointUntil = 0;
    private readonly methodUntil = new Map<string, number>();
    // 429s since the method's last success
    private readonly backoff = new Map<string, number>();
    private limitedSince: number | null = null;

    constructor(
        private readonly s: RpcSettings,
        private readonly now: () => number,
        private readonly random: () => number,
    ) {}

    record(method: string, lane: Lane): void {
        this.settle();
        const background = lane === "background";
        this.sent.push({ at: this.now(), method, background });
        for (const count of [this.total, this.countOf(method, true)]) {
            count.all += 1;
            if (background) count.background += 1;
        }
        for (const [count, limit] of this.applying(method)) {
            if (count.all >= limit.value) limit.filled = true;
        }
    }

    hit429(method: string, retryAfterMs: number | null): { scope: string; capped: boolean } {
        this.settle();
        const at = this.now();
        this.limitedSince ??= at;
        const star = this.learned.get(ENDPOINT);
        const own = this.countOf(method, false).all;
        // A method's own limit only when the endpoint-wide one cannot explain the 429
        const scope =
            star !== undefined &&
            this.total.all < star.value &&
            own >= METHOD_SHARE * this.total.all
                ? method
                : ENDPOINT;
        const window = scope === ENDPOINT ? this.total.all : own;
        this.learn(scope, Math.max(1, Math.floor(LIMIT_CUT * window)), at);
        if (scope === ENDPOINT) {
            for (const [key, limit] of this.learned) {
                if (key !== ENDPOINT && limit.learnedAt > at - LIMIT_WINDOW_MS) {
                    this.learned.delete(key);
                }
            }
        }

        const tries = (this.backoff.get(method) ?? 0) + 1;
        this.backoff.set(method, tries);
        const wanted =
            retryAfterMs ??
            Math.min(BACKOFF_START_MS * 2 ** (tries - 1) * this.jitter(), BACKOFF_MAX_MS);
        const capped = wanted > RETRY_AFTER_MAX_MS;
        const until = at + Math.max(0, Math.min(wanted, RETRY_AFTER_MAX_MS));
        if (scope === ENDPOINT) {
            this.endpointUntil = Math.max(this.endpointUntil, until);
        } else {
            this.methodUntil.set(method, Math.max(this.methodUntil.get(method) ?? 0, until));
        }
        return { scope, capped };
    }

    // A 5xx with Retry-After cools the whole endpoint under the same cap (spec 7.2), and
    // teaches no limit
    coolEndpoint(retryAfterMs: number): { capped: boolean } {
        const capped = retryAfterMs > RETRY_AFTER_MAX_MS;
        const until = this.now() + Math.max(0, Math.min(retryAfterMs, RETRY_AFTER_MAX_MS));
        this.endpointUntil = Math.max(this.endpointUntil, until);
        return { capped };
    }

    succeeded(method: string): void {
        this.backoff.delete(method);
        this.limitedSince = null;
    }

    // 0 when nothing cools
    coolingUntil(method: string): number {
        const until = Math.max(this.methodUntil.get(method) ?? 0, this.endpointUntil);
        return until > this.now() ? until : 0;
    }

    endpointCoolingUntil(): number {
        return this.endpointUntil > this.now() ? this.endpointUntil : 0;
    }

    // The window only: a cooldown is coolingUntil's
    hasRoom(method: string, lane: Lane): boolean {
        this.settle();
        return this.applying(method).every(([count, limit]) => {
            if (count.all >= limit.value) return false;
            return lane === "money" || count.background < this.backgroundCap(limit);
        });
    }

    // Infinity when the background lane has no room under a limit at all
    msUntilRoom(method: string, lane: Lane): number {
        this.settle();
        let wait = 0;
        for (const [count, limit, scope] of this.applying(method)) {
            const ofScope = (e: Sent) => scope === ENDPOINT || e.method === scope;
            if (count.all >= limit.value) {
                wait = Math.max(wait, this.leaves(count.all - limit.value + 1, ofScope));
            }
            if (lane === "background") {
                const cap = this.backgroundCap(limit);
                if (cap === 0) return Infinity;
                if (count.background >= cap) {
                    const ofLane = (e: Sent) => e.background && ofScope(e);
                    wait = Math.max(wait, this.leaves(count.background - cap + 1, ofLane));
                }
            }
        }
        return wait;
    }

    limits(): Record<string, number> {
        this.settle();
        return Object.fromEntries([...this.learned].map(([key, limit]) => [key, limit.value]));
    }

    backgroundOut(method: string): boolean {
        this.settle();
        return this.applying(method).some(([, limit]) => this.backgroundCap(limit) === 0);
    }

    rateLimited(): boolean {
        if (this.limitedSince === null) return false;
        return this.now() - this.limitedSince >= this.s.limited_alarm_after;
    }

    private backgroundCap(limit: Limit): number {
        return Math.floor(this.s.background_share * limit.value);
    }

    private jitter(): number {
        return 1 + JITTER * (2 * this.random() - 1);
    }

    private countOf(method: string, create: boolean): Count {
        let count = this.byMethod.get(method);
        if (count === undefined) {
            count = { all: 0, background: 0 };
            if (create) this.byMethod.set(method, count);
        }
        return count;
    }

    // The limits a request of this method must stay under, with the window each one counts
    private applying(method: string): [Count, Limit, string][] {
        const found: [Count, Limit, string][] = [];
        const star = this.learned.get(ENDPOINT);
        if (star !== undefined) found.push([this.total, star, ENDPOINT]);
        const own = method === ENDPOINT ? undefined : this.learned.get(method);
        if (own !== undefined) found.push([this.countOf(method, false), own, method]);
        return found;
    }

    private learn(scope: string, value: number, at: number): void {
        const known = this.learned.get(scope);
        this.learned.set(scope, {
            value: known === undefined ? value : Math.min(known.value, value),
            learnedAt: at,
            periodStart: at,
            filled: false,
        });
    }

    // How long until the n-th oldest request that matches leaves the window
    private leaves(n: number, matches: (e: Sent) => boolean): number {
        let seen = 0;
        for (let i = this.head; i < this.sent.length; i++) {
            const e = this.sent[i]!;
            if (!matches(e)) continue;
            seen += 1;
            if (seen === n) return Math.max(0, e.at + LIMIT_WINDOW_MS - this.now());
        }
        return 0;
    }

    private settle(): void {
        const at = this.now();
        const from = at - LIMIT_WINDOW_MS;
        while (this.head < this.sent.length && this.sent[this.head]!.at <= from) {
            const e = this.sent[this.head]!;
            for (const count of [this.total, this.countOf(e.method, false)]) {
                count.all -= 1;
                if (e.background) count.background -= 1;
            }
            const method = this.byMethod.get(e.method);
            if (method !== undefined && method.all === 0) this.byMethod.delete(e.method);
            this.head += 1;
        }
        if (this.head > 1024 && this.head * 2 > this.sent.length) {
            this.sent = this.sent.slice(this.head);
            this.head = 0;
        }
        // A limit grows only after a period in which it was reached, so a quiet night keeps it
        for (const limit of this.learned.values()) {
            const periods = Math.floor((at - limit.periodStart) / LIMIT_GROW_MS);
            if (periods <= 0) continue;
            if (limit.filled) {
                limit.value = Math.max(limit.value + 1, Math.floor(limit.value * LIMIT_GROW));
            }
            limit.filled = false;
            limit.periodStart += periods * LIMIT_GROW_MS;
        }
    }
}
