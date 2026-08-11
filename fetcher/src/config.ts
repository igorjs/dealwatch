import {
  AldiStoreProfileSchema,
  type AldiStoreProfile,
  StoreProfileSchema,
  type StoreProfile,
} from "../../src/types.ts";

/**
 * The Aldi store profile the fetcher's driver needs to build the
 * product-search URL: a service point and the two specials category keys
 * (Super Savers, Limited Time Only). Mirrors the values in the Worker's own
 * `src/config.ts` so both sides describe the same store; kept as a separate
 * small object here rather than shared, since the fetcher has no reason to
 * depend on the Worker's watchlist or the other stores' profiles.
 */
export const aldiProfile: AldiStoreProfile = AldiStoreProfileSchema.parse({
  // Placeholder store code, same as src/config.ts's servicePoint. Replace
  // with the operator's real Aldi store's servicePoint before relying on
  // results (find it in the Aldi site's own product-search requests via
  // DevTools).
  servicePoint: "G452",
  categoryKeys: [
    "1588161426952145", // Super Savers
    "1588161420755352", // Limited Time Only
  ],
});

/**
 * The Woolworths store profile the fetcher's driver needs: the category API
 * endpoint the driver POSTs against in-page, after first warming the
 * half-price page's Akamai session (see `fetcher/src/drivers/woolworths.ts`).
 * Mirrors the value in the Worker's own `src/config.ts` so both sides
 * describe the same store.
 */
export const woolworthsProfile: StoreProfile = StoreProfileSchema.parse({
  url: "https://www.woolworths.com.au/apis/ui/browse/category",
});
