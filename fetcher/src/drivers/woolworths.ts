import type { RawDeal, StoreProfile } from "../../../src/types.ts";
import { parseWoolworthsPayload } from "../../../src/sources/woolworths.ts";
import type { PageLike } from "../browser.ts";
import { SourceError } from "../errors.ts";

/**
 * The human-facing half-price specials page. `driveWoolworths` navigates
 * here first, and only for that side effect: a real browser loading this
 * page auto-mints the Akamai cookies (`_abck`, `ak_bmsc`, `bm_sz`) and a
 * `wow-auth-token` JWT (2026-08-04 spike). Without this warm step the
 * in-page POST below gets rejected as unauthenticated. Hardcoded rather than
 * sourced from `profile.url`, since which page mints the session is a
 * fetcher-internal detail, not something a deployer configures; `profile.url`
 * is the category API endpoint the POST below targets.
 */
const WOOLWORTHS_HALF_PRICE_PAGE_URL =
  "https://www.woolworths.com.au/shop/browse/specials/half-price";

/** The Half Price specials group, as the browse/category API expects it. */
const WOOLWORTHS_HALF_PRICE_CATEGORY_ID = "specialsgroup.3676";

/** Products requested per page. Chosen to match the site's own page size. */
const PAGE_SIZE = 24;

/**
 * Defensive upper bound on pages fetched, in case `totalRecordCount` is
 * missing or wrong. The spike observed 1624 records at this page size
 * (about 68 pages), so 90 leaves headroom without risking a runaway loop
 * against a bad or malicious `totalRecordCount`.
 */
const MAX_PAGES = 90;

/**
 * Declared locally, not pulled from a "dom" lib: fetcher/tsconfig.json scopes
 * `lib` to plain ES2022, so `fetch` here isn't the ambient type this file
 * otherwise sees. This declaration describes the DOM/browser `fetch` that
 * runs inside the page (via `page.evaluate`, where the Worker's own
 * Akamai-authenticated session cookies apply through `credentials:
 * "include"`), which exists at runtime there regardless of this file's own
 * ambient types.
 */
declare const fetch: (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; credentials: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The request body the category API expects for one page. */
function buildRequestBody(pageNumber: number): Record<string, unknown> {
  return {
    categoryId: WOOLWORTHS_HALF_PRICE_CATEGORY_ID,
    pageNumber,
    pageSize: PAGE_SIZE,
    sortType: "TraderRelevance",
    categoryVersion: "v2",
    filters: [],
  };
}

/**
 * Runs inside the browser page (via `page.evaluate`), same origin as the
 * page just warmed, so this POST carries the browser's own session cookies
 * automatically (`credentials: "include"`); unlike Aldi's cross-origin API,
 * no separate navigation-per-page is needed here (2026-08-04 spike: 200 with
 * 1624 records). Returns the status alongside the body (`undefined` when
 * `res.json()` throws) so the caller outside the page can tell an HTTP
 * failure from a non-JSON bot-challenge body without either case throwing
 * inside the page itself.
 */
async function evaluatePagePost(arg?: unknown): Promise<unknown> {
  const { url, body } = arg as { url: string; body: Record<string, unknown> };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  let parsedBody: unknown;
  try {
    parsedBody = await res.json();
  } catch {
    parsedBody = undefined;
  }
  return { status: res.status, body: parsedBody };
}

interface WoolworthsEvaluatedResponse {
  status: number;
  body: unknown;
}

/** The shape `driveWoolworths` reads off each page: enough to page and merge, not validated. */
interface WoolworthsRawPage {
  bundles?: { products?: unknown[] }[];
  totalRecordCount?: number;
}

/** The merged, still-unvalidated result of paging the category API. */
export interface WoolworthsRawResult {
  bundles: unknown[];
  totalRecordCount: number;
}

async function fetchPage(page: PageLike, url: string, pageNumber: number): Promise<WoolworthsRawPage> {
  const result = (await page.evaluate(evaluatePagePost, {
    url,
    body: buildRequestBody(pageNumber),
  })) as WoolworthsEvaluatedResponse;

  if (result.status < 200 || result.status >= 300) {
    throw new SourceError(
      "woolworths",
      `category API request failed with status ${result.status} (page ${pageNumber})`,
    );
  }

  if (result.body === undefined) {
    throw new SourceError(
      "woolworths",
      `category API returned a non-JSON body (page ${pageNumber}), likely a bot challenge page`,
    );
  }

  return result.body as WoolworthsRawPage;
}

/**
 * Warms the Akamai session by navigating the half-price page, then pages the
 * category API by `pageNumber`, merging every page's `bundles` until the
 * running product count reaches the first page's `totalRecordCount`, the
 * feed returns an empty page, or `MAX_PAGES` stops it. Returns RAW merged
 * JSON: it does not validate against
 * `WoolworthsPayloadSchema` itself, so the caller parses the merged result
 * exactly once instead of once per page.
 */
export async function driveWoolworths(page: PageLike, profile: StoreProfile): Promise<WoolworthsRawResult> {
  await page.goto(WOOLWORTHS_HALF_PRICE_PAGE_URL, { waitUntil: "domcontentloaded" });

  const mergedBundles: unknown[] = [];
  // What the feed said, reported back so the caller's zero-deal guard can
  // still tell a real empty feed from a soft bot-block. Stays 0 when the
  // feed says nothing.
  let reportedTotal = 0;
  // What the loop pages towards. Deliberately NOT `reportedTotal`: if the
  // feed stops sending `totalRecordCount`, a 0 here would make the
  // `collectedCount >= expectedTotal` check true on the first pass and
  // silently return page 1 of roughly 1600 records as a healthy fetch.
  // Infinity instead means an unreported total pages on until the feed runs
  // dry or MAX_PAGES stops it, matching the Aldi driver.
  let expectedTotal = Number.POSITIVE_INFINITY;
  let collectedCount = 0;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const raw = await fetchPage(page, profile.url, pageNumber);
    const bundles = raw.bundles ?? [];
    mergedBundles.push(...bundles);

    if (pageNumber === 1 && typeof raw.totalRecordCount === "number") {
      reportedTotal = raw.totalRecordCount;
      expectedTotal = raw.totalRecordCount;
    }

    const pageCount = bundles.reduce((sum, bundle) => sum + (bundle.products?.length ?? 0), 0);
    collectedCount += pageCount;

    // An empty page means the feed is exhausted. This is the only
    // termination condition available when the total is unreported, and it
    // also stops early on a feed that over-reports its total.
    if (pageCount === 0 || collectedCount >= expectedTotal) {
      break;
    }
  }

  return { bundles: mergedBundles, totalRecordCount: reportedTotal };
}

/**
 * Drives the Woolworths half-price category feed and parses the merged
 * result exactly once with `parseWoolworthsPayload`.
 *
 * A merged result with no deals AND a `totalRecordCount` of 0 is treated as
 * a failure, not a healthy empty fetch: a datacenter runner IP can be soft
 * bot-blocked with a valid-shaped, empty response instead of an HTTP error,
 * and recording that as healthy would hide the store silently until the
 * watchlist stopped matching anything without anyone noticing why.
 */
export async function fetchWoolworths(page: PageLike, profile: StoreProfile): Promise<RawDeal[]> {
  const merged = await driveWoolworths(page, profile);
  const deals = parseWoolworthsPayload(merged);

  if (deals.length === 0 && merged.totalRecordCount === 0) {
    throw new SourceError("woolworths", "woolworths returned 0 deals (possible soft bot-block)");
  }

  return deals;
}
