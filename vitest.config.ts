import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
    },
    globals: false,
    include: ["tests/**/*.test.ts"],
    // Shell regression suites (tests/regression/*.sh, tests/cli-smoke.sh) are
    // driven from npm scripts; vitest covers the TS extension in-process.
    exclude: ["node_modules", "dist", ".forge"],
  },
});
