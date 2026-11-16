# bugnet-payments

Sells Bugnet orders for USDC on Solana mainnet through x402 v2 `exact`, settles them with our own
fee payer, issues router order tokens only to claim holders and refunds automatically.

## Setup

Needs Node 26, pnpm 12.6, `buf`, Postgres 18 and a `../proto` checkout next to this one.

```sh
pnpm install   # @solana/pay-kit comes from vendor/, check it with: shasum -a 256 -c vendor/SHA256SUMS
pnpm proto     # generates src/gen from ../proto
```

`@x402/svm` is pinned at 2.30.0 with `patches/@x402__svm@2.30.0.patch` (`pnpm-workspace.yaml`
`patchedDependencies`). The patch lets a payment carry the Lighthouse instructions Phantom adds
around the USDC transfer. Without it, settlement refuses every Phantom payment. An upgrade of
`@x402/svm` drops the patch: port it to the new version and run the Phantom tests in
`src/orders/pay.test.ts` ("Phantom's real layout") before merging.

## Secrets

`.env` (mode 0600, never committed) holds secrets only; `.env.example` lists every variable.
Every other setting lives in `config/*.toml`: `config/example.toml` shows each one at its default,
`config/dev.toml` is the local run. Load the secrets into the shell with `set -a; . ./.env; set +a`.
The RPC list line (`BUGNET_SOLANA_RPC_URLS`) holds no spaces, quotes or shell characters
(``& ; | < > ( ) $ ` \``), or the shell splits it, runs part of it or prints it.

Payments reaches Solana through its RPC router: `BUGNET_SOLANA_RPC_URLS` is an ordered list of URLs,
the first serving while it is healthy and the rest as fallbacks, with no provider named in code
(`docs/superpowers/specs/2026-11-10-rpc-router-design.md`, `deploy/README.md` section 6).

## Commands

| Command          | What it does                                                 |
| ---------------- | ------------------------------------------------------------ |
| `pnpm test`      | Unit and database tests (Postgres from `BUGNET_TEST_PG_URL`) |
| `pnpm typecheck` | `tsc` over `src` and `test`                                  |
| `pnpm lint`      | ESLint and Prettier check                                    |
| `pnpm dev`       | Runs the service with `config/dev.toml`                      |
| `pnpm cli`       | Operator CLI: keys, refunds, manual queue                    |
| `pnpm build`     | Bundles `dist/main.js`, `dist/cli.js` and `dist/checkout.js` |

## Live test

`pnpm test:live` pays a real order on mainnet with tiny amounts between our own wallets, then
redeems and refunds it. It fails up front, naming each missing variable, unless `.env` holds the
RPC URL, the fee-payer, refund and recipient keys, the order and claim keys, the payments token and
a test payer (key or mnemonic). Run it as `set -a; . ./.env; set +a; pnpm test:live`, with the RPC
list line free of spaces, quotes and shell characters, as above. `test/live/rpc-router.live.test.ts`
checks every URL of the list without moving money;
`pnpm test:live test/live/rpc-router.live.test.ts` runs it alone.
`test/live/deposit.live.test.ts` pays by sending to an order's address and also needs
`BUGNET_DEPOSIT_SEED`; `pnpm test:live test/live/deposit.live.test.ts` runs it alone.
