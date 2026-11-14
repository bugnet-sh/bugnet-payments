import QRCode from "qrcode";
import type { DepositView } from "../deposits/types.ts";
import type { PublicState } from "../http/public.ts";
import type { OrderKind } from "../orders/types.ts";
import {
    amountLabel,
    decimalAmount,
    depositAsk,
    PAGE_TEXT,
    STATE_LABELS,
    stateStep,
} from "./messages.ts";
import { arrivedMoney, confirmingInFull } from "./live.ts";
import { USDC_ICON } from "./usdc.ts";

export { amountLabel, decimalAmount };

export const CHECKOUT_CSP =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'none'";

export interface CheckoutView {
    orderId: string;
    description: string;
    amountMicros: number;
    state: PublicState;
    pageUrl: string;
    origin: string;
    expiresAt: Date;
    now: Date;
    kind: OrderKind;
    deposit: DepositView | null;
    depositsOffered: boolean;
    refundMinMicros: number;
    settleGraceMs: number;
}

const ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

export function walletLinks(
    pageUrl: string,
    origin: string,
): { phantom: string; solflare: string } {
    const target = encodeURIComponent(pageUrl);
    const ref = encodeURIComponent(origin);
    return {
        phantom: `https://phantom.com/ul/browse/${target}?ref=${ref}`,
        solflare: `https://solflare.com/ul/v1/browse/${target}?ref=${ref}`,
    };
}

export function qrSvg(text: string): Promise<string> {
    return QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
}

// Body text and the wordmark show first, so only those two are preloaded
const PRELOAD = ["manrope-400.woff2", "lexend-deca-200.woff2"]
    .map((f) => `<link rel="preload" href="/fonts/${f}" as="font" type="font/woff2" crossorigin>`)
    .join("\n");

