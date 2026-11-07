# Deploying bugnet-payments

Payments runs as one systemd service per installed version, `bugnet-payments@<version>`, on the
VPS next to the router (data-plane 15.1).

| What         | Where                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| Unix user    | `bugnet-payments` (system user, no shell, no home)                             |
| Code         | `/opt/bugnet/payments/<version>`, owned by root, read-only to the service      |
| Settings     | `/etc/bugnet/payments.toml`, `root:root 0644`, no secrets                      |
| Secrets      | `/etc/bugnet/payments.env`, `root:root 0600`, read by systemd, not the service |
| Database     | Postgres database `bugnet_payments`, role `bugnet_payments`, peer login only   |
| Internal API | `127.0.0.1:8447`: the gateway's `/v1/orders`, the router's `/v1/events`        |
| Public site  | `127.0.0.1:8450`: `pay.bugnet.sh` behind the TLS terminator (decision 11)      |
| Unit         | `deploy/bugnet-payments@.service`, copied to `/etc/systemd/system/`            |

8446 is the website's port, 8449 is kept for the later x402 signer.

## 1. User and code

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin bugnet-payments
```

Build in a checkout at the release commit, with `../bugnet-proto` next to it (`pnpm build` runs
`pnpm proto`):

```sh
pnpm install --frozen-lockfile
pnpm build    # dist/main.js, dist/cli.js, dist/checkout.js
v=$(git rev-parse --short HEAD)
tar czf "bugnet-payments-$v.tgz" dist migrations config vendor deploy \
    package.json pnpm-lock.yaml pnpm-workspace.yaml
```

The install directory needs all of these: `dist/main.js` and `dist/cli.js` keep their packages
external, so they need `node_modules/`; `pnpm install` needs `vendor/` (pay-kit) and the lockfile;
the service reads `migrations/` at start and serves `dist/checkout.js`, both relative to its
working directory; `config/` holds `example.toml`, every setting at its default; `deploy/` holds
the unit and these notes. On the server, with Node 26 at `/usr/bin/node` and pnpm 12.6:

```sh
sudo mkdir -p "/opt/bugnet/payments/$v"
sudo tar xzf "bugnet-payments-$v.tgz" -C "/opt/bugnet/payments/$v"
cd "/opt/bugnet/payments/$v" && sudo pnpm install --prod --frozen-lockfile
sudo cp deploy/bugnet-payments@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## 2. Settings: `/etc/bugnet/payments.toml`

Only what differs from the defaults in `config/example.toml`:

```toml
[database]
url = "postgres://bugnet_payments@/bugnet_payments?host=/var/run/postgresql"

[solana]
recipient = "<cold recipient address>"

[router]
url = "http://127.0.0.1:8080"
get_order = true                     # router Task 8 serves GetOrder
check_payer = false                  # true once router Task 28 serves CheckPayer
event_public_key = "<see section 5>"
```

The listeners keep their defaults, `127.0.0.1:8447` and `127.0.0.1:8450`, and `public_url` stays
`https://pay.bugnet.sh`. The database URL names the role because the service's Unix user,
`bugnet-payments`, is not a role name.

## 3. Secrets: `/etc/bugnet/payments.env`

`root:root 0600`, holding only the production secrets of `.env.example`, never the test ones
(`BUGNET_TEST_*`, `BUGNET_RECIPIENT_KEY`, `BUGNET_TEST_PG_URL`):

systemd keeps a `# comment` written after a value as part of that value, so every comment sits
on its own line:

```sh
# Shared with the gateway, which sends it as a bearer token
BUGNET_PAYMENTS_TOKEN=
# Shared with the router (section 5)
BUGNET_PAYMENTS_ROUTER_TOKEN=
# openssl rand -base64 32
BUGNET_ORDER_PRIVATE_KEY=
# openssl rand -base64 32
BUGNET_CLAIM_KEY=
# base58 of the fee payer's 64-byte secret key
BUGNET_FEE_PAYER_KEY=
# base58 of the refund wallet's 64-byte secret key
BUGNET_REFUND_KEY=
# Section 6
BUGNET_SOLANA_RPC_URL=
```

```sh
sudo install -o root -g root -m 0600 /dev/null /etc/bugnet/payments.env
sudoedit /etc/bugnet/payments.env
```

## 4. Postgres

```sh
sudo -u postgres createuser bugnet_payments
sudo -u postgres createdb --owner bugnet_payments bugnet_payments
```

Add one line to `pg_hba.conf`, next to the router's, and one to `pg_ident.conf`, then
`sudo systemctl reload postgresql`:

```text
# pg_hba.conf
local   bugnet_payments   bugnet_payments   peer map=bugnet

# pg_ident.conf
bugnet   bugnet-payments   bugnet_payments
```

