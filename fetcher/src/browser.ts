/**
 * Stealth Playwright launch, isolated to this one file so the rest of the
 * fetcher depends only on the narrow `PageLike`/`BrowserLike` interfaces
 * below (the subset of the real Playwright API the store drivers actually
 * use) and can be unit tested with a fake browser and a fake page.
 * `launchStealth` is the only place Chromium is ever started, and it is
 * never called from a test.
 *
 * Verified against the installed `playwright-core@1.62.1` type definitions
 * (`node_modules/playwright-core/types/types.d.ts`):
 *
 * - `BrowserType.launch(options?: LaunchOptions): Promise<Browser>`
 *   (types.d.ts:16981); `LaunchOptions.args` and `.headless`
 *   (types.d.ts:24935 onward).
 * - `Browser.newContext(options?: BrowserContextOptions):
 *   Promise<BrowserContext>`; `BrowserContextOptions.locale`, `.timezoneId`,
 *   `.viewport`, `.userAgent`, `.extraHTTPHeaders` (types.d.ts:25287
 *   onward).
 * - `BrowserContext.newPage(): Promise<Page>`.
 * - `Page.goto(url, options?): Promise<Response | null>` (types.d.ts:3414),
 *   `Page.evaluate(pageFunction, arg?): Promise<R>` (types.d.ts:137, 190),
 *   `Page.close(options?): Promise<void>` (types.d.ts:2343).
 * - `Response.status(): number`.
 *
 * Adapted from the deleted `src/browser.ts` (git history, commit 9ea5435),
 * which wrapped `@cloudflare/puppeteer` for the Worker. The shape carries
 * over, but Playwright's own API differs from Puppeteer's in two ways this
 * file follows: `evaluate` takes a single optional argument, not a variadic
 * list, and pages are opened from a `BrowserContext` (carrying locale,
 * timezone, viewport, user agent) rather than directly from a `Browser`.
 *
 * `chromium.use(...)` only registers the stealth plugin on the shared
 * `playwright-extra` launcher; it does not start a browser process, so
 * running it at module load time never launches real Chromium.
 */
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

/**
 * The subset of the real Playwright `Page` API the store drivers need:
 * navigate, read the rendered page, and close. Narrowed and re-typed (not a
 * re-export of Playwright's own `Page`) so fakes in driver tests only need
 * to implement these few methods.
 */
export interface PageLike {
  goto(
    url: string,
    options?: {
      timeout?: number;
      waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
    },
  ): Promise<{ status(): number } | null>;
  evaluate(pageFunction: (arg?: unknown) => unknown, arg?: unknown): Promise<unknown>;
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
}

/**
 * The subset of the real Playwright session a driver needs to open a page:
 * the context returned by `launchStealth`, or any fake with the same shape.
 */
export interface BrowserLike {
  newPage(): Promise<PageLike>;
}

/**
 * A real desktop Chrome user agent, not Playwright's own default. The
 * default announces itself in ways Akamai and Imperva fingerprint; this
 * value is the one the 2026-08-04 spike confirmed works against both.
 */
const DESKTOP_CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/**
 * Launch and context configuration the 2026-08-04 spike proved works
 * against Akamai (Coles, Woolworths) and Imperva. Kept as one named,
 * exported constant so a test can assert on the exact values without ever
 * launching a browser.
 */
export const STEALTH_OPTIONS = {
  launch: {
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  },
  context: {
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    viewport: { width: 1366, height: 900 },
    userAgent: DESKTOP_CHROME_USER_AGENT,
    extraHTTPHeaders: { "accept-language": "en-AU,en;q=0.9" },
  },
};

/**
 * Launches headless Chromium with the stealth plugin applied and opens a
 * context configured with `STEALTH_OPTIONS.context`. Returns both the
 * browser and the context: closing the browser tears down the context and
 * every page opened on it.
 */
export async function launchStealth() {
  const browser = await chromium.launch(STEALTH_OPTIONS.launch);
  const context = await browser.newContext(STEALTH_OPTIONS.context);
  return { browser, context };
}

/**
 * Opens a page on `browser` (the context returned by `launchStealth`, or a
 * fake with the same shape). Drivers receive a page through this seam
 * instead of constructing one themselves, so tests can inject a fake
 * browser and never launch real Chromium.
 */
export async function newPage(browser: BrowserLike): Promise<PageLike> {
  return browser.newPage();
}
