import { type Deal, DealSchema, type RawDeal } from "../types.ts";
import { stableId } from "./id.ts";
import { toCategory } from "./category.ts";
import { computeDiscountPercent } from "./price.ts";

/**
 * Builds a Deal from a source's RawDeal: assigns a stable id, maps the raw
 * department onto the shared category set, derives `discountPercent` when
 * the source didn't provide one, and stamps `seenAt` from the injected
 * clock. The result is parsed against `DealSchema` before returning so a
 * malformed RawDeal can never produce an invalid Deal.
 */
export function normalize(raw: RawDeal, now: Date): Deal {
  const discountPercent = raw.discountPercent ??
    computeDiscountPercent(raw.priceCents, raw.wasPriceCents);

  return DealSchema.parse({
    id: stableId(raw.source, raw.url),
    source: raw.source,
    store: raw.store,
    title: raw.title,
    url: raw.url,
    category: toCategory(raw.source, raw.department),
    priceCents: raw.priceCents,
    wasPriceCents: raw.wasPriceCents,
    discountPercent,
    seenAt: now.toISOString(),
  });
}
