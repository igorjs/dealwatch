import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, runOnePass } from "./index";
import type { BrowserSession, PageLike } from "./browser";
import { LIST_KEY, readList } from "./listStore";
import { runPipeline } from "./pipeline";
import { recordAttempt } from "./store";
import type { RawDeal } from "./types";

// `TEST_MIGRATIONS` is a test-only binding wired in vitest.config.ts, same
// pattern as store.test.ts / pipeline.test.ts.
const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };

/**
 * Storage (D1 + R2) is isolated per test *file*, not per test (see
 * vitest.config.ts). So every test in this file shares one D1 instance and
 * one R2 bucket; each test uses its own unique data (deal ids/urls, R2 keys)
 * so tests can't collide with each other. Routes under test that read a
 * FIXED key (`GET /shopping-list` reads the production `LIST_KEY`) instead
 * clean up after themselves.
 */
beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

const API_TOKEN = "test-api-token-12345";

/**
 * The shape `handler.fetch` actually expects for its `request` parameter.
 * The global `Request` constructor (from the DOM/workers-types lib) types
 * its `cf` property as the looser `CfProperties`, not the runtime's
 * `IncomingRequestCfProperties` — a well-known typing friction in Workers
 * tests, not a real behavioral difference (miniflare supplies `cf` for real
 * at runtime regardless of what the constructor's static type says).
 */
type IncomingRequest = Request<unknown, IncomingRequestCfProperties<unknown>>;

/** The real `env`, with a known `API_TOKEN`/`NTFY_TOPIC_URL` for auth + config. */
function testWorkerEnv(): Env {
  return {
    ...(env as unknown as Env),
    API_TOKEN,
    NTFY_TOPIC_URL: "https://ntfy.sh/dealwatch-test-topic",
  };
}

function plainRequest(path: string, init: RequestInit = {}): IncomingRequest {
  return new Request(`https://example.com${path}`, init) as IncomingRequest;
}

function authedRequest(path: string, init: RequestInit = {}): IncomingRequest {
  return new Request(`https://example.com${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${API_TOKEN}` },
  }) as IncomingRequest;
}

/** A no-op BrowserSession/PageLike: fetchers are swapped separately so the real page API is never exercised. */
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

