import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Resolves a workspace package to its TypeScript source entry.
 *
 * @param name - Directory name under `packages/`.
 * @returns Absolute path to that package's `src/index.ts`.
 */
function sourceEntry(name: string): string {
  return fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
}

export default defineConfig({
  resolve: {
    /**
     * Point cross-package imports at TypeScript source rather than `dist/`.
     *
     * Each workspace package declares `exports` -> `./dist/index.js`, which does not exist
     * until `tsc -b` has run. Without these aliases `vitest run` on a clean checkout dies
     * with "Failed to resolve entry for package @x402-mesh/shared", so the test suite would
     * only pass when a build happened to have run first — exactly the state a fresh CI
     * checkout is not in.
     *
     * Aliasing to source also makes coverage honest: instrumentation is configured over
     * `packages/../src/**`, so a test executing `dist/` would report the source file as
     * uncovered even though it was exercised.
     */
    alias: {
      "@x402-mesh/shared": sourceEntry("shared"),
      "@x402-mesh/registry": sourceEntry("registry"),
      "@x402-mesh/gateway": sourceEntry("gateway"),
      "@x402-mesh/node-daemon": sourceEntry("node-daemon"),
    },
  },
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
