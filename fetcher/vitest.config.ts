import { defineConfig } from "vitest/config";

// Plain Node vitest, no Workers pool, no D1, no R2. The Worker's own
// `vitest.config.ts` at the repo root only globs `src/**/*.test.ts`, so this
// config and that one never pick up each other's tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
