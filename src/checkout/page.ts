import QRCode from "qrcode";
import type { DepositView } from "../deposits/types.ts";
import type { PublicState } from "../http/public.ts";
import type { OrderKind } from "../orders/types.ts";
import { amountLabel, decimalAmount, STATE_LABELS } from "./messages.ts";
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
    --row: 40px;
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
    --copy-button: 24px;
    --wallet-row: 48px;
    --wallet-icon: 24px;
    --qr: 192px;
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
    font-size: var(--lead-size);
    line-height: var(--lead-line);
    font-weight: 400;
    overflow-wrap: anywhere;
}
.amount {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-2);
    margin: var(--space-2) 0 0;
}
.amount-value {
    font-family: var(--font-head);
    font-weight: 200;
    font-size: var(--amount-size);
    line-height: var(--amount-line);
    color: var(--accent-2);
}
.amount-unit { color: var(--text-muted); }
.facts { margin: var(--space-5) 0 0; border-bottom: var(--hairline) solid var(--line); }
/* Where the id and its button cannot sit beside the label, they wrap under it, right-aligned */
.facts div {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0 var(--space-4);
    padding: var(--space-2) 0;
    min-height: calc(var(--row) + var(--hairline));
    border-top: var(--hairline) solid var(--line);
}
.facts dt { flex-shrink: 0; color: var(--text-muted); }
.facts dd {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    margin: 0 0 0 auto;
}
/* An id never wraps mid-token; on a screen too narrow for it, it scrolls inside its cell */
code {
    min-width: 0;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--ui-size);
    white-space: nowrap;
}
/* A payment address is read and compared by eye, so it wraps instead of hiding its end */
#deposit dd code {
    white-space: normal;
    overflow-wrap: anywhere;
    overflow-x: visible;
    font-size: var(--fine-size);
}
#deposit .qr { margin-top: var(--space-4); }
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
.state[data-state="expired"] { color: var(--text-muted); }
.state[data-state="review"] { color: var(--warn); }

h2 {
    margin: var(--space-6) 0 var(--space-3);
    font-size: var(--ui-size);
    line-height: var(--ui-line);
    font-weight: 600;
}
#wallets { list-style: none; margin: 0; padding: 0; border-top: var(--hairline) solid var(--line); }
#wallets li {
    display: flex;
    align-items: center;
    min-height: calc(var(--wallet-row) + var(--hairline));
    padding: calc((var(--wallet-row) - var(--ui-line)) / 2) 0;
    border-bottom: var(--hairline) solid var(--line);
    color: var(--text-muted);
}
#wallets li.wallet { padding: 0; }
#wallets label {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--wallet-row);
    color: var(--text);
    cursor: pointer;
}
#wallets input { margin: 0; accent-color: var(--accent); }
#wallets img { display: block; width: var(--wallet-icon); height: var(--wallet-icon); }
.button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: var(--control);
    padding: 0 var(--space-4);
    border: 0;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
    cursor: pointer;
}
#pay-button { margin-top: var(--space-5); }
.button:disabled { background: var(--surface); color: var(--text-muted); cursor: default; }
.button.outline {
    border: var(--hairline) solid var(--line);
    background: var(--bg);
    color: var(--text);
}
.button.outline:hover { background: var(--surface-hover); }
#message { min-height: var(--ui-line); margin: var(--space-3) 0 0; }
.mobile-links {
    display: none;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-5);
}
.qr { margin: 0; }
.qr svg { display: block; width: var(--qr); height: var(--qr); background: var(--qr-paper); }
.qr img { display: block; width: var(--qr); height: var(--qr); background: var(--qr-paper); }
.usdc { width: var(--usdc-icon); height: var(--usdc-icon); flex-shrink: 0; vertical-align: middle; }
.note { margin: var(--space-3) 0 0; color: var(--text-muted); }
#deposit-message, #wallet-note { min-height: var(--ui-line); margin: var(--space-3) 0 0; }
.qr figcaption { margin-top: var(--space-3); color: var(--text-muted); }

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

