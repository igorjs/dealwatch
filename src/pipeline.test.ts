import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type PipelineDeps, type SourceFetchers, runPipeline } from "./pipeline";
import { filterNew, getHealth, recordAttempt } from "./store";
import { readList } from "./listStore";
import { stableId } from "./core/id";
import type { BrowserSession, PageLike } from "./browser";
import type { Config, RawDeal, Watch } from "./types";

// `TEST_MIGRATIONS` is a test-only binding wired in vitest.config.ts, same
// pattern as store.test.ts.
const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };

/**
 * Storage (D1 + R2) is isolated per test *file*, not per test (see
 * vitest.config.ts). So every test in this file shares one D1 instance and
 * one R2 bucket; each test uses its own unique deal ids/urls and, where it
 * writes the shopping list, its own unique R2 key (via `listKey`) so tests
 * can't collide with each other.
 */
beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

const WATCHLIST: Watch[] = [
  { term: "olive oil", minDiscountPercent: 0, exclude: [] },
];

function config(overrides: Partial<Config> = {}): Config {
  return {
    watchlist: WATCHLIST,
    ntfy: { topicUrl: "https://ntfy.sh/dealwatch-test-topic" },
    stores: {
      aldi: { servicePoint: "G452", categoryKeys: ["cat-1"] },
      coles: { url: "https://www.coles.com.au/on-special?filter_Special=halfprice" },
      woolworths: { url: "https://www.woolworths.com.au/apis/ui/browse/category" },
    },
    ...overrides,
  };
}

/** A RawDeal fixture whose title matches the "olive oil" watch term above. */
function rawDeal(overrides: Partial<RawDeal> = {}): RawDeal {
  return {
    source: "aldi",
    title: "Extra Virgin Olive Oil 1L",
    url: `https://example.com/deal/${crypto.randomUUID()}`,
    store: "Aldi Example",
    department: null,
    priceCents: 500,
    wasPriceCents: 1000,
    discountPercent: 50,
    ...overrides,
  };
}

