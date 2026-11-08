# x402 mainnet tests: the joint runbook (T1 to T19)

The joint run of spec 11.3, with the ledger check of Payments after every test. Nothing here
sends a transaction by itself: the sandbox, egress, the router and the test seller do, and the
commands below only read Payments' state and the chain.

Spec: `docs/superpowers/specs/2026-11-06-x402-in-sandboxes-design.md` (11.3, 12.3 steps 5 to 7,
12.5, 6.17). Commands run in `bugnet-payments` unless a step says otherwise.

Every `pcli` command runs on the VPS as the service user, against the deploy settings and the
secrets file, as `deploy/README.md` section 8 defines it. Never `pnpm cli` there: without
`-config` it opens `config/dev.toml`, the dev database. Once per shell:

```sh
cd "/opt/bugnet/payments/$v"
pcli() {
    sudo sh -c 'set -a; . /etc/bugnet/payments.env; [ -z "$0" ] || . "$0"; set +a
        exec setpriv --reuid=bugnet-payments --regid=bugnet-payments --init-groups \
            node dist/cli.js -config /etc/bugnet/payments.toml "$@"' "${PCLI_ENV:-}" "$@"
}
```

## 1. Owners and preconditions

Owners (spec 1):

| Owner       | Part                                                                        |
| ----------- | --------------------------------------------------------------------------- |
| the founder | the Mac, Tailscale, the test payer, wallet approvals, the final call to run |
| bugnet-d7   | router, egress, mTLS                                                        |
| bugnet-ea   | gateway (the MCP tools)                                                     |
| bugnet-22   | Payments (the ledger, the signer, the ledger check)                         |

Do not start before every handoff is live. How to check each:

| Handoff                                                                                 | Owner                         | Check                                                                                                           |
| --------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| H1 proto: `LookupPlacement`, `AppendAllowanceEvent`, `AppendX402Resolved`, `x402.proto` | bugnet-d7                     | Payments builds against `../bugnet-proto`; `pnpm typecheck` passes                                              |
| H2 router serves the three calls                                                        | bugnet-d7                     | `LookupPlacement` by handle answers on the live router; an unknown handle gives `HANDLE_UNKNOWN`                |
| H3 router accepts the `allowance_micros` claim                                          | bugnet-d7                     | a start order with `allowanceMicros` is claimed; `[router] allowance_claim = true` in Payments                  |
| H4 router events carry order id, placement id and deadline                              | bugnet-d7                     | a `placement.ready` event in the router log has `order_id` and `deadline`                                       |
| H5 egress is the mTLS client                                                            | bugnet-d7                     | egress log shows a `ReserveAndSign` answer from Payments on 127.0.0.1:8449                                      |
| H6 mTLS material                                                                        | bugnet-d7                     | `/etc/bugnet/internal-ca.pem` and `/etc/bugnet/payments/x402-server.pem` exist; Payments logs its x402 listener |
| H7 gateway is the port v3 client                                                        | bugnet-ea                     | `bugnet_x402_find` and `bugnet_x402_budget` are listed by the gateway                                           |
| H8 session page draws allowance phases                                                  | bugnet-d7, session page owner | the session page of a test run shows the allowance rows                                                         |
| H9 founder steps 1 to 3 of 12.5                                                         | the founder                   | section 2 below                                                                                                 |

Payments itself must show, on the VPS (`pcli x402 status`):

```
paused: false
disabled: false
pool committed=... unpaid=0
verified_slot: ... lag_slots: <60 s worth of slots (under 150)>
```

`paused: false`, the pool line and a `verified_slot` lag under 60 s (about 150 slots at 400 ms).
`chain balance:` must show the allowance wallet's USDC. `pcli x402 incident list` must print
nothing.

## 2. Setup

Built at FD4's current pick (open; spec 3.1 and 6.17): the test seller runs on the founder's Mac
during the run. Tailscale Funnel publishes it as the two names of 11.3, `x402-seller-a` and
`x402-seller-b` under the tailnet's `ts.net` name. There is no domain and no server.

1. **Tailscale** (founder step 1 of 12.5, done 2026-11-07). The auth key is in
   `~/.config/bugnet/tailscale.env`. Keep the Mac plugged in and awake for the whole run.
