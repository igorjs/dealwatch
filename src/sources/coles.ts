import { z } from "zod";
import type { RawDeal, StoreProfile } from "../types.ts";
import { SourceError } from "./errors.ts";

/**
 * PLACEHOLDER SCHEMA, HIGH UNCERTAINTY. Unlike Woolworths and Aldi, the only
 * Coles request captured so far is the `GetProductCategories` operation
 * (department tree), NOT the half-price product-listing operation behind
 * `/on-special?filter_Special=halfprice` (plan Capture notes, 2026-07-31).
 * The transport is verified (GraphQL POST to
 * `https://www.coles.com.au/api/graphql`, `ocp-apim-subscription-key` +
 * session-cookie auth via profile.headers) but this response shape is a
 * best-effort guess, not a captured payload. Assumptions to revisit once
 * the real product-listing request/response is captured:
 *   - The listing operation returns `data.results.results[]` (a paged
 *     search-result envelope) alongside a `totalCount`, mirroring common
 *     Coles GraphQL product-search shapes.
 *   - Each product carries `pricing.now` / `pricing.was` as decimal dollar
 *     amounts (not cents), with `was` null when a product isn't discounted.
 *   - `seoToken` is a slug usable as `/product/<seoToken>`.
 *   - `onlineHeirs` is the category breadcrumb; its first entry's
 *     `category` is treated as the department. It may be empty.
 * Refine this schema and test/fixtures/coles.json together once a real
 * capture exists (see scripts/STORE-CAPTURE.md).
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
    priceCents: Math.round(product.pricing.now * 100),
    wasPriceCents: product.pricing.was === null
      ? null
      : Math.round(product.pricing.was * 100),
    discountPercent: null,
  }));
}

/**
 * PLACEHOLDER request body, HIGH UNCERTAINTY. `operationName`/`query` are
 * not the real captured half-price product-listing operation (only
 * `GetProductCategories` has been captured) — replace this wholesale once
 * that request is captured (see scripts/STORE-CAPTURE.md). Only the
 * transport (POST, JSON body, `profile.headers` auth) is verified.
 */
function buildColesRequestBody(): unknown {
  return {
    operationName: "SearchProducts",
    // PLACEHOLDER query string: fill in the real half-price product-listing
    // query captured from `/on-special?filter_Special=halfprice`.
    query:
      `query SearchProducts($filters: ProductSearchFilters) { results: search(filters: $filters) { results { id name brand pricing { now was } seoToken onlineHeirs { category } } totalCount } }`,
    variables: {
      filters: { specials: "halfprice" },
    },
  };
}

/**
 * Fetches Coles' GraphQL product-search endpoint using the captured request
 * profile (URL + auth headers) and parses the response. Throws SourceError
 * on a non-2xx response (e.g. 403/429 from an expired session) or a body
 * that isn't valid JSON (e.g. a bot-challenge/outage HTML page). `fetchFn`
 * is injected (defaults to the global `fetch`) so tests never hit the
 * network.
 */
export async function fetchColes(
  profile: StoreProfile,
  fetchFn: typeof fetch = fetch,
): Promise<RawDeal[]> {
  const response = await fetchFn(profile.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...profile.headers },
    body: JSON.stringify(buildColesRequestBody()),
  });

  if (!response.ok) {
    throw new SourceError(
      "coles",
      `Coles product-search request failed: ${response.status} ${response.statusText}`
        .trim(),
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (cause) {
    throw new SourceError(
      "coles",
      "Coles product-search returned a non-JSON body (likely a bot challenge or expired session)",
      { cause },
    );
  }

  return parseColesPayload(json);
}
