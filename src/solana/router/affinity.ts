/**
 * Which endpoint produced a listing's cursor, and the entry just before it (spec 8.5). Callers
 * pass only a page's last entry as the next before, so only that entry is kept. An endpoint
 * that does not know a cursor answers an empty page, which reads as "history ended".
 */

export interface CursorEntry {
    endpoint: string;
    // The entry before the cursor in that listing; null for the first page's only entry
    predecessor: string | null;
}

const CURSORS_KEPT = 4096;

// One signature can end pages of two addresses, each with its own predecessor
function keyOf(address: string, signature: string): string {
    return JSON.stringify([address, signature]);
}

export class CursorBook {
    // Map order is the use order, oldest first
    private readonly entries = new Map<string, CursorEntry>();

    constructor(private readonly size = CURSORS_KEPT) {}

    remember(
        address: string,
        page: readonly { signature: string }[],
        before: string | null,
        endpoint: string,
    ): void {
        const last = page.at(-1);
        if (last === undefined) return;
        const predecessor = page.length > 1 ? page.at(-2)!.signature : before;
        this.put(keyOf(address, last.signature), { endpoint, predecessor });
    }

    entryOf(address: string, signature: string): CursorEntry | undefined {
        const key = keyOf(address, signature);
        const entry = this.entries.get(key);
        if (entry === undefined) return undefined;
        this.put(key, entry);
        return { ...entry };
    }

    private put(key: string, entry: CursorEntry): void {
        this.entries.delete(key);
        this.entries.set(key, entry);
        if (this.entries.size > this.size) {
            this.entries.delete(this.entries.keys().next().value!);
        }
    }
}