2. **Test seller wallets** (founder step 3 of 12.5), on the Mac where the test payer key lives:

    ```
    pnpm cli keys testseller --env ~/.config/bugnet/testseller.env
    ```

    The file is mode 0600 and outside any repo. The command creates ATA(`payTo`), the test payer
    paying the rent, and prints `testseller_payto` and `testseller_fee_payer`. Send 0.01 SOL to
    the printed `testseller_fee_payer`. The seller is the fake seller's code with a real
    facilitator (`@x402/svm`), its own fee payer and its own `payTo`; neither is a Bugnet key.

3. **Payments settings for the window** in `/etc/bugnet/payments.toml`: `[x402] enabled = true`
   and `[router] allowance_claim = true`; then `systemctl restart bugnet-payments@<instance>`.
   The allowance wallet and its USDC account exist (founder step 2 of 12.5).
4. **The 6.17 check from the VPS**, over public DNS and never through Tailscale, passes before
   any paid row. It uses the free paths `/hold/<seconds>/` and `/sse/` and pays nothing:
    - each name's certificate is valid for that name;
    - a response held silent for 150 s (`/hold/150/`) still arrives;
    - `/sse/` keeps flowing for 3 minutes, one event every 5 s;
    - a slow 1 MiB upload gets its 402 before the upload ends;
    - 32 parallel requests, and 300 requests in one minute, all pass.

    If it fails, the seller runs on the founder's other-projects VPS behind its web server (the
    6.17 fallback) and the same check runs there before any paid row.

5. **Money stays between Bugnet's own wallets.** The test payer (17.44 USDC at the time of the
   spec) pays orders into the allowance wallet, which pays the test seller's `payTo`. After the run
   the test seller's balance goes back to the test payer (section 5).

## 3. Budget

| Budget                                                                             | Amount                                       |
| ---------------------------------------------------------------------------------- | -------------------------------------------- |
| USDC moved in tests                                                                | about $10, about $1.50 of it not coming back |
| Test seller's fee payer                                                            | 0.01 SOL                                     |
| ATA rents, paid by the test payer                                                  | about 0.0062 SOL                             |
| Bugnet fee payer, refunds and sweeps (10,000 lamports base each plus priority fee) | under 0.005 SOL                              |
| Paid calls to third-party sellers, 3 + 100 + 18                                    | about $0.12 at $0.001                        |
| Test seller hosting (Tailscale Personal plan)                                      | $0                                           |

The live stack's 0.3 to 0.5 SOL fee-payer float is float, not test spend.

## 4. Tests

Each test runs on the live stack in a real sandbox at a provider. Conventions used below:

- `SELLER_A` and `SELLER_B` are the two Funnel hosts of section 2. `curl` lines run inside the
  sandbox through `bugnet_exec`, so they go through egress.
- Start: `bugnet_start {quoteId, packageId, confirmPriceUsd, x402: {allowanceUsd, services:
[<serviceLine>]}}`. A service line is `METHOD URL max=USD payTo=ADDRESS`, as
  `bugnet_x402_find` returns it; here the seller's `payTo` is `testseller_payto`.
- The account id for the ledger check is the start order's id (the `orderId` that
  `bugnet_start` returns, shown by `bugnet_status`).
- Every test ends with the ledger check, and exit code 0 is required:

    ```
    pcli x402 ledger-check <accountId>
    ```

    It checks every confirmed payment and every confirmed allowance refund of the account against
    the chain, to the micro-dollar, and that a closed account has `funded = spent + refunded +
kept`. A refund resolved by hand is listed, not checked. Any `MISMATCH` line stops the run.
    A line `refund <id> pending`, `signed`, `sent` or `manual` means the refund has not reached the
    chain: on a closed account the check exits 1. Wait until the refund is confirmed and run the
    check again; a `manual` refund is an incident, not a wait. The output also has a
    `payment` line per confirmed payment and an `account` line with `spent=`; the per-test checks read payments and spend from these lines,
    since `pcli x402 status` does not print them.

- Between tests: `pcli x402 status` shows `paused: false`, and `pcli x402 incident list`
  and `pcli manual list` print nothing new. A new incident or manual row stops the run.

