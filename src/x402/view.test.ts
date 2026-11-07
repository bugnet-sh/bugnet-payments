import { getBase58Decoder } from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../config.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { testSigner } from "../testing/keys.ts";
import {
    resetLedger,
    seedAccount,
    seedFunding,
    seedService,
    seedX402Payment,
    TEST_PAYTO,
} from "../testing/x402.ts";
import type { AccountState } from "./types.ts";
import { accountView, refundView } from "./view.ts";

const RECIPIENT = "Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw";
const x402 = parseSettings(stringify({ solana: { recipient: RECIPIENT } }), "t").x402;
const SIG = (n: number) => getBase58Decoder().decode(new Uint8Array(64).fill(n));

let db: TestDb;
let PAYER: string;
beforeAll(async () => {
    db = await testDb();
    PAYER = (await testSigner(3)).address;
});
afterAll(async () => {
    await db.close();
});
beforeEach(async () => {
    await resetLedger(db.pool);
});

async function refundRow(
    orderId: string,
    r: {
        kind?: "allowance" | "full";
        state: string;
        amountMicros: number;
        txSignature?: string;
        handTx?: string;
        manualReason?: string;
    },
) {
    const kind = r.kind ?? "allowance";
    await db.pool.query(
        `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state,
            from_wallet, tx_signature, hand_tx, manual_reason)
         values ($1, $2, $3, $4, 'source-test', $5, $6, 'allowance', $7, $8, $9)`,
        [
            orderId,
            kind,
            kind === "allowance" ? "x402_unspent" : "unredeemed",
            r.amountMicros,
            PAYER,
            r.state,
            r.txSignature ?? null,
            r.handTx ?? null,
            r.manualReason ?? null,
        ],
    );
}

async function twoFundings(state: AccountState) {
    const a = await seedAccount(db.pool, { state, fundedMicros: 2_000_000 });
    const f1 = await seedFunding(db.pool, {
        accountId: a.id,
        allowanceMicros: 1_000_000,
        payer: PAYER,
    });
    const f2 = await seedFunding(db.pool, {
        accountId: a.id,
        allowanceMicros: 1_000_000,
        payer: PAYER,
    });
    return { a, f1, f2 };
}

it("the account view of 7.15", async () => {
    const a = await seedAccount(db.pool, {
        fundedMicros: 750_000,
        spentMicros: 730_000,
        heldMicros: 20_000,
        spendPerMinuteMicros: 500_000,
    });
    await seedFunding(db.pool, { accountId: a.id, orderId: a.id, allowanceMicros: 1_000_000 });
    // seedFunding adds its allowance to funded_micros
    await db.pool.query("update x402_accounts set funded_micros = 1000000 where id = $1", [a.id]);
    await seedService(db.pool, {
        accountId: a.id,
        serviceId: "xs_w5a4htopmpzmmhos",
        method: "POST",
        host: "agent402.tools",
        prefix: "/v1/auto/",
        url: "https://agent402.tools/v1/auto/chat/completions",
        maxPriceMicros: 10_000,
        payTo: TEST_PAYTO,
        listed: "indexed",
        paidPath: null,
        state: "enabled",
    });
    for (let i = 0; i < 73; i++) {
        await seedX402Payment(db.pool, { accountId: a.id, state: "confirmed" });
    }
    await seedX402Payment(db.pool, { accountId: a.id, state: "confirmed", lateLanded: true });
    await seedX402Payment(db.pool, { accountId: a.id, state: "reserved" });
    await seedX402Payment(db.pool, { accountId: a.id, state: "signed" });
    await seedX402Payment(db.pool, { accountId: a.id, state: "released" });
    const view = await accountView(db.pool, a.id, x402);
    expect(view).toEqual({
        state: "open",
        fundedMicros: 1_000_000,
        spentMicros: 730_000,
        heldMicros: 20_000,
        leftMicros: 250_000,
        allowanceRoomMicros: 4_000_000,
        paidCalls: 73,
        pendingCalls: 2,
        spendPerMinuteMicros: 500_000,
        services: [
            {
                serviceId: "xs_w5a4htopmpzmmhos",
                method: "POST",
                host: "agent402.tools",
                prefix: "/v1/auto/",
                url: "https://agent402.tools/v1/auto/chat/completions",
                paidPath: null,
                maxPriceMicros: 10_000,
                payTo: TEST_PAYTO,
                listed: "indexed",
                state: "enabled",
            },
        ],
    });
    expect(Object.keys(view)).toEqual([
        "state",
        "fundedMicros",
        "spentMicros",
        "heldMicros",
        "leftMicros",
        "allowanceRoomMicros",
        "paidCalls",
        "pendingCalls",
        "spendPerMinuteMicros",
        "services",
    ]);
    expect("refund" in view).toBe(false);
});

