import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
    },
    globals: true,
    include: ["**/*.test.ts"], // Vitest unit tests; smoke tests use node scripts
    exclude: ["node_modules", "dist", ".forge"],
  },
});
