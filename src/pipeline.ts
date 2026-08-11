import type { BrowserSession, PageLike, SourceResult } from "./browser";
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
 * Coles takes no profile, its on-special URL is hardcoded inside the
 * fetcher itself (see `src/sources/coles.ts`). Exported so tests can swap in
 * fakes for one or more sources (via `PipelineDeps.fetchers`) without having
 * to fake a real store's response shape through a fake `PageLike`.
 */
export const REAL_FETCHERS: SourceFetchers = {
  aldi: (page, config) => fetchAldiViaBrowser(page, config.stores.aldi),
  woolworths: (page, config) => fetchWoolworthsViaBrowser(page, config.stores.woolworths),
  coles: (page) => fetchColesViaBrowser(page),
};

/**
 * Everything `processSourceResults` needs for the process half of one pass:
 * the clock, config, and both storage bindings, plus the optional
 * push/threshold/list-key seams. No `browser` or `fetchers` here: those
 * belong only to the fetch half `runPipeline` still does.
 */
export type ProcessDeps = {
  now: Date;
  config: Config;
  db: D1Database;
  bucket: R2Bucket;
  /** Defaults to the real `push()` (posts to ntfy over `fetch`). */
  pushFn?: (message: string, topicUrl: string) => Promise<void>;
  /** Consecutive failures before a source triggers a failure-alert push. Defaults to 3. */
  failureThreshold?: number;
  /** The R2 object key the shopping list is upserted to. Defaults to `LIST_KEY`; tests use a unique key per file-shared bucket. */
  listKey?: string;
};

/**
 * Everything `runPipeline` needs for one pass, injected rather than read
 * from a global or reconstructed internally. This repo's "dependency
 * injection, not global mocks" convention (clock, storage, browser session,
 * and the push/fetch seams all pass straight through) is what lets tests
 * exercise the real D1/R2 bindings while faking only Browser Rendering and
 * ntfy, the two things with no local equivalent. Extends `ProcessDeps` with
 * the fetch-half-only seams (`browser`, `fetchers`); `runPipeline` passes a
 * `PipelineDeps` straight through to `processSourceResults`, which only
 * reads the `ProcessDeps` subset of it.
 */
export type PipelineDeps = ProcessDeps & {
  browser: BrowserSession;
  /** Defaults to `REAL_FETCHERS`. Tests swap in fakes per source. */
  fetchers?: SourceFetchers;
};

/**
 * A compact record of what one `runPipeline` pass did, for logging/tests,
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
 * `failureThreshold` consecutive failures. v3 fetches every source from a
 * GitHub Actions Playwright job rather than Browser Rendering, so unlike v1
 * this never points at a re-capture doc. It names the plausible v3-era
 * causes instead (the store's anti-bot protection blocking the runner, a
 * Playwright or stealth failure, or the store changing its page/API shape),
 * without claiming to know which one applies. Includes the rejected
 * result's own `reason` so the alert is diagnosable on its own, rather than
 * requiring a trip to the Actions run's logs.
 */
function formatFailureAlert(
  source: Source,
  consecutiveFailures: number,
  reason: string,
): string {
  return `dealwatch: source "${source}" failed ${consecutiveFailures} times in a row (${reason}). ` +
    `Possible causes: the store's anti-bot protection blocked the GitHub Actions ` +
    `runner, a Playwright or stealth failure, or the store changed its page/API shape`;
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
 * others, see `src/browser.ts`), then hands the results to
 * `processSourceResults` for everything downstream. Kept as two functions so
 * a caller with results delivered another way (not a live Browser Rendering
 * session) can drive the process half directly with the same fulfilled/
 * rejected shape.
 */
export async function runPipeline(deps: PipelineDeps): Promise<PipelineSummary> {
  const { config, browser } = deps;
  const fetchers = deps.fetchers ?? REAL_FETCHERS;

  // Fetch every source, strictly one at a time (Browser Rendering has no
  // concurrent-page budget worth spending here, see withSourcesSerial's own
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

  return processSourceResults(deps, results);
}

/**
 * Everything downstream of a source fetch: normalizes and dedupes the
 * results, matches against the watchlist, and delivers new matches to both
 * the shopping list (R2) and a push alert (isolated from each other under
 * `allSettled`). `results` is the same fulfilled/rejected shape
 * `withSourcesSerial` produces, so it works the same whether it came from a
 * live Browser Rendering fetch or arrived some other way. Never rethrows a
 * source-fetch, normalize, R2-write, or push failure: those are logged and
 * folded into the returned summary instead, so one bad tick never crashes
 * the whole run.
 */
export async function processSourceResults(
  deps: ProcessDeps,
  results: SourceResult<Source, RawDeal[]>[],
): Promise<PipelineSummary> {
  const { now, config, db, bucket } = deps;
  const pushFn = deps.pushFn ?? push;
  const failureThreshold = deps.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const listKey = deps.listKey ?? LIST_KEY;
  const topicUrl = config.ntfy.topicUrl;

  const runStart = performance.now();

  // Prior failure counts, read once up front, so a fetch failure below can
  // tell whether it just pushed the source's streak to the alert threshold.
  const health = await getHealth(db);
  const priorFailures = new Map<Source, number>(
    health.map((entry: SourceHealth) => [entry.source, entry.consecutiveFailures]),
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
      const reason = String(result.reason);
      failureAlerts.push(
        safePush(pushFn, formatFailureAlert(source, consecutiveFailures, reason), topicUrl),
      );
    }
  }
  await Promise.allSettled(failureAlerts);

  // Normalize every collected RawDeal, isolated per deal: `normalize` can
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

  // Drop deals already recorded as seen, then keep only deals matching the
  // watchlist.
  const newDeals = await filterNew(db, deals);
  const matched = newDeals.filter((deal) => match(deal, config.watchlist));

  // Deliver matches to both sinks, isolated so one sink failing never blocks
  // or fails the other.
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
    // filterNew. They retry, and re-alert, next run instead. A duplicate
    // ntfy ping on retry is an acceptable cost for avoiding silent data loss.
    if (saveListResult.status === "fulfilled") {
      await recordSeen(db, matched);
    }
  }

  const totalElapsedMs = Math.round(performance.now() - runStart);
  console.log(
    `dealwatch: run complete in ${totalElapsedMs}ms, fetched ${rawDeals.length}, matched ${matched.length}`,
  );

  return {
    fetched: rawDeals.length,
    matched: matched.length,
    sourceFailures,
  };
}
