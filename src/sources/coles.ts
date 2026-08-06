import { z } from "zod";
import type { PageLike } from "../browser";
import type { RawDeal } from "../types";
import { SourceError } from "./errors";
import { toCents } from "../core/price";

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

/** Response-interception tuning for fetchColesViaBrowser. */
const GRAPHQL_URL_SUBSTRING = "/api/graphql";
const MAX_RESPONSE_ATTEMPTS = 5;
const NAVIGATION_TIMEOUT_MS = 30_000;
const RESPONSE_TIMEOUT_MS = 15_000;

/**
 * Fetches Coles' half-price listing by navigating to the on-special page
 * through Browser Rendering and intercepting the GraphQL response that
 * carries the product list, rather than driving a direct fetch (Coles sits
 * behind Incapsula, which a bare `fetch` cannot pass — a prior spike this
 * plan confirmed the page itself renders fine through Browser Rendering).
 *
 * Ambiguity this has to handle: Coles' page load fires MULTIPLE requests to
 * `/api/graphql` (at minimum `GetProductCategories`, likely also the actual
 * product-listing query, and possibly others). `PageLike.waitForResponse`'s
 * predicate only sees the response's `url()` — every graphql call shares the
 * same URL, and the narrowed `PageLike` type has no access to the
 * *request*'s body/operationName to disambiguate up front (see
 * src/browser.ts). So this cannot cleanly pick the right call by URL alone.
 *
 * Strategy: register the URL-substring predicate, then loop
 * `waitForResponse` up to MAX_RESPONSE_ATTEMPTS times. Each time a graphql
 * response arrives, parse its JSON body and structurally test it against
 * `ColesPayloadSchema` (i.e. does it look like a product-listing response,
 * not e.g. a category-tree response) — if it matches, use it; if not, go
 * back and wait for the next graphql call. This treats "does the payload
 * have the shape we need" as the disambiguator, since URL/predicate-level
 * filtering can't do it. If no response matches within the attempt cap, or
 * `waitForResponse` itself times out, this throws SourceError.
 *
 * NOTE ON SCHEMA UNCERTAINTY: even when this finds *a* response that
 * structurally matches ColesPayloadSchema, that schema is itself an
 * unverified guess (see the doc comment above ColesProductSchema) — this
 * fetcher cannot promise the matched response is semantically the
 * half-price listing, only that its shape happens to satisfy the guessed
 * schema. Confirming that requires a real capture.
 */
export async function fetchColesViaBrowser(page: PageLike): Promise<RawDeal[]> {
  let lastParseError: unknown;

  for (let attempt = 0; attempt < MAX_RESPONSE_ATTEMPTS; attempt++) {
    // Re-armed each attempt: waitForResponse resolves once per call, so
    // catching the *next* graphql response after a non-matching one means
    // calling it again rather than reusing a single promise.
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(GRAPHQL_URL_SUBSTRING),
      { timeout: RESPONSE_TIMEOUT_MS },
    );

    // Only navigate on the first attempt — later attempts are just waiting
    // for additional responses from the same page load.
    if (attempt === 0) {
      try {
        await page.goto("https://www.coles.com.au/on-special?filter_Special=halfprice", {
          timeout: NAVIGATION_TIMEOUT_MS,
          waitUntil: "networkidle0",
        });
      } catch (cause) {
        throw new SourceError(
          "coles",
          "Coles on-special page navigation failed",
          { cause },
        );
      }
    }

    let response: { url(): string; json(): Promise<unknown> };
    try {
      response = await responsePromise;
    } catch (cause) {
      throw new SourceError(
        "coles",
        `Coles graphql response not observed within ${RESPONSE_TIMEOUT_MS}ms ` +
          `(attempt ${attempt + 1}/${MAX_RESPONSE_ATTEMPTS})`,
        { cause },
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new SourceError(
        "coles",
        "Coles graphql response returned a non-JSON body (likely a bot challenge or expired session)",
        { cause },
      );
    }

    const parsed = ColesPayloadSchema.safeParse(json);
    if (parsed.success) {
      return parseColesPayload(json);
    }

    // Didn't look like the product-listing response (e.g. this was
    // GetProductCategories or another graphql call) — remember why, and
    // loop to wait for the next graphql response.
    lastParseError = parsed.error;
  }

  throw new SourceError(
    "coles",
    `No graphql response matched the expected product-listing shape within ` +
      `${MAX_RESPONSE_ATTEMPTS} attempts`,
    { cause: lastParseError },
  );
}
