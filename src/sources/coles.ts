import { z } from "zod";
import type { RawDeal } from "../types";
import { toCents } from "../core/price";

/**
 * This file holds only the pure Coles payload parser. Fetching now happens
 * outside the Worker, in the GitHub Actions Playwright job, which posts the
 * raw JSON to the Worker over `POST /ingest`; this parser is imported by
 * that job and by the Worker so both sides validate against one schema.
 */

/**
 * PLACEHOLDER SCHEMA, HIGH UNCERTAINTY, CARRIED OVER FROM V1 UNCHANGED. The
 * only Coles request ever captured is the `GetProductCategories` operation
 * (department tree), NOT the half-price product-listing operation actually
 * fired by `/on-special?filter_Special=halfprice` (plan Capture notes,
 * 2026-07-31; plan Assumption 15). A prior spike (this plan) confirmed the
 * half-price page itself renders through Browser Rendering without being
 * blocked, but did NOT capture or verify the GraphQL response body. This
 * schema is therefore still a best-effort guess, not a captured payload, and
 * is deliberately kept as v1 left it rather than re-guessed here — there is
 * no way to verify a "more correct" shape from this environment either.
 * Assumptions to revisit once the real product-listing request/response is
 * captured:
 *   - The listing operation returns `data.results.results[]` (a paged
 *     search-result envelope) alongside a `totalCount`, mirroring common
 *     Coles GraphQL product-search shapes.
 *   - Each product carries `pricing.now` / `pricing.was` as decimal dollar
 *     amounts (not cents), with `was` null when a product isn't discounted.
 *   - `seoToken` is a slug usable as `/product/<seoToken>`.
 *   - `onlineHeirs` is the category breadcrumb; its first entry's
 *     `category` is treated as the department. It may be empty.
 * Refine this schema and test/fixtures/coles.json together once a real
 * response body has been captured from the site's own GraphQL call (DevTools
 * Network tab on `/on-special?filter_Special=halfprice`).
 */
const ColesProductSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  brand: z.string().nullable().default(null),
  pricing: z.object({
    now: z.number(),
    was: z.number().nullable().default(null),
  }),
  seoToken: z.string(),
  onlineHeirs: z.array(z.object({ category: z.string() })).default([]),
});

const ColesPayloadSchema = z.object({
  data: z.object({
    results: z.object({
      results: z.array(ColesProductSchema),
      totalCount: z.number().optional(),
    }),
  }),
});

/**
 * Validates and maps a Coles product-search response into RawDeal[]. Pure:
 * no I/O. Throws a Zod error on a malformed entry or a wholly invalid
 * payload. `discountPercent` is always null (normalize derives it from
 * priceCents/wasPriceCents, matching the other sources).
 */
export function parseColesPayload(json: unknown): RawDeal[] {
  const payload = ColesPayloadSchema.parse(json);

  return payload.data.results.results.map((product): RawDeal => ({
    source: "coles",
    title: product.name,
    url: `https://www.coles.com.au/product/${product.seoToken}`,
    store: "Coles",
    department: product.onlineHeirs[0]?.category ?? null,
    priceCents: toCents(product.pricing.now),
    wasPriceCents: toCents(product.pricing.was),
    discountPercent: null,
  }));
}
