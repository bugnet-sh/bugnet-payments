import { spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../deploy/vps-install.sh");
const PUSH = join(import.meta.dirname, "../deploy/push-rpc-urls.sh");

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

    it("--start restarts a running unit so it loads a changed list", () => {
        const bin = join(dir, "bin");
        const etc = join(dir, "etc");
        const log = join(dir, "systemctl.log");
        mkdirSync(bin);
        mkdirSync(join(etc, "payments"), { recursive: true });
        for (const f of [
            "internal-ca.pem",
            "payments/x402-server.pem",
            "payments/x402-index.json",
        ]) {
            writeFileSync(join(etc, f), "");
        }
        writeFileSync(join(etc, "payments.toml"), "[solana]\n");
        writeFileSync(join(etc, "payments.release"), "v9\n");
        const names = [
            "BUGNET_PAYMENTS_TOKEN",
            "BUGNET_PAYMENTS_ROUTER_TOKEN",
            "BUGNET_ORDER_PRIVATE_KEY",
            "BUGNET_CLAIM_KEY",
            "BUGNET_FEE_PAYER_KEY",
            "BUGNET_REFUND_KEY",
            "BUGNET_ALLOWANCE_KEY",
            "BUGNET_X402_TLS_KEY",
        ];
        const file = envFile(
            `${names.map((n) => `${n}=x`).join("\n")}\nBUGNET_SOLANA_RPC_URLS=https://a.example\n`,
        );
        // systemctl records its arguments and says every unit is active; curl answers health
        writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash\necho "$*" >> "${log}"\n`);
        writeFileSync(join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
        writeFileSync(join(bin, "journalctl"), "#!/usr/bin/env bash\nexit 0\n");
        for (const tool of ["systemctl", "curl", "journalctl"]) chmodSync(join(bin, tool), 0o755);
        const r = spawnSync(
            "bash",
            [
                "-c",
                `. "${SCRIPT}"; ETC="$1"; TOML="$1/payments.toml"; RELEASE_FILE="$1/payments.release"; do_start`,
                "bash",
                etc,
            ],
            {
                encoding: "utf8",
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH ?? ""}`,
                    VPS_INSTALL_LIB: "1",
                    BUGNET_PAYMENTS_ENV: file,
                },
            },
        );
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        expect(readFileSync(log, "utf8")).toContain("restart bugnet-payments@v9\n");
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

describe("push-rpc-urls.sh", () => {
    function push(envText: string) {
        const bin = join(dir, "bin");
        const got = join(dir, "ssh-stdin");
        spawnSync("mkdir", ["-p", bin]);
        writeFileSync(join(bin, "ssh"), `#!/usr/bin/env bash\ncat > "${got}"\n`);
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
        return { code: r.status, all: r.stdout + r.stderr, sent };
    }

    it("push-rpc-urls.sh sends only the list line", () => {
        const r = push(
            "BUGNET_FEE_PAYER_KEY=madeupfeepayer\nBUGNET_SOLANA_RPC_URLS=https://a.example/key1,https://b.example\nBUGNET_CLAIM_KEY=madeupclaim\n",
        );
        expect(r.code).toBe(0);
        expect(r.sent).toBe("BUGNET_SOLANA_RPC_URLS=https://a.example/key1,https://b.example\n");
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

    it("both scripts parse", () => {
        for (const file of [SCRIPT, PUSH]) expect(spawnSync("bash", ["-n", file]).status).toBe(0);
    });
});
