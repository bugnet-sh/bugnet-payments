import { type Address, address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
export const USDC_MINT: Address = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDC_DECIMALS = 6;
export const TOKEN_PROGRAM: Address = TOKEN_PROGRAM_ADDRESS;
// Not @solana-program/memo's default (Memo4c2...): x402 uses the legacy Memo program.
export const MEMO_PROGRAM: Address = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const LIGHTHOUSE_PROGRAM: Address = address("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
export const UNKNOWN_BLOCKHASH_MARGIN = 300n;
