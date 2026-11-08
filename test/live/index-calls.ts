/**
 * One real paid x402 call to each seller in docs/mcp-gateway/x402-index-test-calls.json, paid from
 * the test payer, so each seller can go into the gateway's x402 index.
 *
 *   node --import tsx test/live/index-calls.ts [--probe]   unpaid requests only (the default)
 *   set -a; . ./.env; set +a
 *   BUGNET_INDEX_CALLS_PAY=yes node --import tsx test/live/index-calls.ts --pay
 *
 * --out-dir <dir> moves the JSON results (default: ~/.local/state/bugnet-paid/index-calls).
 * The journal stays in that default folder: --pay skips every URL it lists as sent.
 */
import { homedir } from "node:os";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { address, type Address } from "@solana/kit";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { loadTestPayer } from "../../src/keys/test-payer.ts";
import { inspectTokenAccount, usdcAta } from "../../src/solana/accounts.ts";
import { SOLANA_MAINNET, USDC_MINT } from "../../src/solana/constants.ts";
import { createRpc, deadline } from "../../src/solana/rpc.ts";
import { buildSellerPayment, randomSellerMemo, signSellerPayment } from "../../src/x402/build.ts";
import { newPaymentIdentifier } from "../../src/x402/ids.ts";
import { chooseEntry, decodeChallenge, type DecodedChallenge } from "../../src/x402/seller.ts";
import { paymentSignatureHeader } from "../../src/x402/signer.ts";

const LIST = resolve(import.meta.dirname, "../../../docs/mcp-gateway/x402-index-test-calls.json");
// Kept outside the repo and across runs, so the journal outlives any one session
const DEFAULT_OUT = join(homedir(), ".local", "state", "bugnet-paid", "index-calls");
const JOURNAL = join(DEFAULT_OUT, "journal.jsonl");

// Founder-approved caps
const MAX_PER_CALL_MICROS = 80_000n;
const MAX_TOTAL_MICROS = 1_000_000n;
// Dynamic prices drift a little from the listed one
const DRIFT = 1.25;

// Settings defaults the signer uses (src/config.ts [x402])
const COMPUTE_UNIT_LIMIT = 20_000;
const COMPUTE_UNIT_PRICE = 1n;
const SELLER_MEMO_MAX_BYTES = 32;

const PROBE_TIMEOUT_MS = 30_000;
const PAID_TIMEOUT_MS = 180_000;
const PAUSE_MS = 300;

interface Seller {
    url: string;
    method: "GET" | "POST";
    priceUsd: number;
    payTo: string;
    category: string;
}

interface Request {
    query?: Record<string, string>;
    json?: unknown;
    form?: () => FormData;
}

const PROMPT = [{ role: "user", content: "Reply with exactly: OK" }];
const IMAGE_PROMPT = "a small red circle on a white background";
const SEARCH = "x402 payment protocol";

