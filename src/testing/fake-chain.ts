import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
    AccountRole,
    type Address,
    address,
    appendTransactionMessageInstructions,
    blockhash,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    getAddressDecoder,
    getAddressEncoder,
    getBase58Decoder,
    getBase58Encoder,
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    type Instruction,
    type ReadonlyUint8Array,
    type KeyPairSigner,
    partiallySignTransaction,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type Transaction,
} from "@solana/kit";
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import {
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    getApproveInstruction,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getTransferCheckedInstruction,
} from "@solana-program/token";
import { isRecord } from "../is-record.ts";
import { usdcAta } from "../solana/accounts.ts";
import { MEMO_PROGRAM, TOKEN_PROGRAM, USDC_DECIMALS, USDC_MINT } from "../solana/constants.ts";
import { createRpc, type SolanaRpc } from "../solana/rpc.ts";
import { MAINNET_GENESIS, MAINNET_HISTORY_PROBE } from "../solana/router/index.ts";

export type BadAnswer = { meta: "null" } | { dropTokenEntryFor: string };

export interface FakeChain {
    url: string;
    rpc: SolanaRpc;
    slot(): bigint;
    height(): bigint;
    advance(blocks: number): void;
    finalize(upToSlot?: bigint): void;
    setTokenAccount(a: {
        address: string;
        owner: string;
        amount: bigint;
        state?: "initialized" | "frozen";
        delegate?: string | null;
        closeAuthority?: string | null;
    }): void;
    balance(tokenAccount: string): bigint;
    submitted(): { signature: string; slot: bigint; failed: boolean }[];
    cosignAndSubmit(wireBase64: string, feePayer: KeyPairSigner): Promise<string>;
    credit(tokenAccount: string, micros: bigint): string;
    debit(tokenAccount: string, micros: bigint): string;
    approve(tokenAccount: string, delegate: string): string;
    hideFromIndex(signature: string, ms: number): void;
    lagNode(slots: number, o?: { refuse?: boolean; methods?: readonly string[] }): void;
    failNext(): void;
    // The destination is created first in the same transaction when createDestinationFor names
    // its owner, paid by feePayer, as a wallet does when it sends to an account that is not there
    transfer(o: {
        authority: KeyPairSigner;
        feePayer: KeyPairSigner;
        source: string;
        destination: string;
        micros: bigint;
        memo?: string;
        lifetime?: { blockhash: string; lastValidBlockHeight: bigint };
        createDestinationFor?: string;
    }): Promise<string>;
    withholdTransaction(signature: string, times: number): void;
    // SOL balances getBalance answers, 0 for an unknown address
    lamports(address: string): bigint;
    // Adds to the balance at the current slot, never sets it; getBalance reads it at the
    // request's commitment
    fundLamports(address: string, lamports: bigint): void;
    calls(): { method: string; params: unknown[] }[];
    // Another RPC endpoint over this same chain, on its own loopback port (so its own domain)
    addEndpoint(o?: {
        lag?: number;
        refuse?: boolean;
        history?: boolean | "short" | "alternate";
        genesis?: string;
        ignoreMinContextSlot?: boolean;
    }): Promise<FakeChainEndpoint>;
    close(): Promise<void>;
    accountExists(address: string): boolean;
    // null: the node gives no block time for transactions landing from now on
    setBlockTime(seconds: number | null): void;
    withholdBlockTime(slot: bigint, times: number): void;
    createAta(o: { owner: string; payer: KeyPairSigner }): Promise<string>;
    // An exchange batch: one signer, one transaction, several credits
    transferMany(o: {
        from: KeyPairSigner;
        to: readonly { tokenAccount: string; micros: bigint }[];
    }): Promise<string>;
    // A pool vault moved by CPI, or a delegate: the vault's owner does not sign
    vaultTransfer(o: {
        vault: string;
        to: string;
        micros: bigint;
        signer: KeyPairSigner;
    }): Promise<string>;
    // History padding: names the accounts read-only and moves nothing
    noOp(o: {
        touching: string | readonly string[];
        signer: KeyPairSigner;
        fail?: boolean;
    }): Promise<string>;
    preflight(on: boolean): void;
    // A node lacking that history
    hideFromStatus(signature: string): void;
    // A pruned endpoint
    pruneHistoryBefore(slot: bigint | null): void;
    undecodable(signature: string): void;
    // One backend's wrong answer behind an endpoint that mixes backends
    badAnswer(signature: string, times: number, o: BadAnswer): void;
}

export interface FakeChainEndpoint {
    url: string;
    setLag(slots: number, o?: { refuse?: boolean }): void;
    // Answers the slot it had when frozen
    freeze(on: boolean): void;
    // false: -32011 for every history lookup; "short": null; "alternate": every second one null
    setHistory(mode: boolean | "short" | "alternate"): void;
    ignoreMinContextSlot(on: boolean): void;
    rateLimit(times: number, retryAfterSeconds?: number): void;
    failNext(status?: number): void;
    // "after": handles the request, never answers; with methods, only those calls stall
    stall(mode: "off" | "before" | "after", o?: { methods?: readonly string[] }): void;
    // A known signature sent with preflight answers -32002 AlreadyProcessed
    alreadyProcessed(on: boolean): void;
    // The next sendTransaction answers its signature and lands nothing
    dropNext(): void;
    calls(): { method: string; params: unknown[] }[];
    close(): Promise<void>;
}

// One added endpoint's own view of the shared chain
interface EndpointView {
    lag: number;
    refuse: boolean;
    frozen: { slot: bigint; finalized: bigint } | null;
    ignoreMin: boolean;
    history: boolean | "short" | "alternate";
    historyLookups: number;
    alreadyProcessed: boolean;
    dropNext: boolean;
    genesis: string;
}

const GENESIS_SLOT = 1_000n;
const HEIGHT_OFFSET = 100n;
const BLOCKHASH_LIFE = 150n;
const OUTSIDE_FUNDS = 10n ** 12n;
const TOKEN_ACCOUNT_RENT = 2_039_280n;
const MIN_CONTEXT_SLOT_NOT_REACHED = -32016;
const BLOCK_NOT_AVAILABLE = -32004;
const spkiEd25519Prefix = Buffer.from("302a300506032b6570032100", "hex");
const TOKEN_TRANSFER = 3;
const TOKEN_APPROVE = 4;
const TOKEN_CLOSE_ACCOUNT = 9;
const TOKEN_TRANSFER_CHECKED = 12;
const ATA_CREATE = 0;
const ATA_CREATE_IDEMPOTENT = 1;
const SYSTEM_TRANSFER = 2;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ATA_PROGRAM: string = ASSOCIATED_TOKEN_PROGRAM_ADDRESS;

const fakeProgram = (name: string): Address =>
    getAddressDecoder().decode(createHash("sha256").update(`fake-chain ${name} program`).digest());
// Stand-ins for programs FakeChain does not run: one moves a vault's tokens by CPI, one only
// names accounts
const VAULT_PROGRAM = fakeProgram("vault");
const NOOP_PROGRAM = fakeProgram("noop");

interface Account {
    owner: string;
    genesis: bigint;
    state: "initialized" | "frozen";
    delegate: string | null;
    closeAuthority: string | null;
    // Set by setTokenAccount: the account exists at every slot unless a landed close says otherwise
    base: boolean;
}

interface Delta {
    account: string;
    slot: bigint;
    amount: bigint;
}

