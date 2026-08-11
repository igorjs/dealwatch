import { z } from "zod";
import type { RawDeal } from "../types";
import { toCents } from "../core/price";

/**
 * This file holds only the pure Aldi payload parser. Fetching now happens
 * outside the Worker, in the GitHub Actions Playwright job, which posts the
 * raw JSON to the Worker over `POST /ingest`; this parser is imported by
 * that job and by the Worker so both sides validate against one schema.
 */

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
