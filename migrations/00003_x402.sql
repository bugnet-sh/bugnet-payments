alter table orders drop constraint orders_kind_check;
alter table orders add constraint orders_kind_check check (kind in ('start', 'extend', 'allowance'));
alter table orders drop constraint orders_check;
alter table orders add constraint orders_handle_check
    check ((kind in ('extend', 'allowance')) = (handle_sha256 is not null));
alter table orders add column pay_into text not null default 'cold'
    check (pay_into in ('cold', 'allowance'));
alter table orders add column allowance_micros bigint not null default 0;
alter table orders add column fee_micros bigint not null default 0;
alter table orders add constraint orders_allowance_check check (
    allowance_micros >= 0 and fee_micros >= 0
    and allowance_micros + fee_micros <= amount_micros
    and (fee_micros = 0 or allowance_micros > 0)
    and (kind = 'extend') <= (allowance_micros = 0 and fee_micros = 0)
    and (kind = 'allowance') <= (allowance_micros > 0 and allowance_micros + fee_micros = amount_micros)
    and (pay_into = 'allowance') = (allowance_micros > 0));
-- the gateway's services and limits, with Payments' own listed and paid_path, applied when paid
alter table orders add column x402_setup jsonb;
alter table orders add column x402_refusal text check (x402_refusal in
    ('allowance_ceiling', 'allowance_pool_full', 'sandbox_ended', 'order_expired'));
alter table orders add column cold_transfer_id bigint;
-- a partial refund paid from the hot wallet before the share went to cold (7.11)
alter table orders add column hot_router_refund_micros bigint not null default 0
    check (hot_router_refund_micros >= 0);
alter table payments add column landed_slot bigint;
alter table refunds drop constraint refunds_kind_check;
alter table refunds add constraint refunds_kind_check
    check (kind in ('full', 'partial', 'allowance'));
alter table refunds drop constraint refunds_reason_check;
alter table refunds add constraint refunds_reason_check check (reason in
    ('unredeemed', 'late', 'router_refundable', 'abandoned', 'no_router_record', 'operator',
     'x402_unspent', 'x402_ceiling', 'x402_closed'));
alter table refunds add constraint refunds_allowance_reason_check
    check ((kind = 'allowance') = (reason = 'x402_unspent'));
alter table refunds add column from_wallet text not null default 'refund'
    check (from_wallet in ('refund', 'allowance'));
-- landed_slot, expiry_seen_slot and signing_slot as on x402_payments (7.9, 7.10); budget_waived
-- by manual retry and manual refund; hand_tx when the operator paid a hot row by hand (7.10)
alter table refunds add column landed_slot bigint, add column expiry_seen_slot bigint,
    add column signing_slot bigint, add column budget_waived boolean not null default false,
    add column hand_tx text;

create table x402_accounts (
    id text primary key references orders (id),            -- the placement's start order id
    handle_sha256 text check (handle_sha256 ~ '^[0-9a-f]{64}$'),   -- null until a handle lookup
    placement_id uuid,
    package_id text not null,                               -- for CheckPayer (7.2)
    state text not null default 'open' check (state in ('open', 'closing', 'closed')),
    funded_micros bigint not null default 0 check (funded_micros >= 0),     -- unvoided fundings
    spent_micros bigint not null default 0 check (spent_micros >= 0),       -- confirmed payments
    held_micros bigint not null default 0 check (held_micros >= 0),         -- reserved, signed
    refunded_micros bigint not null default 0 check (refunded_micros >= 0), -- refund rows made
    kept_micros bigint not null default 0 check (kept_micros >= 0),
    kept_cold_transfer_id bigint,
    spend_per_minute_micros bigint not null check (spend_per_minute_micros > 0),
    minute_start timestamptz not null default now(),
    minute_micros bigint not null default 0 check (minute_micros >= 0),
    deadline timestamptz,
    close_check_failing_since timestamptz,
    created_at timestamptz not null default now(),
    closing_at timestamptz,
    closed_at timestamptz,
    check (spent_micros + held_micros + refunded_micros + kept_micros <= funded_micros)
);

