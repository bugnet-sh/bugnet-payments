import { randomBytes } from "node:crypto";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../config.ts";
import { silentLog } from "../log.ts";
import type { PlacementLookup, RouterClient } from "../router/client.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import {
    agentPin,
    resetLedger,
    seedAccount,
    seedService,
    TEST_PAYTO,
    testIndex,
    usdcAccountAnswer,
} from "../testing/x402.ts";
import {
    accountAnswer,
    configure,
    configureRequestSha256,
    RouterUnavailableError,
} from "./configure.ts";
import type { X402OrderDeps } from "./create.ts";
import { bugnetAddresses, serviceIdFor } from "./ids.ts";
import type { AccountRow, ServiceRow, X402ServicePin } from "./types.ts";

const X = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t").x402;
const PIN = agentPin();
const addresses = bugnetAddresses({
    feePayer: (await testSigner(5)).address,
    allowanceWallet: (await testSigner(11)).address,
    refundWallet: (await testSigner(6)).address,
    recipient: (await testSigner(1)).address,
});

let db: TestDb;
let lookup: "ok" | "unknown" | "error" = "ok";
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await resetLedger(db.pool);
    lookup = "ok";
});

const router: Pick<RouterClient, "lookupPlacement"> = {
    lookupPlacement: async (): Promise<PlacementLookup> =>
        lookup === "error" ? { kind: "unavailable" } : { kind: "unknown" },
};
const deps = (): X402OrderDeps => ({
    x402: { ...X, enabled: true },
    allowanceClaim: true,
    router: router as RouterClient,
    rpc: createFakeRpc({ getAccountInfo: () => usdcAccountAnswer(TEST_PAYTO) }),
    index: testIndex,
    signer: { open: () => true },
    addresses,
    rpcTimeoutMs: 1_000,
    log: silentLog,
    now: () => new Date("2030-01-01T00:00:00Z"),
});

const rid = () => randomBytes(12).toString("base64url");
async function held(over: Partial<ServiceRow> = {}) {
    const a = await seedAccount(db.pool, {
        handleSha256: randomBytes(32).toString("hex"),
        spendPerMinuteMicros: 500_000,
    });
    await seedService(db.pool, {
        accountId: a.id,
        ...PIN,
        paidPath: null,
        state: "enabled",
        ...over,
    });
    return a;
}
const run = (a: { handleSha256: string | null }, over: object = {}) =>
    configure(
        db.pool,
        deps(),
        { handleSha256: a.handleSha256, services: [], disable: [], requestId: rid(), ...over },
        AbortSignal.timeout(5_000),
    );
const svc = async (a: AccountRow, id = PIN.serviceId) =>
    (
        await db.pool.query(
            "select * from x402_services where account_id = $1 and service_id = $2",
            [a.id, id],
        )
    ).rows[0];