interface TokenEntry {
    amount: bigint;
    owner: string;
}

interface StoredInstruction {
    program: string;
    accounts: string[];
    data: Uint8Array;
}

interface Working {
    exists: boolean;
    owner: string;
    amount: bigint;
    delegate: string | null;
    state: "initialized" | "frozen";
    closeAuthority: string | null;
}

interface Applied {
    err: unknown;
    tokens: Map<string, Working>;
    lamports: Map<string, bigint>;
    inner: { index: number; instructions: StoredInstruction[] }[];
}

interface Stored {
    signature: string;
    slot: bigint;
    seq: number;
    wire: string;
    signatures: string[];
    keys: string[];
    numSigners: number;
    header: {
        numSignerAccounts: number;
        numReadonlySignerAccounts: number;
        numReadonlyNonSignerAccounts: number;
    };
    recentBlockhash: string;
    instructions: StoredInstruction[];
    inner: Applied["inner"];
    err: unknown;
    pre: Map<number, TokenEntry>;
    post: Map<number, TokenEntry>;
    blockTime: number | null;
}

class RpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown,
    ) {
        super(message);
    }
}

const blockhashOf = (slot: bigint): string =>
    getBase58Decoder().decode(createHash("sha256").update(`fake-chain block ${slot}`).digest());

const uiAmountString = (amount: bigint): string => {
    const whole = amount / 1_000_000n;
    const frac = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return frac === "" ? `${whole}` : `${whole}.${frac}`;
};

const tokenAmount = (amount: bigint) => ({
    amount: amount.toString(),
    decimals: USDC_DECIMALS,
    uiAmount: Number(amount) / 1_000_000,
    uiAmountString: uiAmountString(amount),
});

function decodeMessage(tx: Transaction) {
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (compiled.version !== 0) throw new Error("fake chain: only v0 transactions");
    return compiled;
}

function readMessage(tx: Transaction) {
    const compiled = decodeMessage(tx);
    const keys = [...compiled.staticAccounts] as string[];
    const instructions: StoredInstruction[] = compiled.instructions.map((ix) => ({
        program: keys[ix.programAddressIndex]!,
        accounts: (ix.accountIndices ?? []).map((i) => keys[i]!),
        data: new Uint8Array(ix.data ?? []),
    }));
    return { compiled, keys, instructions };
}

const u64 = (n: bigint): Uint8Array => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
};

const u32 = (n: number): Uint8Array => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
};

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function signedBy(
    signer: string,
    message: ReadonlyUint8Array,
    signature: Uint8Array | null,
): boolean {
    if (signature === null) return false;
    try {
        const key = createPublicKey({
            key: Buffer.concat([
                spkiEd25519Prefix,
                Buffer.from(getAddressEncoder().encode(address(signer))),
            ]),
            format: "der",
            type: "spki",
        });
        return verify(null, Buffer.from(message), key, signature);
    } catch {
        return false;
    }
}