/** A no-op BrowserSession/PageLike: fetchers are swapped via `deps.fetchers`, so the real page API is never exercised. */
function fakeBrowser(): BrowserSession {
  const page: PageLike = {
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    evaluate: vi.fn().mockResolvedValue(undefined),
    waitForResponse: vi.fn().mockResolvedValue({
      url: () => "https://example.com",
      json: () => Promise.resolve({}),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** All three fetchers resolving empty, as a base to override per test. */
function fetchers(overrides: Partial<SourceFetchers> = {}): SourceFetchers {
  return {
    aldi: vi.fn().mockResolvedValue([]),
    woolworths: vi.fn().mockResolvedValue([]),
    coles: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** A push spy: records every (message, topicUrl) call; resolves by default. */
function pushSpy(impl?: (message: string, topicUrl: string) => Promise<void>) {
  return vi.fn(impl ?? (() => Promise.resolve()));
}

const NOW = new Date("2026-08-06T00:00:00Z");

function baseDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    now: NOW,
    config: config(),
    db: testEnv.DB,
    bucket: env.LIST,
    browser: fakeBrowser(),
    pushFn: pushSpy(),
    fetchers: fetchers(),
    ...overrides,
  };
}

describe("runPipeline", () => {
  it("excludes a non-matching deal, proven by identity of the surviving deal", async () => {
    // Arrange
    const matching = rawDeal({ title: "Extra Virgin Olive Oil 1L" });
    const nonMatching = rawDeal({ title: "Plain Bread Loaf" });
    const push = pushSpy();
    const deps = baseDeps({
      fetchers: fetchers({ aldi: vi.fn().mockResolvedValue([matching, nonMatching]) }),
      pushFn: push,
      listKey: `list-${crypto.randomUUID()}.json`,
    });
    const matchingId = stableId("aldi", matching.url);

    // Act
    const summary = await runPipeline(deps);

    // Assert
    expect(summary.matched).toBe(1);
    const grouped = await readList(env.LIST, deps.listKey);
    const allItems = Object.values(grouped).flat();
    expect(allItems.map((item) => item.id)).toEqual([matchingId]);
    expect(allItems[0]?.title).toBe("Extra Virgin Olive Oil 1L");
  });

  it("a rejecting source contributes zero deals, records a failed attempt, and doesn't block the other two", async () => {
    // Arrange
    const aldiDeal = rawDeal({ source: "aldi" });
    const woolworthsDeal = rawDeal({ source: "woolworths" });
    const push = pushSpy();
    const deps = baseDeps({
      fetchers: fetchers({
        aldi: vi.fn().mockResolvedValue([aldiDeal]),
        woolworths: vi.fn().mockResolvedValue([woolworthsDeal]),
        coles: vi.fn().mockRejectedValue(new Error("coles boom")),
      }),
      pushFn: push,
      listKey: `list-${crypto.randomUUID()}.json`,
    });

    // Act
    const summary = await runPipeline(deps);

    // Assert
    expect(summary.sourceFailures).toEqual(["coles"]);
    expect(summary.fetched).toBe(2);
    expect(summary.matched).toBe(2);
    const health = await getHealth(testEnv.DB);
    const colesHealth = health.find((entry) => entry.source === "coles");
    expect(colesHealth?.consecutiveFailures).toBeGreaterThanOrEqual(1);
  });

  it("skips recordSeen when the R2 write throws, but still pushes for the attempted matches, and resolves normally", async () => {
    // Arrange: pre-corrupt the object at this test's own unique key so
    // upsertList's readStore() throws CorruptListFileError.
    const listKey = `list-${crypto.randomUUID()}.json`;
    await env.LIST.put(listKey, "{ not valid json");
    const raw = rawDeal();
    const push = pushSpy();
    const deps = baseDeps({
      fetchers: fetchers({ aldi: vi.fn().mockResolvedValue([raw]) }),
      pushFn: push,
      listKey,
    });
    const dealId = stableId("aldi", raw.url);

    // Act
    const summary = await runPipeline(deps);

    // Assert: three-part — recordSeen skipped (deal still "new"), push still
    // fired, runPipeline resolved (didn't throw).
    expect(summary.matched).toBe(1);
    const stillNew = await filterNew(testEnv.DB, [
      {
        id: dealId,
        source: "aldi",
        store: "Aldi Example",
        title: "Extra Virgin Olive Oil 1L",
        url: raw.url,
        category: "other",
        priceCents: 500,
        wasPriceCents: 1000,
        discountPercent: 50,
        seenAt: NOW.toISOString(),
      },
    ]);
    expect(stillNew.map((d) => d.id)).toEqual([dealId]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toContain("1 new matching deal");
  });

  it("drops one malformed RawDeal (fails normalize) and still processes the rest of the batch", async () => {
    // Arrange
    const badRaw = rawDeal({ url: "not-a-valid-url", title: "Bad Olive Oil" });
    const goodRaw = rawDeal({ title: "Good Olive Oil" });
    const push = pushSpy();
    const deps = baseDeps({
      fetchers: fetchers({ aldi: vi.fn().mockResolvedValue([badRaw, goodRaw]) }),
      pushFn: push,
      listKey: `list-${crypto.randomUUID()}.json`,
    });
    const goodId = stableId("aldi", goodRaw.url);

    // Act
    const summary = await runPipeline(deps);

    // Assert
    expect(summary.matched).toBe(1);
    const grouped = await readList(env.LIST, deps.listKey);
    const allItems = Object.values(grouped).flat();
    expect(allItems.map((item) => item.id)).toEqual([goodId]);
  });

  it("triggers exactly one failure-alert push once a source's failures cross the threshold", async () => {
    // Arrange: seed source_health so woolworths is already at
    // consecutiveFailures = threshold - 1 (2), so one more failure crosses
    // the default threshold of 3.
    const failThreshold = 3;
    await recordAttempt(testEnv.DB, "woolworths", new Date("2020-01-01T00:00:00Z"), false);
    await recordAttempt(testEnv.DB, "woolworths", new Date("2020-01-01T01:00:00Z"), false);
    const push = pushSpy();
    const deps = baseDeps({
      fetchers: fetchers({ woolworths: vi.fn().mockRejectedValue(new Error("still down")) }),
      pushFn: push,
      failureThreshold: failThreshold,
      listKey: `list-${crypto.randomUUID()}.json`,
    });

    // Act
    await runPipeline(deps);

    // Assert: exactly one failure-alert push, v2-appropriate copy (no
    // mention of captures/re-capture doc).
    expect(push).toHaveBeenCalledTimes(1);
    const [message] = push.mock.calls[0] ?? [];
    expect(message).toContain("woolworths");
    expect(message).toContain("3 times in a row");
    expect(message).not.toContain("re-capture");
    expect(message).not.toContain("STORE-CAPTURE.md");
  });

  it("does not alert a source with fewer prior failures than the threshold", async () => {
    // Arrange: aldi has 0 prior failures; one failure this run reaches only 1, below default threshold 3.
    const push = pushSpy();
    const deps = baseDeps({
      fetchers: fetchers({ aldi: vi.fn().mockRejectedValue(new Error("transient")) }),
      pushFn: push,
      listKey: `list-${crypto.randomUUID()}.json`,
    });

    // Act
    await runPipeline(deps);

    // Assert
    expect(push).not.toHaveBeenCalled();
  });

  it("matches reach R2 and push exactly once each", async () => {
    // Arrange
    const raw = rawDeal();
    const push = pushSpy();
    const deps = baseDeps({
      fetchers: fetchers({ aldi: vi.fn().mockResolvedValue([raw]) }),
      pushFn: push,
      listKey: `list-${crypto.randomUUID()}.json`,
    });
    const dealId = stableId("aldi", raw.url);

    // Act
    await runPipeline(deps);

    // Assert
    expect(push).toHaveBeenCalledTimes(1);
    const grouped = await readList(env.LIST, deps.listKey);
    const allItems = Object.values(grouped).flat();
    expect(allItems.map((item) => item.id)).toEqual([dealId]);
  });

  it("a second run with the same fetched deal is a dedup no-op: no new push for already-seen deals", async () => {
    // Arrange: same raw deal fetched on both runs.
    const raw = rawDeal();
    const listKey = `list-${crypto.randomUUID()}.json`;
    const firstPush = pushSpy();
    const firstDeps = baseDeps({
      fetchers: fetchers({ aldi: vi.fn().mockResolvedValue([raw]) }),
      pushFn: firstPush,
      listKey,
    });

    // Act: first run alerts and records the deal as seen.
    const firstSummary = await runPipeline(firstDeps);
    expect(firstSummary.matched).toBe(1);
    expect(firstPush).toHaveBeenCalledTimes(1);

    // Second run, same deal: filterNew excludes it before match/save.
    const secondPush = pushSpy();
    const secondDeps = baseDeps({
      fetchers: fetchers({ aldi: vi.fn().mockResolvedValue([raw]) }),
      pushFn: secondPush,
      listKey,
    });
    const secondSummary = await runPipeline(secondDeps);

    // Assert: no new match, no new push.
    expect(secondSummary.matched).toBe(0);
    expect(secondPush).not.toHaveBeenCalled();
  });

  it("never throws when a source fetch rejects and the R2 write also fails in the same run", async () => {
    // Arrange: a maximally adverse run — one source fails, and the matched
    // deal from another source can't be saved to R2 either.
    const listKey = `list-${crypto.randomUUID()}.json`;
    await env.LIST.put(listKey, "{ not valid json");
    const raw = rawDeal();
    const deps = baseDeps({
      fetchers: fetchers({
        aldi: vi.fn().mockResolvedValue([raw]),
        coles: vi.fn().mockRejectedValue(new Error("coles down")),
      }),
      listKey,
    });

    // Act + Assert
    await expect(runPipeline(deps)).resolves.toBeDefined();
  });
});
