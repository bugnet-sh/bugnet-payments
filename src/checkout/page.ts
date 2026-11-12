import QRCode from "qrcode";
import type { DepositView } from "../deposits/types.ts";
import type { PublicState } from "../http/public.ts";
import type { OrderKind } from "../orders/types.ts";
import { amountLabel, decimalAmount, depositAsk, STATE_LABELS } from "./messages.ts";
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

    --column: 480px;
    --box-pad: var(--space-6);
    --amount-size: 40px;
    --amount-line: 48px;
    --control: 44px;
    --chip: 40px;
    --copy-button: 24px;
    --wallet-icon: 20px;
    --qr: 136px;
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

.box, .foot {
    width: calc(100% - 2 * var(--pad));
    max-width: var(--column);
    margin-inline: auto;
    /* As flex items of the body they would otherwise never shrink below their widest line */
    min-width: 0;
}
/* Auto margins center the card, and fall to zero when it is taller than the screen */
.box {
    margin-block: auto;
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
.amount {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-3);
    margin-top: var(--space-1);
}
.amount-value {
    font-family: var(--font-head);
    font-weight: 200;
    font-size: var(--amount-size);
    line-height: var(--amount-line);
    color: var(--accent-2);
}
.amount-unit { color: var(--text-muted); }
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
#deposit-message:empty { display: none; }

#wallet, #phone { margin-top: var(--space-5); }
#wallets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    list-style: none;
    margin: 0 0 var(--space-3);
    padding: 0;
}
#wallets li.none { color: var(--text-muted); }
#wallets label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--chip);
    padding: 0 var(--space-3);
    border: var(--hairline) solid var(--line);
    cursor: pointer;
}
#wallets label:hover { background: var(--surface-hover); }
#wallets label:has(input:checked) { border-color: var(--accent); }
#wallets label:has(input:focus-visible) { outline: var(--ring) solid var(--accent); outline-offset: var(--ring); }
/* The radio stays in the page for keyboards and screen readers; the chip's border shows the choice */
#wallets input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
#wallets img, .button img { display: block; width: var(--wallet-icon); height: var(--wallet-icon); }
.button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    width: 100%;
    height: var(--control);
    padding: 0 var(--space-4);
    border: 0;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
    cursor: pointer;
}
.button.outline {
    border: var(--hairline) solid var(--line);
    background: var(--bg);
    color: var(--text);
}
.button.outline:not(:disabled):hover { background: var(--surface-hover); }
/* After .button.outline, whose specificity it shares, so a disabled outline button looks it */
.button:disabled { background: var(--surface); color: var(--text-muted); cursor: default; }
#message { margin-top: var(--space-3); }
#message:empty { display: none; }
.mobile-links { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }

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

#deposit { margin-top: var(--space-5); }
h2 {
    margin: 0 0 var(--space-4);
    font-size: var(--ui-size);
    line-height: var(--ui-line);
    font-weight: 600;
}
.send { display: flex; gap: var(--space-5); align-items: flex-start; }
.qr { flex-shrink: 0; margin: 0; }
.qr img { display: block; width: var(--qr); height: var(--qr); background: var(--qr-paper); }
.pairs { flex: 1; min-width: 0; margin: 0; }
.pairs div + div { margin-top: var(--space-4); }
.pairs dt { color: var(--text-muted); font-size: var(--fine-size); line-height: var(--fine-line); }
.pairs dd {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    margin: var(--space-1) 0 0;
}
/* A payment address is read and compared by eye, so it wraps instead of hiding its end */
code {
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--fine-size);
    line-height: var(--ui-line);
    overflow-wrap: anywhere;
}
/* Centred on the capitals of the text beside it, measured from the baseline, so every engine agrees */
.usdc {
    width: var(--usdc-icon);
    height: var(--usdc-icon);
    flex-shrink: 0;
    vertical-align: -0.3em;
    vertical-align: calc((1cap - var(--usdc-icon)) / 2);
}
.with-usdc .usdc { margin-right: var(--space-2); }
.note { margin-top: var(--space-4); color: var(--text-muted); }
#wallet-note { margin-top: var(--space-3); color: var(--text-muted); }
.copy {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    height: var(--copy-button);
    padding: 0 var(--space-2);
    border: var(--hairline) solid var(--line);
    background: var(--bg);
    color: var(--text-muted);
    font-size: var(--fine-size);
    line-height: var(--fine-line);
    cursor: pointer;
}
/* Both labels share one cell, so the button keeps its width when it says Copied */
.copy span { grid-area: 1 / 1; }
.copy span + span, .copy[data-copied] span:first-child { visibility: hidden; }
.copy[data-copied] span + span { visibility: visible; }
.copy[data-copied] { color: var(--accent); }
.copy:hover { color: var(--text); }

.order {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-top: var(--space-5);
    padding-top: var(--space-4);
    border-top: var(--hairline) solid var(--line);
    color: var(--text-muted);
    font-size: var(--fine-size);
    line-height: var(--fine-line);
}
.order span { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }

.foot {
    display: flex;
    gap: var(--space-5);
    margin: 0 auto var(--space-7);
    /* The box's border plus its padding, so the links start on the content's left edge */
    padding: 0 calc(var(--box-pad) + var(--hairline));
    color: var(--text-muted);
    font-size: var(--fine-size);
    line-height: var(--fine-line);
}
.foot a:hover { color: var(--text); }