describe("configure", () => {
    it("re-prices, disables and sets the minute limit", async () => {
        const a = await held();
        const r = await run(a, { services: [{ ...PIN, maxPriceMicros: 20_000 }] });
        expect(r).toMatchObject({
            status: "ok",
            x402: { services: [{ maxPriceMicros: 20_000, state: "enabled" }] },
        });
        expect((await run(a, { disable: [PIN.serviceId] })).status).toBe("ok");
        expect((await svc(a)).state).toBe("disabled");
        expect(await run(a, { spendPerMinuteMicros: 2_000_000 })).toMatchObject({
            status: "ok",
            x402: { spendPerMinuteMicros: 2_000_000 },
        });
        expect((await run(a, { services: [PIN] })).status).toBe("ok");
        expect((await svc(a)).state).toBe("enabled");
    });

    it("keeps an unreliable service unreliable", async () => {
        const a = await held({ state: "unreliable", failures: 3 });
        expect((await run(a, { services: [{ ...PIN, maxPriceMicros: 20_000 }] })).status).toBe(
            "ok",
        );
        const row = await svc(a);
        expect(row.state).toBe("unreliable");
        expect(row.max_price_micros).toBe("20000");
    });

    it("a new service or payTo answers needs_payment", async () => {
        const a = await held();
        const other = {
            ...PIN,
            serviceId: "xs_beynw7muaoanyeri",
            method: "GET",
            host: "seller.example",
            prefix: "/ok/",
            url: "https://seller.example/ok/x",
        };
        expect(await run(a, { services: [other] })).toEqual({
            status: "refused",
            reason: "needs_payment",
        });
        expect(
            await run(a, { services: [{ ...PIN, payTo: "11111111111111111111111111111112" }] }),
        ).toEqual({ status: "refused", reason: "needs_payment" });
        expect(await run(a, { disable: ["xs_beynw7muaoanyeri"] })).toEqual({
            status: "refused",
            reason: "needs_payment",
        });
        expect((await svc(a)).max_price_micros).toBe("10000");
    });

    it("refuses what the spec lists", async () => {
        expect(await run({ handleSha256: "cd".repeat(32) })).toEqual({
            status: "refused",
            reason: "no_account",
        });
        lookup = "error";
        expect(await run({ handleSha256: "ef".repeat(32) })).toEqual({
            status: "refused",
            reason: "router_unavailable",
        });
        lookup = "ok";
        expect(
            await run(await held(), { services: [{ ...PIN, maxPriceMicros: 500_001 }] }),
        ).toEqual({ status: "refused", reason: "price_above_ceiling" });
        const closing = await held();
        await db.pool.query("update x402_accounts set state = 'closing' where id = $1", [
            closing.id,
        ]);
        expect(await run(closing, { spendPerMinuteMicros: 1_000_000 })).toEqual({
            status: "refused",
            reason: "sandbox_ended",
        });
        const six = await held();
        for (let i = 0; i < 5; i++) {
            const prefix = `/p${i}/`;
            await seedService(db.pool, {
                accountId: six.id,
                ...PIN,
                serviceId: serviceIdFor("GET", "s.example", prefix),
                method: "GET",
                host: "s.example",
                prefix,
                url: `https://s.example${prefix}`,
                paidPath: prefix,
                listed: "unlisted",
                state: i === 4 ? "disabled" : "enabled",
            });
        }
        const sixth = serviceIdFor("GET", "s.example", "/p4/");
        const reEnable: X402ServicePin = {
            ...PIN,
            serviceId: sixth,
            method: "GET",
            host: "s.example",
            prefix: "/p4/",
            url: "https://s.example/p4/",
        };
        expect(await run(six, { services: [reEnable] })).toEqual({
            status: "refused",
            reason: "too_many_services",
        });
        const a = await held({ maxPriceMicros: 20_000 });
        expect(await run(a, { spendPerMinuteMicros: 9_999 })).toEqual({
            status: "refused",
            reason: "spend_rate_out_of_range",
        });
        // F10: a limit under the dearest enabled service
        expect(await run(a, { spendPerMinuteMicros: 10_000 })).toEqual({
            status: "refused",
            reason: "spend_rate_out_of_range",
        });
    });

    it("answers bad_request for a malformed body or an id in both lists", async () => {
        const a = await held();
        expect(await run(a, { requestId: "short" })).toEqual({
            status: "refused",
            reason: "bad_request",
        });
        expect(await run(a, { services: [PIN], disable: [PIN.serviceId] })).toEqual({
            status: "refused",
            reason: "bad_request",
        });
        expect(await run(a, { extra: 1 })).toEqual({ status: "refused", reason: "bad_request" });
    });

    it("never writes a funding and never answers firstUse", async () => {
        const a = await held();
        const count = async () =>
            (
                await db.pool.query(
                    "select (select count(*) from x402_fundings) + (select count(*) from x402_payers) as n",
                )
            ).rows[0].n;
        const before = await count();
        const r = await run(a, { services: [{ ...PIN, maxPriceMicros: 20_000 }] });
        expect(r.status).toBe("ok");
        expect(JSON.stringify(r)).not.toContain("firstUse");
        expect(await count()).toBe(before);
    });

    it("replays a stored answer for a re-probed body and refuses another body", async () => {
        const a = await held();
        const requestId = "req_0123456789abcdef";
        const first = await run(a, { requestId, services: [{ ...PIN, maxPriceMicros: 20_000 }] });
        await run(a, { disable: [PIN.serviceId] });
        const reprobed = {
            ...PIN,
            maxPriceMicros: 20_000,
            listed: "unlisted",
            pinnedFrom: "index",
            probe: { at: "2030-01-01T00:04:00.000Z", status: 402, accepted: null },
        };
        expect(await run(a, { requestId, services: [reprobed] })).toEqual(first);
        expect((await svc(a)).state).toBe("disabled");
        expect(await run(a, { requestId, services: [{ ...PIN, maxPriceMicros: 30_000 }] })).toEqual(
            { status: "refused", reason: "idempotency_conflict" },
        );
    });

    it("does not store a refusal", async () => {
        const a = await held();
        const requestId = "req_refused_0123456";
        const body = { requestId, services: [{ ...PIN, maxPriceMicros: 500_001 }] };
        expect((await run(a, body)).status).toBe("refused");
        const stored = await db.pool.query("select 1 from x402_configure_requests");
        expect(stored.rowCount).toBe(0);
    });

    it("two concurrent twins answer the same", async () => {
        const a = await held();
        const body = {
            requestId: "req_twin_0123456789",
            services: [{ ...PIN, maxPriceMicros: 30_000 }],
        };
        const [x, y] = await Promise.all([run(a, body), run(a, body)]);
        expect(x).toEqual(y);
        expect(x.status).toBe("ok");
        const stored = await db.pool.query("select 1 from x402_configure_requests");
        expect(stored.rowCount).toBe(1);
    });
});

describe("configureRequestSha256", () => {
    it("ignores probe, listed, pinnedFrom and order", () => {
        const r = {
            handleSha256: "ab".repeat(32),
            services: [PIN],
            disable: ["xs_b", "xs_a"],
            requestId: "x".repeat(16),
        };
        const same = {
            ...r,
            services: [{ ...PIN, listed: "unlisted" as const, pinnedFrom: "index" as const }],
            disable: ["xs_a", "xs_b", "xs_a"],
        };
        expect(configureRequestSha256(same)).toEqual(configureRequestSha256(r));
        expect(configureRequestSha256({ ...r, spendPerMinuteMicros: 1 })).not.toEqual(
            configureRequestSha256(r),
        );
    });
});

describe("accountAnswer", () => {
    it("throws when the router is down and answers null for an unknown handle", async () => {
        lookup = "error";
        await expect(
            accountAnswer(db.pool, deps(), "ab".repeat(32), AbortSignal.timeout(5_000)),
        ).rejects.toBeInstanceOf(RouterUnavailableError);
        lookup = "unknown";
        expect(
            await accountAnswer(db.pool, deps(), "ab".repeat(32), AbortSignal.timeout(5_000)),
        ).toEqual({ x402: null, feeDue: true });
    });
});
