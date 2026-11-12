#!/usr/bin/env bash
# Copies the BUGNET_PAYMENTS_TOKEN line of the local .env to the server's payments.env, through
# the installed release's vps-install.sh --payments-token. The gateway sends the same token, so
# the local .env holds the one value both use. Run in bugnet-payments on the Mac:
#
#   deploy/push-payments-token.sh [ssh options] HOST
#   for example: deploy/push-payments-token.sh -p PORT -i KEY_FILE USER@HOST
#
# It sends that one line and no other. The line only travels through pipes: never an argument, an
# echoed variable or a file, so it shows in no process list and no shell history. It prints names
# only, never the value.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# The same rule as the server's check, so a line the server would refuse never leaves the Mac
# shellcheck source=SCRIPTDIR/vps-install.sh
VPS_INSTALL_LIB=1 . "$here/vps-install.sh"
die() {
    echo "push-payments-token: $*" >&2
    exit 1
}

env_file=${BUGNET_LOCAL_ENV:-.env}
[ $# -ge 1 ] || {
    echo "usage: deploy/push-payments-token.sh [ssh options] HOST" >&2
    exit 2
}
[ -f "$env_file" ] || die "$env_file not found; run this in bugnet-payments"
n=$(grep -c '^BUGNET_PAYMENTS_TOKEN=' "$env_file" || true)
[ "$n" = 1 ] || die "$env_file must hold exactly one BUGNET_PAYMENTS_TOKEN line, it holds $n"
grep '^BUGNET_PAYMENTS_TOKEN=' "$env_file" | payments_token_ok || die "nothing was sent"
# -T: a remote terminal would echo the line back to this screen; an option beats ~/.ssh/config
grep '^BUGNET_PAYMENTS_TOKEN=' "$env_file" |
    ssh -T "$@" 'sudo -n /opt/bugnet/payments/$(cat /etc/bugnet/payments.release)/deploy/vps-install.sh --payments-token'
