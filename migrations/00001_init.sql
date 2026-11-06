create table orders (
    id text primary key check (id ~ '^ord_[a-z2-7]{26}$'),
    kind text not null check (kind in ('start', 'extend')),
    package_id text not null,
    amount_micros bigint not null check (amount_micros > 0),
    handle_sha256 text check (handle_sha256 ~ '^[0-9a-f]{64}$'),
    description text not null,
    claim_sha256 bytea not null,
    claim_box bytea,
    idempotency_key text unique,
    state text not null check (state in
        ('unpaid','settling','paid','redeemed','refunding','refunded','expired','manual')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    paid_at timestamptz,
    payer text,
    redeemed_at timestamptz,
    token_expires_at timestamptz,
    event_seen_at timestamptz,
    router_confirmed_at timestamptz,
    abandon_reason text,
    abandon_at timestamptz,
    manual_reason text,
    check ((kind = 'extend') = (handle_sha256 is not null))
);
create index orders_state on orders (state);
create table payments (
    order_id text not null unique references orders(id),
    tx_signature text not null unique,
    message_hash text not null unique,
    payer text not null,
    source_token_account text not null,
    amount_micros bigint not null,
    blockhash text not null,
    last_valid_block_height bigint not null,
    status text not null check (status in ('settling', 'confirmed')),
    created_at timestamptz not null default now(),
    confirmed_at timestamptz
);
create table failed_payments (
    id bigserial primary key,
    order_id text not null references orders(id),
    tx_signature text not null,
    message_hash text not null,
    payer text not null,
    amount_micros bigint not null,
    reason text not null check (reason in ('onchain_failed', 'blockhash_expired')),
    failed_at timestamptz not null default now()
);
create table refunds (
    id bigserial primary key,
    order_id text not null references orders(id),
    kind text not null check (kind in ('full', 'partial')),
    reason text not null check (reason in
        ('unredeemed','late','router_refundable','abandoned','no_router_record','operator')),
    amount_micros bigint not null check (amount_micros > 0),
    destination text not null,
    payer text not null,
    state text not null check (state in ('pending','signed','sent','confirmed','manual')),
    tx_signature text unique,
    wire_tx text,
    last_valid_block_height bigint,
    previous_signatures text[] not null default '{}',
    attempts int not null default 0,
    manual_reason text,
    created_at timestamptz not null default now(),
    signed_at timestamptz,
    sent_at timestamptz,
    confirmed_at timestamptz,
    unique (order_id, kind)
);
create table refund_controls (
    id int primary key check (id = 1),
    paused boolean not null default false,
    reason text,
    paused_at timestamptz
);
insert into refund_controls (id) values (1);
create table events (
    event_id text primary key,
    type text not null,
    created_at timestamptz not null,
    received_at timestamptz not null default now(),
    order_id text,
    payload jsonb not null
);
create table audit_checkpoints (
    name text primary key,
    signature text not null,
    updated_at timestamptz not null default now()
);
