import { type Deal, type ListItem, ListItemSchema } from "../types.ts";

/**
 * Thrown when the shopping-list file at `path` exists but its contents are
 * not valid JSON. Distinct from "file absent" so a corrupt file never
 * silently resets to an empty list (no silent data loss).
 */
export class CorruptListFileError extends Error {
  override name = "CorruptListFileError";

  constructor(path: string, cause: unknown) {
    super(`Shopping list file at "${path}" is not valid JSON`, { cause });
  }
}

/** On-disk shape: `ListItem`s keyed by `Deal.id`, for idempotent upsert. */
type ListStore = Record<string, ListItem>;

/** Directory portion of a (Unix-style) path; "." when `path` has no slash. */
function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

/** Reads the store at `path`. Returns `{}` when the file is absent. */
function readStore(path: string): ListStore {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      return {};
    }
    throw cause;
  }

  try {
    return JSON.parse(raw) as ListStore;
  } catch (cause) {
    throw new CorruptListFileError(path, cause);
  }
}

/**
 * Writes `store` atomically: serializes to a temp file in the same
 * directory as `path`, then renames over `path`. A rename within one
 * directory is atomic, so a crash mid-write never leaves a truncated or
 * partially-written `path` behind.
 */
function writeStore(path: string, store: ListStore): void {
  const tmpPath = `${dirnameOf(path)}/.${crypto.randomUUID()}.tmp`;
  Deno.writeTextFileSync(tmpPath, JSON.stringify(store, null, 2));
  Deno.renameSync(tmpPath, path);
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
 * Upserts `deals` into the shopping-list JSON file at `path`, keyed by
 * `Deal.id`. Creates the file if absent. Upserting the same id again updates
 * the stored item in place (title/store/url/category/priceCents refresh;
 * status/addedAt preserved) rather than duplicating it. The write is atomic
 * (temp file + rename). A file that exists but isn't valid JSON throws
 * `CorruptListFileError` instead of being silently treated as empty.
 */
export function upsert(deals: Deal[], path: string): void {
  const store = readStore(path);

  for (const deal of deals) {
    store[deal.id] = toListItem(deal, store[deal.id]);
  }

  writeStore(path, store);
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
