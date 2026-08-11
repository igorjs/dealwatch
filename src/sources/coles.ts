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
 * Schema verified against a real capture of
 * https://www.coles.com.au/on-special?filter_Special=halfprice taken
 * 2026-08-11 (see test/fixtures/coles.json). The half-price listing is
 * server-rendered into the page's __NEXT_DATA__ script tag at
 * `props.pageProps.searchResults`, not returned by a GraphQL call.
 */
const ColesResultEntrySchema = z.object({
  _type: z.string(),
  id: z.union([z.number(), z.string()]),
  name: z.string().optional(),
  brand: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  onlineHeirs: z.array(z.object({ category: z.string() })).default([]),
  pricing: z
    .object({
      now: z.number(),
      was: z.number().nullable().default(null),
    })
    .optional(),
});

const ColesPayloadSchema = z.object({
  props: z.object({
    pageProps: z.object({
      searchResults: z.object({
        noOfResults: z.number(),
        results: z.array(ColesResultEntrySchema),
      }),
    }),
  }),
});

/**
 * The strict shape a `_type === "PRODUCT"` entry must match. Applied only
 * after the permissive `ColesResultEntrySchema` above has already let
 * `SINGLE_TILE` and `CONTENT_ASSOCIATION` entries through untouched, so a
 * product missing `pricing` still throws.
 */
const ColesProductSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  brand: z.string().nullable().default(null),
  size: z.string().nullable().default(null),
  onlineHeirs: z.array(z.object({ category: z.string() })).default([]),
  pricing: z.object({
    now: z.number(),
    was: z.number().nullable().default(null),
  }),
});

/** Lowercases, replaces every run of non-alphanumeric characters with one hyphen, and trims. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds the real product URL: `kebab-case(brand + name + size) + "-" + id`.
 * Missing brand or size is dropped before joining, so it never leaves a
 * double hyphen or a leading hyphen (confirmed against two real products).
 */
function buildProductUrl(product: z.infer<typeof ColesProductSchema>): string {
  const slug = slugify([product.brand, product.name, product.size].filter(Boolean).join(" "));
  return `https://www.coles.com.au/product/${slug}-${product.id}`;
}

/**
 * Validates and maps a Coles __NEXT_DATA__ payload into RawDeal[]. Pure: no
 * I/O. `results[]` is mixed (PRODUCT, SINGLE_TILE, CONTENT_ASSOCIATION); only
 * PRODUCT entries become deals, and each is re-validated against the strict
 * `ColesProductSchema` so a malformed product still throws. Throws a Zod
 * error on a malformed product or a wholly invalid payload.
 * `discountPercent` is always null (normalize derives it from
 * priceCents/wasPriceCents, matching the other sources).
 */
export function parseColesPayload(json: unknown): RawDeal[] {
  const payload = ColesPayloadSchema.parse(json);

  return payload.props.pageProps.searchResults.results
    .filter((entry) => entry._type === "PRODUCT")
    .map((entry): RawDeal => {
      const product = ColesProductSchema.parse(entry);
      return {
        source: "coles",
        title: product.name,
        url: buildProductUrl(product),
        store: "Coles",
        department: product.onlineHeirs[0]?.category ?? null,
        priceCents: toCents(product.pricing.now),
        wasPriceCents: toCents(product.pricing.was),
        discountPercent: null,
      };
    });
}
