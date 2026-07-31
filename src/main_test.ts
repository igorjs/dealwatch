import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDeps,
  EXIT_CONFIG_ERROR,
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  main,
} from "./main.ts";
import type { Db } from "./store/db.ts";
import type { PipelineDeps, PipelineSummary } from "./pipeline.ts";
import type { Config } from "./types.ts";

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

/** A minimal valid Config, cheap to build without touching real files. */
function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    watchlist: [{ term: "olive oil", minDiscountPercent: 0, exclude: [] }],
    sinks: {
      shoppingListPath: "./shopping-list.json",
      ntfy: { topicUrl: "https://ntfy.sh/test-topic" },
    },
    stores: {
      aldi: { servicePoint: "G452", categoryKeys: ["123"] },
      coles: { url: "https://coles.example/api", headers: {} },
      woolworths: { url: "https://woolworths.example/api", headers: {} },
    },
    ...overrides,
  };
}

const NOW = new Date("2026-08-06T00:00:00Z");

const SUMMARY: PipelineSummary = {
  due: ["aldi"],
  fetched: 1,
  matched: 1,
  sourceFailures: [],
};

Deno.test("buildDeps: wires the three sources, store, and sinks from config", () => {
  // Arrange
  const config = fakeConfig();
  const db = {} as Db;

  // Act
  const deps: PipelineDeps = buildDeps(config, db, NOW);

  // Assert
  assertEquals(deps.now, NOW);
  assertEquals(deps.watchlist, config.watchlist);
  assertEquals(deps.sources.map((s) => s.source), [
    "aldi",
    "woolworths",
    "coles",
  ]);
  assertEquals(typeof deps.store.getHealth, "function");
  assertEquals(typeof deps.store.filterNew, "function");
  assertEquals(typeof deps.store.recordSeen, "function");
  assertEquals(typeof deps.store.recordAttempt, "function");
  assertEquals(typeof deps.sinks.saveList, "function");
  assertEquals(typeof deps.sinks.push, "function");
});

Deno.test("main: valid config and a resolving pipeline run exits 0 and calls runFn once", async () => {
  // Arrange
  const loadConfigSpy = spy((_path: string) => fakeConfig());
  const openDbSpy = spy((_path: string) => ({} as Db));
  const runSpy = spy((_deps: PipelineDeps) => Promise.resolve(SUMMARY));
  const notifyCrashSpy = spy((_message: string) => Promise.resolve());

  // Act
  const code = await main({
    configPath: "config.local.json",
    dbPath: "dealwatch.db",
    now: NOW,
    loadConfigFn: loadConfigSpy.fn,
    openDbFn: openDbSpy.fn,
    runFn: runSpy.fn,
    notifyCrash: notifyCrashSpy.fn,
  });

  // Assert
  assertEquals(code, EXIT_SUCCESS);
  assertEquals(runSpy.calls.length, 1);
  assertEquals(notifyCrashSpy.calls.length, 0);
});

Deno.test("main: a throwing config loader exits 1 and never attempts a crash push", async () => {
  // Arrange
  const loadConfigSpy = spy((_path: string) => {
    throw new Error("config file missing");
  });
  const runSpy = spy((_deps: PipelineDeps) => Promise.resolve(SUMMARY));
  const notifyCrashSpy = spy((_message: string) => Promise.resolve());

  // Act
  const code = await main({
    configPath: "does-not-exist.json",
    loadConfigFn: loadConfigSpy.fn,
    runFn: runSpy.fn,
    notifyCrash: notifyCrashSpy.fn,
  });

  // Assert
  assertEquals(code, EXIT_CONFIG_ERROR);
  assertEquals(runSpy.calls.length, 0);
  assertEquals(notifyCrashSpy.calls.length, 0);
});

Deno.test("main: a throwing pipeline run exits 2 and best-effort pushes a crash alert", async () => {
  // Arrange
  const loadConfigSpy = spy((_path: string) => fakeConfig());
  const openDbSpy = spy((_path: string) => ({} as Db));
  const runSpy = spy((_deps: PipelineDeps) => {
    throw new Error("db exploded");
  });
  const notifyCrashSpy = spy((_message: string) => Promise.resolve());

  // Act
  const code = await main({
    now: NOW,
    loadConfigFn: loadConfigSpy.fn,
    openDbFn: openDbSpy.fn,
    runFn: runSpy.fn,
    notifyCrash: notifyCrashSpy.fn,
  });

  // Assert
  assertEquals(code, EXIT_RUNTIME_ERROR);
  assertEquals(notifyCrashSpy.calls.length, 1);
  assertStringIncludes(notifyCrashSpy.calls[0][0], "crashed");
});

Deno.test("main: exits 2 even when the crash-notify push itself throws (swallowed)", async () => {
  // Arrange
  const loadConfigSpy = spy((_path: string) => fakeConfig());
  const openDbSpy = spy((_path: string) => ({} as Db));
  const runSpy = spy((_deps: PipelineDeps) =>
    Promise.reject(new Error("boom"))
  );
  const notifyCrashSpy = spy((_message: string) => {
    throw new Error("ntfy is also down");
  });

  // Act
  const code = await main({
    now: NOW,
    loadConfigFn: loadConfigSpy.fn,
    openDbFn: openDbSpy.fn,
    runFn: runSpy.fn,
    notifyCrash: notifyCrashSpy.fn,
  });

  // Assert
  assertEquals(code, EXIT_RUNTIME_ERROR);
  assertEquals(notifyCrashSpy.calls.length, 1);
});
