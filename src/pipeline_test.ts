import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PipelineDeps,
  type PipelineSinks,
  type PipelineSource,
  type PipelineStore,
  run,
} from "./pipeline.ts";
import type { Deal, RawDeal, Source, Watch } from "./types.ts";
import type { SourceHealth } from "./core/schedule.ts";
import { stableId } from "./core/id.ts";

// Reference instants reused from core/schedule_test.ts (no DST in effect,
// Sydney is AEST, UTC+10 throughout): Wed 2026-08-05, Thu 2026-08-06.
/** Sydney 2026-08-06 10:00 (Thursday). */
const NOW = new Date("2026-08-06T00:00:00Z");
/** Sydney 2026-08-05 10:00 (Wednesday), after this week's refresh boundary. */
const FRESH_SUCCESS_AT = new Date("2026-08-05T00:00:00Z");

const WATCHLIST: Watch[] = [
  { term: "olive oil", minDiscountPercent: 0, exclude: [] },
];

/** A generic call-recording spy: `calls` holds every invocation's argument tuple. */
function spy<Args extends unknown[], R>(
  impl: (...args: Args) => R,
): { fn: (...args: Args) => R; calls: Args[] } {
  const calls: Args[] = [];
  const fn = (...args: Args): R => {
    calls.push(args);
    return impl(...args);
  };
  return { fn, calls };
}

/** A RawDeal fixture whose title matches the "olive oil" watch term above. */
function rawDeal(overrides: Partial<RawDeal> = {}): RawDeal {
  return {
    source: "aldi",
    title: "Extra Virgin Olive Oil 1L",
    url: "https://example.com/deal/1",
    store: "Aldi Example",
    department: null,
    priceCents: 500,
    wasPriceCents: 1000,
    discountPercent: 50,
    ...overrides,
  };
}

/** A `sort()`-friendly array-of-strings comparator for asserting id sets ignoring order. */
function sortedIds(deals: { id: string }[]): string[] {
  return deals.map((deal) => deal.id).sort();
}

/** A PipelineSource whose `fetch` is a spy delegating to `impl`. */
function makeSource(source: Source, impl: () => Promise<RawDeal[]>) {
  const fetchSpy = spy(impl);
  const pipelineSource: PipelineSource = { source, fetch: fetchSpy.fn };
  return { pipelineSource, fetchSpy };
}

/** A PipelineStore double: `getHealth` returns `health` as-is; every method is a spy. */
function makeStore(
  options: {
    health?: SourceHealth[];
    filterNew?: (deals: Deal[]) => Deal[];
  } = {},
) {
  const getHealthSpy = spy(() => options.health ?? []);
  const filterNewSpy = spy((deals: Deal[]) =>
    options.filterNew ? options.filterNew(deals) : deals
  );
  const recordSeenSpy = spy((_deals: Deal[]) => {});
  const recordAttemptSpy = spy(
    (_source: Source, _now: Date, _ok: boolean) => {},
  );
  const store: PipelineStore = {
    getHealth: getHealthSpy.fn,
    filterNew: filterNewSpy.fn,
    recordSeen: recordSeenSpy.fn,
    recordAttempt: recordAttemptSpy.fn,
  };
  return { store, getHealthSpy, filterNewSpy, recordSeenSpy, recordAttemptSpy };
}

/** A PipelineSinks double: both methods are spies; each can be given a custom (possibly throwing) impl. */
function makeSinks(
  options: {
    saveListImpl?: (deals: Deal[]) => void | Promise<void>;
    pushImpl?: (message: string) => Promise<void>;
  } = {},
) {
  const saveListSpy = spy((deals: Deal[]) =>
    options.saveListImpl ? options.saveListImpl(deals) : undefined
  );
  const pushSpy = spy((message: string) =>
    options.pushImpl ? options.pushImpl(message) : Promise.resolve()
  );
  const sinks: PipelineSinks = { saveList: saveListSpy.fn, push: pushSpy.fn };
  return { sinks, saveListSpy, pushSpy };
}

/** An empty-health store option: every configured source has never run, so all are due. */
const NO_HEALTH: SourceHealth[] = [];

