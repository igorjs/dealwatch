import { z } from "zod";
import { SourceError } from "./errors";
import type { PageLike } from "../browser";
import type { RawDeal, StoreProfile } from "../types";
import { toCents } from "../core/price";

/**
 * PLACEHOLDER SCHEMA. The Woolworths half-price request is captured (plan's
 * "Woolworths (deals request captured...)" Capture notes) but no response
 * body has been captured yet, so this models the plausible shape of
 * `POST https://www.woolworths.com.au/apis/ui/browse/category` from public
 * knowledge of Woolworths' browse API rather than a real payload. Assumptions
 * beyond what the plan documents, to revisit against the first real capture:
 *   - Products are nested two levels deep: a top-level `bundles` array (one
 *     per merchandising group), each with a `products` array. Real responses
 *     may include non-product bundles (e.g. banners); this schema assumes
 *     every bundle entry is shaped the same way.
 *   - `price.price` / `price.wasPrice` are decimal dollar amounts (not
 *     cents), and `wasPrice` is `null` when a product isn't discounted.
 *   - `department` is a plain string label on the product; may be absent.
 * Refine this schema and test/fixtures/woolworths.json together once a real
 * capture exists.
 */
const WoolworthsPriceSchema = z.object({
  price: z.number(),
  wasPrice: z.number().nullable().default(null),
});

const WoolworthsProductSchema = z.object({
  stockcode: z.number(),
  name: z.string(),
  urlFriendlyName: z.string(),
  price: WoolworthsPriceSchema,
  department: z.string().nullable().default(null),
});

const WoolworthsBundleSchema = z.object({
  products: z.array(WoolworthsProductSchema),
});

const WoolworthsPayloadSchema = z.object({
  bundles: z.array(WoolworthsBundleSchema),
  totalRecordCount: z.number().optional(),
});

/**
 * Validates and maps a Woolworths browse/category response into RawDeal[].
 * Pure: no I/O. Throws a Zod error on a malformed entry or a wholly invalid
 * payload. `discountPercent` is left null here; core/normalize.ts derives it
 * from priceCents/wasPriceCents later (core/price.ts), consistent with how
 * every source hands off discount computation downstream.
 */
export function parseWoolworthsPayload(json: unknown): RawDeal[] {
  const payload = WoolworthsPayloadSchema.parse(json);

  return payload.bundles.flatMap((bundle) =>
    bundle.products.map((product): RawDeal => ({
      source: "woolworths",
      title: product.name,
      url:
        `https://www.woolworths.com.au/shop/productdetails/${product.stockcode}/${product.urlFriendlyName}`,
      store: "Woolworths",
      department: product.department,
      priceCents: toCents(product.price.price),
      wasPriceCents: toCents(product.price.wasPrice),
      discountPercent: null,
    }))
  );
}

const WOOLWORTHS_HALF_PRICE_CATEGORY_ID = "specialsgroup.3676";

/**
 * The human-facing half-price specials page. Navigated first (via
 * `page.goto`) purely to establish a real Akamai session with browser-minted
 * cookies before the in-page category POST runs — Akamai's sensor JS only
 * runs on a real rendered page, never on a bare POST-only API endpoint, so
 * this can't be `profile.url` (the category API endpoint) itself. Hardcoded
 * here rather than sourced from config: which page to warm the session on is
 * a fetcher-internal implementation detail, not something a deployer needs to
 * configure.
 */
const WOOLWORTHS_HALF_PRICE_PAGE_URL =
  "https://www.woolworths.com.au/shop/browse/specials/half-price";

/** Result of `attempt()`, one browse/category API call, page and body/status included for logging/errors. */
interface EvaluatedResponse {
  status: number;
  body: unknown;
}

/**
 * The captured half-price browse request body (plan's Capture notes):
 * category id for the "Half Price" specials group, page `pageNumber` of
 * `pageSize` results, sorted by trader relevance, no extra filters.
 */
function buildWoolworthsRequestBody(pageNumber: number): Record<string, unknown> {
  return {
    categoryId: WOOLWORTHS_HALF_PRICE_CATEGORY_ID,
    pageNumber,
    pageSize: 24,
    sortType: "TraderRelevance",
    categoryVersion: "v2",
    filters: [],
  };
}

