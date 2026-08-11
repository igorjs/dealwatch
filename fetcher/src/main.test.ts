import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Source, SourceResult } from "../../src/types.ts";
import type { BrowserLike, PageLike } from "./browser.ts";
import { main, type LaunchedBrowser, type MainDeps } from "./main.ts";

const TOKEN = "sentinel-token-do-not-log";
const URL = "https://worker.example.com/ingest";

/**
 * A fake browser + context pair whose `newPage`/page `close`/`browser.close`
 * calls are all appended to a shared `callOrder` array, in call order, so a
 * test can prove the sources run serially (a page always closes before the
 * next one opens) without a real browser.
 */
function makeFakeBrowser(callOrder: string[]): LaunchedBrowser {
  let pageCount = 0;
  const browser = {
    close: async () => {
      callOrder.push("browser:close");
    },
  };
  const context: BrowserLike = {
    newPage: async () => {
      pageCount += 1;
      const id = pageCount;
      callOrder.push(`page:${id}:open`);
      const page: PageLike = {
        goto: async () => null,
        evaluate: async () => undefined,
        waitForResponse: async () => ({ url: () => "https://example.test", json: async () => ({}) }),
        on: () => {},
        close: async () => {
          callOrder.push(`page:${id}:close`);
        },
      };
      return page;
    },
  };
  return { browser, context };
}

function fulfilled(source: Source): SourceResult {
  return { source, status: "fulfilled", deals: [] };
}

function rejected(source: Source, reason: string): SourceResult {
  return { source, status: "rejected", reason };
}

/** A fetchStore fake that returns a fixed outcome per source and records call order. */
function makeFetchStoreFake(outcomeBySource: Record<Source, SourceResult>, callOrder: string[]) {
  const calls: Source[] = [];
  const fetchStoreFake = async (source: Source): Promise<SourceResult> => {
    calls.push(source);
    callOrder.push(`fetchStore:${source}`);
    return outcomeBySource[source];
  };
  return { fetchStoreFake, calls };
}

interface PostIngestCall {
  results: SourceResult[];
  target: { url: string; token: string };
}

/** A postIngest fake that records every call and optionally rejects. */
function makePostIngestFake(shouldThrow = false) {
  const calls: PostIngestCall[] = [];
  const postIngestFake = async (results: SourceResult[], target: { url: string; token: string }): Promise<void> => {
    calls.push({ results, target });
    if (shouldThrow) {
      throw new Error("ingest POST failed with status 500");
    }
  };
  return { postIngestFake, calls };
}

describe("main", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("one source failing does not stop the others, and postIngest receives all three results in one call", async () => {
    // Arrange
    const callOrder: string[] = [];
    const { fetchStoreFake } = makeFetchStoreFake(
      {
        aldi: fulfilled("aldi"),
        woolworths: rejected("woolworths", "bot challenge"),
        coles: fulfilled("coles"),
      },
      callOrder,
    );
    const { postIngestFake, calls } = makePostIngestFake();
    const deps: MainDeps = {
      env: { API_TOKEN: TOKEN, WORKER_INGEST_URL: URL },
      launchStealth: async () => makeFakeBrowser(callOrder),
      fetchStore: fetchStoreFake,
      postIngest: postIngestFake,
    };

    // Act
    await main(deps);

    // Assert
    expect(calls).toHaveLength(1);
    const results = calls[0]?.results ?? [];
    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("all three sources failing still posts once with three rejected results, and main resolves with a zero exit code", async () => {
    // Arrange
    const callOrder: string[] = [];
    const { fetchStoreFake } = makeFetchStoreFake(
      {
        aldi: rejected("aldi", "bot challenge"),
        woolworths: rejected("woolworths", "bot challenge"),
        coles: rejected("coles", "bot challenge"),
      },
      callOrder,
    );
    const { postIngestFake, calls } = makePostIngestFake();
    const deps: MainDeps = {
      env: { API_TOKEN: TOKEN, WORKER_INGEST_URL: URL },
      launchStealth: async () => makeFakeBrowser(callOrder),
      fetchStore: fetchStoreFake,
      postIngest: postIngestFake,
    };

    // Act
    await main(deps);

    // Assert
    expect(calls).toHaveLength(1);
    const results = calls[0]?.results ?? [];
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("postIngest failing sets a non-zero exit code", async () => {
    // Arrange
    const callOrder: string[] = [];
    const { fetchStoreFake } = makeFetchStoreFake(
      { aldi: fulfilled("aldi"), woolworths: fulfilled("woolworths"), coles: fulfilled("coles") },
      callOrder,
    );
    const { postIngestFake } = makePostIngestFake(true);
    const deps: MainDeps = {
      env: { API_TOKEN: TOKEN, WORKER_INGEST_URL: URL },
      launchStealth: async () => makeFakeBrowser(callOrder),
      fetchStore: fetchStoreFake,
      postIngest: postIngestFake,
    };

    // Act
    await main(deps);

    // Assert
    expect(process.exitCode).toBe(1);
  });

  it("runs the three sources serially: a page always closes before the next one opens", async () => {
    // Arrange
    const callOrder: string[] = [];
    const { fetchStoreFake } = makeFetchStoreFake(
      { aldi: fulfilled("aldi"), woolworths: fulfilled("woolworths"), coles: fulfilled("coles") },
      callOrder,
    );
    const { postIngestFake } = makePostIngestFake();
    const deps: MainDeps = {
      env: { API_TOKEN: TOKEN, WORKER_INGEST_URL: URL },
      launchStealth: async () => makeFakeBrowser(callOrder),
      fetchStore: fetchStoreFake,
      postIngest: postIngestFake,
    };

    // Act
    await main(deps);

    // Assert
    const opens = callOrder.filter((entry) => entry.startsWith("page:") && entry.endsWith(":open"));
    const closes = callOrder.filter((entry) => entry.startsWith("page:") && entry.endsWith(":close"));
    expect(opens).toHaveLength(3);
    expect(closes).toHaveLength(3);
    for (let i = 0; i < opens.length - 1; i++) {
      const close = closes[i];
      const nextOpen = opens[i + 1];
      expect(close).toBeDefined();
      expect(nextOpen).toBeDefined();
      expect(callOrder.indexOf(close ?? "")).toBeLessThan(callOrder.indexOf(nextOpen ?? ""));
    }
  });

  it("closes the browser even when a source throws", async () => {
    // Arrange
    const callOrder: string[] = [];
    const fetchStoreFake = async (): Promise<SourceResult> => {
      throw new Error("unexpected driver crash");
    };
    const { postIngestFake } = makePostIngestFake();
    const deps: MainDeps = {
      env: { API_TOKEN: TOKEN, WORKER_INGEST_URL: URL },
      launchStealth: async () => makeFakeBrowser(callOrder),
      fetchStore: fetchStoreFake,
      postIngest: postIngestFake,
    };

    // Act
    const error = await main(deps).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(callOrder).toContain("browser:close");
  });

  it("a missing API_TOKEN fails fast without leaking any env var value, and never launches the browser", async () => {
    // Arrange
    let launchStealthCalled = false;
    const deps: MainDeps = {
      env: { WORKER_INGEST_URL: URL },
      launchStealth: async () => {
        launchStealthCalled = true;
        return makeFakeBrowser([]);
      },
      fetchStore: async (source) => fulfilled(source),
      postIngest: async () => {},
    };

    // Act
    const error = await main(deps).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("API_TOKEN");
    expect(message).not.toContain(URL);
    expect(message).not.toContain(TOKEN);
    expect(launchStealthCalled).toBe(false);
  });
});