create table x402_fundings (
    order_id text primary key references orders (id),
    account_id text not null references x402_accounts (id),
    -- the order's allowance, plus its fee when the fee was credited (7.2)
    allowance_micros bigint not null check (allowance_micros > 0),
    fee_credited_micros bigint not null default 0
        check (fee_credited_micros >= 0 and fee_credited_micros < allowance_micros),
    payer text not null,
    source_token_account text not null,
    created_at timestamptz not null default now(),
    voided_at timestamptz
);

create table x402_services (
    account_id text not null references x402_accounts (id),
    service_id text not null check (service_id ~ '^xs_[a-z2-7]{16}$'),
    method text not null check (method in ('GET', 'POST')),
    host text not null, prefix text not null, url text not null,
    max_price_micros bigint not null check (max_price_micros > 0),
    pay_to text not null,
    listed text not null check (listed in ('indexed', 'unlisted')),   -- Payments' decision (7.7)
    paid_path text,                                         -- the one paid path when unlisted
    pinned_from text not null check (pinned_from in ('probe', 'index')),
    probe jsonb not null,                                   -- for audit only
    order_id text not null references orders (id),          -- the paid order of this pin
    state text not null default 'enabled' check (state in ('enabled', 'disabled', 'unreliable')),
    failures int not null default 0,
    updated_at timestamptz not null default now(),
    primary key (account_id, service_id),
    check ((paid_path is null) = (listed = 'indexed'))
);

create table x402_payments (
    id text primary key check (id ~ '^xp_[a-z2-7]{26}$'),
    ref text not null unique check (ref ~ '^[a-z2-7]{16}$'),
    account_id text not null references x402_accounts (id),
    service_id text not null, placement_id uuid not null,
    method text not null, host text not null, path text not null,
    target_sha256 bytea not null, body_sha256 bytea not null,
    amount_micros bigint not null check (amount_micros > 0),
    pay_to text not null, pay_to_token_account text not null, fee_payer text not null,
    listed text not null check (listed in ('indexed', 'unlisted')),
    cap_day date not null,                                  -- the UTC day whose caps it holds
    state text not null check (state in
        ('reserved', 'signed', 'confirmed', 'expired_unlanded', 'failed_onchain', 'released')),
    -- the parts that rebuild the message byte for byte, never the signed payload (X10)
    blockhash text, last_valid_block_height bigint, signing_slot bigint, memo bytea,
    compute_unit_limit int, compute_unit_price_microlamports bigint, accepted_json text,
    message_hash text unique,
    our_signature_sha256 bytea unique,                      -- never the signature itself (F8)
    payment_identifier text,
    keep_until timestamptz,
    landed_slot bigint, expiry_seen_slot bigint,
    tx_signature text unique,                               -- the first, the seller's fee payer's
    late_landed boolean not null default false,
    hint text check (hint in ('success', 'failure', 'absent', 'rejected')),
    hint_tx text, hint_error text, http_status int,
    stream_cut boolean not null default false,
    ended_clean boolean not null default false,
    created_at timestamptz not null default now(), signed_at timestamptz, resolved_at timestamptz
);
create index x402_payments_open on x402_payments (state) where state in ('reserved', 'signed');
create index x402_payments_placement on x402_payments (placement_id, state);
create index x402_payments_account on x402_payments (account_id, state);
create index x402_payments_host on x402_payments (host, created_at);
create index x402_payments_resend on x402_payments
    (placement_id, method, host, target_sha256, body_sha256) where state in ('signed', 'confirmed');

create table x402_payers (
    payer text primary key,
    first_order_id text not null references orders (id),
    first_funded_at timestamptz not null default now()
);
create table x402_payto_days (
    pay_to text not null, day date not null,
    micros bigint not null default 0 check (micros >= 0),
    primary key (pay_to, day)
);
create table x402_unlisted_days (day date primary key, micros bigint not null default 0 check (micros >= 0));
create table x402_outflow_days (day date primary key, micros bigint not null default 0 check (micros >= 0));
create table x402_refund_days (day date primary key, micros bigint not null default 0 check (micros >= 0));
create table x402_pool (
    id int primary key check (id = 1),
    committed_micros bigint not null default 0 check (committed_micros >= 0),
    unpaid_micros bigint not null default 0 check (unpaid_micros >= 0)
);
insert into x402_pool (id) values (1);
create table x402_controls (
    id int primary key check (id = 1),
    disabled boolean not null default false,
    paused boolean not null default false,
    refunds_held boolean not null default false,
    reason text, changed_at timestamptz
);
insert into x402_controls (id) values (1);
create table x402_blocked_payto (pay_to text primary key, reason text not null, at timestamptz not null default now());

