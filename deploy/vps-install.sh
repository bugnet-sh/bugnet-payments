#!/usr/bin/env bash
# Installs bugnet-payments on the VPS, as README.md sections 1 to 10 and 13 lay out. Run as root.
#
#   vps-install.sh <bugnet-payments-VERSION.tgz> [--recipient ADDR] [--event-key B64]
#                  [--router-url URL] [--index FILE]
#   vps-install.sh --mtls <staging dir>   server certificate and key from bugnet-dev mtls init
#   vps-install.sh --pubkeys              order_token_public_key and the four wallet addresses
#   vps-install.sh --start                checks the settings, backs up the database, then starts or
#                                         restarts the installed version
#   vps-install.sh --backup               dumps the database into /var/backups/bugnet-payments now
#   vps-install.sh --rpc-urls             reads one BUGNET_SOLANA_RPC_URLS line on stdin into
#                                         payments.env; deploy/push-rpc-urls.sh sends it
#   vps-install.sh --payments-token       reads one BUGNET_PAYMENTS_TOKEN line on stdin into
#                                         payments.env; deploy/push-payments-token.sh sends it
#   vps-install.sh --deposits on|off      sets [deposits] enabled and restarts the running version;
#                                         on needs the RPC router release and a passing rpc probe
#   vps-install.sh --deposits remove      before a rollback below the deposits release: removes
#                                         [deposits] once deposits are off and no deposit is open,
#                                         settling, draining or has a move in flight
#   vps-install.sh --rotate-deposit-seed  makes a new deposit seed; the old one stays as
#                                         BUGNET_DEPOSIT_SEED_PREVIOUS until it is retired
#   vps-install.sh --retire-deposit-seed - [--remove-previous]
#                                         once every deposit of the old seed is done: prints the
#                                         archive line; with --remove-previous, removes the seed
#                                         once stdin holds that line.
#                                         deploy/retire-deposit-seed.sh runs both on the Mac
#
# Every step can run again. It prints addresses and variable names, never a secret value, except
# --retire-deposit-seed - without --remove-previous: its stdout is the seed's archive line.
set -euo pipefail
umask 077

ETC=/etc/bugnet
TOML=$ETC/payments.toml
ENV_FILE=${BUGNET_PAYMENTS_ENV:-$ETC/payments.env}
ROUTER_ENV=$ETC/router.env
RELEASE_FILE=$ETC/payments.release
ROTATING=$ETC/payments.rotating
OPT=/opt/bugnet/payments
UNIT_DIR=/etc/systemd/system
LIB_DIR=/usr/local/lib/bugnet
BACKUP_SCRIPT=$LIB_DIR/payments-backup.sh
BACKUP_DIR=/var/backups/bugnet-payments
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

installed_version() {
    [ -f "$RELEASE_FILE" ] || die "no installed version yet, run the install step with the tarball first"
    cat "$RELEASE_FILE"
}

# Runs a command in the installed release with the secrets loaded, in a subshell so nothing leaks
# into this shell
in_release() {
    local v
    v=$(installed_version)
    (
        set -a
        # shellcheck disable=SC1090
        . "$ENV_FILE"
        set +a
        cd "$OPT/$v" && "$@"
    )
}

cli() { in_release node dist/cli.js "$@"; }

