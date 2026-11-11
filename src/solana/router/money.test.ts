import { randomBytes } from "node:crypto";
import { getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../../config.ts";
import { reconcileSettling } from "../../jobs/reconciler.ts";
import { memoryLog } from "../../log.ts";
import { findOrder } from "../../orders/store.ts";
import { testDb, type TestDb } from "../../testing/db.ts";
import {
    type FakeChain,
    type FakeChainEndpoint,
    startFakeChain,
} from "../../testing/fake-chain.ts";
import { testSigner } from "../../testing/keys.ts";
import { seedOrder, seedPayment } from "../../testing/orders.ts";
import { usdcAta } from "../accounts.ts";
import { createRouterRpc, type RoutedRpc } from "../rpc.ts";
import { testRpcSettings } from "./testing.ts";

// Money decisions through a real router over fake-chain endpoints a (rpc1) and b (rpc2), each on
// its own loopback port and so its own domain: absence_quorum resolves to 2
const RECIPIENT = "Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw";
const defaults = parseSettings(stringify({ solana: { recipient: RECIPIENT } }), "money.test");
const MIN = 60_000;
// The chain and the router's clock move together, 420 ms a slot
const MS_PER_SLOT = 420;

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

describe("money decisions over the router", () => {
    let chain: FakeChain;
    let payer: KeyPairSigner, owner: KeyPairSigner;
    let source: string, destination: string;
    const clock = { ms: Date.UTC(2030, 0, 1) };
    const routers: RoutedRpc[] = [];
    beforeEach(async () => {
        await db.pool.query("truncate orders cascade");
        chain = await startFakeChain({ autoFinalize: true });
        [payer, owner] = await Promise.all([testSigner(61), testSigner(62)]);
        source = await usdcAta(owner.address);
        destination = await usdcAta(RECIPIENT as never);
        chain.setTokenAccount({ address: source, owner: owner.address, amount: 1_000_000n });
        chain.setTokenAccount({ address: destination, owner: RECIPIENT, amount: 0n });
    });
    afterEach(async () => {
        for (const r of routers.splice(0)) await r.router.stop();
        await chain.close();
    });

    function advance(slots: number) {
        chain.advance(slots);
        clock.ms += slots * MS_PER_SLOT;
    }

    async function routed(endpoints: FakeChainEndpoint[]) {
        const log = memoryLog();
        const r = createRouterRpc(
            testRpcSettings({ attempt_timeout: 300 }),
            endpoints.map((e) => e.url),
            { log, now: () => clock.ms, random: () => 0.5 },
        );
        routers.push(r);
        await r.router.start({ timers: false });
        return { ...r, log };
    }

    // A settling order whose payment row names sig and expires at lastValid
    async function settling(sig: string, lastValid: bigint) {
        const recorded = new Date(clock.ms - 2 * MIN);
        const { order } = await seedOrder(db.pool, {
            state: "settling",
            payer: owner.address,
            createdAt: new Date(recorded.getTime() - MIN),
            expiresAt: new Date(recorded.getTime() + 14 * MIN),
        });
        await seedPayment(db.pool, order.id, {
            txSignature: sig,
            payer: owner.address,
            createdAt: recorded,
            lastValidBlockHeight: lastValid,
        });
        return order.id;
    }

    const reconcile = (r: RoutedRpc, log = memoryLog()) =>
        reconcileSettling({
            pool: db.pool,
            rpc: r.rpc,
            rpcTimeoutMs: 5_000,
            log,
            now: () => new Date(clock.ms),
            paid: null,
            x402: defaults.x402,
        });

    const pay = () =>
        chain.transfer({ authority: owner, feePayer: payer, source, destination, micros: 50_000n });

    for (const mode of [false, "short"] as const) {
        it(`a history-less endpoint never reverts a paid order (history ${String(mode)})`, async () => {
            const a = await chain.addEndpoint({ history: mode });
            const b = await chain.addEndpoint();
            const r = await routed([a, b]);
            const sig = await pay();
            const id = await settling(sig, chain.height() + 5n);
            advance(200);
            const report = await reconcile(r);
            expect(report.reverted).toBe(0);
            expect((await findOrder(db.pool, id))?.state).toBe("paid");
        });
    }

    it("two domains that agree still revert a dropped payment", async () => {
        const r = await routed([await chain.addEndpoint(), await chain.addEndpoint()]);
        const dropped = getBase58Decoder().decode(randomBytes(64));
        const id = await settling(dropped, chain.height() + 5n);
        advance(200);
        const report = await reconcile(r);
        expect(report.reverted).toBe(1);
        expect((await findOrder(db.pool, id))?.state).toBe("unpaid");
    });

    it("with one domain down the order waits", async () => {
        const a = await chain.addEndpoint();
        const b = await chain.addEndpoint();
        const r = await routed([a, b]);
        b.stall("before");
        const dropped = getBase58Decoder().decode(randomBytes(64));
        const id = await settling(dropped, chain.height() + 5n);
        advance(200);
        const report = await reconcile(r);
        expect(report.waiting).toBe(1);
        expect(report.reverted).toBe(0);
        expect((await findOrder(db.pool, id))?.state).toBe("settling");
        expect(r.log.lines.filter((l) => l.alarm === "rpc_absence_unconfirmed")).toHaveLength(1);
    });
});
