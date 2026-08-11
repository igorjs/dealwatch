import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ProcessDeps, processSourceResults } from "./pipeline";
import { filterNew, getHealth, recordAttempt } from "./store";
import { readList } from "./listStore";
import { stableId } from "./core/id";
import type { Config, RawDeal, Source, SourceResult, Watch } from "./types";

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

/** A fulfilled per-source result, the wire shape a validated `POST /ingest` body carries. */
function fulfilledResult(source: Source, deals: RawDeal[]): SourceResult {
  return { source, status: "fulfilled", deals };
}

/** A rejected per-source result, the wire shape a validated `POST /ingest` body carries. */
function rejectedResult(source: Source, reason: string): SourceResult {
  return { source, status: "rejected", reason };
}

/** A push spy: records every (message, topicUrl) call; resolves by default. */
function pushSpy(impl?: (message: string, topicUrl: string) => Promise<void>) {
  return vi.fn(impl ?? (() => Promise.resolve()));
}

const NOW = new Date("2026-08-06T00:00:00Z");

function baseDeps(overrides: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    now: NOW,
    config: config(),
    db: testEnv.DB,
    bucket: env.LIST,
    pushFn: pushSpy(),
    ...overrides,
  };
}

describe("processSourceResults", () => {
  it("delivers every fulfilled deal to both sinks and records health per source", async () => {
    // Arrange
    const listKey = `list-${crypto.randomUUID()}.json`;
    const aldiDeals = [
      rawDeal({ title: "Extra Virgin Olive Oil 1L" }),
      rawDeal({ title: "Light Olive Oil 500mL" }),
      rawDeal({ title: "Garlic Olive Oil 250mL" }),
    ];
    const push = pushSpy();
    const deps = baseDeps({ pushFn: push, listKey });
    const results: SourceResult[] = [
      fulfilledResult("aldi", aldiDeals),
      rejectedResult("coles", "socket hang up"),
    ];

    // Act
    const summary = await processSourceResults(deps, results);

    // Assert
    expect(summary.fetched).toBe(3);
    expect(summary.matched).toBe(3);
    expect(push).toHaveBeenCalledTimes(1);
    const grouped = await readList(env.LIST, listKey);
    expect(Object.values(grouped).flat()).toHaveLength(3);
    const health = await getHealth(testEnv.DB);
    expect(health.find((entry) => entry.source === "aldi")?.consecutiveFailures).toBe(0);
    expect(
      health.find((entry) => entry.source === "coles")?.consecutiveFailures,
    ).toBeGreaterThanOrEqual(1);
  });

  it("fires the threshold alert with the rejected result's reason, and never mentions Browser Rendering", async () => {
    // Arrange: seed woolworths at consecutiveFailures = threshold - 1 (2), so
    // this run's rejection crosses the threshold of 3.
    const failThreshold = 3;
    await recordAttempt(testEnv.DB, "woolworths", new Date("2020-01-01T00:00:00Z"), false);
    await recordAttempt(testEnv.DB, "woolworths", new Date("2020-01-01T01:00:00Z"), false);
    const push = pushSpy();
    const deps = baseDeps({
      pushFn: push,
      failureThreshold: failThreshold,
      listKey: `list-${crypto.randomUUID()}.json`,
    });
    const results: SourceResult[] = [
      rejectedResult("woolworths", "stealth plugin detected, page returned 403"),
    ];

    // Act
    await processSourceResults(deps, results);

    // Assert
    expect(push).toHaveBeenCalledTimes(1);
    const [message] = push.mock.calls[0] ?? [];
    expect(message).toContain("stealth plugin detected, page returned 403");
    expect(message).not.toContain("Browser Rendering");
  });

  it("resolves with an empty summary and never throws when every source rejects", async () => {
    // Arrange
    const push = pushSpy();
    const deps = baseDeps({ pushFn: push, listKey: `list-${crypto.randomUUID()}.json` });
    const results: SourceResult[] = [
      rejectedResult("aldi", "timeout"),
      rejectedResult("woolworths", "timeout"),
      rejectedResult("coles", "timeout"),
    ];

    // Act
    const summary = await processSourceResults(deps, results);

    // Assert: nothing fetched or matched, all three failures recorded, and
    // nothing written to the shopping list (so recordSeen never ran).
    expect(summary.fetched).toBe(0);
    expect(summary.matched).toBe(0);
    expect(summary.sourceFailures).toHaveLength(3);
    const grouped = await readList(env.LIST, deps.listKey);
    expect(grouped).toEqual({});
  });

  it("skips recordSeen when the R2 write rejects, so the matched deal is still eligible next run", async () => {
    // Arrange: pre-corrupt the object at this test's own unique key so
    // upsertList's readStore() throws CorruptListFileError.
    const listKey = `list-${crypto.randomUUID()}.json`;
    await env.LIST.put(listKey, "{ not valid json");
    const raw = rawDeal();
    const push = pushSpy();
    const deps = baseDeps({ pushFn: push, listKey });
    const dealId = stableId("aldi", raw.url);
    const results: SourceResult[] = [fulfilledResult("aldi", [raw])];

    // Act
    const summary = await processSourceResults(deps, results);

    // Assert
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
  });

  it("excludes a non-matching deal, proven by identity of the surviving deal", async () => {
    // Arrange
    const matching = rawDeal({ title: "Extra Virgin Olive Oil 1L" });
    const nonMatching = rawDeal({ title: "Plain Bread Loaf" });
    const push = pushSpy();
    const listKey = `list-${crypto.randomUUID()}.json`;
    const deps = baseDeps({ pushFn: push, listKey });
    const results: SourceResult[] = [fulfilledResult("aldi", [matching, nonMatching])];
    const matchingId = stableId("aldi", matching.url);

    // Act
    const summary = await processSourceResults(deps, results);

    // Assert
    expect(summary.matched).toBe(1);
    const grouped = await readList(env.LIST, listKey);
    const allItems = Object.values(grouped).flat();
    expect(allItems.map((item) => item.id)).toEqual([matchingId]);
    expect(allItems[0]?.title).toBe("Extra Virgin Olive Oil 1L");
  });

  it("a rejecting source contributes zero deals, records a failed attempt, and doesn't block the other two", async () => {
    // Arrange
    const aldiDeal = rawDeal({ source: "aldi" });
    const woolworthsDeal = rawDeal({ source: "woolworths" });
    const push = pushSpy();
    const deps = baseDeps({ pushFn: push, listKey: `list-${crypto.randomUUID()}.json` });
    const results: SourceResult[] = [
      fulfilledResult("aldi", [aldiDeal]),
      fulfilledResult("woolworths", [woolworthsDeal]),
      rejectedResult("coles", "coles boom"),
    ];

    // Act
    const summary = await processSourceResults(deps, results);

    // Assert
    expect(summary.sourceFailures).toEqual(["coles"]);
    expect(summary.fetched).toBe(2);
    expect(summary.matched).toBe(2);
    const health = await getHealth(testEnv.DB);
    const colesHealth = health.find((entry) => entry.source === "coles");
    expect(colesHealth?.consecutiveFailures).toBeGreaterThanOrEqual(1);
  });

  it("skips recordSeen when the R2 write throws, but still pushes for the attempted match", async () => {
    // Arrange: pre-corrupt the object at this test's own unique key so
    // upsertList's readStore() throws CorruptListFileError.
    const listKey = `list-${crypto.randomUUID()}.json`;
    await env.LIST.put(listKey, "{ not valid json");
    const raw = rawDeal();
    const push = pushSpy();
    const deps = baseDeps({ pushFn: push, listKey });
    const dealId = stableId("aldi", raw.url);
    const results: SourceResult[] = [fulfilledResult("aldi", [raw])];

    // Act
    const summary = await processSourceResults(deps, results);

    // Assert: three-part, recordSeen skipped (deal still "new"), push still
    // fired, processSourceResults resolved (didn't throw).
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
    const listKey = `list-${crypto.randomUUID()}.json`;
    const deps = baseDeps({ pushFn: push, listKey });
    const results: SourceResult[] = [fulfilledResult("aldi", [badRaw, goodRaw])];
    const goodId = stableId("aldi", goodRaw.url);

    // Act
    const summary = await processSourceResults(deps, results);

    // Assert
    expect(summary.matched).toBe(1);
    const grouped = await readList(env.LIST, listKey);
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
      pushFn: push,
      failureThreshold: failThreshold,
      listKey: `list-${crypto.randomUUID()}.json`,
    });
    const results: SourceResult[] = [rejectedResult("woolworths", "still down")];

    // Act
    await processSourceResults(deps, results);

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
    const deps = baseDeps({ pushFn: push, listKey: `list-${crypto.randomUUID()}.json` });
    const results: SourceResult[] = [rejectedResult("aldi", "transient")];

    // Act
    await processSourceResults(deps, results);

    // Assert
    expect(push).not.toHaveBeenCalled();
  });

  it("matches reach R2 and push exactly once each", async () => {
    // Arrange
    const raw = rawDeal();
    const push = pushSpy();
    const listKey = `list-${crypto.randomUUID()}.json`;
    const deps = baseDeps({ pushFn: push, listKey });
    const results: SourceResult[] = [fulfilledResult("aldi", [raw])];
    const dealId = stableId("aldi", raw.url);

    // Act
    await processSourceResults(deps, results);

    // Assert
    expect(push).toHaveBeenCalledTimes(1);
    const grouped = await readList(env.LIST, listKey);
    const allItems = Object.values(grouped).flat();
    expect(allItems.map((item) => item.id)).toEqual([dealId]);
  });

  it("a second run with the same fetched deal is a dedup no-op: no new push for already-seen deals", async () => {
    // Arrange: same raw deal fetched on both runs.
    const raw = rawDeal();
    const listKey = `list-${crypto.randomUUID()}.json`;
    const firstPush = pushSpy();
    const firstDeps = baseDeps({ pushFn: firstPush, listKey });
    const results: SourceResult[] = [fulfilledResult("aldi", [raw])];

    // Act: first run alerts and records the deal as seen.
    const firstSummary = await processSourceResults(firstDeps, results);
    expect(firstSummary.matched).toBe(1);
    expect(firstPush).toHaveBeenCalledTimes(1);

    // Second run, same deal: filterNew excludes it before match/save.
    const secondPush = pushSpy();
    const secondDeps = baseDeps({ pushFn: secondPush, listKey });
    const secondSummary = await processSourceResults(secondDeps, results);

    // Assert: no new match, no new push.
    expect(secondSummary.matched).toBe(0);
    expect(secondPush).not.toHaveBeenCalled();
  });

  it("never throws when a source fetch rejects and the R2 write also fails in the same run", async () => {
    // Arrange: a maximally adverse run, one source fails, and the matched
    // deal from another source can't be saved to R2 either.
    const listKey = `list-${crypto.randomUUID()}.json`;
    await env.LIST.put(listKey, "{ not valid json");
    const raw = rawDeal();
    const deps = baseDeps({ listKey });
    const results: SourceResult[] = [
      fulfilledResult("aldi", [raw]),
      rejectedResult("coles", "coles down"),
    ];

    // Act + Assert
    await expect(processSourceResults(deps, results)).resolves.toBeDefined();
  });
});
