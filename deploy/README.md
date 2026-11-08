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
| x402 signer  | `127.0.0.1:8449`: mTLS, loopback only, no HAProxy rule (section 10)            |

8446 is the website's port, 8449 is the x402 signer.

## 1. User and code

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin bugnet-payments
```

Build in a checkout at the release commit, with `../bugnet-proto` next to it (`pnpm build` runs
`pnpm proto`):

```sh
pnpm install --frozen-lockfile
pnpm build    # dist/main.js, dist/cli.js, dist/checkout.js, dist/fonts/
v=$(git rev-parse --short HEAD)
tar czf "bugnet-payments-$v.tgz" dist migrations config vendor deploy \
    package.json pnpm-lock.yaml pnpm-workspace.yaml
```

The install directory needs all of these: `dist/main.js` and `dist/cli.js` keep their packages
external, so they need `node_modules/`; `pnpm install` needs `vendor/` (pay-kit) and the lockfile;
the service reads `migrations/` at start and serves `dist/checkout.js` and `dist/fonts/`, all
relative to its working directory; `config/` holds `example.toml`, every setting at its default;
`deploy/` holds the unit and these notes. On the server, with Node 26 at `/usr/bin/node` and
pnpm 12.6:

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
`bugnet-payments`, is not a role name. `router.url` must be https unless its host is loopback,
since every router call carries `BUGNET_PAYMENTS_ROUTER_TOKEN`.

Boot logs a warn line while `orders.max_amount_micros` (100 USDC by default) is above
`refunds.daily_cap_micros` (20 USDC by default): a refund above the cap always goes to the manual
queue as `refund_exceeds_cap`. Set the cap at or above the largest package price to refund every
order automatically.

## 3. Secrets: `/etc/bugnet/payments.env`

`root:root 0600`, holding only the production secrets of `.env.example`, never the test ones
(`BUGNET_TEST_*`, `BUGNET_RECIPIENT_KEY`, `BUGNET_TEST_PG_URL`):

systemd keeps a `# comment` written after a value as part of that value, so every comment sits
on its own line:

```sh
# Shared with the gateway, which sends it as a bearer token, at least 32 characters
BUGNET_PAYMENTS_TOKEN=
# Shared with the router (section 5), at least 32 characters
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
BUGNET_ALLOWANCE_KEY=
BUGNET_X402_TLS_KEY=
```

```sh
sudo install -o root -g root -m 0600 /dev/null /etc/bugnet/payments.env
sudoedit /etc/bugnet/payments.env
```

Boot refuses a `BUGNET_PAYMENTS_TOKEN` shorter than 32 characters, and a shorter
`BUGNET_PAYMENTS_ROUTER_TOKEN` whenever it is set (it is required while `router.get_order` or
`router.check_payer` is on, or `[x402] allowance_wallet` is set); `openssl rand -base64 32` makes
one of 44.

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
exception. The router runs as the Unix user `bugnet-router` (15.1) with the role `bugnet_router`
and the database `bugnet` (15.3).

**Check after setup, and after every deploy.** Neither service may read the other's data. Run
this as root once both databases exist; it exits 1 if any login it expects to fail succeeds, or
fails for a reason other than Postgres refusing it (Postgres down, a missing socket), and exits 1
if Payments cannot open its own database. The deploy check of 15.3 runs it next to the router's
entry:

```sh
# The login must fail because Postgres or the socket refuses it, never because nothing listens
refused() {
  out=$(sudo -u "$1" psql -h /var/run/postgresql -U "$2" -d "$3" -c 'select 1' 2>&1) && exit 1
  printf '%s\n' "$out" |
    grep -Eiq 'no pg_hba.conf entry|peer authentication failed|permission denied' || exit 1
}
# Payments cannot open the router's database, under its own role or the router's
refused bugnet-payments bugnet_payments bugnet
refused bugnet-payments bugnet_router bugnet
# The router cannot open bugnet_payments, under its own role or Payments'
refused bugnet-router bugnet_router bugnet_payments
refused bugnet-router bugnet_payments bugnet_payments
# No other user reaches bugnet_payments
for u in haproxy bugnet-edge bugnet-secrets bugnet-certs bugnet-ssh bugnet-egress \
    bugnet-website $GATEWAY_USERS; do
  refused "$u" bugnet_payments bugnet_payments
done
psql -h 127.0.0.1 -U bugnet_payments -d bugnet_payments -c 'select 1' && exit 1
sudo -u bugnet-payments psql -h /var/run/postgresql -U bugnet_payments -d bugnet_payments \
    -c 'select 1' || exit 1
```