@media (max-width: 720px) {
    /* The website's phone inset, so the logo, the box's content and the footer share one edge */
    :root { --box-pad: var(--pad); }
    code { font-size: var(--fine-size); }
    .box, .foot { width: 100%; max-width: none; }
    .box { margin-top: 0; padding: var(--space-5) var(--box-pad); border-inline: 0; border-top: 0; }
    .foot { padding: 0 var(--box-pad); }
    .mobile-links { display: flex; }
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
    "<noscript><p>This page needs JavaScript to show live status. You can still send to the address above.</p></noscript>";
const COPY_LABELS = "<span>Copy</span><span>Copied</span>";

function copyButton(value: string): string {
    return `<button class="copy" type="button" data-copy="${escapeHtml(value)}">${COPY_LABELS}</button>`;
}

// mm:ss until the deadline, which the script keeps counting down
function timeLeft(expiresAt: Date, now: Date): string {
    const s = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function depositSection(v: CheckoutView, deposit: DepositView): string {
    const plain = decimalAmount(v.amountMicros);
    const id = escapeHtml(v.orderId);
    return `<section id="deposit">
<h2>Send USDC to this address</h2>
<dl class="facts">
<div><dt>Amount</dt><dd>${USDC_ICON} <span>${plain} USDC</span> ${copyButton(plain)}</dd></div>
<div><dt>Network</dt><dd>Solana</dd></div>
<div><dt>Address</dt><dd><code>${escapeHtml(deposit.address)}</code> ${copyButton(deposit.address)}</dd></div>
</dl>
<figure class="qr">
<img src="/o/${id}/qr.svg" alt="Solana Pay code for ${plain} USDC">
<figcaption>Scan with a Solana wallet app to send ${plain} USDC</figcaption>
</figure>
<p class="note">Send only USDC on Solana.</p>
<p class="note">From an exchange, send exactly ${plain} USDC. Anything returned goes back to the sending address, which an exchange may not credit to you.</p>
<p id="deposit-message" role="status" aria-live="polite"></p>
</section>`;
}

async function paySections(v: CheckoutView, amount: string, withDeposit: boolean): Promise<string> {
    const links = walletLinks(v.pageUrl, v.origin);
    return `<section id="wallet">
<h2>${withDeposit ? "Or pay with a browser wallet" : "Pay with a browser wallet"}</h2>
<ul id="wallets"><li>Looking for wallets</li></ul>
<button id="pay-button" class="button outline" type="button" disabled>Pay ${amount}</button>
<p id="wallet-note" role="status" hidden></p>
${MESSAGE}
</section>
<section id="phone">
<h2>Or pay in a phone wallet</h2>
<div class="mobile-links">
<a class="button outline" href="${escapeHtml(links.phantom)}">Open in Phantom</a>
<a class="button outline" href="${escapeHtml(links.solflare)}">Open in Solflare</a>
</div>
<figure class="qr">
${await qrSvg(links.phantom)}
<figcaption>Scan with your phone to open this page in Phantom</figcaption>
</figure>
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
    let tail: string;
    if (v.state === "unpaid") {
        const dep = v.depositsOffered ? v.deposit : null;
        tail =
            dep !== null
                ? `${depositSection(v, dep)}\n${await paySections(v, amount, true)}`
                : `<p id="deposit-message" class="note" role="status">Paying by address is off right now. Pay with a browser wallet below, or reload this page later.</p>
${await paySections(v, amount, false)}`;
    } else {
        tail = `<p id="deposit-message" role="status" aria-live="polite">${closedLine(v)}</p>${
            v.state === "settling" ? `\n${MESSAGE}` : ""
        }`;
    }
    return page(
        `Pay ${amount} to Bugnet`,
        `<main id="checkout" class="box" data-order-id="${id}" data-state="${v.state}" data-amount="${amount}" data-amount-micros="${v.amountMicros}" data-expires-at="${expires}" data-now="${v.now.toISOString()}" data-kind="${v.kind}" data-refund-min-micros="${v.refundMinMicros}" data-settle-grace-ms="${v.settleGraceMs}">
<h1 class="description">${escapeHtml(v.description)}</h1>
<p class="amount">
<span class="amount-value">${amount}</span>
<span class="amount-unit">${USDC_ICON} USDC on Solana</span>
</p>
<dl class="facts">
<div><dt>Order</dt><dd><code>${id}</code>
${copyButton(v.orderId)}
</dd></div>
<div><dt>Status</dt>
<dd id="state" class="state" data-state="${v.state}">${STATE_LABELS[v.state]}</dd></div>
${
    v.state === "unpaid"
        ? `<div><dt>Time left</dt><dd><time id="time-left" datetime="${expires}">${timeLeft(v.expiresAt, v.now)}</time> <span id="until"></span></dd></div>`
        : ""
}
</dl>
${tail}
${NOSCRIPT}
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
