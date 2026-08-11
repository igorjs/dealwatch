import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler } from "./index";
import { LIST_KEY } from "./listStore";
import { getHealth, recordAttempt } from "./store";
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

describe("fetch: POST /run (route removed)", () => {
  it("returns 404 for a valid bearer token, proving auth is not what rejects it", async () => {
    // Arrange: the route is gone entirely, so even a correctly authed
    // request must fall through to the unknown-route 404, not a 401.
    const handler = createHandler();
    const request = authedRequest("/run", { method: "POST" });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(404);
  });

  it("has no scheduled property on the exported handler", () => {
    // Arrange + Act: GitHub Actions is the sole scheduler now, so there is
    // no Cron `scheduled` handler left to export.
    const handler = createHandler();

    // Assert
    expect("scheduled" in handler).toBe(false);
  });
});

describe("fetch: POST /ingest", () => {
  /**
   * A request-shaped object exposing only what `POST /ingest` actually reads
   * (`url`, `headers`, `text()`), with `text` swappable for a spy. Lets the
   * size-guard boundary tests below control the `Content-Length` header and
   * the bytes `text()` returns independently, and prove the body was never
   * read at all, without constructing a real multi-megabyte `Request`.
   */
  function fakeIngestRequest(
    headers: HeadersInit,
    text: () => Promise<string>,
  ): IncomingRequest {
    return {
      method: "POST",
      url: "https://example.com/ingest",
      headers: new Headers(headers),
      text,
    } as unknown as IncomingRequest;
  }

  /**
   * A valid `IngestBody` JSON string padded to exactly `sizeBytes` (measured
   * the same way the route measures it, via `TextEncoder`), using an extra
   * `padding` field `IngestBodySchema` silently strips on parse (it has no
   * `.strict()`). Lets the exact-boundary tests hit a precise byte count
   * without pasting a multi-megabyte literal into this file.
   */
  function ingestBodyPaddedTo(sizeBytes: number): string {
    const skeleton = { results: [] as unknown[], padding: "" };
    const baseBytes = new TextEncoder().encode(JSON.stringify(skeleton)).byteLength;
    skeleton.padding = "a".repeat(sizeBytes - baseBytes);
    return JSON.stringify(skeleton);
  }

  /** `count` minimal but schema-valid RawDeals, for the per-source deal cap tests. */
  function buildRawDeals(count: number): RawDeal[] {
    return Array.from({ length: count }, (_, index) => ({
      source: "aldi",
      title: `Deal ${index}`,
      url: `https://example.com/deal/${index}`,
      store: "Aldi Example",
      department: null,
      priceCents: 100,
      wasPriceCents: 200,
      discountPercent: 50,
    }));
  }

  it("returns 401 when the Authorization header is missing", async () => {
    // Arrange
    const handler = createHandler();
    const request = plainRequest("/ingest", { method: "POST" });
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
    const request = plainRequest("/ingest", {
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

  it("returns 400 when a valid bearer's body is not valid JSON", async () => {
    // Arrange
    const handler = createHandler();
    const request = authedRequest("/ingest", {
      method: "POST",
      body: "{ not valid json",
    });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(400);
  });

  it("returns 400 when the body fails IngestBodySchema (an unknown source)", async () => {
    // Arrange
    const handler = createHandler();
    const request = authedRequest("/ingest", {
      method: "POST",
      body: JSON.stringify({
        results: [{ source: "kmart", status: "fulfilled", deals: [] }],
      }),
    });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(400);
  });

  it("with a valid body, calls the injected processSourceResultsFn with the parsed results and returns 200 with its summary", async () => {
    // Arrange
    const dealUrl = `https://example.com/deal/${crypto.randomUUID()}`;
    const deal: RawDeal = {
      source: "aldi",
      title: "Ingest Test Deal",
      url: dealUrl,
      store: "Aldi Example",
      department: null,
      priceCents: 500,
      wasPriceCents: 1000,
      discountPercent: 50,
    };
    const summary = { fetched: 1, matched: 1, sourceFailures: [] };
    const processSourceResultsFn = vi.fn().mockResolvedValue(summary);
    const handler = createHandler({ processSourceResultsFn });
    const request = authedRequest("/ingest", {
      method: "POST",
      body: JSON.stringify({
        results: [
          { source: "aldi", status: "fulfilled", deals: [deal] },
          { source: "coles", status: "rejected", reason: "timed out" },
          { source: "woolworths", status: "fulfilled", deals: [] },
        ],
      }),
    });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert: 200 with the summary the fake returned, and the fake was
    // actually driven with the parsed body's results, passed straight
    // through with no reshaping.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(summary);
    expect(processSourceResultsFn).toHaveBeenCalledTimes(1);
    const [, results] = processSourceResultsFn.mock.calls[0] as [unknown, unknown];
    expect(results).toEqual([
      { source: "aldi", status: "fulfilled", deals: [deal] },
      { source: "coles", status: "rejected", reason: "timed out" },
      { source: "woolworths", status: "fulfilled", deals: [] },
    ]);
  });

  it("rejects a request whose Content-Length exceeds 5 MB before the body is read", async () => {
    // Arrange
    const processSourceResultsFn = vi.fn();
    const handler = createHandler({ processSourceResultsFn });
    const textFn = vi.fn();
    const request = fakeIngestRequest(
      {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Length": String(5 * 1024 * 1024 + 1),
      },
      textFn,
    );
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert: 400, and neither the body nor the pipeline were ever reached.
    expect(response.status).toBe(400);
    expect(textFn).not.toHaveBeenCalled();
    expect(processSourceResultsFn).not.toHaveBeenCalled();
  });

  it("accepts and parses a body whose size is exactly at the 5 MB limit", async () => {
    // Arrange
    const summary = { fetched: 0, matched: 0, sourceFailures: [] };
    const processSourceResultsFn = vi.fn().mockResolvedValue(summary);
    const handler = createHandler({ processSourceResultsFn });
    const bodyText = ingestBodyPaddedTo(5 * 1024 * 1024);
    const request = fakeIngestRequest(
      { Authorization: `Bearer ${API_TOKEN}` },
      () => Promise.resolve(bodyText),
    );
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(200);
    expect(processSourceResultsFn).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when a single source result carries more than 5000 deals", async () => {
    // Arrange
    const processSourceResultsFn = vi.fn();
    const handler = createHandler({ processSourceResultsFn });
    const request = authedRequest("/ingest", {
      method: "POST",
      body: JSON.stringify({
        results: [{ source: "aldi", status: "fulfilled", deals: buildRawDeals(5001) }],
      }),
    });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(400);
    expect(processSourceResultsFn).not.toHaveBeenCalled();
  });

  it("accepts a single source result carrying exactly 5000 deals", async () => {
    // Arrange
    const summary = { fetched: 5000, matched: 0, sourceFailures: [] };
    const processSourceResultsFn = vi.fn().mockResolvedValue(summary);
    const handler = createHandler({ processSourceResultsFn });
    const request = authedRequest("/ingest", {
      method: "POST",
      body: JSON.stringify({
        results: [{ source: "aldi", status: "fulfilled", deals: buildRawDeals(5000) }],
      }),
    });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert
    expect(response.status).toBe(200);
    expect(processSourceResultsFn).toHaveBeenCalledTimes(1);
  });

  it("returns 200 and records source_health failures when every result in a valid body is rejected", async () => {
    // Arrange: no processSourceResultsFn override, so the real
    // processSourceResults (from src/pipeline.ts) runs against the real D1
    // binding.
    const handler = createHandler({
      buildConfigFn: (e) => ({
        watchlist: [{ term: "unmatched-term-xyz", minDiscountPercent: 0, exclude: [] }],
        ntfy: { topicUrl: e.NTFY_TOPIC_URL },
        stores: {
          aldi: { servicePoint: "G452", categoryKeys: ["cat-1"] },
          coles: { url: "https://www.coles.com.au/on-special?filter_Special=halfprice" },
          woolworths: { url: "https://www.woolworths.com.au/apis/ui/browse/category" },
        },
      }),
    });
    const request = authedRequest("/ingest", {
      method: "POST",
      body: JSON.stringify({
        results: [
          { source: "aldi", status: "rejected", reason: "fetch timed out" },
          { source: "coles", status: "rejected", reason: "blocked by anti-bot" },
          { source: "woolworths", status: "rejected", reason: "network error" },
        ],
      }),
    });
    const ctx = createExecutionContext();

    // Act
    const response = await handler.fetch!(request, testWorkerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // Assert: 200 with all three sources named as failures in the summary,
    // and source_health in D1 actually recorded the attempt.
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fetched: number;
      matched: number;
      sourceFailures: string[];
    };
    expect(body.fetched).toBe(0);
    expect(body.matched).toBe(0);
    expect([...body.sourceFailures].sort()).toEqual(["aldi", "coles", "woolworths"]);

    const health = await getHealth(testEnv.DB);
    const aldiHealth = health.find((entry) => entry.source === "aldi");
    expect(aldiHealth?.consecutiveFailures).toBeGreaterThanOrEqual(1);
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
