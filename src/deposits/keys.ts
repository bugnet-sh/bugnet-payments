/**
 * Per-order deposit keys (spec 4.2 to 4.4).
 *
 * A deposit's key is HMAC-SHA256 of the seed of its key_version over the domain, the order id and
 * the deposit's own random salt, so the seed alone gives no key. Signers are made non-extractable
 * when a move is signed and are never stored. checkDepositKeys runs at boot and refuses to start
 * while a deposit that is not done has no seed for its version, or its stored address no longer
 * derives from that seed.
 */
import { createHmac } from "node:crypto";
import {
    type Address,
    createKeyPairSignerFromPrivateKeyBytes,
    type KeyPairSigner,
} from "@solana/kit";
import { BootCheckError } from "../boot.ts";
import type { Secrets } from "../config.ts";
import type { Queryable } from "../db/pool.ts";
import { usdcAta } from "../solana/accounts.ts";

export const DEPOSIT_DOMAIN = "bugnet/deposit/v1/";

export function depositSeed32(seed: Buffer, orderId: string, salt: Buffer): Uint8Array {
    const data = DEPOSIT_DOMAIN + orderId + "/" + salt.toString("hex");
    return new Uint8Array(createHmac("sha256", seed).update(data, "utf8").digest());
}

export async function depositSigner(
    seed: Buffer,
    orderId: string,
    salt: Buffer,
): Promise<KeyPairSigner> {
    const bytes = depositSeed32(seed, orderId, salt);
    try {
        return await createKeyPairSignerFromPrivateKeyBytes(bytes);
    } finally {
        // The key lives on only inside the non-extractable CryptoKey
        bytes.fill(0);
    }
}

export interface DepositAddress {
    address: Address;
    tokenAccount: Address;
    keyVersion: number;
}

export class DepositKeyMissing extends Error {
    readonly keyVersion: number;
    constructor(keyVersion: number) {
        super(`deposit seed for version ${keyVersion} is not loaded`);
        this.name = "DepositKeyMissing";
        this.keyVersion = keyVersion;
    }
}

export class DepositKeys {
    readonly current: number;
    readonly #seeds: ReadonlyMap<number, Buffer>;

    constructor(seeds: ReadonlyMap<number, Buffer>, current: number) {
        this.#seeds = new Map(seeds);
        this.current = current;
    }

    async address(orderId: string, salt: Buffer): Promise<DepositAddress> {
        const signer = await this.signer(orderId, salt, this.current);
        return {
            address: signer.address,
            tokenAccount: await usdcAta(signer.address),
            keyVersion: this.current,
        };
    }

    signer(orderId: string, salt: Buffer, keyVersion: number): Promise<KeyPairSigner> {
        const seed = this.#seeds.get(keyVersion);
        if (seed === undefined) return Promise.reject(new DepositKeyMissing(keyVersion));
        return depositSigner(seed, orderId, salt);
    }

    has(keyVersion: number): boolean {
        return this.#seeds.has(keyVersion);
    }

    withSeed(keyVersion: number, seed: Buffer): DepositKeys {
        return new DepositKeys(new Map([...this.#seeds, [keyVersion, seed]]), this.current);
    }
}

export function depositKeysFrom(
    secrets: Pick<Secrets, "depositSeed" | "depositSeedPrevious">,
    seedVersion: number,
): DepositKeys | null {
    if (secrets.depositSeed === null) return null;
    const seeds = new Map([[seedVersion, secrets.depositSeed]]);
    // Version 0 is never stored, so a previous seed beside version 1 signs nothing
    if (secrets.depositSeedPrevious !== null && seedVersion > 1) {
        seeds.set(seedVersion - 1, secrets.depositSeedPrevious);
    }
    return new DepositKeys(seeds, seedVersion);
}

export async function checkDepositKeys(pool: Queryable, keys: DepositKeys | null): Promise<void> {
    const { rows } = await pool.query<{
        order_id: string;
        address: string;
        key_version: number;
        salt: Buffer;
    }>(
        `select order_id, address, key_version, salt from deposits
         where state <> 'done' order by key_version, order_id`,
    );
    const unloaded = rows.filter((r) => keys?.has(r.key_version) !== true);
    const version = unloaded[0]?.key_version;
    if (version !== undefined) {
        const count = unloaded.filter((r) => r.key_version === version).length;
        throw new BootCheckError(
            `BUGNET_DEPOSIT_SEED for version ${version} is missing while ${count} deposits use ` +
                "it; restore it or set BUGNET_DEPOSIT_SEED_PREVIOUS",
        );
    }
    if (keys === null) return;
    for (const r of rows) {
        const signer = await keys.signer(r.order_id, r.salt, r.key_version);
        if (signer.address !== r.address) {
            throw new BootCheckError(
                `BUGNET_DEPOSIT_SEED does not derive the stored deposit address of ${r.order_id}; ` +
                    "restore the seed that created it",
            );
        }
    }
    await checkSeedVersion(pool, keys);
}

/**
 * A seed loaded under the wrong number passes the checks above once every deposit of that number
 * is done, and new deposits would then reuse the number for another seed, so a retired seed could
 * no longer return their late money (spec 4.3). Done deposits count here: the newest deposit of
 * each loaded version must derive, and no deposit may name a version above seed_version.
 */
async function checkSeedVersion(pool: Queryable, keys: DepositKeys): Promise<void> {
    const above = await pool.query<{ key_version: number; n: number }>(
        `select key_version, count(*)::int as n from deposits where key_version > $1
         group by key_version order by key_version limit 1`,
        [keys.current],
    );
    const high = above.rows[0];
    if (high !== undefined) {
        throw new BootCheckError(
            `${high.n} deposits use seed version ${high.key_version}, above [deposits] ` +
                `seed_version ${keys.current}; restore seed_version`,
        );
    }
    for (const version of [keys.current, keys.current - 1]) {
        if (!keys.has(version)) continue;
        const { rows } = await pool.query<{ order_id: string; address: string; salt: Buffer }>(
            `select order_id, address, salt from deposits where key_version = $1
             order by created_at desc, order_id desc limit 1`,
            [version],
        );
        const newest = rows[0];
        if (newest === undefined) continue;
        const signer = await keys.signer(newest.order_id, newest.salt, version);
        if (signer.address !== newest.address) {
            throw new BootCheckError(
                `BUGNET_DEPOSIT_SEED loaded as version ${version} does not derive ` +
                    `${newest.order_id}, the newest deposit of that version; check [deposits] ` +
                    "seed_version",
            );
        }
    }
}
