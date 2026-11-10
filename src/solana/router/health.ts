/**
 * One endpoint's health (spec 6.2, 6.4): latency, error rate, requests in flight, the breaker
 * and the probation that brings an endpoint back. Latency and errors never reorder the list;
 * they only make an endpoint ineligible.
 */
import type { RpcSettings } from "./settings.ts";

export type Lane = "money" | "background";

export type Breaker = "closed" | "open" | "probation";

export const INITIAL_LATENCY_MS = 500;
export const LATENCY_TAU_MS = 10_000;
export const ERROR_WINDOW_MS = 60_000;
export const BREAKER_MAX_MS = 600_000;
// 401, 402, 403, 404, 405 and 410 are about the URL, so retrying it sooner only spends calls
export const DOWN_OPEN_MS = 600_000;
// A caller abort sooner than this says nothing about the endpoint
export const STALL_SAMPLE_MS = 1_000;
// Three good probes 10 s apart: an endpoint is back about 30 s after it recovered at the
// earliest, so one that fails again and again does not flap (spec 6.2). Tuning needs a review.
export const RECOVER_PROBES = 3;
export const RECOVER_SPACING_MS = 10_000;
export const JITTER = 0.25;

const MIN_RATE_ANSWERS = 10;
const MAX_ERROR_RATE = 0.5;

export function monthOf(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 7);
}

export class EndpointHealth {
    private latency = INITIAL_LATENCY_MS;
    private lastSampleAt: number;
    // Answers of the last ERROR_WINDOW_MS, oldest first: true for a strike
    private answers: { at: number; strike: boolean }[] = [];
    private strikeRun = 0;
    private running = 0;
    private state: Breaker = "closed";
    private openEnd = 0;
    // The unjittered length of the last opening, 0 once the breaker closed
    private openBase = 0;
    private probationFrom: number | null = null;
    private goodProbes = 0;
    private lastProbeAt: number | null = null;
    private lastGood = false;
    private readonly off = new Set<string>();

    constructor(
        private readonly s: RpcSettings,
        private readonly now: () => number,
        private readonly random: () => number,
    ) {
        this.lastSampleAt = now();
    }

    latencyMs(): number {
        return this.latency;
    }

    errorRate(): number {
        this.prune();
        if (this.answers.length === 0) return 0;
        return this.answers.filter((a) => a.strike).length / this.answers.length;
    }

    inflight(): number {
        return this.running;
    }

    begin(): void {
        this.running += 1;
    }

    // Every begin() gets one end(), whatever the attempt's outcome
    end(): void {
        this.running = Math.max(0, this.running - 1);
    }

    succeed(latencyMs: number): void {
        this.settle();
        this.take(latencyMs);
        this.answers.push({ at: this.now(), strike: false });
        this.strikeRun = 0;
    }

    strike(latencyMs: number): void {
        this.settle();
        this.take(latencyMs);
        this.answers.push({ at: this.now(), strike: true });
        this.strikeRun += 1;
        // Only probes decide an endpoint in probation, and an open one is out already
        if (this.state !== "closed") return;
        if (this.strikeRun >= this.s.breaker_failures || this.rateTooHigh()) {
            this.open(this.s.breaker_open);
        }
    }

    sample(latencyMs: number): void {
        this.take(latencyMs);
    }

    callerAborted(elapsedMs: number): void {
        if (elapsedMs >= STALL_SAMPLE_MS) this.take(elapsedMs);
    }

    authFailed(): void {
        this.openDown();
    }

    endpointDown(): void {
        this.openDown();
    }

    lagged(): void {
        this.settle();
        if (this.state === "closed") this.enterProbation();
        // A lag in probation is no recovery yet
        else if (this.state === "probation") this.goodProbes = 0;
    }

    probationAt(ms: number): void {
        this.settle();
        if (this.state === "closed") {
            this.probationFrom = Math.max(this.probationFrom ?? 0, ms);
        } else if (this.state === "open") {
            this.openEnd = Math.max(this.openEnd, ms);
        }
    }

    probeDue(): boolean {
        this.settle();
        if (this.state !== "probation") return false;
        return this.lastProbeAt === null || this.now() - this.lastProbeAt >= RECOVER_SPACING_MS;
    }

    probeResult(good: boolean): void {
        this.settle();
        if (this.state !== "probation") return;
        if (!good) {
            this.open(Math.min(this.openBase * 2 || this.s.breaker_open, BREAKER_MAX_MS));
            return;
        }
        // A good probe counts only RECOVER_SPACING_MS after the last one
        if (!this.probeDue()) return;
        this.lastProbeAt = this.now();
        this.lastGood = true;
        this.goodProbes += 1;
        if (this.goodProbes >= RECOVER_PROBES) this.close();
    }

    lastProbeGood(): boolean {
        return this.lastGood;
    }

    disableMethod(method: string): void {
        this.off.add(method);
    }

    methodOff(method: string): boolean {
        return this.off.has(method);
    }

    methodsOff(): ReadonlySet<string> {
        return this.off;
    }

    breaker(): Breaker {
        this.settle();
        return this.state;
    }

    openUntil(): number {
        return this.openEnd;
    }

    // Peak EWMA: a slower sample counts at once, a faster one decays in
    private take(latencyMs: number): void {
        const at = this.now();
        if (latencyMs >= this.latency) {
            this.latency = latencyMs;
        } else {
            const keep = Math.exp(-Math.max(0, at - this.lastSampleAt) / LATENCY_TAU_MS);
            this.latency = this.latency * keep + latencyMs * (1 - keep);
        }
        this.lastSampleAt = at;
    }

    private prune(): void {
        const from = this.now() - ERROR_WINDOW_MS;
        let drop = 0;
        while (drop < this.answers.length && this.answers[drop]!.at <= from) drop += 1;
        if (drop > 0) this.answers.splice(0, drop);
    }

    private rateTooHigh(): boolean {
        this.prune();
        return this.answers.length >= MIN_RATE_ANSWERS && this.errorRate() > MAX_ERROR_RATE;
    }

    private settle(): void {
        const at = this.now();
        if (this.state === "open" && at >= this.openEnd) {
            this.enterProbation();
        } else if (
            this.state === "closed" &&
            this.probationFrom !== null &&
            at >= this.probationFrom
        ) {
            this.enterProbation();
        }
    }

    private jitter(): number {
        return 1 + JITTER * (2 * this.random() - 1);
    }

    private open(baseMs: number): void {
        this.openBase = baseMs;
        this.openEnd = this.now() + Math.min(baseMs * this.jitter(), BREAKER_MAX_MS);
        this.state = "open";
        this.resetRecovery();
    }

    private openDown(): void {
        this.openBase = DOWN_OPEN_MS;
        this.openEnd = this.now() + DOWN_OPEN_MS;
        this.state = "open";
        this.resetRecovery();
    }

    private enterProbation(): void {
        this.state = "probation";
        this.resetRecovery();
    }

    private close(): void {
        this.state = "closed";
        this.openBase = 0;
        // Answers from before the opening say nothing about the recovered endpoint
        this.answers = [];
        this.strikeRun = 0;
    }

    private resetRecovery(): void {
        this.strikeRun = 0;
        this.probationFrom = null;
        this.goodProbes = 0;
        this.lastProbeAt = null;
        this.lastGood = false;
    }
}
