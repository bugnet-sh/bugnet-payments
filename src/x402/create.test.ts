import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../config.ts";
import { silentLog } from "../log.ts";
import type { PlacementLookup, RouterClient } from "../router/client.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { seedOrder } from "../testing/orders.ts";
import {
    agentPin,
    resetLedger,
    sellerPin,
    seedAccount,
    seedFunding,
    seedService,
    TEST_HANDLE_SHA256,
    TEST_PAYTO,
    testIndex,
    usdcAccountAnswer,
} from "../testing/x402.ts";
import { setControls } from "./controls.ts";
import {
    type CreatePlan,
    planOrder,
    RpcUnavailableError,
    sameSetupTerms,
    settleGate,
    spendRateFits,
    type ValidCreate,
    type X402OrderDeps,
} from "./create.ts";
import { bugnetAddresses, serviceIdFor } from "./ids.ts";
import { findAccount } from "./ledger.ts";
import type { StoredPin, StoredX402Setup, X402ServicePin } from "./types.ts";

const X = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t").x402;
const AT = new Date("2030-01-01T00:00:00Z");
const P = "8f9c0a52-0000-4000-8000-000000000001";
const D = new Date("2030-01-01T01:00:00Z");
const EF = "ef".repeat(32);
const addresses = bugnetAddresses({
    feePayer: (await testSigner(5)).address,
    allowanceWallet: (await testSigner(11)).address,
    refundWallet: (await testSigner(6)).address,
    recipient: (await testSigner(1)).address,
});

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});
beforeEach(() => resetLedger(db.pool));

interface Over {
    x402?: Partial<typeof X>;
    allowanceClaim?: boolean;
    signerOpen?: boolean;
    router?: Pick<RouterClient, "lookupPlacement">;
    rpc?: SolanaRpc;
}

const notFound: Over["router"] = { lookupPlacement: async () => ({ kind: "unknown" }) };
const unavailable: Over["router"] = { lookupPlacement: async () => ({ kind: "unavailable" }) };
const lookup = (
    over: Partial<Extract<PlacementLookup, { kind: "found" }>> = {},
): Over["router"] => ({
    lookupPlacement: async () => ({
        kind: "found",
        placementId: P,
        startOrderId: "unused",
        state: "ready",
        deadline: D,
        endedAt: null,
        x402Capable: true,
        packageId: "cpu-small",
        ...over,
    }),
});
const throwingAccountInfo = createFakeRpc({
    getAccountInfo: () => {
        throw new Error("rpc down");
    },
});

function deps(over: Over = {}): X402OrderDeps {
    return {
        x402: { ...X, enabled: true, ...over.x402 },
        allowanceClaim: over.allowanceClaim ?? true,
        router: (over.router ?? notFound) as RouterClient,
        rpc: over.rpc ?? createFakeRpc({ getAccountInfo: () => usdcAccountAnswer(TEST_PAYTO) }),
        index: testIndex,
        signer: { open: () => over.signerOpen ?? true },
        addresses,
        rpcTimeoutMs: 1_000,
        log: silentLog,
        now: () => AT,
    };
}
const plan = (r: ValidCreate, over: Over = {}) =>
    planOrder(db.pool, deps(over), r, AbortSignal.timeout(5_000));

const allowance = (over: Partial<ValidCreate> = {}): ValidCreate => ({
    kind: "allowance",
    packageId: "x402-allowance",
    amountMicros: 1_003_000,
    allowanceMicros: 1_000_000,
    feeMicros: 3_000,
    description: "ignored",
    handleSha256: TEST_HANDLE_SHA256,
    ...over,
});
const start = (over: Partial<ValidCreate> = {}): ValidCreate => ({
    kind: "start",
    packageId: "cpu-small",
    amountMicros: 1_013_000,
    allowanceMicros: 1_000_000,
    feeMicros: 3_000,
    description: "Bugnet sandbox 2 vCPU / 2 GiB, 10 min",
    ...over,
});
const why = async (r: ValidCreate, over: Over = {}) => {
    const p = await plan(r, over);
    return p.ok ? "ok" : p.refused.reason;
};
const okPin = (over: Partial<X402ServicePin> = {}) => sellerPin(1, over);
const badPin = sellerPin(2, {
    probe: { at: "2030-01-01T00:00:00.000Z", status: 200, accepted: null },
});

function accepted(p: CreatePlan): StoredX402Setup {
    if (!p.ok) throw new Error(`refused: ${p.refused.reason}`);
    return p.setup!;
}

