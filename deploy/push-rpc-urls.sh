#!/usr/bin/env bash
# Copies the BUGNET_SOLANA_RPC_URLS line of the local .env to the server's payments.env, through
# the installed release's vps-install.sh --rpc-urls. Run in bugnet-payments on the Mac:
#
#   deploy/push-rpc-urls.sh [ssh options] HOST
#   for example: deploy/push-rpc-urls.sh -p 2222 -i ~/.ssh/bugnet_deploy bugnet@62.72.21.74
#
# The line only travels through pipes: never an argument, an echoed variable or a file, so it
# shows in no process list and no shell history. It prints counts and names, never a URL.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# The same rule as the server's check, so a line the server would refuse never leaves the Mac
VPS_INSTALL_LIB=1 . "$here/vps-install.sh"
die() {
    echo "push-rpc-urls: $*" >&2
    exit 1
}

env_file=${BUGNET_LOCAL_ENV:-.env}
[ $# -ge 1 ] || {
    echo "usage: deploy/push-rpc-urls.sh [ssh options] HOST" >&2
    exit 2
}
[ -f "$env_file" ] || die "$env_file not found; run this in bugnet-payments"
n=$(grep -c '^BUGNET_SOLANA_RPC_URLS=' "$env_file" || true)
[ "$n" = 1 ] || die "$env_file must hold exactly one BUGNET_SOLANA_RPC_URLS line, it holds $n"
grep '^BUGNET_SOLANA_RPC_URLS=' "$env_file" | rpc_list_ok || die "nothing was sent"
grep '^BUGNET_SOLANA_RPC_URLS=' "$env_file" |
    ssh "$@" 'sudo -n /opt/bugnet/payments/$(cat /etc/bugnet/payments.release)/deploy/vps-install.sh --rpc-urls'
