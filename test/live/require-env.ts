import { missingLiveEnv } from "../../src/testing/live-env.ts";

// A missing secret fails the run before any test, instead of passing with 0 tests
export default function requireLiveEnv(): void {
    const missing = missingLiveEnv(process.env);
    if (missing.length > 0) {
        throw new Error(
            `live test needs ${missing.join(", ")} in bugnet-payments/.env (Task 25 Step 2)`,
        );
    }
}