// Values copied from bugnet-website/packages/brand/tokens.css; the second group is this page's own
const STYLE = `
:root {
    color-scheme: dark;

    --bg: #0a0a0a;
    --surface: #111111;
    --surface-hover: #171717;
    --line: #262626;
    --text: #ededed;
    --text-muted: #a1a1a1;
    --accent: #52ffb8;
    --accent-ink: #0a0a0a;
    --accent-2: #fab2ea;
    --warn: #f5c451;

    --frame: 1360px;
    --pad: clamp(20px, 3.4vw, 46px);
    --nav: 62px;
    --ui-size: 14px;
    --ui-line: 20px;
    --fine-size: 12px;
    --fine-line: 16px;
    --lead-size: 15px;
    --lead-line: 24px;
    --wordmark-size: 20px;
    --wordmark-line: 24px;
    --mark: 24px;
    --hairline: 1px;
    --ring: 2px;
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 24px;
    --space-6: 32px;
    --space-7: 48px;

    --font-ui: "Manrope", ui-sans-serif, system-ui, sans-serif;
    --font-head: "Lexend Deca", "Manrope", ui-sans-serif, system-ui, sans-serif;
    --font-mono: "Obel Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;

    /* Wide enough that a Solana address wraps on two lines at most beside the code */
    --column: 520px;
    --box-pad: var(--space-6);
    --amount-size: 40px;
    --amount-line: 48px;
    --control: 44px;
    --field: 48px;
    --address-line: 18px;
    --copy-button: 32px;
    --copy-icon: 16px;
    --wallet-icon: 20px;
    /* Exactly the height of the two labelled fields beside it */
    --qr: calc(2 * (var(--fine-line) + var(--space-1) + var(--field)) + var(--space-3));
    --usdc: #2775ca;
    --usdc-icon: 20px;
    /* Phones scan the code only on a light square */
    --qr-paper: #ffffff;
}
@font-face {
    font-family: "Manrope";
    font-weight: 400;
    font-display: block;
    src: url("/fonts/manrope-400.woff2") format("woff2");
}
@font-face {
    font-family: "Manrope";
    font-weight: 600;
    font-display: block;
    src: url("/fonts/manrope-600.woff2") format("woff2");
}
@font-face {
    font-family: "Lexend Deca";
    font-weight: 200;
    font-display: block;
    src: url("/fonts/lexend-deca-200.woff2") format("woff2");
}
@font-face {
    font-family: "Obel Mono";
    font-weight: 400;
    font-display: block;
    src: url("/fonts/obel-mono-400.woff2") format("woff2");
}
* { box-sizing: border-box; }
/* The script hides blocks whose own rules set a display */
[hidden] { display: none !important; }
html {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-variant-numeric: tabular-nums;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
}
body {
    margin: 0;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
    gap: var(--space-7);
    padding-bottom: var(--space-7);
    background: var(--bg);
    font-size: var(--ui-size);
    line-height: var(--ui-line);
}
:focus-visible { outline: var(--ring) solid var(--accent); outline-offset: var(--ring); }
:focus:not(:focus-visible) { outline: none; }
a { color: inherit; text-decoration: none; }
::selection { background: var(--accent); color: var(--accent-ink); }
button { font: inherit; color: inherit; border-radius: 0; }
p { margin: 0; }

/* An inset shadow draws the hairline, so the band stays exactly --nav tall */
.top { background: var(--bg); box-shadow: inset 0 calc(var(--hairline) * -1) 0 var(--line); }
.top .frame {
    display: flex;
    align-items: center;
    height: var(--nav);
    max-width: var(--frame);
    margin: 0 auto;
    padding: 0 var(--pad);
}
.brand { display: inline-flex; align-items: center; gap: var(--space-2); }
.brand svg { display: block; height: var(--mark); width: auto; flex-shrink: 0; }
.brand span {
    font-family: var(--font-head);
    font-weight: 200;
    font-size: var(--wordmark-size);
    line-height: var(--wordmark-line);
}
/* The website header's link style, at the band's far right */
.legal { display: flex; gap: var(--space-5); margin-left: auto; color: var(--text-muted); }
.legal a:hover { color: var(--text); }

/* Auto margins center the card, and fall to zero when it is taller than the screen */
.box {
    width: calc(100% - 2 * var(--pad));
    max-width: var(--column);
    margin: auto;
    /* As a flex item of the body it would otherwise never shrink below its widest line */
    min-width: 0;
    padding: var(--box-pad);
    border: var(--hairline) solid var(--line);
    background: var(--bg);
}
.description {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--ui-size);
    line-height: var(--ui-line);
    font-weight: 400;
    overflow-wrap: anywhere;
}
.amount { margin-top: var(--space-1); }
.amount-value {
    font-family: var(--font-head);
    font-weight: 200;
    font-size: var(--amount-size);
    line-height: var(--amount-line);
    color: var(--accent-2);
}
.status {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0 var(--space-4);
    margin-top: var(--space-2);
}
.state[data-state="paid"] { color: var(--accent); }
.state[data-state="expired"], .state[data-state="refunded"] { color: var(--text-muted); }
.state[data-state="review"] { color: var(--warn); }
.time { color: var(--text-muted); }
.time time { color: var(--text); }
#deposit-message { margin-top: var(--space-4); }
/* An empty live region stays in the page, so its first line is announced */
#deposit-message:empty, #message:empty, #copy-message:empty, #wallet-note:empty { margin: 0; }

#deposit, #wallet, #phone { margin-top: var(--space-5); }
/* The code and the two fields beside it share one height and one top and bottom edge */
.send { display: flex; gap: var(--space-5); }
.qr { flex: none; margin: 0; }
.qr img, .qr svg { display: block; width: var(--qr); height: var(--qr); background: var(--qr-paper); }
.fields { flex: 1; min-width: 0; }
.pair + .pair { margin-top: var(--space-3); }
.pair .label {
    display: block;
    color: var(--text-muted);
    font-size: var(--fine-size);
    line-height: var(--fine-line);
}
/* A whole field copies its value on click; its icon button is the keyboard's way in */
.field {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--field);
    margin-top: var(--space-1);
    padding: 0 var(--space-1) 0 var(--space-3);
    border: var(--hairline) solid var(--line);
    background: var(--surface);
    cursor: pointer;
}
.field:hover { background: var(--surface-hover); }
.value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* An address is compared by eye, so it shows whole and wraps inside its field */
.value.address {
    padding-block: calc((var(--field) - 2 * var(--address-line)) / 2 - var(--hairline));
    overflow: visible;
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: var(--address-line);
}
.note { margin-top: var(--space-4); color: var(--text-muted); }
.unit { color: var(--text-muted); }
.usdc { display: block; flex: none; width: var(--usdc-icon); height: var(--usdc-icon); }
.copy {
    display: grid;
    flex: none;
    place-items: center;
    width: var(--copy-button);
    height: var(--copy-button);
    margin-left: auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
}
.copy svg { grid-area: 1 / 1; width: var(--copy-icon); height: var(--copy-icon); }
.copy .done, .copy[data-copied] .idle { visibility: hidden; }
.copy[data-copied] .done { visibility: visible; }
.copy[data-copied] { color: var(--accent); }
.copy:hover { color: var(--text); }

.or {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-5);
    color: var(--text-muted);
    font-size: var(--fine-size);
    line-height: var(--fine-line);
}
.or::before, .or::after { content: ""; flex: 1; border-top: var(--hairline) solid var(--line); }

.button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    width: 100%;
    height: var(--control);
    padding: 0 var(--space-4);
    border: var(--hairline) solid var(--line);
    background: var(--bg);
    color: var(--text);
    font-weight: 600;
    cursor: pointer;
}
.button img { display: block; flex: none; width: var(--wallet-icon); height: var(--wallet-icon); }
.button:not(:disabled):hover { background: var(--surface-hover); }
.button:disabled { background: var(--surface); color: var(--text-muted); cursor: default; }
#wallets { display: grid; gap: var(--space-2); margin-top: var(--space-2); }
#wallets:empty { margin: 0; }
#message { margin-top: var(--space-3); }
#wallet-note { margin-top: var(--space-3); color: var(--text-muted); }
#copy-message { margin-top: var(--space-3); color: var(--text-muted); }
/* The app links open this page in a wallet app on the same device, so only touch screens get them */
.mobile-links { display: none; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
#phone .qr { display: flex; align-items: center; gap: var(--space-5); }
#phone figcaption { color: var(--text-muted); }

/* The order's copy icon sits on the same vertical line as the fields' icons above it */
.order {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-5);
    padding: var(--space-3) calc(var(--space-1) + var(--hairline)) 0 0;
    border-top: var(--hairline) solid var(--line);
    color: var(--text-muted);
}
.order .value { color: var(--text); }

@media (hover: none) and (pointer: coarse) {
    .mobile-links { display: grid; }
    #phone .qr { margin-top: var(--space-4); }
}
/* A phone cannot scan its own screen; a tablet's code can still go to a phone */
@media (hover: none) and (pointer: coarse) and (max-width: 720px) {
    .qr { display: none !important; }
}
@media (max-width: 720px) {
    /* The website's phone inset, so the logo, the links and the box's content share their edges */
    :root { --box-pad: var(--pad); }
    .box { width: 100%; max-width: none; padding: var(--space-5) var(--box-pad); border: 0; }
}
/* A short laptop screen keeps the Pay button in view */
@media (min-width: 721px) and (max-height: 760px) {
    body { gap: var(--space-5); padding-bottom: var(--space-5); }
    .box { padding-block: var(--space-5); }
}
@media (max-width: 400px) {
    .send { flex-direction: column; }
}
`;

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="320 264 608 693" aria-hidden="true" focusable="false"><g fill="currentColor">
<path d="M 556 415 C 546 364 514 330 460 309" fill="none" stroke="currentColor" stroke-width="31" stroke-linecap="round"/>
<path d="M 694 415 C 704 364 736 330 790 309" fill="none" stroke="currentColor" stroke-width="31" stroke-linecap="round"/>
<circle cx="440" cy="307" r="43"/>
<circle cx="810" cy="307" r="43"/>
<path fill-rule="evenodd" d="M 446 563 L 446 534 C 446 455 524 393 624 393 C 724 393 802 455 802 534 L 802 563 L 624 640 Z M 573 499 A 31 31 0 1 0 511 499 A 31 31 0 1 0 573 499 Z M 737 499 A 31 31 0 1 0 675 499 A 31 31 0 1 0 737 499 Z"/>
<path d="M 430 501 L 333 547 Q 320 553 320 566 L 320 641 Q 320 653 334 659 L 375 675 L 375 822 Q 375 840 393 849 L 591 946 Q 611 957 611 935 L 611 691 Q 611 677 599 671 L 363 562 L 428 533 Q 426 518 430 501 Z"/>
<path d="M 818 501 L 915 547 Q 928 553 928 566 L 928 641 Q 928 653 914 659 L 873 675 L 873 822 Q 873 840 855 849 L 657 946 Q 637 957 637 935 L 637 691 Q 637 677 649 671 L 885 562 L 820 533 Q 822 518 818 501 Z"/>
</g></svg>`;

// The tab icon, byte for byte bugnet-website/packages/brand/icon.svg, served at /favicon.svg
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" role="img" aria-label="Bugnet">
  <rect width="1254" height="1254" fill="#0A0A0A"/>
  <g fill="#EDEDED">
    <path d="M 556 415 C 546 364 514 330 460 309" fill="none" stroke="#EDEDED" stroke-width="31" stroke-linecap="round"/>
    <path d="M 694 415 C 704 364 736 330 790 309" fill="none" stroke="#EDEDED" stroke-width="31" stroke-linecap="round"/>
    <circle cx="440" cy="307" r="43"/>
    <circle cx="810" cy="307" r="43"/>
    <path fill-rule="evenodd" d="M 446 563 L 446 534 C 446 455 524 393 624 393 C 724 393 802 455 802 534 L 802 563 L 624 640 Z M 573 499 A 31 31 0 1 0 511 499 A 31 31 0 1 0 573 499 Z M 737 499 A 31 31 0 1 0 675 499 A 31 31 0 1 0 737 499 Z"/>
    <path d="M 430 501 L 333 547 Q 320 553 320 566 L 320 641 Q 320 653 334 659 L 375 675 L 375 822 Q 375 840 393 849 L 591 946 Q 611 957 611 935 L 611 691 Q 611 677 599 671 L 363 562 L 428 533 Q 426 518 430 501 Z"/>
    <path d="M 818 501 L 915 547 Q 928 553 928 566 L 928 641 Q 928 653 914 659 L 873 675 L 873 822 Q 873 840 855 849 L 657 946 Q 637 957 637 935 L 637 691 Q 637 677 649 671 L 885 562 L 820 533 Q 822 518 818 501 Z"/>
  </g>
</svg>
`;

