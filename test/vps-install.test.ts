import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../deploy/vps-install.sh");
const PUSH = join(import.meta.dirname, "../deploy/push-rpc-urls.sh");
const RETIRE = join(import.meta.dirname, "../deploy/retire-deposit-seed.sh");
const PUSH_TOKEN = join(import.meta.dirname, "../deploy/push-payments-token.sh");
const BACKUP = join(import.meta.dirname, "../deploy/payments-backup.sh");
const DEPLOY = join(import.meta.dirname, "../deploy");
const BACKUP_UNITS = ["bugnet-payments-backup.service", "bugnet-payments-backup.timer"] as const;

const KEYS = [
    "BUGNET_PAYMENTS_TOKEN",
    "BUGNET_PAYMENTS_ROUTER_TOKEN",
    "BUGNET_ORDER_PRIVATE_KEY",
    "BUGNET_CLAIM_KEY",
    "BUGNET_FEE_PAYER_KEY",
    "BUGNET_REFUND_KEY",
    "BUGNET_ALLOWANCE_KEY",
    "BUGNET_X402_TLS_KEY",
    "BUGNET_DEPOSIT_SEED",
];
const SEED = Buffer.alloc(32, 7).toString("base64");
const OLD_SEED = Buffer.alloc(32, 8).toString("base64");

// Router spec 10.4: the probe's answer for a ready list
const READY_PROBE = [
    "rpc1  genesis: ok  pinned-accounts: ok  pinned-signatures: ok  history: ok  consistent: yes  slot: 467621707  latency: 84ms",
    "rpc2  genesis: ok  pinned-accounts: ok  pinned-signatures: ok  history: ok  consistent: no  slot: 467621706  latency: 95ms",
    "rpc3  genesis: ok  pinned-accounts: ok  pinned-signatures: ok  history: ok  consistent: yes  slot: 467621705  latency: 210ms",
    "quorum: 2 of 2 domains ready",
    "listings: rpc1 rpc3",
    "",
].join("\n");
const OLD_USAGE = "usage: cli [-config FILE] <command>\n  manual list\n";
const ROUTER_USAGE = `${OLD_USAGE}  rpc probe                                check every RPC endpoint now\n`;

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bn-vps-install-"));
});
afterEach(() => {
    // A test may leave the folder read only
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
});

// Sources the script as a library and runs one function, as a non-root user
function call(fn: string, args: string[], stdin = "", envFile = join(dir, "payments.env")) {
    const r = spawnSync("bash", ["-c", `. "${SCRIPT}"; ${fn} "$@"`, "bash", ...args], {
        input: stdin,
        encoding: "utf8",
        env: { ...process.env, VPS_INSTALL_LIB: "1", BUGNET_PAYMENTS_ENV: envFile },
    });
    return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

function envFile(text: string): string {
    const file = join(dir, "payments.env");
    writeFileSync(file, text, { mode: 0o600 });
    return file;
}

function keysEnv(extra = ""): string {
    const lines = KEYS.map((n) => `${n}=${n === "BUGNET_DEPOSIT_SEED" ? SEED : "x"}`);
    return `${lines.join("\n")}\nBUGNET_SOLANA_RPC_URLS=https://rpc1.example,https://rpc2.example\n${extra}`;
}

// A server with release v9 and the backup script installed. systemctl, curl, journalctl, chown,
// install, setpriv, id, node, runuser, pg_dump and pg_restore are fakes; id makes main run as root,
// install leaves out the owner, node stands in for dist/cli.js, and node, systemctl, install and
// the Postgres tools log who ran them with which arguments and answer from files the test can
// change.
function fakeServer(o: { usage?: string; active?: boolean; env?: string } = {}) {
    const root = join(dir, "server");
    const etc = join(root, "etc");
    const opt = join(root, "opt");
    const bin = join(root, "bin");
    const log = join(root, "calls.log");
    // A test may set up several servers in turn
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(etc, "payments"), { recursive: true });
    mkdirSync(join(opt, "v9"), { recursive: true });
    mkdirSync(bin);
    mkdirSync(join(root, "systemd"));
    mkdirSync(join(root, "lib"));
    copyFileSync(BACKUP, join(root, "lib", "payments-backup.sh"));
    chmodSync(join(root, "lib", "payments-backup.sh"), 0o755);
    for (const f of ["internal-ca.pem", "payments/x402-server.pem", "payments/x402-index.json"]) {
        writeFileSync(join(etc, f), "");
    }
    const toml = join(etc, "payments.toml");
    writeFileSync(toml, "[solana]\n\n[deposits]\nenabled = false\n");
    writeFileSync(join(etc, "payments.release"), "v9\n");
    writeFileSync(join(root, "usage"), o.usage ?? ROUTER_USAGE);
    writeFileSync(join(root, "probe.out"), READY_PROBE);
    writeFileSync(join(root, "probe.exit"), "0");
    writeFileSync(join(root, "list.out"), "");
    writeFileSync(join(root, "all.out"), "");
    writeFileSync(join(root, "moving.out"), "");
    writeFileSync(join(root, "pg_dump.exit"), "0");
    writeFileSync(join(root, "pg_restore.exit"), "0");
    writeFileSync(join(root, "units.out"), "");
    writeFileSync(log, "");
    const env = envFile(o.env ?? keysEnv());
    const fakes: Record<string, string> = {
        systemctl: [
            `echo "systemctl $*" >> "${log}"`,
            `[ "$1" != list-units ] || cat "${root}/units.out"`,
            `[ "$1" != is-active ] || exit ${o.active === true ? 0 : 3}`,
        ].join("\n"),
        curl: "exit 0",
        journalctl: "exit 0",
        chown: "exit 0",
        install: [
            `echo "install $*" >> "${log}"`,
            "args=()",
            'while [ $# -gt 0 ]; do case $1 in -o | -g) shift 2 ;; *) args+=("$1"); shift ;; esac; done',
            'exec /usr/bin/install "${args[@]}"',
        ].join("\n"),
        id: 'if [ "$1" = -u ]; then echo 0; else exec /usr/bin/id "$@"; fi',
        setpriv: [
            'for a in "$@"; do case $a in --reuid=*) export FAKE_AS=${a#--reuid=} ;; esac; done',
            'while [ "${1#--}" != "$1" ]; do shift; done',
            'exec "$@"',
        ].join("\n"),
        node: [
            "shift",
            `echo "\${FAKE_AS:-root} $*" >> "${log}"`,
            'case "$*" in',
            `"") cat "${root}/usage" >&2; exit 2 ;;`,
            `*" rpc probe") cat "${root}/probe.out"; exit "$(cat "${root}/probe.exit")" ;;`,
            `*" deposits list --version "*) cat "${root}/list.out" ;;`,
            `*" deposits list --moving") cat "${root}/moving.out" ;;`,
            `*" deposits list") cat "${root}/all.out" ;;`,
            '"keys show --no-balances") echo "allowance=Allowance1111" ;;',
            `"keys rotate-deposit-seed --env "*) echo "BUGNET_DEPOSIT_SEED_PREVIOUS=${SEED}" >> "$4" ;;`,
            `"keys retire-deposit-seed --env "*" --remove-previous") cat > "${root}/stdin"`,
            '    grep -v "^BUGNET_DEPOSIT_SEED_PREVIOUS=" "$4" > "$4.new"; mv "$4.new" "$4" ;;',
            '"keys retire-deposit-seed --env "*" --archive - --version "*)',
            '    echo "BUGNET_DEPOSIT_SEED_V$8=$(sed -n "s/^BUGNET_DEPOSIT_SEED_PREVIOUS=//p" "$4")" ;;',
            '"keys retire-deposit-seed --env "*) ;;',
            '*) echo "unexpected: $*" >&2; exit 9 ;;',
            "esac",
        ].join("\n"),
        runuser: [
            'while [ $# -gt 0 ] && [ "$1" != -- ]; do',
            "    case $1 in -u) export FAKE_AS=$2; shift 2 ;; *) shift ;; esac",
            "done",
            'shift; exec "$@"',
        ].join("\n"),
        // The dump holds its own environment, so a test can see no secret reached it
        pg_dump: [
            `echo "\${FAKE_AS:-root} pg_dump $*" >> "${log}"`,
            "echo PGDMP; env",
            `exit "$(cat "${root}/pg_dump.exit")"`,
        ].join("\n"),
        pg_restore: [
            `echo "\${FAKE_AS:-root} pg_restore $*" >> "${log}"`,
            'for last in "$@"; do :; done',
            '[ "$(head -c 5 "$last")" = PGDMP ] || { echo "pg_restore: error: not an archive" >&2; exit 1; }',
            `exit "$(cat "${root}/pg_restore.exit")"`,
        ].join("\n"),
    };
    for (const [name, body] of Object.entries(fakes)) {
        writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
    }
    const backups = join(root, "backups");
    return {
        root,
        toml,
        env,
        backups,
        rotating: join(etc, "payments.rotating"),
        calls: () =>
            readFileSync(log, "utf8")
                .split("\n")
                .filter((l) => l !== ""),
        run(cmd: string, stdin = "", cwd = dir, extraEnv: Record<string, string> = {}) {
            const r = spawnSync(
                "bash",
                [
                    "-c",
                    `. "${SCRIPT}"; ETC="$1"; TOML="$1/payments.toml"; RELEASE_FILE="$1/payments.release"; ROTATING="$1/payments.rotating"; OPT="$2"; UNIT_DIR="$3/systemd"; LIB_DIR="$3/lib"; BACKUP_SCRIPT="$3/lib/payments-backup.sh"; BACKUP_DIR="$3/backups"; ${cmd}`,
                    "bash",
                    etc,
                    opt,
                    root,
                ],
                {
                    input: stdin,
                    encoding: "utf8",
                    cwd,
                    env: {
                        ...process.env,
                        ...extraEnv,
                        PATH: `${bin}:${process.env.PATH ?? ""}`,
                        PWD: cwd,
                        VPS_INSTALL_LIB: "1",
                        BUGNET_PAYMENTS_ENV: env,
                    },
                },
            );
            return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
        },
        // Runs deploy/payments-backup.sh itself, as the timer does
        backup(extra: Record<string, string> = {}) {
            const r = spawnSync("bash", [BACKUP], {
                encoding: "utf8",
                cwd: dir,
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH ?? ""}`,
                    BUGNET_PAYMENTS_BACKUP_DIR: backups,
                    ...extra,
                },
            });
            return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
        },
    };
}

describe("vps-install.sh RPC list", () => {
    it("rpc_env_ok accepts the list or the single URL", () => {
        let file = envFile("BUGNET_SOLANA_RPC_URLS=https://a.example,https://b.example\n");
        expect(call("rpc_env_ok", [file]).code).toBe(0);
        file = envFile("BUGNET_SOLANA_RPC_URL=https://a.example\n");
        expect(call("rpc_env_ok", [file]).code).toBe(0);
        file = envFile("OTHER=1\n");
        const r = call("rpc_env_ok", [file]);
        expect(r.code).toBe(1);
        expect(r.err).toContain("has no BUGNET_SOLANA_RPC_URLS");
    });

    it("rpc_env_ok refuses a spaced or shell-character list", () => {
        for (const line of [
            "BUGNET_SOLANA_RPC_URLS=https://a.example, https://b.example",
            "BUGNET_SOLANA_RPC_URLS=https://a.example/?x=1&k=2",
        ]) {
            const r = call("rpc_env_ok", [envFile(`${line}\n`)]);
            expect(r.code).toBe(1);
            expect(r.all).toContain("BUGNET_SOLANA_RPC_URLS");
            expect(r.all).not.toContain("a.example");
            expect(r.all).not.toContain("b.example");
        }
    });

    it("write_rpc_list replaces the line and prints only the count", () => {
        const file = envFile(
            "BUGNET_SOLANA_RPC_URL=https://old.example\nBUGNET_SOLANA_RPC_URLS=https://older.example\n",
        );
        const r = call(
            "write_rpc_list",
            [file],
            "BUGNET_SOLANA_RPC_URLS=https://a.example/k1,https://b.example\n",
        );
        expect(r.code).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(
            "BUGNET_SOLANA_RPC_URL=https://old.example\nBUGNET_SOLANA_RPC_URLS=https://a.example/k1,https://b.example\n",
        );
        expect(r.out.trim()).toBe(`BUGNET_SOLANA_RPC_URLS set in ${file}: 2 URLs`);
        expect(r.all).not.toContain("a.example");
    });

    it("rpc_env_ok refuses a second list line", () => {
        const r = call("rpc_env_ok", [
            envFile(
                "BUGNET_SOLANA_RPC_URLS=https://a.example ;x\nBUGNET_SOLANA_RPC_URLS=https://b.example\n",
            ),
        ]);
        expect(r.code).toBe(1);
        expect(r.err).toContain("holds 2 BUGNET_SOLANA_RPC_URLS lines");
        expect(r.all).not.toContain("a.example");
    });

    it("write_rpc_list keeps the env file whole when it cannot write beside it", () => {
        const before =
            "BUGNET_FEE_PAYER_KEY=madeupfeepayer\nBUGNET_SOLANA_RPC_URLS=https://old.example\n";
        const file = envFile(before);
        // No new file can be made in the folder, while the env file itself stays writable
        chmodSync(dir, 0o500);
        const r = spawnSync(
            "bash",
            ["-c", `. "${SCRIPT}"; write_rpc_list "$1" || echo failed`, "bash", file],
            {
                input: "BUGNET_SOLANA_RPC_URLS=https://a.example,https://b.example\n",
                encoding: "utf8",
                env: { ...process.env, VPS_INSTALL_LIB: "1", BUGNET_PAYMENTS_ENV: file },
            },
        );
        chmodSync(dir, 0o700);
        expect(r.stdout.trim()).toBe("failed");
        expect(r.stderr).toContain("cannot create a temporary file");
        expect(readFileSync(file, "utf8")).toBe(before);
        expect(r.stdout + r.stderr).not.toContain("a.example");
    });

    it("write_rpc_list leaves no copy of the env file when killed before the rename", () => {
        const before =
            "BUGNET_FEE_PAYER_KEY=madeupfeepayer\nBUGNET_SOLANA_RPC_URLS=https://old.example\n";
        const file = envFile(before);
        const bin = join(dir, "bin");
        mkdirSync(bin);
        // A Ctrl-C or a dropped ssh session lands while the new file waits beside the old one
        writeFileSync(join(bin, "mv"), '#!/usr/bin/env bash\nkill -TERM "$PPID"\nexit 1\n');
        chmodSync(join(bin, "mv"), 0o755);
        const r = spawnSync(
            "bash",
            ["-c", `. "${SCRIPT}"; write_rpc_list "$1" || echo failed`, "bash", file],
            {
                input: "BUGNET_SOLANA_RPC_URLS=https://a.example,https://b.example\n",
                encoding: "utf8",
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH ?? ""}`,
                    VPS_INSTALL_LIB: "1",
                    BUGNET_PAYMENTS_ENV: file,
                },
            },
        );
        expect(r.status).not.toBe(0);
        expect(readdirSync(dir).toSorted()).toEqual(["bin", "payments.env"]);
        expect(readFileSync(file, "utf8")).toBe(before);
    });

    it("--start restarts a running unit so it loads a changed list", () => {
        const server = fakeServer({ active: true });
        const r = server.run("do_start");
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(server.calls()).toContain("systemctl restart bugnet-payments@v9");
    });

    it("--start refuses an env file without BUGNET_DEPOSIT_SEED", () => {
        const env = keysEnv().replace(/^BUGNET_DEPOSIT_SEED=.*\n/m, "");
        const server = fakeServer({ active: true, env });
        const r = server.run("do_start");
        expect(r.code).toBe(1);
        expect(r.err).toContain(`${server.env} has no BUGNET_DEPOSIT_SEED`);
        expect(server.calls()).not.toContain("systemctl restart bugnet-payments@v9");
    });

    it("write_rpc_list refuses two lines, none, or a bad line", () => {
        const before = "BUGNET_SOLANA_RPC_URL=https://old.example\nOTHER=1\n";
        for (const stdin of [
            "BUGNET_SOLANA_RPC_URLS=https://a.example\nBUGNET_SOLANA_RPC_URLS=https://b.example\n",
            "",
            "BUGNET_SOLANA_RPC_URLS=https://a.example; rm -rf /\n",
        ]) {
            const file = envFile(before);
            expect(call("write_rpc_list", [file], stdin).code).toBe(1);
            expect(readFileSync(file, "utf8")).toBe(before);
        }
    });
});