### T1: start, 10 paid calls, stop (S6, S11, S14)

1. founder: `bugnet_start {quoteId, packageId, confirmPriceUsd, x402: {allowanceUsd: "1.00",
services: [GET https://SELLER_A/cent/ max=0.01 payTo=<testseller_payto>]}}`; approve the prompt
   and the wallet.
2. bugnet-ea: `bugnet_exec` ten times: `curl -s -o /dev/null -w '%{http_code}\n'
https://SELLER_A/cent/`. Every answer is 200.
3. bugnet-22: `pcli x402 status` shows `accounts open=1`.
4. bugnet-ea: `bugnet_stop`. Its result lists the x402 spend ($0.10) and the refund.
5. bugnet-22: within 10 minutes the allowance refund row is confirmed (S14); `pcli manual
list` prints nothing.

Checks: 10 confirmed payments of 10000 (S6), each resolved from the chain (S11), the refund
within 10 minutes of the stop (S14). Last: `pcli x402 ledger-check <accountId>` exits 0.

### T2: no keys, payloads or tokens leak (S4)

1. founder: `bugnet_start` with `GET https://SELLER_A/echo/ max=0.01`.
2. bugnet-ea: `bugnet_exec` three times: `curl -si https://SELLER_A/echo/`.
3. bugnet-d7: grep the sandbox's files, every service log (egress, router, gateway, Payments) and
   the session record for `PAYMENT-SIGNATURE`, the allowance wallet address, the test seller's
   `payTo`, any base58 string of 64 characters or more, and `eyJ`. `/echo/` returns the signature
   only as its SHA-256, so no payload may appear. No hit is allowed.
4. bugnet-ea: `bugnet_stop`.

Checks: S4. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T3: 32 parallel calls, different bodies (S5)

1. founder: `bugnet_start` with `GET https://SELLER_A/cents/ max=0.02` and `allowanceUsd: "0.10"`.
2. bugnet-ea: `bugnet_exec`: 32 parallel `curl -s -X POST -d "call-$i" https://SELLER_A/cents/`,
   each with a different body.
3. bugnet-22: after the stop, `pcli x402 ledger-check <accountId>` prints at most 5 `payment`
   lines and `spent=` at most 100000 on its `account` line; the rest were refused
   `allowance_spent`.
4. bugnet-ea: `bugnet_stop`.

Checks: S5. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T3b: 32 parallel calls, identical bodies (S5)

1. founder: `bugnet_start` as in T3.
2. bugnet-ea: `bugnet_exec`: 32 parallel `curl -s -X POST -d same https://SELLER_A/cents/`, one
   identical body.
3. bugnet-22: after the stop, `pcli x402 ledger-check <accountId>` prints exactly 5 `payment`
   lines; 27 calls were answered `allowance_spent` (egress log).
4. bugnet-ea: `bugnet_stop`.

Checks: S5. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T4: a second host, not enabled, answers 402 (S7)

1. founder: `bugnet_start` with a service line for `SELLER_A` only.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_B/ok/`. The seller's own 402 comes back and
   nothing is paid.
3. bugnet-22: after the stop, `pcli x402 ledger-check <accountId>` prints no `payment` line
   for SELLER_B's token account and `spent=0` on its `account` line.
4. bugnet-ea: `bugnet_stop`.

Checks: S7. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T5a: the seller path /bait/ (S8)

1. founder: `bugnet_start` with a service line for `GET https://SELLER_A/bait/ max=0.01`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/bait/`. The seller asks $10, above the pinned max.
3. bugnet-22: the call is refused and nothing is paid: after the stop, the ledger check
   (`pcli x402 ledger-check <accountId>`) prints no `payment` line and `spent=0` on its
   `account` line, and `pcli x402 incident list` prints nothing.
4. bugnet-ea: `bugnet_stop`.

Checks: S8. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T5b: the seller path /switch/ (S8)

