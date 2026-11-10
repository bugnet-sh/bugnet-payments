/**
 * The methods the router knows (spec 5). Kit's own table of options positions is not exported,
 * so the router keeps a copy for these methods.
 */

// Where an answer reports the slot or height it was read at
export type SlotSource = "context" | "slot_result" | "height_result" | "epoch_info" | "none";

export interface MethodSpec {
    readonly kind: "read" | "send";
    // preferred: endpoints with the history role first, then the others (spec 6.1)
    readonly history: "always" | "when_searching" | "preferred" | "never";
    readonly slot: SlotSource;
    readonly optionsAt: number | null;
    readonly retry: boolean;
    // A null answer is asked once more of an endpoint on another domain (spec 8.3)
    readonly nullRetry: boolean;
}

function spec(
    history: MethodSpec["history"],
    slot: SlotSource,
    optionsAt: number | null,
    more: Partial<MethodSpec> = {},
): MethodSpec {
    return Object.freeze({
        kind: "read",
        history,
        slot,
        optionsAt,
        retry: true,
        nullRetry: false,
        ...more,
    });
}

export const METHODS: Readonly<Record<string, MethodSpec>> = Object.freeze({
    getAccountInfo: spec("never", "context", 1),
    getBalance: spec("never", "context", 1),
    getBlockHeight: spec("never", "height_result", 0),
    getBlockTime: spec("preferred", "none", null),
    getEpochInfo: spec("never", "epoch_info", 0),
    getFirstAvailableBlock: spec("always", "none", null),
    getGenesisHash: spec("never", "none", null),
    getIdentity: spec("never", "none", null),
    getLatestBlockhash: spec("never", "context", 0),
    getMinimumBalanceForRentExemption: spec("never", "none", 1),
    getMultipleAccounts: spec("never", "context", 1),
    getSignatureStatuses: spec("when_searching", "context", 1),
    getSignaturesForAddress: spec("always", "none", 1),
    getSlot: spec("never", "slot_result", 0),
    getTokenAccountBalance: spec("never", "context", 1),
    getTransaction: spec("always", "none", 1, { nullRetry: true }),
    simulateTransaction: spec("never", "context", 1),
    // Sends fail over by spec 8.6's own rules, which the transport applies
    sendTransaction: spec("never", "none", 1, { kind: "send" }),
});

// The router cannot know that another method is safe to repeat, so it gets one attempt
export const UNKNOWN_METHOD: MethodSpec = spec("never", "none", null, { retry: false });

export function methodSpec(method: string): MethodSpec {
    return Object.hasOwn(METHODS, method) ? METHODS[method]! : UNKNOWN_METHOD;
}
