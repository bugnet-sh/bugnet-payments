interface Window {
    start: number;
    count: number;
}

export class RateLimiter {
    // Kept in window start order, so pruning stops at the first live window
    private readonly windows = new Map<string, Window>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
        const t = this.now();
        this.prune(t);
        const w = this.windows.get(key);
        if (w === undefined || t - w.start >= this.windowMs) {
            this.windows.delete(key);
            this.windows.set(key, { start: t, count: 1 });
            return { ok: true };
        }
        if (w.count >= this.limit) {
            return {
                ok: false,
                retryAfterSeconds: Math.ceil((w.start + this.windowMs - t) / 1000),
            };
        }
        w.count++;
        return { ok: true };
    }

    private prune(t: number): void {
        for (const [key, w] of this.windows) {
            if (t - w.start < this.windowMs) return;
            this.windows.delete(key);
        }
    }
}
