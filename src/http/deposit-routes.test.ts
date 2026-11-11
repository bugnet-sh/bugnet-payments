import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DepositKeys } from "../deposits/keys.ts";
import { ensureDeposit, insertTransfers } from "../deposits/store.ts";
import { TEST_DEPOSIT_SALT, TEST_DEPOSIT_SEED } from "../testing/app.ts";
import { seedOrder } from "../testing/orders.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
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
        const body = (await r.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
            orderId: ID,
            state: "unpaid",
            expiresAt: "2030-01-01T00:15:00.000Z",
            now: "2030-01-01T00:05:00.000Z",
            amountMicros: 50_000,
            kind: "start",
        });
        expect(body.deposit).toMatchObject({
            address: ADDRESS,
            ready: false,
            status: "partial",
            receivedMicros: 30_000,
            otherMicros: 0,
            remainingMicros: 20_000,
        });
        expect(totalCalls(app.rpc)).toBe(before);
    });

    it("status without a deposit", async () => {
        await order(app);
        const body = (await (await json(app, `/o/${ID}/status`)).json()) as { deposit: unknown };
        expect(body.deposit).toBeNull();
    });

    it("a checkout status poll notes the viewer with facts", async () => {
        await order(app);
        await page(app);
        const now = app.now.get().getTime();
        await json(app, `/o/${ID}/status`);
        expect(app.watch!.viewerSeen(ID, now)).toBe(false);
        await json(app, `/o/${ID}/status`, { "bugnet-client": "checkout" });
        expect(app.watch!.viewerSeen(ID, now)).toBe(true);
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
                message: "Unexpected error\u0000\n",
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
        expect((await json(app, `/o/${ID}/balance?owner=${app.payer.address}`)).status).toBe(200);
        expect(totalCalls(background)).toBe(1);
        expect(totalCalls(app.rpc)).toBe(before);
    });

    it("the balance route is capped process-wide", async () => {
        await order(app);
        const owners = Array.from({ length: 31 }, (_, i) => {
            const bytes = new Uint8Array(32).fill(i + 40);
            return bytes;
        });
        const { getBase58Decoder } = await import("@solana/kit");
        const before = totalCalls(background);
        const codes: number[] = [];
        for (const o of owners) {
            const owner = getBase58Decoder().decode(o);
            codes.push((await json(app, `/o/${ID}/balance?owner=${owner}`)).status);
        }
        expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(30);
        expect(codes.at(-1)).toBe(503);
        expect(totalCalls(background) - before).toBeLessThanOrEqual(30);
    });
});
