import { z } from "zod";

/** The supermarkets DealWatch fetches deals from. */
export const SourceSchema = z.enum(["coles", "woolworths", "aldi"]);
export type Source = z.infer<typeof SourceSchema>;

/**
 * A deal exactly as a source fetcher emits it, before normalization.
 * `department` is the store's own raw category label — core/category.ts
 * later maps it onto the shared category set used by Deal.
 */
export const RawDealSchema = z.object({
  source: SourceSchema,
  title: z.string(),
  url: z.url(),
  store: z.string(),
  department: z.string().nullable(),
  priceCents: z.int().nullable(),
  wasPriceCents: z.int().nullable(),
  discountPercent: z.number().nullable(),
});
export type RawDeal = z.infer<typeof RawDealSchema>;

/** A deal after normalization: stable id assigned, category mapped to the shared set. */
export const DealSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  store: z.string(),
  title: z.string(),
  url: z.url(),
  category: z.string(),
  priceCents: z.int().nullable(),
  wasPriceCents: z.int().nullable(),
  discountPercent: z.number().nullable(),
  seenAt: z.iso.datetime(),
});
export type Deal = z.infer<typeof DealSchema>;

/**
 * A watchlist entry. `term` is rejected here when empty (rather than in
 * core/match.ts) so every downstream consumer of Config can assume it's non-empty.
 */
export const WatchSchema = z.object({
  term: z.string().min(1),
  minDiscountPercent: z.number().min(0).max(100),
  exclude: z.array(z.string()).default([]),
});
export type Watch = z.infer<typeof WatchSchema>;

/**
 * A store profile for a store fetched via Browser Rendering. Browser
 * Rendering mints its own session per run, so there's no captured header
 * map here — just the URL to navigate/fetch in-page.
 */
export const StoreProfileSchema = z.object({
  url: z.string(),
});
export type StoreProfile = z.infer<typeof StoreProfileSchema>;

/**
 * Aldi is fetched via its product-search service rather than a scraped page,
 * so its profile carries a service endpoint + category keys instead of url.
 */
export const AldiStoreProfileSchema = z.object({
  servicePoint: z.string(),
  categoryKeys: z.array(z.string()).min(1),
});
export type AldiStoreProfile = z.infer<typeof AldiStoreProfileSchema>;

/**
 * The app config. `watchlist` must be non-empty so consumers never handle a
 * no-op watch run. `ntfy` is a direct top-level field (not nested under a
 * `sinks` object) since R2 is the only other sink and needs no config here.
 */
export const ConfigSchema = z.object({
  watchlist: z.array(WatchSchema).min(1),
  ntfy: z.object({
    topicUrl: z.string(),
  }),
  stores: z.object({
    aldi: AldiStoreProfileSchema,
    coles: StoreProfileSchema,
    woolworths: StoreProfileSchema,
  }),
});
export type Config = z.infer<typeof ConfigSchema>;

/** An entry persisted to shopping-list.json. */
export const ListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  store: z.string(),
  url: z.url(),
  category: z.string(),
  priceCents: z.int().nullable(),
  status: z.enum(["pending", "bought"]),
  addedAt: z.iso.datetime(),
});
export type ListItem = z.infer<typeof ListItemSchema>;
