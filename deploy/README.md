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
# On macOS, without these tar adds hidden ._ metadata files that unpack on Linux as real files
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "bugnet-payments-$v.tgz" \
    dist migrations config vendor patches deploy package.json pnpm-lock.yaml pnpm-workspace.yaml
tar tzf "bugnet-payments-$v.tgz" | grep -c '/\._\|^\._' # must print 0
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

**Deposits** (paying by sending USDC to a per-order address; design
`docs/superpowers/specs/2026-11-10-direct-transfer-design.md`). The install step adds, once:

```toml
[deposits]
enabled = false
```

`vps-install.sh --deposits on|off` changes `enabled` (section 8) and `--rotate-deposit-seed`
changes `seed_version` (section 12); nobody edits either by hand. `enabled` only decides whether
new pages get an address: deposits that exist are watched and finish either way. Every other
`[deposits]` key keeps its default from `config/example.toml`, which lists each with its meaning:

- pacing: `busy_every` 2 s, `idle_every` 20 s, `closed_every` 120 s;
- deadlines: `settle_grace` 60 s after the order's deadline, then the hard stop
  `expire_hard_after` 5 min, waiting at most `expire_hard_max` 30 min for a scan that is catching
  up; `watch_after_close` 24 h for late money;
- Bugnet-paid rent: `max_open` 500 open accounts (about 1.02 SOL, returned at the closes),
  `rented_per_ip` 1 per IPv4 address or IPv6 /64, `rented_per_block` 2 per /48;
- budgets: `unpaid_create_lamports_per_hour` 1,000,000, `free_moves_lamports_per_hour`
  2,000,000, `returns_per_owner_per_hour` 6, `max_late_returns` 2;
- `refund_min_micros` 1,000: smaller leftovers, review money and split parts are kept, not sent;
- the job's own RPC caps: `rpc_calls_per_second` 3 (at most 5), `rpc_calls_per_day` 30,000,
  `rpc_calls_per_hour_alarm` 6,000.

