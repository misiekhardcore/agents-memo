import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
    },
    globals: true,
    include: ["extensions/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
