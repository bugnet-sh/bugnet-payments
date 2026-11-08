import { existsSync } from "node:fs";
import { missingLiveEnv } from "../../src/testing/live-env.ts";

// A missing secret fails the run before any test, instead of passing with 0 tests
export default function requireLiveEnv(): void {
    const missing = missingLiveEnv(process.env, existsSync);
    if (missing.length > 0) {
        throw new Error(
            `live test needs ${missing.join(", ")} in bugnet-payments/.env (Task 25 Step 2 and Task 36 Step 2)`,
        );
    }
}
