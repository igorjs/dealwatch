import type { AldiStoreProfile, RawDeal } from "../../../src/types.ts";
import { parseAldiPayload } from "../../../src/sources/aldi.ts";
import type { PageLike } from "../browser.ts";
import { SourceError, zeroDealSoftBlock } from "../errors.ts";

/**
 * `api.aldi.com.au` is a different origin from `www.aldi.com.au`, so an
 * in-page `fetch` hits CORS. Aldi also sets `_abck` for that origin as
 * httpOnly, so a plain HTTP request cannot mint it; only a real browser
 * navigating the URL can. The driver therefore navigates this URL directly
 * and reads the JSON back out of the rendered page body, rather than
 * fetching it (verified against the live endpoint, 2026-08-04 spike).
 */
const ALDI_API_URL = "https://api.aldi.com.au/v3/product-search";

/**
 * One of Aldi's valid `limit` values (12, 16, 24, 30, 32, 48, 60; not
 * arbitrary). The Limited Time Only feed carries about 120 items, so a
 * single page never covers it; paging by `offset` is required.
 */
const PAGE_LIMIT = 30;

/**
 * Defensive upper bound on pages fetched per category, mirroring the
 * Woolworths driver's own cap. Both termination conditions below depend on
 * the response: a short page, or a `totalCount` read from page one. A
 * response that keeps returning full pages and never reports a `totalCount`
 * satisfies neither and would loop until the Actions job hits its timeout,
 * burning the run and producing nothing. The largest real feed is the
 * 120-item Limited Time Only one (4 pages), so 20 is generous.
 */
const MAX_PAGES_PER_CATEGORY = 20;

/**
 * Declared locally, not pulled from a "dom" lib: fetcher/tsconfig.json scopes
 * `lib` to plain ES2022, so `document` is not an ambient type here even
 * though the function below runs inside a real browser page (via
 * `page.evaluate`), where a real `document` exists at runtime regardless.
 */
declare const document: { body: { innerText: string } };

/** The shape `driveAldi` reads off each page: enough to page and merge, not validated. */
interface AldiRawPage {
  data: unknown[];
  meta?: { pagination?: { totalCount?: number } };
}

/** The merged, still-unvalidated result of paging every categoryKey. */
export interface AldiRawResult {
  data: unknown[];
  meta: { pagination: { totalCount: number } };
}

function buildUrl(categoryKey: string, offset: number, profile: AldiStoreProfile): string {
  const params = new URLSearchParams({
    categoryKey,
    offset: String(offset),
    limit: String(PAGE_LIMIT),
    servicePoint: profile.servicePoint,
  });
  return `${ALDI_API_URL}?${params.toString()}`;
}

async function readPage(page: PageLike, url: string): Promise<AldiRawPage> {
  await page.goto(url);
  const body = (await page.evaluate(() => document.body.innerText)) as string;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SourceError("aldi", "non-JSON response, likely a bot challenge page");
  }

  // Check the one field the paging loop below relies on, rather than casting
  // and trusting it. Without this, a shape change upstream surfaces as a raw
  // "not iterable" TypeError from the spread, which tells the operator
  // nothing about which store broke or why.
  const page1 = parsed as AldiRawPage;
  if (!Array.isArray(page1.data)) {
    throw new SourceError("aldi", "response JSON has no `data` array, the API shape has changed");
  }

  return page1;
}

/**
 * Navigates `profile.categoryKeys` one at a time, paging each by `offset`
 * until a page returns fewer items than `PAGE_LIMIT` or the category's own
 * `totalCount` is reached, and merges every page's `data` into one raw
 * result. Returns RAW JSON: it does not validate against `AldiPayloadSchema`
 * itself, so the caller parses the merged result exactly once instead of
 * once per page (the v2 driver parsed twice).
 */
export async function driveAldi(page: PageLike, profile: AldiStoreProfile): Promise<AldiRawResult> {
  const mergedData: unknown[] = [];
  let mergedTotalCount = 0;

  for (const categoryKey of profile.categoryKeys) {
    let offset = 0;
    let categoryTotal = Number.POSITIVE_INFINITY;
    let categoryCount = 0;

    for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_CATEGORY; pageNumber++) {
      const raw = await readPage(page, buildUrl(categoryKey, offset, profile));
      mergedData.push(...raw.data);
      categoryCount += raw.data.length;

      if (offset === 0) {
        const totalCount = raw.meta?.pagination?.totalCount;
        if (typeof totalCount === "number") {
          categoryTotal = totalCount;
          mergedTotalCount += totalCount;
        }
      }

      if (raw.data.length < PAGE_LIMIT || categoryCount >= categoryTotal) {
        break;
      }
      offset += PAGE_LIMIT;
    }
  }

  return { data: mergedData, meta: { pagination: { totalCount: mergedTotalCount } } };
}

/**
 * Drives both Aldi specials feeds and parses the merged result exactly once
 * with `parseAldiPayload`.
 *
 * A merged result with no deals AND a `totalCount` of 0 is treated as a
 * failure, not a healthy empty fetch: a datacenter runner IP can be soft
 * bot-blocked with a valid-shaped, empty response instead of an HTTP error,
 * and recording that as healthy would hide the store silently until the
 * watchlist stopped matching anything without anyone noticing why.
 */
export async function fetchAldi(page: PageLike, profile: AldiStoreProfile): Promise<RawDeal[]> {
  const merged = await driveAldi(page, profile);
  const deals = parseAldiPayload(merged);

  if (deals.length === 0 && merged.meta.pagination.totalCount === 0) {
    throw zeroDealSoftBlock("aldi");
  }

  return deals;
}