/**
 * Defensive upper bound on pages fetched, in case `totalRecordCount` is
 * missing or absurdly large. At `pageSize: 24` this comfortably covers the
 * spike-observed ~1624 records (~68 pages) without risking a true runaway
 * loop against a misbehaving/malicious response.
 */
const MAX_PAGES = 90;

/**
 * Fetches every page of the Woolworths half-price browse/category listing
 * via Browser Rendering, and returns the merged result as RawDeal[].
 *
 * Two-step session dance (a bare cross-origin fetch to the category API
 * 400s on missing params without ever establishing a session — proven by a
 * prior spike; navigating a real page first and then POSTing from inside
 * that page's context reaches 200 with real data):
 *   1. `page.goto` the human-facing half-price page, establishing a real
 *      Akamai session with browser-minted cookies.
 *   2. `page.evaluate` an in-page `fetch(..., { credentials: "include" })`
 *      against `profile.url` (the category API endpoint), which
 *      automatically carries the browser's own session cookies the same way
 *      a real user's browser would — no headers need to be supplied by the
 *      Worker.
 *
 * Pages through `pageNumber` (starting at 1), collecting `bundles` across
 * pages until the running product count reaches the first page's
 * `totalRecordCount`, or `MAX_PAGES` is hit, whichever comes first. Throws
 * the shared `SourceError` on a failed navigation, a non-2xx in-page fetch,
 * or an unparseable/malformed body — never a raw error.
 */
export async function fetchWoolworthsViaBrowser(
  page: PageLike,
  profile: StoreProfile,
): Promise<RawDeal[]> {
  const navigation = await page.goto(WOOLWORTHS_HALF_PRICE_PAGE_URL, {
    waitUntil: "domcontentloaded",
  });

  if (!navigation || navigation.status() < 200 || navigation.status() >= 300) {
    throw new SourceError(
      "woolworths",
      `navigation to the half-price page failed: ${
        navigation ? navigation.status() : "no response"
      }`,
    );
  }

  const bundles: unknown[] = [];
  let totalRecordCount: number | undefined;
  let collectedProductCount = 0;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const requestBody = buildWoolworthsRequestBody(pageNumber);

    const result = await page.evaluate<EvaluatedResponse>(
      async (...args: unknown[]) => {
        const [apiUrl, body] = args as [string, Record<string, unknown>];
        // This callback runs inside the browser page (Browser Rendering),
        // never inside the Worker, so `fetch` here is the DOM/browser fetch
        // (supports `credentials`), not the Workers-runtime `fetch` ambient
        // type this file otherwise sees (which has no `credentials` field).
        // Cast through a minimal local signature to type-check against the
        // right contract without depending on `lib.dom.d.ts` being present.
        type BrowserFetch = (
          input: string,
          init: {
            method: string;
            headers: Record<string, string>;
            body: string;
            credentials: string;
          },
        ) => Promise<{ status: number; json(): Promise<unknown> }>;
        const browserFetch = fetch as unknown as BrowserFetch;
        const res = await browserFetch(apiUrl, {
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
      },
      profile.url,
      requestBody,
    );

    if (result.status < 200 || result.status >= 300) {
      throw new SourceError(
        "woolworths",
        `category API request failed: ${result.status} (page ${pageNumber})`,
      );
    }

    if (result.body === undefined) {
      throw new SourceError(
        "woolworths",
        `category API returned a non-JSON body (page ${pageNumber}), likely a bot challenge or outage page`,
      );
    }

    let parsedPage: z.infer<typeof WoolworthsPayloadSchema>;
    try {
      parsedPage = WoolworthsPayloadSchema.parse(result.body);
    } catch (cause) {
      throw new SourceError(
        "woolworths",
        `category API returned a malformed payload (page ${pageNumber})`,
        { cause },
      );
    }

    if (pageNumber === 1) {
      totalRecordCount = parsedPage.totalRecordCount;
    }

    bundles.push(...parsedPage.bundles);
    collectedProductCount += parsedPage.bundles.reduce(
      (sum, bundle) => sum + bundle.products.length,
      0,
    );

    const reachedTotal = totalRecordCount !== undefined &&
      collectedProductCount >= totalRecordCount;
    // An empty page (no products at all) means there's nothing left to
    // page through, regardless of what totalRecordCount claims.
    const exhausted = parsedPage.bundles.every((bundle) => bundle.products.length === 0);

    if (reachedTotal || exhausted) break;
  }

  return parseWoolworthsPayload({ bundles, totalRecordCount });
}
