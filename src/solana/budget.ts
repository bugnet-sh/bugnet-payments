import type { Log } from "../log.ts";
import type { SolanaRpc } from "./rpc.ts";

const HOUR_MS = 3_600_000;

export function countingRpc(
    rpc: SolanaRpc,
    o: {
        limitPerHour: number;
        log: Log;
        now: () => number;
        alarm?: "x402_rpc_budget" | "deposit_rpc_budget";
    },
): SolanaRpc {
    const alarm = o.alarm ?? "x402_rpc_budget";
    const sends: number[] = [];
    let head = 0;
    let alarmed = false;
    const record = () => {
        const now = o.now();
        while (head < sends.length && now - sends[head]! > HOUR_MS) head++;
        if (head > 1024) {
            sends.splice(0, head);
            head = 0;
        }
        sends.push(now);
        const calls = sends.length - head;
        if (calls <= o.limitPerHour) {
            alarmed = false;
        } else if (!alarmed) {
            alarmed = true;
            o.log.alarm(alarm, { calls, limitPerHour: o.limitPerHour });
        }
    };
    const counted = (fn: unknown, self: unknown) => {
        return (...args: unknown[]) => {
            record();
            return (fn as (...a: unknown[]) => unknown).apply(self, args);
        };
    };
    return new Proxy(rpc, {
        get(target, prop, receiver) {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
                const pending: unknown = (value as (...a: unknown[]) => unknown).apply(
                    target,
                    args,
                );
                if (
                    pending === null ||
                    typeof pending !== "object" ||
                    typeof (pending as { send?: unknown }).send !== "function"
                ) {
                    return pending;
                }
                const p = pending as { send: unknown; reactiveStore?: unknown };
                const wrapped: Record<string, unknown> = {
                    ...p,
                    send: counted(p.send, pending),
                };
                if (typeof p.reactiveStore === "function") {
                    wrapped.reactiveStore = counted(p.reactiveStore, pending);
                }
                return wrapped;
            };
        },
    });
}