describe("planOrder", () => {
    it("decides the fee and refuses fee_mismatch", async () => {
        await seedAccount(db.pool);
        expect(await why(allowance({ amountMicros: 1_000_000, feeMicros: 0 }))).toBe(
            "fee_mismatch",
        );
        expect(await plan(allowance())).toMatchObject({
            ok: true,
            payInto: "allowance",
            feeMicros: 3_000,
        });
        const a = await seedAccount(db.pool, { handleSha256: "cd".repeat(32) });
        await seedFunding(db.pool, { accountId: a.id, orderId: a.id });
        expect(await why(allowance({ handleSha256: "cd".repeat(32) }))).toBe("fee_mismatch");
        expect(
            await why(
                allowance({
                    handleSha256: "cd".repeat(32),
                    amountMicros: 1_000_000,
                    feeMicros: 0,
                }),
            ),
        ).toBe("ok");
        expect(await plan(start())).toMatchObject({
            ok: true,
            payInto: "allowance",
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
        });
        expect(await why(start({ feeMicros: 0, amountMicros: 1_010_000 }))).toBe("fee_mismatch");
    });

    it("runs the create checks in table order", async () => {
        await seedAccount(db.pool);
        expect(await why(allowance(), { x402: { enabled: false } })).toBe("x402_disabled");
        await setControls(db.pool, { disabled: true }, "t", AT);
        expect(await why(allowance())).toBe("x402_disabled");
        await setControls(db.pool, { disabled: false, paused: true }, "t", AT);
        expect(await why(allowance())).toBe("x402_paused");
        await setControls(db.pool, { paused: false }, null, AT);
        expect(await why(allowance(), { signerOpen: false })).toBe("x402_unavailable");
        expect(await why(start(), { allowanceClaim: false })).toBe("x402_start_unavailable");
        expect(await why(allowance({ allowanceMicros: 99_999, amountMicros: 102_999 }))).toBe(
            "amount_too_small",
        );
        expect(await why(allowance({ handleSha256: EF }), { router: notFound })).toBe(
            "sandbox_unknown",
        );
        expect(await why(allowance({ handleSha256: EF }), { router: unavailable })).toBe(
            "router_unavailable",
        );
        expect(
            await why(allowance({ handleSha256: EF }), {
                router: lookup({ state: "terminated" }),
            }),
        ).toBe("sandbox_ended");
        await seedAccount(db.pool, { handleSha256: "aa".repeat(32), state: "closing" });
        expect(await why(allowance({ handleSha256: "aa".repeat(32) }))).toBe("sandbox_ended");
        expect(
            await why(allowance({ handleSha256: EF }), {
                router: lookup({ x402Capable: false }),
            }),
        ).toBe("sandbox_not_capable");

        const full = await seedAccount(db.pool, { handleSha256: "bb".repeat(32) });
        for (let i = 11; i < 16; i++) {
            const prefix = `/s${i}/`;
            await seedService(db.pool, {
                accountId: full.id,
                serviceId: serviceIdFor("POST", "seller.example", prefix),
                host: "seller.example",
                prefix,
                url: `https://seller.example${prefix}run`,
            });
        }
        expect(
            await why(allowance({ handleSha256: "bb".repeat(32), x402: { services: [okPin()] } })),
        ).toBe("too_many_services");
        expect(
            await why(allowance({ x402: { services: [okPin({ maxPriceMicros: 500_001 })] } })),
        ).toBe("price_above_ceiling");
        expect(await plan(allowance({ x402: { services: [badPin] } }))).toMatchObject({
            ok: false,
            refused: {
                status: "refused",
                reason: "pin_refused",
                serviceId: badPin.serviceId,
                pinReason: "no_402",
            },
        });
        expect(await why(allowance({ x402: { spendPerMinuteMicros: 9_999 } }))).toBe(
            "spend_rate_out_of_range",
        );
        expect(await why(allowance({ x402: { spendPerMinuteMicros: 5_000_001 } }))).toBe(
            "spend_rate_out_of_range",
        );
        expect(
            await why(
                allowance({
                    x402: {
                        services: [okPin({ maxPriceMicros: 20_000 })],
                        spendPerMinuteMicros: 10_000,
                    },
                }),
            ),
        ).toBe("spend_rate_out_of_range");
        expect(
            await why(allowance({ x402: { services: [okPin(), sellerPin(3), sellerPin(4)] } }), {
                x402: { max_new_services_per_order: 2 },
            }),
        ).toBe("description_too_long");
        const funded = await seedAccount(db.pool, { handleSha256: "dd".repeat(32) });
        await seedFunding(db.pool, { accountId: funded.id });
        expect(
            await why(
                allowance({
                    handleSha256: "dd".repeat(32),
                    allowanceMicros: 4_000_001,
                    amountMicros: 4_003_001,
                }),
            ),
        ).toBe("allowance_ceiling");
        expect(
            await why(
                allowance({
                    handleSha256: "dd".repeat(32),
                    allowanceMicros: 4_000_000,
                    amountMicros: 4_003_000,
                }),
            ),
        ).toBe("ok");
    });

    it("counts services after the order: disabled ones free a place, disable removes one", async () => {
        const a = await seedAccount(db.pool, { handleSha256: "bb".repeat(32) });
        const ids: string[] = [];
        for (let i = 11; i < 16; i++) {
            const prefix = `/s${i}/`;
            const serviceId = serviceIdFor("POST", "seller.example", prefix);
            ids.push(serviceId);
            await seedService(db.pool, {
                accountId: a.id,
                serviceId,
                host: "seller.example",
                prefix,
                url: `https://seller.example${prefix}run`,
                state: i === 11 ? "disabled" : "enabled",
            });
        }
        const r = allowance({ handleSha256: "bb".repeat(32) });
        expect(await why({ ...r, x402: { services: [okPin()] } })).toBe("ok");
        expect(await why({ ...r, x402: { services: [okPin(), sellerPin(3)] } })).toBe(
            "too_many_services",
        );
        expect(
            await why({
                ...r,
                x402: { services: [okPin(), sellerPin(3)], disable: [ids[1]!] },
            }),
        ).toBe("ok");
    });

    it("gives a sandbox with no account one in its own transaction", async () => {
        const { order } = await seedOrder(db.pool, { kind: "start", state: "redeemed" });
        const router = lookup({
            startOrderId: order.id,
            placementId: P,
            deadline: D,
            packageId: "cpu-small",
        });
        const six = [1, 2, 3, 4, 5, 6].map((n) => sellerPin(n));
        expect(
            await why(allowance({ handleSha256: EF, x402: { services: six } }), { router }),
        ).toBe("too_many_services");
        expect(await findAccount(db.pool, order.id)).toMatchObject({
            handleSha256: EF,
            placementId: P,
            deadline: D,
            packageId: "cpu-small",
            spendPerMinuteMicros: 500_000,
            state: "open",
        });
    });

    it("answers sandbox_unknown when the placement's start order is not ours", async () => {
        const router = lookup({ startOrderId: "ord_missing" });
        expect(await why(allowance({ handleSha256: EF }), { router })).toBe("sandbox_unknown");
    });

    it("takes listed and paid_path from Payments' own index and the rest from the account", async () => {
        const a = await seedAccount(db.pool);
        const fresh = accepted(
            await plan(allowance({ x402: { services: [agentPin({ listed: "unlisted" })] } })),
        );
        expect(fresh.services).toHaveLength(1);
        expect(fresh.services[0]).toMatchObject({
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
            newPin: true,
        });
        const indexed = accepted(await plan(allowance({ x402: { services: [agentPin()] } })));
        expect(indexed.services[0]).toMatchObject({ listed: "indexed", paidPath: null });

        await seedService(db.pool, {
            accountId: a.id,
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
        });
        const held = accepted(
            await plan(allowance({ x402: { services: [agentPin({ maxPriceMicros: 20_000 })] } })),
        );
        expect(held.services[0]).toMatchObject({
            maxPriceMicros: 20_000,
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
            newPin: false,
        });
    });

    it("treats a held service with another payTo as a new pin", async () => {
        const a = await seedAccount(db.pool);
        await seedService(db.pool, { accountId: a.id, payTo: addresses.recipient });
        const setup = accepted(await plan(allowance({ x402: { services: [agentPin()] } })));
        expect(setup.services[0]).toMatchObject({ newPin: true, listed: "indexed" });
    });

    it("stores disable and the minute limit as sent, null when absent", async () => {
        const a = await seedAccount(db.pool);
        await seedService(db.pool, { accountId: a.id });
        const id = serviceIdFor("POST", "agent402.tools", "/v1/auto/");
        const withBoth = await plan(
            allowance({ x402: { disable: [id], spendPerMinuteMicros: 20_000 } }),
        );
        expect(accepted(withBoth)).toEqual({
            services: [],
            disable: [id],
            spendPerMinuteMicros: 20_000,
        });
        expect(accepted(await plan(allowance()))).toEqual({
            services: [],
            disable: [],
            spendPerMinuteMicros: null,
        });
    });

    it("writes the description from the pins and gives the order its TTL", async () => {
        await seedAccount(db.pool);
        const p = await plan(allowance({ x402: { services: [agentPin()] } }));
        expect(p).toMatchObject({
            ok: true,
            ttlMs: 300_000,
            description:
                "Bugnet x402 $1.00 + $0.003 fee: agent402.tools/v1/auto/ up to $0.01 pays 4vJ9...kLKi",
        });
        const s = await plan(start({ x402: { services: [okPin()] } }));
        expect(s).toMatchObject({
            ok: true,
            description:
                "Bugnet sandbox 2 vCPU / 2 GiB, 10 min + x402 $1.00 + $0.003 fee: seller.example/p1/run up to $0.01 pays 4vJ9...kLKi (unreviewed)",
        });
    });

    it("refuses a pin that Postgres could not store as jsonb", async () => {
        await seedAccount(db.pool);
        for (const text of ["a\u0000b", "a\ud800b"]) {
            const pin = okPin({
                probe: {
                    at: "2030-01-01T00:00:00.000Z",
                    status: 402,
                    accepted: { ...(agentPin().probe.accepted as object), note: text },
                },
            });
            expect(await plan(allowance({ x402: { services: [pin] } }))).toMatchObject({
                ok: false,
                refused: { reason: "pin_refused", serviceId: pin.serviceId },
            });
        }
    });

    it("answers RpcUnavailableError when the payee check cannot reach the RPC", async () => {
        await seedAccount(db.pool);
        await expect(
            plan(allowance({ x402: { services: [okPin()] } }), { rpc: throwingAccountInfo }),
        ).rejects.toBeInstanceOf(RpcUnavailableError);
    });
});