1. founder: `bugnet_start` with a service line for `GET https://SELLER_A/switch/ max=0.01`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/switch/`. The seller names a different payTo on every 402.
3. bugnet-22: the call is refused and nothing is paid: after the stop, the ledger check
   (`pcli x402 ledger-check <accountId>`) prints no `payment` line and `spent=0` on its
   `account` line, and `pcli x402 incident list` prints nothing.
4. bugnet-ea: `bugnet_stop`.

Checks: S8. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T5c: the seller path /splits/ (S8)

1. founder: `bugnet_start` with a service line for `GET https://SELLER_A/splits/ max=0.01`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/splits/`. The seller sets a splits field.
3. bugnet-22: the call is refused and nothing is paid: after the stop, the ledger check
   (`pcli x402 ledger-check <accountId>`) prints no `payment` line and `spent=0` on its
   `account` line, and `pcli x402 incident list` prints nothing.
4. bugnet-ea: `bugnet_stop`.

Checks: S8. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T5d: the seller path /upto/ (S8)

1. founder: `bugnet_start` with a service line for `GET https://SELLER_A/upto/ max=0.01`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/upto/`. The seller uses the upto scheme (repeat with /escrow/, the escrow scheme).
3. bugnet-22: the call is refused and nothing is paid: after the stop, the ledger check
   (`pcli x402 ledger-check <accountId>`) prints no `payment` line and `spent=0` on its
   `account` line, and `pcli x402 incident list` prints nothing.
4. bugnet-ea: `bugnet_stop`.

Checks: S8. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T5e: the seller path /ata/ (S8)

1. founder: `bugnet_start` with a service line for `GET https://SELLER_A/ata/ max=0.01`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/ata/`. The seller asks us to create an associated token account.
3. bugnet-22: the call is refused and nothing is paid: after the stop, the ledger check
   (`pcli x402 ledger-check <accountId>`) prints no `payment` line and `spent=0` on its
   `account` line, and `pcli x402 incident list` prints nothing.
4. bugnet-ea: `bugnet_stop`.

Checks: S8. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T5f: the seller path /feepayer-bugnet/ (S8)

1. founder: `bugnet_start` with a service line for `GET https://SELLER_A/feepayer-bugnet/ max=0.01`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/feepayer-bugnet/`. The seller names a Bugnet address as its fee payer (R3).
3. bugnet-22: the call is refused and nothing is paid: after the stop, the ledger check
   (`pcli x402 ledger-check <accountId>`) prints no `payment` line and `spent=0` on its
   `account` line, and `pcli x402 incident list` prints nothing.
4. bugnet-ea: `bugnet_stop`.

Checks: S8. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T6: /late/ with 20 parallel calls and $0.05 left (S9)

1. founder: `bugnet_start` with `GET https://SELLER_A/late/ max=0.01` and an allowance of $0.05.
2. bugnet-ea: `bugnet_exec`: 20 parallel `curl -s https://SELLER_A/late/`. The seller answers
   `success: false` and submits 20 s later.
3. bugnet-22: at most 5 payments are signed. Watch `pcli x402 status` for `signed` lines; a
   late-landed row ends confirmed, never twice. After the stop, `pcli x402 ledger-check
<accountId>` prints at most 5 `payment` lines and `spent=` at most 50000.
4. bugnet-ea: `bugnet_stop`.

Checks: S9. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T7: retries against /settle500/ and /settle429/ (S10)

1. founder: `bugnet_start` with `GET https://SELLER_A/settle500/` and `GET
https://SELLER_A/settle429/`, max 0.01 each.
2. bugnet-ea: `bugnet_exec`: openai-python with its default retries pointed at each path. Each
   request is paid once, not once per retry.
3. bugnet-d7: repeat the `/settle500/` run once with egress restarted between the paid answer and
   the retry. The retry is served from the kept payload, with no second payment.
4. bugnet-22: one payment per request; `pcli x402 incident list` prints nothing.
5. bugnet-ea: `bugnet_stop`.

Checks: S10. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T8: /lie/ (S11)

1. founder: `bugnet_start` with `GET https://SELLER_A/lie/ max=0.01`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/lie/`. The seller answers `success: true`
   with a made-up transaction and never submits.
3. bugnet-d7: the session page never shows the made-up transaction or counts it as paid.
4. bugnet-22: the payment ends `expired_unlanded`, and its `x402_resolved` says `released`.
5. bugnet-ea: `bugnet_stop`.

Checks: S11. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T9: /silent/ resolves from the chain (S11)

1. founder: `bugnet_start` with `GET https://SELLER_A/silent/ max=0.01`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/silent/`. No `PAYMENT-RESPONSE` comes
   back, yet the seller submits.
