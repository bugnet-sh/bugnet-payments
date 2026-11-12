import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BootCheckError } from "../boot.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { seedOrder } from "../testing/orders.ts";
import { checkDepositKeys, DepositKeyMissing, DepositKeys, depositKeysFrom } from "./keys.ts";

const S1 = Buffer.alloc(16, 1);
const SEED_7 = Buffer.alloc(32, 7);
const SEED_8 = Buffer.alloc(32, 8);
const ORDER_A = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORDER_B = "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_A = "BGx7SpE3VBc356Bhn9Y2GUvkecpfPjSkSM9iRxJ63Ley";
const TOKEN_A = "D2mAKdUVEHvizHThmG57bTCiASiiYj5gQbMeMoyWtQo1";
const CREATED = new Date("2030-01-01T00:00:00Z");
const EXPIRES = new Date("2030-01-01T00:15:00Z");

const keys7 = (): DepositKeys => new DepositKeys(new Map([[1, SEED_7]]), 1);

describe("DepositKeys", () => {
    it("golden vector", async () => {
        await expect(keys7().address(ORDER_A, S1)).resolves.toEqual({
            address: ADDRESS_A,
            tokenAccount: TOKEN_A,
            keyVersion: 1,
        });
    });

    it("another order, another address", async () => {
        const got = await keys7().address(ORDER_B, S1);
        expect(got.address).toBe("Fvkkb7d7zpJZcyUsygPojncsHASt2VtQB6hLRTHKp4aB");
    });

    it("another salt, another address", async () => {
        const got = await keys7().address(ORDER_A, Buffer.alloc(16, 2));
        expect(got.address).toBe("C7Qrh164bHd57YUthbnb9VAUKrq9bc7FybKuPC5EnmXz");
    });

    it("another seed, another address", async () => {
        const keys = new DepositKeys(new Map([[1, SEED_8]]), 1);
        const got = await keys.address(ORDER_A, S1);
        expect(got.address).toBe("7dPzXCP3K8goCUqBJLiRNz2Zei5FEHGUbuaEN5EMEB9K");
    });

    it("the signer matches the address and is not extractable", async () => {
        const signer = await keys7().signer(ORDER_A, S1, 1);
        expect(signer.address).toBe(ADDRESS_A);
        await expect(crypto.subtle.exportKey("pkcs8", signer.keyPair.privateKey)).rejects.toThrow();
    });

    it("previous version signs old deposits", async () => {
        const keys = depositKeysFrom({ depositSeed: SEED_8, depositSeedPrevious: SEED_7 }, 2);
        expect(keys).not.toBeNull();
        expect(keys!.current).toBe(2);
        expect((await keys!.signer(ORDER_A, S1, 1)).address).toBe(ADDRESS_A);
        const now = await keys!.address(ORDER_A, S1);
        expect(now.keyVersion).toBe(2);
        expect(now.address).toBe("7dPzXCP3K8goCUqBJLiRNz2Zei5FEHGUbuaEN5EMEB9K");
        await expect(keys!.signer(ORDER_A, S1, 3)).rejects.toBeInstanceOf(DepositKeyMissing);
        const archived = keys!.withSeed(3, SEED_7);
        expect((await archived.signer(ORDER_A, S1, 3)).address).toBe(ADDRESS_A);
        expect(keys!.has(3)).toBe(false);
    });

    it("without a current seed there are no keys", () => {
        expect(depositKeysFrom({ depositSeed: null, depositSeedPrevious: SEED_7 }, 2)).toBeNull();
    });

    it("version 1 has no previous version", () => {
        const keys = depositKeysFrom({ depositSeed: SEED_8, depositSeedPrevious: SEED_7 }, 1);
        expect(keys!.has(1)).toBe(true);
        expect(keys!.has(0)).toBe(false);
    });

    it("a missing version names the version only", async () => {
        const err = await keys7()
            .signer(ORDER_A, S1, 3)
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DepositKeyMissing);
        expect((err as Error).message).toContain("version 3");
        expect((err as Error).message).not.toContain(SEED_7.toString("base64"));
    });
});

