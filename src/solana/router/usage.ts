/**
 * Counters, monthly usage and the alarms the router's tick evaluates (spec 10). Every real HTTP
 * request is counted per endpoint, lane and outcome. The month's counts go to the usage store and
 * the health snapshot to its own store on the tick. Rows, alarms and logs name endpoints by
 * position only, and a store that fails is a warn, never a stop.
 */
import { type Lane, monthOf } from "./health.ts";
import { ROLES, type Role, type RpcSettings } from "./settings.ts";
import type { EndpointSnapshot, RouterLog, RouterSnapshot } from "./transport.ts";

export interface UsageRow {
    // A position such as "rpc1", never a URL
    endpoint: string;
    requests: number;
    background: number;
}

export interface UsageStore {
    load(month: string): Promise<Record<string, { requests: number; background: number }>>;
    // Adds the rows to the month's stored counts
    add(month: string, rows: readonly UsageRow[]): Promise<void>;
}

export interface SnapshotStore {
    write(s: RouterSnapshot): Promise<void>;
}

// At most one rpc_absence_unconfirmed alarm in this time (spec 10.2)
const ABSENCE_ALARM_EVERY_MS = 600_000;

const HOUR_MS = 3_600_000;
const NOT_STORED = "rpc usage not stored";

interface Requests {
    requests: number;
    background: number;
}

export interface HourCounts {
    money: number;
    background: number;
    // Method, then outcome, then count
    outcomes: Record<string, Record<string, number>>;
}

interface Hour {
    key: number;
    money: number;
    background: number;
    outcomes: Map<string, Map<string, number>>;
}

function freshHour(now: number): Hour {
    return { key: Math.floor(now / HOUR_MS), money: 0, background: 0, outcomes: new Map() };
}

function addTo(to: Requests, from: Requests): void {
    to.requests += from.requests;
    to.background += from.background;
}

// One endpoint's requests: this month's, stored before plus counted since, this hour's by lane
// and outcome, and the ones not stored yet
export class Counters {
    private month: { key: string; counts: Requests };
    private hour: Hour;
    // Per month, so the counts of a month that just ended still go to that month
    private unstored = new Map<string, Requests>();

    constructor(
        private readonly now: () => number,
        // Without a store, nothing waits to be stored
        private readonly stored: boolean,
    ) {
        const at = now();
        this.month = { key: monthOf(at), counts: { requests: 0, background: 0 } };
        this.hour = freshHour(at);
    }

    count(lane: Lane): void {
        const now = this.now();
        const one = { requests: 1, background: lane === "background" ? 1 : 0 };
        const month = this.monthAt(now);
        addTo(month.counts, one);
        this.hourAt(now)[lane] += 1;
        if (this.stored) this.addUnstored(month.key, one);
    }

    outcome(method: string, outcome: string): void {
        const { outcomes } = this.hourAt(this.now());
        let counts = outcomes.get(method);
        if (counts === undefined) {
            counts = new Map();
            outcomes.set(method, counts);
        }
        counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }

    monthCounts(): Requests {
        return { ...this.monthAt(this.now()).counts };
    }

    hourCounts(): HourCounts {
        const hour = this.hourAt(this.now());
        return {
            money: hour.money,
            background: hour.background,
            outcomes: Object.fromEntries(
                [...hour.outcomes].map(([method, counts]) => [method, Object.fromEntries(counts)]),
            ),
        };
    }

    // The month's counts stored before this process; a month that has ended is left out
    loaded(month: string, counts: Requests): void {
        const current = this.monthAt(this.now());
        if (current.key === month) addTo(current.counts, counts);
    }

    take(): [string, Requests][] {
        const taken = [...this.unstored];
        this.unstored = new Map();
        return taken;
    }

    // Counts that wait for the next flush, a failed one's too
    addUnstored(month: string, counts: Requests): void {
        const pending = this.unstored.get(month) ?? { requests: 0, background: 0 };
        addTo(pending, counts);
        this.unstored.set(month, pending);
    }

