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
        private readonly now: () => number = () => performance.now(),
    ) {
        if (!(limit >= 1)) throw new RangeError(`rate limit must be at least 1, got ${limit}`);
        if (!(windowMs > 0)) throw new RangeError(`rate window must be positive, got ${windowMs}`);
    }

    take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
        const t = this.now();
        this.prune(t);
        const w = this.windows.get(key);
        if (w === undefined || t - w.start >= this.windowMs) {
            this.windows.delete(key);
            this.windows.set(key, { start: t, count: 1 });
            return { ok: true };
        }
        // A clock that stepped back would otherwise stretch the window past windowMs
        if (w.start > t) w.start = t;
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
