import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts", "test/**/*.test.ts"],
        exclude: ["test/live/**", "node_modules/**"],
        testTimeout: 20_000,
        // Dropping a test database waits for a forced checkpoint, seconds long under parallel files
        hookTimeout: 60_000,
    },
});
