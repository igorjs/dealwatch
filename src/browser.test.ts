import { describe, expect, it, vi } from "vitest";
import { withSourcesSerial } from "./browser";
import type { BrowserSession, PageLike } from "./browser";

/** Resolves/rejects from outside the executor, for deterministic ordering. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Flushes the microtask queue until `predicate()` is true, or throws after a
 * bounded number of flushes. Deterministic (driven by actual promise
 * resolution, not wall-clock time) but tolerant of implementations that need
 * a different number of microtask hops to propagate a resolved deferred
 * through `await page.close()` / the loop continuation / `await
 * browser.newPage()`.
 */
async function flushUntil(predicate: () => boolean, maxFlushes = 50): Promise<void> {
  for (let i = 0; i < maxFlushes; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  if (!predicate()) {
    throw new Error(`flushUntil: predicate still false after ${maxFlushes} microtask flushes`);
  }
}

/** A fake PageLike whose close() is spy-observable and never throws. */
function fakePage(): PageLike {
  return {
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    evaluate: vi.fn().mockResolvedValue(undefined),
    waitForResponse: vi.fn().mockResolvedValue({
      url: () => "https://example.com",
      json: () => Promise.resolve({}),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** A fake BrowserSession that hands out a fresh fakePage() per newPage() call. */
function fakeBrowser(pages: PageLike[]): BrowserSession {
  let i = 0;
  return {
    newPage: vi.fn(async () => {
      const page = pages[i];
      i += 1;
      if (!page) throw new Error("fakeBrowser: no more pages configured");
      return page;
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("withSourcesSerial", () => {
  it("runs callbacks for multiple sources strictly one at a time, not concurrently", async () => {
    // Arrange
    const order: string[] = [];
    const gateA = deferred<void>();
    const gateB = deferred<void>();
    const pageA = fakePage();
    const pageB = fakePage();
    const browser = fakeBrowser([pageA, pageB]);

    const fn = vi.fn(async (source: string) => {
      order.push(`start-${source}`);
      if (source === "A") {
        await gateA.promise;
      } else {
        await gateB.promise;
      }
      order.push(`end-${source}`);
      return source;
    });

    // Act: kick off the run, but don't await it yet — resolve gates in the
    // order we want to prove, checking `order` between each resolution so a
    // concurrent (non-serial) implementation would show "start-B" before
    // "end-A".
    const runPromise = withSourcesSerial(["A", "B"], fn, browser);

    // Let the microtask queue drain so source A's fn has started.
    await flushUntil(() => order.length >= 1);
    expect(order).toEqual(["start-A"]);

    gateA.resolve();
    // Drain microtasks until "start-B" appears (or a wrongly-concurrent
    // implementation would already show it before gateA even resolves).
    await flushUntil(() => order.length >= 3);
    expect(order).toEqual(["start-A", "end-A", "start-B"]);

    gateB.resolve();
    const results = await runPromise;

    // Assert
    expect(order).toEqual(["start-A", "end-A", "start-B", "end-B"]);
    expect(results).toEqual([
      { source: "A", status: "fulfilled", value: "A" },
      { source: "B", status: "fulfilled", value: "B" },
    ]);
  });

  it("closes a source's page in finally even when its callback throws, and continues to the next source", async () => {
    // Arrange
    const pageA = fakePage();
    const pageB = fakePage();
    const browser = fakeBrowser([pageA, pageB]);
    const failure = new Error("source A blew up");

    const fn = vi.fn(async (source: string) => {
      if (source === "A") throw failure;
      return "ok-B";
    });

    // Act
    const results = await withSourcesSerial(["A", "B"], fn, browser);

    // Assert
    expect(pageA.close).toHaveBeenCalledTimes(1);
    expect(pageB.close).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { source: "A", status: "rejected", reason: failure },
      { source: "B", status: "fulfilled", value: "ok-B" },
    ]);
  });

  it("closes the page in finally even when the callback resolves normally", async () => {
    // Arrange
    const page = fakePage();
    const browser = fakeBrowser([page]);
    const fn = vi.fn(async () => "done");

    // Act
    await withSourcesSerial(["only"], fn, browser);

    // Assert
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it("returns an empty results array for an empty sources list without opening any page", async () => {
    // Arrange
    const browser = fakeBrowser([]);
    const fn = vi.fn(async () => "unused");

    // Act
    const results = await withSourcesSerial([] as string[], fn, browser);

    // Assert
    expect(results).toEqual([]);
    expect(browser.newPage).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});
