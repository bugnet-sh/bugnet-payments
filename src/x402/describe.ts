import type { StoredPin } from "./types.ts";

const PACKAGE_TEXT_CODE_POINTS = 120;

export function usd(micros: number): string {
    const whole = Math.floor(micros / 1e6);
    const fraction = String(micros % 1e6).padStart(6, "0");
    return `$${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

function pinText(p: StoredPin): string {
    if (p.listed === "unlisted" && p.paidPath === null) {
        throw new Error("describeOrder: an unlisted pin has no paid path");
    }
    const where = p.listed === "unlisted" ? `${p.host}${p.paidPath}` : `${p.host}${p.prefix}`;
    const payee = `${p.payTo.slice(0, 4)}...${p.payTo.slice(-4)}`;
    const text = `${where} up to ${usd(p.maxPriceMicros)} pays ${payee}`;
    return p.listed === "unlisted" ? `${text} (unreviewed)` : text;
}

// Never cut: the wallet step approves exactly what this names
export function describeOrder(o: {
    kind: "start" | "allowance";
    packageText: string;
    allowanceMicros: number;
    feeMicros: number;
    pins: readonly StoredPin[];
}): string {
    let text: string;
    if (o.kind === "start") {
        const cut = Array.from(o.packageText).slice(0, PACKAGE_TEXT_CODE_POINTS).join("");
        text = `${cut} + x402 ${usd(o.allowanceMicros)} + ${usd(o.feeMicros)} fee`;
    } else {
        text = `Bugnet x402 ${usd(o.allowanceMicros)}`;
        if (o.feeMicros > 0) text += ` + ${usd(o.feeMicros)} fee`;
    }
    const named = o.pins.filter((p) => p.newPin);
    if (named.length > 0) text += `: ${named.map(pinText).join("; ")}`;
    return text;
}
