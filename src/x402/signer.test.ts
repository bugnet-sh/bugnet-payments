import { createHash } from "node:crypto";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
    address,
    getBase64Encoder,
    getTransactionDecoder,
    verifySignature,
    type Address,
    type KeyPairSigner,
    type SignatureBytes,
} from "@solana/kit";
import { stringify } from "smol-toml";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { parseSettings, type Settings } from "../config.ts";
import {
    ReportOutcomeRequestSchema,
    ReserveAndSignRequestSchema,
    SellerHint,
    type ReserveAndSignRequest,
} from "../gen/bugnet/payments/v1/x402_pb.ts";
import { memoryLog } from "../log.ts";
import { createRouterClient, type RouterClient } from "../router/client.ts";
import { usdcAta } from "../solana/accounts.ts";
import { SOLANA_MAINNET, USDC_MINT } from "../solana/constants.ts";
import { testDb, type TestDb } from "../testing/db.ts";
import { startFakeRouter, type FakeRouter } from "../testing/fake-router.ts";
import { createFakeRpc, neverAnswers, TEST_BLOCKHASH, TEST_LVBH } from "../testing/fake-rpc.ts";
import { testSigner } from "../testing/keys.ts";
import { seedAccount, seedService, seedX402Payment, TEST_PAYTO } from "../testing/x402.ts";
import { buildSellerPayment, signSellerPayment } from "./build.ts";
import { blockPayTo, setControls } from "./controls.ts";
import { bugnetAddresses, newX402PaymentId, serviceIdFor } from "./ids.ts";
import { findAccount } from "./ledger.ts";
import { releaseReserved, toX402Payment, X402_PAYMENT_COLUMNS } from "./reserve.ts";
import { reportOutcome, reserveAndSign, type SignerDeps } from "./signer.ts";
import type { AccountRow, BugnetAddresses, X402PaymentRow } from "./types.ts";

let db: TestDb;
let fake: FakeRouter;
let router: RouterClient;
let lookup: (req: { key: { case?: string; value?: unknown } }) => Promise<unknown>;
let x402: Settings["x402"];
let allowance: KeyPairSigner;
let sellerFeePayer: Address;
let otherPayTo: Address;
let addresses: BugnetAddresses;
let log: ReturnType<typeof memoryLog>;
let account: AccountRow;
let blockhashCalls: unknown[];
let wakeFastPass: Mock<() => void>;
let HOT: Address;

const T0 = new Date("2030-01-01T12:00:00Z");
const PLACEMENT = "8f9c0a52-0000-4000-8000-000000000001";
const OTHER_PLACEMENT = "8f9c0a52-0000-4000-8000-000000000009";
const DEADLINE = new Date("2030-01-01T13:00:00Z");
const HOST = "s.example";
const PATH = "/v1/chat";
const SERVICE = serviceIdFor("POST", HOST, "/v1/");
const RESOURCE = '{"url":"https://s.example/v1/chat","b":1,  "a":"é"}';
const SIG =
    "1GEoSr1zQmSdVRBytTGqwokiyaVTd1mNJ2jkEGmhDSmTwX9CbcVZrrYJZc42r5Wyu9rAJGFSDAPJWAaui4Y5Ku";

// module-level lets: db, fake, router, lookup, x402, allowance (testSigner(7)), sellerFeePayer
// (testSigner(9)), otherPayTo (testSigner(8)), addresses, log, account, blockhashCalls,
// wakeFastPass, HOT (usdcAta of the allowance wallet), each set below

beforeAll(async () => {
    db = await testDb();
    allowance = await testSigner(7);
    HOT = await usdcAta(allowance.address);
    sellerFeePayer = (await testSigner(9)).address;
    otherPayTo = (await testSigner(8)).address;
    const recipient = (await testSigner(1)).address;
    x402 = parseSettings(stringify({ solana: { recipient } }), "t").x402;
    addresses = bugnetAddresses({
        feePayer: (await testSigner(4)).address,
        allowanceWallet: allowance.address,
        refundWallet: (await testSigner(5)).address,
        recipient,
    });
    fake = await startFakeRouter({ lookupPlacement: (req) => lookup(req as never) as never });
    router = createRouterClient({
        url: fake.url,
        token: "router-token",
        timeoutMs: 3_000,
        checkPayer: false,
        getOrder: false,
        log: memoryLog(),
    });
});
afterAll(async () => {
    await fake.close();
    await db.close();
});
beforeEach(async () => {
    await db.pool.query(
        "truncate orders, x402_blocked_payto, x402_payto_days, x402_unlisted_days, x402_outflow_days cascade",
    );
    await db.pool.query("update x402_controls set paused = false, disabled = false");
    await db.pool.query("update x402_tail set finalized_height = 0");
    log = memoryLog();
    blockhashCalls = [];
    wakeFastPass = vi.fn<() => void>();
    lookup = async () => found(PLACEMENT);
    account = await seedAccount(db.pool, {
        fundedMicros: 1_000_000,
        spendPerMinuteMicros: 500_000,
        placementId: PLACEMENT,
    });
    await seedService(db.pool, {
        accountId: account.id,
        serviceId: SERVICE,
        method: "POST",
        host: HOST,
        prefix: "/v1/",
        url: "https://s.example/v1/chat",
        maxPriceMicros: 10_000,
        payTo: TEST_PAYTO,
        listed: "indexed",
        paidPath: null,
        state: "enabled",
    });
});

