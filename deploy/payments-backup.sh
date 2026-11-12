#!/usr/bin/env bash
# Dumps the bugnet_payments database into /var/backups/bugnet-payments and keeps the newest 14
# dumps (spec 23.2, D10). Run as root: every night by bugnet-payments-backup.timer, and by
# vps-install.sh --backup and --start. The database only: payments.env is never part of a backup.
# Prints the dump's path and size, never a secret.
set -euo pipefail
umask 077

BACKUP_DIR=${BUGNET_PAYMENTS_BACKUP_DIR:-/var/backups/bugnet-payments}
KEEP=${BUGNET_PAYMENTS_BACKUP_KEEP:-14}
DB=bugnet_payments
PG_USER=postgres

die() {
    echo "payments-backup: $*" >&2
    exit 1
}
say() { echo "== $*"; }

case $KEEP in
*[!0-9]* | 0*) die "BUGNET_PAYMENTS_BACKUP_KEEP must be a whole number of at least 1" ;;
esac

# pg_dump runs as postgres, which cannot enter root's working directory and would warn about it
cd /
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

final="$BACKUP_DIR/$DB-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp=$(mktemp "$final.XXXXXX") || die "cannot create a temporary file in $BACKUP_DIR"
# shellcheck disable=SC2064
trap "rm -f -- $(printf '%q' "$tmp")" EXIT
trap 'exit 1' INT TERM HUP
# postgres cannot write into the root-only folder, so the dump comes back through this shell
runuser -u "$PG_USER" -- pg_dump --format=custom "$DB" >"$tmp" ||
    die "pg_dump of $DB failed; no dump was written"
pg_restore --list "$tmp" >/dev/null ||
    die "pg_restore --list cannot read the dump of $DB; no dump was written"
if ! chmod 0600 "$tmp" || ! mv -f "$tmp" "$final"; then
    die "cannot rename the dump to $final"
fi
trap - EXIT INT TERM HUP
say "wrote $final ($(wc -c <"$final" | tr -d ' ') bytes)"

# The UTC stamp sorts by time, so the newest dumps come first. Only regular files named as this
# script names its dumps count or go.
re="^$DB-[0-9]{8}T[0-9]{6}Z[.]dump\$"
for path in "$BACKUP_DIR/$DB"-*.dump; do
    if [[ ${path##*/} =~ $re ]] && [ -f "$path" ]; then echo "${path##*/}"; fi
done | sort -r | tail -n "+$((KEEP + 1))" | while IFS= read -r name; do
    rm -f -- "$BACKUP_DIR/$name"
    say "removed $name"
done

# A run killed outright (SIGKILL, power loss) skips its trap; no run lasts a day
find "$BACKUP_DIR" -maxdepth 1 -type f -name "$DB-????????T??????Z.dump.??????" -mmin +1440 |
    while IFS= read -r path; do
        rm -f -- "$path"
        say "removed ${path##*/}, left by a stopped run"
    done