const HEADER = `<header class="top"><div class="frame">
<a class="brand" href="https://bugnet.sh/">${MARK}<span>Bugnet</span></a>
<nav class="legal" aria-label="Legal">
<a href="https://bugnet.sh/terms/">Terms</a>
<a href="https://bugnet.sh/privacy/">Privacy</a>
</nav>
</div></header>`;

function page(title: string, main: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${PRELOAD}
<style>${STYLE}</style>
</head>
<body>
${HEADER}
${main}
</body>
</html>
`;
}

const MESSAGE = '<p id="message" role="status" aria-live="polite"></p>';
const SCRIPT = '<script type="module" src="/checkout.js"></script>';
const NOSCRIPT =
    '<noscript><p class="note">This page needs JavaScript to show live status. You can still send to the address above.</p></noscript>';

// Square corners, as everywhere on the page: two sheets for copy, a tick once copied
const COPY_ICONS =
    '<svg class="idle" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><path d="M5.75 5.75h7.5v7.5h-7.5z"/><path d="M10.25 5.75v-3h-7.5v7.5h3"/></svg>' +
    '<svg class="done" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><path d="M2.75 8.25l3.5 3.5 7-7.5"/></svg>';

function copyButton(value: string, label: string, id?: string): string {
    const idAttr = id === undefined ? "" : ` id="${id}"`;
    return `<button${idAttr} class="copy" type="button" data-copy="${escapeHtml(value)}" aria-label="${label}">${COPY_ICONS}</button>`;
}

// m:ss until the deadline, which the script keeps counting down
function timeLeft(expiresAt: Date, now: Date): string {
    const s = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The script shows the wallet once it knows which wallets the browser has: the first on the
// Pay button, any other on a button of its own. The phone part is drawn shown only on a page
// with no address, so a page whose script never runs still offers a way to pay; its code opens
// this page in Phantom and is the page's one QR.
async function walletSections(v: CheckoutView, phoneShown: boolean): Promise<string> {
    const links = walletLinks(v.pageUrl, v.origin);
    const hidden = phoneShown ? "" : " hidden";
    return `<section id="wallet" hidden>
<button id="pay-button" class="button" type="button" disabled>Pay</button>
<div id="wallets"></div>
<p id="wallet-note" role="status" aria-live="polite"></p>
${MESSAGE}
</section>
<section id="phone"${hidden}>
<div class="mobile-links">
<a class="button" href="${escapeHtml(links.phantom)}">Open in Phantom</a>
<a class="button" href="${escapeHtml(links.solflare)}">Open in Solflare</a>
</div>
<figure class="qr"${hidden}>
${await qrSvg(links.phantom)}
<figcaption>Scan with Phantom on your phone</figcaption>
</figure>
</section>`;
}

function depositSection(v: CheckoutView, deposit: DepositView): string {
    const ask = depositAsk(v.amountMicros, deposit);
    const id = escapeHtml(v.orderId);
    // With the price covered the QR route answers 404, so the code waits hidden, unloaded
    const qrHidden = deposit.remainingMicros > 0 ? "" : " hidden";
    const qrLoading = deposit.remainingMicros > 0 ? "" : ' loading="lazy"';
    return `<section id="deposit">
<div class="send">
<figure class="qr"${qrHidden}>
<img src="/o/${id}/qr.svg?r=${deposit.remainingMicros}" data-remaining="${deposit.remainingMicros}"${qrLoading} alt="${ask.alt}">
</figure>
<div class="fields">
<div class="pair">
<span class="label">Amount</span>
<div class="field">${USDC_ICON}<span id="deposit-amount" class="value">${ask.plain}</span><span class="unit">USDC</span>${copyButton(ask.plain, "Copy amount", "deposit-amount-copy")}</div>
</div>
<div class="pair">
<span class="label">Solana address</span>
<div class="field"><span class="value address">${escapeHtml(deposit.address)}</span>${copyButton(deposit.address, "Copy address")}</div>
</div>
</div>
</div>
</section>`;
}

// A deposit in review reads as review before the script runs, and without it
const inReview = (dep: DepositView | null) => dep?.status === "review";

// The label the script would give, so the first paint and a page without the script agree
function stateLabel(state: PublicState, dep: DepositView | null): string {
    if (inReview(dep)) return STATE_LABELS.review;
    if (dep !== null && confirmingInFull(dep)) return STATE_LABELS.settling;
    return STATE_LABELS[state];
}

// The page-level line under the status (spec 15.6, M18, M20, P2 and P3)
function firstLine(v: CheckoutView, dep: DepositView | null): string {
    if (v.state === "unpaid") {
        if (dep === null) return PAGE_TEXT.addressOff;
        if (!inReview(dep)) return "";
        const ctx = {
            amountMicros: v.amountMicros,
            deadline: "",
            refundMinMicros: v.refundMinMicros,
            orderId: v.orderId,
        };
        return escapeHtml(stateStep("review", ctx).message);
    }
    if (v.deposit !== null) return "";
    if (v.state === "settling") return "This page updates when the payment lands.";
    if (v.state === "refunded") return "This order's payment was returned to the wallet that paid.";
    return "";
}

export async function renderCheckout(v: CheckoutView): Promise<string> {
    const amount = amountLabel(v.amountMicros);
    const id = escapeHtml(v.orderId);
    const expires = v.expiresAt.toISOString();
    const unpaid = v.state === "unpaid";
    const dep = unpaid && v.depositsOffered ? v.deposit : null;
    // With the whole price in and confirming, the page asks for nothing while it lands
    const confirming = dep !== null && confirmingInFull(dep);
    // What already arrived, so the Pay buttons name the whole price before any status answer
    const arrived = arrivedMoney(v.state, dep);
    let methods = "";
    if (dep !== null) {
        // Money sent while the deposit is in review cannot pay the order until an operator looks
        const askHidden = inReview(dep) || confirming ? " hidden" : "";
        // The address comes first, as the main way to pay (founder, 2026-11-10); P4 points at it
        methods = `<div id="deposit-ask"${askHidden}>
${depositSection(v, dep)}
<p id="or" class="or" hidden>or</p>
</div>
${await walletSections(v, inReview(dep))}${askHidden === "" ? `\n${NOSCRIPT}` : ""}`;
    } else if (unpaid) {
        methods = await walletSections(v, true);
    } else if (v.state === "settling") {
        methods = MESSAGE;
    }
    const time = unpaid
        ? `<span class="time"${confirming ? " hidden" : ""}><time id="time-left" datetime="${expires}">${timeLeft(v.expiresAt, v.now)}</time> left</span>`
        : "";
    return page(
        `Pay ${amount} to Bugnet`,
        `<main id="checkout" class="box" data-order-id="${id}" data-state="${v.state}" data-amount="${amount}" data-amount-micros="${v.amountMicros}" data-expires-at="${expires}" data-now="${v.now.toISOString()}" data-kind="${v.kind}" data-refund-min-micros="${v.refundMinMicros}" data-settle-grace-ms="${v.settleGraceMs}" data-takes-money="${unpaid && !confirming}" data-arrived-micros="${arrived.micros}" data-arrived-review="${arrived.review}">
<h1 class="description">${escapeHtml(v.description)}</h1>
<p class="amount"><span class="amount-value">${amount}</span></p>
<p class="status"><span id="state" class="state" data-state="${v.state}" role="status" aria-live="polite">${stateLabel(v.state, dep)}</span>${time}</p>
<p id="deposit-message" role="status" aria-live="polite">${firstLine(v, dep)}</p>
${methods}
<div class="order"><span>Order</span><span class="value">${id}</span>${copyButton(v.orderId, "Copy order ID")}</div>
<p id="copy-message" role="status" aria-live="polite"></p>
</main>
${SCRIPT}`,
    );
}

export function renderNotFound(): string {
    return page(
        "Order not found",
        `<main class="box">
<h1 class="description">Order not found.</h1>
<p class="note">Check the link, or ask your agent for a new payment link.</p>
</main>`,
    );
}
