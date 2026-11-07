import type { Log } from "../log.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function runLogged(name: string, fn: () => Promise<unknown>, log: Log): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(
            () => undefined,
            (err: unknown) => log.error("job failed", { job: name, err }),
        );
}

// A tick that finds the previous run still going is skipped, so runs never overlap
export function every(ms: number, name: string, fn: () => Promise<unknown>, log: Log): () => void {
    let running = false;
    const timer = setInterval(() => {
        if (running) return;
        running = true;
        void runLogged(name, fn, log).then(() => {
            running = false;
        });
    }, ms);
    return () => clearInterval(timer);
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
    const [hour, minute] = hhmmUtc.split(":").map(Number) as [number, number];
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    // Counted from the last target too, so a timer that fires a little early never runs twice
    const schedule = (last: number) => {
        const t = now().getTime();
        const at = nextAt(hour, minute, Math.max(t, last));
        timer = setTimeout(() => {
            void runLogged(name, fn, log).then(() => {
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
