import {
  AldiStoreProfileSchema,
  type Config,
  ConfigSchema,
  StoreProfileSchema,
  type Watch,
  WatchSchema,
} from "./types";

/**
 * The watchlist DealWatch matches deals against. This is a placeholder —
 * edit these entries to your own grocery preferences before deploying.
 */
export const watchlist: Watch[] = [
  { term: "chicken breast", minDiscountPercent: 50, exclude: [] },
  { term: "beef mince", minDiscountPercent: 40, exclude: [] },
  { term: "salmon", minDiscountPercent: 30, exclude: ["smoked"] },
].map((watch) => WatchSchema.parse(watch));

/**
 * Store profiles for the three sources. These are non-secret, public page
 * and API URLs — Browser Rendering mints its own session per run, so unlike
 * v1 there's no captured header/cookie map to bundle here.
 */
export const storeProfiles = {
  aldi: AldiStoreProfileSchema.parse({
    // Placeholder store code — replace with your local Aldi store's
    // servicePoint before deploying. See scripts/STORE-CAPTURE.md.
    servicePoint: "G452",
    categoryKeys: [
      "1588161426952145", // Super Savers
      "1588161420755352", // Limited Time Only
    ],
  }),
  coles: StoreProfileSchema.parse({
    url: "https://www.coles.com.au/on-special?filter_Special=halfprice",
  }),
  woolworths: StoreProfileSchema.parse({
    url: "https://www.woolworths.com.au/apis/ui/browse/category",
  }),
};

/**
 * Assembles the final, validated Config from the bundled watchlist and store
 * profiles plus the one secret that belongs to this domain: the ntfy topic
 * URL. `API_TOKEN` is deliberately not read here — it authenticates the HTTP
 * trigger itself, not the pipeline's config, so it stays in the HTTP handler.
 */
export function buildConfig(env: Pick<Env, "NTFY_TOPIC_URL">): Config {
  return ConfigSchema.parse({
    watchlist,
    ntfy: { topicUrl: env.NTFY_TOPIC_URL },
    stores: storeProfiles,
  });
}