Deno.test("run: a failing source is isolated; the other's matches reach both sinks once", async () => {
  // Arrange
  const goodDeals = [
    rawDeal({ url: "https://example.com/deal/1" }),
    rawDeal({ url: "https://example.com/deal/2" }),
    rawDeal({ url: "https://example.com/deal/3" }),
  ];
  const { pipelineSource: goodSource, fetchSpy: goodFetchSpy } = makeSource(
    "aldi",
    () => Promise.resolve(goodDeals),
  );
  const { pipelineSource: badSource, fetchSpy: badFetchSpy } = makeSource(
    "coles",
    () => Promise.reject(new Error("boom")),
  );
  const { store, recordAttemptSpy } = makeStore({ health: NO_HEALTH });
  const { sinks, saveListSpy, pushSpy } = makeSinks();
  const deps: PipelineDeps = {
    now: NOW,
    watchlist: WATCHLIST,
    sources: [goodSource, badSource],
    store,
    sinks,
  };

  // Act
  const summary = await run(deps);

  // Assert
  assertEquals(goodFetchSpy.calls.length, 1);
  assertEquals(badFetchSpy.calls.length, 1);
  assertEquals(saveListSpy.calls.length, 1);
  assertEquals(
    sortedIds(saveListSpy.calls[0][0]),
    sortedIds(goodDeals.map((raw) => ({ id: stableId("aldi", raw.url) }))),
  );
  assertEquals(pushSpy.calls.length, 1);
  assertEquals(
    recordAttemptSpy.calls.map(([source, , ok]) => [source, ok]),
    [["aldi", true], ["coles", false]],
  );
  assertEquals(summary.sourceFailures, ["coles"]);
  assertEquals(summary.matched, 3);
});

Deno.test("run: a non-matching deal is excluded from the sinks and recordSeen", async () => {
  // Arrange
  const matchingDeal = rawDeal({ url: "https://example.com/deal/matching" });
  const nonMatchingDeal = rawDeal({
    title: "Plain Bread",
    url: "https://example.com/deal/non-matching",
  });
  const { pipelineSource } = makeSource(
    "aldi",
    () => Promise.resolve([matchingDeal, nonMatchingDeal]),
  );
  const { store, recordSeenSpy } = makeStore({ health: NO_HEALTH });
  const { sinks, saveListSpy, pushSpy } = makeSinks();
  const matchingId = stableId("aldi", matchingDeal.url);

  // Act
  const summary = await run({
    now: NOW,
    watchlist: WATCHLIST,
    sources: [pipelineSource],
    store,
    sinks,
  });

  // Assert
  assertEquals(saveListSpy.calls.length, 1);
  assertEquals(saveListSpy.calls[0][0].map((deal) => deal.id), [matchingId]);
  assertEquals(pushSpy.calls.length, 1);
  assertEquals(recordSeenSpy.calls.length, 1);
  assertEquals(recordSeenSpy.calls[0][0].map((deal) => deal.id), [
    matchingId,
  ]);
  assertEquals(summary.matched, 1);
});

Deno.test("run: a matching new deal is recorded as seen exactly once", async () => {
  // Arrange
  const raw = rawDeal({ url: "https://example.com/deal/only" });
  const { pipelineSource } = makeSource("aldi", () => Promise.resolve([raw]));
  const { store, recordSeenSpy } = makeStore({ health: NO_HEALTH });
  const { sinks } = makeSinks();

  // Act
  await run({
    now: NOW,
    watchlist: WATCHLIST,
    sources: [pipelineSource],
    store,
    sinks,
  });

  // Assert
  assertEquals(recordSeenSpy.calls.length, 1);
  const [seenDeals] = recordSeenSpy.calls[0];
  assertEquals(seenDeals.map((deal) => deal.id), [stableId("aldi", raw.url)]);
});

Deno.test("run: filterNew drops an already-seen deal before it reaches the sinks", async () => {
  // Arrange
  const raw = rawDeal({ url: "https://example.com/deal/seen" });
  const { pipelineSource } = makeSource("aldi", () => Promise.resolve([raw]));
  const { store } = makeStore({ health: NO_HEALTH, filterNew: () => [] });
  const { sinks, saveListSpy, pushSpy } = makeSinks();

  // Act
  const summary = await run({
    now: NOW,
    watchlist: WATCHLIST,
    sources: [pipelineSource],
    store,
    sinks,
  });

  // Assert
  assertEquals(saveListSpy.calls.length, 0);
  assertEquals(pushSpy.calls.length, 0);
  assertEquals(summary.matched, 0);
});

Deno.test("run: a saveList failure does not block push and run does not rethrow", async () => {
  // Arrange
  const raw = rawDeal({ url: "https://example.com/deal/sink-fail" });
  const { pipelineSource } = makeSource("aldi", () => Promise.resolve([raw]));
  const { store, recordSeenSpy } = makeStore({ health: NO_HEALTH });
  const { sinks, saveListSpy, pushSpy } = makeSinks({
    saveListImpl: () => {
      throw new Error("disk full");
    },
  });

  // Act
  const summary = await run({
    now: NOW,
    watchlist: WATCHLIST,
    sources: [pipelineSource],
    store,
    sinks,
  });

  // Assert
  assertEquals(saveListSpy.calls.length, 1);
  assertEquals(pushSpy.calls.length, 1);
  assertEquals(summary.matched, 1);
  // A saveList failure means the deal never durably landed in the shopping
  // list, so it must not be marked seen — otherwise it's dropped forever.
  assertEquals(recordSeenSpy.calls.length, 0);
});