# As README section 8's pcli: database commands log in by peer as the service user
svc_cli() {
    in_release setpriv --reuid="$SVC_USER" --regid="$SVC_USER" --init-groups \
        node dist/cli.js -config "$TOML" "$@"
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
    # The script's umask is 077 for the secrets, so the code folders get their modes explicitly
    install -d -o root -g root -m 0755 /opt/bugnet "$OPT" "$OPT/$v"
    if [ ! -f "$OPT/$v/dist/main.js" ]; then
        say "unpacking $v into $OPT/$v"
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

# Runs awk with these arguments and puts its output in place of the TOML by a rename: a write cut
# short, or a failed awk, leaves the old file whole, where a cut-short TOML would read as
# seed_version 1 and lose its other sections
toml_rewrite() {
    local tmp
    tmp=$(mktemp "$TOML.XXXXXX" 2>/dev/null) || die "cannot create a temporary file beside $TOML"
    if ! awk "$@" >"$tmp" || ! chmod 0644 "$tmp" || ! mv -f "$tmp" "$TOML"; then
        rm -f "$tmp"
        die "cannot write $TOML; it was not changed"
    fi
}

# Sets one key inside one [section], so the two url keys never touch each other
toml_set() {
    local section=$1 key=$2 value=$3
    # An awk program, which expands its own $0
    # shellcheck disable=SC2016
    toml_rewrite -v sec="[$section]" -v key="$key" -v val="$value" '
        /^\[/ { cur = $0 }
        cur == sec && $0 ~ "^" key " = " { print key " = \"" val "\""; next }
        { print }
    ' "$TOML"
}

# Spec 4.3: seed_version changes only through --rotate-deposit-seed. --deposits remove takes the
# whole section out, so the version waits in this file until a step adds the section back; read
# as the default 1, the current seed would sign under an older version's number.
kept_seed_version() {
    local f="$ETC/payments.seed_version" v
    [ -f "$f" ] || return 0
    v=$(cat "$f")
    case $v in
    "" | *[!0-9]* | 0*) die "$f does not hold a whole number of at least 1" ;;
    *) echo "$v" ;;
    esac
}

# Sets one unquoted value (a boolean or a number) inside [deposits]. Unlike toml_set it adds the
# key, and the section, when they are missing, since --deposits and the rotation own these keys.
# A section it adds states enabled = false, as the install step's does, because a missing enabled
# reads as true, and the seed_version --deposits remove kept. The file is read twice; each pass
# starts outside every section.
deposits_set() {
    local key=$1 value=$2 kept
    kept=$(kept_seed_version)
    # shellcheck disable=SC2016
    toml_rewrite -v key="$key" -v val="$value" -v kept="$kept" '
        FNR == 1 { cur = "" }
        NR == FNR {
            if ($0 ~ /^\[/) cur = $0
            else if (cur == "[deposits]" && $0 ~ "^" key "[[:space:]]*=") has = 1
            if ($0 == "[deposits]") sec = 1
            next
        }
        /^\[/ { cur = $0 }
        cur == "[deposits]" && $0 ~ "^" key "[[:space:]]*=" { print key " = " val; next }
        { print }
        $0 == "[deposits]" && !has { print key " = " val }
        END {
            if (!sec) {
                print ""; print "[deposits]"; print key " = " val
                if (key != "enabled") print "enabled = false"
                if (kept != "" && key != "seed_version") print "seed_version = " kept
            }
        }
    ' "$TOML" "$TOML"
    rm -f "$ETC/payments.seed_version"
}

deposits_get() {
    awk -v key="$1" '
        /^\[/ { cur = $0; next }
        cur == "[deposits]" && $0 ~ "^" key "[[:space:]]*=" {
            v = $0
            sub("^" key "[[:space:]]*=[[:space:]]*", "", v)
            sub("[[:space:]]*(#.*)?$", "", v)
        }
        END { print v }
    ' "$TOML"
}

# Spec 4.3: the version of BUGNET_DEPOSIT_SEED, 1 until the first rotation
seed_version() {
    local v
    v=$(deposits_get seed_version)
    [ -n "$v" ] || v=$(kept_seed_version)
    case $v in
    "") echo 1 ;;
    *[!0-9]* | 0*) die "[deposits] seed_version in $TOML is not a whole number of at least 1" ;;
    *) echo "$v" ;;
    esac
}

