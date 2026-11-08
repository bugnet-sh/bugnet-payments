#!/usr/bin/env bash
# Installs bugnet-payments on the VPS, as README.md sections 1 to 10 lay out. Run as root.
#
#   vps-install.sh <bugnet-payments-VERSION.tgz> [--recipient ADDR] [--event-key B64]
#                  [--router-url URL] [--index FILE]
#   vps-install.sh --mtls <staging dir>   server certificate and key from bugnet-dev mtls init
#   vps-install.sh --pubkeys              order_token_public_key and the four wallet addresses
#   vps-install.sh --start                checks the settings, then starts the installed version
#
# Every step can run again. It prints addresses and variable names, never a secret value.
set -euo pipefail
umask 077

ETC=/etc/bugnet
TOML=$ETC/payments.toml
ENV_FILE=$ETC/payments.env
ROUTER_ENV=$ETC/router.env
RELEASE_FILE=$ETC/payments.release
OPT=/opt/bugnet/payments
UNIT_DIR=/etc/systemd/system
NODE_MAJOR=26
PNPM_VERSION=12.6.0
SVC_USER=bugnet-payments
DB=bugnet_payments
ROLE=bugnet_payments

die() {
    echo "vps-install: $*" >&2
    exit 1
}
say() { echo "== $*"; }

[ "$(id -u)" = 0 ] || die "run as root"

installed_version() {
    [ -f "$RELEASE_FILE" ] || die "no installed version yet, run the install step with the tarball first"
    cat "$RELEASE_FILE"
}

# Runs the release's CLI with the secrets loaded, in a subshell so nothing leaks into this shell
cli() {
    local v
    v=$(installed_version)
    (
        set -a
        # shellcheck disable=SC1090
        . "$ENV_FILE"
        set +a
        cd "$OPT/$v" && node dist/cli.js "$@"
    )
}

env_has() { grep -q "^$1=." "$ENV_FILE" 2>/dev/null; }
env_value() { sed -n "s/^$1=//p" "$2" | tail -n 1; }

