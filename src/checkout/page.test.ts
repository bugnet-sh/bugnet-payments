import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    getTransactionDecoder,
    getTransactionEncoder,
    partiallySignTransaction,
} from "@solana/kit";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newOrderId } from "../orders/ids.ts";
import type { OrderRow } from "../orders/types.ts";
import { get, testApp, type TestApp, totalCalls } from "../testing/app.ts";
import { seedOrder } from "../testing/orders.ts";
import { CHECKOUT_FONTS } from "./fonts.ts";
import { payWithWallet, type WalletPort } from "./flow.ts";
import {
    amountLabel,
    CHECKOUT_CSP,
    type CheckoutView,
    qrSvg,
    renderCheckout,
    renderNotFound,
    decimalAmount,
    walletLinks,
} from "./page.ts";

const FONTS_SRC = "src/checkout/fonts";

const id = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const view: CheckoutView = {
    orderId: id,
    description: "Bugnet sandbox 2 vCPU / 2 GiB, 10 min",
    amountMicros: 10_000,
    state: "unpaid",
    pageUrl: `https://pay.bugnet.sh/o/${id}`,
    origin: "https://pay.bugnet.sh",
    expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    now: new Date("2030-01-01T00:00:00.000Z"),
    kind: "start",
    deposit: null,
    depositsOffered: false,
    refundMinMicros: 1_000,
    settleGraceMs: 60_000,
};

