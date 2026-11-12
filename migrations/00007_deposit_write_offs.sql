-- A debit Bugnet did not sign, written off by an operator (spec 23.1): one row per deposit the
-- transaction debited
create table deposit_write_offs (
    order_id text not null references deposits (order_id),
    signature text not null,
    slot bigint not null,
    micros bigint not null check (micros > 0),
    written_at timestamptz not null,
    primary key (order_id, signature)
);

-- The debit split onto the senders' transfers; refund_id is the float payout of a part whose
-- sender is known
create table deposit_write_off_parts (
    order_id text not null,
    signature text not null,
    transfer_signature text not null,
    micros bigint not null check (micros > 0),
    refund_id bigint references refunds (id),
    primary key (order_id, signature, transfer_signature),
    foreign key (order_id, signature) references deposit_write_offs (order_id, signature),
    foreign key (order_id, transfer_signature) references deposit_transfers (order_id, signature)
);
create index deposit_write_off_parts_refund on deposit_write_off_parts (refund_id)
    where refund_id is not null;

alter table refunds drop constraint refunds_reason_check;
alter table refunds add constraint refunds_reason_check check (reason in
    ('unredeemed', 'late', 'router_refundable', 'abandoned', 'no_router_record', 'operator',
     'x402_unspent', 'x402_ceiling', 'x402_closed', 'deposit_held', 'deposit_write_off'));
alter table refunds drop constraint refunds_deposit_check;
alter table refunds add constraint refunds_deposit_check
    check ((kind = 'deposit') = (reason in ('deposit_held', 'deposit_write_off'))
        and (kind = 'deposit') = (deposit_signature is not null)
        and (kind <> 'deposit' or from_wallet = 'refund'));
-- one held return and one write-off payout per transfer
drop index refunds_deposit_once;
create unique index refunds_deposit_once on refunds (order_id, deposit_signature, reason)
    where kind = 'deposit';

alter table failed_payments drop constraint failed_payments_reason_check;
alter table failed_payments add constraint failed_payments_reason_check
    check (reason in ('onchain_failed', 'blockhash_expired', 'written_off'));
