create table rpc_usage (
    endpoint text not null check (endpoint ~ '^rpc[1-9][0-9]*$'),
    month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
    requests bigint not null default 0,
    background bigint not null default 0,
    primary key (endpoint, month)
);

create table rpc_health (
    id boolean primary key default true check (id),
    snapshot jsonb not null,
    written_at timestamptz not null
);

create table rpc_verdicts (
    fingerprint text primary key check (fingerprint ~ '^[0-9a-f]{32}$'),
    endpoint text not null check (endpoint ~ '^rpc[1-9][0-9]*$'),
    inconsistent_at timestamptz,
    inconsistent_reason text
        check (inconsistent_reason in ('found_then_missing', 'slot_went_back', 'check_disagreed')),
    history_passed boolean not null default false,
    updated_at timestamptz not null,
    check ((inconsistent_at is null) = (inconsistent_reason is null))
);
