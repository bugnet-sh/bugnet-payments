import { getBase58Decoder, type Address, type KeyPairSigner } from "@solana/kit";
import type pg from "pg";
import { ConfigError, type Settings } from "./config.ts";
import { withTx } from "./db/pool.ts";
import type { Log } from "./log.ts";
import { inspectTokenAccount, usdcAta } from "./solana/accounts.ts";
import { TOKEN_PROGRAM, USDC_MINT } from "./solana/constants.ts";
import { loadKeypair } from "./solana/keys.ts";
import type { SolanaRpc } from "./solana/rpc.ts";
import { recordIncident } from "./x402/incidents.ts";
import { loadIndex, type IndexCopy } from "./x402/index-file.ts";
import { checkTlsFiles, type SignerGate, type TlsFiles } from "./x402/listener.ts";
import { hotLedgerEmpty, openTail, readTail } from "./x402/tail.ts";
import type { MirrorRun } from "./x402/mirror.ts";

export class BootCheckError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BootCheckError";
    }
}

export interface BootDeps {
    rpc: SolanaRpc;
    recipient: Address;
    feePayer: Address;
    refundWallet: Address;
    feePayerMinLamports: bigint;
    refundsEnabled: boolean;
    eventPublicKey: string;
}

async function requireUsdcAccount(
    rpc: SolanaRpc,
    label: string,
    owner: Address,
    fix: string,
): Promise<Address> {
    const ata = await usdcAta(owner);
    const info = await inspectTokenAccount(rpc, ata);
    if (info === null) {
        throw new BootCheckError(`${label} USDC account ${ata} does not exist: ${fix}`);
    }
    if (info.programOwner !== TOKEN_PROGRAM) {
        throw new BootCheckError(
            `${label} USDC account ${ata} is owned by program ${info.programOwner}, not the Token program ${TOKEN_PROGRAM}`,
        );
    }
    if (info.mint !== USDC_MINT) {
        throw new BootCheckError(
            `${label} USDC account ${ata} has mint ${info.mint}, expected USDC ${USDC_MINT}`,
        );
    }
    if (info.owner !== owner) {
        throw new BootCheckError(
            `${label} USDC account ${ata} is owned by ${info.owner}, expected ${owner}`,
        );
    }
    if (info.state === "frozen") {
        throw new BootCheckError(
            `${label} USDC account ${ata} is frozen: use a different ${label} wallet`,
        );
    }
    if (info.state !== "initialized") {
        throw new BootCheckError(`${label} USDC account ${ata} is not initialized: ${fix}`);
    }
    return ata;
}

export async function bootChecks(
    d: BootDeps,
): Promise<{ recipientAta: Address; feePayerLamports: bigint }> {
    if (d.refundsEnabled && d.eventPublicKey === "") {
        throw new BootCheckError(
            'router.event_public_key: set it to the output of bugnet-dev pubkey --priv "$BUGNET_EVENT_SIGNING_KEY" ' +
                "(dev only: the key appears in argv and shell history; use pubkey --event once router Task 39 ships)",
        );
    }
    if (d.recipient === d.feePayer || d.recipient === d.refundWallet) {
        throw new BootCheckError(
            `recipient must be a cold address: ${d.recipient} is also the fee payer or the refund wallet; ` +
                "set [solana] recipient in the TOML settings to the cold wallet's address",
        );
    }

    const recipientAta = await requireUsdcAccount(
        d.rpc,
        "recipient",
        d.recipient,
        `create it once with: pnpm cli keys fund --create-recipient-ata ${d.recipient}`,
    );

    const { value: feePayerLamports } = await d.rpc.getBalance(d.feePayer).send();
    if (feePayerLamports < d.feePayerMinLamports) {
        throw new BootCheckError(
            `fee payer holds ${feePayerLamports} lamports, needs at least ${d.feePayerMinLamports}: send SOL to ${d.feePayer}`,
        );
    }

    if (d.refundsEnabled) {
        await requireUsdcAccount(
            d.rpc,
            "refund",
            d.refundWallet,
            "create it once with: pnpm cli keys fund --create-refund-ata, or set refunds.enabled = false",
        );
    }
    return { recipientAta, feePayerLamports: BigInt(feePayerLamports) };
}

export interface X402BootDeps {
    pool: pg.Pool;
    allowanceKey: string;
    x402: Settings["x402"];
    others: {
        feePayer: string;
        refundWallet: string;
        recipient: string;
        orderPublicKeyBase64: string;
    };
    routerToken: string;
    eventPublicKey: string;
    tls: TlsFiles;
    gate: SignerGate;
    runMirror: () => Promise<MirrorRun | "skipped">;
    log: Log;
    now: () => Date;
}

const TLS_SERVER_NAME = "bugnet-payments.internal";

