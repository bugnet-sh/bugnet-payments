import type { Address } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { silentLog } from "../log.ts";
import { usdcAta } from "../solana/accounts.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { createFakeRpc } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import {
    resetLedger,
    seedAccount,
    seedX402Payment,
    TEST_PAYTO,
    usdcAccountAnswer,
} from "../testing/x402.ts";
import { recordIncident } from "./incidents.ts";
import { setControls } from "./controls.ts";
import { openTail } from "./tail.ts";
import { x402Status } from "./status.ts";

const NOW = new Date("2030-01-01T12:00:00Z");
let db: TestDb;
let HOT: Address;
let x402: Settings["x402"];

beforeAll(async () => {
    db = await testDb();
    HOT = await usdcAta((await testSigner(11)).address);
    x402 = parseSettings(stringify({ solana: { recipient: TEST_PAYTO } }), "t").x402;
});
beforeEach(async () => {
    await resetLedger(db.pool);
    await db.pool.query("truncate x402_incidents");
});
afterAll(async () => {
    await db.close();
});

describe("x402Status", () => {
    it("prints every fact", async () => {
        await setControls(db.pool, { paused: true }, "test pause", NOW);
        await db.pool.query("update x402_pool set committed_micros = 1000000, unpaid_micros = 0");
        const a = await seedAccount(db.pool, { fundedMicros: 1_000_000 });
        const late = await seedX402Payment(db.pool, {
            accountId: a.id,
            state: "signed",
            signedAt: new Date(NOW.getTime() - 600_001),
            signingSlot: 4_242n,
            lastValidBlockHeight: 5_151n,
        });
        await seedX402Payment(db.pool, {
            accountId: a.id,
            state: "signed",
            signedAt: new Date(NOW.getTime() - 1_000),
            signingSlot: 7_777n,
        });
        await openTail(db.pool, HOT, 0n, 900n, NOW);
        await withTx(db.pool, (c) =>
            recordIncident(
                c,
                { kind: "balance_short", subject: "balance_short", detail: {} },
                silentLog,
                NOW,
            ),
        );
        const text = (await x402Status(db.pool, null, HOT, x402, NOW)).join("\n");
        expect(text).toContain("paused: true");
        expect(text).toContain("reason: incident balance_short");
        expect(text).toContain("pool committed=1000000 unpaid=0");
        expect(text).toContain("liabilities: 1000000");
        expect(text).toContain("chain balance: unavailable");
        expect(text).toContain(`verified_slot: 900 verified_at: ${NOW.toISOString()} lag_slots: -`);
        expect(text).toContain("accounts open=1 closing=0");
        expect(text).toContain(
            `signed ${late.id} signed_at=${late.signedAt!.toISOString()} signing_slot=4242 last_valid_block_height=5151`,
        );
        expect(text).not.toContain("signing_slot=7777");
        expect(text).toContain("events pending=0");
        expect(text).toMatch(/incident \d+ balance_short balance_short loss=0 at=/);
    });

    it("prints the finalized balance and the lag in slots", async () => {
        await openTail(db.pool, HOT, 0n, 900n, NOW);
        const answer = usdcAccountAnswer(TEST_PAYTO) as {
            value: { data: { parsed: { info: { tokenAmount: { amount: string } } } } };
        };
        answer.value.data.parsed.info.tokenAmount.amount = "1000000";
        const rpc = createFakeRpc({
            getAccountInfo: () => ({ context: { slot: 1_000n }, value: answer.value }),
        });
        const lines = await x402Status(db.pool, rpc, HOT, x402, NOW);
        expect(lines).toContain("chain balance: 1000000 at slot 1000");
        expect(lines.find((l) => l.startsWith("verified_slot"))).toMatch(/lag_slots: 100$/);
    });

    it("an RPC error prints chain balance: unavailable", async () => {
        const rpc = createFakeRpc({
            getAccountInfo: () => {
                throw new Error("429");
            },
        });
        expect(await x402Status(db.pool, rpc, HOT, x402, NOW)).toContain(
            "chain balance: unavailable",
        );
    });

    it("a missing account prints chain balance: account missing", async () => {
        const rpc = createFakeRpc({ getAccountInfo: () => ({ value: null }) });
        expect(await x402Status(db.pool, rpc, HOT, x402, NOW)).toContain(
            "chain balance: account missing",
        );
    });
});