3. bugnet-22: within 3 minutes the payment is `confirmed` from the chain (it lands).
4. bugnet-ea: `bugnet_stop`.

Checks: S11. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T9b: /reject/ resolves by expiry (S11, 7.10)

1. founder: `bugnet_start` with `GET https://SELLER_A/reject/ max=0.01`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/reject/`. The seller answers 402 to the
   paid retry and submits nothing.
3. bugnet-22: within about 5 minutes the payment is resolved by expiry and its money is released.
4. bugnet-ea: `bugnet_stop`.

Checks: S11. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T10: latency (S13)

1. founder: `bugnet_start` with `GET https://SELLER_A/ok/` and `GET https://SELLER_A/free/`,
   allowance $1.00.
2. bugnet-ea: `bugnet_exec`: 50 paid calls to `/ok/` and 50 unpaid calls to `/free/`; record the
   p50 of each with `curl -w '%{time_total}'`.
3. bugnet-ea: report apart 50 calls through Bugnet and 50 paid directly by the test payer at a
   third-party $0.001 seller.
4. bugnet-ea: `bugnet_stop`.

Checks: S13. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T11: top-up after allowance_spent (S5, S6)

1. founder: `bugnet_start` with `GET https://SELLER_A/cents/ max=0.02` and `allowanceUsd: "0.10"`.
2. bugnet-ea: `bugnet_exec`: calls until one answers `allowance_spent`.
3. founder: `bugnet_x402_budget {handle, amountUsd: "0.50", confirmPriceUsd: "0.50"}`.
4. bugnet-ea: the same calls pass with no restart.
5. bugnet-ea: `bugnet_stop`.

Checks: S5, S6. Last: `pcli x402 ledger-check <accountId>` exits 0 (the account has two
fundings; the check covers both refunds).

### T12: the first-use flag (S3)

1. founder: with a fresh test wallet, `bugnet_start` with x402; then fund the same wallet's second
   allowance with `bugnet_x402_budget {amountUsd: "0.50"}`.
2. bugnet-ea: the first answer says first use; the second does not.
3. bugnet-ea: `bugnet_stop`.

Checks: S3. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T13: unspent $0.004 is kept (S6)

1. founder: `bugnet_start` with `GET https://SELLER_A/cent/ max=0.01` and `allowanceUsd:
"0.104"`.
2. bugnet-ea: `bugnet_exec`: ten calls to `/cent/`; then `bugnet_stop`.
3. bugnet-22: the account ends with `kept_micros = 4000` and no refund row; a `kept` event is sent;
   the session page shows the line; the sweeper moves the money to cold later.

Checks: S6. Last: `pcli x402 ledger-check <accountId>` exits 0 (`funded = spent + refunded +
kept`, kept 4000).

### T14a: end by stop (S14)

1. founder: `bugnet_start` with x402 and $1.00.
2. bugnet-ea: two paid calls, then `bugnet_stop`.
3. bugnet-22: the refund is confirmed within 10 minutes of the stop.

Checks: S14. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T14b: end by deadline with no stop (S14)

1. founder: `bugnet_start` with x402 and $1.00 on the shortest package.
2. bugnet-ea: two paid calls; do not stop.
3. bugnet-d7: the placement ends at its deadline.
4. bugnet-22: the refund is confirmed within 10 minutes of the deadline.

Checks: S14. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T14c: egress killed during a /slow/ call (S14)

1. founder: `bugnet_start` with `GET https://SELLER_A/slow/ max=0.01` and x402 $1.00.
2. bugnet-ea: `bugnet_exec`: `curl -s https://SELLER_A/slow/` in the background.
3. bugnet-d7: kill egress for the sandbox while the call is in flight.
4. bugnet-22: the payment resolves from the chain or by expiry; the account closes and its refund
   is confirmed within 10 minutes; `pcli x402 incident list` prints nothing.

Checks: S14. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T15: /slow/ fails to settle (2.3 limit)