it("a closing account carries its refund view last", async () => {
    const a = await seedAccount(db.pool, { state: "closing" });
    const view = await accountView(db.pool, a.id, x402);
    expect(Object.keys(view).at(-1)).toBe("refund");
    expect(view.refund).toEqual({ state: "waiting", amountMicros: 0, keptMicros: 0, txs: [] });
});

it("an unknown account throws", async () => {
    await expect(accountView(db.pool, "o_missing", x402)).rejects.toThrow(
        "x402 account o_missing not found",
    );
});

describe("refund view states", () => {
    it("closing with no row is waiting", async () => {
        const a = await seedAccount(db.pool, { state: "closing" });
        expect(await refundView(db.pool, a)).toEqual({
            state: "waiting",
            amountMicros: 0,
            keptMicros: 0,
            txs: [],
        });
    });
    it.each([
        ["signed", "pending"],
        ["pending", "pending"],
        ["sent", "sent"],
    ])("a %s row beside a confirmed one is %s", async (rowState, viewState) => {
        const { a, f1, f2 } = await twoFundings("closing");
        await refundRow(f1.orderId, { state: rowState, amountMicros: 400_000 });
        await refundRow(f2.orderId, {
            state: "confirmed",
            amountMicros: 600_000,
            txSignature: SIG(1),
        });
        expect(await refundView(db.pool, a)).toEqual({
            state: viewState,
            amountMicros: 1_000_000,
            keptMicros: 0,
            txs: [SIG(1)],
        });
    });
    it("a manual row not resolved by hand is manual", async () => {
        const { a, f1, f2 } = await twoFundings("closed");
        await refundRow(f1.orderId, {
            state: "manual",
            amountMicros: 400_000,
            manualReason: "refund_destination_invalid",
        });
        await refundRow(f2.orderId, {
            state: "confirmed",
            amountMicros: 600_000,
            txSignature: SIG(1),
        });
        expect((await refundView(db.pool, a))!.state).toBe("manual");
    });
    it("a row resolved by hand counts as confirmed and lists hand_tx", async () => {
        const { a, f1, f2 } = await twoFundings("closed");
        await refundRow(f1.orderId, {
            state: "confirmed",
            amountMicros: 400_000,
            txSignature: SIG(1),
        });
        await refundRow(f2.orderId, {
            state: "manual",
            amountMicros: 600_000,
            handTx: SIG(2),
            manualReason: "resolved_by_hand",
        });
        expect(await refundView(db.pool, a)).toEqual({
            state: "confirmed",
            amountMicros: 1_000_000,
            keptMicros: 0,
            txs: [SIG(1), SIG(2)],
        });
    });
    it("kept only", async () => {
        const a = await seedAccount(db.pool, {
            state: "closed",
            fundedMicros: 4_000,
            keptMicros: 4_000,
        });
        expect(await refundView(db.pool, a)).toEqual({
            state: "kept",
            amountMicros: 0,
            keptMicros: 4_000,
            txs: [],
        });
    });
    it("closed with nothing is confirmed zero", async () => {
        const a = await seedAccount(db.pool, { state: "closed" });
        expect(await refundView(db.pool, a)).toEqual({
            state: "confirmed",
            amountMicros: 0,
            keptMicros: 0,
            txs: [],
        });
    });
    it("a voided funding's full row joins with the voided allowance", async () => {
        const a = await seedAccount(db.pool, { state: "closing" });
        await seedFunding(db.pool, {
            accountId: a.id,
            orderId: a.id,
            allowanceMicros: 1_000_000,
            voidedAt: new Date(),
        });
        await refundRow(a.id, { kind: "full", state: "sent", amountMicros: 1_013_000 });
        expect(await refundView(db.pool, a)).toEqual({
            state: "sent",
            amountMicros: 1_000_000,
            keptMicros: 0,
            txs: [],
        });
        await db.pool.query(
            "update refunds set state = 'confirmed', tx_signature = $2 where order_id = $1",
            [a.id, SIG(3)],
        );
        expect(await refundView(db.pool, a)).toEqual({
            state: "confirmed",
            amountMicros: 1_000_000,
            keptMicros: 0,
            txs: [SIG(3)],
        });
    });
    it("a full refund of a funding that is not voided is not counted", async () => {
        const a = await seedAccount(db.pool, { state: "closing" });
        await seedFunding(db.pool, { accountId: a.id, orderId: a.id, allowanceMicros: 1_000_000 });
        await refundRow(a.id, { kind: "full", state: "sent", amountMicros: 1_013_000 });
        expect((await refundView(db.pool, a))!.state).toBe("waiting");
    });
    it("is undefined while open", async () => {
        expect(await refundView(db.pool, await seedAccount(db.pool, {}))).toBeUndefined();
    });
});

it("the payer is never in the view", async () => {
    const { a, f1 } = await twoFundings("closing");
    await refundRow(f1.orderId, { state: "pending", amountMicros: 400_000 });
    expect(JSON.stringify(await accountView(db.pool, a.id, x402))).not.toContain(PAYER);
});