create table x402_cold_transfers (
    id bigserial primary key,
    amount_micros bigint not null check (amount_micros > 0),
    state text not null check (state in ('signed', 'sent', 'confirmed', 'failed')),
    tx_signature text unique, wire_tx text, last_valid_block_height bigint,
    previous_signatures text[] not null default '{}',
    attempts int not null default 0,
    signing_slot bigint, landed_slot bigint, expiry_seen_slot bigint,
    created_at timestamptz not null default now(), confirmed_at timestamptz
);

-- every transaction that touched the hot USDC account, read once at finalized (7.9)
create table x402_chain_txs (
    signature text primary key,
    slot bigint not null,
    delta_micros bigint not null,                           -- the account's USDC change
    failed boolean not null,                                -- meta.err: moved no money
    matched text not null check (matched in
        ('payment', 'order', 'refund', 'cold_transfer', 'inflow', 'no_effect', 'unknown')),
    matched_id text,
    read_at timestamptz not null default now()
);
create index x402_chain_txs_slot on x402_chain_txs (slot);
create index x402_chain_txs_matched_id on x402_chain_txs (matched_id);

create table x402_tail (
    id int primary key check (id = 1),
    token_account text,                                     -- ATA(allowance_wallet), 7.3 check 4
    opening_balance_micros bigint not null default 0,
    opening_slot bigint not null default 0,
    opened_at timestamptz,                                  -- set with opening_slot (7.3 check 4)
    verified_slot bigint not null default 0,                -- only moves forward (7.9)
    verified_at timestamptz,
    finalized_height bigint not null default 0,             -- H0, for the resend rule (7.6)
    mismatch_since timestamptz
);
insert into x402_tail (id) values (1);

-- one row per incident fact (7.12), written with the pause, never repaired automatically
create table x402_incidents (
    id bigserial primary key,
    kind text not null check (kind in ('balance_mismatch', 'mirror_gap', 'balance_short',
        'unknown_change', 'token_account_changed', 'late_landing', 'double_transfer')),
    subject text not null,                                  -- a signature, or the kind
    loss_micros bigint not null default 0 check (loss_micros >= 0),   -- Bugnet's loss
    payment_id text references x402_payments (id),
    refund_id bigint references refunds (id),
    cold_transfer_id bigint references x402_cold_transfers (id),
    detail jsonb not null,
    created_at timestamptz not null default now(),
    resolved_at timestamptz, resolution text
);
create unique index x402_incidents_open on x402_incidents (kind, subject) where resolved_at is null;

create table x402_router_events (
    id bigserial primary key,
    kind text not null check (kind in ('allowance', 'x402_resolved')),
    start_order_id text not null references orders (id),
    order_id text references orders (id),
    phase text check (phase in ('paid', 'refunded', 'kept')),
    ref text,
    payload jsonb not null,
    state text not null default 'pending' check (state in ('pending', 'sent', 'dropped')),
    attempts int not null default 0,
    next_at timestamptz not null default now(),
    last_error text, dropped_reason text,
    created_at timestamptz not null default now(), sent_at timestamptz,
    unique (kind, order_id, phase),
    unique (kind, ref)
);
create index x402_router_events_due on x402_router_events (next_at) where state = 'pending';

create table x402_configure_requests (
    account_id text not null references x402_accounts (id),
    request_id text not null check (request_id ~ '^[A-Za-z0-9_-]{16,128}$'),
    request_sha256 bytea not null,
    answer jsonb not null,
    created_at timestamptz not null default now(),
    primary key (account_id, request_id)
);

create unique index x402_accounts_handle on x402_accounts (handle_sha256)
    where handle_sha256 is not null;
create index x402_accounts_close on x402_accounts (state, deadline) where state <> 'closed';
create index x402_fundings_account on x402_fundings (account_id);
create index events_start_order_type on events ((payload->>'order_id'), type);
create index refunds_allowance_open on refunds (state)
    where from_wallet = 'allowance' and state <> 'confirmed';
