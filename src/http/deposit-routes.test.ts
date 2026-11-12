import { request } from "node:http";
import { getBase58Decoder } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { qrSvg } from "../checkout/page.ts";
import type { ViewerFacts } from "../deposits/job.ts";
import { DepositKeys } from "../deposits/keys.ts";
import { ensureDeposit, insertTransfers, updateDeposit } from "../deposits/store.ts";
import { TEST_DEPOSIT_SALT, TEST_DEPOSIT_SEED } from "../testing/app.ts";
import { seedOrder } from "../testing/orders.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { get, testApp, type TestApp, totalCalls } from "../testing/app.ts";
import { solanaPayUrl } from "./public.ts";

// Deposit routes over a test app with deposits on: seed 7 and salt 1 give ord_aaaa… the address
// BGx7… (the keys golden vector)
const ID = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDRESS = "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley";
const T0 = new Date("2030-01-01T00:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
let ipSeq = 0;
const freshIp = () => {
    ipSeq += 1;
    return `10.77.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
};

async function order(app: TestApp, over: Record<string, unknown> = {}) {
    await app.pool.query("delete from orders where id = $1", [ID]).catch(() => {});
    return (
        await seedOrder(app.pool, {
            id: ID,
            state: "unpaid",
            amountMicros: 50_000,
            description: "Sandbox time",
            createdAt: T0,
            expiresAt: at(15 * MIN),
            ...over,
        })
    ).order;
}

async function credit(app: TestApp, signature: string, micros: number, owner: string, when: Date) {
    const c = await app.pool.connect();
    try {
        await insertTransfers(c, ID, [
            {
                orderId: ID,
                signature,
                slot: 100n,
                seq: 0,
                blockTime: when,
                seenAt: when,
                amountMicros: micros,
                sourceTokenAccount: `${owner}Ata`,
                sourceOwner: owner,
                sourceBalanceMicros: 1_000_000n,
            },
        ]);
    } finally {
        c.release();
    }
}

const page = (app: TestApp, ip = freshIp()) =>
    get(app, `/o/${ID}`, { accept: "text/html", "x-forwarded-for": ip });
const json = (app: TestApp, path: string, headers: Record<string, string> = {}) =>
    get(app, path, { "x-forwarded-for": freshIp(), ...headers });

describe("deposit routes", () => {
    let app: TestApp;
    beforeAll(async () => {
        app = await testApp({ now: at(5 * MIN), deposits: {} });
    });
    afterAll(() => app.close());
    beforeEach(async () => {
        app.now.set(at(5 * MIN));
        await app.pool.query("truncate orders cascade");
    });

    it("the HTML page creates the deposit", async () => {
        await order(app);
        const r = await page(app);
        expect(r.status).toBe(200);
        expect(await r.text()).toContain(ADDRESS);
        const row = await app.pool.query("select address from deposits where order_id = $1", [ID]);
        expect(row.rows[0]?.address).toBe(ADDRESS);
    });

    it("status keeps the old fields and adds the new ones", async () => {
        await order(app);
        await page(app);
        await credit(app, "A1", 30_000, "OwnA", at(4 * MIN));
        const before = totalCalls(app.rpc);
        const r = await json(app, `/o/${ID}/status`);
        expect(r.status).toBe(200);
        expect(r.headers.get("cache-control")).toBe("no-store");
        expect(await r.json()).toEqual({
            orderId: ID,
            state: "unpaid",
            expiresAt: "2030-01-01T00:15:00.000Z",
            now: "2030-01-01T00:05:00.000Z",
            amountMicros: 50_000,
            kind: "start",
            deposit: {
                address: ADDRESS,
                ready: false,
                status: "partial",
                receivedMicros: 30_000,
                otherMicros: 0,
                remainingMicros: 20_000,
                extraMicros: 0,
                returningMicros: 0,
                returnedMicros: 0,
                keptMicros: 0,
                reviewMicros: 0,
                reason: null,
                reasonMicros: 0,
                blockedUntil: null,
                hold: null,
                transfers: [
                    {
                        signature: "A1",
                        amountMicros: 30_000,
                        at: "2030-01-01T00:04:00.000Z",
                        outcome: "counted",
                        reason: null,
                        returnSignature: null,
                    },
                ],
            },
        });
        expect(totalCalls(app.rpc)).toBe(before);
    });

    it("status without a deposit", async () => {
        await order(app);
        const body = (await (await json(app, `/o/${ID}/status`)).json()) as { deposit: unknown };
        expect(body.deposit).toBeNull();
    });

    it("a checkout status poll notes the viewer with facts", async () => {
        const watch = app.watch!;
        const noted: ViewerFacts[] = [];
        const real = watch.noteViewer.bind(watch);
        watch.noteViewer = (id, ip, nowMs, facts) => {
            noted.push(facts);
            return real(id, ip, nowMs, facts);
        };
        try {
            const checkout = { "bugnet-client": "checkout" };
            // No deposit: nothing is noted
            await order(app);
            await json(app, `/o/${ID}/status`, checkout);
            expect(noted).toEqual([]);
            expect(watch.viewerSeen(ID, app.now.get().getTime())).toBe(false);

            await page(app);
            const now = app.now.get().getTime();
            await json(app, `/o/${ID}/status`);
            expect(watch.viewerSeen(ID, now)).toBe(false);
            await json(app, `/o/${ID}/status`, checkout);
            expect(watch.viewerSeen(ID, now)).toBe(true);
            expect(noted).toEqual([
                { state: "open", expiresAtMs: at(15 * MIN).getTime(), needsCreate: true },
            ]);

            // A closed deposit is noted with its state, and the watch ignores it; a minute on,
            // the open poll above is past viewer_ttl
            await updateDeposit(app.pool, ID, { state: "closed" });
            app.now.set(at(6 * MIN));
            await json(app, `/o/${ID}/status`, checkout);
            expect(noted.at(-1)).toMatchObject({ state: "closed" });
            expect(watch.viewerSeen(ID, at(6 * MIN).getTime())).toBe(false);
        } finally {
            watch.noteViewer = real;
        }
    });

    it("the QR never counts a stranger's money", async () => {
        await order(app);
        await page(app);
        await credit(app, "A1", 30_000, "OwnA", at(4 * MIN));
        await credit(app, "B1", 10_000, "OwnB", at(4 * MIN + 1_000));
        const body = (await (await json(app, `/o/${ID}/status`)).json()) as {
            deposit: Record<string, number>;
        };
        expect(body.deposit).toMatchObject({
            receivedMicros: 30_000,
            otherMicros: 10_000,
            remainingMicros: 20_000,
        });
        const qr = await json(app, `/o/${ID}/qr.svg`);
        expect(qr.status).toBe(200);
        expect(qr.headers.get("content-type")).toBe("image/svg+xml");
        expect(qr.headers.get("content-security-policy")).toBe("default-src 'none'");
        // The code asks for the 0.02 the payer still owes, never less for the stranger's money
        expect(await qr.text()).toBe(await qrSvg(solanaPayUrl(ADDRESS, 20_000, "Sandbox time")));
    });

    it("qr.svg is the Solana Pay request for the remaining amount", async () => {
        expect(solanaPayUrl(ADDRESS, 20_000, "Sandbox time")).toBe(
            `solana:${ADDRESS}?amount=0.02&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&label=Bugnet&message=Sandbox%20time`,
        );
        await order(app, { state: "paid", paidAt: at(4 * MIN), payer: "P" });
        expect((await json(app, `/o/${ID}/qr.svg`)).status).toBe(404);
    });

    it("the 402 challenge is unchanged", async () => {
        await order(app);
        const without = await (await json(app, `/o/${ID}`)).text();
        await page(app);
        const withDeposit = await (await json(app, `/o/${ID}`)).text();
        expect(withDeposit).toBe(without);
        const pr = JSON.parse(withDeposit) as { accepts: { payTo: string }[] };
        expect(pr.accepts[0]!.payTo).toBe((await testSigner(1)).address);
    });

    it("the HTML page states what the status route states", async () => {
        await order(app);
        await page(app);
        await credit(app, "A1", 30_000, "OwnA", at(4 * MIN));
        // Inside the grace with on-time money: settling, not a 410 Expired page
        app.now.set(at(15 * MIN + 30_000));
        const r = await page(app);
        expect(r.status).toBe(200);
        expect(await r.text()).toContain('data-state="settling"');
        const status = (await (await json(app, `/o/${ID}/status`)).json()) as { state: string };
        expect(status.state).toBe("settling");
    });

    it("a report whose client hangs up is an info line, not an error", async () => {
        await order(app);
        const before = app.log.lines.length;
        const url = new URL(`${app.publicOrigin}/o/${ID}/report`);
        await new Promise<void>((resolve) => {
            const req = request(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": "500",
                    "x-forwarded-for": freshIp(),
                },
            });
            req.on("error", () => resolve());
            req.write('{"stage":"sign"', () => setTimeout(() => req.destroy(), 50));
            req.on("close", () => resolve());
        });
        const lines = () => app.log.lines.slice(before);
        await expect
            .poll(() => lines().some((l) => l.msg === "client hung up mid-body"))
            .toBe(true);
        expect(lines().filter((l) => l.level === "error")).toEqual([]);
    });

    it("one /64 is one key", async () => {
        await order(app);
        const a = "2001:db8:aa:bb::1";
        const b = "2001:db8:aa:bb:ffff::2";
        for (let i = 0; i < 60; i++) {
            expect((await page(app, i % 2 === 0 ? a : b)).status).toBe(200);
        }
        const over = await page(app, b);
        expect(over.status).toBe(429);
        expect(over.headers.get("retry-after")).not.toBeNull();
        // Another /64 of the same /48 has its own 60
        expect((await page(app, "2001:db8:aa:cc::1")).status).toBe(200);
    });

    it("balance answers the owner's USDC", async () => {
        await order(app);
        const payer = app.payer.address;
        const ip = freshIp();
        const ask = (owner: string) =>
            get(app, `/o/${ID}/balance?owner=${owner}`, { "x-forwarded-for": ip });
        const first = await ask(payer);
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ owner: payer, usdcMicros: 0, needMicros: 50_000 });
        const calls = totalCalls(app.rpc);
        expect((await ask(payer)).status).toBe(200);
        expect(totalCalls(app.rpc)).toBe(calls);
        const bad = await ask("abc");
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({ error: "bad_owner" });
        for (let i = 3; i < 20; i++) await ask(payer);
        const over = await ask(payer);
        expect(over.status).toBe(429);
        expect(over.headers.get("retry-after")).not.toBeNull();
    });

    it("balance refuses an order that is not payable", async () => {
        await order(app, { state: "paid", paidAt: at(4 * MIN), payer: "P" });
        const r = await json(app, `/o/${ID}/balance?owner=${app.payer.address}`);
        expect(r.status).toBe(409);
        expect(await r.json()).toEqual({ error: "order_not_payable" });
    });

    it("report logs a cleaned wallet error", async () => {
        await order(app);
        const before = app.log.lines.length;
        const r = await fetch(`${app.publicOrigin}/o/${ID}/report`, {
            method: "POST",
            headers: { "x-forwarded-for": freshIp(), "content-type": "application/json" },
            body: JSON.stringify({
                stage: "sign",
                wallet: "Phantom",
                code: -32603,
                message: "Unexpected\u2028 error\u0000\n\u0085",
            }),
        });
        expect(r.status).toBe(204);
        const lines = app.log.lines.slice(before).filter((l) => l.msg === "checkout wallet error");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
            orderId: ID,
            stage: "sign",
            wallet: "Phantom",
            code: -32603,
            message: "Unexpected error",
        });
    });

    it("report refuses bad bodies", async () => {
        await order(app);
        const ip = freshIp();
        const send = (body: string) =>
            fetch(`${app.publicOrigin}/o/${ID}/report`, {
                method: "POST",
                headers: { "x-forwarded-for": ip, "content-type": "application/json" },
                body,
            });
        const ok = { stage: "sign", wallet: "W", code: null, message: "m" };
        expect((await send(JSON.stringify({ stage: "x" }))).status).toBe(400);
        expect((await send(JSON.stringify({ ...ok, tx: "AAAA" }))).status).toBe(400);
        expect((await send("x".repeat(3_000))).status).toBe(413);
        let last = 0;
        for (let i = 0; i < 9; i++) last = (await send(JSON.stringify(ok))).status;
        expect(last).toBe(429);
    });

    it("methods", async () => {
        await order(app);
        const status = await fetch(`${app.publicOrigin}/o/${ID}/status`, {
            method: "POST",
            headers: { "x-forwarded-for": freshIp() },
        });
        expect(status.status).toBe(405);
        expect((await json(app, `/o/${ID}/report`)).status).toBe(405);
    });
});

describe("deposit routes with new deposits off", () => {
    let app: TestApp;
    beforeAll(async () => {
        app = await testApp({ now: at(5 * MIN), deposits: { enabled: false } });
    });
    afterAll(() => app.close());

    it("no new deposit when disabled", async () => {
        await order(app);
        const html = await (await page(app)).text();
        expect(html).toContain("Paying by address is off right now.");
        const rows = await app.pool.query("select 1 from deposits where order_id = $1", [ID]);
        expect(rows.rowCount).toBe(0);
    });

    it("status works with enabled = false", async () => {
        const o = await order(app);
        const keys = new DepositKeys(new Map([[1, TEST_DEPOSIT_SEED]]), 1);
        await ensureDeposit(app.pool, keys, o, at(5 * MIN), () => TEST_DEPOSIT_SALT);
        await credit(app, "A1", 30_000, "OwnA", at(4 * MIN));
        // An existing address still shows while new ones are off
        expect(await (await page(app)).text()).toContain(ADDRESS);
        app.now.set(at(15 * MIN + 30_000));
        const body = (await (await json(app, `/o/${ID}/status`)).json()) as {
            state: string;
            deposit: { address: string } | null;
        };
        expect(body.deposit?.address).toBe(ADDRESS);
        expect(body.state).toBe("settling");
    });
});

describe("the balance route", () => {
    let app: TestApp;
    let background: ReturnType<typeof createFakeRpc>;
    beforeAll(async () => {
        background = createFakeRpc({ getAccountInfo: () => ({ value: null }) });
        app = await testApp({
            now: at(5 * MIN),
            deposits: {},
            backgroundRpc: background,
        });
    });
    afterAll(() => app.close());
    afterEach(async () => {
        await app.pool.query("truncate orders cascade");
    });

    it("the balance route reads on the background lane", async () => {
        await order(app);
        const before = totalCalls(app.rpc);
        const r = await json(app, `/o/${ID}/balance?owner=${app.payer.address}`);
        expect(r.status).toBe(200);
        // The owner has no USDC account
        expect(await r.json()).toEqual({
            owner: app.payer.address,
            usdcMicros: 0,
            needMicros: 50_000,
        });
        expect(totalCalls(background)).toBe(1);
        expect(totalCalls(app.rpc)).toBe(before);
    });
});

describe("a failing balance read", () => {
    let app: TestApp;
    beforeAll(async () => {
        const background = createFakeRpc({
            getAccountInfo: () => {
                throw new Error("node down");
            },
        });
        app = await testApp({ now: at(5 * MIN), deposits: {}, backgroundRpc: background });
    });
    afterAll(() => app.close());

    it("answers 503 and logs one warn line a minute", async () => {
        await order(app);
        for (const fill of [50, 51]) {
            const owner = getBase58Decoder().decode(new Uint8Array(32).fill(fill));
            const r = await json(app, `/o/${ID}/balance?owner=${owner}`);
            expect(r.status).toBe(503);
            expect(await r.json()).toEqual({ error: "rpc_unavailable" });
        }
        const warned = app.log.lines.filter((l) => l.msg === "deposit balance read failed");
        expect(warned).toEqual([
            expect.objectContaining({ level: "warn", label: "public.balance" }),
        ]);
    });
});

describe("the process-wide balance cap", () => {
    let app: TestApp;
    let background: ReturnType<typeof createFakeRpc>;
    beforeAll(async () => {
        background = createFakeRpc({ getAccountInfo: () => ({ value: null }) });
        app = await testApp({ now: at(5 * MIN), deposits: {}, backgroundRpc: background });
    });
    afterAll(() => app.close());

    it("the balance route is capped process-wide", async () => {
        await order(app);
        const owners = Array.from({ length: 31 }, (_, i) =>
            getBase58Decoder().decode(new Uint8Array(32).fill(i + 40)),
        );
        const codes: number[] = [];
        let last: Response | undefined;
        for (const owner of owners) {
            last = await json(app, `/o/${ID}/balance?owner=${owner}`);
            codes.push(last.status);
        }
        expect(codes.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => 200));
        expect(codes[30]).toBe(503);
        expect(await last!.json()).toEqual({ error: "rpc_unavailable" });
        expect(totalCalls(background)).toBe(30);
    });
});
