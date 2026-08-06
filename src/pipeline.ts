import type { BrowserSession, PageLike } from "./browser";
import { withSourcesSerial } from "./browser";
import { normalize } from "./core/normalize";
import { match } from "./core/match";
import { LIST_KEY, upsertList } from "./listStore";
import { push } from "./push";
import {
  filterNew,
  getHealth,
  recordAttempt,
  recordSeen,
  type SourceHealth,
} from "./store";
import { fetchAldiViaBrowser } from "./sources/aldi";
import { fetchColesViaBrowser } from "./sources/coles";
import { fetchWoolworthsViaBrowser } from "./sources/woolworths";
import type { Config, Deal, RawDeal, Source } from "./types";

/** Every source the pipeline fetches, in the (serial) order they run. */
const SOURCES = ["aldi", "woolworths", "coles"] as const satisfies readonly Source[];

const DEFAULT_FAILURE_THRESHOLD = 3;

/** One fetcher per source, each already bound to `(page, config) => RawDeal[]`. */
export type SourceFetchers = Record<
  Source,
  (page: PageLike, config: Config) => Promise<RawDeal[]>
>;

/**
 * The real per-source fetchers, wired to the config profile each one needs.
 * Coles takes no profile — its on-special URL is hardcoded inside the
 * fetcher itself (see `src/sources/coles.ts`). Exported so tests can swap in
 * fakes for one or more sources (via `PipelineDeps.fetchers`) without having
 * to fake a real store's response shape through a fake `PageLike`.
 */
export const REAL_FETCHERS: SourceFetchers = {
  aldi: (page, config) => fetchAldiViaBrowser(page, config.stores.aldi),
  woolworths: (page, config) => fetchWoolworthsViaBrowser(page, config.stores.woolworths),
  coles: (page) => fetchColesViaBrowser(page),
};

export type PipelineDeps = {
  now: Date;
  config: Config;
  db: D1Database;
  bucket: R2Bucket;
  browser: BrowserSession;
  /** Defaults to the real `push()` (posts to ntfy over `fetch`). */
  pushFn?: (message: string, topicUrl: string) => Promise<void>;
  /** Consecutive failures before a source triggers a failure-alert push. Defaults to 3. */
  failureThreshold?: number;
  /** Defaults to `REAL_FETCHERS`. Tests swap in fakes per source. */
  fetchers?: SourceFetchers;
  /** The R2 object key the shopping list is upserted to. Defaults to `LIST_KEY`; tests use a unique key per file-shared bucket. */
  listKey?: string;
};

/**
 * A compact record of what one `runPipeline` pass did, for logging/tests —
 * not an error channel. Unlike v1's summary, there is no `due` field: v2 has
 * no due-source scheduling (every source runs every invocation, since the
 * Cron Trigger itself is the schedule now), so there is nothing to report.
 */
export type PipelineSummary = {
  fetched: number;
  matched: number;
  sourceFailures: Source[];
};

/**
 * Formats the failure-alert push text for a source that just hit
 * `failureThreshold` consecutive failures. v2 sources are all fetched via
 * Browser Rendering with a freshly minted session per run (no captured
 * headers/cookies to expire), so unlike v1 this never points at a
 * re-capture doc — it names the plausible v2-era causes instead, without
 * claiming to know which one applies.
 */
function formatFailureAlert(source: Source, consecutiveFailures: number): string {
  return `dealwatch: source "${source}" failed ${consecutiveFailures} times in a row — ` +
    `possible causes: the store's anti-bot protection is now blocking Browser ` +
    `Rendering, a Browser Rendering outage, or the store changed its page/API shape`;
}

/** Best-effort push: logs and swallows a failure instead of letting it escape `runPipeline`. */
async function safePush(
  pushFn: (message: string, topicUrl: string) => Promise<void>,
  message: string,
  topicUrl: string,
): Promise<void> {
  try {
    await pushFn(message, topicUrl);
  } catch (error) {
    console.error(`dealwatch: push failed for message "${message}":`, error);
  }
}

/**
 * Runs one pipeline pass: fetches every configured source serially via
 * `withSourcesSerial` (a broken/slow source never blocks or stops the
 * others — see `src/browser.ts`), normalizes and dedupes the results,
 * matches against the watchlist, and delivers new matches to both the
 * shopping list (R2) and a push alert (isolated from each other under
 * `allSettled`). Never rethrows a source-fetch, normalize, R2-write, or
 * push failure — those are logged and folded into the returned summary
 * instead, so one bad tick never crashes the whole run.
 */
