import { z } from "zod";
import type { AldiStoreProfile, RawDeal } from "../types.ts";
import { toCents } from "../core/price.ts";

/**
 * Thrown by fetchAldi on a non-2xx response or a body that isn't valid JSON
 * (e.g. a bot-challenge or outage HTML page), so callers get a typed,
 * distinguishable failure instead of a raw fetch/SyntaxError.
 */
export class AldiSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AldiSourceError";
  }
}

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

function buildAldiRequestUrl(
  categoryKey: string,
  servicePoint: string,
): string {
  return `${ALDI_PRODUCT_SEARCH_URL}?currency=AUD&serviceType=walk-in` +
    `&categoryKey=${encodeURIComponent(categoryKey)}&limit=30&offset=0` +
    `&sort=relevance&servicePoint=${encodeURIComponent(servicePoint)}`;
}

/**
 * Fetches Aldi's public, unauthenticated product-search endpoint once per
 * configured `categoryKey` and merges the results, de-duplicating by
 * RawDeal.url so a product present under more than one category (e.g. both
 * specials categories) isn't emitted twice. No captured auth profile or
 * cookies needed, unlike Coles/Woolworths (plan's Aldi capture notes).
 *
 * Throws AldiSourceError on a non-2xx response or a body that isn't valid
 * JSON (e.g. a bot-challenge/outage HTML page). `fetchFn` is injected
 * (defaults to the global `fetch`) so tests never hit the network.
 */
export async function fetchAldi(
  profile: AldiStoreProfile,
  fetchFn: typeof fetch = fetch,
): Promise<RawDeal[]> {
  const merged = new Map<string, RawDeal>();

  for (const categoryKey of profile.categoryKeys) {
    const url = buildAldiRequestUrl(categoryKey, profile.servicePoint);
    const response = await fetchFn(url);

    if (!response.ok) {
      throw new AldiSourceError(
        `Aldi product-search request failed: ${response.status} ${response.statusText}`
          .trim(),
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new AldiSourceError(
        "Aldi product-search returned a non-JSON body (likely a bot challenge or outage page)",
        { cause },
      );
    }

    for (const deal of parseAldiPayload(json)) {
      merged.set(deal.url, deal);
    }
  }

  return [...merged.values()];
}
