/**
 * Turns one source's fetchX(page) outcome into a SourceResult matching the
 * /ingest wire contract (src/types.ts). This is the only place a driver's
 * throw (a SourceError, or anything else) is caught and turned into data:
 * it never rethrows, so main() can run every source and still make exactly
 * one POST carrying all three outcomes, whether they succeeded or not.
 */
import type { Source, SourceResult } from "../../src/types.ts";
import type { PageLike } from "./browser.ts";
import { aldiProfile, woolworthsProfile } from "./config.ts";
import { fetchAldi } from "./drivers/aldi.ts";
import { fetchColes } from "./drivers/coles.ts";
import { fetchWoolworths } from "./drivers/woolworths.ts";

/** Dispatches to the one driver that knows how to fetch `source`. */
function runFetchX(source: Source, page: PageLike) {
  switch (source) {
    case "aldi":
      return fetchAldi(page, aldiProfile);
    case "woolworths":
      return fetchWoolworths(page, woolworthsProfile);
    case "coles":
      return fetchColes(page);
  }
}

/**
 * Runs `source`'s driver against `page` and converts the outcome into a
 * SourceResult: a success becomes `{ source, status: "fulfilled", deals }`,
 * a throw becomes `{ source, status: "rejected", reason }` built from the
 * error's own message, not its stack. Never rethrows.
 */
export async function fetchStore(source: Source, page: PageLike): Promise<SourceResult> {
  try {
    const deals = await runFetchX(source, page);
    return { source, status: "fulfilled", deals };
  } catch (error) {
    return {
      source,
      status: "rejected",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
