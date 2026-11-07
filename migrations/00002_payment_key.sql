-- sha256 of the idempotency key of the request that settled the payment, null when it had none
alter table payments add column key_sha256 bytea;
