import QRCode from "qrcode";
import type { PublicState } from "../http/public.ts";
import { STATE_LABELS } from "./flow.ts";

export const CHECKOUT_CSP =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
    "form-action 'none'";

export interface CheckoutView {
    orderId: string;
    description: string;
    amountMicros: number;
    state: PublicState;
    pageUrl: string;
    origin: string;
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

export function amountLabel(micros: number): string {
    const whole = Math.trunc(micros / 1_000_000);
    const fraction = String(micros % 1_000_000)
        .padStart(6, "0")
        .replace(/0+$/, "")
        .padEnd(2, "0");
    return `$${whole}.${fraction}`;
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

const STYLE = `
:root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --card: #ffffff;
    --text: #15171a;
    --muted: #5d6470;
    --line: #dde1e6;
    --accent: #4f46e5;
    --accent-text: #ffffff;
}
@media (prefers-color-scheme: dark) {
    :root {
        --bg: #101215;
        --card: #1a1d21;
        --text: #eceef1;
        --muted: #9aa1ab;
        --line: #2c3036;
        --accent: #818cf8;
        --accent-text: #101215;
    }
}
* { box-sizing: border-box; }
body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main {
    max-width: 30rem;
    margin: 2.5rem auto;
    padding: 1.5rem;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
}
h1 { margin: 0 0 0.25rem; font-size: 1rem; color: var(--muted); font-weight: 600; }
h2 { margin: 1.5rem 0 0.5rem; font-size: 1rem; }
.description { margin: 0; font-size: 1.125rem; overflow-wrap: anywhere; }
.amount { margin: 0.75rem 0; font-size: 2rem; font-weight: 700; }
.amount span { font-size: 0.875rem; font-weight: 500; color: var(--muted); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
code { font-size: 0.875rem; }
#wallets { list-style: none; margin: 0 0 1rem; padding: 0; }
#wallets li { padding: 0.5rem 0; color: var(--muted); }
#wallets label { display: flex; align-items: center; gap: 0.75rem; color: var(--text); }
#wallets img { width: 28px; height: 28px; border-radius: 6px; }
.button {
    display: block;
    width: 100%;
    padding: 0.75rem 1rem;
    border: 0;
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-text);
    font: inherit;
    font-weight: 600;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
}
.button:disabled { opacity: 0.5; cursor: default; }
#message { min-height: 1.5rem; margin: 0.75rem 0 0; }
#message::first-letter { text-transform: uppercase; }
.mobile-links { display: none; gap: 0.5rem; flex-direction: column; margin-bottom: 1rem; }
.qr { margin: 0; text-align: center; }
.qr svg { width: 12rem; height: 12rem; background: #ffffff; border-radius: 8px; }
.qr figcaption { color: var(--muted); font-size: 0.875rem; }
@media (max-width: 40rem) {
    main { max-width: none; margin: 0; min-height: 100vh; border: 0; border-radius: 0; }
    .mobile-links { display: flex; }
}
`;

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

const MESSAGE = '<p id="message" role="status" aria-live="polite"></p>';
const SCRIPT = '<script type="module" src="/checkout.js"></script>';

async function paySection(v: CheckoutView, amount: string): Promise<string> {
    const links = walletLinks(v.pageUrl, v.origin);
    return `<section>
<h2>Pay with a browser wallet</h2>
<ul id="wallets"><li>Looking for wallets</li></ul>
<button id="pay-button" class="button" type="button" disabled>Pay ${amount}</button>
${MESSAGE}
</section>
<section>
<h2>Pay with a phone wallet</h2>
<div class="mobile-links">
<a class="button" href="${escapeHtml(links.phantom)}">Open in Phantom</a>
<a class="button" href="${escapeHtml(links.solflare)}">Open in Solflare</a>
</div>
<figure class="qr">
${await qrSvg(links.phantom)}
<figcaption>Scan with your phone to open this page in Phantom</figcaption>
</figure>
</section>
${SCRIPT}`;
}

export async function renderCheckout(v: CheckoutView): Promise<string> {
    const amount = amountLabel(v.amountMicros);
    const id = escapeHtml(v.orderId);
    let tail = "";
    if (v.state === "unpaid") tail = await paySection(v, amount);
    else if (v.state === "settling") tail = `${MESSAGE}\n${SCRIPT}`;
    return page(
        `Pay ${amount} · Bugnet`,
        `<main id="checkout" data-order-id="${id}" data-state="${v.state}">
<h1>Bugnet</h1>
<p class="description">${escapeHtml(v.description)}</p>
<p class="amount">${amount} <span>USDC on Solana</span></p>
<dl>
<dt>Order</dt><dd><code>${id}</code></dd>
<dt>Status</dt><dd id="state">${STATE_LABELS[v.state]}</dd>
</dl>
${tail}
</main>`,
    );
}

export function renderNotFound(): string {
    return page(
        "Order not found · Bugnet",
        `<main>
<h1>Bugnet</h1>
<p class="description">Order not found</p>
</main>`,
    );
}
