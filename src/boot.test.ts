import { type Address, address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { bootChecks } from "./boot.ts";
import { usdcAta } from "./solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "./solana/constants.ts";
import { createFakeRpc, type FakeRpc, type FakeRpcScript } from "./testing/fake-rpc.ts";

const recipient = address("Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw");
const feePayer = address("73iCm2eWpXsEqTpYkNHe4VoiR4Eq7nyCLv9wYZzEnFM9");
const refundWallet = address("57cyJJfb1o617JNvfCZfbXEsPAyK2z8HxEfWSHiVJAq9");
const EVENT_KEY = "a".repeat(43);

interface Overrides {
    programOwner?: string;
    mint?: string;
    owner?: string;
    state?: string;
}

function tokenAccount(owner: Address, o: Overrides = {}) {
    return {
        value: {
            owner: o.programOwner ?? TOKEN_PROGRAM,
            data: {
                program: "spl-token",
                parsed: {
                    type: "account",
                    info: {
                        mint: o.mint ?? USDC_MINT,
                        owner: o.owner ?? owner,
                        state: o.state ?? "initialized",
                        tokenAmount: { amount: "5000000", decimals: 6 },
                    },
                },
            },
        },
    };
}

function okAccounts(script: Partial<FakeRpcScript> = {}, recipientOverrides: Overrides = {}) {
    return createFakeRpc({
        getAccountInfo: async (ata: Address) =>
            ata === (await usdcAta(recipient))
                ? tokenAccount(recipient, recipientOverrides)
                : tokenAccount(refundWallet),
        getBalance: () => ({ value: 100_000_000n }),
        ...script,
    });
}

function deps(rpc: FakeRpc) {
    return {
        rpc,
        recipient,
        feePayer,
        refundWallet,
        feePayerMinLamports: 100_000_000n,
        refundsEnabled: false,
        eventPublicKey: EVENT_KEY,
    };
}

describe("bootChecks", () => {
    it("refuses a missing recipient USDC account", async () => {
        const rpc = createFakeRpc({ getAccountInfo: () => ({ value: null }) });
        await expect(bootChecks(deps(rpc))).rejects.toThrow(
            /recipient USDC account \w+ does not exist.*keys fund --create-recipient-ata/,
        );
    });

    it("refuses a frozen, foreign or wrong-mint recipient account", async () => {
        await expect(bootChecks(deps(okAccounts({}, { state: "frozen" })))).rejects.toThrow(
            /frozen/,
        );
        await expect(bootChecks(deps(okAccounts({}, { owner: feePayer })))).rejects.toThrow(
            /owned by/,
        );
        await expect(bootChecks(deps(okAccounts({}, { mint: feePayer })))).rejects.toThrow(/mint/);
        await expect(bootChecks(deps(okAccounts({}, { programOwner: feePayer })))).rejects.toThrow(
            /owned by program/,
        );
        await expect(bootChecks(deps(okAccounts({}, { state: "uninitialized" })))).rejects.toThrow(
            /not initialized/,
        );
    });

    it("refuses a fee payer below the float", async () => {
        const rpc = okAccounts({ getBalance: () => ({ value: 99_999_999n }) });
        await expect(bootChecks(deps(rpc))).rejects.toThrow(
            "fee payer holds 99999999 lamports, needs at least 100000000",
        );
    });

    it("refuses a missing refund USDC account only when refunds are on", async () => {
        const missingRefund = () =>
            okAccounts({
                getAccountInfo: async (ata: Address) =>
                    ata === (await usdcAta(recipient)) ? tokenAccount(recipient) : { value: null },
            });
        await expect(
            bootChecks({ ...deps(missingRefund()), refundsEnabled: true }),
        ).rejects.toThrow(/refund USDC account \w+ does not exist/);
        await expect(bootChecks(deps(missingRefund()))).resolves.toBeDefined();
    });

    it("refuses refunds without a router event key, before any RPC", async () => {
        const rpc = okAccounts();
        await expect(
            bootChecks({ ...deps(rpc), refundsEnabled: true, eventPublicKey: "" }),
        ).rejects.toThrow(
            'router.event_public_key: set it to the output of bugnet-dev pubkey --priv "$BUGNET_EVENT_SIGNING_KEY"',
        );
        expect(Object.values(rpc.calls).reduce((a, b) => a + b, 0)).toBe(0);
        await expect(
            bootChecks({ ...deps(okAccounts()), refundsEnabled: false, eventPublicKey: "" }),
        ).resolves.toBeDefined();
    });

    it("refuses a recipient equal to the fee payer or the refund wallet", async () => {
        await expect(bootChecks({ ...deps(okAccounts()), recipient: feePayer })).rejects.toThrow(
            /recipient must be a cold address/,
        );
        await expect(
            bootChecks({ ...deps(okAccounts()), recipient: refundWallet }),
        ).rejects.toThrow(/recipient must be a cold address/);
    });

    it("passes and reports the recipient account and fee payer balance", async () => {
        const r = await bootChecks({ ...deps(okAccounts()), refundsEnabled: true });
        expect(r.recipientAta).toBe(await usdcAta(recipient));
        expect(r.feePayerLamports).toBe(100_000_000n);
    });
});
