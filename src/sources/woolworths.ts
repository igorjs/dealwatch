import { z } from "zod";
import type { RawDeal } from "../types";
import { toCents } from "../core/price";

/**
 * This file holds only the pure Woolworths payload parser. Fetching now
 * happens outside the Worker, in the GitHub Actions Playwright job, which
 * posts the raw JSON to the Worker over `POST /ingest`; this parser is
 * imported by that job and by the Worker so both sides validate against one
 * schema.
 */

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
