alter table orders drop constraint orders_paid_via_check;
alter table orders add constraint orders_paid_via_check
    check (paid_via in ('checkout', 'pay_cli', 'transfer'));
-- false when the order token names no payer: a payment shared by several owners (10.5)
alter table payments add column payer_counted boolean not null default true;
-- the applied money came from more than one owner: later refunds are split (D5, 10.9)
alter table payments add column multi_sender boolean not null default false;
-- the smallest split part, [deposits] refund_min_micros at settle time (10.9)
alter table payments add column split_min_micros bigint check (split_min_micros >= 0);
alter table payments add constraint payments_split_check
    check (multi_sender = (split_min_micros is not null)
        and payer_counted = (not multi_sender));

-- each owner's applied part of a multi-sender payment, largest first (a tie goes to the owner
-- whose first transfer came first)
create table payment_shares (
    order_id text not null references orders (id),
    part smallint not null check (part >= 0),
    owner text not null,
    source_token_account text not null,
    applied_micros bigint not null check (applied_micros > 0),
    primary key (order_id, part),
    unique (order_id, owner)
);

-- one refund row per owner share (D5); 'deposit' rows return held review money (10.9, 17)
alter table refunds add column part smallint not null default 0 check (part >= 0);
alter table refunds drop constraint refunds_order_id_kind_key;
alter table refunds add constraint refunds_order_kind_part unique (order_id, kind, part);
alter table refunds drop constraint refunds_kind_check;
alter table refunds add constraint refunds_kind_check
    check (kind in ('full', 'partial', 'allowance', 'deposit'));
alter table refunds drop constraint refunds_reason_check;
alter table refunds add constraint refunds_reason_check check (reason in
    ('unredeemed', 'late', 'router_refundable', 'abandoned', 'no_router_record', 'operator',
     'x402_unspent', 'x402_ceiling', 'x402_closed', 'deposit_held'));
alter table refunds add column deposit_signature text;
alter table refunds add constraint refunds_deposit_check
    check ((kind = 'deposit') = (reason = 'deposit_held')
        and (kind = 'deposit') = (deposit_signature is not null)
        and (kind <> 'deposit' or from_wallet = 'refund'));
-- one return of one held transfer, whatever the operator types twice
create unique index refunds_deposit_once on refunds (order_id, deposit_signature)
    where kind = 'deposit';

create table deposits (
    order_id text primary key references orders (id),
    address text not null unique,
    token_account text not null unique,
    key_version int not null check (key_version > 0),
    salt bytea not null check (length(salt) = 16),
    state text not null default 'open'
        check (state in ('open', 'settling', 'draining', 'closed', 'done')),
    balance_micros bigint not null default 0 check (balance_micros >= 0),
    last_signature text,
    scan_slot bigint,
    scan_top text,
    scan_before text,
    rent_payer text,
    -- HMAC-SHA256 of the viewer's IP key and /48 (5), set when the job first sees a viewer
    viewer_key text,
    viewer_block text,
    review_reason text
        check (review_reason in ('unknown_debit', 'double_sweep', 'moves_failing',
            'move_expired_repeatedly')),
    -- a hold that stops every owner; holds of one owner are deposit_holds rows
    hold_reason text check (hold_reason in ('allowance_paused', 'router_unavailable')),
    -- set by deposits retry: rule 7 counts only sweeps that failed after it, so a retried
    -- deposit gets a fresh max_attempts without losing its failure history (17)
    moves_failing_reset_at timestamptz,
    recheck_at timestamptz,
    expiry_due_at timestamptz,
    hard_stop_at timestamptz,
    expiry_min_slot bigint,
    close_separately boolean not null default false,
    close_failures int not null default 0,
    close_after timestamptz,
    stable_since timestamptz,
    late_returns int not null default 0,
    created_at timestamptz not null,
    ready_at timestamptz,
    checked_at timestamptz,
    checked_slot bigint,
    settled_at timestamptz,
    closed_at timestamptz,
    watch_until timestamptz
);
create index deposits_watched on deposits (state) where state <> 'done';
create index deposits_viewer on deposits (viewer_key) where state in ('open', 'settling');

-- one owner the router holds at settle (10.1); owner '' is the owner set of a shared payment
-- waiting for the anonymous pool
create table deposit_holds (
    order_id text not null references deposits (order_id),
    owner text not null,
    reason text not null check (reason in ('payer_busy', 'payer_rate_limited', 'anonymous_busy')),
    recheck_at timestamptz not null,
    since timestamptz not null,
    primary key (order_id, owner),
    check ((owner = '') = (reason = 'anonymous_busy'))
);

create table deposit_transfers (
    order_id text not null references deposits (order_id),
    signature text not null,
    slot bigint not null,
    seq int not null,
    block_time timestamptz not null,
    seen_at timestamptz not null,
    amount_micros bigint not null check (amount_micros > 0),
    source_token_account text,
    source_owner text,
    source_balance_micros bigint,
    outcome text not null default 'open'
        check (outcome in ('open', 'paid', 'return', 'keep', 'review')),
    applied_micros bigint not null default 0
        check (applied_micros >= 0 and applied_micros <= amount_micros),
    reason text check (reason in ('extra', 'unpaid', 'late', 'after_paid', 'paid_otherwise',
        'payer_blocked', 'payer_busy', 'payer_rate_limited', 'pool_busy', 'router_unavailable',
        'allowance_unavailable', 'below_minimum', 'operator', 'unattributed', 'unreadable',
        'from_bugnet', 'late_limit', 'return_destination_invalid', 'return_failed')),
    blocked_until timestamptz,
    move_id bigint,
    refund_id bigint references refunds (id),
    -- one transaction can credit several deposits, an exchange batch for example
    primary key (order_id, signature)
);
create index deposit_transfers_signature on deposit_transfers (signature);

create table deposit_moves (
    id bigserial primary key,
    order_id text not null references deposits (order_id),
    kind text not null check (kind in ('create', 'sweep', 'return', 'close')),
    amount_micros bigint not null default 0 check (amount_micros >= 0),
    keep_micros bigint not null default 0 check (keep_micros >= 0),
    held_micros bigint not null default 0 check (held_micros >= 0),
    destination text,
    payer text,
    memo text,
    closes boolean not null default false,
    close_to text,
    state text not null default 'pending'
        check (state in ('pending', 'signed', 'sent', 'confirmed', 'failed', 'manual')),
    tx_signature text unique,
    wire_tx text,
    last_valid_block_height bigint,
    previous_signatures text[] not null default '{}',
    attempts int not null default 0,
    landed_slot bigint,
    expiry_seen_slot bigint,
    preflight_refused_at timestamptz,
    manual_reason text,
    created_at timestamptz not null,
    signed_at timestamptz,
    sent_at timestamptz,
    confirmed_at timestamptz,
    failed_at timestamptz,
    check ((kind in ('sweep', 'return')) = (amount_micros > 0)),
    check ((kind = 'return') = (payer is not null)),
    check ((keep_micros = 0 and held_micros = 0) or (kind in ('return', 'close') and closes)),
    check (landed_slot is null or state <> 'failed')
);
-- one transaction in flight per deposit, so the planner never races its own moves
create unique index deposit_moves_one_in_flight on deposit_moves (order_id)
    where state in ('pending', 'signed', 'sent');
