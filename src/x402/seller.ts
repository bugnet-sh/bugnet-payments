import { isCanonicalAddress } from "../solana/base58.ts";
import { SOLANA_MAINNET, USDC_MINT } from "../solana/constants.ts";
import type { SellerCheckCode, SignerRefusal } from "./types.ts";

export interface SellerRules {
    bugnet: ReadonlySet<string>;
    sellerMemoMaxBytes: number;
}

// json: the entry's source text byte for byte
export interface AcceptedEntry {
    amountMicros: bigint;
    payTo: string;
    feePayer: string;
    memo: string | null;
    json: string;
}

export type EntryCheck =
    { ok: true; entry: AcceptedEntry } | { ok: false; code: SellerCheckCode; passed: number };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_HEADER = 32_768;
const MAX_ACCEPTS = 32;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const AMOUNT = /^[1-9][0-9]*$/;

export function checkEntry(raw: unknown, json: string, rules: SellerRules): EntryCheck {
    const fail = (code: SellerCheckCode, passed: number): EntryCheck => ({
        ok: false,
        code,
        passed,
    });
    const e: Obj = isObj(raw) ? raw : {};
    if (!isObj(raw) || e.network !== SOLANA_MAINNET) return fail("network_unsupported", 0);
    if (e.asset !== USDC_MINT) return fail("network_unsupported", 1);
    if (e.scheme !== "exact") return fail("flow_unsupported", 2);
    if (typeof e.amount !== "string" || !AMOUNT.test(e.amount)) {
        return fail("price_above_max", 3);
    }
    const payable = (a: unknown): a is string =>
        typeof a === "string" && isCanonicalAddress(a) && !rules.bugnet.has(a);
    if (!payable(e.payTo)) return fail("payee_refused", 4);
    if (!isObj(e.extra) || !payable(e.extra.feePayer)) return fail("fee_payer_refused", 5);
    const x = e.extra;
    if (x.splits !== undefined && !(Array.isArray(x.splits) && x.splits.length === 0)) {
        return fail("splits_unsupported", 6);
    }
    if (x.paymentFlow !== undefined && x.paymentFlow !== "authorization") {
        if (x.paymentFlow !== "upfront") return fail("flow_unsupported", 7);
    }
    if (x.assetTransferMethod !== undefined && x.assetTransferMethod !== "default") {
        return fail("flow_unsupported", 8);
    }
    if (x.transactionVersions !== undefined) {
        if (!Array.isArray(x.transactionVersions) || !x.transactionVersions.includes(0)) {
            return fail("flow_unsupported", 9);
        }
    }
    if (x.ataCreationRequired === true) return fail("ata_creation_unsupported", 10);
    if (x.memo !== undefined) {
        if (
            typeof x.memo !== "string" ||
            Buffer.byteLength(x.memo, "utf8") > rules.sellerMemoMaxBytes
        ) {
            return fail("flow_unsupported", 11);
        }
    }
    return {
        ok: true,
        entry: {
            amountMicros: BigInt(e.amount),
            payTo: e.payTo,
            feePayer: x.feePayer as string,
            memo: typeof x.memo === "string" ? x.memo : null,
            json,
        },
    };
}

