import {
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
} from "@solana/kit";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { peekWireTransactionVersion, transactionMessageHash } from "@x402/svm";
import { isOrderId } from "../orders/ids.ts";
import { TOKEN_PROGRAM } from "../solana/constants.ts";

export type PayRefusal =
    | "order_unknown"
    | "order_expired"
    | "order_closed"
    | "payment_malformed"
    | "payment_invalid"
    | "payment_replayed"
    | "payment_order_mismatch"
    | "payer_blocked"
    | "payer_busy"
    | "payer_rate_limited"
    | "payer_invalid"
    | "router_unavailable"
    | "rpc_unavailable"
    | "settlement_unavailable"
    | "too_many_attempts";

export class PaymentRefusal extends Error {
    constructor(
        readonly reason: PayRefusal,
        readonly code?: string,
    ) {
        super(code === undefined ? reason : `${reason}: ${code}`);
        this.name = "PaymentRefusal";
    }
}

export interface DecodedPayment {
    payload: PaymentPayload;
    payer: string;
    sourceTokenAccount: string;
    messageHash: string;
    blockhash: string;
    memoOrderId: string | undefined;
}

const TRANSFER_CHECKED = 12;

export function parsePaymentHeader(value: string): unknown {
    try {
        return decodePaymentSignatureHeader(value);
    } catch {
        throw new PaymentRefusal("payment_malformed");
    }
}

function invalid(code: string): PaymentRefusal {
    return new PaymentRefusal("payment_invalid", code);
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodeWire(wire: string) {
    try {
        const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
        return { tx, compiled: getCompiledTransactionMessageDecoder().decode(tx.messageBytes) };
    } catch {
        throw new PaymentRefusal("payment_malformed");
    }
}

export function decodePayment(
    raw: unknown,
    ctx: { feePayer: string; transactionVersions: readonly (0 | 1)[] },
): DecodedPayment {
    if (!isRecord(raw) || raw.x402Version !== 2) throw invalid("invalid_x402_version");
    const { accepted, payload } = raw;
    if (!isRecord(accepted) || !isRecord(payload) || typeof payload.transaction !== "string") {
        throw new PaymentRefusal("payment_malformed");
    }
    const wire = payload.transaction;
    const version = peekWireTransactionVersion(wire);
    // Bytes too short to carry a version fall through to the decoder and come back malformed
    if (
        version !== undefined &&
        !(ctx.transactionVersions as readonly unknown[]).includes(version)
    ) {
        throw invalid("unsupported_transaction_version");
    }
    const { tx, compiled } = decodeWire(wire);
    if (compiled.version !== 0) throw invalid("unsupported_transaction_version");
    if ((compiled.addressTableLookups ?? []).length > 0) {
        throw invalid("address_lookup_tables_refused");
    }
    const accounts = compiled.staticAccounts;
    if (accounts[0] !== ctx.feePayer) throw invalid("invalid_exact_svm_fee_payer_mismatch");
    if (compiled.header.numSignerAccounts !== 2) {
        throw invalid("invalid_exact_svm_payload_excessive_signers");
    }
    const transfer = compiled.instructions.find(
        (ix) =>
            accounts[ix.programAddressIndex] === TOKEN_PROGRAM &&
            ix.data?.[0] === TRANSFER_CHECKED &&
            (ix.accountIndices?.length ?? 0) >= 4,
    );
    if (transfer === undefined) {
        throw invalid("invalid_exact_svm_payload_no_transfer_instruction");
    }
    const indices = transfer.accountIndices!;
    const source = accounts[indices[0]!];
    const payer = accounts[indices[3]!];
    if (source === undefined) throw new PaymentRefusal("payment_malformed");
    if (payer === undefined || payer !== accounts[1] || payer === ctx.feePayer) {
        throw invalid("payer_mismatch");
    }
    if (tx.signatures[payer]?.length !== 64) throw invalid("payer_signature_missing");
    const memo = isRecord(accepted.extra) ? accepted.extra.memo : undefined;
    return {
        payload: raw as PaymentPayload,
        payer,
        sourceTokenAccount: source,
        messageHash: transactionMessageHash(tx),
        blockhash: compiled.lifetimeToken,
        memoOrderId: isOrderId(memo) ? memo : undefined,
    };
}
