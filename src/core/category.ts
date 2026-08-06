import type { Source } from "../types";

/**
 * The shared grocery categories DealWatch groups deals by, independent of
 * any one store's own department taxonomy. `"other"` is the catch-all for
 * departments this mapping doesn't recognize.
 */
export const CATEGORIES = [
  "fruit-veg",
  "dairy-eggs",
  "meat-seafood",
  "pantry",
  "bakery",
  "frozen",
  "drinks",
  "snacks",
  "household",
  "health-beauty",
  "other",
] as const;

/** A category from the shared set every store's raw department maps onto. */
export type SharedCategory = (typeof CATEGORIES)[number];

/** A lowercased keyword tried against a raw department string (substring match) and its shared category. */
type KeywordEntry = readonly [keyword: string, category: SharedCategory];

/**
 * Per-source keyword tables, tried in order, first hit wins. Real department
 * strings vary by store (e.g. Woolworths "Meat & Seafood" vs. Coles "Meat,
 * Seafood & Deli"), so each source gets its own keyword list rather than one
 * shared list that has to cover every store's phrasing.
 */
const KEYWORD_TABLES: Record<Source, readonly KeywordEntry[]> = {
  woolworths: [
    ["fruit", "fruit-veg"],
    ["veg", "fruit-veg"],
    ["meat", "meat-seafood"],
    ["seafood", "meat-seafood"],
    ["deli", "meat-seafood"],
    ["dairy", "dairy-eggs"],
    ["eggs", "dairy-eggs"],
    ["fridge", "dairy-eggs"],
    ["bakery", "bakery"],
    ["bread", "bakery"],
    ["freezer", "frozen"],
    ["frozen", "frozen"],
    ["drinks", "drinks"],
    ["drink", "drinks"],
    ["snack", "snacks"],
    ["confectionery", "snacks"],
    ["health", "health-beauty"],
    ["beauty", "health-beauty"],
    ["household", "household"],
    ["pantry", "pantry"],
  ],
  coles: [
    ["fruit", "fruit-veg"],
    ["vegetable", "fruit-veg"],
    ["veg", "fruit-veg"],
    ["meat", "meat-seafood"],
    ["seafood", "meat-seafood"],
    ["deli", "meat-seafood"],
    ["dairy", "dairy-eggs"],
    ["eggs", "dairy-eggs"],
    ["fridge", "dairy-eggs"],
    ["bakery", "bakery"],
    ["bread", "bakery"],
    ["freezer", "frozen"],
    ["frozen", "frozen"],
    ["drinks", "drinks"],
    ["drink", "drinks"],
    ["snack", "snacks"],
    ["confectionery", "snacks"],
    ["health", "health-beauty"],
    ["beauty", "health-beauty"],
    ["household", "household"],
    ["pantry", "pantry"],
  ],
  aldi: [
    ["produce", "fruit-veg"],
    ["fruit", "fruit-veg"],
    ["veg", "fruit-veg"],
    ["meat", "meat-seafood"],
    ["seafood", "meat-seafood"],
    ["dairy", "dairy-eggs"],
    ["eggs", "dairy-eggs"],
    ["bakery", "bakery"],
    ["bread", "bakery"],
    ["frozen", "frozen"],
    ["drinks", "drinks"],
    ["drink", "drinks"],
    ["snack", "snacks"],
    ["confectionery", "snacks"],
    ["health", "health-beauty"],
    ["beauty", "health-beauty"],
    ["household", "household"],
    ["pet", "household"],
    ["pantry", "pantry"],
  ],
};

/**
 * Maps a store's raw department string onto the shared category set via a
 * case-insensitive keyword lookup for that source. Null, empty/blank, and
 * unrecognized departments map to `"other"`; this function never throws.
 */
export function toCategory(
  source: Source,
  department: string | null,
): SharedCategory {
  if (!department || department.trim() === "") {
    return "other";
  }
  const lowerDepartment = department.toLowerCase();
  const hit = KEYWORD_TABLES[source].find(([keyword]) =>
    lowerDepartment.includes(keyword)
  );
  return hit ? hit[1] : "other";
}