1. founder: `bugnet_start` with `GET https://SELLER_A/slow/ max=0.01`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/slow/`. After about 60 s the call fails to
   settle with a clear message. The seller settles at 120 s, but the transfer can no longer land
   (its blockhash expired), so nothing is charged.
3. bugnet-22: the payment ends `expired_unlanded` and its money is released.
4. bugnet-ea: `bugnet_stop`.

Checks: 2.3 limit. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T16: budget with $0 and a new service (X16)

1. founder: `bugnet_start` without x402.
2. bugnet-ea: `bugnet_x402_budget {handle, amountUsd: "0", confirmPriceUsd: "0", services:
[<new service>]}` is refused.
3. founder: the same with `amountUsd: "0.10"` and `confirmPriceUsd: "0.10"`; after the wallet
   step the service is enabled.
4. bugnet-ea: `bugnet_stop`.

Checks: X16. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T17: a seller memo of exactly 32 bytes (7.8)

1. founder: `bugnet_start` with `GET https://SELLER_A/memo/ max=0.01`, the seller set to a 32-byte
   `extra.memo`.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/memo/`. The call is paid and lands.
3. bugnet-22: the payment is confirmed; the memo on chain equals the seller's.
4. bugnet-ea: `bugnet_stop`.

Checks: 7.8. Last: `pcli x402 ledger-check <accountId>` exits 0.

### T18: a longer seller memo (7.8)

1. founder: `bugnet_start` with `GET https://SELLER_A/memo-long/<n>/ max=0.01`, for n in 33, 64,
   128 and 256 in turn.
2. bugnet-ea: `bugnet_exec`: `curl -si https://SELLER_A/memo-long/<n>/`.
3. bugnet-22: record for each n whether the call is refused or lands, and the compute units the
   landed transaction used (`getTransaction` `meta.computeUnitsConsumed`) against the compute
   limit. The result sets `sellerMemoMaxBytes`.
4. bugnet-ea: `bugnet_stop`.

Checks: 7.8. Last: `pcli x402 ledger-check <accountId>` exits 0.

Payments-level measurement (test/live/x402.live.test.ts, mainnet, 2026-11-08): a 64-byte seller
memo landed using 24,588 compute units against a limit raised to 40,000 for the test. A 32-byte
memo (T17) used 13,180. The default `seller_compute_unit_limit` of 20,000 therefore covers the
default 32-byte memo but not a 64-byte one; keep `seller_memo_max_bytes` at 32 unless the limit is
raised with it.

### T19: the refund memo's compute units (7.10)

1. founder: `bugnet_start` with x402 and $1.00; spend a little; `bugnet_stop`.
2. bugnet-22: when the allowance refund is confirmed, read its transaction
   (`meta.computeUnitsConsumed`) and compare it with `[refunds] compute_unit_limit`. Record the
   number for 7.10.

Payments-level measurement (mainnet, 2026-11-08): the allowance refund used 7,429 compute units
against `[refunds] compute_unit_limit` 20,000. The real third-party spike (12.3 step 5,
apexfaucet.xyz at $0.001) accepted Payments' own-blockhash payload; the paid call took 1,164 ms.

Checks: 7.10. Last: `pcli x402 ledger-check <accountId>` exits 0.

## 5. After the run

1. founder, on the Mac: move the test seller's balance back to the test payer:

    ```
    pnpm cli keys drain --testseller --env ~/.config/bugnet/testseller.env
    ```

2. bugnet-22: run `pcli x402 ledger-check <accountId>` for every account touched in the run
   (every start order id above) and require exit code 0 for each.
3. bugnet-22: `pcli x402 status` shows `accounts open=0 closing=0`; `pcli x402 incident
list` and `pcli manual list` print nothing.
4. founder: stop the test seller and Tailscale Funnel on the Mac.

## 6. The eval window (F7)

The eval of 11.4 runs about 70 runs that refund near $1.00 each, past the $50 daily hot-refund
budget (F5). The operator either spreads the eval over two UTC days or raises `[x402]
refund_daily_cap_micros` in `/etc/bugnet/payments.toml` for the window (then `systemctl restart`
the Payments unit) and lowers it after. The eval's spend is capped by F7 ($30 USDC with a hard
stop in the harness).
