import type { Log } from "../log.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// Node runs a longer timer after 1 ms
const MAX_TIMER_MS = 2 ** 31 - 1;
const HHMM_UTC = /^([01]\d|2[0-3]):[0-5]\d$/;

// Never rejects, a logger that throws has nowhere left to report
function runLogged(name: string, fn: () => Promise<unknown>, log: Log): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(
            () => undefined,
            (err: unknown) => log.error("job failed", { job: name, err }),
        )
        .catch(() => undefined);
}

// A tick that finds the previous run still going is skipped, so runs never overlap
export function every(ms: number, name: string, fn: () => Promise<unknown>, log: Log): () => void {
    if (!Number.isInteger(ms) || ms < 1 || ms > MAX_TIMER_MS) {
        throw new RangeError(`job ${name}: interval ${ms} ms is not from 1 to ${MAX_TIMER_MS}`);
    }
    let running = false;
    const timer = setInterval(() => {
        if (running) return;
        running = true;
        void runLogged(name, fn, log).finally(() => {
            running = false;
        });
    }, ms);
    return () => clearInterval(timer);
}

// The wait comes after the run, so runs never overlap and a slow run pushes the next one back
export function paced(
    name: string,
    fn: () => Promise<unknown>,
    nextMs: () => Promise<number>,
    log: Log,
): () => void {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const schedule = () => {
        // nextMs is the caller's to keep from rejecting; a throw is logged and retried after a second
        void Promise.resolve()
            .then(nextMs)
            .then(
                (ms) => Math.min(Math.max(ms, 1), MAX_TIMER_MS),
                (err: unknown) => {
                    log.error("job failed", { job: name, err });
                    return 1_000;
                },
            )
            .then((ms) => {
                if (stopped) return;
                timer = setTimeout(() => {
                    void runLogged(name, fn, log).finally(() => {
                        if (!stopped) schedule();
                    });
                }, ms);
            })
            .catch(() => undefined);
    };
    schedule();
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}

function nextAt(hour: number, minute: number, after: number): number {
    const d = new Date(after);
    const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
    return at > after ? at : at + DAY_MS;
}

export function dailyAt(
    hhmmUtc: string,
    name: string,
    fn: () => Promise<unknown>,
    log: Log,
    now: () => Date = () => new Date(),
): () => void {
    if (!HHMM_UTC.test(hhmmUtc)) {
        throw new RangeError(
            `job ${name}: ${JSON.stringify(hhmmUtc)} is not a UTC time like 03:30`,
        );
    }
    const [hour, minute] = hhmmUtc.split(":").map(Number) as [number, number];
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    // Counted from the last target too, so a timer that fires a little early never runs twice
    const schedule = (last: number) => {
        const t = now().getTime();
        const at = nextAt(hour, minute, Math.max(t, last));
        timer = setTimeout(() => {
            void runLogged(name, fn, log).finally(() => {
                if (!stopped) schedule(at);
            });
        }, at - t);
    };
    schedule(0);
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
