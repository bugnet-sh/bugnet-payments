import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const goBinary = process.env.GO_BIN ?? "go";
const vectorFile = resolve(import.meta.dirname, "../../test/go/ordertoken_vector_test.go");

export function goAvailable(): boolean {
    return spawnSync(goBinary, ["version"], { stdio: "ignore" }).status === 0;
}

// The overlay adds the vector test to the router's package without touching its working tree.
export function runGoVector(
    routerDir: string,
    token: string,
    pubkeyB64: string,
    expect: "ok" | "malformed",
    now?: Date,
): number {
    const dir = mkdtempSync(join(tmpdir(), "go-vector-"));
    try {
        const overlay = join(dir, "overlay.json");
        const target = join(resolve(routerDir), "internal/ordertoken/payments_vector_test.go");
        writeFileSync(overlay, JSON.stringify({ Replace: { [target]: vectorFile } }));
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            BUGNET_VECTOR_TOKEN: token,
            BUGNET_VECTOR_PUBKEY: pubkeyB64,
            BUGNET_VECTOR_EXPECT: expect,
        };
        if (now) env.BUGNET_VECTOR_NOW = now.toISOString();
        const res = spawnSync(
            goBinary,
            [
                "test",
                "-count=1",
                "-overlay",
                overlay,
                "-run",
                "TestPaymentsTokenVector",
                "./internal/ordertoken/",
            ],
            { cwd: routerDir, env, encoding: "utf8" },
        );
        return res.status ?? 1;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