describe("checkDepositKeys", () => {
    let db: TestDb;
    beforeAll(async () => {
        db = await testDb();
    });
    afterAll(async () => {
        await db.close();
    });
    beforeEach(async () => {
        await db.pool.query("truncate orders cascade");
    });

    async function deposit(
        orderId: string,
        o: { address: string; tokenAccount: string; keyVersion: number; state?: string },
    ): Promise<void> {
        await seedOrder(db.pool, {
            id: orderId,
            amountMicros: 50_000,
            createdAt: CREATED,
            expiresAt: EXPIRES,
        });
        await db.pool.query(
            `insert into deposits (order_id, address, token_account, key_version, salt, state,
                created_at)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [orderId, o.address, o.tokenAccount, o.keyVersion, S1, o.state ?? "open", CREATED],
        );
    }

    it("boot check refuses a changed seed", async () => {
        await deposit(ORDER_A, { address: ADDRESS_A, tokenAccount: TOKEN_A, keyVersion: 1 });
        await expect(checkDepositKeys(db.pool, keys7())).resolves.toBeUndefined();
        const changed = new DepositKeys(new Map([[1, SEED_8]]), 1);
        const err = await checkDepositKeys(db.pool, changed).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BootCheckError);
        const message = (err as Error).message;
        expect(message).toContain(
            "does not derive the stored deposit address of ord_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        expect(message).not.toContain(SEED_8.toString("base64"));
        expect(message).not.toContain(SEED_7.toString("base64"));
    });

    it("boot check refuses a missing version", async () => {
        await deposit(ORDER_A, { address: ADDRESS_A, tokenAccount: TOKEN_A, keyVersion: 1 });
        await deposit(ORDER_B, {
            address: "Fvkkb7d7zpJZcyUsygPojncsHASt2VtQB6hLRTHKp4aB",
            tokenAccount: "other-token-account",
            keyVersion: 1,
            state: "done",
        });
        const err = await checkDepositKeys(db.pool, null).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BootCheckError);
        expect((err as Error).message).toBe(
            "BUGNET_DEPOSIT_SEED for version 1 is missing while 1 deposits use it; " +
                "restore it or set BUGNET_DEPOSIT_SEED_PREVIOUS",
        );
        await db.pool.query("update deposits set state = 'done' where order_id = $1", [ORDER_A]);
        await expect(checkDepositKeys(db.pool, null)).resolves.toBeUndefined();
    });

    it("boot check refuses a seed loaded under another version's number, done deposits too", async () => {
        await deposit(ORDER_A, {
            address: ADDRESS_A,
            tokenAccount: TOKEN_A,
            keyVersion: 1,
            state: "done",
        });
        await expect(checkDepositKeys(db.pool, keys7())).resolves.toBeUndefined();
        // Seed 8 read as version 1, as after seed_version fell back to its default
        const misnumbered = new DepositKeys(new Map([[1, SEED_8]]), 1);
        const err = await checkDepositKeys(db.pool, misnumbered).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BootCheckError);
        expect((err as Error).message).toBe(
            "BUGNET_DEPOSIT_SEED loaded as version 1 does not derive ord_aaaaaaaaaaaaaaaaaaaaaaaaaa, " +
                "the newest deposit of that version; if /etc/bugnet/payments.rotating exists, " +
                "run vps-install.sh --rotate-deposit-seed again, else see deploy/README.md " +
                "section 12",
        );
        await expect(checkDepositKeys(db.pool, null)).resolves.toBeUndefined();
    });

    it("boot check refuses deposits of a version above seed_version", async () => {
        await deposit(ORDER_B, {
            address: "Fvkkb7d7zpJZcyUsygPojncsHASt2VtQB6hLRTHKp4aB",
            tokenAccount: "other-token-account",
            keyVersion: 2,
            state: "done",
        });
        const err = await checkDepositKeys(db.pool, keys7()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BootCheckError);
        expect((err as Error).message).toBe(
            "1 deposits use seed version 2, above [deposits] seed_version 1; " +
                "no script sets it back, see deploy/README.md section 12",
        );
        const two = new DepositKeys(new Map([[2, SEED_7]]), 2);
        await expect(checkDepositKeys(db.pool, two)).resolves.toBeUndefined();
        const wrong = new DepositKeys(new Map([[2, SEED_8]]), 2);
        await expect(checkDepositKeys(db.pool, wrong)).rejects.toThrow(/newest deposit/);
    });

    it("a version without its seed is refused while another version is loaded", async () => {
        await deposit(ORDER_A, { address: ADDRESS_A, tokenAccount: TOKEN_A, keyVersion: 1 });
        const onlyTwo = new DepositKeys(new Map([[2, SEED_8]]), 2);
        await expect(checkDepositKeys(db.pool, onlyTwo)).rejects.toThrow(
            /for version 1 is missing while 1 deposits use it/,
        );
        await expect(checkDepositKeys(db.pool, onlyTwo.withSeed(1, SEED_7))).resolves.toBe(
            undefined,
        );
    });
});