ensure_toml() {
    local recipient=$1 event_key=$2 router_url=$3 allowance kept
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
    # Only when the section is missing, so a later install keeps what --deposits set
    if ! grep -q '^\[deposits\]' "$TOML"; then
        kept=$(kept_seed_version)
        printf '\n[deposits]\nenabled = false\n' >>"$TOML"
        [ -z "$kept" ] || printf 'seed_version = %s\n' "$kept" >>"$TOML"
        rm -f "$ETC/payments.seed_version"
        say "added [deposits] enabled = false to $TOML"
    fi
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

# Spec 23.2: the script and its timer sit outside the release folders, so the newest install step's
# copy backs up whichever version runs
ensure_backup() {
    local v=$1
    install -d -o root -g root -m 0755 "$LIB_DIR"
    install -o root -g root -m 0755 "$OPT/$v/deploy/payments-backup.sh" "$BACKUP_SCRIPT"
    install -o root -g root -m 0644 "$OPT/$v/deploy/bugnet-payments-backup.service" \
        "$OPT/$v/deploy/bugnet-payments-backup.timer" "$UNIT_DIR/"
    install -d -o root -g root -m 0700 "$BACKUP_DIR"
    systemctl daemon-reload
    systemctl enable --now bugnet-payments-backup.timer
    say "bugnet-payments-backup.timer enabled: a dump of $DB into $BACKUP_DIR every night"
}

backup_now() {
    if [ ! -x "$BACKUP_SCRIPT" ]; then
        echo "$BACKUP_SCRIPT is missing; run the install step first" >&2
        return 1
    fi
    BUGNET_PAYMENTS_BACKUP_DIR=$BACKUP_DIR "$BACKUP_SCRIPT"
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
    ensure_backup "$v"
    do_pubkeys
    say "next: fund the wallets, run deploy/push-rpc-urls.sh and deploy/push-payments-token.sh, --mtls, then --start"
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

# One line on stdin: BUGNET_SOLANA_RPC_URLS= and comma-separated URLs, with nothing a shell
# loading the env file would split or run. Messages name the variable only, never a URL.
rpc_list_ok() {
    local line="" value
    IFS= read -r line || true
    case $line in
    BUGNET_SOLANA_RPC_URLS=*) ;;
    *)
        echo "expected a BUGNET_SOLANA_RPC_URLS line" >&2
        return 1
        ;;
    esac
    value=${line#BUGNET_SOLANA_RPC_URLS=}
    case $value in
    *[[:space:]\&\;\|\<\>\(\)\$\`\'\"\\]*)
        echo "BUGNET_SOLANA_RPC_URLS holds a space or a shell character; fix the line in the local .env" >&2
        return 1
        ;;
    esac
    if [ -z "${value//,/}" ]; then
        echo "BUGNET_SOLANA_RPC_URLS holds no URL" >&2
        return 1
    fi
}

# The list when it is set, else the single URL; the list itself must pass rpc_list_ok. A shell
# loading the file runs every list line, so a second one is refused rather than left unchecked.
rpc_env_ok() {
    local file=$1 n
    n=$(grep -c '^BUGNET_SOLANA_RPC_URLS=' "$file" 2>/dev/null || true)
    if [ "${n:-0}" -gt 1 ]; then
        echo "$file holds $n BUGNET_SOLANA_RPC_URLS lines; copy the list again with deploy/push-rpc-urls.sh" >&2
        return 1
    fi
    if grep -q '^BUGNET_SOLANA_RPC_URLS=.' "$file" 2>/dev/null; then
        grep '^BUGNET_SOLANA_RPC_URLS=.' "$file" | rpc_list_ok
        return
    fi
    grep -q '^BUGNET_SOLANA_RPC_URL=.' "$file" 2>/dev/null && return 0
    echo "$file has no BUGNET_SOLANA_RPC_URLS" >&2
    return 1
}

# Puts LINE in place of every NAME= line of FILE. The env file holds the only copy of the server's
# keys, so the new file is built and checked beside it and renamed over it: any failure leaves the
# old file whole. Every step is checked by hand, because a caller's `|| die` turns set -e off
# inside this function.
replace_env_line() {
    local file=$1 name=$2 line=$3 tmp kept lines rc=0
    tmp=$(mktemp "$file.XXXXXX" 2>/dev/null) || tmp=""
    if [ -z "$tmp" ]; then
        echo "cannot create a temporary file beside $file" >&2
        return 1
    fi
    # A Ctrl-C or a dropped ssh session before the rename would leave a root-only copy of the keys
    # beside the file. Traps are global and outlive $tmp, so the path is written into the trap.
    # shellcheck disable=SC2064
    trap "rm -f -- $(printf '%q' "$tmp")" EXIT
    trap 'exit 1' INT TERM HUP
    # grep exits 1 when it keeps no line, which is fine, and 2 when it cannot read the file
    grep -v "^$name=" "$file" >"$tmp" || rc=$?
    if [ "$rc" -gt 1 ] || ! printf '%s\n' "$line" >>"$tmp" || ! chmod 0600 "$tmp"; then
        rm -f "$tmp"
        trap - EXIT INT TERM HUP
        echo "cannot write the new $file" >&2
        return 1
    fi
    kept=$(grep -vc "^$name=" "$file" || true)
    lines=$(wc -l <"$tmp" | tr -d ' ')
    if [ "$lines" != "$((kept + 1))" ] || ! mv -f "$tmp" "$file"; then
        rm -f "$tmp"
        trap - EXIT INT TERM HUP
        echo "cannot write the new $file" >&2
        return 1
    fi
    trap - EXIT INT TERM HUP
}

# Reads one line on stdin into $line, refusing none or more than one
one_line() {
    line=$(cat)
    if [ -z "$line" ] || [[ $line == *$'\n'* ]]; then
        echo "expected one $1 line on stdin" >&2
        return 1
    fi
}

# Replaces the list line with the one on stdin; the single URL line stays for a rollback
write_rpc_list() {
    local file=$1 line n
    one_line BUGNET_SOLANA_RPC_URLS || return 1
    printf '%s\n' "$line" | rpc_list_ok || return 1
    replace_env_line "$file" BUGNET_SOLANA_RPC_URLS "$line" || return 1
    n=$(printf '%s' "${line#BUGNET_SOLANA_RPC_URLS=}" | tr ',' '\n' | grep -c . || true)
    echo "BUGNET_SOLANA_RPC_URLS set in $file: $n URL$([ "$n" = 1 ] || echo s)"
}

do_rpc_urls() {
    # A line pasted at a terminal echoes on the screen; it comes only through the copy step's pipe
    [ ! -t 0 ] || die "pipe the list line with deploy/push-rpc-urls.sh from the Mac"
    [ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist; run the install step first"
    write_rpc_list "$ENV_FILE" || die "the RPC list was not changed"
    chown root:root "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    if [ -f "$RELEASE_FILE" ] && systemctl is-active --quiet "bugnet-payments@$(installed_version)"; then
        say "run pcli rpc probe, then --start to restart with the new list"
    fi
}

# One line on stdin: BUGNET_PAYMENTS_TOKEN= and the token the gateway sends. Boot wants at least 32
# characters and no space; the shell that loads the env file wants nothing it would split or
# expand. Messages name the variable only, never the value.
payments_token_ok() {
    local line="" value
    IFS= read -r line || true
    case $line in
    BUGNET_PAYMENTS_TOKEN=*) ;;
    *)
        echo "expected a BUGNET_PAYMENTS_TOKEN line" >&2
        return 1
        ;;
    esac
    value=${line#BUGNET_PAYMENTS_TOKEN=}
    case $value in
    *[!A-Za-z0-9+/=_.-]*)
        echo "BUGNET_PAYMENTS_TOKEN holds a character other than letters, digits and + / = _ . -" >&2
        return 1
        ;;
    esac
    if [ "${#value}" -lt 32 ]; then
        echo "BUGNET_PAYMENTS_TOKEN is shorter than 32 characters" >&2
        return 1
    fi
}

write_payments_token() {
    local file=$1 line
    one_line BUGNET_PAYMENTS_TOKEN || return 1
    printf '%s\n' "$line" | payments_token_ok || return 1
    # Boot refuses the two tokens equal, so the service would not start
    if [ "${line#BUGNET_PAYMENTS_TOKEN=}" = "$(env_value BUGNET_PAYMENTS_ROUTER_TOKEN "$file")" ]; then
        echo "BUGNET_PAYMENTS_TOKEN must differ from BUGNET_PAYMENTS_ROUTER_TOKEN" >&2
        return 1
    fi
    replace_env_line "$file" BUGNET_PAYMENTS_TOKEN "$line" || return 1
    echo "BUGNET_PAYMENTS_TOKEN set in $file"
}

do_payments_token() {
    # A line pasted at a terminal echoes on the screen; it comes only through the copy step's pipe
    [ ! -t 0 ] || die "pipe the token line with deploy/push-payments-token.sh from the Mac"
    [ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist; run the install step first"
    write_payments_token "$ENV_FILE" || die "BUGNET_PAYMENTS_TOKEN was not changed"
    chown root:root "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    if [ -f "$RELEASE_FILE" ] && systemctl is-active --quiet "bugnet-payments@$(installed_version)"; then
        say "run --start to load it"
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
    # This release reads a missing [deposits] as enabled = true, which after --deposits remove would
    # turn deposits on unasked
    if ! grep -q '^\[deposits\]' "$TOML"; then
        echo "$TOML has no [deposits]; run --deposits off to add it back" >&2
        ok=0
    fi
    rpc_env_ok "$ENV_FILE" || ok=0
    for name in BUGNET_PAYMENTS_TOKEN BUGNET_PAYMENTS_ROUTER_TOKEN \
        BUGNET_ORDER_PRIVATE_KEY BUGNET_CLAIM_KEY BUGNET_FEE_PAYER_KEY BUGNET_REFUND_KEY \
        BUGNET_ALLOWANCE_KEY BUGNET_X402_TLS_KEY BUGNET_DEPOSIT_SEED; do
        env_has "$name" || { echo "$ENV_FILE has no $name" >&2; ok=0; }
    done
    for f in "$ETC/internal-ca.pem" "$ETC/payments/x402-server.pem" "$ETC/payments/x402-index.json"; do
        [ -f "$f" ] || { echo "missing $f" >&2; ok=0; }
    done
    [ "$ok" = 1 ] || die "not starting"
    # Spec 23.2: a release migrates the database as it starts, so a dump from just before comes first
    backup_now || die "the backup failed, so nothing was stopped or started"
    for old in $(systemctl list-units --all --plain --no-legend 'bugnet-payments@*' | awk '{print $1}'); do
        [ "$old" = "bugnet-payments@$v.service" ] && continue
        systemctl disable --now "$old"
        say "stopped $old"
    done
    # A unit already running keeps the env file it started with, so --start restarts it to load a
    # changed list or key; restart also starts a stopped unit
    systemctl enable "bugnet-payments@$v"
    systemctl restart "bugnet-payments@$v"
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

# Between keys rotate-deposit-seed and the raised seed_version, a restart would load the new seed
# under the old version: boot then refuses while that version has open deposits, and otherwise
# new deposits get the old number on the new seed. Only --rotate-deposit-seed itself restarts
# while the marker exists.
no_rotation_halfway() {
    [ ! -f "$ROTATING" ] || die "a seed rotation stopped halfway; run --rotate-deposit-seed again first"
}

# The settings and the env file are read only at start. Only the installed version is restarted,
# and only while it runs: an older one still running would refuse [deposits] keys it does not know.
restart_running() {
    local v
    v=$(installed_version)
    if systemctl is-active --quiet "bugnet-payments@$v"; then
        do_start
    else
        say "bugnet-payments@$v is not running; the next --start loads the change"
    fi
}

# Spec 19, D7: deposits go live only on the RPC router release, whose CLI lists rpc probe
release_has_probe() {
    local v usage
    v=$(installed_version)
    usage=$(cd "$OPT/$v" && node dist/cli.js 2>&1) || true
    printf '%s\n' "$usage" | grep -q '^  rpc probe '
}

# Reads rpc probe's output on stdin and takes its exit code as $1. Deposit scans are pinned
# listings, which go only to the endpoints on the listings line, and a "not found" needs two
# domains (spec 19; router spec 14 step 3). Prints counts, never an endpoint.
deposits_gate_ok() {
    local rc=$1 line n=0 m=0 quorum=off listings=0 rest
    local quorum_re='^quorum: ([0-9]+) of ([0-9]+) domains ready$'
    while IFS= read -r line; do
        if [[ $line =~ $quorum_re ]]; then
            n=${BASH_REMATCH[1]}
            m=${BASH_REMATCH[2]}
            quorum="$n of $m domains ready"
        elif [ "${line#listings: }" != "$line" ]; then
            rest=${line#listings: }
            listings=0
            if [ "$rest" != none ]; then
                listings=$(printf '%s\n' "$rest" | wc -w | tr -d ' ')
            fi
        fi
    done
    echo "rpc probe: exit $rc, quorum $quorum, $listings listing endpoint$([ "$listings" = 1 ] || echo s)"
    if [ "$rc" = 0 ] && [ "$m" -ge 2 ] && [ "$n" -ge "$m" ] && [ "$listings" -ge 2 ]; then
        return 0
    fi
    echo "deposits need the probe to exit 0, a quorum of at least 2 domains and at least 2 listing endpoints" >&2
    return 1
}

# A release without deposits refuses payments.toml while it holds [deposits], so a rollback below
# the deposits release removes the section first. Such a release watches no deposit, so this
# refuses while money could still move: deposits on (a page view would open one), a deposit open,
# settling or draining, or a move in flight. Closed deposits may stay: late money sent to them
# waits for a roll forward and goes back with deposits return-late. It restarts nothing, since
# this release would read the missing section as deposits on.
deposits_remove() {
    local list n moving m version
    if ! grep -q '^\[deposits\]' "$TOML"; then
        say "$TOML has no [deposits]"
        return 0
    fi
    [ "$(deposits_get enabled)" = false ] || die "deposits are on; run --deposits off first"
    list=$(svc_cli deposits list </dev/null) || die "pcli deposits list failed; [deposits] was not removed"
    n=$(printf '%s\n' "$list" | grep -cE ' state=(open|settling|draining) ' || true)
    moving=$(svc_cli deposits list --moving </dev/null) || die "pcli deposits list failed; [deposits] was not removed"
    m=$(printf '%s' "$moving" | grep -c . || true)
    if [ "$n" != 0 ] || [ "$m" != 0 ]; then
        die "deposits open, settling or draining: $n; with a move in flight: $m; [deposits] was not removed"
    fi
    version=$(seed_version)
    printf '%s\n' "$version" >"$ETC/payments.seed_version.new"
    mv -f "$ETC/payments.seed_version.new" "$ETC/payments.seed_version"
    # shellcheck disable=SC2016
    toml_rewrite '/^\[/ { skip = ($0 ~ /^\[deposits(\]|\.)/) } !skip { print }' "$TOML"
    say "removed [deposits] from $TOML, keeping seed_version $version in $ETC/payments.seed_version; now install the older release and run its --start"
}

do_deposits() {
    local want=$1 out rc=0
    case $want in
    on | off | remove) ;;
    *) die "--deposits takes on, off or remove" ;;
    esac
    no_rotation_halfway
    if [ "$want" = remove ]; then
        deposits_remove
        return
    fi
    if [ "$want" = on ]; then
        if ! release_has_probe; then
            echo "deposits need the RPC router release; install it first" >&2
            exit 1
        fi
        env_has BUGNET_DEPOSIT_SEED || die "$ENV_FILE has no BUGNET_DEPOSIT_SEED; run the install step first"
        # The probe's env file is loaded by the shell, which would split a bad list line
        rpc_env_ok "$ENV_FILE" || die "deposits were not changed"
        out=$(svc_cli rpc probe </dev/null) || rc=$?
        printf '%s\n' "$out" | deposits_gate_ok "$rc" || die "deposits were not changed"
        deposits_set enabled true
    else
        deposits_set enabled false
    fi
    say "[deposits] enabled = $([ "$want" = on ] && echo true || echo false) in $TOML"
    restart_running
}

# Spec 4.3: the marker holds the target version from the first step to the last, so a run that
# stopped halfway is finished by the next one and the seed is never rotated twice
do_rotate_seed() {
    local version target
    version=$(seed_version)
    if [ -f "$ROTATING" ]; then
        target=$(cat "$ROTATING")
        # Only this step writes the marker, always as version + 1; any other value means the
        # TOML or the marker changed outside it, and raising seed_version to it would misnumber
        # BUGNET_DEPOSIT_SEED_PREVIOUS
        if [ "$target" != "$version" ] && [ "$target" != "$((version + 1))" ]; then
            die "$ROTATING does not name seed version $version or $((version + 1)); nothing was changed"
        fi
        say "finishing the rotation to seed version $target"
    else
        if env_has BUGNET_DEPOSIT_SEED_PREVIOUS; then
            die "BUGNET_DEPOSIT_SEED_PREVIOUS is set: an earlier rotation is still draining; run deploy/retire-deposit-seed.sh first"
        fi
        env_has BUGNET_DEPOSIT_SEED || die "$ENV_FILE has no BUGNET_DEPOSIT_SEED; run the install step first"
        target=$((version + 1))
        # By a rename, so a cut-short write never leaves an empty marker that would block --start
        printf '%s\n' "$target" >"$ROTATING.new"
        mv -f "$ROTATING.new" "$ROTATING"
    fi
    if [ "$version" -lt "$target" ]; then
        if env_has BUGNET_DEPOSIT_SEED_PREVIOUS; then
            say "BUGNET_DEPOSIT_SEED was already moved to BUGNET_DEPOSIT_SEED_PREVIOUS"
        else
            cli keys rotate-deposit-seed --env "$ENV_FILE"
        fi
        deposits_set seed_version "$target"
        say "[deposits] seed_version = $target in $TOML"
    fi
    restart_running
    rm -f "$ROTATING"
}

# Spec 4.3, D8 A. The first run prints the archive line and removes nothing; the run with
# --remove-previous takes the archive back on stdin and removes the seed only when it matches. No
# seed file is ever written on the server (founder, D8).
# [ -t fd ], a function so a test can stand in for a terminal
on_terminal() {
    [ -t "$1" ]
}

do_retire_seed() {
    local remove=$1 version old list n
    # stdout carries only the archive line, which deploy/retire-deposit-seed.sh captures
    exec 3>&1 1>&2
    # A seed line shown on a screen or pasted at one is out of the pipe (D8): phase 1 never
    # prints to a terminal and phase 2 never reads from one
    if { [ "$remove" = 1 ] && on_terminal 0; } || { [ "$remove" = 0 ] && on_terminal 3; }; then
        die "run deploy/retire-deposit-seed.sh from the Mac"
    fi
    no_rotation_halfway
    if ! env_has BUGNET_DEPOSIT_SEED_PREVIOUS; then
        say "nothing to retire: $ENV_FILE has no BUGNET_DEPOSIT_SEED_PREVIOUS"
        return 0
    fi
    version=$(seed_version)
    [ "$version" -ge 2 ] || die "BUGNET_DEPOSIT_SEED_PREVIOUS is set while [deposits] seed_version is 1"
    old=$((version - 1))
    list=$(svc_cli deposits list --version "$old" </dev/null) || die "pcli deposits list failed; nothing was retired"
    n=$(printf '%s' "$list" | grep -vc ' state=done ' || true)
    [ "$n" = 0 ] || die "deposits of seed version $old not done yet: $n; retire once pcli deposits list --version $old shows only done ones"
    if [ "$remove" = 1 ]; then
        cli keys retire-deposit-seed --env "$ENV_FILE" --archive - --version "$old" --remove-previous
    else
        cli keys retire-deposit-seed --env "$ENV_FILE" --archive - --version "$old" </dev/null >&3
        say "printed BUGNET_DEPOSIT_SEED_V$old for the archive; BUGNET_DEPOSIT_SEED_PREVIOUS stays until it is read back"
        return 0
    fi
    restart_running
}

main() {
    local tgz="" recipient="" event_key="" router_url="" index="" mode=install mtls=""
    local deposits="" remove=0
    [ "$(id -u)" = 0 ] || die "run as root"
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
        --backup) mode=backup; shift ;;
        --rpc-urls) mode=rpc_urls; shift ;;
        --payments-token) mode=payments_token; shift ;;
        --deposits) mode=deposits; deposits=${2:?}; shift 2 ;;
        --rotate-deposit-seed) mode=rotate_seed; shift ;;
        --retire-deposit-seed)
            mode=retire_seed
            [ "${2:-}" = - ] || die "--retire-deposit-seed takes -; deploy/retire-deposit-seed.sh runs it from the Mac"
            shift 2
            ;;
        --remove-previous) remove=1; shift ;;
        -*) die "unknown option $1" ;;
        *) tgz=$1; shift ;;
        esac
    done
    if [ "$remove" = 1 ] && [ "$mode" != retire_seed ]; then
        die "--remove-previous goes with --retire-deposit-seed -"
    fi
    case $mode in
    install) [ -n "$tgz" ] || die "the install step needs the tarball"; do_install "$tgz" "$recipient" "$event_key" "$router_url" "$index" ;;
    mtls) do_mtls "$mtls" ;;
    pubkeys) do_pubkeys ;;
    start) no_rotation_halfway; do_start ;;
    backup) backup_now || die "the backup failed" ;;
    rpc_urls) do_rpc_urls ;;
    payments_token) do_payments_token ;;
    deposits) do_deposits "$deposits" ;;
    rotate_seed) do_rotate_seed ;;
    retire_seed) do_retire_seed "$remove" ;;
    esac
}

# A test sources the script with VPS_INSTALL_LIB=1 and calls one function, as a non-root user
[ "${VPS_INSTALL_LIB:-0}" = 1 ] || main "$@"
