import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it } from "vitest";
import { filterNew, getHealth, recordAttempt, recordSeen } from "./store";
import type { Deal, Source } from "./types";

// `TEST_MIGRATIONS` is a test-only binding wired in vitest.config.ts (via
// `readD1Migrations` at config-build time, since `node:fs` isn't available
// inside the Workers-runtime test context). It isn't part of the real `Env`
// declared in wrangler.jsonc/worker-configuration.d.ts.
const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };

/** A minimal, valid Deal to mutate per test via overrides. */
function deal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: `deal-${crypto.randomUUID()}`,
    source: "coles",
    store: "Coles Test Store",
    title: "Test product",
    url: "https://coles.com.au/product/1",
    category: "other",
    priceCents: 500,
    wasPriceCents: 1000,
    discountPercent: 50,
    seenAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Storage is isolated per test *file*, not per test (the old
 * `isolatedStorage` pool option was removed upstream — see
 * vitest.config.ts). So every test in this file shares one D1 instance;
 * migrations only need applying once, and every test must use unique
 * ids/sources so `INSERT OR IGNORE` can never mask a cross-test collision.
 */
beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("filterNew", () => {
  it("drops an id already recorded via recordSeen and keeps a fresh one", async () => {
    // Arrange
    const seen = deal();
    const fresh = deal();
    await recordSeen(testEnv.DB, [seen]);

    // Act
    const result = await filterNew(testEnv.DB, [seen, fresh]);

    // Assert: only the never-seen id survives.
    expect(result.map((d) => d.id)).toEqual([fresh.id]);
  });

  it("keeps every id when none have been recorded yet", async () => {
    // Arrange
    const a = deal();
    const b = deal();

    // Act
    const result = await filterNew(testEnv.DB, [a, b]);

    // Assert
    expect(result.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("recordSeen", () => {
  it("is idempotent: recording the same deal twice does not error", async () => {
    // Arrange
    const d = deal();

    // Act
    await recordSeen(testEnv.DB, [d]);
    await expect(recordSeen(testEnv.DB, [d])).resolves.not.toThrow();

    // Assert: still only filtered out once (row wasn't duplicated/corrupted).
    const result = await filterNew(testEnv.DB, [d]);
    expect(result).toEqual([]);
  });

  it("persists overlapping deals across two calls without erroring", async () => {
    // Arrange
    const first = deal();
    const second = deal();

    // Act
    await recordSeen(testEnv.DB, [first]);
    await recordSeen(testEnv.DB, [first, second]);

    // Assert: both ids are now known.
    const result = await filterNew(testEnv.DB, [first, second]);
    expect(result).toEqual([]);
  });
});

describe("recordAttempt", () => {
  it("resets consecutive_failures to 0 and sets both timestamps after N failures then a success", async () => {
    // Arrange: a per-test-unique source label isn't possible (Source is a
    // fixed enum), so use distinct `now` timestamps to keep assertions
    // unambiguous even though `source` itself is shared across tests in
    // this file.
    const source: Source = "coles";

    // Act
    await recordAttempt(
      testEnv.DB,
      source,
      new Date("2020-01-01T00:00:00.000Z"),
      false,
    );
    await recordAttempt(
      testEnv.DB,
      source,
      new Date("2020-01-01T01:00:00.000Z"),
      false,
    );
    await recordAttempt(
      testEnv.DB,
      source,
      new Date("2020-01-01T02:00:00.000Z"),
      true,
    );
    const health = await getHealth(testEnv.DB);
    const colesHealth = health.find((entry) => entry.source === "coles");

    // Assert
    expect(colesHealth?.consecutiveFailures).toBe(0);
    expect(colesHealth?.lastSuccessAt).toEqual(
      new Date("2020-01-01T02:00:00.000Z"),
    );
    expect(colesHealth?.lastAttemptAt).toEqual(
      new Date("2020-01-01T02:00:00.000Z"),
    );
  });

  it("sets consecutive_failures to 1 and leaves last_success_at null on a single failure from a clean state", async () => {
    // Arrange
    const source: Source = "woolworths";

    // Act
    await recordAttempt(
      testEnv.DB,
      source,
      new Date("2020-02-02T00:00:00.000Z"),
      false,
    );
    const health = await getHealth(testEnv.DB);
    const woolworthsHealth = health.find((entry) =>
      entry.source === "woolworths"
    );

    // Assert
    expect(woolworthsHealth?.consecutiveFailures).toBe(1);
    expect(woolworthsHealth?.lastAttemptAt).toEqual(
      new Date("2020-02-02T00:00:00.000Z"),
    );
    expect(woolworthsHealth?.lastSuccessAt).toBeNull();
  });
});

describe("getHealth", () => {
  it("round-trips a Date written via recordAttempt as an equivalent Date, not a string", async () => {
    // Arrange
    const source: Source = "aldi";
    const now = new Date("2020-03-03T03:03:03.000Z");

    // Act
    await recordAttempt(testEnv.DB, source, now, true);
    const health = await getHealth(testEnv.DB);
    const aldiHealth = health.find((entry) => entry.source === "aldi");

    // Assert
    expect(aldiHealth?.lastSuccessAt).toBeInstanceOf(Date);
    expect(aldiHealth?.lastSuccessAt?.getTime()).toBe(now.getTime());
    expect(aldiHealth?.lastAttemptAt).toBeInstanceOf(Date);
    expect(aldiHealth?.lastAttemptAt?.getTime()).toBe(now.getTime());
  });
});

describe("migrations", () => {
  it("applying the same migrations twice does not error", async () => {
    // Act + Assert: applyD1Migrations only re-applies un-applied
    // migrations (tracked in its own bookkeeping table), and the SQL itself
    // uses CREATE TABLE IF NOT EXISTS, so re-applying must be a no-op, not
    // an error.
    await expect(
      applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS),
    ).resolves.not.toThrow();

    // The db is still usable afterwards.
    const health = await getHealth(testEnv.DB);
    expect(Array.isArray(health)).toBe(true);
  });
});
