import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { payWithWallet, type WalletPort } from "./flow.ts";
import {
    amountLabel,
    CHECKOUT_CSP,
    type CheckoutView,
    qrSvg,
    renderCheckout,
    walletLinks,
} from "./page.ts";

const id = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const view: CheckoutView = {
    orderId: id,
    description: "Bugnet sandbox 2 vCPU / 2 GiB, 10 min",
    amountMicros: 10_000,
    state: "unpaid",
    pageUrl: `https://pay.bugnet.sh/o/${id}`,
    origin: "https://pay.bugnet.sh",
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
        expect(html).toContain(await qrSvg(links.phantom));
        expect(html).toContain('id="pay-button"');
    });

    it("shows a closed order's state without a way to pay", async () => {
        for (const [state, label] of [
            ["paid", "Paid"],
            ["expired", "Expired"],
            ["refunded", "Refunded"],
            ["review", "Under review"],
        ] as const) {
            const html = await renderCheckout({ ...view, state });
            expect(html).toContain(label);
            expect(html).toContain(id);
            expect(html).not.toContain("/checkout.js");
            expect(html).not.toContain('id="pay-button"');
            expect(html).not.toContain("<svg");
        }
    });

    it("follows a settling order with the client but offers no way to pay", async () => {
        const html = await renderCheckout({ ...view, state: "settling" });
        expect(html).toContain('<dd id="state">Settling</dd>');
        expect(html).toContain('<p id="message" role="status" aria-live="polite"></p>');
        expect(html).toContain('<script type="module" src="/checkout.js"></script>');
        expect(html).not.toContain('id="pay-button"');
        expect(html).not.toContain('id="wallets"');
        expect(html).not.toContain("<svg");
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
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
        expect(page).not.toContain("/checkout.js");

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
        expect(html).toContain("Settling");
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
    });
});
