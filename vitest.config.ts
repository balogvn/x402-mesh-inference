import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "**/types.ts"],
    },
  },
});
