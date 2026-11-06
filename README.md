# bugnet-payments

Sells Bugnet orders for USDC on Solana mainnet through x402 v2 `exact`, settles them with our own
fee payer, issues router order tokens only to claim holders and refunds automatically.

## Setup

Needs Node 26, pnpm 12.6, `buf`, Postgres 18 and a `../bugnet-proto` checkout next to this one.

```sh
pnpm install   # @solana/pay-kit comes from vendor/, check it with: shasum -a 256 -c vendor/SHA256SUMS
pnpm proto     # generates src/gen from ../bugnet-proto
```

## Secrets

`.env` (mode 0600, never committed) holds secrets only; `.env.example` lists every variable.
Every other setting lives in `config/*.toml`: `config/example.toml` shows each one at its default,
`config/dev.toml` is the local run. Load the secrets into the shell with `set -a; . ./.env; set +a`.

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
a test payer (key or mnemonic). Run it as `set -a; . ./.env; set +a; pnpm test:live`.
