import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
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
import { getApproveInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { isRecord } from "../is-record.ts";
import { usdcAta } from "../solana/accounts.ts";
import { MEMO_PROGRAM, TOKEN_PROGRAM, USDC_DECIMALS, USDC_MINT } from "../solana/constants.ts";
import { createRpc, type SolanaRpc } from "../solana/rpc.ts";
import { MAINNET_GENESIS, MAINNET_HISTORY_PROBE } from "../solana/router/index.ts";

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
    transfer(o: {
        authority: KeyPairSigner;
        feePayer: KeyPairSigner;
        source: string;
        destination: string;
        micros: bigint;
        memo?: string;
        lifetime?: { blockhash: string; lastValidBlockHeight: bigint };
    }): Promise<string>;
    withholdTransaction(signature: string, times: number): void;
    // SOL balances getBalance answers, 0 for an unknown address
    lamports(address: string): bigint;
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
const MIN_CONTEXT_SLOT_NOT_REACHED = -32016;
const spkiEd25519Prefix = Buffer.from("302a300506032b6570032100", "hex");
const TOKEN_TRANSFER = 3;
const TOKEN_APPROVE = 4;
const TOKEN_TRANSFER_CHECKED = 12;

interface Account {
    owner: string;
    genesis: bigint;
    state: "initialized" | "frozen";
    delegate: string | null;
    closeAuthority: string | null;
}

interface Delta {
    account: string;
    slot: bigint;
    amount: bigint;
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
    instructions: { program: string; accounts: string[]; data: Uint8Array }[];
    err: unknown;
    pre: Map<number, bigint>;
    post: Map<number, bigint>;
    blockTime: number;
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
    let seq = 0;
    const accounts = new Map<string, Account>();
    const deltas: Delta[] = [];
    const txs: Stored[] = [];
    const bySignature = new Map<string, Stored>();
    const sentOnRpc: Stored[] = [];
    const hidden = new Map<string, number>();
    const withheld = new Map<string, number>();
    const requests: { method: string; params: unknown[] }[] = [];
    const lamportsByAddress = new Map<string, bigint>();
    // Set while an added endpoint's request is answered; answer() runs synchronously
    let current: EndpointView | null = null;
    const endpointClosers: (() => Promise<void>)[] = [];
    // The router's history check asks for this old mainnet transaction before any payment exists
    const probeSlot = GENESIS_SLOT - 1n;
    const heights = new Map<string, bigint>([
        [blockhashOf(GENESIS_SLOT), GENESIS_SLOT - HEIGHT_OFFSET],
    ]);

    const heightOf = (s: bigint) => s - HEIGHT_OFFSET;
    const finalized = () => (o.autoFinalize === true ? slot : finalizedSlot);

    const balanceAt = (account: string, at: bigint): bigint =>
        deltas
            .filter((d) => d.account === account && d.slot <= at)
            .reduce((sum, d) => sum + d.amount, accounts.get(account)?.genesis ?? 0n);
    const tipBalance = (account: string) => balanceAt(account, slot);

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
        });
    }

    const outsideKeys = generateKeyPairSync("ed25519");
    const outside = getAddressDecoder().decode(
        outsideKeys.publicKey.export({ format: "der", type: "spki" }).subarray(12),
    );
    const outsideAta = await usdcAta(outside);
    setAccount({ address: outsideAta, owner: outside, amount: OUTSIDE_FUNDS });

    function apply(
        keys: string[],
        numSigners: number,
        instructions: Stored["instructions"],
    ): { err: unknown; working: Map<string, { amount: bigint; delegate: string | null }> } {
        const working = new Map<string, { amount: bigint; delegate: string | null }>();
        const load = (addr: string) => {
            const acct = accounts.get(addr);
            if (acct === undefined) return undefined;
            let w = working.get(addr);
            if (w === undefined) {
                w = { amount: tipBalance(addr), delegate: acct.delegate };
                working.set(addr, w);
            }
            return { acct, w };
        };
        const signed = (addr: string | undefined) =>
            addr !== undefined && keys.indexOf(addr) >= 0 && keys.indexOf(addr) < numSigners;
        const authorised = (
            acct: Account,
            w: { delegate: string | null },
            who: string | undefined,
        ) => signed(who) && (who === acct.owner || who === w.delegate);
        const fail = (index: number) => ({ InstructionError: [index, { Custom: 1 }] });

        for (const [index, ix] of instructions.entries()) {
            if (ix.program !== TOKEN_PROGRAM) continue;
            const kind = ix.data[0];
            if (kind === TOKEN_TRANSFER || kind === TOKEN_TRANSFER_CHECKED) {
                const checked = kind === TOKEN_TRANSFER_CHECKED;
                const [srcKey, second, third, fourth] = ix.accounts;
                const dstKey = checked ? third : second;
                const authority = checked ? fourth : third;
                const amount = Buffer.from(ix.data).readBigUInt64LE(1);
                if (checked && (second !== USDC_MINT || ix.data[9] !== USDC_DECIMALS)) {
                    return { err: fail(index), working };
                }
                const src = srcKey === undefined ? undefined : load(srcKey);
                const dst = dstKey === undefined ? undefined : load(dstKey);
                if (
                    src === undefined ||
                    dst === undefined ||
                    src.acct.state !== "initialized" ||
                    dst.acct.state !== "initialized" ||
                    !authorised(src.acct, src.w, authority) ||
                    src.w.amount < amount
                ) {
                    return { err: fail(index), working };
                }
                src.w.amount -= amount;
                dst.w.amount += amount;
            } else if (kind === TOKEN_APPROVE) {
                const [srcKey, delegate, owner] = ix.accounts;
                const src = srcKey === undefined ? undefined : load(srcKey);
                if (
                    src === undefined ||
                    delegate === undefined ||
                    !(signed(owner) && owner === src.acct.owner)
                ) {
                    return { err: fail(index), working };
                }
                src.w.delegate = delegate;
            } else {
                return { err: fail(index), working };
            }
        }
        return { err: null, working };
    }

    function land(tx: Transaction, wire: string, viaRpc: boolean): string {
        const compiled = decodeMessage(tx);
        const keys = [...compiled.staticAccounts] as string[];
        const first = Object.values(tx.signatures)[0];
        const sig = getBase58Decoder().decode(first ?? new Uint8Array(64));
        const existing = bySignature.get(sig);
        if (existing !== undefined) return sig;

        const instructions = compiled.instructions.map((ix) => ({
            program: keys[ix.programAddressIndex]!,
            accounts: (ix.accountIndices ?? []).map((i) => keys[i]!),
            data: new Uint8Array(ix.data ?? []),
        }));
        const tokenAt = instructions.findIndex((ix) => ix.program === TOKEN_PROGRAM);
        const result = failNextFlag
            ? {
                  err: { InstructionError: [Math.max(tokenAt, 0), { Custom: 1 }] },
                  working: new Map<string, { amount: bigint; delegate: string | null }>(),
              }
            : apply(keys, compiled.header.numSignerAccounts, instructions);
        failNextFlag = false;

        const pre = new Map<number, bigint>();
        const post = new Map<number, bigint>();
        keys.forEach((k, i) => {
            if (!accounts.has(k)) return;
            const before = tipBalance(k);
            pre.set(i, before);
            post.set(i, result.working.get(k)?.amount ?? before);
        });
        for (const [addr, w] of result.working) {
            const diff = w.amount - tipBalance(addr);
            if (diff !== 0n) deltas.push({ account: addr, slot, amount: diff });
            accounts.get(addr)!.delegate = w.delegate;
        }

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
            err: result.err,
            pre,
            post,
            blockTime: Math.floor(Date.now() / 1000),
        };
        txs.push(stored);
        bySignature.set(sig, stored);
        if (viaRpc) sentOnRpc.push(stored);
        return sig;
    }

    function sendTransaction(wire: string): string {
        let tx: Transaction;
        let compiled: ReturnType<typeof decodeMessage>;
        try {
            tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
            compiled = decodeMessage(tx);
        } catch {
            throw new RpcError(-32602, "Invalid param: failed to deserialize transaction");
        }
        const known = heights.get(compiled.lifetimeToken);
        if (known === undefined || heightOf(slot) > known + BLOCKHASH_LIFE) {
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

    function known(addr: string): Account {
        const acct = accounts.get(addr);
        if (acct === undefined) throw new Error(`fake chain: no token account ${addr}`);
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

    function viewSlot(method: string, commitment: unknown): bigint {
        // Kit strips an explicit finalized and injects confirmed when none is given, so a request
        // that arrives with no commitment is the finalized one, as on a real node
        const head = current?.frozen?.slot ?? slot;
        const fin = current?.frozen?.finalized ?? finalized();
        const base = commitment === undefined || commitment === "finalized" ? fin : head;
        const at = base - BigInt(current === null ? lagFor(method) : current.lag);
        return at < 0n ? 0n : at;
    }

    const statusOf = (s: bigint) => (s <= finalized() ? "finalized" : "confirmed");

    function tokenAccountJson(addr: string, at: bigint) {
        const acct = known(addr);
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
            lamports: 2_039_280,
            owner: TOKEN_PROGRAM,
            rentEpoch: 0,
            space: 165,
        };
    }

    function tokenBalances(t: Stored, which: Map<number, bigint>) {
        return [...which].map(([accountIndex, amount]) => ({
            accountIndex,
            mint: USDC_MINT,
            owner: accounts.get(t.keys[accountIndex]!)!.owner,
            programId: TOKEN_PROGRAM,
            uiTokenAmount: tokenAmount(amount),
        }));
    }

    function parsedInstruction(ix: Stored["instructions"][number]) {
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
        return {
            programId: ix.program,
            accounts: ix.accounts,
            data: getBase58Decoder().decode(ix.data),
        };
    }

    function transactionJson(t: Stored, encoding: unknown) {
        let transaction: unknown;
        if (encoding === "base64") {
            transaction = [t.wire, "base64"];
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
                preTokenBalances: tokenBalances(t, t.pre),
                postTokenBalances: tokenBalances(t, t.post),
                innerInstructions: [],
                logMessages: [],
                loadedAddresses: { writable: [], readonly: [] },
            },
        };
    }

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

    function signatureOfWire(wire: string): string {
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
        const first = Object.values(tx.signatures)[0];
        return getBase58Decoder().decode(first ?? new Uint8Array(64));
    }

    // A dry run of apply() on the current state: nothing lands
    function simulate(wire: string): Record<string, unknown> {
        let tx: Transaction;
        let compiled: ReturnType<typeof decodeMessage>;
        try {
            tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
            compiled = decodeMessage(tx);
        } catch {
            throw new RpcError(-32602, "Invalid param: failed to deserialize transaction");
        }
        const result = { logs: [], accounts: null, unitsConsumed: 0, returnData: null };
        const known = heights.get(compiled.lifetimeToken);
        if (known === undefined || heightOf(slot) > known + BLOCKHASH_LIFE) {
            return { err: "BlockhashNotFound", ...result };
        }
        const keys = [...compiled.staticAccounts] as string[];
        const instructions = compiled.instructions.map((ix) => ({
            program: keys[ix.programAddressIndex]!,
            accounts: (ix.accountIndices ?? []).map((i) => keys[i]!),
            data: new Uint8Array(ix.data ?? []),
        }));
        const { err } = apply(keys, compiled.header.numSignerAccounts, instructions);
        return { err, ...result, unitsConsumed: 1_000 };
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

    function answer(method: string, params: unknown[]): unknown {
        const last = params[params.length - 1];
        const config = isRecord(last) ? last : {};
        const view = viewSlot(method, config.commitment);
        // Above the head every node refuses; below it only a lagged view that is set to refuse
        const head = current?.frozen?.slot ?? slot;
        const refuseLagged = current === null ? lagRefuses : current.refuse;
        if (
            typeof config.minContextSlot === "number" &&
            current?.ignoreMin !== true &&
            (config.minContextSlot > head || (refuseLagged && view < config.minContextSlot))
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
            case "getBalance":
                return { context, value: lamportsByAddress.get(params[0] as string) ?? 0n };
            case "simulateTransaction":
                return { context, value: simulate(params[0] as string) };
            case "getSlot":
                return view;
            case "getBlockHeight":
                return heightOf(view);
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
                const addr = params[0] as string;
                return {
                    context,
                    value: accounts.has(addr) ? tokenAccountJson(addr, view) : null,
                };
            }
            case "getTokenAccountBalance": {
                const addr = params[0] as string;
                if (!accounts.has(addr)) {
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
                        return {
                            slot: t.slot,
                            confirmations: null,
                            err: t.err,
                            confirmationStatus: statusOf(t.slot),
                        };
                    }),
                };
            }
            case "getSignaturesForAddress": {
                const addr = params[0] as string;
                if (historyMode() === "short") return [];
                let list = txs
                    .filter((t) => t.slot <= view && t.keys.includes(addr))
                    .sort((a, b) => (a.slot === b.slot ? b.seq - a.seq : a.slot > b.slot ? -1 : 1));
                if (typeof config.before === "string") {
                    const at = list.findIndex((t) => t.signature === config.before);
                    if (at >= 0) list = list.slice(at + 1);
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
            case "getTransaction": {
                const sig = params[0] as string;
                if (historyMode() === "short") return null;
                const t = bySignature.get(sig);
                const probe = sig === MAINNET_HISTORY_PROBE.signature;
                // Every transaction here is v0, which Agave refuses to a caller without the field
                if (
                    (t !== undefined || probe) &&
                    config.maxSupportedTransactionVersion === undefined
                ) {
                    throw new RpcError(
                        -32015,
                        "Transaction version (0) is not supported by the requesting client. " +
                            'Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 0',
                    );
                }
                if (probe) return probeTransaction();
                const left = withheld.get(sig) ?? 0;
                if (left > 0) {
                    withheld.set(sig, left - 1);
                    return null;
                }
                if (t === undefined || t.slot > view) return null;
                return transactionJson(t, config.encoding);
            }
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
                return sendTransaction(wire);
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
    function respond(
        body: string,
        view: EndpointView | null,
        log: { method: string; params: unknown[] }[],
    ): unknown {
        let id: unknown = null;
        try {
            const parsed: unknown = JSON.parse(body);
            if (!isRecord(parsed) || typeof parsed.method !== "string") {
                return rpcError(null, -32600, "Invalid request");
            }
            id = parsed.id ?? null;
            const params = Array.isArray(parsed.params) ? (parsed.params as unknown[]) : [];
            log.push({ method: parsed.method, params });
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
                .then((body) => {
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
                    const payload = respond(body, view, log);
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

    async function buildAndSend(t: Parameters<FakeChain["transfer"]>[0]): Promise<string> {
        const lifetime = t.lifetime ?? {
            blockhash: blockhashOf(slot),
            lastValidBlockHeight: heightOf(slot) + BLOCKHASH_LIFE,
        };
        const instructions: Instruction[] = [
            getTransferCheckedInstruction({
                source: address(t.source),
                mint: USDC_MINT,
                destination: address(t.destination),
                authority: t.authority,
                amount: t.micros,
                decimals: USDC_DECIMALS,
            }),
        ];
        if (t.memo !== undefined) {
            instructions.push({
                programAddress: MEMO_PROGRAM,
                data: new TextEncoder().encode(t.memo),
            });
        }
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(t.feePayer, m),
            (m) =>
                setTransactionMessageLifetimeUsingBlockhash(
                    {
                        blockhash: blockhash(lifetime.blockhash),
                        lastValidBlockHeight: lifetime.lastValidBlockHeight,
                    },
                    m,
                ),
            (m) => appendTransactionMessageInstructions(instructions, m),
        );
        const signed = await signTransactionMessageWithSigners(message);
        return await rpc
            .sendTransaction(getBase64EncodedWireTransaction(signed) as never, {
                encoding: "base64",
            })
            .send();
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
        lamports: (address) => lamportsByAddress.get(address) ?? 0n,
        fundLamports: (address, lamports) => {
            lamportsByAddress.set(address, lamports);
        },
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
    };
}