describe("vps-install.sh deposits", () => {
    it("deposits_gate_ok passes a ready list", () => {
        const r = call("deposits_gate_ok", ["0"], READY_PROBE);
        expect(r.code).toBe(0);
        expect(r.out).toBe("rpc probe: exit 0, quorum 2 of 2 domains ready, 2 listing endpoints\n");
        expect(r.err).toBe("");
    });

    it("deposits_gate_ok refuses a short list", () => {
        const cases: [string, string, string][] = [
            ["1", READY_PROBE, "exit 1, quorum 2 of 2 domains ready, 2 listing endpoints"],
            [
                "0",
                READY_PROBE.replace("quorum: 2 of 2 domains ready", "quorum: off (one URL)"),
                "exit 0, quorum off, 2 listing endpoints",
            ],
            [
                "0",
                READY_PROBE.replace("quorum: 2 of 2 domains ready", "quorum: 1 of 1 domains ready"),
                "exit 0, quorum 1 of 1 domains ready, 2 listing endpoints",
            ],
            [
                "0",
                READY_PROBE.replace("listings: rpc1 rpc3", "listings: rpc1"),
                "exit 0, quorum 2 of 2 domains ready, 1 listing endpoint",
            ],
            [
                "0",
                READY_PROBE.replace("listings: rpc1 rpc3", "listings: none"),
                "exit 0, quorum 2 of 2 domains ready, 0 listing endpoints",
            ],
        ];
        for (const [exit, probe, counts] of cases) {
            const r = call("deposits_gate_ok", [exit], probe);
            expect(r.code).toBe(1);
            expect(r.out).toBe(`rpc probe: ${counts}\n`);
            expect(r.err).toBe(
                "deposits need the probe to exit 0, a quorum of at least 2 domains and at least 2 listing endpoints\n",
            );
            expect(r.all).not.toMatch(/rpc\d/);
        }
    });

    it("--deposits on refuses a release without rpc probe", () => {
        const server = fakeServer({ usage: OLD_USAGE, active: true });
        const before = readFileSync(server.toml, "utf8");
        const r = server.run("do_deposits on");
        expect(r.code).toBe(1);
        expect(r.out).toBe("");
        expect(r.err).toBe("deposits need the RPC router release; install it first\n");
        expect(readFileSync(server.toml, "utf8")).toBe(before);
        expect(before).toContain("enabled = false\n");
        expect(server.calls()).toEqual(["root "]);
    });

    it("--deposits on runs the probe as the service user, then turns deposits on", () => {
        const server = fakeServer({ active: true });
        writeFileSync(join(server.root, "probe.exit"), "1");
        let r = server.run("do_deposits on");
        expect(r.code).toBe(1);
        expect(readFileSync(server.toml, "utf8")).toContain("enabled = false\n");
        expect(server.calls()).not.toContain("systemctl restart bugnet-payments@v9");

        writeFileSync(join(server.root, "probe.exit"), "0");
        r = server.run("do_deposits on");
        expect(r.code).toBe(0);
        expect(r.out).toContain("rpc probe: exit 0, quorum 2 of 2 domains ready");
        expect(readFileSync(server.toml, "utf8")).toBe("[solana]\n\n[deposits]\nenabled = true\n");
        expect(server.calls()).toContain(`bugnet-payments -config ${server.toml} rpc probe`);
        expect(server.calls()).toContain("systemctl restart bugnet-payments@v9");
        expect(r.all).not.toContain("rpc1.example");

        r = server.run("do_deposits off");
        expect(r.code).toBe(0);
        expect(readFileSync(server.toml, "utf8")).toBe("[solana]\n\n[deposits]\nenabled = false\n");
    });

    it("--deposits on refuses a bad list line or a missing seed before the probe", () => {
        const bad = keysEnv().replace(
            "BUGNET_SOLANA_RPC_URLS=https://rpc1.example,https://rpc2.example",
            "BUGNET_SOLANA_RPC_URLS=https://rpc1.example, https://rpc2.example",
        );
        const noSeed = keysEnv().replace(/^BUGNET_DEPOSIT_SEED=.*\n/m, "");
        for (const [env, message] of [
            [bad, "BUGNET_SOLANA_RPC_URLS holds a space or a shell character"],
            [noSeed, "has no BUGNET_DEPOSIT_SEED"],
        ]) {
            const server = fakeServer({ active: true, env });
            const r = server.run("do_deposits on");
            expect(r.code).toBe(1);
            expect(r.err).toContain(message);
            expect(readFileSync(server.toml, "utf8")).toContain("enabled = false\n");
            expect(server.calls().some((c) => c.endsWith("rpc probe"))).toBe(false);
            expect(server.calls()).not.toContain("systemctl restart bugnet-payments@v9");
            expect(r.all).not.toContain("rpc1.example");
        }
    });

    it("--start and --deposits refuse while a seed rotation stopped halfway", () => {
        const server = fakeServer({ active: true });
        writeFileSync(server.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
        writeFileSync(server.rotating, "2\n");
        const before = readFileSync(server.toml, "utf8");
        for (const cmd of ["main --start", "do_deposits off", "do_deposits on"]) {
            const r = server.run(cmd);
            expect(r.code).toBe(1);
            expect(r.err).toContain(
                "a seed rotation stopped halfway; run --rotate-deposit-seed again first",
            );
        }
        expect(readFileSync(server.toml, "utf8")).toBe(before);
        expect(server.calls().some((c) => c.startsWith("systemctl"))).toBe(false);
    });

    it("--deposits remove refuses while deposits are on or money could still move", () => {
        const doneLine = "ord_d state=done received=1 returned=1 kept=0 review=0 held=0 reason=-\n";
        const cases: [string, string, string, string][] = [
            [
                "[solana]\n\n[deposits]\nenabled = true\n",
                "",
                "",
                "deposits are on; run --deposits off first",
            ],
            ...["open", "settling", "draining"].map((state): [string, string, string, string] => [
                "[solana]\n\n[deposits]\nenabled = false\n",
                `${doneLine}ord_a state=${state} received=1 returned=0 kept=0 review=0 held=0 reason=-\n`,
                "",
                "deposits open, settling or draining: 1; with a move in flight: 0",
            ]),
            [
                "[solana]\n\n[deposits]\nenabled = false\n",
                `${doneLine}ord_c state=closed received=1 returned=0 kept=0 review=0 held=0 reason=-\n`,
                "ord_c state=closed received=1 returned=0 kept=0 review=0 held=0 reason=-\n",
                "deposits open, settling or draining: 0; with a move in flight: 1",
            ],
        ];
        for (const [toml, all, moving, message] of cases) {
            const server = fakeServer({ active: true });
            writeFileSync(server.toml, toml);
            writeFileSync(join(server.root, "all.out"), all);
            writeFileSync(join(server.root, "moving.out"), moving);
            const r = server.run("main --deposits remove");
            expect(r.code).toBe(1);
            expect(r.err).toContain(message);
            expect(readFileSync(server.toml, "utf8")).toBe(toml);
            expect(server.calls().some((c) => c.startsWith("systemctl"))).toBe(false);
        }
    });

    it("--deposits remove takes [deposits] out by a rename, restarts nothing, and --start then refuses", () => {
        const server = fakeServer({ active: true });
        writeFileSync(
            server.toml,
            '[solana]\nrecipient = "R"\n\n[deposits]\nenabled = false\nseed_version = 2\n\n[limits]\nx = 1\n',
        );
        writeFileSync(
            join(server.root, "all.out"),
            "ord_c state=closed received=1 returned=1 kept=0 review=0 held=0 reason=-\n" +
                "ord_d state=done received=1 returned=1 kept=0 review=0 held=0 reason=-\n",
        );
        const ino = statSync(server.toml).ino;
        let r = server.run("main --deposits remove");
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(readFileSync(server.toml, "utf8")).toBe(
            '[solana]\nrecipient = "R"\n\n[limits]\nx = 1\n',
        );
        expect(statSync(server.toml).ino).not.toBe(ino);
        expect(statSync(server.toml).mode & 0o777).toBe(0o644);
        expect(server.calls()).toEqual([
            `bugnet-payments -config ${server.toml} deposits list`,
            `bugnet-payments -config ${server.toml} deposits list --moving`,
        ]);

        // This release would read the missing section as deposits on
        r = server.run("main --start");
        expect(r.code).toBe(1);
        expect(r.err).toContain(
            `${server.toml} has no [deposits]; run --deposits off to add it back`,
        );
        expect(server.calls().some((c) => c.startsWith("systemctl restart"))).toBe(false);

        r = server.run("main --deposits remove");
        expect(r.code).toBe(0);
        expect(r.out).toContain("has no [deposits]");

        r = server.run("main --deposits off");
        expect(r.code).toBe(0);
        expect(readFileSync(server.toml, "utf8")).toContain("\n[deposits]\nenabled = false\n");
        expect(server.calls()).toContain("systemctl restart bugnet-payments@v9");
    });

    it("--deposits remove keeps seed_version for the step that adds [deposits] back", () => {
        for (const add of ['ensure_toml "" "" ""', "main --deposits off"]) {
            const server = fakeServer({ active: true });
            const kept = join(server.root, "etc", "payments.seed_version");
            writeFileSync(
                server.toml,
                '[solana]\nrecipient = "R"\n\n[deposits]\nenabled = false\nseed_version = 2\n',
            );
            expect(server.run("main --deposits remove").code).toBe(0);
            expect(readFileSync(server.toml, "utf8")).not.toContain("seed_version");
            expect(readFileSync(kept, "utf8")).toBe("2\n");
            // A rotation run before the section is back still counts from version 2
            expect(server.run("seed_version").out).toBe("2\n");

            const r = server.run(add);
            expect(r.code).toBe(0);
            const toml = readFileSync(server.toml, "utf8");
            expect(toml).toContain("[deposits]\n");
            expect(toml).toContain("enabled = false\n");
            expect(toml).toContain("seed_version = 2\n");
            expect(existsSync(kept)).toBe(false);
            expect(server.run("seed_version").out).toBe("2\n");
        }
    });

    it("deposits_set gives a section it adds enabled = false", () => {
        const server = fakeServer();
        writeFileSync(server.toml, "[solana]\n");
        expect(server.run("deposits_set seed_version 2").code).toBe(0);
        expect(readFileSync(server.toml, "utf8")).toBe(
            "[solana]\n\n[deposits]\nseed_version = 2\nenabled = false\n",
        );
    });

    it("the install step adds [deposits] enabled = false once", () => {
        const server = fakeServer();
        writeFileSync(server.toml, '[solana]\nrecipient = "R"\n\n[x402]\nallowance_wallet = ""\n');
        let r = server.run('ensure_toml "" "" ""');
        expect(r.code).toBe(0);
        expect(readFileSync(server.toml, "utf8")).toBe(
            '[solana]\nrecipient = "R"\n\n[x402]\nallowance_wallet = "Allowance1111"\n\n[deposits]\nenabled = false\n',
        );
        r = server.run('deposits_set enabled true; ensure_toml "" "" ""');
        expect(r.code).toBe(0);
        const toml = readFileSync(server.toml, "utf8");
        expect(toml).toContain("[deposits]\nenabled = true\n");
        expect(toml.match(/\[deposits\]/g)).toHaveLength(1);
    });

    it("deposits_set adds a missing key and replaces one, inside [deposits] only", () => {
        const server = fakeServer();
        writeFileSync(server.toml, "[deposits]\nenabled = false\n\n[limits]\nseed_version = 9\n");
        server.run("deposits_set seed_version 2");
        expect(readFileSync(server.toml, "utf8")).toBe(
            "[deposits]\nseed_version = 2\nenabled = false\n\n[limits]\nseed_version = 9\n",
        );
        server.run("deposits_set seed_version 3");
        expect(readFileSync(server.toml, "utf8")).toBe(
            "[deposits]\nseed_version = 3\nenabled = false\n\n[limits]\nseed_version = 9\n",
        );
        writeFileSync(server.toml, "[solana]\n");
        server.run("deposits_set enabled false");
        expect(readFileSync(server.toml, "utf8")).toBe("[solana]\n\n[deposits]\nenabled = false\n");
    });

    it("deposits_set leaves a root-level key of the same name alone", () => {
        const server = fakeServer();
        writeFileSync(server.toml, "enabled = 1\n[solana]\n\n[deposits]\nenabled = false\n");
        server.run("deposits_set enabled true");
        expect(readFileSync(server.toml, "utf8")).toBe(
            "enabled = 1\n[solana]\n\n[deposits]\nenabled = true\n",
        );
    });

    it("deposits_set and toml_set replace the TOML by a rename, mode 0644", () => {
        const server = fakeServer();
        writeFileSync(server.toml, '[solana]\nrecipient = "A"\n\n[deposits]\nenabled = false\n');
        let ino = statSync(server.toml).ino;
        expect(server.run("deposits_set enabled true").code).toBe(0);
        expect(statSync(server.toml).ino).not.toBe(ino);
        expect(statSync(server.toml).mode & 0o777).toBe(0o644);
        ino = statSync(server.toml).ino;
        expect(server.run("toml_set solana recipient B").code).toBe(0);
        expect(statSync(server.toml).ino).not.toBe(ino);
        expect(statSync(server.toml).mode & 0o777).toBe(0o644);
        expect(readFileSync(server.toml, "utf8")).toBe(
            '[solana]\nrecipient = "B"\n\n[deposits]\nenabled = true\n',
        );
    });

    it("--rotate-deposit-seed rotates once and raises seed_version", () => {
        const server = fakeServer({ active: true });
        let r = server.run("do_rotate_seed");
        expect(r.code).toBe(0);
        expect(server.calls()).toContain(`root keys rotate-deposit-seed --env ${server.env}`);
        expect(readFileSync(server.toml, "utf8")).toBe(
            "[solana]\n\n[deposits]\nseed_version = 2\nenabled = false\n",
        );
        expect(existsSync(server.rotating)).toBe(false);
        expect(server.calls()).toContain("systemctl restart bugnet-payments@v9");
        expect(r.all).not.toContain(SEED);

        r = server.run("do_rotate_seed");
        expect(r.code).toBe(1);
        expect(r.err).toContain(
            "BUGNET_DEPOSIT_SEED_PREVIOUS is set: an earlier rotation is still draining; run deploy/retire-deposit-seed.sh first",
        );
        expect(readFileSync(server.toml, "utf8")).toContain("seed_version = 2\n");
        expect(server.calls().filter((c) => c.includes("rotate-deposit-seed"))).toHaveLength(1);
    });

    it("the rotation marker is written by a rename, so a failed write leaves none", () => {
        const server = fakeServer({ active: true });
        const bin = join(server.root, "bin");
        writeFileSync(join(bin, "mv"), "#!/usr/bin/env bash\nexit 1\n");
        chmodSync(join(bin, "mv"), 0o755);
        const r = server.run("do_rotate_seed");
        expect(r.code).not.toBe(0);
        expect(existsSync(server.rotating)).toBe(false);
        expect(server.calls().some((c) => c.includes("rotate-deposit-seed"))).toBe(false);
        expect(readFileSync(server.env, "utf8")).not.toContain("BUGNET_DEPOSIT_SEED_PREVIOUS=");
    });

    it("a rotation that stopped halfway is finished and never rotates twice", () => {
        const server = fakeServer();
        // The env file already moved the seed, then the run stopped before the TOML changed
        writeFileSync(server.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
        writeFileSync(server.rotating, "2\n");
        const r = server.run("do_rotate_seed");
        expect(r.code).toBe(0);
        expect(server.calls().some((c) => c.includes("rotate-deposit-seed"))).toBe(false);
        expect(readFileSync(server.toml, "utf8")).toContain("seed_version = 2\n");
        expect(existsSync(server.rotating)).toBe(false);
    });

    it("a rotation that stopped right after its marker rotates exactly once", () => {
        const server = fakeServer({ active: true });
        writeFileSync(server.rotating, "2\n");
        const r = server.run("do_rotate_seed");
        expect(r.code).toBe(0);
        expect(server.calls().filter((c) => c.includes("rotate-deposit-seed"))).toEqual([
            `root keys rotate-deposit-seed --env ${server.env}`,
        ]);
        expect(readFileSync(server.toml, "utf8")).toBe(
            "[solana]\n\n[deposits]\nseed_version = 2\nenabled = false\n",
        );
        expect(server.calls()).toContain("systemctl restart bugnet-payments@v9");
        expect(existsSync(server.rotating)).toBe(false);
    });

    it("a rotation whose seed_version is already raised only restarts and removes the marker", () => {
        const server = fakeServer({ active: true });
        writeFileSync(server.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
        const toml = "[deposits]\nseed_version = 2\nenabled = true\n";
        writeFileSync(server.toml, toml);
        writeFileSync(server.rotating, "2\n");
        const r = server.run("do_rotate_seed");
        expect(r.code).toBe(0);
        expect(server.calls().some((c) => c.includes("rotate-deposit-seed"))).toBe(false);
        expect(readFileSync(server.toml, "utf8")).toBe(toml);
        expect(server.calls()).toContain("systemctl restart bugnet-payments@v9");
        expect(existsSync(server.rotating)).toBe(false);
    });

    it("a rotation marker that names neither the version nor the next one changes nothing", () => {
        for (const marker of ["5\n", "x\n", ""]) {
            const server = fakeServer({ active: true });
            writeFileSync(server.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
            const toml = "[deposits]\nseed_version = 1\nenabled = true\n";
            writeFileSync(server.toml, toml);
            writeFileSync(server.rotating, marker);
            const r = server.run("do_rotate_seed");
            expect(r.code).toBe(1);
            expect(r.err).toContain("does not name seed version 1 or 2; nothing was changed");
            expect(r.err).not.toContain("remove");
            expect(readFileSync(server.toml, "utf8")).toBe(toml);
            expect(server.calls()).toEqual([]);
            expect(existsSync(server.rotating)).toBe(true);
        }
    });

    it("--retire-deposit-seed - prints only the archive line and removes nothing", () => {
        const server = fakeServer({ active: true });
        writeFileSync(server.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
        writeFileSync(server.toml, "[deposits]\nenabled = true\nseed_version = 2\n");
        writeFileSync(
            join(server.root, "list.out"),
            "ord_a state=done received=50000 returned=0 kept=0 review=0 held=0 reason=-\n",
        );
        const r = server.run("do_retire_seed 0");
        expect(r.code).toBe(0);
        expect(r.out).toBe(`BUGNET_DEPOSIT_SEED_V1=${OLD_SEED}\n`);
        expect(r.err).not.toContain(OLD_SEED);
        expect(server.calls()).toEqual([
            `bugnet-payments -config ${server.toml} deposits list --version 1`,
            `root keys retire-deposit-seed --env ${server.env} --archive - --version 1`,
        ]);
        expect(readFileSync(server.env, "utf8")).toContain("BUGNET_DEPOSIT_SEED_PREVIOUS=");
    });

    it("--retire-deposit-seed refuses while an old deposit is not done or a rotation is unfinished", () => {
        const server = fakeServer();
        writeFileSync(server.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
        writeFileSync(server.toml, "[deposits]\nseed_version = 2\n");
        writeFileSync(
            join(server.root, "list.out"),
            "ord_a state=done received=1 returned=0 kept=0 review=0 held=0 reason=-\n" +
                "ord_b state=closed received=1 returned=0 kept=0 review=0 held=0 reason=-\n",
        );
        let r = server.run("do_retire_seed 0");
        expect(r.code).toBe(1);
        expect(r.out).toBe("");
        expect(r.err).toContain("deposits of seed version 1 not done yet: 1");
        expect(server.calls().some((c) => c.includes("keys retire"))).toBe(false);

        writeFileSync(server.rotating, "3\n");
        r = server.run("do_retire_seed 0");
        expect(r.code).toBe(1);
        expect(r.err).toContain("a seed rotation stopped halfway");
        expect(server.calls().some((c) => c.includes("keys retire"))).toBe(false);
    });

    it("--retire-deposit-seed - --remove-previous passes the line on stdin, then restarts", () => {
        const server = fakeServer({ active: true });
        writeFileSync(server.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
        writeFileSync(server.toml, "[deposits]\nseed_version = 2\n");
        const r = server.run("do_retire_seed 1", `BUGNET_DEPOSIT_SEED_V1=${OLD_SEED}\n`);
        expect(r.code).toBe(0);
        expect(r.out).toBe("");
        expect(r.all).not.toContain(OLD_SEED);
        expect(readFileSync(join(server.root, "stdin"), "utf8")).toBe(
            `BUGNET_DEPOSIT_SEED_V1=${OLD_SEED}\n`,
        );
        expect(server.calls()).toContain(
            `root keys retire-deposit-seed --env ${server.env} --archive - --version 1 --remove-previous`,
        );
        expect(readFileSync(server.env, "utf8")).not.toContain("BUGNET_DEPOSIT_SEED_PREVIOUS=");
        expect(server.calls()).toContain("systemctl restart bugnet-payments@v9");
    });

    it("--retire-deposit-seed takes only -, so no seed file is written on the server", () => {
        const cases: [string, string][] = [
            [
                "main --retire-deposit-seed seeds.env",
                "--retire-deposit-seed takes -; deploy/retire-deposit-seed.sh runs it from the Mac",
            ],
            [
                "main --retire-deposit-seed --remove-previous",
                "--retire-deposit-seed takes -; deploy/retire-deposit-seed.sh runs it from the Mac",
            ],
            [
                "main --retire-deposit-seed",
                "--retire-deposit-seed takes -; deploy/retire-deposit-seed.sh runs it from the Mac",
            ],
            [
                "main --start --remove-previous",
                "--remove-previous goes with --retire-deposit-seed -",
            ],
        ];
        for (const [cmd, message] of cases) {
            const server = fakeServer({ active: true });
            writeFileSync(server.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
            writeFileSync(server.toml, "[deposits]\nseed_version = 2\n");
            const r = server.run(cmd);
            expect(r.code).toBe(1);
            expect(r.err).toBe(`vps-install: ${message}\n`);
            expect(server.calls()).toEqual([]);
            expect(readFileSync(server.env, "utf8")).toContain("BUGNET_DEPOSIT_SEED_PREVIOUS=");
            expect(readdirSync(dir).toSorted()).toEqual(["payments.env", "server"]);
        }
    });
});

describe("vps-install.sh retirement at a terminal", () => {
    it("--retire-deposit-seed never prints or reads the seed at a terminal", () => {
        // on_terminal stands in for [ -t fd ], since a test has no terminal to give the script
        for (const [fd, cmd] of [
            ["3", "main --retire-deposit-seed -"],
            ["0", "main --retire-deposit-seed - --remove-previous"],
        ] as const) {
            const server = fakeServer({ active: true });
            writeFileSync(server.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
            writeFileSync(server.toml, "[deposits]\nseed_version = 2\n");
            const r = server.run(`on_terminal() { [ "$1" = ${fd} ]; }; ${cmd}`);
            expect(r.code).toBe(1);
            expect(r.err).toBe("vps-install: run deploy/retire-deposit-seed.sh from the Mac\n");
            expect(r.all).not.toContain(OLD_SEED);
            expect(server.calls()).toEqual([]);
            expect(readFileSync(server.env, "utf8")).toContain("BUGNET_DEPOSIT_SEED_PREVIOUS=");
        }
    });
});

describe("vps-install.sh payments token", () => {
    const TOKEN = "T".repeat(20) + "ok+/=_.-" + "k".repeat(16);

    it("--payments-token writes the line by a rename and prints only that it was set", () => {
        const server = fakeServer();
        writeFileSync(server.env, keysEnv("BUGNET_PAYMENTS_ROUTER_TOKEN=router\n"));
        const ino = statSync(server.env).ino;
        const r = server.run("main --payments-token", `BUGNET_PAYMENTS_TOKEN=${TOKEN}\n`);
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(r.out).toBe(`BUGNET_PAYMENTS_TOKEN set in ${server.env}\n`);
        const text = readFileSync(server.env, "utf8");
        expect(text.match(/^BUGNET_PAYMENTS_TOKEN=.*$/gm)).toEqual([
            `BUGNET_PAYMENTS_TOKEN=${TOKEN}`,
        ]);
        expect(text.replace(`BUGNET_PAYMENTS_TOKEN=${TOKEN}\n`, "")).toBe(
            keysEnv("BUGNET_PAYMENTS_ROUTER_TOKEN=router\n").replace(
                "BUGNET_PAYMENTS_TOKEN=x\n",
                "",
            ),
        );
        expect(statSync(server.env).ino).not.toBe(ino);
        expect(statSync(server.env).mode & 0o777).toBe(0o600);
    });

    it("--payments-token refuses another name, a bad value, two lines or the router's token", () => {
        const cases: [string, string][] = [
            [
                "BUGNET_FEE_PAYER_KEY=" + "f".repeat(44) + "\n",
                "expected a BUGNET_PAYMENTS_TOKEN line",
            ],
            [
                "BUGNET_PAYMENTS_TOKEN=short\n",
                "BUGNET_PAYMENTS_TOKEN is shorter than 32 characters",
            ],
            [
                `BUGNET_PAYMENTS_TOKEN=${TOKEN};x\n`,
                "BUGNET_PAYMENTS_TOKEN holds a character other than",
            ],
            [
                `BUGNET_PAYMENTS_TOKEN=${TOKEN} \n`,
                "BUGNET_PAYMENTS_TOKEN holds a character other than",
            ],
            [
                `BUGNET_PAYMENTS_TOKEN=${TOKEN}\nBUGNET_PAYMENTS_TOKEN=${TOKEN}\n`,
                "expected one BUGNET_PAYMENTS_TOKEN line on stdin",
            ],
            ["", "expected one BUGNET_PAYMENTS_TOKEN line on stdin"],
            [
                `BUGNET_PAYMENTS_TOKEN=${TOKEN}\n`,
                "BUGNET_PAYMENTS_TOKEN must differ from BUGNET_PAYMENTS_ROUTER_TOKEN",
            ],
        ];
        for (const [stdin, message] of cases) {
            const server = fakeServer();
            const before = keysEnv(`BUGNET_PAYMENTS_ROUTER_TOKEN=${TOKEN}\n`);
            writeFileSync(server.env, before);
            const r = server.run("main --payments-token", stdin);
            expect(r.code).toBe(1);
            expect(r.err).toContain(message);
            expect(r.err).toContain("BUGNET_PAYMENTS_TOKEN was not changed");
            expect(readFileSync(server.env, "utf8")).toBe(before);
            expect(r.all).not.toContain(TOKEN);
            expect(r.all).not.toContain("f".repeat(44));
        }
    });
});

const DUMP_NAME = /^bugnet_payments-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;

function dumpsIn(folder: string): string[] {
    return existsSync(folder) ? readdirSync(folder).filter((f) => DUMP_NAME.test(f)) : [];
}

describe("vps-install.sh backups", () => {
    const OLD_UNIT = "bugnet-payments@v8.service loaded active running Bugnet Payments v8\n";

    it("--backup dumps the database now and touches no unit", () => {
        const server = fakeServer({ active: true });
        let r = server.run("main --backup");
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        const dumps = dumpsIn(server.backups);
        expect(dumps).toHaveLength(1);
        const dump = join(server.backups, dumps[0]!);
        expect(r.out).toBe(`== wrote ${dump} (${statSync(dump).size} bytes)\n`);
        expect(server.calls()[0]).toBe("postgres pg_dump --format=custom bugnet_payments");
        expect(server.calls().some((c) => c.startsWith("systemctl"))).toBe(false);

        writeFileSync(join(server.root, "pg_dump.exit"), "1");
        r = server.run("main --backup");
        expect(r.code).toBe(1);
        expect(r.out).toBe("");
        expect(r.err).toBe(
            "payments-backup: pg_dump of bugnet_payments failed; no dump was written\n" +
                "vps-install: the backup failed\n",
        );
        expect(server.calls().some((c) => c.startsWith("systemctl"))).toBe(false);
    });

    it("--start backs up the database before it stops or restarts any unit", () => {
        const server = fakeServer({ active: true });
        writeFileSync(join(server.root, "units.out"), OLD_UNIT);
        const r = server.run("main --start");
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(dumpsIn(server.backups)).toHaveLength(1);
        const calls = server.calls();
        const dumped = calls.indexOf("postgres pg_dump --format=custom bugnet_payments");
        expect(dumped).toBeGreaterThanOrEqual(0);
        expect(dumped).toBeLessThan(calls.findIndex((c) => c.startsWith("systemctl")));
        expect(calls).toContain("systemctl disable --now bugnet-payments@v8.service");
        expect(calls).toContain("systemctl restart bugnet-payments@v9");
    });

    it("--start stops, touching no unit, when the backup fails", () => {
        const cases: [string, string][] = [
            ["pg_dump.exit", "payments-backup: pg_dump of bugnet_payments failed"],
            ["pg_restore.exit", "payments-backup: pg_restore --list cannot read the dump"],
            ["", "lib/payments-backup.sh is missing; run the install step first"],
        ];
        for (const [file, message] of cases) {
            const server = fakeServer({ active: true });
            writeFileSync(join(server.root, "units.out"), OLD_UNIT);
            if (file === "") rmSync(join(server.root, "lib", "payments-backup.sh"));
            else writeFileSync(join(server.root, file), "1");
            const r = server.run("main --start");
            expect(r.code).toBe(1);
            expect(r.err).toContain(message);
            expect(r.err).toContain(
                "vps-install: the backup failed, so nothing was stopped or started\n",
            );
            expect(server.calls().some((c) => c.startsWith("systemctl"))).toBe(false);
            expect(existsSync(server.backups) ? readdirSync(server.backups) : []).toEqual([]);
        }
    });

    it("--deposits, the rotation and the retirement restart the running release without a dump", () => {
        const cases: [string, string, (s: ReturnType<typeof fakeServer>) => void][] = [
            [
                "main --deposits off",
                "",
                (s) => {
                    writeFileSync(s.toml, "[solana]\n\n[deposits]\nenabled = true\n");
                },
            ],
            ["main --rotate-deposit-seed", "", () => {}],
            [
                "main --retire-deposit-seed - --remove-previous",
                `BUGNET_DEPOSIT_SEED_V1=${OLD_SEED}\n`,
                (s) => {
                    writeFileSync(s.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
                    writeFileSync(s.toml, "[deposits]\nenabled = false\nseed_version = 2\n");
                },
            ],
        ];
        for (const [cmd, stdin, setup] of cases) {
            const server = fakeServer({ active: true });
            setup(server);
            // A dump would fail, so a restart that waited on one would never happen
            writeFileSync(join(server.root, "pg_dump.exit"), "1");
            const r = server.run(`on_terminal() { false; }; ${cmd}`, stdin);
            expect(r.all).not.toContain("backup");
            expect(r.code).toBe(0);
            expect(server.calls().some((c) => c.includes("pg_dump"))).toBe(false);
            expect(server.calls()).toContain("systemctl restart bugnet-payments@v9");
            expect(existsSync(server.rotating)).toBe(false);
        }
    });

    it("no secret reaches the backup's output or the dump", () => {
        const server = fakeServer({ active: true });
        writeFileSync(server.env, keysEnv(`BUGNET_DEPOSIT_SEED_PREVIOUS=${OLD_SEED}\n`));
        for (const cmd of ["main --backup", "main --start"]) {
            const r = server.run(cmd);
            expect(r.code).toBe(0);
            for (const secret of [SEED, OLD_SEED]) {
                expect(r.all).not.toContain(secret);
                for (const f of readdirSync(server.backups)) {
                    expect(readFileSync(join(server.backups, f), "utf8")).not.toContain(secret);
                }
            }
        }
    });

    it("ensure_backup installs the script and both units and enables the timer", () => {
        const server = fakeServer();
        const deploy = join(server.root, "opt", "v9", "deploy");
        const lib = join(server.root, "lib");
        const units = join(server.root, "systemd");
        const script = join(lib, "payments-backup.sh");
        mkdirSync(deploy);
        for (const f of ["payments-backup.sh", ...BACKUP_UNITS]) {
            copyFileSync(join(DEPLOY, f), join(deploy, f));
        }
        rmSync(lib, { recursive: true });
        for (const round of [1, 2]) {
            writeFileSync(join(server.root, "calls.log"), "");
            const r = server.run("ensure_backup v9");
            expect(r.err).toBe("");
            expect(r.code).toBe(0);
            expect(readFileSync(script, "utf8")).toBe(readFileSync(BACKUP, "utf8"));
            expect(statSync(script).mode & 0o777).toBe(0o755);
            expect(statSync(lib).mode & 0o777).toBe(0o755);
            for (const unit of BACKUP_UNITS) {
                const f = join(units, unit);
                expect(readFileSync(f, "utf8")).toBe(readFileSync(join(DEPLOY, unit), "utf8"));
                expect(statSync(f).mode & 0o777).toBe(0o644);
            }
            expect(statSync(server.backups).mode & 0o777).toBe(0o700);
            const calls = server.calls();
            expect(calls.filter((c) => c.startsWith("install"))).toEqual([
                `install -d -o root -g root -m 0755 ${lib}`,
                `install -o root -g root -m 0755 ${deploy}/payments-backup.sh ${script}`,
                `install -o root -g root -m 0644 ${deploy}/${BACKUP_UNITS[0]} ${deploy}/${BACKUP_UNITS[1]} ${units}/`,
                `install -d -o root -g root -m 0700 ${server.backups}`,
            ]);
            expect(calls.filter((c) => c.startsWith("systemctl"))).toEqual([
                "systemctl daemon-reload",
                "systemctl enable --now bugnet-payments-backup.timer",
            ]);
            if (round === 1) chmodSync(server.backups, 0o755);
        }
    });

    it("the install step runs ensure_backup after the service's unit", () => {
        const server = fakeServer();
        const tgz = join(dir, "bugnet-payments-v9.tgz");
        writeFileSync(tgz, "");
        const steps = [
            "ensure_node",
            "ensure_user",
            "install_code",
            "ensure_postgres",
            "ensure_keys",
            "ensure_router_token",
            "ensure_toml",
            "ensure_index",
            "ensure_unit",
            "ensure_backup",
            "do_pubkeys",
        ];
        const stubs = steps.map((step) => `${step}() { echo "${step} $*"; }`).join("; ");
        const r = server.run(`${stubs}; do_install "${tgz}" "" "" "" ""`);
        expect(r.code).toBe(0);
        const ran = r.out.split("\n").filter((l) => steps.includes(l.split(" ")[0]!));
        expect(ran.map((l) => l.split(" ")[0])).toEqual(steps);
        expect(ran).toContain("ensure_backup v9");
    });

    it("the units run the installed script at 02:15 UTC and may write only the backup folder", () => {
        const r = spawnSync("bash", ["-c", `. "${SCRIPT}"; echo "$BACKUP_SCRIPT $BACKUP_DIR"`], {
            encoding: "utf8",
            env: { ...process.env, VPS_INSTALL_LIB: "1" },
        });
        const [script, folder] = r.stdout.trim().split(" ");
        expect(script).toBe("/usr/local/lib/bugnet/payments-backup.sh");
        expect(folder).toBe("/var/backups/bugnet-payments");
        expect(readFileSync(BACKUP, "utf8")).toContain(
            `BACKUP_DIR=\${BUGNET_PAYMENTS_BACKUP_DIR:-${folder}}\n`,
        );
        const service = readFileSync(join(DEPLOY, BACKUP_UNITS[0]), "utf8");
        for (const line of [
            "Type=oneshot",
            "User=root",
            `ExecStart=${script}`,
            "ProtectSystem=strict",
            `ReadWritePaths=${folder}`,
        ]) {
            expect(service.split("\n")).toContain(line);
        }
        const timer = readFileSync(join(DEPLOY, BACKUP_UNITS[1]), "utf8");
        for (const line of [
            "OnCalendar=*-*-* 02:15:00 UTC",
            "RandomizedDelaySec=15m",
            "Persistent=true",
            "WantedBy=timers.target",
        ]) {
            expect(timer.split("\n")).toContain(line);
        }
    });
});

const MIGRATIONS = join(import.meta.dirname, "../migrations");
const MIGRATION_FILES = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{5}_[a-z0-9_]+\.sql$/.test(f))
    .toSorted();
const PG_URL = new URL(
    process.env.BUGNET_TEST_PG_URL || "postgres://localhost:5432/postgres?sslmode=disable",
);
// The script's psql, createdb and pg_restore read these, so they reach the test server
const PG_ENV: Record<string, string> = {
    PGHOST: PG_URL.hostname,
    PGPORT: PG_URL.port || "5432",
    ...(PG_URL.username === "" ? {} : { PGUSER: decodeURIComponent(PG_URL.username) }),
    ...(PG_URL.password === "" ? {} : { PGPASSWORD: decodeURIComponent(PG_URL.password) }),
    ...(PG_URL.searchParams.has("sslmode")
        ? { PGSSLMODE: PG_URL.searchParams.get("sslmode")! }
        : {}),
};

function pg(cmd: string, args: string[]): string {
    const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...PG_ENV } });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
}

function sql(db: string, text: string): string {
    return pg("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-d", db, "-c", text]);
}

// As src/db/migrate.ts does, one file at a time
function migrateTo(db: string, files: readonly string[]) {
    sql(
        db,
        "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())",
    );
    for (const f of files) {
        pg("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db, "-f", join(MIGRATIONS, f)]);
        sql(db, `insert into schema_migrations (version) values ('${f}')`);
    }
}

function databasesLike(prefix: string): string[] {
    const out = sql("postgres", `select datname from pg_database where datname like '${prefix}%'`);
    return out === "" ? [] : out.split("\n").toSorted();
}

describe("vps-install.sh restore", () => {
    const PRE = MIGRATION_FILES.slice(0, 4);
    const LATER = MIGRATION_FILES.slice(4);
    const UNITS =
        "bugnet-payments@v10.service loaded active running Bugnet Payments v10\n" +
        "bugnet-payments@v9.service loaded inactive dead Bugnet Payments v9\n";
    let db: string;

    beforeEach(() => {
        db = `bn_pay_restore_${randomBytes(6).toString("hex")}`;
    });
    afterEach(() => {
        for (const name of databasesLike(db)) {
            sql("postgres", `drop database if exists ${name} with (force)`);
        }
    });

    // A database at 00004, its dump, then a release whose migrations add tables with foreign keys
    // into the dumped ones, on a server where v10 still runs while v9 is installed. Postgres runs
    // for real; runuser logs and runs the tool as this user.
    function scene(o: { dumpedAt?: number; before?: () => void; after?: () => void } = {}) {
        expect(PRE.at(-1)).toBe("00004_paid_via.sql");
        const at = o.dumpedAt ?? PRE.length;
        sql("postgres", `create database ${db}`);
        migrateTo(db, MIGRATION_FILES.slice(0, at));
        o.before?.();
        const dump = join(dir, "pre.dump");
        pg("pg_dump", ["--format=custom", "-d", db, "-f", dump]);
        o.after?.();
        migrateTo(db, MIGRATION_FILES.slice(at));
        const server = fakeServer({ active: true });
        const bin = join(server.root, "bin");
        rmSync(join(bin, "pg_dump"));
        rmSync(join(bin, "pg_restore"));
        writeFileSync(
            join(bin, "runuser"),
            [
                "#!/usr/bin/env bash",
                `echo "runuser $*" >> "${join(server.root, "calls.log")}"`,
                'while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done',
                'shift; exec "$@"',
                "",
            ].join("\n"),
        );
        writeFileSync(join(server.root, "units.out"), UNITS);
        mkdirSync(join(server.root, "opt", "v9", "migrations"));
        for (const f of MIGRATION_FILES) {
            copyFileSync(join(MIGRATIONS, f), join(server.root, "opt", "v9", "migrations", f));
        }
        const role = sql("postgres", "select current_user");
        const restore = (file = dump) =>
            server.run(`DB=${db}; ROLE=${role}; main --restore "${file}"`, "", dir, PG_ENV);
        return { server, dump, role, restore };
    }

    it("--restore goes back before migrations whose tables point into the dump, keeping the old database", () => {
        const { server, role, restore } = scene();
        const r = restore();
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(
            sql(db, "select string_agg(version, ' ' order by version) from schema_migrations"),
        ).toBe(PRE.join(" "));
        expect(sql(db, "select to_regclass('public.deposits') is null")).toBe("t");
        expect(
            sql(
                "postgres",
                `select pg_get_userbyid(datdba) from pg_database where datname = '${db}'`,
            ),
        ).toBe(role);
        expect(
            sql(
                db,
                "select string_agg(distinct tableowner, ' ') from pg_tables where schemaname = 'public'",
            ),
        ).toBe(role);
        const kept = databasesLike(`${db}_before_`);
        expect(kept).toHaveLength(1);
        expect(kept[0]).toMatch(new RegExp(`^${db}_before_\\d{8}_\\d{6}$`));
        expect(sql(kept[0]!, "select count(*) from schema_migrations")).toBe(
            String(MIGRATION_FILES.length),
        );
        expect(sql(kept[0]!, "select to_regclass('public.deposits') is not null")).toBe("t");
        expect(databasesLike(`${db}_restoring`)).toEqual([]);
        expect(r.out).toContain(
            `== ${db} is now the dump; the database it replaced is ${kept[0]}, which only postgres opens\n`,
        );
        expect(r.out).toContain(
            `== bugnet-payments@v9 would run these migrations again at its start: ${LATER.join(" ")}\n`,
        );
        expect(r.out).toContain(
            "== nothing was started; README section 13 says what comes before --start\n",
        );
        const calls = server.calls();
        expect(calls.some((c) => /^systemctl (start|restart|enable)/.test(c))).toBe(false);
    });

    it("--restore stops and disables every version, not only the installed one, before the rename", () => {
        const { server, restore } = scene();
        const r = restore();
        expect(r.code).toBe(0);
        const calls = server.calls();
        const stops = calls.filter((c) => c.startsWith("systemctl disable"));
        expect(stops).toEqual([
            "systemctl disable --now bugnet-payments@v10.service",
            "systemctl disable --now bugnet-payments@v9.service",
        ]);
        const restored = calls.findIndex((c) => / pg_restore .* -d /.test(c));
        const renamed = calls.findIndex((c) => c.includes("alter database"));
        expect(restored).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf(stops[0]!)).toBeGreaterThan(restored);
        expect(calls.indexOf(stops[1]!)).toBeLessThan(renamed);
        expect(r.out).toContain("== stopped and disabled bugnet-payments@v10.service\n");
    });

    it("--restore names no migration when the installed release has none the dump lacks", () => {
        const { server, restore } = scene();
        for (const f of LATER) rmSync(join(server.root, "opt", "v9", "migrations", f));
        const r = restore();
        expect(r.code).toBe(0);
        expect(r.out).toContain(
            "== bugnet-payments@v9 runs no migration the restored database lacks\n",
        );
    });

    it("--restore pauses refunds and x402 and lists the rows that moved money after the dump", () => {
        const ORDER = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        const { restore } = scene({
            before: () => {
                sql(
                    db,
                    `insert into orders (id, kind, package_id, amount_micros, description, claim_sha256, state, expires_at)
                     values ('${ORDER}', 'start', 'p', 1000000, 'd', '\\x00', 'refunding', now())`,
                );
                sql(
                    db,
                    `insert into refunds (order_id, kind, reason, amount_micros, destination, payer, state)
                     values ('${ORDER}', 'full', 'operator', 1000000, 'Dest', 'Payer', 'pending')`,
                );
            },
            // The executor signed and landed the refund after the dump
            after: () => {
                sql(
                    db,
                    "update refunds set state = 'confirmed', tx_signature = 'SigAfterDump', signed_at = now()",
                );
            },
        });
        const r = restore();
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        const kept = databasesLike(`${db}_before_`)[0]!;
        expect(sql(db, "select paused, reason from refund_controls")).toBe("t|restore");
        expect(sql(db, "select paused, refunds_held, reason from x402_controls")).toBe(
            "t|t|restore",
        );
        expect(sql(kept, "select paused from refund_controls")).toBe("f");
        expect(sql(kept, "select paused, refunds_held from x402_controls")).toBe("f|f");
        expect(r.out).toContain(
            `== refunds and x402 payments are paused and x402 refunds held in ${db}\n` +
                `== rows that differ from ${kept}:\n` +
                `refunds 1: pending - here, confirmed SigAfterDump in ${kept}\n` +
                "deposit_moves: not compared, missing from one of the two databases\n",
        );
    });

    it("--restore says so when no row that moves money differs", () => {
        const { restore } = scene({ dumpedAt: 5 });
        const r = restore();
        expect(r.code).toBe(0);
        const kept = databasesLike(`${db}_before_`)[0]!;
        expect(r.out).toContain(
            `== no refund, deposit move or x402 payment differs from ${kept}\n`,
        );
        expect(r.out).not.toContain("not compared");
    });

    it("a failed restore stops nothing and leaves the database as it was", () => {
        const { server, restore } = scene();
        const real = spawnSync("bash", ["-c", "command -v pg_restore"], { encoding: "utf8" });
        writeFileSync(
            join(server.root, "bin", "pg_restore"),
            [
                "#!/usr/bin/env bash",
                `case " $* " in *" --list "*) exec "${real.stdout.trim()}" "$@" ;; esac`,
                'echo "pg_restore: error: could not execute query" >&2',
                "exit 1",
                "",
            ].join("\n"),
        );
        chmodSync(join(server.root, "bin", "pg_restore"), 0o755);
        const r = restore();
        expect(r.code).toBe(1);
        expect(r.err).toContain(
            `vps-install: the restore failed, so nothing was stopped and ${db} was not changed\n`,
        );
        expect(server.calls().some((c) => c.startsWith("systemctl"))).toBe(false);
        expect(sql(db, "select count(*) from schema_migrations")).toBe(
            String(MIGRATION_FILES.length),
        );
        expect(databasesLike(`${db}_`)).toEqual([]);
    });

    it("--restore refuses a file that is not a dump before it touches anything", () => {
        const server = fakeServer({ active: true });
        const file = join(dir, "not.dump");
        writeFileSync(file, "nope\n");
        for (const [f, message] of [
            [file, `pg_restore --list cannot read ${file}; nothing was changed`],
            [join(dir, "missing.dump"), `no such file: ${join(dir, "missing.dump")}`],
        ] as const) {
            writeFileSync(join(server.root, "calls.log"), "");
            const r = server.run(`main --restore "${f}"`);
            expect(r.code).toBe(1);
            expect(r.err).toBe(`vps-install: ${message}\n`);
            expect(server.calls().filter((c) => !c.startsWith("root pg_restore --list"))).toEqual(
                [],
            );
        }
    });
});

describe("payments-backup.sh", () => {
    it("dumps the database as postgres into a 0700 folder as a checked 0600 file", () => {
        const server = fakeServer();
        for (const made of [false, true]) {
            if (made) {
                rmSync(server.backups, { recursive: true });
                mkdirSync(server.backups, { mode: 0o755 });
                writeFileSync(join(server.root, "calls.log"), "");
            }
            const r = server.backup();
            expect(r.err).toBe("");
            expect(r.code).toBe(0);
            const files = readdirSync(server.backups);
            expect(files).toHaveLength(1);
            const name = files[0]!;
            expect(name).toMatch(DUMP_NAME);
            // The stamp is UTC and the time of the run
            const at = Date.parse(name.replace(DUMP_NAME, "$1-$2-$3T$4:$5:$6Z"));
            expect(Math.abs(Date.now() - at)).toBeLessThan(60_000);
            const dump = join(server.backups, name);
            expect(statSync(server.backups).mode & 0o777).toBe(0o700);
            expect(statSync(dump).mode & 0o777).toBe(0o600);
            expect(readFileSync(dump, "utf8")).toMatch(/^PGDMP\n/);
            const calls = server.calls();
            expect(calls).toHaveLength(2);
            expect(calls[0]).toBe("postgres pg_dump --format=custom bugnet_payments");
            expect(calls[1]).toBe(`root pg_restore --list ${dump}.${calls[1]!.slice(-6)}`);
            expect(r.out).toBe(`== wrote ${dump} (${statSync(dump).size} bytes)\n`);
            rmSync(dump);
        }
    });

    it("a failed dump, check or run leaves no partial file and exits non-zero", () => {
        const old = "bugnet_payments-20250101T021500Z.dump";
        const cases: [string, (root: string) => void, string][] = [
            [
                "pg_dump fails after writing part of the dump",
                (root) => writeFileSync(join(root, "pg_dump.exit"), "1"),
                "payments-backup: pg_dump of bugnet_payments failed; no dump was written\n",
            ],
            [
                "pg_restore --list cannot read the dump",
                (root) => writeFileSync(join(root, "pg_restore.exit"), "1"),
                "payments-backup: pg_restore --list cannot read the dump of bugnet_payments; no dump was written\n",
            ],
            [
                "the run is stopped while the dump is checked",
                (root) =>
                    writeFileSync(
                        join(root, "bin", "pg_restore"),
                        '#!/usr/bin/env bash\nkill -TERM "$PPID"\nexit 1\n',
                    ),
                "",
            ],
        ];
        for (const [, breakIt, message] of cases) {
            const server = fakeServer();
            mkdirSync(server.backups, { mode: 0o700 });
            writeFileSync(join(server.backups, old), "PGDMP old\n", { mode: 0o600 });
            breakIt(server.root);
            const r = server.backup();
            expect(r.code).not.toBe(0);
            expect(r.out).toBe("");
            if (message !== "") expect(r.err).toBe(message);
            expect(readdirSync(server.backups)).toEqual([old]);
        }
    });

    it("keeps the newest 14 dumps and leaves every other file alone", () => {
        const server = fakeServer();
        mkdirSync(server.backups, { mode: 0o700 });
        const olds = Array.from(
            { length: 16 },
            (_, i) => `bugnet_payments-202501${String(i + 1).padStart(2, "0")}T021500Z.dump`,
        );
        const others = [
            "notes.txt",
            "bugnet_payments-latest.dump",
            "bugnet_payments-20240101T021500Z.dump.bak",
            "bugnet_payments-2024-01-01.dump",
            "other_db-20240101T021500Z.dump",
        ];
        for (const f of [...olds, ...others]) writeFileSync(join(server.backups, f), "x");
        // Named like the oldest dump, but a folder
        const folder = "bugnet_payments-20240101T021500Z.dump";
        mkdirSync(join(server.backups, folder));
        const r = server.backup();
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        const files = readdirSync(server.backups).toSorted();
        const dumps = files.filter((f) => DUMP_NAME.test(f) && f !== folder);
        expect(dumps).toHaveLength(14);
        expect(dumps.slice(0, 13)).toEqual(olds.slice(3));
        expect(files.filter((f) => !dumps.includes(f))).toEqual([...others, folder].toSorted());
        expect(
            r.out
                .split("\n")
                .filter((l) => l.startsWith("== removed"))
                .toSorted(),
        ).toEqual(olds.slice(0, 3).map((f) => `== removed ${f}`));
    });

    it("keeps the number BUGNET_PAYMENTS_BACKUP_KEEP names, and refuses one below 1 before dumping", () => {
        const server = fakeServer();
        mkdirSync(server.backups, { mode: 0o700 });
        const olds = ["20250101", "20250102", "20250103"].map(
            (d) => `bugnet_payments-${d}T021500Z.dump`,
        );
        for (const f of olds) writeFileSync(join(server.backups, f), "x");
        let r = server.backup({ BUGNET_PAYMENTS_BACKUP_KEEP: "2" });
        expect(r.code).toBe(0);
        const files = readdirSync(server.backups).toSorted();
        expect(files).toHaveLength(2);
        expect(files[0]).toBe(olds[2]);
        for (const keep of ["0", "x", "014", "-1", "1.5"]) {
            writeFileSync(join(server.root, "calls.log"), "");
            r = server.backup({ BUGNET_PAYMENTS_BACKUP_KEEP: keep });
            expect(r.code).toBe(1);
            expect(r.err).toBe(
                "payments-backup: BUGNET_PAYMENTS_BACKUP_KEEP must be a whole number of at least 1\n",
            );
            expect(server.calls()).toEqual([]);
            expect(readdirSync(server.backups).toSorted()).toEqual(files);
        }
    });

    it("removes a temporary dump that a killed run left over a day ago, and nothing newer", () => {
        const server = fakeServer();
        mkdirSync(server.backups, { mode: 0o700 });
        const stale = "bugnet_payments-20250101T021500Z.dump.Ab12Cd";
        const running = "bugnet_payments-20250102T021500Z.dump.Xy34Zw";
        const other = "bugnet_payments-20250101T021500Z.dump.gz";
        const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
        for (const f of [stale, running, other]) writeFileSync(join(server.backups, f), "PGDMP");
        for (const f of [stale, other]) utimesSync(join(server.backups, f), twoDaysAgo, twoDaysAgo);
        const r = server.backup();
        expect(r.code).toBe(0);
        const files = readdirSync(server.backups);
        expect(files).not.toContain(stale);
        expect(files).toContain(running);
        expect(files).toContain(other);
        expect(r.out).toContain(`== removed ${stale}, left by a stopped run\n`);
    });
});

describe("retire-deposit-seed.sh", () => {
    const LINE = `BUGNET_DEPOSIT_SEED_V1=${OLD_SEED}`;

    // ssh is a fake: phase 1 prints the server's answer, phase 2 keeps what it was sent and exits
    // with phase2Exit
    function retire(
        answer: string,
        archive = join(dir, "vault", "deposit-seeds.env"),
        phase2Exit = 0,
    ) {
        const bin = join(dir, "bin");
        const calls = join(dir, "ssh-calls");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(dir, "answer"), answer);
        writeFileSync(
            join(bin, "ssh"),
            [
                "#!/usr/bin/env bash",
                `echo "$*" >> "${calls}"`,
                'for last in "$@"; do :; done',
                "case $last in",
                `*--remove-previous) cat > "${dir}/ssh-stdin"; exit ${phase2Exit} ;;`,
                `*) cat "${dir}/answer" ;;`,
                "esac",
                "",
            ].join("\n"),
        );
        chmodSync(join(bin, "ssh"), 0o755);
        const r = spawnSync("bash", [RETIRE, "-p", "2222", "server.example"], {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                BUGNET_DEPOSIT_ARCHIVE: archive,
            },
        });
        const sent = join(dir, "ssh-stdin");
        return {
            code: r.status,
            all: r.stdout + r.stderr,
            calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
            sent: existsSync(sent) ? readFileSync(sent, "utf8") : null,
            archive,
        };
    }

    it("retire-deposit-seed.sh archives the line and reads it back before the server removes it", () => {
        const r = retire(`${LINE}\n`);
        expect(r.code).toBe(0);
        expect(readFileSync(r.archive, "utf8")).toBe(`${LINE}\n`);
        expect(statSync(r.archive).mode & 0o777).toBe(0o600);
        expect(r.calls).toHaveLength(2);
        // No remote terminal, which would echo the seed line back to this screen
        expect(r.calls[0]).toMatch(
            /^-T -p 2222 server\.example sudo -n .*--retire-deposit-seed -$/,
        );
        expect(r.calls[1]).toMatch(/^-T -p 2222 .*--retire-deposit-seed - --remove-previous$/);
        expect(r.sent).toBe(`${LINE}\n`);
        expect(r.calls.join("\n")).not.toContain(OLD_SEED);
        expect(r.all).not.toContain(OLD_SEED);
        expect(r.all).toContain("BUGNET_DEPOSIT_SEED_V1");

        // A second run after a lost answer finds the same line and appends nothing
        rmSync(join(dir, "ssh-calls"));
        const again = retire(`${LINE}\n`);
        expect(again.code).toBe(0);
        expect(readFileSync(again.archive, "utf8")).toBe(`${LINE}\n`);
        expect(again.calls).toHaveLength(2);
    });

    it("retire-deposit-seed.sh removes nothing for another archived value or a bad answer", () => {
        const archive = join(dir, "vault", "deposit-seeds.env");
        mkdirSync(join(dir, "vault"));
        writeFileSync(archive, `BUGNET_DEPOSIT_SEED_V1=${SEED}\n`, { mode: 0o600 });
        let r = retire(`${LINE}\n`, archive);
        expect(r.code).toBe(1);
        expect(r.calls).toHaveLength(1);
        expect(r.sent).toBeNull();
        expect(readFileSync(archive, "utf8")).toBe(`BUGNET_DEPOSIT_SEED_V1=${SEED}\n`);
        expect(r.all).not.toContain(OLD_SEED);
        expect(r.all).not.toContain(SEED);

        for (const answer of [`${LINE}\nmore\n`, "BUGNET_DEPOSIT_SEED_V1=short\n"]) {
            rmSync(join(dir, "ssh-calls"));
            r = retire(answer, join(dir, "other", "deposit-seeds.env"));
            expect(r.code).toBe(1);
            expect(r.calls).toHaveLength(1);
            expect(existsSync(r.archive)).toBe(false);
        }
    });

    it("retire-deposit-seed.sh names no cause when phase 2 fails, and keeps the line", () => {
        const r = retire(`${LINE}\n`, undefined, 1);
        expect(r.code).toBe(1);
        expect(r.sent).toBe(`${LINE}\n`);
        expect(readFileSync(r.archive, "utf8")).toBe(`${LINE}\n`);
        expect(r.all).toContain(
            `retire-deposit-seed: phase 2 failed; check the server's message. BUGNET_DEPOSIT_SEED_V1 is in ${r.archive}\n`,
        );
        expect(r.all).not.toContain("the server kept");
        expect(r.all).not.toContain(OLD_SEED);
    });

    it("retire-deposit-seed.sh stops when there is nothing to retire", () => {
        const r = retire("");
        expect(r.code).toBe(0);
        expect(r.all).toContain("nothing to retire");
        expect(r.calls).toHaveLength(1);
        expect(existsSync(r.archive)).toBe(false);
    });

    it("retire-deposit-seed.sh refuses an archive inside a git checkout", () => {
        const repo = join(dir, "repo");
        expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
        const r = retire(`${LINE}\n`, join(repo, "keys", "deposit-seeds.env"));
        expect(r.code).toBe(1);
        expect(r.all).toContain("inside a git checkout");
        expect(r.calls).toEqual([]);
        expect(existsSync(join(repo, "keys"))).toBe(false);
    });
});

describe("push-payments-token.sh", () => {
    const TOKEN = "p".repeat(40);

    function push(envText: string) {
        const bin = join(dir, "bin");
        const got = join(dir, "ssh-stdin");
        const args = join(dir, "ssh-args");
        mkdirSync(bin, { recursive: true });
        writeFileSync(
            join(bin, "ssh"),
            `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${args}"\ncat > "${got}"\n`,
        );
        chmodSync(join(bin, "ssh"), 0o755);
        const local = join(dir, "local.env");
        writeFileSync(local, envText, { mode: 0o600 });
        const r = spawnSync("bash", [PUSH_TOKEN, "-p", "2222", "server.example"], {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                BUGNET_LOCAL_ENV: local,
            },
        });
        const sent = existsSync(got) ? readFileSync(got, "utf8") : null;
        const sshArgs = existsSync(args) ? readFileSync(args, "utf8").split("\n") : null;
        return { code: r.status, all: r.stdout + r.stderr, sent, sshArgs };
    }

    it("push-payments-token.sh sends only the token line, through a pipe", () => {
        const r = push(
            `BUGNET_FEE_PAYER_KEY=madeupfeepayer\nBUGNET_PAYMENTS_TOKEN=${TOKEN}\nBUGNET_PAYMENTS_TOKEN_OLD=madeupold\nBUGNET_CLAIM_KEY=madeupclaim\n`,
        );
        expect(r.code).toBe(0);
        expect(r.sent).toBe(`BUGNET_PAYMENTS_TOKEN=${TOKEN}\n`);
        expect(r.sshArgs?.slice(0, 4)).toEqual(["-T", "-p", "2222", "server.example"]);
        expect(r.sshArgs?.[4]).toMatch(/vps-install\.sh --payments-token$/);
        for (const secret of [TOKEN, "madeupfeepayer", "madeupold", "madeupclaim"]) {
            expect(r.all).not.toContain(secret);
            expect(r.sshArgs?.join("\n")).not.toContain(secret);
        }
    });

    it("push-payments-token.sh refuses no line, two lines or a bad value", () => {
        for (const text of [
            "BUGNET_FEE_PAYER_KEY=madeupfeepayer\n",
            `BUGNET_PAYMENTS_TOKEN=${TOKEN}\nBUGNET_PAYMENTS_TOKEN=${TOKEN}\n`,
            "BUGNET_PAYMENTS_TOKEN=short\n",
            `BUGNET_PAYMENTS_TOKEN=${TOKEN} # gateway\n`,
        ]) {
            const r = push(text);
            expect(r.code).not.toBe(0);
            expect(r.sent).toBeNull();
            expect(r.all).not.toContain(TOKEN);
            expect(r.all).not.toContain("madeupfeepayer");
        }
    });
});

describe("push-rpc-urls.sh", () => {
    function push(envText: string) {
        const bin = join(dir, "bin");
        const got = join(dir, "ssh-stdin");
        const args = join(dir, "ssh-args");
        spawnSync("mkdir", ["-p", bin]);
        writeFileSync(
            join(bin, "ssh"),
            `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${args}"\ncat > "${got}"\n`,
        );
        chmodSync(join(bin, "ssh"), 0o755);
        const local = join(dir, "local.env");
        writeFileSync(local, envText, { mode: 0o600 });
        const r = spawnSync("bash", [PUSH, "server.example"], {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                BUGNET_LOCAL_ENV: local,
            },
        });
        const sent = existsSync(got) ? readFileSync(got, "utf8") : null;
        const sshArgs = existsSync(args) ? readFileSync(args, "utf8").split("\n") : null;
        return { code: r.status, all: r.stdout + r.stderr, sent, sshArgs };
    }

    it("push-rpc-urls.sh sends only the list line", () => {
        const r = push(
            "BUGNET_FEE_PAYER_KEY=madeupfeepayer\nBUGNET_SOLANA_RPC_URLS=https://a.example/key1,https://b.example\nBUGNET_CLAIM_KEY=madeupclaim\n",
        );
        expect(r.code).toBe(0);
        expect(r.sent).toBe("BUGNET_SOLANA_RPC_URLS=https://a.example/key1,https://b.example\n");
        // No remote terminal, which would echo the line back
        expect(r.sshArgs?.slice(0, 2)).toEqual(["-T", "server.example"]);
        for (const secret of ["madeupfeepayer", "madeupclaim", "key1", "a.example"]) {
            expect(r.all).not.toContain(secret);
        }
    });

    it("push-rpc-urls.sh refuses two lines or a spaced one", () => {
        for (const text of [
            "BUGNET_SOLANA_RPC_URLS=https://a.example\nBUGNET_SOLANA_RPC_URLS=https://b.example\n",
            "BUGNET_SOLANA_RPC_URLS=https://a.example, https://b.example\n",
        ]) {
            const r = push(text);
            expect(r.code).not.toBe(0);
            expect(r.sent).toBeNull();
            expect(r.all).not.toContain("a.example");
        }
    });

    it("the deploy scripts parse", () => {
        for (const file of [SCRIPT, PUSH, RETIRE, PUSH_TOKEN, BACKUP]) {
            expect(spawnSync("bash", ["-n", file]).status).toBe(0);
        }
    });
});
