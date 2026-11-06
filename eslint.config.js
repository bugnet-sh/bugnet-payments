import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["**/node_modules/**", "dist/**", "src/gen/**", "vendor/**"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
        },
    },
    {
        files: ["src/**/*.ts"],
        ignores: ["**/*.test.ts", "src/testing/**"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        { group: ["**/testing/*"], message: "The test harness is for tests only." },
                    ],
                },
            ],
        },
    },
);
