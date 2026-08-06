/**
 * Thin wrapper around `@cloudflare/puppeteer`, isolated to this one file so
 * the rest of the codebase depends only on the narrow `PageLike`/
 * `BrowserSession` interfaces below (the subset of the real Puppeteer API the
 * store fetchers actually use) and can be unit-tested with a fake page —
 * Browser Rendering has no local simulator, so a real browser is never
 * exercised in tests.
 *
 * Verified against the installed `@cloudflare/puppeteer@1.2.0` type
 * definitions (`node_modules/@cloudflare/puppeteer/lib/types.d.ts`, a
 * self-contained bundle — this fork has no separate `puppeteer-core`
 * dependency, so there is only one place to check):
 *
 * - `puppeteer.launch(endpoint: BrowserWorker, options?: WorkersLaunchOptions
 *   ): Promise<Browser>` (types.d.ts:3891, re-exported as a bound method on
 *   `PuppeteerWorkers` at types.d.ts:6647). `BrowserWorker` is
 *   `{ fetch: typeof fetch }` (types.d.ts:694) — a minimal structural type.
 *   `Env.BROWSER` is generated as `BrowserRun` (worker-configuration.d.ts),
 *   which structurally satisfies `BrowserWorker`.
 * - `Browser.newPage(): Promise<Page>` (types.d.ts:288).
 * - `Page.goto(url: string, options?: GoToOptions): Promise<HTTPResponse |
 *   null>` (types.d.ts:5286); `GoToOptions extends WaitForOptions` which has
 *   `timeout?: number` and `waitUntil?: PuppeteerLifeCycleEvent |
 *   PuppeteerLifeCycleEvent[]` (types.d.ts:7321-7338).
 * - `Page.evaluate<Params, Func>(pageFunction: Func | string, ...args:
 *   Params): Promise<Awaited<ReturnType<Func>>>` (types.d.ts:5699).
 * - `Page.close(options?: { runBeforeUnload?: boolean }): Promise<void>`
 *   (types.d.ts:5803). `Browser.close(): Promise<void>` (types.d.ts:353).
 * - `Page.waitForResponse(urlOrPredicate: string | AwaitablePredicate<
 *   HTTPResponse>, options?: WaitTimeoutOptions): Promise<HTTPResponse>`
 *   (types.d.ts:5376) — CONFIRMED PRESENT.
 * - `Page extends EventEmitter<PageEvents>` (types.d.ts:4509), and
 *   `PageEvents` maps `PageEvent.Response = "response"` to `HTTPResponse`
 *   (types.d.ts:6242-6259), with `EventEmitter.on<Key>(type: Key, handler:
 *   Handler<Events[Key]>): this` (types.d.ts:2123). So `page.on("response",
 *   (response: HTTPResponse) => ...)` is fully typed — CONFIRMED PRESENT.
 * - `HTTPResponse.url(): string` (types.d.ts:3420) and `HTTPResponse.json():
 *   Promise<any>` (types.d.ts:3471) are both present, which is what a
 *   GraphQL-response-interception fetcher (WU-12) needs.
 *
 * Conclusion: both `waitForResponse` and `on("response", ...)` exist on the
 * real installed types, so `PageLike` below includes `waitForResponse`.
 */
import puppeteer from "@cloudflare/puppeteer";

/**
 * The subset of the real Puppeteer `Page` API the store fetchers need.
 * Narrowed and re-typed (not a re-export of `@cloudflare/puppeteer`'s own
 * `Page`) so fakes in tests only need to implement these few methods.
 */
export interface PageLike {
  goto(
    url: string,
    options?: {
      timeout?: number;
      waitUntil?: string | string[];
    },
  ): Promise<{ status(): number } | null>;
  evaluate<T>(
    fn: (...args: unknown[]) => T | Promise<T>,
    ...args: unknown[]
  ): Promise<T>;
  /**
   * Resolves with the first response matching `urlOrPredicate`. Confirmed
   * present on the real `Page` type (see file header) — available for a
   * fetcher that intercepts a GraphQL/XHR response instead of scraping the
   * rendered DOM.
   */
  waitForResponse(
    urlOrPredicate:
      | string
      | ((response: { url(): string; json(): Promise<unknown> }) => boolean | Promise<boolean>),
    options?: { timeout?: number },
  ): Promise<{ url(): string; json(): Promise<unknown> }>;
  close(): Promise<void>;
}

/** The subset of the real Puppeteer `Browser` API the pipeline needs. */
export interface BrowserSession {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

/**
 * Cloudflare's generated binding type for the `browser` binding declared in
 * `wrangler.jsonc` (see `worker-configuration.d.ts`: `BROWSER: BrowserRun`).
 * Structurally, this is just `{ fetch: typeof fetch }` — the same shape
 * `@cloudflare/puppeteer`'s own `BrowserWorker` type expects — so a real
 * `BrowserRun` binding satisfies `puppeteer.launch` without a cast.
 */
export type BrowserBinding = { fetch: typeof fetch };

/**
 * Launches a Browser Rendering session against `binding` (the Worker's
 * `env.BROWSER`) and returns it as a `BrowserSession`. `puppeteer.launch`'s
 * real return value (a `Browser` instance) already structurally satisfies
 * `BrowserSession` — no wrapping needed.
 *
 * This is the ONLY file in the codebase that imports `@cloudflare/puppeteer`
 * directly; everyone else depends on `PageLike`/`BrowserSession`/`launch`.
 */
export async function launch(binding: BrowserBinding): Promise<BrowserSession> {
  return await puppeteer.launch(binding);
}

/**
 * One possible outcome of a per-source fetch run by `withSourcesSerial`,
 * mirroring the shape `Promise.allSettled` uses (a familiar, well-understood
 * contract) so callers — namely the pipeline — can reuse the same
 * fulfilled/rejected narrowing they already use elsewhere.
 */
export type SourceResult<T, R> =
  | { source: T; status: "fulfilled"; value: R }
  | { source: T; status: "rejected"; reason: unknown };

/**
 * Runs `fn` once per source in `sources`, strictly one at a time: for each
 * source it opens a fresh page via `browser.newPage()`, awaits `fn(source,
 * page)`, and always closes that page in a `finally` block before moving on
 * — regardless of whether `fn` resolved or threw. Two sources' pages are
 * never open/running concurrently.
 *
 * A thrown/rejected `fn` for one source does not stop the loop; it is
 * captured as a `"rejected"` result and the next source still runs, so the
 * caller (the pipeline) can isolate per-source failures the way v1's
 * `Promise.allSettled` did.
 */
export async function withSourcesSerial<T, R>(
  sources: readonly T[],
  fn: (source: T, page: PageLike) => Promise<R>,
  browser: BrowserSession,
): Promise<SourceResult<T, R>[]> {
  const results: SourceResult<T, R>[] = [];

  for (const source of sources) {
    const page = await browser.newPage();
    try {
      const value = await fn(source, page);
      results.push({ source, status: "fulfilled", value });
    } catch (reason) {
      results.push({ source, status: "rejected", reason });
    } finally {
      await page.close();
    }
  }

  return results;
}
