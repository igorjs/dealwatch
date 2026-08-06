import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// `@cloudflare/vitest-pool-workers` 0.20.1 exposes its Workers runtime
// integration as a Vite plugin (`cloudflareTest`), not as a
// `defineWorkersConfig`/`defineWorkersProject` wrapper (those were removed).
// The plugin reads bindings straight from wrangler.jsonc.
//
// Test isolation note: this version removed the old `isolatedStorage`/
// `singleWorker` pool options entirely — storage isolation is now per test
// *file* by default (matching Vitest's own isolation model), with no config
// knob to make it per-test. So tests within one file share a D1 instance;
// each test must seed its own uniquely-keyed rows.
//
// `readD1Migrations` runs here in Node (config-build time, not inside the
// Workers runtime) to read `migrations/*.sql` off disk, then hands the
// parsed migrations to the Workers runtime as a test-only `TEST_MIGRATIONS`
// binding, since `node:path`/`node:fs` aren't available inside the pool's
// Workers-runtime test context where `applyD1Migrations` is actually called.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "migrations",
      );
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
});