describe("checkout page", () => {
    it("links mobile wallets into their in-app browsers", () => {
        expect(walletLinks(`https://pay.bugnet.sh/o/${id}`, "https://pay.bugnet.sh")).toEqual({
            phantom: `https://phantom.com/ul/browse/https%3A%2F%2Fpay.bugnet.sh%2Fo%2F${id}?ref=https%3A%2F%2Fpay.bugnet.sh`,
            solflare: `https://solflare.com/ul/v1/browse/https%3A%2F%2Fpay.bugnet.sh%2Fo%2F${id}?ref=https%3A%2F%2Fpay.bugnet.sh`,
        });
    });

    it("formats amounts exactly", () => {
        expect(amountLabel(10_000)).toBe("$0.01");
        expect(amountLabel(1_234_567)).toBe("$1.234567");
        expect(amountLabel(1_000_000)).toBe("$1.00");
        expect(amountLabel(10_500)).toBe("$0.0105");
        expect(amountLabel(0)).toBe("$0.00");
    });

    it("draws the QR as an inline SVG", async () => {
        const svg = await qrSvg(walletLinks(view.pageUrl, view.origin).phantom);
        expect(svg).toMatch(/^<svg [^>]*viewBox=/);
        expect(svg).toContain("</svg>");
    });

    it("renders order, amount, links and QR, and escapes the description", async () => {
        const html = await renderCheckout({ ...view, description: "<script>x</script>" });
        expect(html).toContain("$0.01");
        expect(html).toContain(id);
        expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
        expect(html).not.toContain("<script>x</script>");
        expect(html).toContain('<script type="module" src="/checkout.js"></script>');
        expect(html).toContain("<svg");
        expect(html).not.toMatch(/claim/i);
        const links = walletLinks(view.pageUrl, view.origin);
        expect(html).toContain(`href="${links.phantom}"`);
        expect(html).toContain(`href="${links.solflare}"`);
        expect(html).toContain("Open in Phantom");
        expect(html).toContain("Open in Solflare");
        // No address on this page, so its one code opens the page in Phantom
        expect(html).toContain(await qrSvg(links.phantom));
        expect(html.match(/<figure class="qr"/g)).toHaveLength(1);
        expect(html).toContain('id="pay-button"');
        expect(html).toContain('id="wallets"');
    });

    it("selects text in the accent green and carries the amount for the wallet messages", async () => {
        const html = await renderCheckout({ ...view, amountMicros: 50_000 });
        expect(html).toContain(
            "::selection { background: var(--accent); color: var(--accent-ink); }",
        );
        expect(html).toContain('data-amount="$0.05"');
    });
    it("wears the brand: title, header, fonts, copy button and footer", async () => {
        const html = await renderCheckout({ ...view, amountMicros: 50_000 });
        expect(html).toContain("<title>Pay $0.05 to Bugnet</title>");
        expect(html).toContain('<a class="brand" href="https://bugnet.sh/">');
        expect(html).toContain('<span class="amount-value">$0.05</span>');
        expect(html).toContain(`data-copy="${id}"`);
        expect(html).toContain('href="https://bugnet.sh/terms/"');
        expect(html).toContain('href="https://bugnet.sh/privacy/"');
        for (const name of ["manrope-400.woff2", "lexend-deca-200.woff2"]) {
            expect(html).toContain(
                `<link rel="preload" href="/fonts/${name}" as="font" type="font/woff2" crossorigin>`,
            );
        }
        const faces = [...html.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((m) => m[1]);
        expect(faces).toEqual(CHECKOUT_FONTS);
        expect(html).not.toMatch(/prefers-color-scheme|border-radius:\s*[1-9]/);
        expect(html).not.toContain("\u00b7");
        const notFound = renderNotFound();
        expect(notFound).toContain("<title>Order not found</title>");
        expect(notFound).not.toContain("\u00b7");
    });

    it("ships every allowlisted font with its family's license", async () => {
        const files = await readdir(FONTS_SRC);
        for (const name of CHECKOUT_FONTS) expect(files).toContain(name);
        for (const family of ["manrope", "lexend-deca", "obel-mono"]) {
            expect(files).toContain(`OFL-${family}.txt`);
        }
    });

    it("shows a closed order's state without a way to pay", async () => {
        for (const [state, label] of [
            ["paid", "Paid"],
            ["expired", "Expired"],
            ["refunded", "Refunded"],
            ["review", "Under review"],
        ] as const) {
            const html = await renderCheckout({ ...view, state });
            expect(html).toContain(
                `<span id="state" class="state" data-state="${state}" role="status" aria-live="polite">${label}</span>`,
            );
            expect(html).toContain(id);
            // The client only wires the Copy button on a closed order's page
            expect(html).toContain(`data-copy="${id}"`);
            expect(html).not.toContain('id="pay-button"');
            expect(html).not.toContain('id="wallets"');
            expect(html).not.toContain('class="qr"');
            expect(html).not.toContain("Open in Phantom");
        }
    });

    it("follows a settling order with the client but offers no way to pay", async () => {
        const html = await renderCheckout({ ...view, state: "settling" });
        expect(html).toContain(
            '<span id="state" class="state" data-state="settling" role="status" aria-live="polite">Confirming</span>',
        );
        expect(html).toContain('<p id="message" role="status" aria-live="polite"></p>');
        expect(html).toContain('<script type="module" src="/checkout.js"></script>');
        expect(html).not.toContain('id="pay-button"');
        expect(html).not.toContain('id="wallets"');
        expect(html).not.toContain('class="qr"');
    });

    it("bundles the browser client", async () => {
        const out = await esbuild.build({
            entryPoints: ["src/checkout/client.ts"],
            bundle: true,
            platform: "browser",
            format: "esm",
            target: "es2022",
            write: false,
            logLevel: "warning",
        });
        expect(out.errors).toEqual([]);
        expect(out.warnings).toEqual([]);
        const text = out.outputFiles[0]!.text;
        expect(text).toContain("solana:signTransaction");
        expect(text).toContain("standard:connect");
        // @x402/core/http and the zod it pulls in would add about 750 KB here
        expect(text.length).toBeLessThan(400_000);
        // Every message comes from messages.ts, which never passes a raw wallet or error text
        expect(text).not.toContain("payment refused:");
        expect(text).not.toContain("did not go through");
        const flow = await import("./flow.ts");
        for (const gone of ["pageStep", "stateStep", "walletErrorStep"]) {
            expect(gone in flow).toBe(false);
        }
    });
});

describe("checkout routes", () => {
    let app: TestApp;
    let order: OrderRow;
    let dir: string;
    const bundle = "export const checkout = 1;\n";

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), "bn-checkout-"));
        await writeFile(join(dir, "checkout.js"), bundle);
        await mkdir(join(dir, "fonts"));
        for (const name of CHECKOUT_FONTS) {
            await copyFile(join(FONTS_SRC, name), join(dir, "fonts", name));
        }
        await writeFile(join(dir, "secret.txt"), "not a font\n");
        app = await testApp({ checkoutJsPath: join(dir, "checkout.js") });
    });
    afterAll(async () => {
        await app.close();
        await rm(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
        const expiresAt = new Date(app.now.get().getTime() + 15 * 60_000);
        order = (await seedOrder(app.pool, { expiresAt })).order;
        for (const k of Object.keys(app.rpc.calls)) app.rpc.calls[k] = 0;
    });

    it("serves HTML with a strict CSP to browsers", async () => {
        const r = await get(app, `/o/${order.id}`, { accept: "text/html" });
        expect(r.status).toBe(200);
        expect(r.headers.get("content-security-policy")).toBe(CHECKOUT_CSP);
        expect(CHECKOUT_CSP).toBe(
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
        expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(r.headers.get("cache-control")).toBe("no-store");
        const html = await r.text();
        expect(html).toContain(order.id);
        expect(html).toContain(amountLabel(order.amountMicros));
        const links = walletLinks(`${app.publicUrl}/o/${order.id}`, new URL(app.publicUrl).origin);
        expect(html).toContain(`href="${links.phantom}"`);
        expect(totalCalls(app.rpc)).toBe(0);
    });

    it("serves the page to a browser's navigation Accept header", async () => {
        const r = await get(app, `/o/${order.id}`, {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        });
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    });

    it("answers HTML 404 for an unknown order and 410 for an expired one", async () => {
        const html = { accept: "text/html" };
        for (const path of [`/o/${newOrderId()}`, "/o/not-an-id"]) {
            const unknown = await get(app, path, html);
            expect(unknown.status).toBe(404);
            expect(unknown.headers.get("content-type")).toBe("text/html; charset=utf-8");
            expect(unknown.headers.get("content-security-policy")).toBe(CHECKOUT_CSP);
            expect(await unknown.text()).toContain("Order not found");
        }

        const lapsed = (
            await seedOrder(app.pool, { expiresAt: new Date(app.now.get().getTime() - 1_000) })
        ).order;
        const expired = await get(app, `/o/${lapsed.id}`, html);
        expect(expired.status).toBe(410);
        expect(expired.headers.get("content-type")).toBe("text/html; charset=utf-8");
        const page = await expired.text();
        expect(page).toContain(lapsed.id);
        expect(page).toContain("Expired");
        expect(page).not.toContain('id="pay-button"');

        const refunded = (
            await seedOrder(app.pool, { state: "refunded", expiresAt: app.now.get() })
        ).order;
        const closed = await get(app, `/o/${refunded.id}`, html);
        expect(closed.status).toBe(410);
        expect(await closed.text()).toContain("Refunded");
        expect(totalCalls(app.rpc)).toBe(0);
    });

    it("shows a paid order as paid", async () => {
        const paid = (await seedOrder(app.pool, { state: "paid", expiresAt: app.now.get() })).order;
        const r = await get(app, `/o/${paid.id}`, { accept: "text/html" });
        expect(r.status).toBe(200);
        const html = await r.text();
        expect(html).toContain("Paid");
        expect(html).not.toContain('id="pay-button"');
    });

    it("serves a settling order's page with the client that follows it", async () => {
        const settling = (
            await seedOrder(app.pool, { state: "settling", expiresAt: app.now.get() })
        ).order;
        const r = await get(app, `/o/${settling.id}`, { accept: "text/html" });
        expect(r.status).toBe(200);
        const html = await r.text();
        expect(html).toContain("Confirming");
        expect(html).toContain('<script type="module" src="/checkout.js"></script>');
        expect(html).not.toContain('id="pay-button"');
        expect(totalCalls(app.rpc)).toBe(0);
    });

    it("keeps answering x402 clients with JSON", async () => {
        const r = await get(app, `/o/${order.id}`, { accept: "application/json" });
        expect(r.status).toBe(402);
        expect(r.headers.get("payment-required")).not.toBeNull();
        expect(
            (await get(app, `/o/${order.id}/status`, { accept: "text/html" })).headers.get(
                "content-type",
            ),
        ).toMatch(/application\/json/);
    });

    it("serves the browser bundle", async () => {
        const r = await get(app, "/checkout.js");
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        expect(r.headers.get("cache-control")).toBe("no-store");
        expect(await r.text()).toBe(bundle);
        const post = await fetch(`${app.publicOrigin}/checkout.js`, { method: "POST" });
        expect(post.status).toBe(405);
    });

    it("serves the allowlisted fonts for a year, GET and HEAD only", async () => {
        for (const name of CHECKOUT_FONTS) {
            const r = await get(app, `/fonts/${name}`);
            expect(r.status).toBe(200);
            expect(r.headers.get("content-type")).toBe("font/woff2");
            expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
            const body = Buffer.from(await r.arrayBuffer());
            expect(body.equals(await readFile(join(FONTS_SRC, name)))).toBe(true);
        }
        const head = await fetch(`${app.publicOrigin}/fonts/manrope-400.woff2`, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-type")).toBe("font/woff2");
        expect(await head.text()).toBe("");
        const post = await fetch(`${app.publicOrigin}/fonts/manrope-400.woff2`, { method: "POST" });
        expect(post.status).toBe(404);
    });

    it("answers 404 for any font path off the allowlist, traversal included", async () => {
        // Sent byte for byte, as fetch would normalise the dot segments first
        const raw = (path: string) =>
            new Promise<{ status: number; type: string | undefined }>((resolve, reject) => {
                const url = new URL(app.publicOrigin);
                const req = request(
                    { host: url.hostname, port: url.port, path, method: "GET" },
                    (res) => {
                        res.resume();
                        res.on("end", () =>
                            resolve({
                                status: res.statusCode ?? 0,
                                type: res.headers["content-type"],
                            }),
                        );
                    },
                );
                req.on("error", reject);
                req.end();
            });
        for (const path of [
            "/fonts/../secret.txt",
            "/fonts/%2e%2e/secret.txt",
            "/fonts/%2E%2E%2Fsecret.txt",
            "/fonts/..%2fsecret.txt",
            "/fonts/fonts/manrope-400.woff2",
            "/fonts/manrope-700.woff2",
            "/fonts/MANROPE-400.WOFF2",
            "/fonts/manrope-400.woff2/",
            "/fonts/",
            "/fonts/OFL-manrope.txt",
        ]) {
            const r = await raw(path);
            expect([path, r.status]).toEqual([path, 404]);
            expect(r.type).toBe("application/json");
        }
    });

    it("pays an order through the real routes with a browser wallet", async () => {
        const wallet: WalletPort = {
            connect: async () => ({ address: app.payer.address }),
            async signTransaction(i) {
                const tx = getTransactionDecoder().decode(i.transaction);
                const signed = await partiallySignTransaction([app.payer.keyPair], tx);
                return [
                    { signedTransaction: new Uint8Array(getTransactionEncoder().encode(signed)) },
                ];
            },
        };
        const orderUrl = `${app.publicOrigin}/o/${order.id}`;
        expect(await payWithWallet({ fetch, wallet, orderUrl })).toBe("paid");
        expect(app.rpc.calls.sendTransaction).toBe(1);
        const status = await (await get(app, `/o/${order.id}/status`)).json();
        expect(status).toMatchObject({ orderId: order.id, state: "paid" });
        const via = await app.pool.query("select paid_via from orders where id = $1", [order.id]);
        expect(via.rows).toEqual([{ paid_via: "checkout" }]);
    });
});

describe("address-first page", () => {
    const ADDRESS = "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley";
    const deposit = {
        address: ADDRESS,
        ready: true,
        status: "waiting",
        receivedMicros: 0,
        otherMicros: 0,
        remainingMicros: 50_000,
        extraMicros: 0,
        returningMicros: 0,
        returnedMicros: 0,
        keptMicros: 0,
        reviewMicros: 0,
        reason: null,
        reasonMicros: 0,
        blockedUntil: null,
        hold: null,
        transfers: [],
    } as unknown as NonNullable<CheckoutView["deposit"]>;
    const offered: CheckoutView = { ...view, amountMicros: 50_000, deposit, depositsOffered: true };
    const section = (html: string, name: string) => {
        const at = html.indexOf(`<section id="${name}"`);
        return html.slice(at, html.indexOf("</section>", at));
    };

    it("decimalAmount", () => {
        expect(decimalAmount(50_000)).toBe("0.05");
        expect(decimalAmount(1)).toBe("0.000001");
        expect(decimalAmount(1_000_000)).toBe("1");
        expect(decimalAmount(10_000)).toBe("0.01");
    });

    it("the address comes first, then an or, then the wallet and the phone", async () => {
        const html = await renderCheckout(offered);
        const order = ['id="deposit"', 'id="or"', 'id="wallet"', 'id="phone"'].map((a) =>
            html.indexOf(a),
        );
        expect(order[0]).toBeGreaterThan(0);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // The script shows each once it knows the browser's wallets
        expect(html).toContain('<section id="wallet" hidden>');
        expect(html).toContain('<section id="phone" hidden>');
        expect(html).toContain('<p id="or" class="or" hidden>or</p>');
    });

    it("the amount and the Solana address are click-to-copy fields with copy icons", async () => {
        const html = await renderCheckout(offered);
        const dep = section(html, "deposit");
        expect(dep).toContain(`data-copy="${ADDRESS}" aria-label="Copy address"`);
        expect(dep).toContain('data-copy="0.05" aria-label="Copy amount"');
        expect(dep).toContain('<span class="label">Solana address</span>');
        // Shown whole, wrapping in its field, since people compare it by eye
        expect(dep).toContain(`<span class="value address">${ADDRESS}</span>`);
        // Icons, never a Copy word, and no mono text
        expect(html).not.toMatch(/>Copy</);
        expect(html).not.toContain("<code");
        expect(html).toContain('<svg class="idle"');
    });

    it("USDC is said once on the page, in the amount field", async () => {
        const html = await renderCheckout(offered);
        const body = html.slice(html.indexOf("<main"));
        expect(body.match(/>USDC</g)).toHaveLength(1);
        expect(body.match(/class="usdc"/g)).toHaveLength(1);
        expect(html).toContain('<p class="amount"><span class="amount-value">$0.05</span></p>');
        expect(html).not.toContain("<h2");
    });

    it("one code shows: the address's, while the Phantom code waits hidden for a review", async () => {
        const html = await renderCheckout(offered);
        expect(html.match(/<figure class="qr">/g)).toHaveLength(1);
        expect(section(html, "deposit")).toContain(`<img src="/o/${id}/qr.svg?r=50000"`);
        const phone = section(html, "phone");
        expect(phone).toContain('<figure class="qr" hidden>');
        const phantom = walletLinks(offered.pageUrl, offered.origin).phantom;
        expect(phone).toContain(await qrSvg(phantom));
        // A phone cannot scan its own screen; a tablet can still show its code to one
        expect(html).toContain(
            "@media (hover: none) and (pointer: coarse) and (max-width: 720px) {\n    .qr { display: none !important; }",
        );
    });

    it("a deposit drawn in review shows no address, and the Phantom code instead", async () => {
        const review = {
            ...offered,
            deposit: { ...offered.deposit!, status: "review" as const, remainingMicros: 30_000 },
        };
        const html = await renderCheckout(review);
        expect(html).toContain('<div id="deposit-ask" hidden>');
        expect(section(html, "phone")).toContain('<figure class="qr">');
        // The address's code sits inside the hidden ask, so one code shows
        const outside = html.slice(html.indexOf('<section id="wallet"'));
        expect(outside.match(/<figure class="qr">/g)).toHaveLength(1);
    });

    it("the deposit QR names what it asks for, so the first poll fetches it again only when that changed", async () => {
        const dep = section(await renderCheckout(offered), "deposit");
        expect(dep).toContain(`<img src="/o/${id}/qr.svg?r=50000" data-remaining="50000"`);
    });

    it("the deposit QR waits hidden while nothing more is owed", async () => {
        const shown = section(await renderCheckout(offered), "deposit");
        expect(shown).toContain('<figure class="qr">');
        const held = {
            ...offered,
            deposit: { ...offered.deposit!, status: "held" as const, remainingMicros: 0 },
        };
        const hidden = section(await renderCheckout(held), "deposit");
        expect(hidden).toContain('<figure class="qr" hidden>');
        expect(hidden).toContain(
            `<img src="/o/${id}/qr.svg?r=0" data-remaining="0" loading="lazy"`,
        );
    });

    it("once money has arrived, the Amount field, its copy value and the QR ask for the rest", async () => {
        const partial = {
            ...offered,
            deposit: {
                ...offered.deposit!,
                status: "partial" as const,
                receivedMicros: 30_000,
                remainingMicros: 20_000,
            },
        };
        const html = await renderCheckout(partial);
        const dep = section(html, "deposit");
        expect(dep).toContain('<span id="deposit-amount" class="value">0.02</span>');
        expect(dep).toContain(
            '<button id="deposit-amount-copy" class="copy" type="button" data-copy="0.02" aria-label="Copy amount">',
        );
        expect(dep).toContain('alt="Solana Pay code for 0.02 USDC"');
        expect(dep).not.toContain("0.05");
        // The price stays whole
        expect(html).toContain('<span class="amount-value">$0.05</span>');
    });

    it("the ask sits in one block the client hides, apart from the deposit line", async () => {
        const html = await renderCheckout(offered);
        const ask = html.slice(
            html.indexOf('<div id="deposit-ask">'),
            html.indexOf('<section id="wallet"'),
        );
        expect(ask).toContain('<div class="fields">');
        expect(ask).toContain('<figure class="qr">');
        expect(ask).toContain('id="or"');
        // The order's line sits under its status, apart from any way to pay
        expect(ask).not.toContain('id="deposit-message"');
        expect(
            html.indexOf('<p id="deposit-message" role="status" aria-live="polite"></p>'),
        ).toBeLessThan(html.indexOf('id="deposit-ask"'));
    });

    it("with the whole price in and confirming, nothing asks for money", async () => {
        const html = await renderCheckout({
            ...offered,
            deposit: {
                ...offered.deposit!,
                status: "confirming" as const,
                receivedMicros: 50_000,
                remainingMicros: 0,
            },
        });
        expect(html).toContain('<div id="deposit-ask" hidden>');
        expect(html).toContain('<section id="phone" hidden>');
        expect(html).toContain('<span class="time" hidden>');
        expect(html).not.toContain("<noscript>");
        // The script starts with no way to pay, and the label already says Confirming
        expect(html).toContain('data-takes-money="false"');
        expect(html).toContain('aria-live="polite">Confirming</span>');
        expect(await renderCheckout(offered)).toContain('data-takes-money="true"');
    });

    it("nothing on the page talks about exchanges", async () => {
        for (const state of ["unpaid", "settling", "paid", "expired", "refunded"] as const) {
            expect((await renderCheckout({ ...offered, state })).toLowerCase()).not.toContain(
                "exchange",
            );
        }
    });

    it("a failed copy has its own line, apart from the order's", async () => {
        const html = await renderCheckout(offered);
        expect(html).toContain('<p id="copy-message" role="status" aria-live="polite"></p>');
        // Empty live regions stay in the page, so their first line is announced
        expect(html).toContain(
            "#deposit-message:empty, #message:empty, #copy-message:empty, #wallet-note:empty { margin: 0; }",
        );
        expect(html).not.toMatch(/:empty \{ display: none/);
        expect(html).toContain('aria-label="Copy order ID"');
    });

    it("the code and the two fields beside it share one height", async () => {
        expect(await renderCheckout(offered)).toContain(
            "--qr: calc(2 * (var(--fine-line) + var(--space-1) + var(--field)) + var(--space-3));",
        );
    });

    it("phone links stay", async () => {
        const phone = section(await renderCheckout(offered), "phone");
        expect(phone).toContain("Open in Phantom");
        expect(phone).toContain("Open in Solflare");
    });

    it("the USDC icon sits in the payment details", async () => {
        const dep = section(await renderCheckout(offered), "deposit");
        expect(dep).toContain('class="usdc"');
        expect(dep.toLowerCase()).toContain("#2775ca");
    });

    it("the deadline is shown", async () => {
        const html = await renderCheckout(offered);
        expect(html).toContain('<time id="time-left" datetime="2030-01-01T00:15:00.000Z"');
        expect(html).toContain('data-expires-at="2030-01-01T00:15:00.000Z"');
        expect(html).toContain('data-refund-min-micros="1000"');
        expect(html).toContain('data-settle-grace-ms="60000"');
        expect(html).toContain(">15:00</time>");
    });

    it("time left shows only while the order takes money", async () => {
        expect(await renderCheckout({ ...offered, state: "paid" })).not.toContain('id="time-left"');
        expect(await renderCheckout(offered)).toContain('id="time-left"');
        // The client hides the Time left row, a .facts div that is otherwise display: flex
        expect(await renderCheckout(offered)).toContain("[hidden] { display: none !important; }");
    });

    it("the card is centered", async () => {
        const html = await renderCheckout(offered);
        expect(html).toContain("min-height: 100dvh");
        expect(html).toContain("margin-block: auto");
        expect(html).not.toContain("::first-letter");
        // On a phone too: a short card is centered, a long one starts at the top
        expect(html).not.toContain(".box { margin-top: 0;");
    });

    it("an address wraps whole, never cut, on two lines beside the code", async () => {
        const html = await renderCheckout(offered);
        const rule = html.slice(
            html.indexOf(".value.address {"),
            html.indexOf("}", html.indexOf(".value.address {")),
        );
        expect(rule).toContain("white-space: normal;");
        expect(rule).toContain("overflow-wrap: anywhere;");
        expect(rule).not.toContain("ellipsis");
        expect(html).toContain("--column: 520px;");
    });

    it("the page carries what already arrived, so Pay names the whole price before any poll", async () => {
        expect(await renderCheckout(offered)).toContain(
            'data-arrived-micros="0" data-arrived-review="false"',
        );
        const partial = {
            ...offered,
            deposit: {
                ...offered.deposit!,
                status: "partial" as const,
                receivedMicros: 30_000,
                remainingMicros: 20_000,
            },
        };
        expect(await renderCheckout(partial)).toContain(
            'data-takes-money="true" data-arrived-micros="30000" data-arrived-review="false"',
        );
        const review = {
            ...offered,
            deposit: { ...offered.deposit!, status: "review" as const, receivedMicros: 20_000 },
        };
        expect(await renderCheckout(review)).toContain(
            'data-arrived-micros="20000" data-arrived-review="true"',
        );
    });

    it("notes keep their spacing", async () => {
        expect(await renderCheckout(offered)).toContain(
            ".note { margin-top: var(--space-4); color: var(--text-muted); }",
        );
    });

    it("each code is drawn at one size on paper", async () => {
        expect(await renderCheckout(offered)).toContain(
            ".qr img, .qr svg { display: block; width: var(--qr); height: var(--qr); background: var(--qr-paper); }",
        );
    });

    it("the wallet part is the Pay button, any other wallet's button and the wallet's line", async () => {
        const wallet = section(await renderCheckout(offered), "wallet");
        expect(wallet).toBe(`<section id="wallet" hidden>
<button id="pay-button" class="button" type="button" disabled>Pay</button>
<div id="wallets"></div>
<p id="wallet-note" role="status" aria-live="polite"></p>
<p id="message" role="status" aria-live="polite"></p>
`);
    });

    it("a disabled Pay button looks disabled, outline or not", async () => {
        const html = await renderCheckout(offered);
        // Equal specificity, so the later rule wins
        expect(html.indexOf(".button:disabled {")).toBeGreaterThan(
            html.indexOf(".button.outline {"),
        );
        expect(html).toContain(".button.outline:not(:disabled):hover {");
        expect(html).not.toContain(".button.outline:hover");
    });

    it("Pay is the page's one green button, named by the script once it finds a wallet", async () => {
        const html = await renderCheckout(offered);
        expect(section(html, "wallet")).toContain(
            '<button id="pay-button" class="button" type="button" disabled>Pay</button>',
        );
        expect(html.match(/class="button"/g)).toHaveLength(1);
    });

    it("no deposit offered", async () => {
        const html = await renderCheckout({ ...offered, depositsOffered: false });
        expect(html).not.toContain('id="deposit"');
        expect(html).not.toContain('id="or"');
        expect(html).toContain(
            '<p id="deposit-message" role="status" aria-live="polite">Paying by address is off right now.</p>',
        );
        // Shown before the script runs, so the page offers a way to pay without it
        const phone = section(html, "phone");
        expect(html).toContain('<section id="phone">');
        expect(phone).toContain('<figure class="qr">');
        expect(phone).toContain("<figcaption>Scan with Phantom on your phone</figcaption>");
        expect(html).toContain('<section id="wallet" hidden>');
    });

    it("page-level messages", async () => {
        expect(await renderCheckout({ ...view, state: "settling" })).toContain(
            "This page updates when the payment lands.",
        );
        expect(await renderCheckout({ ...view, state: "refunded" })).toContain(
            "This order's payment was returned to the wallet that paid.",
        );
        const P4 =
            '<noscript><p class="note">This page needs JavaScript to show live status. You can still send to the address above.</p></noscript>';
        expect(await renderCheckout(offered)).toContain(P4);
        // Only a page that shows the address
        for (const state of ["settling", "paid", "expired", "refunded", "review"] as const) {
            expect(await renderCheckout({ ...offered, state })).not.toContain("<noscript>");
        }
        expect(await renderCheckout({ ...offered, depositsOffered: false })).not.toContain(
            "<noscript>",
        );
        // A deposit in review hides the address, so P4 would point at nothing
        const review = {
            ...offered,
            deposit: { ...offered.deposit!, status: "review" as const },
        };
        const html = await renderCheckout(review);
        expect(html).not.toContain("<noscript>");
        // Without the script the page still says it is in review, and why
        expect(html).toContain(
            `data-state="unpaid" role="status" aria-live="polite">Under review</span>`,
        );
        expect(html).toContain(
            `<p id="deposit-message" role="status" aria-live="polite">This payment needs a check by hand. The money is safe. Write to support@bugnet.org with order ${id}.</p>`,
        );
    });

    it("not found tells what to do", () => {
        const html = renderNotFound();
        expect(html).toContain("Order not found.");
        expect(html).toContain("Check the link, or ask your agent for a new payment link.");
    });

    it("no middle dot, no raw error text", async () => {
        const pages = [
            renderNotFound(),
            ...(await Promise.all(
                (["unpaid", "settling", "paid", "expired", "refunded", "review"] as const).map(
                    (state) => renderCheckout({ ...offered, state }),
                ),
            )),
        ];
        for (const html of pages) {
            for (const bad of [
                "\u00b7",
                "Waiting for your transfer",
                "No browser wallet",
                "Unexpected error",
                "payment refused:",
                "did not go through",
            ]) {
                expect(html).not.toContain(bad);
            }
        }
    });
});
