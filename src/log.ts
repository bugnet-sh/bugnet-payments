export type AlarmName =
    | "fee_payer_sol_low"
    | "sol_per_order_high"
    | "sol_spent_without_orders"
    | "refund_float_low"
    | "refunds_per_hour_high"
    | "refunds_paused"
    | "inflow_mismatch"
    | "payment_missing_inflow"
    | "manual_queue";

type Fields = Record<string, unknown>;

export interface Log {
    info(msg: string, f?: Fields): void;
    warn(msg: string, f?: Fields): void;
    error(msg: string, f?: Fields): void;
    alarm(name: AlarmName, f?: Fields): void;
}

export const REDACTED_KEYS: ReadonlySet<string> = new Set([
    "claim",
    "claimBox",
    "payment",
    "paymentSignature",
    "payload",
    "orderToken",
    "token",
    "authorization",
    "secret",
    "privateKey",
    "seed",
    "mnemonic",
    "rpcUrl",
    "wire",
    "wireTx",
    "transaction",
    "payment-signature",
    "x-payment",
]);

const REDACTED_LOWER: ReadonlySet<string> = new Set([...REDACTED_KEYS].map((k) => k.toLowerCase()));

const REDACTED = "[redacted]";

function makeScrubber(secrets: readonly string[]): (s: string) => string {
    const list = secrets.filter((s) => s.length > 0);
    return (s) => list.reduce((acc, secret) => acc.split(secret).join(REDACTED), s);
}

function sanitize(value: unknown, scrub: (s: string) => string, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return scrub(value);
    if (typeof value === "bigint") return value.toString();
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Error) {
        return { name: value.name, message: scrub(value.message) };
    }
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    try {
        if (Array.isArray(value)) return value.map((v) => sanitize(v, scrub, seen));
        const out: Fields = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = REDACTED_LOWER.has(k.toLowerCase()) ? REDACTED : sanitize(v, scrub, seen);
        }
        return out;
    } finally {
        seen.delete(value);
    }
}

type Sink = (line: Fields) => void;

function build(service: string, secrets: readonly string[], sink: Sink): Log {
    const scrub = makeScrubber(secrets);
    const emit = (level: string, msg: string, f: Fields = {}, extra: Fields = {}) => {
        const fields = sanitize(f, scrub, new WeakSet()) as Fields;
        sink({
            t: new Date().toISOString(),
            level,
            service,
            msg: scrub(msg),
            ...extra,
            ...fields,
        });
    };
    return {
        info: (msg, f) => emit("info", msg, f),
        warn: (msg, f) => emit("warn", msg, f),
        error: (msg, f) => emit("error", msg, f),
        alarm: (name, f) => emit("alarm", name, f, { alarm: name }),
    };
}

export function jsonLog(
    service: string,
    opts: { secrets?: readonly string[]; write?: (line: string) => void } = {},
): Log {
    const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
    return build(service, opts.secrets ?? [], (line) => write(JSON.stringify(line)));
}

const noop = () => {};
export const silentLog: Log = { info: noop, warn: noop, error: noop, alarm: noop };

export function memoryLog(): Log & { lines: Fields[] } {
    const lines: Fields[] = [];
    return Object.assign(
        build("test", [], (line) => lines.push(line)),
        { lines },
    );
}