export async function runPipeline(deps: PipelineDeps): Promise<PipelineSummary> {
  const { now, config, db, bucket, browser } = deps;
  const pushFn = deps.pushFn ?? push;
  const failureThreshold = deps.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const fetchers = deps.fetchers ?? REAL_FETCHERS;
  const listKey = deps.listKey ?? LIST_KEY;
  const topicUrl = config.ntfy.topicUrl;

  const runStart = performance.now();

  // Prior failure counts, read once up front, so a fetch failure below can
  // tell whether it just pushed the source's streak to the alert threshold.
  const health = await getHealth(db);
  const priorFailures = new Map<Source, number>(
    health.map((entry: SourceHealth) => [entry.source, entry.consecutiveFailures]),
  );

  // 1. Fetch every source, strictly one at a time (Browser Rendering has no
  // concurrent-page budget worth spending here — see withSourcesSerial's own
  // docs). A rejection is isolated to that source and never stops the others.
  const results = await withSourcesSerial(
    SOURCES,
    async (source, page) => {
      const sourceStart = performance.now();
      try {
        return await fetchers[source](page, config);
      } finally {
        const elapsedMs = Math.round(performance.now() - sourceStart);
        console.log(`dealwatch: source "${source}" fetched in ${elapsedMs}ms`);
      }
    },
    browser,
  );

  const rawDeals: RawDeal[] = [];
  const sourceFailures: Source[] = [];
  const failureAlerts: Promise<void>[] = [];

  for (const result of results) {
    const { source } = result;
    await recordAttempt(db, source, now, result.status === "fulfilled");

    if (result.status === "fulfilled") {
      rawDeals.push(...result.value);
      continue;
    }

    console.error(`dealwatch: source "${source}" fetch failed:`, result.reason);
    sourceFailures.push(source);

    const consecutiveFailures = (priorFailures.get(source) ?? 0) + 1;
    if (consecutiveFailures >= failureThreshold) {
      failureAlerts.push(
        safePush(pushFn, formatFailureAlert(source, consecutiveFailures), topicUrl),
      );
    }
  }
  await Promise.allSettled(failureAlerts);

  // 2. Normalize every collected RawDeal, isolated per deal: `normalize` can
  // throw on a single malformed RawDeal (an unparsable url, a store schema
  // drift), and one bad deal shouldn't drop every other deal collected this
  // pass. Log and drop just that deal instead.
  const deals: Deal[] = [];
  for (const raw of rawDeals) {
    try {
      deals.push(normalize(raw, now));
    } catch (error) {
      console.error(
        `dealwatch: failed to normalize deal from source "${raw.source}" (${raw.url}):`,
        error,
      );
    }
  }

  // 3. Drop deals already recorded as seen, then keep only deals matching
  // the watchlist.
  const newDeals = await filterNew(db, deals);
  const matched = newDeals.filter((deal) => match(deal, config.watchlist));

  // 4. Deliver matches to both sinks, isolated so one sink failing never
  // blocks or fails the other.
  if (matched.length > 0) {
    const titles = matched.map((deal) => deal.title).join(", ");
    const [saveListResult, pushResult] = await Promise.allSettled([
      upsertList(bucket, matched, listKey),
      pushFn(`dealwatch: ${matched.length} new matching deal(s): ${titles}`, topicUrl),
    ]);

    if (saveListResult.status === "rejected") {
      console.error("dealwatch: shopping list R2 write failed:", saveListResult.reason);
    }
    if (pushResult.status === "rejected") {
      console.error("dealwatch: push sink failed:", pushResult.reason);
    }

    // Record matched deals as seen only once the shopping list (the durable
    // source of truth) confirms it saved them; the ntfy push is a transient
    // alert. If the R2 write failed (corrupt shopping-list.json, an R2
    // outage), skip recordSeen so these deals aren't dropped forever by
    // filterNew — they retry, and re-alert, next run instead. A duplicate
    // ntfy ping on retry is an acceptable cost for avoiding silent data loss.
    if (saveListResult.status === "fulfilled") {
      await recordSeen(db, matched);
    }
  }

  const totalElapsedMs = Math.round(performance.now() - runStart);
  console.log(
    `dealwatch: run complete in ${totalElapsedMs}ms — fetched ${rawDeals.length}, matched ${matched.length}`,
  );

  return {
    fetched: rawDeals.length,
    matched: matched.length,
    sourceFailures,
  };
}