function found(placementId: string) {
    return {
        placementId,
        startOrderId: account.id,
        state: "ready",
        deadline: timestampFromDate(DEADLINE),
        x402Capable: true,
        packageId: "cpu-small",
    };
}
function later(ms: number): Date {
    return new Date(T0.getTime() + ms);
}
function deps(over: Partial<SignerDeps> = {}, x: Partial<Settings["x402"]> = {}): SignerDeps {
    return {
        pool: db.pool,
        rpc: createFakeRpc({
            getLatestBlockhash: (cfg: unknown) => {
                blockhashCalls.push(cfg);
                return {
                    context: { slot: 4242n },
                    value: { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: TEST_LVBH },
                };
            },
        }),
        allowance,
        hotTokenAccount: HOT,
        x402: { ...x402, enabled: true, allowance_wallet: allowance.address, ...x },
        addresses,
        router,
        log,
        now: () => T0,
        wakeFastPass,
        ...over,
    };
}
function entryJson(o: { amount?: string; payTo?: string; extra?: string } = {}): string {
    const extra = o.extra ?? `{"feePayer":"${sellerFeePayer}"}`;
    return `{"scheme":"exact" ,"network":"${SOLANA_MAINNET}","asset":"${USDC_MINT}","amount":"${o.amount ?? "10000"}","payTo":"${o.payTo ?? TEST_PAYTO}","maxTimeoutSeconds":60,"extra":${extra}}`;
}
function challenge(o: { accepts?: string[]; extensions?: string; version?: number } = {}): string {
    const ext = o.extensions === undefined ? "" : `,"extensions":${o.extensions}`;
    const accepts = (o.accepts ?? [entryJson()]).join(",");
    const text = `{"x402Version":${o.version ?? 2},"resource":${RESOURCE},"accepts":[${accepts}]${ext}}`;
    return Buffer.from(text, "utf8").toString("base64");
}
function offered(required: boolean, schema: string): string {
    return `{"payment-identifier":{"info":{"required":${required}},"schema":${schema}}}`;
}
function request(over: Partial<ReserveAndSignRequest> = {}): ReserveAndSignRequest {
    return create(ReserveAndSignRequestSchema, {
        accountId: account.id,
        placementId: PLACEMENT,
        ref: newX402PaymentId().slice(3, 19),
        serviceId: SERVICE,
        method: "POST",
        host: HOST,
        path: PATH,
        bodySha256: new Uint8Array(32).fill(2),
        targetSha256: new Uint8Array(32).fill(1),
        paymentRequired: challenge(),
        ...over,
    });
}
type Answer = Awaited<ReturnType<typeof reserveAndSign>>;
function signedOf(res: Answer) {
    if (res.result?.case !== "signed") throw new Error(`expected signed, got ${res.result?.case}`);
    return res.result.value;
}
function refusedOf(res: Answer) {
    if (res.result?.case !== "refused")
        throw new Error(`expected refused, got ${res.result?.case}`);
    return res.result.value;
}
function headerOf(value: string) {
    const text = Buffer.from(value, "base64").toString("utf8");
    return { text, json: JSON.parse(text) };
}
async function rowByRef(ref: string): Promise<X402PaymentRow> {
    const { rows } = await db.pool.query(
        `select ${X402_PAYMENT_COLUMNS} from x402_payments where ref = $1`,
        [ref],
    );
    return toX402Payment(rows[0]);
}
async function count(): Promise<number> {
    return Number((await db.pool.query("select count(*) from x402_payments")).rows[0].count);
}
async function money() {
    const a = (await findAccount(db.pool, account.id))!;
    return { held: a.heldMicros, spent: a.spentMicros };
}
async function serviceState() {
    const { rows } = await db.pool.query(
        "select failures, state from x402_services where account_id = $1 and service_id = $2",
        [account.id, SERVICE],
    );
    return { failures: rows[0].failures, state: rows[0].state };
}
function alarms(name: string) {
    return log.lines.filter((l) => l.alarm === name);
}
function sha256(b: Uint8Array): Buffer {
    return createHash("sha256").update(b).digest();
}
async function rebuilt(row: X402PaymentRow) {
    const tx = buildSellerPayment({
        feePayer: address(row.feePayer),
        hotTokenAccount: HOT,
        destination: address(row.payToTokenAccount),
        authority: allowance.address,
        amount: BigInt(row.amountMicros),
        memo: row.memo!,
        computeUnitLimit: row.computeUnitLimit!,
        computeUnitPriceMicroLamports: row.computeUnitPriceMicroLamports!,
        blockhash: row.blockhash!,
        lastValidBlockHeight: row.lastValidBlockHeight!,
    });
    return signSellerPayment(tx, allowance);
}
function errorInfoOf(err: ConnectError): { reason: string; domain: string } {
    const d = err.details[0] as { type: string; value: Uint8Array };
    expect(d.type).toBe("google.rpc.ErrorInfo");
    const r = new BinaryReader(d.value);
    const out = { reason: "", domain: "" };
    while (r.pos < r.len) {
        const [field] = r.tag();
        const s = r.string();
        if (field === 1) out.reason = s;
        if (field === 2) out.domain = s;
    }
    return out;
}

