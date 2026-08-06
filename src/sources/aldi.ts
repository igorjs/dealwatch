import { z } from "zod";
import type { AldiStoreProfile, RawDeal } from "../types";
import { toCents } from "../core/price";
import { SourceError } from "./errors";
import type { PageLike } from "../browser";

/**
 * `page.evaluate` callbacks below run inside the remote browser page's DOM
 * context, not this Worker's — but this file compiles under the Worker's
 * `tsconfig.json`, whose `lib` is `ES2022` only (no `dom`), since the rest of
 * the codebase never touches DOM globals. This ambient declaration exists so
 * the `document.body.innerText` reference inside the `evaluate` callback
 * type-checks; it's never evaluated in this file's own (Worker) runtime.
 */
declare const document: { body: { innerText: string } };

/**
 * PLACEHOLDER SCHEMA. No real Aldi product-search response has been
 * captured yet (plan Assumption 19 / Capture notes) — only the request URL
 * is known. This models the plausible shape of
 * `GET https://api.aldi.com.au/v3/product-search`: a `data` array of
 * products plus a `meta.pagination` block. Assumptions beyond what the plan
 * documents, to revisit against the first real capture:
 *   - `price.amount` / `price.wasAmount` are decimal dollar amounts (not
 *     cents), and `wasAmount` is `null` when a product isn't discounted.
 *   - Products also carry a human-readable `categoryName` alongside the
 *     opaque `categoryKey` used for filtering; either may be absent/null.
 * Refine this schema and test/fixtures/aldi.json together once a real
 * capture exists.
 */
const AldiPriceSchema = z.object({
  amount: z.number(),
  wasAmount: z.number().nullable().default(null),
});

const AldiProductSchema = z.object({
  sku: z.string(),
  name: z.string(),
  brandName: z.string().nullable().default(null),
  price: AldiPriceSchema,
  urlSlugText: z.string(),
  categoryKey: z.string().nullable().default(null),
  categoryName: z.string().nullable().default(null),
});

const AldiPayloadSchema = z.object({
  data: z.array(AldiProductSchema),
  meta: z
    .object({
      pagination: z.object({ totalCount: z.number() }),
    })
    .optional(),
});

/**
 * Validates and maps an Aldi product-search response into RawDeal[]. Pure:
 * no I/O. Throws a Zod error on a malformed entry or a wholly invalid
 * payload.
 *
 * Both `wasPriceCents` and `discountPercent` are always null (Assumption 18:
 * Aldi specials are flat "Super Savers" prices, not was/now percentage
 * discounts, so matching is keyword-only). Leaving `wasPriceCents` null is
 * load-bearing: `normalize` derives a discount from was/now when the source
 * gives none, and a derived discount would then gate the deal against the
 * watch's `minDiscountPercent`, silently dropping a keyword-matched Aldi deal.
 */
export function parseAldiPayload(json: unknown): RawDeal[] {
  const payload = AldiPayloadSchema.parse(json);

  return payload.data.map((product): RawDeal => ({
    source: "aldi",
    title: product.name,
    url: `https://www.aldi.com.au/product/${product.urlSlugText}`,
    store: "Aldi",
    department: product.categoryName,
    priceCents: toCents(product.price.amount),
    wasPriceCents: null,
    discountPercent: null,
  }));
}

const ALDI_PRODUCT_SEARCH_URL = "https://api.aldi.com.au/v3/product-search";
const ALDI_PAGE_SIZE = 30;
/**
 * Defensive cap on pages fetched per categoryKey, in case `meta.pagination.
 * totalCount` is ever missing/wrong and the offset-vs-totalCount stopping
 * condition can't terminate on its own. 20 pages * 30/page = 600 products,
 * comfortably above any plausible specials category size.
 */
const ALDI_MAX_PAGES_PER_CATEGORY = 20;

function buildAldiRequestUrl(
  categoryKey: string,
  servicePoint: string,
  offset: number,
): string {
  return `${ALDI_PRODUCT_SEARCH_URL}?currency=AUD&serviceType=walk-in` +
    `&categoryKey=${encodeURIComponent(categoryKey)}&limit=${ALDI_PAGE_SIZE}&offset=${offset}` +
    `&sort=relevance&servicePoint=${encodeURIComponent(servicePoint)}`;
}

/** One page's worth of parsed results, plus the total count reported for the category (if any). */
interface AldiPageResult {
  deals: RawDeal[];
  totalCount: number | undefined;
}

/**
 * Reads the JSON body of a page that has just navigated directly to a JSON
 * API endpoint: a browser rendering a raw JSON response renders it as the
 * page's plain-text body, so `document.body.innerText` round-trips back to
 * the original payload via `JSON.parse`. Wraps a parse failure (or any
 * shape rejected by `parseAldiPayload`'s Zod schema) in a `SourceError` so
 * callers never see a raw `SyntaxError`/`ZodError`.
 */
async function readAldiJsonPage(
  page: PageLike,
  url: string,
): Promise<AldiPageResult> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });

  if (!response || response.status() < 200 || response.status() >= 300) {
    throw new SourceError(
      "aldi",
      `product-search navigation failed: ${response ? response.status() : "no response"}`,
    );
  }

  let json: unknown;
  try {
    json = await page.evaluate(() => JSON.parse(document.body.innerText));
  } catch (cause) {
    throw new SourceError(
      "aldi",
      "product-search page body was not valid JSON (likely a bot challenge or outage page)",
      { cause },
    );
  }

  try {
    const payload = AldiPayloadSchema.parse(json);
    return {
      deals: parseAldiPayload(payload),
      totalCount: payload.meta?.pagination.totalCount,
    };
  } catch (cause) {
    throw new SourceError(
      "aldi",
      "product-search response did not match the expected shape",
      { cause },
    );
  }
}

/**
 * Fetches Aldi's product-search endpoint via a Browser Rendering `PageLike`,
 * once per configured `categoryKey`, paging through `offset` until the
 * category is exhausted, and merges the results across both categories and
 * all pages, de-duplicating by `RawDeal.url` so a product present under more
 * than one category (or returned again on a later page) isn't emitted twice.
 *
 * A real browser is required here, not a plain `fetch`: `api.aldi.com.au`
 * sits behind Akamai bot-protection that 403s a plain Worker fetch (even
 * with a spoofed User-Agent) — only a real browser session, which mints
 * Aldi's httpOnly `_abck` cookie, gets through (spike-proven). `page.goto`
 * navigates straight to the JSON API URL; `page.evaluate` pulls the parsed
 * JSON out of the rendered page body.
 *
 * Throws `SourceError("aldi", ...)` on a non-2xx navigation or a body that
 * isn't valid JSON / doesn't match the expected shape (a bot-challenge or
 * outage page), so callers get a typed, distinguishable failure.
 */
export async function fetchAldiViaBrowser(
  page: PageLike,
  profile: AldiStoreProfile,
): Promise<RawDeal[]> {
  const merged = new Map<string, RawDeal>();

  for (const categoryKey of profile.categoryKeys) {
    let offset = 0;

    for (let pageCount = 0; pageCount < ALDI_MAX_PAGES_PER_CATEGORY; pageCount++) {
      const url = buildAldiRequestUrl(categoryKey, profile.servicePoint, offset);
      const { deals, totalCount } = await readAldiJsonPage(page, url);

      for (const deal of deals) {
        merged.set(deal.url, deal);
      }

      if (deals.length === 0) break;

      offset += ALDI_PAGE_SIZE;

      if (totalCount === undefined || offset >= totalCount) break;
    }
  }

  return [...merged.values()];
}