Deno.test("run: a deal that fails to normalize is dropped, not the whole run", async () => {
  // Arrange
  const badRaw = rawDeal({
    url: "not-a-valid-url",
    title: "Bad Extra Virgin Olive Oil",
  });
  const goodRaw = rawDeal({ url: "https://example.com/deal/normalize-ok" });
  const { pipelineSource } = makeSource(
    "aldi",
    () => Promise.resolve([badRaw, goodRaw]),
  );
  const { store } = makeStore({ health: NO_HEALTH });
  const { sinks, saveListSpy } = makeSinks();

  // Act
  const summary = await run({
    now: NOW,
    watchlist: WATCHLIST,
    sources: [pipelineSource],
    store,
    sinks,
  });

  // Assert
  assertEquals(saveListSpy.calls.length, 1);
  assertEquals(saveListSpy.calls[0][0].map((deal) => deal.id), [
    stableId("aldi", goodRaw.url),
  ]);
  assertEquals(summary.matched, 1);
});

Deno.test("run: a source reaching the failure threshold triggers a failure-alert push that names a re-capture", async () => {
  // Arrange
  const failingHealth: SourceHealth = {
    source: "woolworths",
    lastSuccessAt: null,
    // 2h ago: consecutiveFailures > 0, so backoff only clears past 1h.
    lastAttemptAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    consecutiveFailures: 2, // one more failure reaches the default threshold of 3
  };
  const { pipelineSource } = makeSource(
    "woolworths",
    () => Promise.reject(new Error("still down")),
  );
  const { store } = makeStore({ health: [failingHealth] });
  const { sinks, pushSpy } = makeSinks();

  // Act
  await run({
    now: NOW,
    watchlist: WATCHLIST,
    sources: [pipelineSource],
    store,
    sinks,
  });

  // Assert
  assertEquals(pushSpy.calls.length, 1);
  assertStringIncludes(pushSpy.calls[0][0], "woolworths");
  // Session-based sources (coles/woolworths) point at the re-capture doc,
  // since an expired captured session is the likely cause.
  assertStringIncludes(pushSpy.calls[0][0], "re-capture");
  assertStringIncludes(pushSpy.calls[0][0], "STORE-CAPTURE.md");
});

Deno.test("run: a public-API source's failure alert stays plain (no re-capture wording)", async () => {
  // Arrange
  const failingHealth: SourceHealth = {
    source: "aldi",
    lastSuccessAt: null,
    lastAttemptAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    consecutiveFailures: 2, // one more failure reaches the default threshold of 3
  };
  const { pipelineSource } = makeSource(
    "aldi",
    () => Promise.reject(new Error("still down")),
  );
  const { store } = makeStore({ health: [failingHealth] });
  const { sinks, pushSpy } = makeSinks();

  // Act
  await run({
    now: NOW,
    watchlist: WATCHLIST,
    sources: [pipelineSource],
    store,
    sinks,
  });

  // Assert
  assertEquals(pushSpy.calls.length, 1);
  assertEquals(
    pushSpy.calls[0][0],
    'dealwatch: source "aldi" failed 3 times in a row',
  );
});

Deno.test("run: a source outside the due set is never fetched", async () => {
  // Arrange
  const freshHealth: SourceHealth = {
    source: "coles",
    lastSuccessAt: FRESH_SUCCESS_AT, // succeeded this week: not due yet
    lastAttemptAt: FRESH_SUCCESS_AT,
    consecutiveFailures: 0,
  };
  const { pipelineSource: freshSource, fetchSpy: freshFetchSpy } = makeSource(
    "coles",
    () => Promise.resolve([]),
  );
  const { pipelineSource: staleSource } = makeSource(
    "aldi",
    () => Promise.resolve([]),
  );
  const { store } = makeStore({ health: [freshHealth] });
  const { sinks } = makeSinks();

  // Act
  const summary = await run({
    now: NOW,
    watchlist: WATCHLIST,
    sources: [freshSource, staleSource],
    store,
    sinks,
  });

  // Assert
  assertEquals(freshFetchSpy.calls.length, 0);
  assertEquals(summary.due, ["aldi"]);
});