    private monthAt(now: number): { key: string; counts: Requests } {
        const key = monthOf(now);
        if (this.month.key !== key) this.month = { key, counts: { requests: 0, background: 0 } };
        return this.month;
    }

    private hourAt(now: number): Hour {
        if (this.hour.key !== Math.floor(now / HOUR_MS)) this.hour = freshHour(now);
        return this.hour;
    }
}

export interface UsageDeps {
    now: () => number;
    log: RouterLog;
    usage?: UsageStore;
    snapshots?: SnapshotStore;
}

// Every endpoint's counters, and the two stores the tick writes to (spec 10.1, 10.4)
export class UsageBook {
    private readonly counters: Map<string, Counters>;
    private nextFlush: number;
    private nextWrite: number;
    private loading: Promise<void> | null = null;
    // One flush after another, so the counts a failed one puts back go with the next one
    private flushing: Promise<void> = Promise.resolve();
    private writing: Promise<void> | null = null;
    // A snapshot store that fails warns once, not every snapshot_every
    private writeFailed = false;

    constructor(
        private readonly s: RpcSettings,
        names: readonly string[],
        private readonly deps: UsageDeps,
    ) {
        const stored = deps.usage !== undefined;
        this.counters = new Map(names.map((name) => [name, new Counters(deps.now, stored)]));
        const now = deps.now();
        this.nextFlush = now + s.usage_flush_every;
        this.nextWrite = now + s.snapshot_every;
    }

    of(name: string): Counters {
        const counters = this.counters.get(name);
        if (counters === undefined) throw new Error(`No counters for ${name}`);
        return counters;
    }

    // At start, so a restart keeps the month's counts; at most once
    load(): Promise<void> {
        this.loading ??= (async () => {
            const store = this.deps.usage;
            if (store === undefined) return;
            const month = monthOf(this.deps.now());
            try {
                const stored = await store.load(month);
                for (const [name, counters] of this.counters) {
                    if (Object.hasOwn(stored, name)) counters.loaded(month, stored[name]!);
                }
            } catch (err) {
                this.deps.log.warn(NOT_STORED, { err });
            }
        })();
        return this.loading;
    }

    tick(snapshot: () => RouterSnapshot): Promise<void> {
        const now = this.deps.now();
        const work: Promise<void>[] = [];
        if (now >= this.nextFlush) {
            this.nextFlush = now + this.s.usage_flush_every;
            work.push(this.flush());
        }
        const store = this.deps.snapshots;
        if (store !== undefined && now >= this.nextWrite && this.writing === null) {
            this.nextWrite = now + this.s.snapshot_every;
            work.push(this.write(store, snapshot()));
        }
        return Promise.all(work).then(() => undefined);
    }

    // The counts are taken at once, so calls sent after this go with the next flush
    flush(): Promise<void> {
        const store = this.deps.usage;
        if (store === undefined) return this.flushing;
        const months = new Map<string, UsageRow[]>();
        for (const [endpoint, counters] of this.counters) {
            for (const [month, counts] of counters.take()) {
                const rows = months.get(month) ?? [];
                rows.push({ endpoint, ...counts });
                months.set(month, rows);
            }
        }
        if (months.size === 0) return this.flushing;
        this.flushing = this.flushing.then(() => this.store(store, [...months]));
        return this.flushing;
    }

    async stop(): Promise<void> {
        await this.flushing;
        await this.writing;
        await this.flush();
    }

    private async store(store: UsageStore, months: [string, UsageRow[]][]): Promise<void> {
        let done = 0;
        try {
            for (const [month, rows] of months) {
                await store.add(month, rows);
                done += 1;
            }
        } catch (err) {
            this.deps.log.warn(NOT_STORED, { err });
            for (const [month, rows] of months.slice(done)) {
                for (const row of rows) this.of(row.endpoint).addUnstored(month, row);
            }
        }
    }