ensure_node() {
    local major=0
    if command -v node >/dev/null 2>&1; then
        major=$(node -p 'process.versions.node.split(".")[0]')
    fi
    if [ "$major" -lt "$NODE_MAJOR" ] || [ "$(command -v node)" != /usr/bin/node ]; then
        say "installing Node $NODE_MAJOR"
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
        apt-get install -y nodejs
    fi
    [ "$(command -v node)" = /usr/bin/node ] || die "node must be /usr/bin/node for the unit"
    if [ "$(pnpm --version 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
        say "installing pnpm $PNPM_VERSION"
        npm install -g "pnpm@$PNPM_VERSION"
    fi
    say "node $(node --version), pnpm $(pnpm --version)"
}

ensure_user() {
    if ! id "$SVC_USER" >/dev/null 2>&1; then
        useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
        say "created user $SVC_USER"
    fi
}

install_code() {
    local tgz=$1 v=$2
    if [ ! -f "$OPT/$v/dist/main.js" ]; then
        say "unpacking $v into $OPT/$v"
        mkdir -p "$OPT/$v"
        tar xzf "$tgz" -C "$OPT/$v"
    fi
    if [ ! -d "$OPT/$v/node_modules" ]; then
        say "installing packages"
        (cd "$OPT/$v" && pnpm install --prod --frozen-lockfile)
    fi
    chown -R root:root "$OPT/$v"
    chmod -R go-w,a+rX "$OPT/$v"
    echo "$v" >"$RELEASE_FILE"
    chmod 0644 "$RELEASE_FILE"
}

# Puts a line in front of the first active local rule, where peer matching would otherwise stop
pg_insert_first() {
    local file=$1 line=$2
    grep -qxF "$line" "$file" && return 0
    awk -v add="$line" '
        !done && /^[[:space:]]*local[[:space:]]/ { print add; done = 1 }
        { print }
        END { if (!done) print add }
    ' "$file" >"$file.new"
    cat "$file.new" >"$file"
    rm -f "$file.new"
    say "added to $file: $line"
}

ensure_postgres() {
    local hba ident
    if [ "$(sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = '$ROLE'")" != 1 ]; then
        sudo -u postgres createuser "$ROLE"
        say "created role $ROLE"
    fi
    if [ "$(sudo -u postgres psql -tAc "select 1 from pg_database where datname = '$DB'")" != 1 ]; then
        sudo -u postgres createdb --owner "$ROLE" "$DB"
        say "created database $DB"
    fi
    hba=$(sudo -u postgres psql -tAc 'show hba_file')
    ident=$(sudo -u postgres psql -tAc 'show ident_file')
    pg_insert_first "$hba" "local   $DB   $ROLE   peer map=bugnet"
    if ! grep -qE "^[[:space:]]*bugnet[[:space:]]+${SVC_USER}[[:space:]]+${ROLE}[[:space:]]*\$" "$ident"; then
        printf 'bugnet   %s   %s\n' "$SVC_USER" "$ROLE" >>"$ident"
        say "added to $ident: bugnet $SVC_USER $ROLE"
    fi
    systemctl reload postgresql
}

ensure_keys() {
    mkdir -p "$ETC"
    chmod 0755 "$ETC"
    [ -f "$ENV_FILE" ] || install -o root -g root -m 0600 /dev/null "$ENV_FILE"
    say "generating any missing keys in $ENV_FILE (addresses only)"
    # The recipient is the founder's cold wallet, so its generated key is dropped and its address hidden
    cli keys generate --env "$ENV_FILE" | { grep -v '^recipient=' || true; }
    sed -i '/^BUGNET_RECIPIENT_KEY=/d' "$ENV_FILE"
    chown root:root "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
}

ensure_router_token() {
    local mine theirs
    if [ ! -f "$ROUTER_ENV" ]; then
        echo "vps-install: $ROUTER_ENV is missing, so BUGNET_PAYMENTS_ROUTER_TOKEN is not set yet; run the router's deploy, then this again" >&2
        return 0
    fi
    mine=$(env_value BUGNET_PAYMENTS_ROUTER_TOKEN "$ENV_FILE")
    theirs=$(env_value BUGNET_PAYMENTS_ROUTER_TOKEN "$ROUTER_ENV")
    if [ -z "$mine" ] && [ -z "$theirs" ]; then
        mine=$(openssl rand -base64 32)
        printf 'BUGNET_PAYMENTS_ROUTER_TOKEN=%s\n' "$mine" >>"$ENV_FILE"
        printf 'BUGNET_PAYMENTS_ROUTER_TOKEN=%s\n' "$mine" >>"$ROUTER_ENV"
        say "BUGNET_PAYMENTS_ROUTER_TOKEN generated into both env files"
    elif [ -z "$mine" ]; then
        printf 'BUGNET_PAYMENTS_ROUTER_TOKEN=%s\n' "$theirs" >>"$ENV_FILE"
        say "BUGNET_PAYMENTS_ROUTER_TOKEN copied from $ROUTER_ENV"
    elif [ -z "$theirs" ]; then
        printf 'BUGNET_PAYMENTS_ROUTER_TOKEN=%s\n' "$mine" >>"$ROUTER_ENV"
        say "BUGNET_PAYMENTS_ROUTER_TOKEN copied to $ROUTER_ENV"
    elif [ "$mine" != "$theirs" ]; then
        die "BUGNET_PAYMENTS_ROUTER_TOKEN differs between $ENV_FILE and $ROUTER_ENV, fix one by hand"
    else
        say "BUGNET_PAYMENTS_ROUTER_TOKEN already set in both"
    fi
}

allowance_address() { cli keys show --no-balances | sed -n 's/^allowance=//p'; }

# Sets one key inside one [section], so the two url keys never touch each other
toml_set() {
    local section=$1 key=$2 value=$3
    awk -v sec="[$section]" -v key="$key" -v val="$value" '
        /^\[/ { cur = $0 }
        cur == sec && $0 ~ "^" key " = " { print key " = \"" val "\""; next }
        { print }
    ' "$TOML" >"$TOML.new"
    cat "$TOML.new" >"$TOML"
    rm -f "$TOML.new"
}

ensure_toml() {
    local recipient=$1 event_key=$2 router_url=$3 allowance
    allowance=$(allowance_address)
    if [ ! -f "$TOML" ]; then
        cat >"$TOML" <<EOF
# Production settings, only what differs from config/example.toml; no secrets here

[database]
url = "postgres://$ROLE@/$DB?host=/var/run/postgresql"

[solana]
# The founder's cold wallet, whose USDC account already exists
recipient = "<founder cold recipient address>"

[router]
url = "http://127.0.0.1:8080"
get_order = true
check_payer = true
token_payer_claims = true
allowance_claim = true
# Standard base64 of the router's event public key
event_public_key = "<router event public key>"

[x402]
enabled = true
allowance_wallet = "$allowance"
indexed_services_file = "$ETC/payments/x402-index.json"
EOF
        say "wrote $TOML"
    fi
    [ -z "$recipient" ] || toml_set solana recipient "$recipient"
    [ -z "$event_key" ] || toml_set router event_public_key "$event_key"
    [ -z "$router_url" ] || toml_set router url "$router_url"
    toml_set x402 allowance_wallet "$allowance"
    chown root:root "$TOML"
    chmod 0644 "$TOML"
}

ensure_index() {
    local index=$1
    install -d -o root -g root -m 0755 "$ETC/payments"
    if [ -n "$index" ]; then
        install -o "$SVC_USER" -g "$SVC_USER" -m 0644 "$index" "$ETC/payments/x402-index.json"
        say "installed the x402 index from $index"
    elif [ ! -f "$ETC/payments/x402-index.json" ]; then
        printf '{ "v": 1, "services": [] }\n' >"$ETC/payments/x402-index.json"
        chown "$SVC_USER:$SVC_USER" "$ETC/payments/x402-index.json"
        chmod 0644 "$ETC/payments/x402-index.json"
        say "wrote an empty x402 index; pass --index with the gateway's index.json to fill it"
    fi
}

ensure_unit() {
    local v=$1
    install -o root -g root -m 0644 "$OPT/$v/deploy/bugnet-payments@.service" "$UNIT_DIR/"
    systemctl daemon-reload
    systemctl enable "bugnet-payments@$v"
    say "bugnet-payments@$v enabled, not started (run --start once the settings are complete)"
}

do_install() {
    local tgz=$1 recipient=$2 event_key=$3 router_url=$4 index=$5 v
    [ -f "$tgz" ] || die "no such file: $tgz"
    v=$(basename "$tgz" .tgz)
    v=${v#bugnet-payments-}
    [ -n "$v" ] && [ "$v" != "$(basename "$tgz" .tgz)" ] || die "the tarball must be bugnet-payments-<version>.tgz"
    ensure_node
    ensure_user
    install_code "$tgz" "$v"
    ensure_postgres
    ensure_keys
    ensure_router_token
    ensure_toml "$recipient" "$event_key" "$router_url"
    ensure_index "$index"
    ensure_unit "$v"
    do_pubkeys
    say "next: fund the wallets, set BUGNET_SOLANA_RPC_URL in $ENV_FILE (sudoedit), run --mtls, then --start"
}

do_mtls() {
    local dir=$1 line
    [ -f "$dir/etc/bugnet/internal-ca.pem" ] || die "$dir has no etc/bugnet/internal-ca.pem"
    [ -f "$dir/etc/bugnet/payments/x402-server.pem" ] || die "$dir has no etc/bugnet/payments/x402-server.pem"
    [ -f "$dir/payments.env.add" ] || die "$dir has no payments.env.add"
    line=$(grep '^BUGNET_X402_TLS_KEY=.' "$dir/payments.env.add" | tail -n 1)
    [ -n "$line" ] || die "$dir/payments.env.add holds no BUGNET_X402_TLS_KEY line"
    install -o root -g root -m 0644 "$dir/etc/bugnet/internal-ca.pem" "$ETC/internal-ca.pem"
    install -d -o root -g root -m 0755 "$ETC/payments"
    install -o "$SVC_USER" -g "$SVC_USER" -m 0644 "$dir/etc/bugnet/payments/x402-server.pem" \
        "$ETC/payments/x402-server.pem"
    sed -i '/^BUGNET_X402_TLS_KEY=/d' "$ENV_FILE"
    printf '%s\n' "$line" >>"$ENV_FILE"
    # The staging copy of the server key goes; egress's client pair stays for the router's deploy
    shred -u "$dir/payments.env.add" 2>/dev/null || rm -f "$dir/payments.env.add"
    say "installed internal-ca.pem and x402-server.pem, BUGNET_X402_TLS_KEY set, staging server key removed"
    if systemctl is-active --quiet "bugnet-payments@$(installed_version)"; then
        say "restart bugnet-payments@$(installed_version) to load the new key"
    fi
}

do_pubkeys() {
    local recipient
    say "public values (no secrets)"
    echo "order_token_public_key=$(cli keys pubkey)"
    cli keys show --no-balances | grep -E '^(fee_payer|refund|allowance)='
    recipient=$(sed -n 's/^recipient = "\(.*\)"$/\1/p' "$TOML" 2>/dev/null || true)
    echo "recipient=${recipient:-<not set>}"
}

do_start() {
    local v ok=1 old
    v=$(installed_version)
    grep -q '<' "$TOML" && { echo "fill the <...> values in $TOML" >&2; ok=0; }
    for name in BUGNET_SOLANA_RPC_URL BUGNET_PAYMENTS_TOKEN BUGNET_PAYMENTS_ROUTER_TOKEN \
        BUGNET_ORDER_PRIVATE_KEY BUGNET_CLAIM_KEY BUGNET_FEE_PAYER_KEY BUGNET_REFUND_KEY \
        BUGNET_ALLOWANCE_KEY BUGNET_X402_TLS_KEY; do
        env_has "$name" || { echo "$ENV_FILE has no $name" >&2; ok=0; }
    done
    for f in "$ETC/internal-ca.pem" "$ETC/payments/x402-server.pem" "$ETC/payments/x402-index.json"; do
        [ -f "$f" ] || { echo "missing $f" >&2; ok=0; }
    done
    [ "$ok" = 1 ] || die "not starting"
    for old in $(systemctl list-units --all --plain --no-legend 'bugnet-payments@*' | awk '{print $1}'); do
        [ "$old" = "bugnet-payments@$v.service" ] && continue
        systemctl disable --now "$old"
        say "stopped $old"
    done
    systemctl enable --now "bugnet-payments@$v"
    for _ in $(seq 1 60); do
        if curl -fsS http://127.0.0.1:8447/healthz >/dev/null 2>&1 &&
            curl -fsS http://127.0.0.1:8450/healthz >/dev/null 2>&1; then
            say "bugnet-payments@$v is up on 8447 and 8450"
            journalctl -u "bugnet-payments@$v" -o cat --since -2min | grep -E '"level":"(alarm|error)"' || true
            return 0
        fi
        sleep 1
    done
    journalctl -u "bugnet-payments@$v" -o cat --since -2min | grep -E 'boot check failed|"level":"(alarm|error)"' | tail -n 5 || true
    die "bugnet-payments@$v did not answer healthz within 60 s"
}

main() {
    local tgz="" recipient="" event_key="" router_url="" index="" mode=install mtls=""
    [ $# -gt 0 ] || die "usage: see the comment at the top of this file"
    while [ $# -gt 0 ]; do
        case $1 in
        --recipient) recipient=${2:?}; shift 2 ;;
        --event-key) event_key=${2:?}; shift 2 ;;
        --router-url) router_url=${2:?}; shift 2 ;;
        --index) index=${2:?}; shift 2 ;;
        --mtls) mode=mtls; mtls=${2:?}; shift 2 ;;
        --pubkeys) mode=pubkeys; shift ;;
        --start) mode=start; shift ;;
        -*) die "unknown option $1" ;;
        *) tgz=$1; shift ;;
        esac
    done
    case $mode in
    install) [ -n "$tgz" ] || die "the install step needs the tarball"; do_install "$tgz" "$recipient" "$event_key" "$router_url" "$index" ;;
    mtls) do_mtls "$mtls" ;;
    pubkeys) do_pubkeys ;;
    start) do_start ;;
    esac
}

main "$@"
