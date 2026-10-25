import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "adapters/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 15000,
  },
});