    private write(store: SnapshotStore, s: RouterSnapshot): Promise<void> {
        const writing = (async () => {
            try {
                await store.write(s);
                this.writeFailed = false;
            } catch (err) {
                if (!this.writeFailed) this.deps.log.warn("rpc snapshot not stored", { err });
                this.writeFailed = true;
            }
        })();
        this.writing = writing;
        // Registered first, so the write is cleared before the tick that waits for it ends
        void writing.then(() => {
            if (this.writing === writing) this.writing = null;
        });
        return writing;
    }
}

export interface AlarmView {
    // The roles no endpoint is eligible for now (spec 6.1)
    down: ReadonlySet<Role>;
    endpoints: readonly {
        name: string;
        state: EndpointSnapshot["state"];
        lag: number | null;
        rateLimited: boolean;
    }[];
}

// The alarms of spec 10.2 that come from a state lasting a while, each raised once until the
// state clears; the tick reads the state every 5 s
export class AlarmBook {
    private readonly downSince = new Map<Role, number>();
    private readonly downAlarmed = new Set<Role>();
    private readonly lagSince = new Map<string, number>();
    private readonly lagAlarmed = new Set<string>();
    private readonly limitAlarmed = new Set<string>();
    // Unconfirmed absences since the last rpc_absence_unconfirmed alarm
    private absence: { at: number | null; count: number } = { at: null, count: 0 };

    constructor(
        private readonly s: RpcSettings,
        private readonly log: RouterLog,
    ) {}

    evaluate(now: number, view: AlarmView): void {
        this.allDown(now, view);
        for (const e of view.endpoints) {
            this.lagging(now, e.name, e.lag);
            this.limited(e.name, e.rateLimited);
        }
    }

    // Counts the unconfirmed absences since the last alarm, which comes at most every 10 min
    absenceUnconfirmed(now: number, domainsAnswered: number): void {
        this.absence.count += 1;
        const { at, count } = this.absence;
        if (at === null || now - at >= ABSENCE_ALARM_EVERY_MS) {
            this.log.alarm("rpc_absence_unconfirmed", { count, domainsAnswered });
            this.absence = { at: now, count: 0 };
        }
    }

    private allDown(now: number, view: AlarmView): void {
        for (const role of ROLES) {
            if (!view.down.has(role)) {
                this.downSince.delete(role);
                if (this.downAlarmed.delete(role)) this.log.info("rpc endpoints back", { role });
                continue;
            }
            const since = this.downSince.get(role) ?? now;
            this.downSince.set(role, since);
            // Every endpoint holds the read role, so with reads down the other roles are too,
            // and the read alarm says so
            const covered = role !== "read" && view.down.has("read");
            if (
                covered ||
                this.downAlarmed.has(role) ||
                now - since < this.s.all_down_alarm_after
            ) {
                continue;
            }
            this.downAlarmed.add(role);
            this.log.alarm("rpc_all_endpoints_down", {
                role,
                endpoints: view.endpoints.map(({ name, state }) => ({ name, state })),
            });
        }
    }

    private lagging(now: number, name: string, lag: number | null): void {
        if (lag === null || lag <= this.s.max_slot_lag) {
            this.lagSince.delete(name);
            this.lagAlarmed.delete(name);
            return;
        }
        const since = this.lagSince.get(name) ?? now;
        this.lagSince.set(name, since);
        if (this.lagAlarmed.has(name) || now - since < this.s.lag_alarm_after) return;
        this.lagAlarmed.add(name);
        this.log.alarm("rpc_endpoint_lag", { endpoint: name, lagSlots: lag });
    }

    // 429s and no success for limited_alarm_after: a spent or small plan (spec 6.3)
    private limited(name: string, rateLimited: boolean): void {
        if (!rateLimited) {
            this.limitAlarmed.delete(name);
            return;
        }
        if (this.limitAlarmed.has(name)) return;
        this.limitAlarmed.add(name);
        this.log.alarm("rpc_endpoint_down", { endpoint: name, reason: "rate_limited" });
    }
}