Each refused login prints `no pg_hba.conf entry for host "[local]", user ..., database ...` or
`Peer authentication failed for user ...`: the `pg_hba.conf` and `pg_ident.conf` lines let each
Unix user reach only its own role and database.

## 5. Router handover

Run the `pnpm cli` commands in a checkout whose `.env` holds the production keys, after
`set -a; . ./.env; set +a`.

- Router `order_token_public_key` = the output of `pnpm cli keys pubkey`.
- Router `events_url = "http://127.0.0.1:8447/v1/events"`.
- Payments `router.event_public_key` = the output of
  `go run ./cmd/bugnet-dev pubkey --priv "$BUGNET_EVENT_SIGNING_KEY"` in bugnet-router, with the
  router's environment loaded. Dev only: the key appears in argv and shell history; use
  `pubkey --event` once router Task 39 ships.
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
  (`pnpm cli keys fund --create-recipient-ata <recipient address>`, which prints the owner whose
  account it creates). Its key never sits on the server.

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

Operator commands that read the database (`manual`, `refunds`, `x402`, `keys drain --allowance`)
run as the service user, with the deploy settings and the secrets file (`x402 ledger-check`,
`manual retry` and `x402 status`'s chain balance need `BUGNET_SOLANA_RPC_URL`). Define `pcli` once
per shell, in the install directory:

```sh
cd "/opt/bugnet/payments/$v"
pcli() {
    sudo sh -c 'set -a; . /etc/bugnet/payments.env; [ -z "$0" ] || . "$0"; set +a
        exec setpriv --reuid=bugnet-payments --regid=bugnet-payments --init-groups \
            node dist/cli.js -config /etc/bugnet/payments.toml "$@"' "${PCLI_ENV:-}" "$@"
}
pcli manual list
```

Every `pcli` command in these notes and in `x402-mainnet-tests.md` means this function. Never use
`pnpm cli` for them: without `-config` it opens `config/dev.toml`, the dev database, and the
install directory has no `src/` for it to run. `PCLI_ENV=<absolute path>` sources one more env
file after the secrets file, for `keys drain --allowance`, which also needs `BUGNET_TEST_PAYER_KEY`
(a `0600` file, deleted afterwards).

## 9. Open decision 11 (founder, question 14): TLS for `pay.bugnet.sh`

Both listeners serve plain HTTP on loopback today.

- **A:** a local TLS terminator (Caddy, or HAProxy `mode http`) behind a `names.toml` split, which
  proxies to `127.0.0.1:8450` and sets `X-Forwarded-For`.
- **B:** in-process TLS with ACME and PROXY v2, as the gateway front does.

Either also needs a DNS record. **Recommendation: A**, because it keeps ACME and TLS parsing out
of the process that holds the fee-payer key. Task 26 has a pre-TLS variant. The founder approved A
on 2026-11-06; what remains is the `pay.bugnet.sh` line in `names.toml` (data-plane 15.2), the
terminator itself and the DNS record.

What the terminator must do, because Payments limits requests per client address:

- **Take HAProxy's PROXY v2 header itself.** The SNI split's `pay.bugnet.sh` backend points at
  the terminator with `send-proxy-v2`, never at `127.0.0.1:8450`. The header ends at the
  terminator, which reads the client address from it (Caddy: the `proxy_protocol` listener
  wrapper, allowing `127.0.0.1/32`; HAProxy `mode http`: `accept-proxy` on its `bind`). Payments'
  public listener speaks plain HTTP and never sees a PROXY header.
- **Set `X-Forwarded-For` to that client address, as its last entry.** Caddy's `reverse_proxy`
  does this by default; HAProxy needs `option forwardfor`. Payments takes the last entry, and only
  from a peer in `http.trusted_proxies`. Without the header, every visitor shares the terminator's
  address and one per-IP limit (60 requests a minute by default).
- **Connect from loopback**, so `http.trusted_proxies` keeps its default
  `["127.0.0.1", "::1"]`. If the terminator connects from another address, list exactly that
  address and nothing a client can reach Payments from directly, or a client could choose its own
  rate-limit key.
- **The stats page.** The website's Caddy routes `bugnet.sh/api/stats/payments*` to
  `127.0.0.1:8450`, before `bugnet.sh/api/stats*` to the router (data-plane 15.x, bugnet-d7).

## 10. x402 signer

Payments signs the payments that sandboxes make to x402 sellers, from its own allowance wallet.
Nothing here runs while `[x402] allowance_wallet` is empty.

**Files and modes.**

| File                                   | Mode                               | Holds                                                                                                            |
| -------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/etc/bugnet/internal-ca.pem`          | `0644`                             | The client CA that signed egress's certificate                                                                   |
| `/etc/bugnet/payments/x402-server.pem` | `0644`, owned by `bugnet-payments` | Payments' server certificate, named `bugnet-payments.internal`                                                   |
| `/etc/bugnet/payments/x402-index.json` | `0644`, owned by `bugnet-payments` | The indexed-services copy                                                                                        |
| `/etc/bugnet/payments.env`             | `root:root 0600`                   | `BUGNET_ALLOWANCE_KEY` and `BUGNET_X402_TLS_KEY` (the server certificate's private key, PEM, base64 on one line) |

**Listener.** `[x402] listen` is `127.0.0.1:8449`: loopback, TLS 1.3, a client certificate named
`bugnet-egress.internal` required. HAProxy has no rule for it. Because two processes cannot share
the port, a deploy stops the old process before it starts the new one; egress answers
`payments_unavailable` meanwhile and `signed` rows resolve from the chain. The jobs run under
database locks, so a second process never runs the same job twice.

**The allowance wallet**, once:

1. `pnpm cli keys generate`, and put the key it prints in `BUGNET_ALLOWANCE_KEY`.
2. Set `[x402] allowance_wallet` to its address.
3. `pnpm cli keys fund --create-allowance-ata` creates its USDC account.
4. Restart. Boot refuses an allowance wallet that is also another Bugnet wallet.

**The index copy**, whenever the indexed services change, in this order (5.1, 7.16): write
Payments' `x402-index.json`; run `sudo systemctl kill -s HUP bugnet-payments@<version>` (the unit
has no `ExecReload`, so `systemctl reload` does not work); then the router's
`allowed_shared_hosts`; then the gateway release. A bad file keeps the old copy and fires
`x402_reload_failed`.

**Certificate renewal.** On the Mac that keeps the CA key: `bugnet-dev mtls init --renew --from
<the two certificate files>`. Copy the two `.pem` files to the VPS, then run the same `sudo
systemctl kill -s HUP bugnet-payments@<version>` (and for the router's service). `x402_cert_expiry`
fires `cert_expiry_alarm_before` ahead of the served certificate's expiry. Until the `SIGHUP`, the
TLS check and the expiry alarm keep reading the copy loaded before, and after 10 minutes of a disk
copy that differs from it, `x402_reload_failed` fires.

**The router.** Set `[router] allowance_claim = true` only after router Task 28 is live: until
then the router cannot take the placement claim, and allowance orders must stay refused.

**Timeouts.** Egress's `payments_timeout` (3 s) must stay above `[x402] sign_timeout` (2 s), or
egress gives up on a signature that is still being made. Check both at every deploy.

**Database.** `[database] pool_max` sizes the connection pool; each running x402 job holds one
connection for its lock, so keep it above the number of jobs plus the request load.

## 11. x402 incidents and alarms

An incident writes one `x402_incidents` row (its facts in `detail`; one open row per kind and
subject), pauses seller payments, new allowance orders and transfers to cold, and fires `x402_incident` with its kind.
Payments repairs none of them by itself, and `pcli x402 resume` exits 1 while one is
unresolved.

| Kind                    | Found by                                                                     |
| ----------------------- | ---------------------------------------------------------------------------- |
| `balance_mismatch`      | A balance difference with no backlog for `balance_mismatch_after`            |
| `mirror_gap`            | A transaction Payments made still missing past the rescan                    |
| `balance_short`         | The chain balance under the liabilities at a verified slot                   |
| `unknown_change`        | A transaction that changes the hot account and matches nothing               |
| `token_account_changed` | Live check 5 failing on an answer: owner, delegate, close authority or state |
| `late_landing`          | A payment found after it expired                                             |
| `double_transfer`       | Two landed transactions for one refund or transfer                           |

**The runbook.** `pcli x402 status` and `pcli x402 incident list` show every fact needed.

1. Read the incident and its transaction on an explorer. `balance_mismatch` or `mirror_gap` with
   `x402_tail_lag` firing is usually an RPC whose history lags: point `BUGNET_SOLANA_RPC_URL` at a
   provider with complete history, restart, and once the mirror verifies go to step 5.
2. Otherwise, or if unsure: `pcli x402 kill`. For a suspected key leak, also hold refunds:
   `pcli x402 refunds hold` (the operator's only refund hold).
3. Cover any loss: send Bugnet's own USDC from the cold recipient to the hot USDC account, the sum
   of the open incidents' `loss_micros`. The mirror records it as an unmatched inflow; refunds that
   went to the manual queue for a short balance can then be retried with `pcli manual retry`.
4. A leaked key is replaced only once the hot ledger is empty: keep the kill on and let sandboxes
   end. With refunds held, their hot refunds stay `pending`: pay each by hand from the cold
   recipient and record it with `pcli manual resolve <refundId> --tx`, which takes a `pending`
   row while held. Without a hold, let them confirm and do the same for any that go `manual`.
   Then run `PCLI_ENV=<test payer env file> pcli keys drain --allowance` (section 8), make a new
   key (`pnpm cli keys generate` with `BUGNET_ALLOWANCE_KEY` cleared), set
   `[x402] allowance_wallet`, run `pnpm cli keys fund --create-allowance-ata`, and restart (boot
   check 4 opens the new tail).
5. `pcli x402 incident resolve <id> <finding>`, then `pcli x402 refunds release`,
   `pcli x402 unkill` and `pcli x402 resume` as they apply.

**Operator commands**, each acting on the database row read on every call, so no restart is
needed: `pcli x402 pause <reason>`, `resume`, `kill`, `unkill`, `block-payto <address>
<reason>`, `unblock-payto <address>`, `service reset <account> <serviceId>` (back to `enabled`,
`failures` 0), `refunds hold|release`, `incident list`, `incident resolve <id> <finding>`, and
`status` (controls, pool, liabilities, chain balance, `verified_slot` lag, open and closing
accounts, `signed` rows past `unresolved_alarm_after` with `signed_at`, `signing_slot` and
`last_valid_block_height`, pending events, open incidents). All of them are `pcli x402 ...`.

**Alarms.** Log lines with `"level":"alarm"`.

| Alarm                       | When                                                                                                                             | Operator's action                                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x402_incident`             | An incident was written, with its kind                                                                                           | Payments is paused; follow the runbook above                                                                                                                                                                           |
| `x402_outflow_cap`          | Seller payments of the UTC day reached `outflow_daily_cap_micros`                                                                | None; it lifts at 00:00 UTC. If one payee took most of it, `pcli x402 block-payto`                                                                                                                                     |
| `x402_unresolved`           | A `signed` row unresolved `unresolved_alarm_after` after signing                                                                 | `pcli x402 status` shows its `signed_at`, `signing_slot` and `last_valid_block_height`; read the hot account's history on an explorer for the next 2 minutes; check `x402_tail_lag` and the RPC. Never release by hand |
| `x402_tail_lag`             | `verified_slot` more than `tail_lag_alarm_after` behind                                                                          | Check RPC health and credits; look for a dust flood in `x402_chain_txs`                                                                                                                                                |
| `x402_rpc_budget`           | RPC calls in an hour passed `rpc_calls_per_hour_alarm`                                                                           | Look for a dust flood or a loop; a paid RPC plan if it is real traffic                                                                                                                                                 |
| `x402_ref_conflict`         | A repeated `ref` or a `ReportOutcome` `ref` did not match its row                                                                | Check egress for a bug or a compromise; `pcli x402 kill` if it repeats                                                                                                                                                 |
| `x402_refund_budget`        | Hot refunds passed `refund_daily_cap_micros`                                                                                     | Review the manual queue; `pcli manual retry` each after checking                                                                                                                                                       |
| `x402_pool_high`            | Allowance money held passed `pool_high_alarm_percent` of `pool_max_micros`                                                       | Look for a burst of unpaid orders from one client; raising the $50 is the founder's call                                                                                                                               |
| `x402_pool_drift`           | The audit's `committed_micros` differs from the stored one                                                                       | Find the cause before correcting the row                                                                                                                                                                               |
| `x402_audit_mismatch`       | The audit found a confirmed row missing on chain, or the balance off its sum                                                     | Find the row before correcting anything; `pcli x402 pause audit` if money is unaccounted for                                                                                                                           |
| `x402_cert_expiry`          | Payments' server certificate, the client CA, or the client certificate egress presents expires within `cert_expiry_alarm_before` | On the Mac that keeps the CA key, run `bugnet-dev mtls init --renew --from <the two certificate files>`, copy the two `.pem` files to the VPS, then `systemctl kill -s HUP` both services                              |
| `x402_reload_failed`        | An index or certificate reload was rejected, or the TLS files on disk have differed from the served ones for over 10 minutes     | Fix the file and send `SIGHUP` again; for a renewal copied without one, send `SIGHUP`                                                                                                                                  |
| `x402_payee_unreliable`     | A service was marked unreliable                                                                                                  | Read the seller's hints; `block-payto` if dishonest, else `pcli x402 service reset`                                                                                                                                    |
| `x402_signer_down`          | A live check keeps the listener closed                                                                                           | Read the logged check; fix the RPC or the certificate                                                                                                                                                                  |
| `x402_events_stuck`         | The oldest pending router event of a redeemed order is older than `events_stuck_alarm_after`                                     | Check the router; rows retry by themselves                                                                                                                                                                             |
| `x402_event_dropped`        | The router answered `ORDER_UNKNOWN` to an `x402_resolved`                                                                        | Check whether the start order ever reached `CreatePlacement`; nothing to resend                                                                                                                                        |
| `x402_event_refused`        | The router refused an event as `InvalidArgument`                                                                                 | A bug in Payments or the router; fix and backfill by hand                                                                                                                                                              |
| `x402_close_slow`           | An account `closing` longer than `close_slow_alarm_after`                                                                        | Find its `signed` rows; check the mirror                                                                                                                                                                               |
| `x402_close_unverifiable`   | The close check could not reach the router for `close_unverifiable_after`                                                        | Check the router                                                                                                                                                                                                       |
| `x402_resign_waiting`       | A hot refund or transfer waited for the re-sign proof past `resign_wait_alarm_after`                                             | Check `x402_tail_lag`; if the RPC's history is incomplete, switch `BUGNET_SOLANA_RPC_URL` and restart                                                                                                                  |
| `x402_cold_transfer_failed` | A transfer to cold became `failed`                                                                                               | None needed: its parts go in the next one. If it repeats, check the cold recipient's USDC account                                                                                                                      |

Hot refunds that go manual fire the existing `manual_queue`; unmatched inflows of $0.01 or more
and late order inflows fire the existing `inflow_mismatch`.
