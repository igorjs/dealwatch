import { type Deal, type ListItem, ListItemSchema } from "./types";

/** The production R2 key the shopping list is stored under. */
export const LIST_KEY = "shopping-list.json";

/**
 * Thrown when the shopping-list object at `key` exists but its contents are
 * not valid JSON (or don't match the expected shape). Distinct from "object
 * absent" so a corrupt object never silently resets to an empty list (no
 * silent data loss).
 */
export class CorruptListFileError extends Error {
  override name = "CorruptListFileError";

  constructor(key: string, cause: unknown) {
    super(`Shopping list object "${key}" is not valid JSON`, { cause });
  }
}

/** On-object shape: `ListItem`s keyed by `Deal.id`, for idempotent upsert. */
type ListStore = Record<string, ListItem>;

/**
 * Reads the store at `key`. Returns `{}` when the object is absent. Throws
 * `CorruptListFileError` when the object exists but its body isn't valid
 * JSON matching the expected shape.
 */
async function readStore(bucket: R2Bucket, key: string): Promise<ListStore> {
  const object = await bucket.get(key);
  if (object === null) {
    return {};
  }

  let raw: string;
  try {
    raw = await object.text();
    return JSON.parse(raw) as ListStore;
  } catch (cause) {
    throw new CorruptListFileError(key, cause);
  }
}

/**
 * Builds the `ListItem` for `deal`. `status` and `addedAt` come from
 * `existing` when it's an update, so a re-upsert never resets a "bought"
 * item back to "pending" or bumps its original `addedAt`. A brand-new item
 * defaults to `status: "pending"` and `addedAt` from `deal.seenAt` (not
 * `Date.now()`), keeping the write deterministic.
 */
function toListItem(deal: Deal, existing: ListItem | undefined): ListItem {
  return ListItemSchema.parse({
    id: deal.id,
    title: deal.title,
    store: deal.store,
    url: deal.url,
    category: deal.category,
    priceCents: deal.priceCents,
    status: existing?.status ?? "pending",
    addedAt: existing?.addedAt ?? deal.seenAt,
  });
}

/**
 * Upserts `deals` into the shopping-list JSON object at `key` (defaults to
 * the production `LIST_KEY`), keyed by `Deal.id`. Creates the object if
 * absent. Upserting the same id again updates the stored item in place
 * (title/store/url/category/priceCents refresh; status/addedAt preserved)
 * rather than duplicating it. `bucket.put` is atomic on its own, so no
 * temp-object/rename dance is needed. An object that exists but isn't valid
 * JSON throws `CorruptListFileError` instead of being silently treated as
 * empty.
 */
export async function upsertList(
  bucket: R2Bucket,
  deals: Deal[],
  key: string = LIST_KEY,
): Promise<void> {
  const store = await readStore(bucket, key);

  for (const deal of deals) {
    store[deal.id] = toListItem(deal, store[deal.id]);
  }

  await bucket.put(key, JSON.stringify(store, null, 2));
}

/** Groups list items by category, e.g. for rendering the shopping list. */
export function groupByCategory(
  items: ListItem[],
): Record<string, ListItem[]> {
  const grouped: Record<string, ListItem[]> = {};
  for (const item of items) {
    (grouped[item.category] ??= []).push(item);
  }
  return grouped;
}

/**
 * Reads the current shopping list at `key` (defaults to the production
 * `LIST_KEY`), grouped by category. Returns an empty grouping when the
 * object is absent. Throws `CorruptListFileError` when the object exists
 * but its body isn't valid JSON matching the expected shape.
 */
export async function readList(
  bucket: R2Bucket,
  key: string = LIST_KEY,
): Promise<Record<string, ListItem[]>> {
  const store = await readStore(bucket, key);
  return groupByCategory(Object.values(store));
}