`[limits]` gains `balance_per_ip_per_minute` (20, the page's balance route),
`balance_rpc_per_minute` (30, that route's RPC reads across all clients),
`report_per_ip_per_minute` (10, the page's error report) and `ipv6_block_multiple` (4). Every
per-IP limit keys an IPv6 client by its /64, and the /48 around it gets 4 times that limit.

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
# Shared with the gateway, which sends it as a bearer token: copied by deploy/push-payments-token.sh
BUGNET_PAYMENTS_TOKEN=
# Shared with the router (section 5), at least 32 characters
BUGNET_PAYMENTS_ROUTER_TOKEN=
# Made by the install step; never pasted
BUGNET_ORDER_PRIVATE_KEY=
# Made by the install step; never pasted
BUGNET_CLAIM_KEY=
# base58 of the fee payer's 64-byte secret key
BUGNET_FEE_PAYER_KEY=
# base58 of the refund wallet's 64-byte secret key
BUGNET_REFUND_KEY=
# Section 6: copied by deploy/push-rpc-urls.sh, never edited here
BUGNET_SOLANA_RPC_URLS=
# Section 6: read only while the list is unset; kept for a rollback (section 8)
BUGNET_SOLANA_RPC_URL=
BUGNET_ALLOWANCE_KEY=
BUGNET_X402_TLS_KEY=
# Made by the install step; never pasted
BUGNET_DEPOSIT_SEED=
# Set only while a seed rotation drains (section 12)
BUGNET_DEPOSIT_SEED_PREVIOUS=
```

Nobody edits this file by hand. The install step (`vps-install.sh <tarball>`) makes it and runs
the new release's `keys generate` on it, which adds `BUGNET_ORDER_PRIVATE_KEY`,
`BUGNET_CLAIM_KEY` and `BUGNET_DEPOSIT_SEED` (32 random bytes each, base64) when they are missing,
as it does for the wallet keys, and never replaces one that is set. With each deposit's salt in the
database, `BUGNET_DEPOSIT_SEED` derives every deposit address (section 12).

`BUGNET_PAYMENTS_TOKEN` is the one value the gateway shares, so the install step's random one is
replaced by the line in the local `bugnet-payments/.env`. On the Mac, in `bugnet-payments`:

```sh
deploy/push-payments-token.sh [ssh options] HOST
```

It sends only that line, through a pipe, to `vps-install.sh --payments-token`, which replaces the
line by an atomic rename and prints only `BUGNET_PAYMENTS_TOKEN set in /etc/bugnet/payments.env`.
Both ends refuse a value shorter than 32 characters or holding anything but letters, digits and
`+ / = _ . -`, and the server refuses one equal to `BUGNET_PAYMENTS_ROUTER_TOKEN`.
`openssl rand -base64 32` makes one of 44. A running version loads it at the next `--start`. Boot
refuses a `BUGNET_PAYMENTS_ROUTER_TOKEN` shorter than 32 characters whenever it is set (it is
required while `router.get_order` or `router.check_payer` is on, or `[x402] allowance_wallet` is
set).

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

Payments reaches Solana through its RPC router: a list of RPC URLs, in priority order. Each
request goes to the first URL that is healthy, and the others are fallbacks in order. The router
names no provider; every URL follows the same rules (design:
`docs/superpowers/specs/2026-11-10-rpc-router-design.md`).

**The list.** One line, pasted only into the local `bugnet-payments/.env`:

```
BUGNET_SOLANA_RPC_URLS=<rpc1 URL>,<rpc2 URL>,<rpc3 URL>
```

Copy it to the server with `deploy/push-rpc-urls.sh [ssh options] HOST`. It sends only that line,
through a pipe, to `vps-install.sh --rpc-urls`.
Nobody edits `/etc/bugnet/payments.env` by hand. `rpc1` is the first URL in every log, alarm and
`pcli` line. The single `BUGNET_SOLANA_RPC_URL` is read only while the list is unset or blank,
and stays for a rollback to a release without the router; from the deposits release on, such a
rollback first needs `vps-install.sh --deposits remove` (section 8).

- No spaces, quotes, comment or shell character on the line: `pcli` and the install script load
  the file with the shell, which would split the line and print part of it. A comma inside a URL
  is written `%2C`.
- Each URL is https (no user or password), with no duplicates, at most 6 URLs.
- What the list needs:
    - URLs on two domains whose endpoints keep full history and answer consistently: the "not
      found" quorum of 2, which re-signs and reverts need;
    - a first URL that can take the steady load, since it takes every request while healthy;
    - endpoints that refuse an unreachable `minContextSlot`, for the pinned listings deposits use.
- Local runs use the same keys, so they count against the same daily caps.
- No TOML change is needed: every `[solana.rpc]` knob has a default, listed with its meaning in
  `config/example.toml` (absence quorum 2 with two domains, one copy of each send to a second
  domain).
- An endpoint whose answers disagree with themselves loses its "not found" vote and its listings
  until a check run an hour later passes, also across restarts. While fewer than two domains can
  vote, re-signs and reverts wait.
- On a `pcli rpc probe` line, `genesis: error http_400` means the URL is malformed or the plan
  does not serve Solana; `http_403` means a bad key or a blocked IP. Both name the position only.

**After changing the list:** copy it, run `pcli rpc probe`, then `vps-install.sh --start`, which
restarts a running service so it loads the new list. The probe must exit 0 with
`quorum: 2 of 2 domains ready`. For deposits it must also name two endpoints on `listings:`, which
`vps-install.sh --deposits on` checks (section 8). After the first day, post the day's failed
attempts per position, method and outcome; `pcli rpc status --outcomes` shows the current UTC hour
only, so the day comes from the journal:

```sh
journalctl -u "bugnet-payments@$v" --since -24h -o cat | grep '"msg":"rpc attempt failed"' \
    | grep -o '"endpoint":"rpc[0-9]*","method":"[^"]*","outcome":"[^"]*"' | sort | uniq -c
```

The mainnet smoke test checks a list without moving money, and runs only with the founder's go:
`set -a; . ./.env; set +a; pnpm test:live test/live/rpc-router.live.test.ts` on the Mac. It prints
the probe's lines, each URL's 2021 history note and its `minContextSlot` with `until` answer, by
position, passes by the probe's exit rule, and spends at most 10 + 30 calls per URL.

**Deposits.** The deposit job reaches Solana only through the router, on its two lanes:

- the money lane: its moves (create, sweep, return, close), the settle step and the proof before a
  move is signed again;
- the background lane: everything else, that is its balance reads, the reads pinned past a
  deadline, the history scans, and the page's balance route.

Its scans are pinned listings, which go only to the endpoints on the probe's `listings:` line. On
top of the router's own limits, the job counts its calls: at most `[deposits]
rpc_calls_per_second` (3) a second and `rpc_calls_per_day` (30,000) a day, moves left out. Past
80 % of the day a page that is only watched no longer speeds the job up; past 100 % scans run only
for unpaid orders still within their deadline and for the proofs moves need, and reads keep the
idle pace. Moves and settles are never held back. `deposit_rpc_budget` fires at 80 % and 100 % and
when an hour passes `rpc_calls_per_hour_alarm` (section 12).

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
`"msg":"boot check failed"`, whose `reason` names the fix; the unit restarts after 2 s, then
slower each time up to every 5 minutes (each start calls every RPC URL), so it comes up by itself
within 5 minutes once the cause is fixed, or at once with `sudo systemctl restart`. Two versions
bind the same ports, so an upgrade stops the old one first:
`sudo systemctl disable --now bugnet-payments@<old>`, then enable the new one.
Stopping lets running jobs finish, then closes the listeners and the database pool.

Operator commands that read the database (`manual`, `refunds`, `x402`, `keys drain --allowance`)
run as the service user, with the deploy settings and the secrets file (`x402 ledger-check`,
`manual retry`, `x402 status`'s chain balance and `rpc probe` need `BUGNET_SOLANA_RPC_URLS`, or
`BUGNET_SOLANA_RPC_URL`). `pcli rpc status` shows each endpoint's health from the service's
snapshot; `pcli rpc probe` checks every endpoint now. Define `pcli` once per shell, in the install
directory:

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

**Deposits.** `vps-install.sh` here is the installed release's `deploy/vps-install.sh`, run as
root. No step comes before the install: the install step generates `BUGNET_DEPOSIT_SEED` and, once,
adds `[deposits] enabled = false` to `payments.toml`, and `--start` checks the seed like the other
keys.

Releases without deposits decode `payments.toml` strictly: with `[deposits]` in it, their boot
check fails with a `reason` ending `unknown key deposits`, and every restart fails the same way. So
from this release's install step on:

- run `--start` right after the install step. Until then the older version still runs, but a
  crash or a reboot leaves it unable to start. `--start` stops it and starts this release;
- a rollback to a release without deposits first needs `vps-install.sh --deposits remove`
  (below).

**Rollback below the deposits release.** Run `vps-install.sh --deposits off` first, then:

1. `vps-install.sh --deposits remove`. It asks the database through `pcli deposits list` and
   refuses while deposits are on, any deposit is `open`, `settling` or `draining`, or any deposit
   has a move in flight (`pcli deposits list --moving`), since the older release watches none of
   them. Otherwise it removes `[deposits]` from `payments.toml` by an atomic rename and restarts
   nothing. When it refuses, wait for those deposits to finish and run it again.
2. At once, the older release's own `deploy/vps-install.sh` with its tarball, then its `--start`
   (this release's install step would add `[deposits]` back). Until then this release must not
   restart: it reads the missing section as deposits on. Its `--start` refuses with
   `payments.toml has no [deposits]`; `--deposits off` adds the section back.

`closed` deposits may stay: late money sent to them waits for a roll forward, then goes back with
`pcli deposits return-late` (section 12).

To turn deposits on:

1. With the founder's go, the router's mainnet smoke test passes, its test
   `minContextSlot with until is accepted` included, on the endpoints that `pcli rpc probe` names
   on its `listings:` line. It moves no money.
2. `vps-install.sh --deposits on` sets `enabled = true` and restarts the running version. On a
   release without `pcli rpc probe` it refuses with
   `deposits need the RPC router release; install it first`. Otherwise it checks the list line as
   `--start` does, runs the probe as the service user, and refuses unless the probe exits 0, shows
   `quorum: 2 of 2 domains ready` and names at least two endpoints on `listings:`. Deposit scans
   are pinned listings, which go only to those endpoints. It prints counts, never an endpoint:

    ```text
    rpc probe: exit 0, quorum 2 of 2 domains ready, 2 listing endpoints
    ```

`vps-install.sh --deposits off` stops new addresses and restarts the running version; deposits
that exist are watched and finish. When the installed version is not the one running, both leave
the restart to the next `--start`.

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

**The allowance wallet and the TLS files**, once:

1. In the checkout, `pnpm cli keys generate` writes a new `BUGNET_ALLOWANCE_KEY` into the
   checkout's `.env` and prints only addresses, among them `allowance=<address>`. Copy the value
   of the `BUGNET_ALLOWANCE_KEY=` line from that `.env` into `/etc/bugnet/payments.env`
   (`sudoedit`), as the line `BUGNET_ALLOWANCE_KEY=<value>`.
2. In `/etc/bugnet/payments.toml`, set `[x402] allowance_wallet` to the printed `allowance`
   address and `[x402] enabled = true`. Without `enabled`, terms answer `enabled: false` and
   allowance orders are refused `x402_disabled`.
3. `pnpm cli keys fund --create-allowance-ata` creates its USDC account.
4. The TLS files. The router owner, who keeps the internal CA key on their Mac, runs
   `bugnet-dev mtls init --out <staging>` there. It writes, laid out as on the VPS,
   `etc/bugnet/internal-ca.pem`, `etc/bugnet/payments/x402-server.pem`, egress's client pair and
   `payments.env.add`. Install `internal-ca.pem` as `/etc/bugnet/internal-ca.pem` and
   `x402-server.pem` as `/etc/bugnet/payments/x402-server.pem` with the modes in the table above.
   Append `payments.env.add` to `/etc/bugnet/payments.env`: its one line is
   `BUGNET_X402_TLS_KEY=` and the server key PEM in base64 on one line (from a key file:
   `base64 < x402-server.key | tr -d '\n'`). Then delete the staging copies of both keys.
5. Restart: `sudo systemctl restart bugnet-payments@<version>`. The env file is read only at
   start, so a changed `BUGNET_ALLOWANCE_KEY` or `BUGNET_X402_TLS_KEY` needs the restart; when only
   the two `.pem` files changed, `sudo systemctl kill -s HUP bugnet-payments@<version>` is enough.
   Until then no listener runs and terms answer `enabled: false`. Boot refuses an allowance wallet
   that is also another Bugnet wallet.

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
   `x402_tail_lag` firing is usually an RPC whose history lags: `pcli rpc status`, then move or
   remove the lagging URL in the local `BUGNET_SOLANA_RPC_URLS`, copy it again and restart
   (section 6), and once the mirror verifies go to step 5.
2. Otherwise, or if unsure: `pcli x402 kill`. For a suspected key leak, also hold refunds:
   `pcli x402 refunds hold` (the operator's only refund hold).
3. Cover any loss: send Bugnet's own USDC from the cold recipient to the hot USDC account, the sum
   of the open incidents' `loss_micros`. The mirror records it as an unmatched inflow; refunds that
   went to the manual queue for a short balance can then be retried with `pcli manual retry`.
4. A leaked key is replaced only once the hot ledger is empty: keep the kill on and let sandboxes
   end. With refunds held, their hot refunds stay `pending`: pay each by hand from the cold
   recipient and record it with `pcli manual resolve <refundId> --tx`, which takes a `pending`
   row while held. Without a hold, let them confirm and do the same for any that go `manual`.
   Then stop the unit (`sudo systemctl stop bugnet-payments@<version>`) and only then run
   `PCLI_ENV=<test payer env file> pcli keys drain --allowance` (section 8). Make a new key
   (`pnpm cli keys generate` with `BUGNET_ALLOWANCE_KEY` cleared) and copy it into
   `/etc/bugnet/payments.env` as in section 10, set `[x402] allowance_wallet` to its address, run
   `pnpm cli keys fund --create-allowance-ata`, and start the unit
   (`sudo systemctl start bugnet-payments@<version>`; boot check 4 opens the new tail). A drain
   while Payments runs is a hot outflow that matches nothing: expect an `unknown_change` incident
   whose `loss_micros` is the drained amount, a pause and `x402_incident`, and resolve it in
   step 5.
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

| Alarm                       | When                                                                                                                                                                                                                                                                                                                                 | Operator's action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x402_incident`             | An incident was written, with its kind                                                                                                                                                                                                                                                                                               | Payments is paused; follow the runbook above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `x402_outflow_cap`          | Seller payments of the UTC day reached `outflow_daily_cap_micros`                                                                                                                                                                                                                                                                    | None; it lifts at 00:00 UTC. If one payee took most of it, `pcli x402 block-payto`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `x402_unresolved`           | A `signed` row unresolved `unresolved_alarm_after` after signing                                                                                                                                                                                                                                                                     | `pcli x402 status` shows its `signed_at`, `signing_slot` and `last_valid_block_height`; read the hot account's history on an explorer for the next 2 minutes; check `x402_tail_lag` and the RPC. Never release by hand                                                                                                                                                                                                                                                                                                                                                                                                     |
| `x402_tail_lag`             | `verified_slot` more than `tail_lag_alarm_after` behind                                                                                                                                                                                                                                                                              | `pcli rpc status`; move or remove the lagging URL in the local list, copy it again and restart (section 6); look for a dust flood in `x402_chain_txs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `x402_rpc_budget`           | RPC calls in an hour passed `rpc_calls_per_hour_alarm`                                                                                                                                                                                                                                                                               | Look for a dust flood or a loop; a paid RPC plan if it is real traffic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `x402_ref_conflict`         | A repeated `ref` or a `ReportOutcome` `ref` did not match its row                                                                                                                                                                                                                                                                    | Check egress for a bug or a compromise; `pcli x402 kill` if it repeats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `x402_refund_budget`        | Hot refunds passed `refund_daily_cap_micros`                                                                                                                                                                                                                                                                                         | Review the manual queue; `pcli manual retry` each after checking                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `x402_pool_high`            | Allowance money held passed `pool_high_alarm_percent` of `pool_max_micros`                                                                                                                                                                                                                                                           | Look for a burst of unpaid orders from one client; raising the $50 is the founder's call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `x402_pool_drift`           | The audit's `committed_micros` differs from the stored one                                                                                                                                                                                                                                                                           | Find the cause before correcting the row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `x402_audit_mismatch`       | The audit found a confirmed row missing on chain, or the balance off its sum                                                                                                                                                                                                                                                         | Find the row before correcting anything; `pcli x402 pause audit` if money is unaccounted for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `x402_cert_expiry`          | Payments' server certificate, the client CA, or the client certificate egress presents expires within `cert_expiry_alarm_before`                                                                                                                                                                                                     | On the Mac that keeps the CA key, run `bugnet-dev mtls init --renew --from <the two certificate files>`, copy the two `.pem` files to the VPS, then `systemctl kill -s HUP` both services                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `x402_reload_failed`        | An index or certificate reload was rejected, or the TLS files on disk have differed from the served ones for over 10 minutes                                                                                                                                                                                                         | Fix the file and send `SIGHUP` again; for a renewal copied without one, send `SIGHUP`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `x402_payee_unreliable`     | A service was marked unreliable                                                                                                                                                                                                                                                                                                      | Read the seller's hints; `block-payto` if dishonest, else `pcli x402 service reset`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `x402_signer_down`          | A live check keeps the listener closed                                                                                                                                                                                                                                                                                               | Read the logged check; fix the RPC or the certificate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `x402_events_stuck`         | The oldest pending router event of a redeemed order is older than `events_stuck_alarm_after`                                                                                                                                                                                                                                         | Check the router; rows retry by themselves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `x402_event_dropped`        | The router answered `ORDER_UNKNOWN` to an `x402_resolved`                                                                                                                                                                                                                                                                            | Check whether the start order ever reached `CreatePlacement`; nothing to resend                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `x402_event_refused`        | The router refused an event as `InvalidArgument`                                                                                                                                                                                                                                                                                     | A bug in Payments or the router; fix and backfill by hand                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `x402_close_slow`           | An account `closing` longer than `close_slow_alarm_after`                                                                                                                                                                                                                                                                            | Find its `signed` rows; check the mirror                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `x402_close_unverifiable`   | The close check could not reach the router for `close_unverifiable_after`                                                                                                                                                                                                                                                            | Check the router                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `x402_resign_waiting`       | A hot refund or transfer waited for the re-sign proof past `resign_wait_alarm_after`                                                                                                                                                                                                                                                 | `pcli rpc status`; move or remove the lagging URL in the local `BUGNET_SOLANA_RPC_URLS`, copy it again and restart (section 6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `rpc_endpoint_down`         | An endpoint failed (`errors`), refused its key (`auth`), answered `http_402`, `http_403`, `http_404`, `http_405` or `http_410`, stayed rate limited (`rate_limited`), lost the history it had (`history_missing`), ignored an unreachable `minContextSlot` (`min_context_slot_ignored`), or failed its genesis check (`unreachable`) | `pcli rpc status`; `rpc2` is the second URL of the list. `auth`: check that URL's key. `http_402` or `rate_limited`: its account is out of balance or its plan is spent or too small; top it up, or move the URL down or out. `http_403`: its key, plan or IP allow-list refuses this server. `unreachable` with status 400: its plan does not serve Solana mainnet or its balance is empty. `history_missing` or `min_context_slot_ignored`: move the URL down or remove it. `errors`, `http_404`, `http_405`, `http_410`: fix or remove the URL. Each change: edit the local list, copy it again and restart (section 6) |
| `rpc_all_endpoints_down`    | No endpoint can serve a role (read, history or send)                                                                                                                                                                                                                                                                                 | `pcli rpc status`; the providers' status pages; payments wait meanwhile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `rpc_endpoint_lag`          | An endpoint lagged past `max_slot_lag` for `lag_alarm_after`                                                                                                                                                                                                                                                                         | `pcli rpc status`; move the lagging URL down the list or remove it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `rpc_absence_unconfirmed`   | A "not found" could not be confirmed by two domains, so a revert or re-sign waits                                                                                                                                                                                                                                                    | `pcli rpc status`: a history endpoint is down or inconsistent; re-signs and reverts wait until two domains answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `x402_cold_transfer_failed` | A transfer to cold became `failed`                                                                                                                                                                                                                                                                                                   | None needed: its parts go in the next one. If it repeats, check the cold recipient's USDC account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Hot refunds that go manual fire the existing `manual_queue`; unmatched inflows of $0.01 or more
and late order inflows fire the existing `inflow_mismatch`.

## 12. Deposits

Each unpaid order's page shows its own address. The deposit job watches it, sweeps a full payment
to the recipient (or to the allowance wallet, for an allowance top-up), returns anything else to
the account that sent it, and closes the token account to get the rent back. Design:
`docs/superpowers/specs/2026-11-10-direct-transfer-design.md`.

**The seed and key recovery.** A deposit's key is derived from `BUGNET_DEPOSIT_SEED` and that
deposit's random 16-byte salt in `deposits.salt`. Order ids are public, so the salt keeps the seed
alone from giving any key. The key itself is never stored. Recovery needs both the env file and
the database: database backups are part of key recovery and are kept with the seed archive.
Without either, money still in a deposit, and late money sent to a closed address, cannot be
moved. Boot refuses while a deposit that is not `done` uses a seed version that is not loaded
(`BUGNET_DEPOSIT_SEED for version N is missing while M deposits use it`), and when a loaded seed
does not derive a stored address.

**Rotation.** `vps-install.sh --rotate-deposit-seed`:

- refuses while `BUGNET_DEPOSIT_SEED_PREVIOUS` is set: an earlier rotation is still draining;
- writes its target version to `/etc/bugnet/payments.rotating`, runs `keys rotate-deposit-seed`
  as root (the seed moves to `BUGNET_DEPOSIT_SEED_PREVIOUS` and a new one is written, in one
  atomic `0600` write), raises `[deposits] seed_version` by 1, restarts the running version, and
  removes the marker last. A run that stopped halfway is finished by the next run and never
  rotates twice. While the marker exists, `--start`, `--deposits` and retirement refuse, since a
  restart then would load the new seed under the old version.

New deposits use the new version. Each deposit keeps signing with the seed of its own version.

**Retirement, with the archive on the Mac.** Once `pcli deposits list --version <old>` prints only
`state=done` lines (at most `watch_after_close`, 24 h, after the last one closed), on the Mac, in
`bugnet-payments`:

```sh
deploy/retire-deposit-seed.sh [ssh options] HOST
```

1. Over ssh it runs `vps-install.sh --retire-deposit-seed -`. The server refuses while a deposit
   of the old version is not `done` or a rotation is unfinished; otherwise it prints only the line
   `BUGNET_DEPOSIT_SEED_V<old>=<value>` and removes nothing.
2. The script appends that line to the archive, `BUGNET_DEPOSIT_ARCHIVE` (by default
   `~/.bugnet/deposit-seeds.env`, mode `0600`, refused inside a git checkout), and reads it back.
3. Only then does it send the line back with `--remove-previous`. The server removes
   `BUGNET_DEPOSIT_SEED_PREVIOUS` only when the value matches, in one atomic write, and restarts
   the running version.

Every step can run again: a line already archived with the same value is not appended twice, and
one with another value stops the run. The seed moves only through pipes: never an argument, never
printed, and no seed file is left on the server. Keep the archive offline with the database
backups, and never delete a line from it: a user who saved a closed address and sends to it again
can still get the money back.

**Returning money with a retired seed.** `deposits return-late` and `deposits return-sol` take
`--archive -` and read the archive on stdin, so it never touches the server's disk. On the Mac:

```sh
# Runs one pcli command on the server, fed this shell's stdin
spcli() {
    ssh -p PORT -i KEY_FILE USER@HOST "cd /opt/bugnet/payments/\$(cat /etc/bugnet/payments.release) &&
        sudo -n sh -c 'set -a; . /etc/bugnet/payments.env; set +a
            exec setpriv --reuid=bugnet-payments --regid=bugnet-payments --init-groups \
                node dist/cli.js -config /etc/bugnet/payments.toml \"\$@\"' sh $(printf '%q ' "$@")"
}
spcli deposits return-late <orderId> --signature <sig> --archive - \
    <"${BUGNET_DEPOSIT_ARCHIVE:-$HOME/.bugnet/deposit-seeds.env}"
```

**If the seed leaks.** The seed alone gives no key; someone holding both the env file and the
database (or a backup of each) can derive any deposit's key. They could take USDC sitting in a
deposit (a partial payment for at most 15 min, a full payment for the seconds before its sweep
lands, money held while the router is busy, late money before its return lands) and close empty
deposit accounts to themselves (about 0.00204 SOL each, at most `max_open`, about 1 SOL). They
could not touch the recipient (no key on the server), the fee payer, the refund float, the
allowance wallet, money already swept, or review money already carried to the refund float.

1. `vps-install.sh --deposits off`. Deposits that exist keep being watched and finish. If it
   prints `bugnet-payments@<version> is not running`, the change is not loaded yet: run
   `vps-install.sh --start`.
2. `vps-install.sh --rotate-deposit-seed`. If an earlier rotation is still draining it refuses:
   deposits stay off until `deploy/retire-deposit-seed.sh` can run (at most about 25 h), then
   rotate.
3. Read every `deposit_unknown_debit` alarm: it fires on any debit of a deposit account that is not
   one of Payments' own moves.
4. `vps-install.sh --deposits on` (section 8).

**Alarms.**

| Alarm                   | When                                                                                                                                                                                                                                                                  | Operator's action                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deposit_review`        | A deposit or a transfer needs a person; `reason` is one of `unattributed`, `unreadable`, `from_bugnet`, `late_limit`, `return_destination_invalid`, `return_failed`, `unknown_debit`, `move_expired_repeatedly`, `moves_failing`, `expired_unchecked`, `double_sweep` | `pcli deposits list --review`, `pcli deposits show <orderId>`; a transfer in review goes back with `deposits return-to`, a deposit whose moves failed with `deposits retry` once the cause is fixed |
| `deposit_unknown_debit` | A deposit account lost USDC in a transaction that is not Payments' own                                                                                                                                                                                                | The leak response above                                                                                                                                                                             |
| `deposit_index_lag`     | The balance has not matched the recorded transfers for over 30 s, a listing could not be proven complete, an interval stayed unexplained after every entry was fetched, a transaction stayed missing, or the hard stop waited for a scan                              | `pcli rpc status`; move the lagging URL down the local list or remove it, copy it again and restart (section 6)                                                                                     |
| `deposit_capacity`      | `max_open` deposits hold Bugnet-paid rent (once an hour)                                                                                                                                                                                                              | None needed: senders pay their own rent meanwhile and get it back at the close. Look for a flood of page views                                                                                      |
| `deposit_create_churn`  | The unpaid-create budget of the last hour is spent (once an hour)                                                                                                                                                                                                     | None needed: senders pay their own rent for the rest of the hour. Look for one client behind many addresses                                                                                         |
| `deposit_fee_budget`    | The free-move budget of the last hour is spent (once an hour)                                                                                                                                                                                                         | None needed: metered returns wait, the money stays in the deposit. Look for a dust flood                                                                                                            |
| `deposit_rpc_budget`    | The job passed 80 % or 100 % of `rpc_calls_per_day`, or an hour passed `rpc_calls_per_hour_alarm`                                                                                                                                                                     | Look for a scan that is stuck or a padding flood; section 6 says what slows down                                                                                                                    |

**Operator commands** (all `pcli`, section 8):

- `deposits list [--state S] [--review] [--version N] [--moving]`: one line per deposit,
  `<orderId> state=<s> received= returned= kept= review= held= reason=`, amounts in micros.
  `review` is review money still in the deposit, `held` is review money carried to the refund
  float. `--moving` lists only deposits with a move in flight.
- `deposits show <orderId>`: the deposit, its transfers with owner and source, its moves with
  their signatures, its holds, and for a shared payment its shares and every refund part.
- `deposits retry <orderId>`: clears the review reason and puts the deposit's manual sweep back to
  pending; refused while a move is in flight.
- `deposits return-to <orderId> <signature> <tokenAccount> [--signed FILE]`: returns a transfer in
  review (below).
- `deposits return-late <orderId> [--signature SIG]... [--archive FILE|-]`: for a `done` deposit.
  Without `--signature` it lists the credits sent after the close, each with its source, owner and
  whether the owner signed; with it, it returns exactly those credits, each to its own
  signer-owned source, and closes the account only when it is empty afterwards.
- `deposits return-sol <orderId> <to> [--archive FILE|-]`: SOL sent to a deposit address, on
  request.
- `manual list`, `manual retry`, `manual resolve` and `manual refund` take split refund parts and
  `deposit` refund rows, one line or one id per part.

**Fee payer cost per order** (lamports; 5,000 per signature, 400 priority, rent returned at the
close):

| Order outcome                                                     | Moves                              | Cost                                      |
| ----------------------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| Paid with the exact amount                                        | create + sweep with close          | 15,800 (about $0.003 at $200/SOL)         |
| Paid with extra, one sender                                       | create + sweep + return with close | 26,200                                    |
| Underpaid, then expired                                           | create + return with close         | 15,800                                    |
| Page viewed, never paid                                           | create + close                     | 15,800                                    |
| Each further sending account to return                            |                                    | + 10,400                                  |
| A move that fails on chain                                        |                                    | + about 10,400                            |
| A closing move that loses the race to new money                   |                                    | + 10,400, + 10,400 for the separate close |
| A move refused at preflight                                       |                                    | 0                                         |
| Each later refund of a shared payment, per owner beyond the first |                                    | + about 10,200                            |

The rent, 2,039,280 lamports per open account, is locked while it is open and returned at the
close. The fee-per-order alarms subtract deposit moves, so normal use keeps them quiet.

**Budgets against strangers.** Deposit addresses are public once their account exists, and one
transaction can credit many of them, so a stranger could make Bugnet pay many times what it pays.

- **Free-move budget**, `free_moves_lamports_per_hour` (2,000,000, about 190 moves): caps the fees
  of metered moves (returns that do not close to the fee payer, closes to a stranger who opened
  the account again) and of every failed move. Past it, metered moves wait and
  `deposit_fee_budget` fires. Creates, sweeps and rent-returning closes are never metered, so
  every deposit still gets its account and closes.
- **Per sender**, `returns_per_owner_per_hour` (6): one sending owner cannot spend everyone's
  share; its later returns wait for the next hour.
- **Unpaid-create budget**, `unpaid_create_lamports_per_hour` (1,000,000, about 63 accounts):
  caps the fees of accounts that never see money. Past it no account is created for new pages for
  the rest of the hour and `deposit_create_churn` fires; senders pay their own rent meanwhile.
- **Rent caps:** `max_open` (500), `rented_per_ip` (1 per IPv4 address or IPv6 /64) and
  `rented_per_block` (2 per /48).
- Leftovers, review money and split parts below `refund_min_micros` ($0.001) never get a
  transaction of their own.

**Held review money.** Money that needs a person never blocks a close: below $0.001 it is kept,
above it rides in the closing move to the refund float and stays there as money Bugnet owes.
`deposits return-to` sends it back, and only to:

- an account owned by the wallet that sent it, with no proof; or
- another account, with `--signed FILE`: a JSON file `{message, signature}` where `message` is
  exactly `bugnet return-to <orderId> <transfer signature> <tokenAccount>`, signed by the sending
  wallet. Ask the sender for that signed message.

Never pay a destination on the word of whoever writes: the order id and the amount are public on
chain (the sweep's memo), so knowing them proves nothing. Anything else is refused with
`destination is not the sender's; pass --signed`. A transfer with no source whose transaction
cannot be decoded has no signer to check, and stays in the float until handled by hand.

**Shared payments.** An order is paid by the first single sending wallet whose own money covers
the price; only when none does may up to 4 wallets, each with at least $0.001, share it. Every
later refund of a shared payment (unredeemed, abandoned, router refunds, a refused funding, unspent
allowance, an operator refund) is split by share, one refund row per wallet, each paid on its own.
One wallet's closed account sends only its own part to the manual queue. `deposits show` prints
the shares and every part.

**Who the router sees.** Every single sending wallet is named as the router's payer and checked
with CheckPayer, under the router's own per-wallet limits and blocks, an exchange's hot wallet
included: all customers of one exchange share its limits. A shared payment names no payer and
falls in the router's anonymous pool; each wallet's block still applies. Money the router refuses
goes back to its sender.

**RPC.** The job's own caps, 3 calls a second and 30,000 a day, sit on top of the router's limits
(section 6).