describe("settleGate", () => {
    it("reads the switch, the controls and the signer in that order", async () => {
        const d = deps();
        expect(await settleGate(db.pool, d)).toBeNull();
        expect(await settleGate(db.pool, deps({ signerOpen: false }))).toBe("x402_unavailable");
        await setControls(db.pool, { paused: true }, "t", AT);
        expect(await settleGate(db.pool, deps({ signerOpen: false }))).toBe("x402_paused");
        await setControls(db.pool, { disabled: true }, "t", AT);
        expect(await settleGate(db.pool, d)).toBe("x402_disabled");
        expect(await settleGate(db.pool, deps({ x402: { enabled: false } }))).toBe("x402_disabled");
    });
});

describe("sameSetupTerms", () => {
    const stored = (over: Partial<StoredPin> = {}): StoredX402Setup => ({
        services: [sellerPin(1), sellerPin(2)].map((p) => ({
            ...p,
            paidPath: "/p/run",
            newPin: true,
            ...over,
        })),
        disable: ["a", "b"],
        spendPerMinuteMicros: null,
    });

    it("compares setups by their terms only", () => {
        const s = stored();
        const sent = {
            services: [sellerPin(2), sellerPin(1)].map((p) => ({
                ...p,
                listed: "indexed" as const,
                pinnedFrom: "index" as const,
                probe: { at: "later", status: 200, accepted: null },
            })),
            disable: ["b", "a", "a"],
        };
        expect(sameSetupTerms(sent, s)).toBe(true);
        expect(
            sameSetupTerms({ ...sent, services: [{ ...sent.services[0]!, maxPriceMicros: 1 }] }, s),
        ).toBe(false);
        expect(sameSetupTerms({ ...sent, disable: ["a"] }, s)).toBe(false);
        expect(sameSetupTerms({ ...sent, spendPerMinuteMicros: 20_000 }, s)).toBe(false);
        expect(sameSetupTerms(undefined, s)).toBe(true);
        expect(sameSetupTerms(undefined, null)).toBe(true);
        expect(sameSetupTerms({}, null)).toBe(false);
        expect(sameSetupTerms({ services: [], disable: [] }, { ...s, services: [] })).toBe(false);
        expect(
            sameSetupTerms(
                { services: sent.services, disable: ["a", "b"], spendPerMinuteMicros: undefined },
                s,
            ),
        ).toBe(true);
    });
});

describe("spendRateFits", () => {
    it("fits the minute limit to its range and to every enabled max", () => {
        expect(spendRateFits(10_000, [10_000], X)).toBe(true);
        expect(spendRateFits(10_000, [20_000], X)).toBe(false);
        expect(spendRateFits(9_999, [], X)).toBe(false);
        expect(spendRateFits(5_000_001, [], X)).toBe(false);
        expect(spendRateFits(5_000_000, [5_000_000], X)).toBe(true);
    });
});