export async function startFakeChain(
    o: { autoAdvanceMs?: number; autoFinalize?: boolean } = {},
): Promise<FakeChain> {
    let slot = GENESIS_SLOT;
    let finalizedSlot = GENESIS_SLOT - 1n;
    let lag = 0;
    let lagRefuses = true;
    let lagMethods: readonly string[] | undefined;
    let failNextFlag = false;
    let preflightOn = false;
    let prunedBefore: bigint | null = null;
    let seq = 0;
    let outsideNonce = 0;
    const accounts = new Map<string, Account>();
    const life = new Map<string, { slot: bigint; exists: boolean }[]>();
    const deltas: Delta[] = [];
    const lamportGenesis = new Map<string, bigint>();
    const lamportDeltas: Delta[] = [];
    const txs: Stored[] = [];
    const bySignature = new Map<string, Stored>();
    const sentOnRpc: Stored[] = [];
    const hidden = new Map<string, number>();
    const withheld = new Map<string, number>();
    const hiddenFromStatus = new Set<string>();
    const undecodables = new Set<string>();
    const badAnswers = new Map<string, { left: number; kind: BadAnswer }>();
    const withheldTxTime = new Map<bigint, number>();
    const withheldBlockTime = new Map<bigint, number>();
    const requests: { method: string; params: unknown[] }[] = [];
    // Set while an added endpoint's request is answered; answer() runs synchronously
    let current: EndpointView | null = null;
    const endpointClosers: (() => Promise<void>)[] = [];
    // The router's history check asks for this old mainnet transaction before any payment exists
    const probeSlot = GENESIS_SLOT - 1n;
    const heights = new Map<string, bigint>([
        [blockhashOf(GENESIS_SLOT), GENESIS_SLOT - HEIGHT_OFFSET],
    ]);
    const atas = new Map<string, string>();

    let blockTimeSetting: number | null | undefined;
    let lastSetTime: number | undefined;
    const slotTimes = new Map<bigint, number>();
    const defaultTime = () => lastSetTime ?? Math.floor(Date.now() / 1000);
    function slotTime(s: bigint): number {
        let t = slotTimes.get(s);
        if (t === undefined) {
            t = defaultTime();
            slotTimes.set(s, t);
        }
        return t;
    }
    function stampBlockTime(): number | null {
        if (typeof blockTimeSetting === "number") slotTimes.set(slot, blockTimeSetting);
        const t = slotTime(slot);
        return blockTimeSetting === null ? null : t;
    }

    const heightOf = (s: bigint) => s - HEIGHT_OFFSET;
    const finalized = () => (o.autoFinalize === true ? slot : finalizedSlot);

    const balanceAt = (account: string, at: bigint): bigint =>
        deltas
            .filter((d) => d.account === account && d.slot <= at)
            .reduce((sum, d) => sum + d.amount, accounts.get(account)?.genesis ?? 0n);
    const tipBalance = (account: string) => balanceAt(account, slot);
    const lamportsAt = (account: string, at: bigint): bigint =>
        lamportDeltas
            .filter((d) => d.account === account && d.slot <= at)
            .reduce((sum, d) => sum + d.amount, lamportGenesis.get(account) ?? 0n);

    function existsAt(account: string, at: bigint): boolean {
        const acct = accounts.get(account);
        if (acct === undefined) return false;
        let exists = acct.base;
        for (const e of life.get(account) ?? []) {
            if (e.slot > at) break;
            exists = e.exists;
        }
        return exists;
    }

    function setAccount(a: {
        address: string;
        owner: string;
        amount: bigint;
        state?: "initialized" | "frozen";
        delegate?: string | null;
        closeAuthority?: string | null;
    }) {
        const moved = deltas
            .filter((d) => d.account === a.address)
            .reduce((sum, d) => sum + d.amount, 0n);
        accounts.set(a.address, {
            owner: a.owner,
            genesis: a.amount - moved,
            state: a.state ?? "initialized",
            delegate: a.delegate ?? null,
            closeAuthority: a.closeAuthority ?? null,
            base: true,
        });
        life.delete(a.address);
        const held = lamportsAt(a.address, slot);
        if (held < TOKEN_ACCOUNT_RENT) {
            lamportGenesis.set(
                a.address,
                (lamportGenesis.get(a.address) ?? 0n) + TOKEN_ACCOUNT_RENT - held,
            );
        }
    }

    const outsideKeys = generateKeyPairSync("ed25519");
    const outside = getAddressDecoder().decode(
        outsideKeys.publicKey.export({ format: "der", type: "spki" }).subarray(12),
    );
    const outsideAta = await usdcAta(outside);
    setAccount({ address: outsideAta, owner: outside, amount: OUTSIDE_FUNDS });

    // The associated token program checks the address it creates, which takes an async
    // derivation, so a send or a dry run derives its owners' addresses before answer() runs
    async function deriveAtasFor(method: string, params: unknown[]): Promise<void> {
        if (method !== "sendTransaction" && method !== "simulateTransaction") return;
        let instructions: readonly StoredInstruction[];
        try {
            const wire = params[0] as string;
            instructions = readMessage(
                getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
            ).instructions;
        } catch {
            // answer() refuses a wire it cannot read
            return;
        }
        for (const ix of instructions) {
            const owner = ix.accounts[2];
            if (ix.program !== ATA_PROGRAM || owner === undefined || atas.has(owner)) continue;
            atas.set(owner, await usdcAta(address(owner)));
        }
    }

    // Runs the instructions against the tip and returns the changes without applying them
    function apply(
        keys: string[],
        numSigners: number,
        instructions: readonly StoredInstruction[],
    ): Applied {
        const tokens = new Map<string, Working>();
        const lamports = new Map<string, bigint>();
        const inner: Applied["inner"] = [];
        const load = (addr: string | undefined): Working | undefined => {
            if (addr === undefined) return undefined;
            let w = tokens.get(addr);
            if (w === undefined) {
                const acct = accounts.get(addr);
                if (acct === undefined || !existsAt(addr, slot)) return undefined;
                w = {
                    exists: true,
                    owner: acct.owner,
                    amount: tipBalance(addr),
                    delegate: acct.delegate,
                    state: acct.state,
                    closeAuthority: acct.closeAuthority,
                };
                tokens.set(addr, w);
            }
            return w.exists ? w : undefined;
        };
        const lam = (addr: string) => lamports.get(addr) ?? lamportsAt(addr, slot);
        const signed = (addr: string | undefined) =>
            addr !== undefined && keys.indexOf(addr) >= 0 && keys.indexOf(addr) < numSigners;
        const authorised = (w: Working, who: string | undefined) =>
            signed(who) && (who === w.owner || who === w.delegate);

        const step = (ix: StoredInstruction, index: number): boolean => {
            const data = Buffer.from(ix.data);
            if (ix.program === TOKEN_PROGRAM) {
                const kind = ix.data[0];
                if (kind === TOKEN_TRANSFER || kind === TOKEN_TRANSFER_CHECKED) {
                    const checked = kind === TOKEN_TRANSFER_CHECKED;
                    const [srcKey, second, third, fourth] = ix.accounts;
                    const amount = data.readBigUInt64LE(1);
                    if (checked && (second !== USDC_MINT || ix.data[9] !== USDC_DECIMALS)) {
                        return false;
                    }
                    const src = load(srcKey);
                    const dst = load(checked ? third : second);
                    if (
                        src === undefined ||
                        dst === undefined ||
                        src.state !== "initialized" ||
                        dst.state !== "initialized" ||
                        !authorised(src, checked ? fourth : third) ||
                        src.amount < amount
                    ) {
                        return false;
                    }
                    src.amount -= amount;
                    dst.amount += amount;
                    return true;
                }
                if (kind === TOKEN_APPROVE) {
                    const [srcKey, delegate, owner] = ix.accounts;
                    const src = load(srcKey);
                    if (src === undefined || delegate === undefined) return false;
                    if (!(signed(owner) && owner === src.owner)) return false;
                    src.delegate = delegate;
                    return true;
                }
                if (kind === TOKEN_CLOSE_ACCOUNT) {
                    const [acctKey, dest, authority] = ix.accounts;
                    const w = load(acctKey);
                    if (
                        w === undefined ||
                        acctKey === undefined ||
                        dest === undefined ||
                        dest === acctKey ||
                        w.state !== "initialized" ||
                        !(signed(authority) && authority === (w.closeAuthority ?? w.owner)) ||
                        w.amount !== 0n
                    ) {
                        return false;
                    }
                    const rent = lam(acctKey);
                    lamports.set(acctKey, 0n);
                    lamports.set(dest, lam(dest) + rent);
                    w.exists = false;
                    return true;
                }
                return false;
            }
            if (ix.program === ATA_PROGRAM) {
                const kind = ix.data.length === 0 ? ATA_CREATE : ix.data[0];
                const [payerKey, ataKey, ownerKey, mintKey, , tokenProgram] = ix.accounts;
                if (
                    (kind !== ATA_CREATE && kind !== ATA_CREATE_IDEMPOTENT) ||
                    !signed(payerKey) ||
                    ataKey === undefined ||
                    ownerKey === undefined ||
                    mintKey !== USDC_MINT ||
                    tokenProgram !== TOKEN_PROGRAM ||
                    atas.get(ownerKey) !== ataKey
                ) {
                    return false;
                }
                const existing = load(ataKey);
                if (existing !== undefined) {
                    return kind === ATA_CREATE_IDEMPOTENT && existing.owner === ownerKey;
                }
                tokens.set(ataKey, {
                    exists: true,
                    owner: ownerKey,
                    amount: 0n,
                    delegate: null,
                    state: "initialized",
                    closeAuthority: null,
                });
                if (lam(ataKey) < TOKEN_ACCOUNT_RENT) lamports.set(ataKey, TOKEN_ACCOUNT_RENT);
                return true;
            }
            if (ix.program === SYSTEM_PROGRAM) {
                const [from, to] = ix.accounts;
                if (ix.data.length < 12 || data.readUInt32LE(0) !== SYSTEM_TRANSFER) return false;
                const amount = data.readBigUInt64LE(4);
                if (from === undefined || to === undefined || !signed(from)) return false;
                if (load(from) !== undefined || lam(from) < amount) return false;
                lamports.set(from, lam(from) - amount);
                lamports.set(to, lam(to) + amount);
                return true;
            }
            if (ix.program === VAULT_PROGRAM) {
                const [vault, mint, to, vaultOwner] = ix.accounts;
                const amount = data.readBigUInt64LE(0);
                const src = load(vault);
                const dst = load(to);
                if (
                    src === undefined ||
                    dst === undefined ||
                    mint !== USDC_MINT ||
                    src.state !== "initialized" ||
                    dst.state !== "initialized" ||
                    src.amount < amount
                ) {
                    return false;
                }
                src.amount -= amount;
                dst.amount += amount;
                inner.push({
                    index,
                    instructions: [
                        {
                            program: TOKEN_PROGRAM,
                            accounts: [vault!, mint, to!, vaultOwner!],
                            data: new Uint8Array([
                                TOKEN_TRANSFER_CHECKED,
                                ...u64(amount),
                                USDC_DECIMALS,
                            ]),
                        },
                    ],
                });
                return true;
            }
            if (ix.program === NOOP_PROGRAM) return ix.data[0] !== 1;
            return true;
        };

        for (const [index, ix] of instructions.entries()) {
            if (!step(ix, index)) {
                return {
                    err: { InstructionError: [index, { Custom: 1 }] },
                    tokens,
                    lamports,
                    inner,
                };
            }
        }
        return { err: null, tokens, lamports, inner };
    }

    function commit(result: Applied) {
        for (const [addr, w] of result.tokens) {
            const existed = existsAt(addr, slot);
            if (w.exists && !existed) {
                const prior = accounts.get(addr);
                accounts.set(addr, {
                    owner: w.owner,
                    // A closed account held 0, so its old genesis keeps the new one at 0
                    genesis: prior?.genesis ?? 0n,
                    state: "initialized",
                    delegate: null,
                    closeAuthority: null,
                    base: prior?.base ?? false,
                });
            }
            if (w.exists !== existed) {
                const events = life.get(addr) ?? [];
                events.push({ slot, exists: w.exists });
                life.set(addr, events);
            }
            const diff = w.amount - tipBalance(addr);
            if (diff !== 0n) deltas.push({ account: addr, slot, amount: diff });
            if (w.exists) accounts.get(addr)!.delegate = w.delegate;
        }
        for (const [addr, value] of result.lamports) {
            const diff = value - lamportsAt(addr, slot);
            if (diff !== 0n) lamportDeltas.push({ account: addr, slot, amount: diff });
        }
    }

    function land(tx: Transaction, wire: string, viaRpc: boolean): string {
        const { compiled, keys, instructions } = readMessage(tx);
        const first = Object.values(tx.signatures)[0];
        const sig = getBase58Decoder().decode(first ?? new Uint8Array(64));
        const existing = bySignature.get(sig);
        if (existing !== undefined) return sig;

        const tokenAt = instructions.findIndex((ix) => ix.program === TOKEN_PROGRAM);
        const result: Applied = failNextFlag
            ? {
                  err: { InstructionError: [Math.max(tokenAt, 0), { Custom: 1 }] },
                  tokens: new Map(),
                  lamports: new Map(),
                  inner: [],
              }
            : apply(keys, compiled.header.numSignerAccounts, instructions);
        failNextFlag = false;
        const ok = result.err === null;

        // A failed transaction changes nothing, so its post balances are its pre balances
        const pre = new Map<number, TokenEntry>();
        const post = new Map<number, TokenEntry>();
        keys.forEach((k, i) => {
            const acct = accounts.get(k);
            if (acct !== undefined && existsAt(k, slot)) {
                pre.set(i, { amount: tipBalance(k), owner: acct.owner });
            }
            const w = ok ? result.tokens.get(k) : undefined;
            if (w === undefined) {
                const before = pre.get(i);
                if (before !== undefined) post.set(i, before);
            } else if (w.exists) {
                post.set(i, { amount: w.amount, owner: w.owner });
            }
        });
        if (ok) commit(result);

        const stored: Stored = {
            signature: sig,
            slot,
            seq: seq++,
            wire,
            signatures: Object.values(tx.signatures).map((s) =>
                getBase58Decoder().decode(s ?? new Uint8Array(64)),
            ),
            keys,
            numSigners: compiled.header.numSignerAccounts,
            header: compiled.header,
            recentBlockhash: compiled.lifetimeToken,
            instructions,
            inner: ok ? result.inner : [],
            err: result.err,
            pre,
            post,
            blockTime: stampBlockTime(),
        };
        txs.push(stored);
        bySignature.set(sig, stored);
        if (viaRpc) sentOnRpc.push(stored);
        return sig;
    }

    // A lagging endpoint has not seen a blockhash newer than its own slot, so its simulation and
    // its send's preflight miss it, as a lagging Agave node does
    function unseenBlockhash(known: bigint): boolean {
        if (current === null) return false;
        return known + HEIGHT_OFFSET > (current.frozen?.slot ?? slot) - BigInt(current.lag);
    }

    // A dry run of apply() on the current state: nothing lands. simulateTransaction answers
    // with it, and a send under preflight is refused with its error
    function dryRun(message: ReturnType<typeof readMessage>): Record<string, unknown> {
        const result = { logs: [], accounts: null, unitsConsumed: 0, returnData: null };
        const { compiled, keys, instructions } = message;
        const known = heights.get(compiled.lifetimeToken);
        if (
            known === undefined ||
            heightOf(slot) > known + BLOCKHASH_LIFE ||
            unseenBlockhash(known)
        ) {
            return { err: "BlockhashNotFound", ...result };
        }
        const { err } = apply(keys, compiled.header.numSignerAccounts, instructions);
        return { err, ...result, unitsConsumed: 1_000 };
    }

    function sendTransaction(wire: string, config: Record<string, unknown>): string {
        const preflight = config.skipPreflight !== true;
        let tx: Transaction;
        let message: ReturnType<typeof readMessage>;
        try {
            tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
            message = readMessage(tx);
        } catch {
            throw new RpcError(-32602, "Invalid param: failed to deserialize transaction");
        }
        const { compiled } = message;
        const known = heights.get(compiled.lifetimeToken);
        if (
            known === undefined ||
            heightOf(slot) > known + BLOCKHASH_LIFE ||
            (preflight && unseenBlockhash(known))
        ) {
            throw new RpcError(-32002, "Transaction simulation failed: Blockhash not found", {
                err: "BlockhashNotFound",
                logs: [],
                accounts: null,
                unitsConsumed: 0,
                returnData: null,
            });
        }
        const signers = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
        for (const signer of signers) {
            const s = tx.signatures[signer as Address] ?? null;
            if (!signedBy(signer, tx.messageBytes, s)) {
                throw new RpcError(-32003, "Transaction signature verification failure");
            }
        }
        const first = Object.values(tx.signatures)[0];
        const sig = getBase58Decoder().decode(first ?? new Uint8Array(64));
        if (preflightOn && preflight && !bySignature.has(sig)) {
            const simulated = dryRun(message);
            if (simulated.err !== null) {
                const [index] = (simulated.err as { InstructionError: [number, unknown] })
                    .InstructionError;
                const failed = `Error processing Instruction ${index}: custom program error: 0x1`;
                throw new RpcError(-32002, `Transaction simulation failed: ${failed}`, simulated);
            }
        }
        return land(tx, wire, true);
    }

    function internalTransaction(feeInstruction: Instruction, ix: Instruction) {
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayer(outside, m),
            (m) =>
                setTransactionMessageLifetimeUsingBlockhash(
                    {
                        blockhash: blockhash(blockhashOf(slot)),
                        lastValidBlockHeight: heightOf(slot) + BLOCKHASH_LIFE,
                    },
                    m,
                ),
            (m) => appendTransactionMessageInstructions([feeInstruction, ix], m),
        );
        const compiled = compileTransaction(message);
        const signatures: Record<string, Uint8Array> = {};
        for (const signer of Object.keys(compiled.signatures)) {
            signatures[signer] =
                signer === outside
                    ? new Uint8Array(
                          sign(null, Buffer.from(compiled.messageBytes), outsideKeys.privateKey),
                      )
                    : crypto.getRandomValues(new Uint8Array(64));
        }
        const tx = { ...compiled, signatures } as unknown as Transaction;
        return land(tx, getBase64EncodedWireTransaction(tx), false);
    }

    // A distinct price per transaction keeps two identical outside moves from sharing a signature
    const uniqueness = (): Instruction =>
        getSetComputeUnitPriceInstruction({ microLamports: BigInt(seq + 1) });
    const outsideUniqueness = (): Instruction =>
        getSetComputeUnitPriceInstruction({ microLamports: BigInt(++outsideNonce) });

    function known(addr: string): Account {
        const acct = accounts.get(addr);
        if (acct === undefined || !existsAt(addr, slot)) {
            throw new Error(`fake chain: no token account ${addr}`);
        }
        return acct;
    }

    function transferFrom(source: string, destination: string, owner: string, micros: bigint) {
        return getTransferCheckedInstruction({
            source: address(source),
            mint: USDC_MINT,
            destination: address(destination),
            authority: createNoopSigner(address(owner)),
            amount: micros,
            decimals: USDC_DECIMALS,
        });
    }

    function lagFor(method: string): number {
        return lag > 0 && (lagMethods === undefined || lagMethods.includes(method)) ? lag : 0;
    }

    // An added endpoint answers from its own lag and frozen head; the main URL from lagNode's
    const lagged = (method: string, base: bigint): bigint => {
        const at = base - BigInt(current === null ? lagFor(method) : current.lag);
        return at < 0n ? 0n : at;
    };
    const head = (): bigint => current?.frozen?.slot ?? slot;

    function viewSlot(method: string, commitment: unknown): bigint {
        // Kit strips an explicit finalized and injects confirmed when none is given, so a request
        // that arrives with no commitment is the finalized one, as on a real node
        const fin = current?.frozen?.finalized ?? finalized();
        const base = commitment === undefined || commitment === "finalized" ? fin : head();
        return lagged(method, base);
    }

    function viewFor(method: string, config: Record<string, unknown>): bigint {
        if (method === "sendTransaction") {
            // Agave checks a send's minContextSlot against its preflight bank, which is the
            // processed head when preflight is skipped
            return config.skipPreflight === true
                ? lagged(method, head())
                : viewSlot(method, config.preflightCommitment);
        }
        if (method === "getBlockTime") return viewSlot(method, "confirmed");
        return viewSlot(method, config.commitment);
    }

    const statusOf = (s: bigint) => (s <= finalized() ? "finalized" : "confirmed");

    function tokenAccountJson(addr: string, at: bigint) {
        const acct = accounts.get(addr)!;
        const amount = balanceAt(addr, at);
        return {
            data: {
                parsed: {
                    info: {
                        isNative: false,
                        mint: USDC_MINT,
                        owner: acct.owner,
                        state: acct.state,
                        tokenAmount: tokenAmount(amount),
                        ...(acct.delegate === null
                            ? {}
                            : { delegate: acct.delegate, delegatedAmount: tokenAmount(amount) }),
                        ...(acct.closeAuthority === null
                            ? {}
                            : { closeAuthority: acct.closeAuthority }),
                    },
                    type: "account",
                },
                program: "spl-token",
                space: 165,
            },
            executable: false,
            lamports: lamportsAt(addr, at),
            owner: TOKEN_PROGRAM,
            rentEpoch: 0,
            space: 165,
        };
    }

    function accountJson(addr: string, at: bigint) {
        if (existsAt(addr, at)) return tokenAccountJson(addr, at);
        const lamports = lamportsAt(addr, at);
        if (lamports === 0n) return null;
        return {
            data: ["", "base64"],
            executable: false,
            lamports,
            owner: SYSTEM_PROGRAM,
            rentEpoch: 0,
            space: 0,
        };
    }

    function tokenBalances(t: Stored, which: Map<number, TokenEntry>, drop: string | null) {
        return [...which]
            .filter(([accountIndex]) => t.keys[accountIndex] !== drop)
            .map(([accountIndex, entry]) => ({
                accountIndex,
                mint: USDC_MINT,
                owner: entry.owner,
                programId: TOKEN_PROGRAM,
                uiTokenAmount: tokenAmount(entry.amount),
            }));
    }

    function parsedInstruction(ix: StoredInstruction) {
        if (ix.program === MEMO_PROGRAM) {
            return {
                program: "spl-memo",
                programId: ix.program,
                parsed: new TextDecoder().decode(ix.data),
            };
        }
        const kind = ix.data[0];
        if (ix.program === TOKEN_PROGRAM && kind === TOKEN_TRANSFER_CHECKED) {
            const [source, mint, destination, authority] = ix.accounts;
            const amount = Buffer.from(ix.data).readBigUInt64LE(1);
            return {
                program: "spl-token",
                programId: ix.program,
                parsed: {
                    type: "transferChecked",
                    info: {
                        source,
                        mint,
                        destination,
                        authority,
                        tokenAmount: tokenAmount(amount),
                    },
                },
            };
        }
        if (ix.program === TOKEN_PROGRAM && kind === TOKEN_TRANSFER) {
            const [source, destination, authority] = ix.accounts;
            const amount = Buffer.from(ix.data).readBigUInt64LE(1).toString();
            return {
                program: "spl-token",
                programId: ix.program,
                parsed: { type: "transfer", info: { source, destination, authority, amount } },
            };
        }
        if (ix.program === TOKEN_PROGRAM && kind === TOKEN_APPROVE) {
            const [source, delegate, owner] = ix.accounts;
            const amount = Buffer.from(ix.data).readBigUInt64LE(1).toString();
            return {
                program: "spl-token",
                programId: ix.program,
                parsed: { type: "approve", info: { source, delegate, owner, amount } },
            };
        }
        if (ix.program === TOKEN_PROGRAM && kind === TOKEN_CLOSE_ACCOUNT) {
            const [account, destination, owner] = ix.accounts;
            return {
                program: "spl-token",
                programId: ix.program,
                parsed: { type: "closeAccount", info: { account, destination, owner } },
            };
        }
        if (ix.program === ATA_PROGRAM) {
            const [source, account, wallet, mint, systemProgram, tokenProgram] = ix.accounts;
            return {
                program: "spl-associated-token-account",
                programId: ix.program,
                parsed: {
                    type: ix.data[0] === ATA_CREATE_IDEMPOTENT ? "createIdempotent" : "create",
                    info: { source, account, wallet, mint, systemProgram, tokenProgram },
                },
            };
        }
        if (ix.program === SYSTEM_PROGRAM && ix.data.length >= 12) {
            const [source, destination] = ix.accounts;
            const lamports = Buffer.from(ix.data).readBigUInt64LE(4);
            return {
                program: "system",
                programId: ix.program,
                parsed: { type: "transfer", info: { source, destination, lamports } },
            };
        }
        return {
            programId: ix.program,
            accounts: ix.accounts,
            data: getBase58Decoder().decode(ix.data),
        };
    }

    // A v0 prefix and a header that names five accounts with no bytes after it
    const undecodableWire = (t: Stored) =>
        Buffer.concat([
            Buffer.from([1]),
            Buffer.from(getBase58Encoder().encode(t.signature)),
            Buffer.from([0x80, 1, 0, 0, 5]),
        ]).toString("base64");

    function transactionJson(t: Stored, encoding: unknown, drop: string | null) {
        let transaction: unknown;
        let innerInstructions: unknown[];
        if (encoding === "base64") {
            transaction = [undecodables.has(t.signature) ? undecodableWire(t) : t.wire, "base64"];
            innerInstructions = t.inner.map((g) => ({
                index: g.index,
                instructions: g.instructions.map((ix) => ({
                    programIdIndex: t.keys.indexOf(ix.program),
                    accounts: ix.accounts.map((a) => t.keys.indexOf(a)),
                    data: getBase58Decoder().decode(ix.data),
                    stackHeight: 2,
                })),
            }));
        } else if (encoding === "jsonParsed") {
            const h = t.header;
            const writable = (i: number) =>
                i < h.numSignerAccounts
                    ? i < h.numSignerAccounts - h.numReadonlySignerAccounts
                    : i < t.keys.length - h.numReadonlyNonSignerAccounts;
            transaction = {
                signatures: t.signatures,
                message: {
                    accountKeys: t.keys.map((pubkey, i) => ({
                        pubkey,
                        signer: i < h.numSignerAccounts,
                        writable: writable(i),
                        source: "transaction",
                    })),
                    recentBlockhash: t.recentBlockhash,
                    instructions: t.instructions.map(parsedInstruction),
                },
            };
            innerInstructions = t.inner.map((g) => ({
                index: g.index,
                instructions: g.instructions.map((ix) => ({
                    ...parsedInstruction(ix),
                    stackHeight: 2,
                })),
            }));
        } else {
            throw new RpcError(-32602, "fake chain supports base64 and jsonParsed only");
        }
        return {
            slot: t.slot,
            blockTime: t.blockTime,
            version: 0,
            transaction,
            meta: {
                err: t.err,
                fee: 5000,
                preBalances: [],
                postBalances: [],
                preTokenBalances: tokenBalances(t, t.pre, drop),
                postTokenBalances: tokenBalances(t, t.post, drop),
                innerInstructions,
                logMessages: [],
                loadedAddresses: { writable: [], readonly: [] },
            },
        };
    }

    const takeOne = <K>(counts: Map<K, number>, key: K): boolean => {
        const left = counts.get(key) ?? 0;
        if (left <= 0) return false;
        counts.set(key, left - 1);
        return true;
    };

    // An added endpoint's history: full, short (a node whose history does not reach the slot), or
    // none (-32011, a node run without transaction history)
    function historyMode(): "full" | "short" {
        if (current === null || current.history === true) return "full";
        if (current.history === false) {
            throw new RpcError(-32011, "Transaction history is not available from this node");
        }
        if (current.history === "short") return "short";
        current.historyLookups += 1;
        return current.historyLookups % 2 === 1 ? "full" : "short";
    }

    function getTransaction(sig: string, config: Record<string, unknown>, view: bigint) {
        if (historyMode() === "short") return null;
        const t = bySignature.get(sig);
        const probe = sig === MAINNET_HISTORY_PROBE.signature;
        // Every transaction here is v0, which Agave refuses to a caller without the field
        if ((t !== undefined || probe) && config.maxSupportedTransactionVersion === undefined) {
            throw new RpcError(
                -32015,
                "Transaction version (0) is not supported by the requesting client. " +
                    'Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 0',
            );
        }
        if (probe) return probeTransaction();
        if (takeOne(withheld, sig)) return null;
        if (t === undefined || t.slot > view) return null;
        const bad = badAnswers.get(sig);
        const kind = bad !== undefined && bad.left > 0 ? bad.kind : null;
        if (bad !== undefined && kind !== null) bad.left--;
        const drop = kind !== null && "dropTokenEntryFor" in kind ? kind.dropTokenEntryFor : null;
        const answer = transactionJson(t, config.encoding, drop);
        const time = takeOne(withheldTxTime, t.slot) ? null : answer.blockTime;
        return {
            ...answer,
            blockTime: time,
            meta: kind !== null && "meta" in kind ? null : answer.meta,
        };
    }

    function getBlockTime(params: unknown[], view: bigint): number {
        if (params.length !== 1 || typeof params[0] !== "number") {
            throw new RpcError(-32602, "Invalid params: getBlockTime takes the slot only");
        }
        const at = BigInt(params[0]);
        if (at > view || takeOne(withheldBlockTime, at)) {
            throw new RpcError(BLOCK_NOT_AVAILABLE, `Block not available for slot ${at}`);
        }
        return slotTime(at);
    }

    function getSignaturesForAddress(addr: string, config: Record<string, unknown>, view: bigint) {
        if (historyMode() === "short") return [];
        let list = txs
            .filter(
                (t) =>
                    t.slot <= view &&
                    (prunedBefore === null || t.slot >= prunedBefore) &&
                    t.keys.includes(addr),
            )
            .sort((a, b) => (a.slot === b.slot ? b.seq - a.seq : a.slot > b.slot ? -1 : 1));
        if (typeof config.before === "string") {
            // As on Agave, a before signature the node does not hold answers an empty page
            const at = list.findIndex((t) => t.signature === config.before);
            if (at < 0) return [];
            list = list.slice(at + 1);
        }
        if (typeof config.until === "string") {
            const at = list.findIndex((t) => t.signature === config.until);
            if (at >= 0) list = list.slice(0, at);
        }
        const now = Date.now();
        const limit = typeof config.limit === "number" ? config.limit : 1_000;
        return list
            .filter((t) => (hidden.get(t.signature) ?? 0) <= now)
            .slice(0, limit)
            .map((t) => ({
                signature: t.signature,
                slot: t.slot,
                err: t.err,
                memo: null,
                blockTime: t.blockTime,
                confirmationStatus: statusOf(t.slot),
            }));
    }

    function signatureOfWire(wire: string): string {
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
        const first = Object.values(tx.signatures)[0];
        return getBase58Decoder().decode(first ?? new Uint8Array(64));
    }

    function simulate(wire: string): Record<string, unknown> {
        let message: ReturnType<typeof readMessage>;
        try {
            message = readMessage(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
        } catch {
            throw new RpcError(-32602, "Invalid param: failed to deserialize transaction");
        }
        return dryRun(message);
    }

    function probeTransaction(): Record<string, unknown> {
        return {
            slot: probeSlot,
            blockTime: null,
            version: 0,
            transaction: ["", "base64"],
            meta: {
                err: null,
                fee: 5000,
                preBalances: [],
                postBalances: [],
                preTokenBalances: [],
                postTokenBalances: [],
                innerInstructions: [],
                logMessages: [],
                loadedAddresses: { writable: [], readonly: [] },
            },
        };
    }

    // Synchronous, so the added endpoint's view in current holds for the whole answer
    function answer(method: string, params: unknown[]): unknown {
        const last = params[params.length - 1];
        const config = isRecord(last) ? last : {};
        const view = viewFor(method, config);
        // Above the head every node refuses; below it only a lagged view that is set to refuse
        const refuseLagged = current === null ? lagRefuses : current.refuse;
        if (
            typeof config.minContextSlot === "number" &&
            current?.ignoreMin !== true &&
            (config.minContextSlot > head() || (refuseLagged && view < config.minContextSlot))
        ) {
            throw new RpcError(
                MIN_CONTEXT_SLOT_NOT_REACHED,
                "Minimum context slot has not been reached",
                {
                    contextSlot: Number(view),
                },
            );
        }
        const context = { slot: view };
        switch (method) {
            case "getGenesisHash":
                return current?.genesis ?? MAINNET_GENESIS;
            case "simulateTransaction":
                return { context, value: simulate(params[0] as string) };
            case "getSlot":
                return view;
            case "getBlockHeight":
                return heightOf(view);
            case "getBlockTime":
                return getBlockTime(params, view);
            case "getEpochInfo":
                return {
                    absoluteSlot: view,
                    blockHeight: heightOf(view),
                    epoch: 0,
                    slotIndex: view,
                    slotsInEpoch: 432_000,
                    transactionCount: txs.length,
                };
            case "getLatestBlockhash": {
                const at = view < GENESIS_SLOT ? GENESIS_SLOT : view;
                return {
                    context,
                    value: {
                        blockhash: blockhashOf(at),
                        lastValidBlockHeight: heightOf(at) + BLOCKHASH_LIFE,
                    },
                };
            }
            case "getAccountInfo": {
                if (config.encoding !== "jsonParsed") {
                    throw new RpcError(-32602, "fake chain supports jsonParsed only");
                }
                return { context, value: accountJson(params[0] as string, view) };
            }
            case "getMultipleAccounts": {
                if (config.encoding !== "jsonParsed") {
                    throw new RpcError(-32602, "fake chain supports jsonParsed only");
                }
                const addrs = params[0] as string[];
                return { context, value: addrs.map((a) => accountJson(a, view)) };
            }
            case "getBalance":
                return { context, value: lamportsAt(params[0] as string, view) };
            case "getTokenAccountBalance": {
                const addr = params[0] as string;
                if (!existsAt(addr, view)) {
                    throw new RpcError(-32602, "Invalid param: could not find account");
                }
                return { context, value: tokenAmount(balanceAt(addr, view)) };
            }
            case "getSignatureStatuses": {
                const sigs = params[0] as string[];
                if (config.searchTransactionHistory === true && historyMode() === "short") {
                    return {
                        context: { slot: viewSlot(method, "confirmed") },
                        value: sigs.map(() => null),
                    };
                }
                return {
                    context: { slot: viewSlot(method, "confirmed") },
                    value: sigs.map((s) => {
                        if (s === MAINNET_HISTORY_PROBE.signature) {
                            return {
                                slot: probeSlot,
                                confirmations: null,
                                err: null,
                                confirmationStatus: "finalized",
                            };
                        }
                        const t = bySignature.get(s);
                        if (t === undefined || t.slot > viewSlot(method, "confirmed")) return null;
                        if (hiddenFromStatus.has(s)) return null;
                        return {
                            slot: t.slot,
                            confirmations: null,
                            err: t.err,
                            confirmationStatus: statusOf(t.slot),
                        };
                    }),
                };
            }
            case "getSignaturesForAddress":
                return getSignaturesForAddress(params[0] as string, config, view);
            case "getTransaction":
                return getTransaction(params[0] as string, config, view);
            case "sendTransaction": {
                if (config.encoding !== "base64") {
                    throw new RpcError(-32602, "fake chain supports base64 only");
                }
                const wire = params[0] as string;
                if (current?.dropNext === true) {
                    current.dropNext = false;
                    return signatureOfWire(wire);
                }
                if (
                    current?.alreadyProcessed === true &&
                    config.skipPreflight !== true &&
                    bySignature.has(signatureOfWire(wire))
                ) {
                    throw new RpcError(
                        -32002,
                        "Transaction simulation failed: This transaction has already been processed",
                        {
                            err: "AlreadyProcessed",
                            logs: [],
                            accounts: null,
                            unitsConsumed: 0,
                            returnData: null,
                        },
                    );
                }
                return sendTransaction(wire, config);
            }
            default:
                throw new RpcError(-32601, `Method not found: ${method}`);
        }
    }

    const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
    });
    async function respond(
        body: string,
        view: EndpointView | null,
        log: { method: string; params: unknown[] }[],
    ): Promise<unknown> {
        let id: unknown = null;
        try {
            const parsed: unknown = JSON.parse(body);
            if (!isRecord(parsed) || typeof parsed.method !== "string") {
                return rpcError(null, -32600, "Invalid request");
            }
            id = parsed.id ?? null;
            const params = Array.isArray(parsed.params) ? (parsed.params as unknown[]) : [];
            log.push({ method: parsed.method, params });
            await deriveAtasFor(parsed.method, params);
            current = view;
            try {
                return { jsonrpc: "2.0", id, result: answer(parsed.method, params) };
            } finally {
                current = null;
            }
        } catch (e) {
            if (e instanceof RpcError) return rpcError(id, e.code, e.message, e.data);
            if (e instanceof SyntaxError) return rpcError(null, -32700, "Parse error");
            return rpcError(id, -32603, "Internal error");
        }
    }
    const send = (res: ServerResponse, payload: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(
            JSON.stringify(payload, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v)),
        );
    };
    const server = createServer((req, res) => {
        void readBody(req)
            .then((body) => respond(body, null, requests))
            .catch(() => rpcError(null, -32603, "Internal error"))
            .then((payload) => send(res, payload));
    });

    async function addEndpoint(
        o: Parameters<FakeChain["addEndpoint"]>[0] = {},
    ): Promise<FakeChainEndpoint> {
        const view: EndpointView = {
            lag: o.lag ?? 0,
            refuse: o.refuse ?? true,
            frozen: null,
            ignoreMin: o.ignoreMinContextSlot ?? false,
            history: o.history ?? true,
            historyLookups: 0,
            alreadyProcessed: false,
            dropNext: false,
            genesis: o.genesis ?? MAINNET_GENESIS,
        };
        const log: { method: string; params: unknown[] }[] = [];
        let limited = 0;
        // Without one, a 429 carries no Retry-After, as some endpoints answer
        let retryAfter: number | null = null;
        let failStatus: number | null = null;
        let stallMode: "off" | "before" | "after" = "off";
        let stalled: ReadonlySet<string> | null = null;
        const stalls = (body: string): boolean => {
            if (stalled === null) return true;
            try {
                const parsed: unknown = JSON.parse(body);
                return isRecord(parsed) && stalled.has(String(parsed.method));
            } catch {
                return false;
            }
        };
        const ep = createServer((req, res) => {
            void readBody(req)
                .then(async (body) => {
                    if (stallMode === "before" && stalls(body)) return;
                    if (limited > 0) {
                        limited -= 1;
                        res.writeHead(
                            429,
                            retryAfter === null ? {} : { "retry-after": String(retryAfter) },
                        );
                        res.end();
                        return;
                    }
                    if (failStatus !== null) {
                        const status = failStatus;
                        failStatus = null;
                        res.writeHead(status);
                        res.end();
                        return;
                    }
                    const payload = await respond(body, view, log);
                    if (stallMode === "after" && stalls(body)) return;
                    send(res, payload);
                })
                // A client that aborts during the body read leaves nothing to answer
                .catch(() => res.destroy());
        });
        await new Promise<void>((resolve) => ep.listen(0, "127.0.0.1", resolve));
        const close = async () => {
            ep.closeAllConnections();
            await new Promise<void>((resolve) => ep.close(() => resolve()));
        };
        endpointClosers.push(close);
        return {
            url: `http://127.0.0.1:${(ep.address() as AddressInfo).port}`,
            setLag(slots, opts = {}) {
                view.lag = slots;
                view.refuse = opts.refuse ?? true;
            },
            freeze(on) {
                view.frozen = on ? { slot, finalized: finalized() } : null;
            },
            setHistory(mode) {
                view.history = mode;
                view.historyLookups = 0;
            },
            ignoreMinContextSlot(on) {
                view.ignoreMin = on;
            },
            rateLimit(times, retryAfterSeconds) {
                limited = times;
                retryAfter = retryAfterSeconds ?? null;
            },
            failNext(status = 500) {
                failStatus = status;
            },
            stall(mode, opts = {}) {
                stallMode = mode;
                stalled = opts.methods === undefined ? null : new Set(opts.methods);
            },
            alreadyProcessed(on) {
                view.alreadyProcessed = on;
            },
            dropNext() {
                view.dropNext = true;
            },
            calls: () => log.map((r) => ({ ...r })),
            close,
        };
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const rpc = createRpc(url);

    function advance(blocks: number) {
        for (let i = 0; i < blocks; i++) {
            slot += 1n;
            heights.set(blockhashOf(slot), heightOf(slot));
        }
    }
    const timer =
        o.autoAdvanceMs === undefined ? undefined : setInterval(() => advance(1), o.autoAdvanceMs);
    timer?.unref();

    // Outside senders skip preflight, so preflight(true) only ever refuses the code under test
    async function sendOutside(
        feePayer: KeyPairSigner,
        instructions: Instruction[],
        lifetime?: { blockhash: string; lastValidBlockHeight: bigint },
    ): Promise<string> {
        const life = lifetime ?? {
            blockhash: blockhashOf(slot),
            lastValidBlockHeight: heightOf(slot) + BLOCKHASH_LIFE,
        };
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(feePayer, m),
            (m) =>
                setTransactionMessageLifetimeUsingBlockhash(
                    {
                        blockhash: blockhash(life.blockhash),
                        lastValidBlockHeight: life.lastValidBlockHeight,
                    },
                    m,
                ),
            (m) => appendTransactionMessageInstructions(instructions, m),
        );
        const signed = await signTransactionMessageWithSigners(message);
        return await rpc
            .sendTransaction(getBase64EncodedWireTransaction(signed) as never, {
                encoding: "base64",
                skipPreflight: true,
            })
            .send();
    }

    const createIdempotent = async (owner: string, payer: KeyPairSigner) =>
        await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer,
            owner: address(owner),
            mint: USDC_MINT,
        });

    async function buildAndSend(t: Parameters<FakeChain["transfer"]>[0]): Promise<string> {
        const instructions: Instruction[] = [];
        if (t.createDestinationFor !== undefined) {
            instructions.push(await createIdempotent(t.createDestinationFor, t.feePayer));
        }
        instructions.push(
            getTransferCheckedInstruction({
                source: address(t.source),
                mint: USDC_MINT,
                destination: address(t.destination),
                authority: t.authority,
                amount: t.micros,
                decimals: USDC_DECIMALS,
            }),
        );
        if (t.memo !== undefined) {
            instructions.push({
                programAddress: MEMO_PROGRAM,
                data: new TextEncoder().encode(t.memo),
            });
        }
        return await sendOutside(t.feePayer, instructions, t.lifetime);
    }

    return {
        url,
        rpc,
        slot: () => slot,
        height: () => heightOf(slot),
        advance,
        finalize(upTo) {
            const target = upTo === undefined || upTo > slot ? slot : upTo;
            if (target > finalizedSlot) finalizedSlot = target;
        },
        setTokenAccount: setAccount,
        balance: tipBalance,
        submitted: () =>
            sentOnRpc.map((t) => ({
                signature: t.signature,
                slot: t.slot,
                failed: t.err !== null,
            })),
        async cosignAndSubmit(wireBase64, feePayer) {
            const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
            const signed = await partiallySignTransaction([feePayer.keyPair], tx);
            return await rpc
                .sendTransaction(getBase64EncodedWireTransaction(signed) as never, {
                    encoding: "base64",
                })
                .send();
        },
        credit: (account, micros) => {
            known(account);
            return internalTransaction(
                uniqueness(),
                transferFrom(outsideAta, account, outside, micros),
            );
        },
        debit: (account, micros) => {
            const acct = known(account);
            if (tipBalance(account) < micros) {
                throw new Error(`fake chain: ${account} holds less than ${micros}`);
            }
            return internalTransaction(
                uniqueness(),
                transferFrom(account, outsideAta, acct.owner, micros),
            );
        },
        approve: (account, delegate) => {
            const acct = known(account);
            return internalTransaction(
                uniqueness(),
                getApproveInstruction({
                    source: address(account),
                    delegate: address(delegate),
                    owner: createNoopSigner(address(acct.owner)),
                    amount: 1_000_000_000n,
                }),
            );
        },
        hideFromIndex: (sig, ms) => hidden.set(sig, Date.now() + ms),
        lagNode(slots, opts = {}) {
            lag = slots;
            lagRefuses = opts.refuse ?? true;
            lagMethods = opts.methods;
        },
        failNext: () => {
            failNextFlag = true;
        },
        transfer: buildAndSend,
        withholdTransaction: (sig, times) => withheld.set(sig, times),
        calls: () => requests.map((r) => ({ ...r })),
        addEndpoint,
        async close() {
            if (timer !== undefined) clearInterval(timer);
            for (const closeEndpoint of endpointClosers) await closeEndpoint().catch(() => {});
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
        accountExists: (addr) => existsAt(addr, slot),
        setBlockTime(seconds) {
            blockTimeSetting = seconds;
            if (seconds !== null) lastSetTime = seconds;
        },
        withholdBlockTime(at, times) {
            withheldTxTime.set(at, times);
            withheldBlockTime.set(at, times);
        },
        async createAta(c) {
            return await sendOutside(c.payer, [
                outsideUniqueness(),
                await createIdempotent(c.owner, c.payer),
            ]);
        },
        async transferMany(m) {
            const source = await usdcAta(m.from.address);
            const credits = m.to.map((t) =>
                getTransferCheckedInstruction({
                    source,
                    mint: USDC_MINT,
                    destination: address(t.tokenAccount),
                    authority: m.from,
                    amount: t.micros,
                    decimals: USDC_DECIMALS,
                }),
            );
            return await sendOutside(m.from, [outsideUniqueness(), ...credits]);
        },
        async vaultTransfer(v) {
            const vaultOwner = known(v.vault).owner;
            const ix: Instruction = {
                programAddress: VAULT_PROGRAM,
                accounts: [
                    { address: address(v.vault), role: AccountRole.WRITABLE },
                    { address: USDC_MINT, role: AccountRole.READONLY },
                    { address: address(v.to), role: AccountRole.WRITABLE },
                    { address: address(vaultOwner), role: AccountRole.READONLY },
                    { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
                ],
                data: u64(v.micros),
            };
            return await sendOutside(v.signer, [outsideUniqueness(), ix]);
        },
        lamports: (addr) => lamportsAt(addr, slot),
        fundLamports(addr, lamports) {
            lamportDeltas.push({ account: addr, slot, amount: lamports });
        },
        async noOp(n) {
            const touching = typeof n.touching === "string" ? [n.touching] : n.touching;
            const ix: Instruction = {
                programAddress: NOOP_PROGRAM,
                accounts: touching.map((a) => ({
                    address: address(a),
                    role: AccountRole.READONLY,
                })),
                // The nonce keeps two equal noOps apart without naming one more account
                data: new Uint8Array([n.fail === true ? 1 : 0, ...u32(++outsideNonce)]),
            };
            return await sendOutside(n.signer, [ix]);
        },
        preflight(on) {
            preflightOn = on;
        },
        hideFromStatus: (sig) => hiddenFromStatus.add(sig),
        pruneHistoryBefore(at) {
            prunedBefore = at;
        },
        undecodable: (sig) => undecodables.add(sig),
        badAnswer(sig, times, kind) {
            badAnswers.set(sig, { left: times, kind });
        },
    };
}