/* A phone cannot scan its own screen */
@media (hover: none) and (pointer: coarse) {
    .qr { display: none; }
}
@media (max-width: 720px) {
    /* The website's phone inset, so the logo, the box's content and the footer share one edge */
    :root { --box-pad: var(--pad); }
    .box, .foot { width: 100%; max-width: none; }
    .box { padding: var(--space-5) var(--box-pad); border: 0; }
    .foot { padding: 0 var(--box-pad); }
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

const HEADER = `<header class="top"><div class="frame">
<a class="brand" href="https://bugnet.sh/">${MARK}<span>Bugnet</span></a>
</div></header>`;

const FOOTER = `<footer class="foot">
<a href="https://bugnet.sh/terms/">Terms</a>
<a href="https://bugnet.sh/privacy/">Privacy</a>
</footer>`;

function page(title: string, main: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${PRELOAD}
<style>${STYLE}</style>
</head>
<body>
${HEADER}
${main}
${FOOTER}
</body>
</html>
`;
}

const MESSAGE = '<p id="message" role="status" aria-live="polite"></p>';
const SCRIPT = '<script type="module" src="/checkout.js"></script>';
const NOSCRIPT =
    '<noscript><p class="note">This page needs JavaScript to show live status. You can still send to the address above.</p></noscript>';
const COPY_LABELS = "<span>Copy</span><span>Copied</span>";

function copyButton(value: string, id?: string): string {
    const idAttr = id === undefined ? "" : ` id="${id}"`;
    return `<button${idAttr} class="copy" type="button" data-copy="${escapeHtml(value)}">${COPY_LABELS}</button>`;
}

// m:ss until the deadline, which the script keeps counting down
function timeLeft(expiresAt: Date, now: Date): string {
    const s = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The script shows the wallet sections once it knows which wallets the browser has
function walletSections(v: CheckoutView): string {
    const links = walletLinks(v.pageUrl, v.origin);
    return `<section id="wallet" hidden>
<ul id="wallets" hidden></ul>
<button id="pay-button" class="button" type="button" disabled>Pay</button>
<p id="wallet-note" role="status" hidden></p>
${MESSAGE}
</section>
<section id="phone" hidden>
<div class="mobile-links">
<a class="button outline" href="${escapeHtml(links.phantom)}">Open in Phantom</a>
<a class="button outline" href="${escapeHtml(links.solflare)}">Open in Solflare</a>
</div>
</section>`;
}

function depositSection(v: CheckoutView, deposit: DepositView): string {
    const ask = depositAsk(v.amountMicros, deposit);
    const id = escapeHtml(v.orderId);
    // With the price covered the QR route answers 404, so the code waits hidden, unloaded
    const qrHidden = deposit.remainingMicros > 0 ? "" : " hidden";
    const qrLoading = deposit.remainingMicros > 0 ? "" : ' loading="lazy"';
    // Money sent while the deposit is in review cannot pay the order until an operator looks
    const askHidden = deposit.status === "review" ? " hidden" : "";
    return `<p id="or" class="or" hidden>or</p>
<section id="deposit">
<div id="deposit-ask"${askHidden}>
<h2>Send USDC on Solana</h2>
<div class="send">
<figure class="qr"${qrHidden}>
<img src="/o/${id}/qr.svg?r=${deposit.remainingMicros}" data-remaining="${deposit.remainingMicros}"${qrLoading} alt="${ask.alt}">
</figure>
<dl class="pairs">
<div><dt>Amount</dt><dd><span class="with-usdc">${USDC_ICON}<span id="deposit-amount">${ask.plain} USDC</span></span> ${copyButton(ask.plain, "deposit-amount-copy")}</dd></div>
<div><dt>Address</dt><dd><code>${escapeHtml(deposit.address)}</code> ${copyButton(deposit.address)}</dd></div>
</dl>
</div>
<p id="exchange-note" class="note">${ask.exchange}</p>
</div>
</section>`;
}

// The page-level line for an order that no longer takes money (spec 15.6, P2 and P3)
function closedLine(v: CheckoutView): string {
    if (v.deposit !== null) return "";
    if (v.state === "settling")
        return "The payment is confirming on Solana. This page updates when it lands.";
    if (v.state === "refunded") return "This order's payment was returned to the wallet that paid.";
    return "";
}

export async function renderCheckout(v: CheckoutView): Promise<string> {
    const amount = amountLabel(v.amountMicros);
    const id = escapeHtml(v.orderId);
    const expires = v.expiresAt.toISOString();
    const unpaid = v.state === "unpaid";
    let methods = "";
    if (unpaid) {
        const dep = v.depositsOffered ? v.deposit : null;
        // P4 points at the address, so it comes only with the section that shows one
        methods =
            dep !== null
                ? `${walletSections(v)}\n${depositSection(v, dep)}\n${NOSCRIPT}`
                : walletSections(v);
    } else if (v.state === "settling") {
        methods = MESSAGE;
    }
    const time = unpaid
        ? `<span class="time"><time id="time-left" datetime="${expires}">${timeLeft(v.expiresAt, v.now)}</time> left</span>`
        : "";
    return page(
        `Pay ${amount} to Bugnet`,
        `<main id="checkout" class="box" data-order-id="${id}" data-state="${v.state}" data-amount="${amount}" data-amount-micros="${v.amountMicros}" data-expires-at="${expires}" data-now="${v.now.toISOString()}" data-kind="${v.kind}" data-refund-min-micros="${v.refundMinMicros}" data-settle-grace-ms="${v.settleGraceMs}">
<h1 class="description">${escapeHtml(v.description)}</h1>
<p class="amount">
<span class="amount-value">${amount}</span>
<span class="amount-unit with-usdc">${USDC_ICON}USDC</span>
</p>
<p class="status"><span id="state" class="state" data-state="${v.state}">${STATE_LABELS[v.state]}</span>${time}</p>
<p id="deposit-message" role="status" aria-live="polite">${unpaid ? "" : closedLine(v)}</p>
${methods}
<p class="order"><span>Order <code>${id}</code></span>${copyButton(v.orderId)}</p>
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