// Reads only text that JSON.parse accepted, so it never validates
export function rawMembers(json: string): { resource: string | null; accepts: string[] } {
    let i = 0;
    const ws = () => {
        while (" \t\n\r".includes(json[i] ?? "x")) i++;
    };
    const skipString = () => {
        i++;
        while (json[i] !== '"') i += json[i] === "\\" ? 2 : 1;
        i++;
    };
    const skipValue = () => {
        const c = json[i];
        if (c === '"') return skipString();
        if (c === "{" || c === "[") {
            let depth = 0;
            do {
                const d = json[i];
                if (d === '"') {
                    skipString();
                    continue;
                }
                if (d === "{" || d === "[") depth++;
                if (d === "}" || d === "]") depth--;
                i++;
            } while (depth > 0);
            return;
        }
        while (i < json.length && !",}] \t\n\r".includes(json[i]!)) i++;
    };
    let resource: string | null = null;
    let accepts: string[] = [];
    ws();
    i++;
    ws();
    while (json[i] !== "}") {
        const keyStart = i;
        skipString();
        const key = JSON.parse(json.slice(keyStart, i)) as string;
        ws();
        i++;
        ws();
        const start = i;
        if (key === "accepts") {
            accepts = [];
            if (json[i] === "[") {
                i++;
                ws();
                while (json[i] !== "]") {
                    const elStart = i;
                    skipValue();
                    accepts.push(json.slice(elStart, i));
                    ws();
                    if (json[i] === ",") i++;
                    ws();
                }
                i++;
            } else {
                skipValue();
            }
        } else {
            skipValue();
            if (key === "resource") resource = json.slice(start, i);
        }
        ws();
        if (json[i] === ",") i++;
        ws();
    }
    return { resource, accepts };
}

export interface DecodedChallenge {
    resourceJson: string;
    accepts: { value: unknown; json: string }[];
    extensions: Record<string, unknown> | null;
}

export function decodeChallenge(
    header: string,
): DecodedChallenge | { refusal: "not_x402" | "version_unsupported" } {
    const notX402 = { refusal: "not_x402" } as const;
    if (header.length > MAX_HEADER || header === "" || !BASE64.test(header)) return notX402;
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            Buffer.from(header, "base64"),
        );
    } catch {
        return notX402;
    }
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch {
        return notX402;
    }
    if (!isObj(doc)) return notX402;
    if (!Array.isArray(doc.accepts) || doc.accepts.length > MAX_ACCEPTS) return notX402;
    if (doc.resource === undefined) return notX402;
    if (doc.x402Version !== 2) return { refusal: "version_unsupported" };
    const raw = rawMembers(text);
    return {
        resourceJson: raw.resource ?? "",
        accepts: doc.accepts.map((value: unknown, i: number) => ({
            value,
            json: raw.accepts[i] ?? "",
        })),
        extensions: isObj(doc.extensions) ? doc.extensions : null,
    };
}

export interface PinTerms {
    payTo: string;
    maxPriceMicros: number;
    maxPricePerCallMicros: number;
    blocked: ReadonlySet<string>;
}

export type Choice =
    | { ok: true; index: number; entry: AcceptedEntry }
    // askedMicros is 0n when no amount was read
    | { ok: false; code: SignerRefusal; askedMicros: bigint };

export function chooseEntry(c: DecodedChallenge, pin: PinTerms, rules: SellerRules): Choice {
    const ceiling = BigInt(Math.min(pin.maxPriceMicros, pin.maxPricePerCallMicros));
    let best: { code: SignerRefusal; passed: number; asked: bigint } | null = null;
    for (const [index, { value, json }] of c.accepts.entries()) {
        const r = checkEntry(value, json, rules);
        let code: SignerRefusal;
        let passed: number;
        let asked = 0n;
        if (!r.ok) {
            ({ code, passed } = r);
            if (passed > 3) asked = BigInt((value as Obj).amount as string);
        } else {
            const { entry } = r;
            asked = entry.amountMicros;
            if (entry.payTo !== pin.payTo) {
                [code, passed] = ["payee_changed", 12];
            } else if (pin.blocked.has(entry.payTo)) {
                [code, passed] = ["payto_blocked", 13];
            } else if (entry.amountMicros > ceiling) {
                [code, passed] = ["price_above_max", 14];
            } else {
                return { ok: true, index, entry };
            }
        }
        if (best === null || passed > best.passed) best = { code, passed, asked };
    }
    if (best === null) return { ok: false, code: "network_unsupported", askedMicros: 0n };
    return { ok: false, code: best.code, askedMicros: best.asked };
}
