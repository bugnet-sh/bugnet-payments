#!/usr/bin/env bash
# Retires the previous deposit seed into the offline archive on this Mac (spec 4.3, D8 A), through
# the installed release's vps-install.sh --retire-deposit-seed -. Run on the Mac:
#
#   deploy/retire-deposit-seed.sh [ssh options] HOST
#   for example: deploy/retire-deposit-seed.sh -p PORT -i KEY_FILE USER@HOST
#
# The archive is BUGNET_DEPOSIT_ARCHIVE, by default ~/.bugnet/deposit-seeds.env: mode 0600, never
# inside a git checkout, kept with the database backups. The server prints the archive line and
# removes nothing; this script appends it, reads it back, and only then sends it back, and the
# server removes BUGNET_DEPOSIT_SEED_PREVIOUS only when it matches. So a seed lost in transit is
# never removed. The seed moves only through pipes and shell builtins: never an argument, so it
# shows in no process list, and never printed. It prints names only.
set -euo pipefail

die() {
    echo "retire-deposit-seed: $*" >&2
    exit 1
}

archive=${BUGNET_DEPOSIT_ARCHIVE:-$HOME/.bugnet/deposit-seeds.env}
[ $# -ge 1 ] || {
    echo "usage: deploy/retire-deposit-seed.sh [ssh options] HOST" >&2
    exit 2
}
dir=$(dirname "$archive")
# Checked on the nearest folder that exists, before anything is made inside a checkout
near=$dir
while [ ! -d "$near" ]; do near=$(dirname "$near"); done
if git -C "$near" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "$archive is inside a git checkout; set BUGNET_DEPOSIT_ARCHIVE to a path outside one"
fi
# Expanded on the server, as push-rpc-urls.sh does
# shellcheck disable=SC2016
remote='sudo -n /opt/bugnet/payments/$(cat /etc/bugnet/payments.release)/deploy/vps-install.sh --retire-deposit-seed -'

# shellcheck disable=SC2029
line=$(ssh "$@" "$remote" </dev/null) || die "the server refused; nothing was archived or removed"
if [ -z "$line" ]; then
    echo "nothing to retire"
    exit 0
fi
seed_re='^BUGNET_DEPOSIT_SEED_V[1-9][0-9]*=[A-Za-z0-9+/]{43}=$'
[[ $line =~ $seed_re ]] || die "the server sent no archive line; nothing was archived or removed"
name=${line%%=*}

# The archive line of this version, or "" when there is none; a second, different one refuses
archived() {
    local l found=""
    [ -f "$archive" ] || return 0
    while IFS= read -r l || [ -n "$l" ]; do
        case $l in
        "$name="*)
            [ -z "$found" ] || [ "$found" = "$l" ] || die "$archive holds $name twice; nothing removed"
            found=$l
            ;;
        esac
    done <"$archive"
    printf '%s' "$found"
}

if [ ! -d "$dir" ]; then
    mkdir -p "$(dirname "$dir")"
    mkdir -m 700 "$dir"
fi
kept=$(archived)
if [ -z "$kept" ]; then
    (
        umask 077
        # A last line without its newline would join the new one
        if [ -s "$archive" ] && [ -n "$(tail -c 1 "$archive")" ]; then printf '\n' >>"$archive"; fi
        printf '%s\n' "$line" >>"$archive"
    )
    echo "appended $name to $archive"
elif [ "$kept" != "$line" ]; then
    die "$archive already holds $name with another value; nothing removed"
fi
chmod 600 "$archive"

back=$(archived)
[ "$back" = "$line" ] || die "$name did not read back from $archive; nothing removed"
# shellcheck disable=SC2029
printf '%s\n' "$back" | ssh "$@" "$remote --remove-previous" ||
    die "the server kept BUGNET_DEPOSIT_SEED_PREVIOUS; $name stays in $archive"
echo "$name is in $archive and no longer on the server"