describe("ReserveAndSign", () => {
    it("paused or killed returns no payload, old or new", async () => {
        const req = request();
        signedOf(await reserveAndSign(deps(), req));
        await setControls(db.pool, { paused: true }, "test", T0);
        expect(refusedOf(await reserveAndSign(deps(), req)).reason).toBe("outflow_paused");
        expect(refusedOf(await reserveAndSign(deps(), request())).reason).toBe("outflow_paused");
        await setControls(db.pool, { paused: false, disabled: true }, "test", T0);
        expect(refusedOf(await reserveAndSign(deps(), request())).reason).toBe("x402_disabled");
        await setControls(db.pool, { disabled: false }, null, T0);
        const off = deps({}, { enabled: false });
        expect(refusedOf(await reserveAndSign(off, request())).reason).toBe("x402_disabled");
    });

    it("own blockhash even when the seller hints one", async () => {
        const hinted = `{"feePayer":"${sellerFeePayer}","recentBlockhash":"${"9".repeat(43)}","lastValidBlockHeight":"123"}`;
        const req = request({
            paymentRequired: challenge({ accepts: [entryJson({ extra: hinted })] }),
        });
        signedOf(await reserveAndSign(deps(), req));
        const row = await rowByRef(req.ref);
        expect(row).toMatchObject({
            state: "signed",
            blockhash: TEST_BLOCKHASH,
            lastValidBlockHeight: TEST_LVBH,
            signingSlot: 4242n,
            computeUnitLimit: 20_000,
            computeUnitPriceMicroLamports: 1n,
            keepUntil: later(45_000),
            signedAt: T0,
        });
        expect(row.memo!.toString("utf8")).toMatch(/^[0-9a-f]{32}$/);
        expect(blockhashCalls).toEqual([{ commitment: "confirmed" }]);
    });

    it("accepted and resource echoed byte for byte", async () => {
        const accepted = entryJson();
        const req = request({ paymentRequired: challenge({ accepts: [accepted] }) });
        const s = signedOf(await reserveAndSign(deps(), req));
        const { text, json } = headerOf(s.paymentSignature!);
        expect(text).toContain(`"resource":${RESOURCE}`);
        expect(text).toContain(`"accepted":${accepted}`);
        expect(json.x402Version).toBe(2);
        const tx = getTransactionDecoder().decode(
            getBase64Encoder().encode(json.payload.transaction),
        );
        const ours = tx.signatures[allowance.address] as SignatureBytes;
        expect(await verifySignature(allowance.keyPair.publicKey, ours, tx.messageBytes)).toBe(
            true,
        );
        expect(s).toMatchObject({
            amountMicros: 10_000n,
            payTo: TEST_PAYTO,
            allowanceLeftMicros: 990_000n,
            resend: false,
            paymentRef: req.ref,
        });
        expect(s.paymentId).toMatch(/^xp_[a-z2-7]{26}$/);
        expect(timestampDate(s.keepUntil as never)).toEqual(later(45_000));
    });

    it("the signature hash is stored before the answer", async () => {
        const req = request();
        const killed = deps({
            hooks: {
                afterCommit: async () => {
                    throw new Error("killed");
                },
            },
        });
        await expect(reserveAndSign(killed, req)).rejects.toThrow("killed");
        const row = await rowByRef(req.ref);
        expect(row.state).toBe("signed");
        const again = await rebuilt(row);
        expect(row.ourSignatureSha256).toEqual(sha256(again.signature));
        expect(row.messageHash).toBe(again.messageHash);
    });

    it("a signing that finishes after the release finds the row released and returns nothing", async () => {
        const req = request();
        const late = deps({
            hooks: { beforeSign: async (id) => void (await releaseReserved(db.pool, id, T0)) },
        });
        expect(refusedOf(await reserveAndSign(late, req)).reason).toBe("payments_unavailable");
        expect((await rowByRef(req.ref)).state).toBe("released");
    });

    it("a pause while signing releases the row and answers outflow_paused", async () => {
        const req = request();
        const pausing = deps({
            hooks: { beforeSign: async () => setControls(db.pool, { paused: true }, "test", T0) },
        });
        expect(refusedOf(await reserveAndSign(pausing, req)).reason).toBe("outflow_paused");
        expect((await rowByRef(req.ref)).state).toBe("released");
        expect((await money()).held).toBe(0);
    });

    it("a kill while signing releases the row and answers x402_disabled", async () => {
        const req = request();
        const killing = deps({
            hooks: { beforeSign: async () => setControls(db.pool, { disabled: true }, "test", T0) },
        });
        expect(refusedOf(await reserveAndSign(killing, req)).reason).toBe("x402_disabled");
        expect((await rowByRef(req.ref)).state).toBe("released");
        expect((await money()).held).toBe(0);
    });

    it("a unique violation on the signature hash retries at the next price", async () => {
        const fixed = challenge({
            accepts: [entryJson({ extra: `{"feePayer":"${sellerFeePayer}","memo":"abc"}` })],
        });
        const one = request({ paymentRequired: fixed });
        const two = request({ paymentRequired: fixed, targetSha256: new Uint8Array(32).fill(3) });
        signedOf(await reserveAndSign(deps(), one));
        await db.pool.query("update x402_payments set message_hash = $1 where ref = $2", [
            "other-hash",
            one.ref,
        ]);
        signedOf(await reserveAndSign(deps(), two));
        expect((await rowByRef(two.ref)).computeUnitPriceMicroLamports).toBe(2n);
    });

    it("a repeated ref of a released row answers ref_conflict without an alarm", async () => {
        const req = request();
        signedOf(await reserveAndSign(deps(), req));
        await db.pool.query("update x402_payments set state = 'released' where ref = $1", [
            req.ref,
        ]);
        expect(refusedOf(await reserveAndSign(deps(), req)).reason).toBe("ref_conflict");
        expect(alarms("x402_ref_conflict")).toHaveLength(0);
    });

    it("sign_timeout releases", async () => {
        const req = request();
        const slow = deps(
            { rpc: createFakeRpc({ getLatestBlockhash: neverAnswers }) },
            { sign_timeout: 200 },
        );
        expect(refusedOf(await reserveAndSign(slow, req)).reason).toBe("payments_unavailable");
        expect((await rowByRef(req.ref)).state).toBe("released");
        expect((await money()).held).toBe(0);
    });

    it("a repeated ref rebuilds the same signature", async () => {
        const req = request();
        const a = signedOf(await reserveAndSign(deps(), req));
        const b = signedOf(await reserveAndSign(deps({ now: () => later(3_000) }), req));
        expect(b.paymentSignature).toBe(a.paymentSignature);
        expect(b).toMatchObject({ paymentId: a.paymentId, paymentRef: req.ref, resend: false });
        expect(await count()).toBe(1);
        expect((await money()).held).toBe(10_000);
    });

    it("a repeated ref with a changed field answers ref_conflict and alarms", async () => {
        const req = request();
        signedOf(await reserveAndSign(deps(), req));
        const changed = request({ ref: req.ref, path: "/v1/other" });
        expect(refusedOf(await reserveAndSign(deps(), changed)).reason).toBe("ref_conflict");
        expect(alarms("x402_ref_conflict")).toHaveLength(1);
    });

    it("a repeated ref whose rebuilt signature differs answers ref_conflict and alarms", async () => {
        const req = request();
        signedOf(await reserveAndSign(deps(), req));
        await db.pool.query("update x402_payments set our_signature_sha256 = $1", [
            sha256(Buffer.from("x")),
        ]);
        expect(refusedOf(await reserveAndSign(deps(), req)).reason).toBe("ref_conflict");
        expect(alarms("x402_ref_conflict")).toHaveLength(1);
    });

    it("a repeated ref of a reserved row answers payments_unavailable", async () => {
        const req = request();
        await seedX402Payment(db.pool, {
            accountId: account.id,
            ref: req.ref,
            state: "reserved",
            serviceId: SERVICE,
            placementId: PLACEMENT,
            method: "POST",
            host: HOST,
            path: PATH,
            targetSha256: Buffer.alloc(32, 1),
            bodySha256: Buffer.alloc(32, 2),
        });
        expect(refusedOf(await reserveAndSign(deps(), req)).reason).toBe("payments_unavailable");
    });

    it("two concurrent calls with one new ref answer as a repeat, never Internal", async () => {
        await db.pool.query("update x402_accounts set placement_id = null");
        let arrived = 0;
        let bothArrived!: () => void;
        const barrier = new Promise<void>((r) => (bothArrived = r));
        lookup = async () => {
            if (++arrived === 2) bothArrived();
            await barrier;
            return found(PLACEMENT);
        };
        let signNow!: () => void;
        const signGate = new Promise<void>((r) => (signNow = r));
        const d = deps({ hooks: { beforeSign: () => signGate } });
        const req = request();
        const calls = [reserveAndSign(d, req), reserveAndSign(d, req)];
        expect(refusedOf(await Promise.race(calls)).reason).toBe("payments_unavailable");
        signNow();
        const answers = await Promise.all(calls);
        expect(answers.map((a) => a.result?.case).sort()).toEqual(["refused", "signed"]);
        expect(await count()).toBe(1);
        expect((await money()).held).toBe(10_000);
    });

    it("resend: the same transaction for an unclean row with a live blockhash", async () => {
        const first = request();
        const a = signedOf(await reserveAndSign(deps(), first));
        const b = signedOf(await reserveAndSign(deps({ now: () => later(5_000) }), request()));
        expect(b).toMatchObject({ resend: true, paymentRef: first.ref, paymentId: a.paymentId });
        expect(timestampDate(b.keepUntil as never)).toEqual(later(45_000));
        expect(headerOf(b.paymentSignature!).json.payload.transaction).toBe(
            headerOf(a.paymentSignature!).json.payload.transaction,
        );
        expect(await count()).toBe(1);
        expect((await money()).held).toBe(10_000);
    });

    it("a new payment after a clean end or after expiry", async () => {
        const a = signedOf(await reserveAndSign(deps(), request()));
        await db.pool.query("update x402_payments set ended_clean = true where id = $1", [
            a.paymentId,
        ]);
        expect(signedOf(await reserveAndSign(deps(), request())).resend).toBe(false);
        expect(await count()).toBe(2);
        await db.pool.query("update x402_tail set finalized_height = $1", [String(TEST_LVBH + 1n)]);
        expect(signedOf(await reserveAndSign(deps(), request())).resend).toBe(false);
        expect(await count()).toBe(3);
    });

    it("resend of a confirmed row carries its stored keep_until and payment_identifier", async () => {
        const first = request({
            paymentRequired: challenge({ extensions: offered(false, '{"a":1}') }),
        });
        const a = signedOf(await reserveAndSign(deps(), first));
        const id = headerOf(a.paymentSignature!).json.extensions["payment-identifier"].info.id;
        await db.pool.query("update x402_payments set state = 'confirmed' where id = $1", [
            a.paymentId,
        ]);
        const again = request({
            paymentRequired: challenge({ extensions: offered(true, '{"b":2}') }),
        });
        const b = signedOf(await reserveAndSign(deps({ now: () => later(9_000) }), again));
        expect(b.resend).toBe(true);
        expect(timestampDate(b.keepUntil as never)).toEqual(later(45_000));
        expect(headerOf(b.paymentSignature!).json.extensions).toEqual({
            "payment-identifier": { info: { required: true, id }, schema: { b: 2 } },
        });
    });

    it("payment-identifier only when offered", async () => {
        const withId = request({
            paymentRequired: challenge({ extensions: offered(false, '{"a":1}') }),
        });
        const a = headerOf(signedOf(await reserveAndSign(deps(), withId)).paymentSignature!).json;
        expect(a.extensions["payment-identifier"]).toMatchObject({
            info: { required: false },
            schema: { a: 1 },
        });
        expect(a.extensions["payment-identifier"].info.id).toMatch(/^bn_[0-9a-f]{32}$/);
        expect((await rowByRef(withId.ref)).paymentIdentifier).toBe(
            a.extensions["payment-identifier"].info.id,
        );
        const without = request({ targetSha256: new Uint8Array(32).fill(3) });
        const b = headerOf(signedOf(await reserveAndSign(deps(), without)).paymentSignature!).json;
        expect("extensions" in b).toBe(false);
        expect((await rowByRef(without.ref)).paymentIdentifier).toBeNull();
    });

    it("identical messages raise the price by one", async () => {
        const fixed = challenge({
            accepts: [entryJson({ extra: `{"feePayer":"${sellerFeePayer}","memo":"abc"}` })],
        });
        const one = request({ paymentRequired: fixed });
        const two = request({ paymentRequired: fixed, targetSha256: new Uint8Array(32).fill(3) });
        signedOf(await reserveAndSign(deps(), one));
        signedOf(await reserveAndSign(deps(), two));
        expect((await rowByRef(one.ref)).computeUnitPriceMicroLamports).toBe(1n);
        expect((await rowByRef(two.ref)).computeUnitPriceMicroLamports).toBe(2n);
    });

    it("identical messages past the price ceiling release and answer payments_unavailable", async () => {
        const cap = {
            seller_compute_unit_price_micro_lamports: 1_000,
            seller_compute_unit_price_max_micro_lamports: 1_000,
        };
        const fixed = challenge({
            accepts: [entryJson({ extra: `{"feePayer":"${sellerFeePayer}","memo":"abc"}` })],
        });
        const one = request({ paymentRequired: fixed });
        const two = request({ paymentRequired: fixed, targetSha256: new Uint8Array(32).fill(3) });
        signedOf(await reserveAndSign(deps({}, cap), one));
        expect(refusedOf(await reserveAndSign(deps({}, cap), two)).reason).toBe(
            "payments_unavailable",
        );
        expect((await rowByRef(two.ref)).state).toBe("released");
    });

    it("service checks", async () => {
        const answer = async (over: Partial<ReserveAndSignRequest>) =>
            refusedOf(await reserveAndSign(deps(), request(over))).reason;
        await db.pool.query("update x402_services set state = 'disabled'");
        expect(await answer({})).toBe("service_not_enabled");
        await db.pool.query("update x402_services set state = 'enabled'");
        expect(await answer({ method: "GET" })).toBe("service_not_enabled");
        expect(await answer({ host: "other.example" })).toBe("service_not_enabled");
        expect(await answer({ path: "/v2/chat" })).toBe("service_not_enabled");
        await db.pool.query("update x402_services set listed = 'unlisted', paid_path = '/v1/chat'");
        expect(await answer({ path: "/v1/other" })).toBe("path_not_paid");
        await db.pool.query("update x402_services set state = 'unreliable'");
        expect(await answer({})).toBe("payee_unreliable");
        expect(await count()).toBe(0);
    });

    it("a path equal to the prefix without its slash passes step 4", async () => {
        const short = await reserveAndSign(deps(), request({ path: "/v1" }));
        expect(short.result?.case === "refused" ? short.result.value.reason : "signed").not.toBe(
            "service_not_enabled",
        );
        const longer = await reserveAndSign(
            deps(),
            request({ path: "/v1x", targetSha256: new Uint8Array(32).fill(4) }),
        );
        expect(refusedOf(longer).reason).toBe("service_not_enabled");
    });

    it("a closing account still answers a resend and refuses a new reservation", async () => {
        const first = request();
        const a = signedOf(await reserveAndSign(deps(), first));
        await db.pool.query("update x402_accounts set state = 'closing', closing_at = $1", [T0]);
        const again = signedOf(await reserveAndSign(deps({ now: () => later(5_000) }), request()));
        expect(again).toMatchObject({
            resend: true,
            paymentRef: first.ref,
            paymentId: a.paymentId,
        });
        const other = request({ targetSha256: new Uint8Array(32).fill(3) });
        expect(refusedOf(await reserveAndSign(deps(), other)).reason).toBe("account_closed");
        expect(await count()).toBe(1);
    });

    it("an unset placement is looked up by start order and stored", async () => {
        await db.pool.query("update x402_accounts set placement_id = null");
        const keys: unknown[] = [];
        lookup = async (req) => {
            keys.push(req.key);
            return found(PLACEMENT);
        };
        signedOf(await reserveAndSign(deps(), request()));
        expect(keys).toEqual([{ case: "startOrderId", value: account.id }]);
        expect(await findAccount(db.pool, account.id)).toMatchObject({
            placementId: PLACEMENT,
            deadline: DEADLINE,
        });
    });

    it("a lookup past lookup_timeout answers payments_unavailable", async () => {
        await db.pool.query("update x402_accounts set placement_id = null");
        lookup = () => new Promise(() => {});
        expect(refusedOf(await reserveAndSign(deps(), request())).reason).toBe(
            "payments_unavailable",
        );
        expect(await count()).toBe(0);
    });

    it("NotFound or another placement answers service_not_enabled", async () => {
        expect(
            refusedOf(await reserveAndSign(deps(), request({ placementId: OTHER_PLACEMENT })))
                .reason,
        ).toBe("service_not_enabled");
        await db.pool.query("update x402_accounts set placement_id = null");
        lookup = async () => {
            throw new ConnectError("ORDER_UNKNOWN", Code.NotFound);
        };
        expect(refusedOf(await reserveAndSign(deps(), request())).reason).toBe(
            "service_not_enabled",
        );
        lookup = async () => found(OTHER_PLACEMENT);
        expect(refusedOf(await reserveAndSign(deps(), request())).reason).toBe(
            "service_not_enabled",
        );
    });

    it("an unknown account answers service_not_enabled", async () => {
        const res = await reserveAndSign(deps(), request({ accountId: "ord_" + "z".repeat(26) }));
        expect(refusedOf(res)).toMatchObject({
            reason: "service_not_enabled",
            allowanceLeftMicros: 0n,
        });
    });

    it("seller fields pass through", async () => {
        const answer = async (accepts: string[]) =>
            refusedOf(
                await reserveAndSign(deps(), request({ paymentRequired: challenge({ accepts }) })),
            );
        const splits = entryJson({ extra: `{"feePayer":"${sellerFeePayer}","splits":[{}]}` });
        expect((await answer([splits])).reason).toBe("splits_unsupported");
        expect(await answer([entryJson({ amount: "600000" })])).toMatchObject({
            reason: "price_above_max",
            askedMicros: 600_000n,
            maxMicros: 10_000n,
            allowanceLeftMicros: 1_000_000n,
        });
        expect((await answer([entryJson({ payTo: otherPayTo })])).reason).toBe("payee_changed");
        await blockPayTo(db.pool, TEST_PAYTO, "test");
        expect((await answer([entryJson()])).reason).toBe("payto_blocked");
    });

    it("not_x402 and version_unsupported from the header", async () => {
        const answer = async (paymentRequired: string) =>
            refusedOf(await reserveAndSign(deps(), request({ paymentRequired }))).reason;
        expect(await answer("%%%")).toBe("not_x402");
        expect(await answer(challenge({ version: 1 }))).toBe("version_unsupported");
    });

    it("a malformed request answers InvalidArgument and stores nothing", async () => {
        await expect(reserveAndSign(deps(), request({ ref: "BAD" }))).rejects.toMatchObject({
            code: Code.InvalidArgument,
        });
        await expect(
            reserveAndSign(deps(), request({ bodySha256: new Uint8Array(31) })),
        ).rejects.toMatchObject({ code: Code.InvalidArgument });
        expect(await count()).toBe(0);
    });
});

