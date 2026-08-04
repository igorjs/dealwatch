import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker scaffold", () => {
  it("boots the vitest-pool-workers harness with D1 and R2 bindings wired", () => {
    // Arrange: bindings come from wrangler.jsonc via the vitest-pool-workers
    // harness — nothing to set up. `cloudflare:workers` is the current (non-
    // deprecated) source for the injected test env; `cloudflare:test`'s `env`
    // export is deprecated in @cloudflare/vitest-pool-workers 0.20.1.

    // Act: read the injected test env directly.
    const { DB, LIST } = env;

    // Assert: both bindings resolved to real runtime objects, not just types.
    expect(DB).toBeDefined();
    expect(LIST).toBeDefined();
  });
});
