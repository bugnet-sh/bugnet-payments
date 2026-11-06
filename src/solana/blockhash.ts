import type { SolanaRpc } from "./rpc.ts";

export interface BlockhashHint {
    blockhash: string;
    lastValidBlockHeight: bigint;
}

const REMEMBER_MS = 300_000;
const FETCH_TIMEOUT_MS = 3_000;

export class BlockhashCache {
    private current: { hint: BlockhashHint; at: number } | undefined;
    private inflight: Promise<BlockhashHint> | undefined;
    private readonly seen = new Map<string, { lastValidBlockHeight: bigint; at: number }>();

    constructor(
        private readonly rpc: SolanaRpc,
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now,
        private readonly timeoutMs: number = FETCH_TIMEOUT_MS,
    ) {}

    async latest(): Promise<BlockhashHint> {
        if (this.current && this.now() - this.current.at <= this.ttlMs) {
            return this.current.hint;
        }
        this.inflight ??= this.fetch().finally(() => {
            this.inflight = undefined;
        });
        return this.inflight;
    }

    lastValidBlockHeightOf(blockhash: string): bigint | undefined {
        const entry = this.seen.get(blockhash);
        if (!entry || this.now() - entry.at > REMEMBER_MS) {
            return undefined;
        }
        return entry.lastValidBlockHeight;
    }

    private async fetch(): Promise<BlockhashHint> {
        const { value } = await this.rpc
            .getLatestBlockhash()
            .send({ abortSignal: AbortSignal.timeout(this.timeoutMs) });
        const hint: BlockhashHint = {
            blockhash: value.blockhash,
            lastValidBlockHeight: value.lastValidBlockHeight,
        };
        const at = this.now();
        this.current = { hint, at };
        this.seen.set(hint.blockhash, { lastValidBlockHeight: hint.lastValidBlockHeight, at });
        for (const [hash, entry] of this.seen) {
            if (at - entry.at > REMEMBER_MS) {
                this.seen.delete(hash);
            }
        }
        return hint;
    }
}