describe("ReportOutcome", () => {
    async function paid(n: number): Promise<{ paymentId: string; ref: string }> {
        const s = signedOf(
            await reserveAndSign(deps(), request({ targetSha256: new Uint8Array(32).fill(n) })),
        );
        return { paymentId: s.paymentId!, ref: s.paymentRef! };
    }
    function report(
        p: { paymentId: string; ref: string },
        over: MessageInitShape<typeof ReportOutcomeRequestSchema> = {},
    ) {
        return create(ReportOutcomeRequestSchema, {
            paymentId: p.paymentId,
            ref: p.ref,
            httpStatus: 200,
            hint: SellerHint.SUCCESS,
            ...over,
        });
    }

    it("stores hints and ended_clean only for 2xx with success and no cut", async () => {
        const a = await paid(1);
        await reportOutcome(deps(), report(a));
        expect(await rowByRef(a.ref)).toMatchObject({
            hint: "success",
            httpStatus: 200,
            endedClean: true,
        });
        const b = await paid(2);
        await reportOutcome(deps(), report(b, { httpStatus: 500 }));
        expect((await rowByRef(b.ref)).endedClean).toBe(false);
        const c = await paid(3);
        await reportOutcome(deps(), report(c, { streamCut: true }));
        expect(await rowByRef(c.ref)).toMatchObject({ endedClean: false, streamCut: true });
    });

    it("a ref other than the row's answers FailedPrecondition REF_CONFLICT, stores nothing and alarms", async () => {
        const a = await paid(1);
        const err = await reportOutcome(deps(), report(a, { ref: "zzzzzzzzzzzzzzzz" })).catch(
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(ConnectError);
        expect((err as ConnectError).code).toBe(Code.FailedPrecondition);
        expect(errorInfoOf(err as ConnectError)).toEqual({
            reason: "REF_CONFLICT",
            domain: "bugnet.payments",
        });
        expect((await rowByRef(a.ref)).hint).toBeNull();
        expect(alarms("x402_ref_conflict")).toHaveLength(1);
    });

    it("failure, absent and rejected count; resend never counts", async () => {
        const a = await paid(1);
        await reportOutcome(
            deps(),
            report(a, { resend: true, hint: SellerHint.REJECTED, httpStatus: 402 }),
        );
        expect(await serviceState()).toEqual({ failures: 0, state: "enabled" });
        for (const hint of [SellerHint.FAILURE, SellerHint.ABSENT, SellerHint.REJECTED]) {
            await reportOutcome(deps(), report(a, { hint, httpStatus: 402 }));
        }
        expect(await serviceState()).toEqual({ failures: 3, state: "unreliable" });
        expect(alarms("x402_payee_unreliable")).toHaveLength(1);
    });

    it("a paid_no_answer report counts once", async () => {
        const a = await paid(1);
        await reportOutcome(
            deps(),
            report(a, { httpStatus: 0, hint: SellerHint.ABSENT, streamCut: true }),
        );
        expect(await serviceState()).toEqual({ failures: 1, state: "enabled" });
        expect((await rowByRef(a.ref)).endedClean).toBe(false);
    });

    it("hint_tx and hint_error are shape-checked", async () => {
        const a = await paid(1);
        await reportOutcome(
            deps(),
            report(a, { hintTx: "bad tx", hintError: "Insufficient Funds" }),
        );
        expect(await rowByRef(a.ref)).toMatchObject({ hintTx: null, hintError: null });
        await reportOutcome(deps(), report(a, { hintTx: SIG, hintError: "insufficient_funds" }));
        expect(await rowByRef(a.ref)).toMatchObject({
            hintTx: SIG,
            hintError: "insufficient_funds",
        });
    });

    it("a resend report without a hint_tx keeps the stored one", async () => {
        const a = await paid(1);
        await reportOutcome(deps(), report(a, { hintTx: SIG }));
        await reportOutcome(deps(), report(a, { resend: true, hint: SellerHint.FAILURE }));
        expect(await rowByRef(a.ref)).toMatchObject({ hintTx: SIG, hint: "failure" });
    });

    it("an unknown payment_id answers NotFound without details or an alarm", async () => {
        const a = await paid(1);
        const err = await reportOutcome(
            deps(),
            report({ ...a, paymentId: newX402PaymentId() }),
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConnectError);
        expect((err as ConnectError).code).toBe(Code.NotFound);
        expect((err as ConnectError).details).toHaveLength(0);
        expect(log.lines.filter((l) => l.alarm !== undefined)).toHaveLength(0);
    });

    it("a hint_tx wakes the fast pass", async () => {
        const a = await paid(1);
        await reportOutcome(deps(), report(a));
        expect(wakeFastPass).not.toHaveBeenCalled();
        await reportOutcome(deps(), report(a, { hintTx: SIG }));
        expect(wakeFastPass).toHaveBeenCalledTimes(1);
    });

    it("ReportOutcome never changes money", async () => {
        const a = await paid(1);
        const res = await reportOutcome(
            deps(),
            report(a, { hint: SellerHint.FAILURE, httpStatus: 500 }),
        );
        expect(res.allowanceLeftMicros).toBe(990_000n);
        expect(await money()).toEqual({ held: 10_000, spent: 0 });
    });
});

it("the payment value is never logged", async () => {
    const s = signedOf(await reserveAndSign(deps(), request()));
    await reportOutcome(
        deps(),
        create(ReportOutcomeRequestSchema, {
            paymentId: s.paymentId,
            ref: s.paymentRef,
            httpStatus: 200,
        }),
    );
    const all = JSON.stringify(log.lines);
    expect(all).not.toContain(s.paymentSignature!);
    expect(all).not.toContain(headerOf(s.paymentSignature!).json.payload.transaction);
});
