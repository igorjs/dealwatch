import { z } from "zod";
import { SourceError } from "./errors.ts";
import type { RawDeal, StoreProfile } from "../types.ts";
import { toCents } from "../core/price.ts";

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
 * The captured half-price browse request body (plan's Capture notes):
 * category id for the "Half Price" specials group, page 1 of 24 results,
 * sorted by trader relevance, no extra filters.
 */
function buildWoolworthsRequestBody(): Record<string, unknown> {
  return {
    categoryId: WOOLWORTHS_HALF_PRICE_CATEGORY_ID,
    pageNumber: 1,
    pageSize: 24,
    sortType: "TraderRelevance",
    categoryVersion: "v2",
    filters: [],
  };
}

/**
 * Posts the captured half-price browse request against `profile.url` with
 * `profile.headers` (auth token + Akamai bot cookies per the Capture notes),
 * checks for a non-2xx response and a JSON body, and maps the result via
 * parseWoolworthsPayload. Throws the shared SourceError on a non-2xx
 * response (403/429/503) or a body that isn't valid JSON (a bot-challenge
 * or outage HTML page), so callers get a typed, distinguishable failure
 * instead of a raw fetch/SyntaxError. `fetchFn` is injected (defaults to the
 * global `fetch`) so tests never hit the network.
 */
export async function fetchWoolworths(
  profile: StoreProfile,
  fetchFn: typeof fetch = fetch,
): Promise<RawDeal[]> {
  const response = await fetchFn(profile.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...profile.headers,
    },
    body: JSON.stringify(buildWoolworthsRequestBody()),
  });

  if (!response.ok) {
    throw new SourceError(
      "woolworths",
      `request failed: ${response.status} ${response.statusText}`.trim(),
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (cause) {
    throw new SourceError(
      "woolworths",
      "returned a non-JSON body (likely a bot challenge or outage page)",
      { cause },
    );
  }

  return parseWoolworthsPayload(json);
}
