import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceResult } from "../../src/types.ts";
import { postIngest, type FetchLike } from "./ingestClient.ts";

/**
 * Declared locally for the same reason `ingestClient.ts` declares `fetch`:
 * fetcher/tsconfig.json scopes `lib` to plain ES2022, so `console` is not an
 * ambient type here even though Node provides a real one at runtime.
 */
declare const console: {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const URL = "https://worker.example.com/ingest";
const TOKEN = "sentinel-token-do-not-log";

const RESULTS: SourceResult[] = [
  { source: "aldi", status: "fulfilled", deals: [] },
  { source: "coles", status: "rejected", reason: "bot challenge" },
];

describe("postIngest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("on 200, resolves and posts the right URL, method, bearer header, and body", async () => {
    // Arrange
    const calls: {
      url: string;
      init: { method: string; headers: Record<string, string>; body: string };
    }[] = [];
    const fetchFn: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200 });
    };

    // Act
    await postIngest(RESULTS, { url: URL, token: TOKEN }, fetchFn);

    // Assert
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(URL);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(call?.init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call?.init.body ?? "") as { results: unknown };
    expect(body.results).toEqual(RESULTS);
  });

  it("on 401, throws with the status in the message", async () => {
    // Arrange
    const fetchFn: FetchLike = () =>
      Promise.resolve({ ok: false, status: 401 });

    // Act + Assert
    await expect(
      postIngest(RESULTS, { url: URL, token: TOKEN }, fetchFn),
    ).rejects.toThrow("401");
  });

  it("on 500, throws", async () => {
    // Arrange
    const fetchFn: FetchLike = () =>
      Promise.resolve({ ok: false, status: 500 });

    // Act + Assert
    await expect(
      postIngest(RESULTS, { url: URL, token: TOKEN }, fetchFn),
    ).rejects.toThrow();
  });

  it("a rejecting fetchFn (network failure) throws", async () => {
    // Arrange
    const fetchFn: FetchLike = () =>
      Promise.reject(new Error("network timeout"));

    // Act + Assert
    await expect(
      postIngest(RESULTS, { url: URL, token: TOKEN }, fetchFn),
    ).rejects.toThrow("network timeout");
  });
});

describe("postIngest token leak guarantee", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cases: { name: string; fetchFn: FetchLike }[] = [
    {
      name: "a 401 response",
      fetchFn: () => Promise.resolve({ ok: false, status: 401 }),
    },
    {
      name: "a 500 response",
      fetchFn: () => Promise.resolve({ ok: false, status: 500 }),
    },
    {
      name: "a network reject",
      fetchFn: () => Promise.reject(new Error("network timeout")),
    },
  ];

  for (const { name, fetchFn } of cases) {
    it(`never leaks the token into a thrown message, a stack, or a console call for ${name}`, async () => {
      // Arrange
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});
      let thrownError: unknown;

      // Act
      try {
        await postIngest(RESULTS, { url: URL, token: TOKEN }, fetchFn);
      } catch (error) {
        thrownError = error;
      }

      // Assert
      expect(thrownError).toBeInstanceOf(Error);
      const error = thrownError as Error;
      expect(error.message).not.toContain(TOKEN);
      if (error.stack) {
        expect(error.stack).not.toContain(TOKEN);
      }
      for (const spy of [consoleErrorSpy, consoleLogSpy]) {
        for (const call of spy.mock.calls) {
          for (const arg of call) {
            expect(String(arg)).not.toContain(TOKEN);
          }
        }
      }
    });
  }
});