// 1 s, 16 kHz mono 16-bit, a quiet 440 Hz beep: the smallest upload a Whisper API takes
function beepWav(): Uint8Array<ArrayBuffer> {
    const rate = 16_000;
    const data = Buffer.alloc(rate * 2);
    for (let i = 0; i < rate; i++) {
        data.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
    }
    const head = Buffer.alloc(44);
    head.write("RIFF", 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write("WAVEfmt ", 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(rate * 2, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write("data", 36);
    head.writeUInt32LE(data.length, 40);
    return new Uint8Array(Buffer.concat([head, data]));
}

// Smallest request that should still get a real answer; shapes come from each 402's bazaar input
const REQUESTS: Record<string, Request> = {
    "https://agent402.tools/v1/auto/chat/completions": {
        json: { messages: PROMPT, max_tokens: 5 },
    },
    "https://sol.blockrun.ai/api/v1/chat/completions": {
        json: { model: "openai/gpt-4o-mini", messages: PROMPT, max_tokens: 5 },
    },
    "https://ask.singitai.app/v1/chat/completions": {
        json: { model: "gemma-3-4b-it", messages: PROMPT, max_tokens: 5 },
    },
    "https://api.chit402.com/v1/chat/completions": {
        json: { model: "xfuel/auto", messages: PROMPT, max_tokens: 5 },
    },
    "https://glim.sh/api/v1/inference/v1/chat/completions": {
        json: { model: "qwen/qwen-2.5-7b-instruct", messages: PROMPT, max_tokens: 5 },
    },
    "https://agent402.tools/v1/embeddings": { json: { input: "hi" } },
    "https://ask.singitai.app/v1/embeddings": { json: { model: "venice-embed-1", input: "hi" } },
    "https://netintel.dev/v1/embeddings": {
        json: { model: "text-embedding-3-small", input: "hi" },
    },
    "https://x402engine.app/api/embeddings": { json: { text: "hi" } },
    "https://x402engine.app/api/tts/elevenlabs": {
        json: {
            text: "Hi.",
            voice_id: "21m00Tcm4TlvDq8ikWAM",
            model_id: "eleven_multilingual_v2",
            format: "mp3_44100_128",
        },
    },
    "https://agent402.tools/v1/audio/speech": { json: { input: "Hi.", voice: "alloy" } },
    "https://ask.singitai.app/v1/audio/speech": {
        json: {
            model: "venice-kokoro-tts",
            input: "Hi.",
            voice: "af_heart",
            response_format: "mp3",
        },
    },
    "https://www.trezalabs.com/api/x402/speech": {
        json: { text: "Hi.", voice: "george", model: "eleven-multilingual-v2" },
    },
    "https://agent402.tools/v1/audio/transcriptions": {
        form: () => {
            const f = new FormData();
            f.append("file", new Blob([beepWav()], { type: "audio/wav" }), "beep.wav");
            f.append("language", "en");
            return f;
        },
    },
    // The sellers' own sample files, the most stable public audio each one is known to read
    "https://agentsvc.io/api/v1/proxy/audio-transcribe": {
        json: { audio_url: "https://agentsvc.io/samples/speech-en.mp3", model: "base" },
    },
    "https://tanod.dev/v1/audio/transcribe": {
        json: { url: "https://tanod.dev/samples/speech-sample.mp3", language: "en" },
    },
    // Takes a video page, not an audio file: "Me at the zoo", 19 s, YouTube's first upload
    "https://api.x-402.online/v1/transcribe": {
        query: { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
    },
    "https://agent402.tools/v1/images/generations": { json: { prompt: IMAGE_PROMPT, n: 1 } },
    "https://fal.x402.paysponge.com/fal-ai/flux/schnell": {
        json: {
            prompt: IMAGE_PROMPT,
            image_size: "square",
            num_inference_steps: 1,
            num_images: 1,
        },
    },
    "https://x402.aispace.bot/api/v1/image/generate": {
        json: { model: "venice-sd35", prompt: IMAGE_PROMPT, width: 512, height: 512 },
    },
    "https://api.delx.ai/api/v1/x402/image": {
        json: { prompt: IMAGE_PROMPT, aspect_ratio: "1:1", quality_profile: "raw" },
    },
    "https://www.trezalabs.com/api/x402/image": {
        json: { prompt: IMAGE_PROMPT, model: "gpt-image-2", quality: "low", aspectRatio: "1:1" },
    },
    "https://stableenrich.dev/api/exa/search": {
        json: { query: SEARCH, numResults: 1, type: "auto" },
    },
    "https://api.exa.ai/search": { json: { query: SEARCH, numResults: 1, type: "auto" } },
    "https://agent402.tools/api/search": { query: { q: SEARCH, count: "1" } },
    "https://agentbit.app/v1/web/search": { json: { query: SEARCH, limit: 1 } },
    "https://pplx.x402.paysponge.com/search": {
        json: { query: SEARCH, max_results: 1, max_tokens_per_page: 256 },
    },
};

interface Offer {
    amountMicros: string;
    payTo: string;
    feePayer: string | null;
}

interface Probe {
    url: string;
    status: number | null;
    v2Header: boolean;
    v1Body: boolean;
    offer: Offer | null;
    wouldPay: boolean;
    reason: string;
    preview: string;
    ms: number;
}

interface Planned {
    seller: Seller;
    challenge: DecodedChallenge;
    index: number;
    amountMicros: bigint;
}

type Paid = "settled" | "rejected" | "uncertain" | "skipped";

interface CallResult {
    url: string;
    offeredMicros: string | null;
    paid: Paid;
    note: string;
    httpStatus: number | null;
    paymentResponse: { success: boolean; transaction: string | null } | null;
    preview: string;
    ms: number;
}

function capMicros(s: Seller): bigint {
    const listed = BigInt(Math.ceil(s.priceUsd * 1e6 * DRIFT));
    return listed < MAX_PER_CALL_MICROS ? listed : MAX_PER_CALL_MICROS;
}

function target(s: Seller, r: Request): string {
    const u = new URL(s.url);
    for (const [k, v] of Object.entries(r.query ?? {})) u.searchParams.set(k, v);
    return u.href;
}

// The same bytes and headers for the probe and the paid request, so the quote matches the call
function init(s: Seller, r: Request, payment: string | null, timeoutMs: number): RequestInit {
    const headers: Record<string, string> = { accept: "application/json" };
    let body: BodyInit | undefined;
    if (r.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(r.json);
    } else if (r.form !== undefined) {
        body = r.form();
    }
    if (payment !== null) headers["payment-signature"] = payment;
    // Never followed: a redirect could resend the signed payment to another host
    return {
        method: s.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
    };
}

// Only body text, never headers: a binary answer is summed up by its type and size
async function readBody(res: Response): Promise<{ text: string; preview: string }> {
    const type = res.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (/^(audio|image|video)\/|octet-stream/.test(type)) {
        return { text: "", preview: `<${type}, ${bytes.length} bytes>` };
    }
    const text = new TextDecoder().decode(bytes);
    return { text, preview: text.replace(/\s+/g, " ").slice(0, 200) };
}

function solanaOffer(c: DecodedChallenge): Offer | null {
    for (const { value } of c.accepts) {
        const e = value as {
            scheme?: unknown;
            network?: unknown;
            asset?: unknown;
            amount?: unknown;
            payTo?: unknown;
            extra?: { feePayer?: unknown };
        };
        if (e.scheme !== "exact" || e.network !== SOLANA_MAINNET || e.asset !== USDC_MINT) continue;
        return {
            amountMicros: String(e.amount),
            payTo: String(e.payTo),
            feePayer: typeof e.extra?.feePayer === "string" ? e.extra.feePayer : null,
        };
    }
    return null;
}

function isV1Body(text: string): boolean {
    try {
        const doc = JSON.parse(text) as { x402Version?: unknown; accepts?: unknown };
        return doc.x402Version === 1 && Array.isArray(doc.accepts);
    } catch {
        return false;
    }
}

// The product's own entry checks (seller.ts) with this run's pin: listed payTo and the caps.
// The test payer goes in the refused set, so it can be neither payee nor fee payer.
async function probe(
    s: Seller,
    payer: Address | null,
): Promise<{ probe: Probe; plan: Planned | null }> {
    const r = REQUESTS[s.url];
    const start = Date.now();
    const out: Probe = {
        url: s.url,
        status: null,
        v2Header: false,
        v1Body: false,
        offer: null,
        wouldPay: false,
        reason: "",
        preview: "",
        ms: 0,
    };
    const done = (reason: string, plan: Planned | null = null) => {
        out.reason = reason;
        out.wouldPay = plan !== null;
        out.ms = Date.now() - start;
        return { probe: out, plan };
    };
    if (r === undefined) return done("no request body in the table");
    let res: Response;
    try {
        res = await fetch(target(s, r), init(s, r, null, PROBE_TIMEOUT_MS));
    } catch (err) {
        return done(`request failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
    out.status = res.status;
    const header = res.headers.get("payment-required");
    out.v2Header = header !== null;
    let body: { text: string; preview: string };
    try {
        body = await readBody(res);
    } catch (err) {
        return done(`body read failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
    out.preview = body.preview;
    out.v1Body = isV1Body(body.text);
    if (res.status !== 402) return done(`answered ${res.status}, not 402`);
    if (header === null) return done(out.v1Body ? "v1 body only" : "no PAYMENT-REQUIRED header");
    const c = decodeChallenge(header);
    if ("refusal" in c) return done(c.refusal);
    out.offer = solanaOffer(c);
    const choice = chooseEntry(
        c,
        {
            payTo: s.payTo,
            maxPriceMicros: Number(capMicros(s)),
            maxPricePerCallMicros: Number(MAX_PER_CALL_MICROS),
            blocked: new Set(),
        },
        {
            bugnet: new Set(payer === null ? [] : [payer]),
            sellerMemoMaxBytes: SELLER_MEMO_MAX_BYTES,
        },
    );
    if (!choice.ok) {
        return done(`${choice.code} (asked ${choice.askedMicros}, cap ${capMicros(s)})`);
    }
    return done("ok", {
        seller: s,
        challenge: c,
        index: choice.index,
        amountMicros: choice.entry.amountMicros,
    });
}

// The 402's payment-identifier offer, read as signer.ts reads it
function identifierOffer(c: DecodedChallenge): { required: boolean; schema: unknown } | null {
    const offer = c.extensions?.["payment-identifier"];
    if (typeof offer !== "object" || offer === null || Array.isArray(offer)) return null;
    const { info, schema } = offer as { info?: { required?: unknown }; schema?: unknown };
    return { required: info?.required === true, schema: schema ?? {} };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Append-only and synchronous, so a "sending" line is on disk before the paid request leaves
function journal(line: Record<string, unknown>): void {
    mkdirSync(DEFAULT_OUT, { recursive: true });
    appendFileSync(JOURNAL, JSON.stringify(line) + "\n");
}

// Every URL with a "sending" line may have been paid; a line that does not read stops the run
function attempted(): Map<string, bigint> {
    const out = new Map<string, bigint>();
    if (!existsSync(JOURNAL)) return out;
    const lines = readFileSync(JOURNAL, "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
        if (line.trim() === "") continue;
        const bad = new Error(`${JOURNAL} line ${i + 1} does not read: fix it before paying`);
        let doc: unknown;
        try {
            doc = JSON.parse(line);
        } catch {
            throw bad;
        }
        if (typeof doc !== "object" || doc === null) throw bad;
        const { url, offeredMicros, phase } = doc as Record<string, unknown>;
        if (phase !== "sending") continue;
        if (typeof url !== "string" || typeof offeredMicros !== "string") throw bad;
        if (!/^\d+$/.test(offeredMicros)) throw bad;
        out.set(url, (out.get(url) ?? 0n) + BigInt(offeredMicros));
    }
    return out;
}

function list(): Seller[] {
    return JSON.parse(readFileSync(LIST, "utf8")) as Seller[];
}

function stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function outDir(argv: string[]): string {
    const i = argv.indexOf("--out-dir");
    const dir = i >= 0 && argv[i + 1] ? argv[i + 1]! : DEFAULT_OUT;
    mkdirSync(dir, { recursive: true });
    return dir;
}

async function probeAll(sellers: Seller[], payer: Address | null) {
    const results: { probe: Probe; plan: Planned | null }[] = [];
    for (const s of sellers) {
        results.push(await probe(s, payer));
        await sleep(PAUSE_MS);
    }
    return results;
}

async function runProbe(argv: string[]): Promise<void> {
    const sellers = list();
    const results = await probeAll(sellers, null);
    let planned = 0n;
    for (const { probe: p, plan } of results) {
        if (plan) planned += plan.amountMicros;
        const offer = p.offer ? `${p.offer.amountMicros} micros` : "no offer";
        console.log(`${p.wouldPay ? "PAY " : "SKIP"} ${p.status ?? "---"} ${offer} ${p.url}`);
        if (!p.wouldPay) console.log(`     ${p.reason}`);
    }
    const would = results.filter((r) => r.plan !== null).length;
    console.log(`would pay ${would} of ${sellers.length}, planned ${planned} micros`);
    console.log("fee payer vs test payer is checked only in --pay, which loads the key");
    const file = join(outDir(argv), `probe-${stamp()}.json`);
    writeFileSync(
        file,
        JSON.stringify(
            results.map((r) => r.probe),
            null,
            4,
        ),
    );
    console.log(`wrote ${file}`);
}

async function payOne(
    p: Planned,
    signer: NonNullable<Awaited<ReturnType<typeof loadTestPayer>>>,
    rpc: ReturnType<typeof createRpc>,
): Promise<CallResult> {
    const s = p.seller;
    const r = REQUESTS[s.url]!;
    const entry = p.challenge.accepts[p.index]!;
    const memoText = (entry.value as { extra?: { memo?: unknown } }).extra?.memo;
    const { value: latest } = await rpc
        .getLatestBlockhash({ commitment: "confirmed" })
        .send(deadline(15_000));
    // Like signer.ts: our own fresh blockhash, sellers' blockhash hints are not used
    const tx = buildSellerPayment({
        feePayer: address((entry.value as { extra: { feePayer: string } }).extra.feePayer),
        hotTokenAccount: await usdcAta(signer.address),
        destination: await usdcAta(address(s.payTo)),
        authority: signer.address,
        amount: p.amountMicros,
        memo:
            typeof memoText === "string" ? new TextEncoder().encode(memoText) : randomSellerMemo(),
        computeUnitLimit: COMPUTE_UNIT_LIMIT,
        computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
    });
    const signed = await signSellerPayment(tx, signer);
    const offer = identifierOffer(p.challenge);
    const header = paymentSignatureHeader({
        resourceJson: p.challenge.resourceJson,
        acceptedJson: entry.json,
        wireBase64: signed.wireBase64,
        paymentIdentifier: offer === null ? null : { id: newPaymentIdentifier(), ...offer },
    });
    // Throws before anything is sent if the line cannot be written
    journal({
        url: s.url,
        offeredMicros: p.amountMicros.toString(),
        at: new Date().toISOString(),
        phase: "sending",
    });
    const start = Date.now();
    const result: CallResult = {
        url: s.url,
        offeredMicros: p.amountMicros.toString(),
        paid: "uncertain",
        note: "",
        httpStatus: null,
        paymentResponse: null,
        preview: "",
        ms: 0,
    };
    try {
        const res = await fetch(target(s, r), init(s, r, header, PAID_TIMEOUT_MS));
        result.httpStatus = res.status;
        const raw = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
        if (raw !== null) {
            try {
                const pr = decodePaymentResponseHeader(raw);
                result.paymentResponse = {
                    success: pr.success,
                    transaction: pr.transaction || null,
                };
            } catch {
                result.note = "PAYMENT-RESPONSE did not decode";
            }
        }
        if (res.status >= 300 && res.status < 400) {
            // The seller may have settled before redirecting, so it stays uncertain
            const where = res.headers.get("location");
            result.note =
                `answered ${res.status}, ` +
                `${where === null ? "no Location header" : `Location ${where}`}: not followed`;
        } else if (result.paymentResponse?.success) result.paid = "settled";
        else if (res.status === 402) result.paid = "rejected";
        else result.note ||= "no settled PAYMENT-RESPONSE: check the payer's history";
        result.preview = (await readBody(res)).preview;
    } catch (err) {
        // Sent and then cut off: the seller may have settled, so it counts as spent
        const why = err instanceof Error ? err.message : "unknown";
        result.note = `${result.httpStatus === null ? "no answer" : "body cut off"}: ${why}`;
    }
    result.ms = Date.now() - start;
    return result;
}

async function runPay(argv: string[]): Promise<void> {
    if (process.env.BUGNET_INDEX_CALLS_PAY !== "yes") {
        throw new Error("--pay needs BUGNET_INDEX_CALLS_PAY=yes as well");
    }
    const rpcUrl = (process.env.BUGNET_SOLANA_RPC_URL ?? "").trim();
    if (rpcUrl === "") throw new Error("BUGNET_SOLANA_RPC_URL is not set");
    const signer = await loadTestPayer(process.env);
    if (signer === null) {
        throw new Error("BUGNET_TEST_PAYER_KEY or BUGNET_TEST_PAYER_MNEMONIC is not set");
    }
    const rpc = createRpc(rpcUrl);

    // Earlier runs count toward the same total cap
    const prior = attempted();
    let priorMicros = 0n;
    for (const [url, micros] of prior) {
        console.log(`SKIP ${url}: already attempted (${micros} micros), see ${JOURNAL}`);
        priorMicros += micros;
    }
    const sellers = list().filter((s) => !prior.has(s.url));

    const first = await probeAll(sellers, signer.address);
    let planned = 0n;
    const plan: Seller[] = [];
    for (const { probe: p, plan: ok } of first) {
        if (ok === null) {
            console.log(`SKIP ${p.url}: ${p.reason}`);
        } else if (priorMicros + planned + ok.amountMicros > MAX_TOTAL_MICROS) {
            console.log(`SKIP ${p.url}: would pass the ${MAX_TOTAL_MICROS} micros total`);
        } else {
            planned += ok.amountMicros;
            plan.push(ok.seller);
        }
    }
    const account = await inspectTokenAccount(rpc, await usdcAta(signer.address), deadline(15_000));
    const balance = account?.amount ?? 0n;
    console.log(
        `planned ${plan.length} calls, ${planned} micros; earlier runs ${priorMicros} micros; ` +
            `test payer holds ${balance}`,
    );
    if (balance < planned) throw new Error("test payer USDC balance is below the planned total");

    const results: CallResult[] = [];
    let committed = priorMicros;
    for (const s of sellers) {
        if (!plan.includes(s)) continue;
        // A fresh quote: some sellers put a per-request nonce and expiry in the 402
        const { probe: p, plan: fresh } = await probe(s, signer.address);
        const skip = (note: string) =>
            results.push({
                url: s.url,
                offeredMicros: p.offer?.amountMicros ?? null,
                paid: "skipped",
                note,
                httpStatus: p.status,
                paymentResponse: null,
                preview: "",
                ms: 0,
            });
        if (fresh === null) {
            skip(`re-probe: ${p.reason}`);
        } else if (committed + fresh.amountMicros > MAX_TOTAL_MICROS) {
            skip(`would pass the ${MAX_TOTAL_MICROS} micros total`);
        } else {
            // Counted before sending: a lost answer may still have settled
            committed += fresh.amountMicros;
            let res: CallResult;
            try {
                res = await payOne(fresh, signer, rpc);
            } catch (err) {
                // Failed before the request left (RPC or signing): nothing was sent
                committed -= fresh.amountMicros;
                skip(`not sent: ${err instanceof Error ? err.message : "unknown"}`);
                continue;
            }
            results.push(res);
            try {
                journal({ ...res, phase: "result" });
            } catch (err) {
                // The "sending" line is already there, so a rerun still skips this URL
                const why = err instanceof Error ? err.message : "unknown";
                console.error(`journal result line not written for ${s.url}: ${why}`);
            }
        }
        const last = results.at(-1)!;
        const tx = last.paymentResponse?.transaction ?? "-";
        console.log(
            `${last.paid.padEnd(9)} ${last.httpStatus ?? "---"} ` +
                `${last.offeredMicros ?? "-"} micros ${last.ms} ms tx ${tx} ${last.url}` +
                (last.note ? ` (${last.note})` : ""),
        );
        await sleep(PAUSE_MS);
    }

    const sum = (k: Paid) =>
        results.filter((r) => r.paid === k).reduce((a, r) => a + BigInt(r.offeredMicros!), 0n);
    console.log(
        `settled ${sum("settled")} micros, uncertain ${sum("uncertain")} micros, ` +
            `rejected ${sum("rejected")} micros (sent, seller said 402)`,
    );
    const file = join(outDir(argv), `results-${stamp()}.json`);
    writeFileSync(
        file,
        JSON.stringify(
            {
                priorMicros: priorMicros.toString(),
                plannedMicros: planned.toString(),
                settledMicros: sum("settled").toString(),
                uncertainMicros: sum("uncertain").toString(),
                calls: results,
            },
            null,
            4,
        ),
    );
    console.log(`wrote ${file}`);
}

const argv = process.argv.slice(2);
await (argv.includes("--pay") ? runPay(argv) : runProbe(argv));
