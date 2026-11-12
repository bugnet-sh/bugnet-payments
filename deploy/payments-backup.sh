#!/usr/bin/env bash
# Dumps the bugnet_payments database into /var/backups/bugnet-payments and keeps the newest 14
# dumps (spec 23.2, D10). Run as root: every night by bugnet-payments-backup.timer, and by
# vps-install.sh --backup and --start. The database only: payments.env is never part of a backup.
# Prints the dump's path and size, never a secret.
set -euo pipefail
umask 077

BACKUP_DIR=${BUGNET_PAYMENTS_BACKUP_DIR:-/var/backups/bugnet-payments}
DB=bugnet_payments
PG_USER=postgres

die() {
    echo "payments-backup: $*" >&2
    exit 1
}
say() { echo "== $*"; }

# pg_dump runs as postgres, which cannot enter root's working directory and would warn about it
cd /
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

final="$BACKUP_DIR/$DB-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp=$(mktemp "$final.XXXXXX")
# postgres cannot write into the root-only folder, so the dump comes back through this shell
runuser -u "$PG_USER" -- pg_dump --format=custom "$DB" >"$tmp"
pg_restore --list "$tmp" >/dev/null
chmod 0600 "$tmp"
mv -f "$tmp" "$final"
say "wrote $final ($(wc -c <"$final" | tr -d ' ') bytes)"