Peer login compares the Unix user with the role, so `local bugnet_payments bugnet_payments peer`
alone would refuse `bugnet-payments`; the router's `bugnet` map gives that one user that one role.
The service creates its tables itself at start (`migrations/`).

Data-plane 15.1's rule that only `bugnet-router` opens the Postgres socket gains this one
exception. The deploy check of 15.3 gains an entry next to the router's, which fails the deploy
if any other user reaches `bugnet_payments`, if Payments reaches the router's database, or if
Payments cannot reach its own:

```sh
for u in haproxy bugnet-edge bugnet-secrets bugnet-certs bugnet-ssh bugnet-egress bugnet-router \
    bugnet-website $GATEWAY_USERS; do
  sudo -u "$u" psql -h /var/run/postgresql -U bugnet_payments -d bugnet_payments \
      -c 'select 1' && exit 1
done
sudo -u bugnet-payments psql -h /var/run/postgresql -U bugnet_router -d bugnet \
    -c 'select 1' && exit 1
psql -h 127.0.0.1 -U bugnet_payments -d bugnet_payments -c 'select 1' && exit 1
sudo -u bugnet-payments psql -h /var/run/postgresql -U bugnet_payments -d bugnet_payments \
    -c 'select 1' || exit 1
```

## 5. Router handover

Run the `pnpm cli` commands in a checkout whose `.env` holds the production keys, after
`set -a; . ./.env; set +a`.

- Router `order_token_public_key` = the output of `pnpm cli keys pubkey`.
- Router `events_url = "http://127.0.0.1:8447/v1/events"`.
- Payments `router.event_public_key` = the output of
  `go run ./cmd/bugnet-dev pubkey --priv "$BUGNET_EVENT_SIGNING_KEY"` in bugnet-router, with the
  router's environment loaded.
- `BUGNET_PAYMENTS_ROUTER_TOKEN` is shared with the router session's new variable: the same name
  and value in both environments (`bugnet-dev keys` prints one).
- Once the router ships it, router
  `wallets.facilitator_addresses = ["<fee_payer address from pnpm cli keys show>"]`, so the router
  never counts our fee payer as a user. Not before: the router refuses unknown TOML keys and would
  not start.
- `router.get_order` is true, since the router serves GetOrder. Flip `router.check_payer` to true
  only after the router ships CheckPayer (router Task 28).

## 6. RPC

A Helius free plan: sign up at https://dashboard.helius.dev/signup?plan=free, then set
`BUGNET_SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<KEY>`. The URL carries the key, so
it lives only in the secrets file and the logs redact it.

## 7. Wallets

- **Fee payer:** 0.3-0.5 SOL. Boot refuses below `solana.fee_payer_boot_min_lamports` (0.1 SOL by
  default) and alarms fire below `alarms.fee_payer_min_lamports`.
- **Refund wallet:** a $25-50 USDC float. Its USDC account must exist while refunds are on
  (`pnpm cli keys fund --create-refund-ata`).
- **Recipient:** a cold address whose USDC account exists
  (`pnpm cli keys fund --create-recipient-ata`). Its key never sits on the server.

## 8. Start, check, upgrade

```sh
sudo systemctl enable --now "bugnet-payments@$v"
curl -fsS http://127.0.0.1:8447/healthz
curl -fsS http://127.0.0.1:8450/healthz
journalctl -u "bugnet-payments@$v" -o cat | grep '"level":"alarm"'
```

Logs are one JSON line each on stderr, in the journal. A failed boot check is one line,
`"msg":"boot check failed"`, whose `reason` names the fix; the unit restarts every 2 s, so it
comes up by itself once the cause is fixed. Two versions bind the same ports, so an upgrade stops
the old one first: `sudo systemctl disable --now bugnet-payments@<old>`, then enable the new one.
Stopping lets running jobs finish, then closes the listeners and the database pool.

Operator commands run as the service user, with the deploy settings:

```sh
cd "/opt/bugnet/payments/$v"
sudo -u bugnet-payments node dist/cli.js -config /etc/bugnet/payments.toml manual list
```

## 9. Open decision 11 (founder, question 14): TLS for `pay.bugnet.sh`

Both listeners serve plain HTTP on loopback today.

- **A:** a local TLS terminator (Caddy, or HAProxy `mode http`) behind a `names.toml` split, which
  proxies to `127.0.0.1:8450` and sets `X-Forwarded-For`.
- **B:** in-process TLS with ACME and PROXY v2, as the gateway front does.

Either also needs a DNS record. **Recommendation: A**, because it keeps ACME and TLS parsing out
of the process that holds the fee-payer key. Task 26 has a pre-TLS variant. The founder approved A
on 2026-11-06; what remains is the `pay.bugnet.sh` line in `names.toml` (data-plane 15.2), the
terminator itself and the DNS record.
