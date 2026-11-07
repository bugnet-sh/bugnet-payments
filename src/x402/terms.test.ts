import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "smol-toml";
import { parseSettings } from "../config.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { testSigner } from "../testing/keys.ts";
import { TEST_PAYTO } from "../testing/x402.ts";
import { setControls } from "./controls.ts";
import { bugnetAddresses } from "./ids.ts";
import { x402Terms } from "./terms.ts";
import type { SignerHealth } from "./types.ts";

let db: TestDb;
beforeAll(async () => {
    db = await testDb();
});
afterAll(async () => {
    await db.close();
});

const addresses = bugnetAddresses({
    feePayer: (await testSigner(5)).address,
    allowanceWallet: (await testSigner(11)).address,
    refundWallet: (await testSigner(2)).address,
    recipient: (await testSigner(1)).address,
});
const defaults = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t");
const base = {
    ...defaults.x402,
    enabled: true,
    allowance_wallet: (await testSigner(11)).address,
};
const open: SignerHealth = { open: () => true };

describe("x402Terms", () => {
    it("answers the 7.15 JSON", async () => {
        const t = await x402Terms(db.pool, {
            x402: base,
            allowanceClaim: true,
            signer: open,
            addresses,
        });
        expect(t).toEqual({
            enabled: true,
            startWithX402: true,
            network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            sessionFeeMicros: 3000,
            minAllowanceMicros: 100000,
            suggestedAllowanceMicros: 1000000,
            maxAllowancePerSandboxMicros: 5000000,
            maxPricePerCallMicros: 500000,
            defaultSpendPerMinuteMicros: 500000,
            minSpendPerMinuteMicros: 10000,
            maxSpendPerMinuteMicros: 5000000,
            maxServices: 5,
            maxNewServicesPerOrder: 5,
            sellerMemoMaxBytes: 32,
            refundMinMicros: 10000,
            bugnetAddresses: [
                addresses.feePayer,
                addresses.allowanceWallet,
                addresses.refundWallet,
                addresses.recipient,
            ],
        });
    });

    it.each([
        ["paused", { paused: true }, base, open],
        ["disabled", { disabled: true }, base, open],
        ["signer closed", {}, base, { open: () => false }],
        ["[x402] enabled false", {}, { ...base, enabled: false }, open],
    ])("enabled is false when %s", async (_n, controls, x402, signer) => {
        await setControls(db.pool, controls, "test", new Date());
        try {
            const t = await x402Terms(db.pool, { x402, allowanceClaim: false, signer, addresses });
            expect(t.enabled).toBe(false);
            expect(t.startWithX402).toBe(false);
        } finally {
            await setControls(db.pool, { paused: false, disabled: false }, null, new Date());
        }
    });
});
