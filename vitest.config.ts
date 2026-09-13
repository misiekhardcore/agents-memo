import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
    },
    globals: true,
    include: [], // No vitest unit tests; all smoke/regression tests are node scripts (extension-smoke.mjs + *.sh)
  },
});
