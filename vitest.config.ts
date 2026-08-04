import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// `@cloudflare/vitest-pool-workers` 0.20.1 exposes its Workers runtime
// integration as a Vite plugin (`cloudflareTest`), not as a
// `defineWorkersConfig`/`defineWorkersProject` wrapper (those were removed).
// The plugin reads bindings straight from wrangler.jsonc.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
