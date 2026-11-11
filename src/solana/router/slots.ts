/**
 * The slots and heights each endpoint reported (spec 6.5): marks, their projection to now, the
 * high water the freshness floors come from (spec 8.2), each endpoint's lag, and the slot drops
 * that mark an endpoint inconsistent (spec 8.10).
 */
import {
    bigintOf,
    type Commitment,
    contextSlotOf,
    isObject,
    type RouterRequest,
    rpcErrorOf,
} from "./payload.ts";

export type Kind = "slot" | "height";

export interface Observation {
    commitment: Commitment;
    slot?: bigint;
    height?: bigint;
}

export interface Mark {
    value: bigint;
    firstSeen: number;
    lastSeen: number;
}

// Slower than the chain (about 400 ms a slot, more per block), so an honest node's projection
// stays below the real tip
export const SLOT_PROJECT_MS = 450;
export const BLOCK_PROJECT_MS = 500;
// Keeps a silent endpoint's mark from rising past the live ones
export const PROJECT_MAX_MS = 60_000;
export const LAG_REFERENCE_MS = 10_000;

const KINDS: readonly Kind[] = ["slot", "height"];
// Each commitment with the more final ones that bound it from below
const AT_LEAST: Readonly<Record<Commitment, readonly Commitment[]>> = {
    processed: ["processed", "confirmed", "finalized"],
    confirmed: ["confirmed", "finalized"],
    finalized: ["finalized"],
};
const BEHIND = "behind";

interface Sample {
    slots: number;
    at: number;
}

function keyOf(c: Commitment, k: Kind): string {
    return `${c}/${k}`;
}

export function observationsOf(req: RouterRequest, answer: unknown): Observation[] {
    const error = rpcErrorOf(answer);
    if (error !== null) {
        if (error.code !== -32016 || !isObject(error.data)) return [];
        const slot = bigintOf(error.data.contextSlot);
        return slot === null ? [] : [{ commitment: req.commitment, slot }];
    }
    const result = isObject(answer) ? answer.result : undefined;
    const commitment = req.commitment;
    switch (req.spec.slot) {
        case "context": {
            const slot = contextSlotOf(answer);
            return slot === null ? [] : [{ commitment, slot }];
        }
        case "slot_result": {
            const slot = bigintOf(result);
            return slot === null ? [] : [{ commitment, slot }];
        }
        case "height_result": {
            const height = bigintOf(result);
            return height === null ? [] : [{ commitment, height }];
        }
        case "epoch_info": {
            if (!isObject(result)) return [];
            const o: Observation = { commitment };
            const slot = bigintOf(result.absoluteSlot);
            const height = bigintOf(result.blockHeight);
            if (slot !== null) o.slot = slot;
            if (height !== null) o.height = height;
            return slot === null && height === null ? [] : [o];
        }
        case "none":
            return [];
    }
}

export class SlotBook {
    // endpoint -> commitment/kind -> mark
    private readonly marks = new Map<string, Map<string, Mark>>();
    // endpoint -> commitment/kind (or BEHIND for -32005) -> the latest sample
    private readonly samples = new Map<string, Map<string, Sample>>();

    constructor(
        private readonly o: {
            now: () => number;
            // breaker closed and not cooling (spec 6.5)
            isReference: (endpoint: string) => boolean;
            sampleMaxAgeMs: number;
            maxSlotLag: number;
            // spec 8.10's slot_went_back
            onDrop: (endpoint: string, c: Commitment, k: Kind) => void;
        },
    ) {}

    observe(endpoint: string, o: Observation): void {
        const now = this.o.now();
        const drops: Kind[] = [];
        for (const k of KINDS) {
            const value = o[k];
            if (value === undefined) continue;
            const key = keyOf(o.commitment, k);
            const before = this.marks.get(endpoint)?.get(key) ?? null;
            const reference = this.reference(endpoint, o.commitment, k, now);
            const behind = reference === null || reference <= value ? 0n : reference - value;
            this.sampleOf(endpoint).set(key, { slots: Number(behind), at: now });
            // Forks make processed values go back
            if (
                o.commitment !== "processed" &&
                before !== null &&
                before.value - value > BigInt(this.o.maxSlotLag)
            ) {
                drops.push(k);
            }
            this.update(endpoint, key, value, before, now);
        }
        for (const k of drops) this.o.onDrop(endpoint, o.commitment, k);
    }

    reportLag(endpoint: string, slots: number): void {
        this.sampleOf(endpoint).set(BEHIND, { slots: Math.max(0, slots), at: this.o.now() });
    }

    mark(endpoint: string, c: Commitment, k: Kind): Mark | null {
        const m = this.marks.get(endpoint)?.get(keyOf(c, k));
        return m === undefined ? null : { ...m };
    }

    projected(endpoint: string, c: Commitment, k: Kind): bigint | null {
        const m = this.marks.get(endpoint)?.get(keyOf(c, k));
        return m === undefined ? null : this.project(m, c, k, this.o.now());
    }

    highWater(c: Commitment, k: Kind): bigint | null {
        let high: bigint | null = null;
        for (const endpoint of this.marks.keys()) {
            for (const at of AT_LEAST[c]) {
                const p = this.projected(endpoint, at, k);
                if (p !== null && (high === null || p > high)) high = p;
            }
        }
        return high;
    }

    floor(c: Commitment, k: Kind, maxLag: number): bigint | null {
        const high = this.highWater(c, k);
        return high === null ? null : high - BigInt(maxLag);
    }

    lag(endpoint: string): number | null {
        const samples = this.samples.get(endpoint);
        if (samples === undefined) return null;
        const from = this.o.now() - this.o.sampleMaxAgeMs;
        let lag: number | null = null;
        for (const s of samples.values()) {
            if (s.at >= from && (lag === null || s.slots > lag)) lag = s.slots;
        }
        return lag;
    }

    // The endpoint's own mark however old, which catches a frozen node, and the live references
    private reference(endpoint: string, c: Commitment, k: Kind, now: number): bigint | null {
        const key = keyOf(c, k);
        let high: bigint | null = null;
        for (const [other, marks] of this.marks) {
            const m = marks.get(key);
            if (m === undefined) continue;
            if (
                other !== endpoint &&
                (now - m.lastSeen > LAG_REFERENCE_MS || !this.o.isReference(other))
            ) {
                continue;
            }
            const p = this.project(m, c, k, now);
            if (high === null || p > high) high = p;
        }
        return high;
    }

    private project(m: Mark, c: Commitment, k: Kind, now: number): bigint {
        // Finality can pause while confirmation goes on
        if (c === "finalized") return m.value;
        const elapsed = Math.min(Math.max(0, now - m.firstSeen), PROJECT_MAX_MS);
        const per = k === "slot" ? SLOT_PROJECT_MS : BLOCK_PROJECT_MS;
        return m.value + BigInt(Math.floor(elapsed / per));
    }

    private update(
        endpoint: string,
        key: string,
        value: bigint,
        before: Mark | null,
        now: number,
    ): void {
        let marks = this.marks.get(endpoint);
        if (marks === undefined) {
            marks = new Map();
            this.marks.set(endpoint, marks);
        }
        if (before === null || value > before.value) {
            marks.set(key, { value, firstSeen: now, lastSeen: now });
        } else {
            before.lastSeen = now;
        }
    }

    private sampleOf(endpoint: string): Map<string, Sample> {
        let samples = this.samples.get(endpoint);
        if (samples === undefined) {
            samples = new Map();
            this.samples.set(endpoint, samples);
        }
        return samples;
    }
}
