import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts", "test/**/*.test.ts"],
        exclude: ["test/live/**", "node_modules/**"],
        // Dropping a test database waits for a forced checkpoint, seconds long under parallel files,
        // and some tests create and drop their own database inside the test body
        testTimeout: 60_000,
        hookTimeout: 60_000,
    },
});
