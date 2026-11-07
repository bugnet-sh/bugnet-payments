import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/live/**/*.test.ts"],
        globalSetup: ["test/live/require-env.ts"],
        testTimeout: 300_000,
        fileParallelism: false,
    },
});