async function loadAllowance(d: X402BootDeps): Promise<KeyPairSigner> {
    let allowance: KeyPairSigner;
    try {
        allowance = await loadKeypair(d.allowanceKey, "BUGNET_ALLOWANCE_KEY");
    } catch (err) {
        throw new BootCheckError((err as Error).message);
    }
    const wallet = d.x402.allowance_wallet;
    if (allowance.address !== wallet) {
        throw new BootCheckError(
            `BUGNET_ALLOWANCE_KEY's address ${allowance.address} is not [x402] allowance_wallet ${wallet}`,
        );
    }
    const orderKey = getBase58Decoder().decode(
        Buffer.from(d.others.orderPublicKeyBase64, "base64").subarray(-32),
    );
    const clashes: Array<[string, string]> = [
        [d.others.feePayer, "the fee payer"],
        [d.others.refundWallet, "the refund wallet"],
        [d.others.recipient, "the recipient"],
        [orderKey, "the order-token key"],
    ];
    for (const [other, name] of clashes) {
        if (allowance.address === other) {
            throw new BootCheckError(
                `BUGNET_ALLOWANCE_KEY must be its own wallet: its address is also ${name}`,
            );
        }
    }
    return allowance;
}

function tokenAccountProblem(
    info: Awaited<ReturnType<typeof inspectTokenAccount>>,
    wallet: string,
): string | undefined {
    if (info === null) return "missing";
    if (info.programOwner !== TOKEN_PROGRAM) return "not owned by the Token program";
    if (info.mint !== USDC_MINT) return "not a USDC account";
    if (info.state !== "initialized") return `state ${info.state}`;
    if (info.owner !== wallet) return "owner is not allowance_wallet";
    if (info.delegate !== null) return "delegate set";
    if (info.closeAuthority !== null) return "close authority set";
    return undefined;
}

export async function x402BootChecks(
    rpc: SolanaRpc,
    d: X402BootDeps,
): Promise<{ allowance: KeyPairSigner; index: IndexCopy; hotTokenAccount: Address }> {
    const wallet = d.x402.allowance_wallet;
    const allowance = await loadAllowance(d);

    let index: IndexCopy;
    try {
        index = loadIndex(d.x402.indexed_services_file);
    } catch (err) {
        if (err instanceof ConfigError) throw new BootCheckError(err.message);
        throw err;
    }

    if (d.eventPublicKey === "") {
        throw new BootCheckError(
            "router.event_public_key must be set while [x402] allowance_wallet is set",
        );
    }
    if (d.routerToken === "") {
        throw new BootCheckError(
            "BUGNET_PAYMENTS_ROUTER_TOKEN must be set while [x402] allowance_wallet is set",
        );
    }

    const hot = await usdcAta(allowance.address);
    const tail = await readTail(d.pool);
    let info: Awaited<ReturnType<typeof inspectTokenAccount>> = null;
    let rpcError = false;
    try {
        info = await inspectTokenAccount(rpc, hot, { commitment: "finalized" });
    } catch (err) {
        // An open tail already pins this account; a failed read only delays the live check
        if (tail.tokenAccount !== hot) throw err;
        rpcError = true;
    }

    let opened = false;
    if (tail.tokenAccount !== hot) {
        if (tail.tokenAccount !== null && !(await hotLedgerEmpty(d.pool))) {
            throw new BootCheckError(
                `x402_tail token account ${tail.tokenAccount} is not ATA(${wallet}) and the hot ledger is not empty: run keys drain --allowance first`,
            );
        }
        if (info === null) {
            throw new BootCheckError(
                `allowance USDC account ${hot} does not exist: create it once with: pnpm cli keys fund --create-allowance-ata`,
            );
        }
        await openTail(d.pool, hot, info.amount, info.contextSlot, d.now());
        opened = true;
    }

    if (rpcError) {
        d.gate.record("token_account", "error", "read failed");
    } else {
        const problem = tokenAccountProblem(info, wallet);
        d.gate.record("token_account", problem === undefined ? "pass" : "fail", problem);
        if (problem !== undefined) {
            await withTx(d.pool, (c) =>
                recordIncident(
                    c,
                    { kind: "token_account_changed", subject: hot, detail: { problem } },
                    d.log,
                    d.now(),
                ),
            );
        }
    }

    const tls = checkTlsFiles(d.tls, TLS_SERVER_NAME, d.now());
    d.gate.record("tls", tls.ok ? "pass" : "fail", tls.ok ? undefined : tls.problem);

    const verifiedAt = opened ? null : (await readTail(d.pool)).verifiedAt;
    if (
        verifiedAt === null ||
        verifiedAt.getTime() < d.now().getTime() - d.x402.mirror_idle_every
    ) {
        try {
            await d.runMirror();
        } catch (err) {
            d.log.warn("boot mirror run failed", { err });
        }
    }
    return { allowance, index, hotTokenAccount: hot };
}

// Without allowance_wallet a hot refund event would throw 'hot order refund needs
// AllowanceFunding' and retry forever
export async function refuseUnfinishedAllowanceOrders(pool: pg.Pool): Promise<void> {
    const { rows } = await pool.query<{ n: string }>(
        `select count(*) as n from orders o
         where o.pay_into = 'allowance' and o.state not in ('refunded', 'expired')
           and not (o.state = 'redeemed' and exists (
                select 1 from x402_accounts a
                where a.state = 'closed'
                  and (a.id = o.id or a.id in
                        (select account_id from x402_fundings where order_id = o.id))))`,
    );
    const n = Number(rows[0]!.n);
    if (n > 0) {
        throw new BootCheckError(
            `[x402] allowance_wallet is empty while ${n} allowance order(s) are not finished: set it back to the allowance wallet's address`,
        );
    }
}
