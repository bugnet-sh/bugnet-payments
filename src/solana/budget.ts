import type { Log } from "../log.ts";
import type { SolanaRpc } from "./rpc.ts";

const HOUR_MS = 3_600_000;

export function countingRpc(
    rpc: SolanaRpc,
    o: { limitPerHour: number; log: Log; now: () => number },
): SolanaRpc {
    let sends: number[] = [];
    let alarmed = false;
    const record = () => {
        const now = o.now();
        sends = sends.filter((t) => now - t <= HOUR_MS);
        sends.push(now);
        if (sends.length <= o.limitPerHour) {
            alarmed = false;
        } else if (!alarmed) {
            alarmed = true;
            o.log.alarm("x402_rpc_budget", { calls: sends.length, limitPerHour: o.limitPerHour });
        }
    };
    return new Proxy(rpc, {
        get(target, prop, receiver) {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
                const pending = (
                    value as (...a: unknown[]) => { send: (...s: unknown[]) => unknown }
                ).apply(target, args);
                return {
                    ...pending,
                    send: (...s: unknown[]) => {
                        record();
                        return pending.send(...s);
                    },
                };
            };
        },
    });
}