describe("fetch: POST /run", () => {
  it("returns 401 when the Authorization header is missing", async () => {
    // Arrange
    const handler = createHandler();
    const request = plainRequest("/run", { method: "POST" });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(401);
  });

  it("returns 401 (same status as missing) when the bearer token is present but wrong", async () => {
    // Arrange
    const handler = createHandler();
    const request = plainRequest("/run", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(401);
  });

  it("with a valid bearer, drives the pipeline through a fake browser/fetcher and returns 200 with the summary", async () => {
    // Arrange: a fake browser (via `launchFn`) and a fake `aldi` fetcher
    // (via `PipelineDeps.fetchers`, threaded through `runPipelineFn`) so the
    // real route — auth, `runOnePass`, `runPipeline`, D1/R2 writes — runs
    // end to end without ever driving real Browser Rendering.
    const dealUrl = `https://example.com/deal/${crypto.randomUUID()}`;
    const matchingDeal: RawDeal = {
      source: "aldi",
      title: "Extra Virgin Olive Oil 1L",
      url: dealUrl,
      store: "Aldi Example",
      department: null,
      priceCents: 500,
      wasPriceCents: 1000,
      discountPercent: 50,
    };
    const listKey = `list-${crypto.randomUUID()}.json`;
    const handler = createHandler({
      launchFn: vi.fn().mockResolvedValue(fakeBrowser()),
      buildConfigFn: (e) => ({
        watchlist: [{ term: "olive oil", minDiscountPercent: 0, exclude: [] }],
        ntfy: { topicUrl: e.NTFY_TOPIC_URL },
        stores: {
          aldi: { servicePoint: "G452", categoryKeys: ["cat-1"] },
          coles: { url: "https://www.coles.com.au/on-special?filter_Special=halfprice" },
          woolworths: { url: "https://www.woolworths.com.au/apis/ui/browse/category" },
        },
      }),
      // Delegate to the real runPipeline, just with fakes injected for
      // fetchers/listKey — same seam pipeline.test.ts uses.
      runPipelineFn: (deps) =>
        runPipeline({
          ...deps,
          listKey,
          fetchers: {
            aldi: vi.fn().mockResolvedValue([matchingDeal]),
            woolworths: vi.fn().mockResolvedValue([]),
            coles: vi.fn().mockResolvedValue([]),
          },
        }),
    });
    const request = authedRequest("/run", { method: "POST" });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert: 200 with the summary, and D1/R2 were actually touched.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { fetched: number; matched: number };
    expect(body.fetched).toBe(1);
    expect(body.matched).toBe(1);

    const grouped = await readList(env.LIST, listKey);
    const allItems = Object.values(grouped).flat();
    expect(allItems.some((item) => item.url === dealUrl)).toBe(true);
  });
});

describe("runOnePass", () => {
  it("closes the browser session (not just its pages) after a successful pass", async () => {
    // Arrange
    const browser = fakeBrowser();
    const summary = { fetched: 0, matched: 0, sourceFailures: [] };
    const runPipelineFn = vi.fn().mockResolvedValue(summary);

    // Act
    const result = await runOnePass(testWorkerEnv(), {
      launchFn: vi.fn().mockResolvedValue(browser),
      runPipelineFn,
    });

    // Assert
    expect(result).toEqual(summary);
    expect(runPipelineFn).toHaveBeenCalledTimes(1);
    const call = runPipelineFn.mock.calls[0]?.[0];
    expect(call.db).toBe(testEnv.DB);
    expect(call.bucket).toBe(env.LIST);
    expect(call.browser).toBe(browser);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("closes the browser session even when runPipeline throws", async () => {
    // Arrange
    const browser = fakeBrowser();
    const runPipelineFn = vi.fn().mockRejectedValue(new Error("pipeline boom"));

    // Act + Assert
    await expect(
      runOnePass(testWorkerEnv(), {
        launchFn: vi.fn().mockResolvedValue(browser),
        runPipelineFn,
      }),
    ).rejects.toThrow("pipeline boom");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("fetch: GET /health", () => {
  it("returns the source_health rows as JSON for a valid bearer", async () => {
    // Arrange: seed a real "woolworths" attempt via `recordAttempt` (an
    // idempotent upsert), so the route has something real to read back
    // regardless of what other tests in this file already wrote for
    // "aldi"/"coles" (storage is shared per test *file*, not per test).
    const seededAt = new Date("2026-08-01T00:00:00.000Z");
    await recordAttempt(testEnv.DB, "woolworths", seededAt, true);
    const handler = createHandler();
    const request = authedRequest("/health");
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<
      { source: string; lastSuccessAt: string | null }
    >;
    const woolworths = body.find((entry) => entry.source === "woolworths");
    expect(woolworths?.lastSuccessAt).toBe(seededAt.toISOString());
  });

  it("returns 401 when unauthenticated", async () => {
    // Arrange
    const handler = createHandler();
    const request = plainRequest("/health");
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(401);
  });
});

describe("fetch: GET /shopping-list", () => {
  it("returns the R2 object's content as JSON when present", async () => {
    // Arrange: write a valid shopping-list object directly at the
    // production LIST_KEY this route reads.
    const dealId = `deal-${crypto.randomUUID()}`;
    const listContent = {
      [dealId]: {
        id: dealId,
        title: "Test Deal",
        store: "Aldi",
        url: "https://example.com/deal-1",
        category: "pantry",
        priceCents: 500,
        status: "pending",
        addedAt: "2026-08-01T00:00:00.000Z",
      },
    };
    await env.LIST.put(LIST_KEY, JSON.stringify(listContent));
    const handler = createHandler();
    const request = authedRequest("/shopping-list");
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown[]>;
    const allItems = Object.values(body).flat() as Array<{ id: string }>;
    expect(allItems.map((item) => item.id)).toContain(dealId);

    // Cleanup: this route reads the fixed production LIST_KEY (shared
    // across this file's tests), so remove what this test wrote.
    await env.LIST.delete(LIST_KEY);
  });

  it("returns 404 when the object is absent", async () => {
    // Arrange: ensure the production key is absent for this test.
    await env.LIST.delete(LIST_KEY);
    const handler = createHandler();
    const request = authedRequest("/shopping-list");
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(404);
  });

  it("returns 500 (not 404) when the object exists but is corrupt", async () => {
    // Arrange
    await env.LIST.put(LIST_KEY, "{ not valid json");
    const handler = createHandler();
    const request = authedRequest("/shopping-list");
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(500);

    // Cleanup
    await env.LIST.delete(LIST_KEY);
  });

  it("returns 401 when unauthenticated", async () => {
    // Arrange
    const handler = createHandler();
    const request = plainRequest("/shopping-list");
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(401);
  });
});

describe("fetch: unknown routes", () => {
  it("returns 404 for an unknown path", async () => {
    // Arrange
    const handler = createHandler();
    const request = authedRequest("/nope");
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(404);
  });

  it("returns 404 for a known path with the wrong method", async () => {
    // Arrange
    const handler = createHandler();
    const request = authedRequest("/run", { method: "GET" });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(404);
  });
});
