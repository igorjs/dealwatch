import type { Deal, RawDeal, Source, Watch } from "./types.ts";
import {
  DEFAULT_SCHEDULE,
  dueSources,
  type SourceHealth,
} from "./core/schedule.ts";
import { normalize } from "./core/normalize.ts";
import { match } from "./core/match.ts";

/** A configured source paired with a pre-bound fetcher thunk (no config/fetch args left to pass). */
export type PipelineSource = {
  source: Source;
  fetch: () => Promise<RawDeal[]>;
};

/**
 * The persistence surface `run` needs: dedupe + health, already bound to a
 * concrete db handle by the caller (real `store/db.ts` functions, or a test
 * spy). Kept narrow so tests never need a real `node:sqlite` connection.
 */
export type PipelineStore = {
  getHealth(): SourceHealth[];
  filterNew(deals: Deal[]): Deal[];
  recordSeen(deals: Deal[]): void;
  recordAttempt(source: Source, now: Date, ok: boolean): void;
};

/** The output surface `run` needs: one sink per delivery channel. */
export type PipelineSinks = {
  saveList(deals: Deal[]): void | Promise<void>;
  push(message: string): Promise<void>;
};

export type PipelineDeps = {
  now: Date;
  watchlist: Watch[];
  sources: PipelineSource[];
  store: PipelineStore;
  sinks: PipelineSinks;
  /** Consecutive failures before a source triggers a failure-alert push. Defaults to 3. */
  failureThreshold?: number;
};

/** A compact record of what one `run` pass did, for logging/tests — not an error channel. */
export type PipelineSummary = {
  due: Source[];
  fetched: number;
  matched: number;
  sourceFailures: Source[];
};

const DEFAULT_FAILURE_THRESHOLD = 3;

/** A source health record with no recorded activity, used when `getHealth` has no row for a configured source. */
function emptyHealth(source: Source): SourceHealth {
  return {
    source,
    lastSuccessAt: null,
    lastAttemptAt: null,
    consecutiveFailures: 0,
  };
}

/** Best-effort push: logs and swallows a failure instead of letting it escape `run`. */
async function safePush(sinks: PipelineSinks, message: string): Promise<void> {
  try {
    await sinks.push(message);
  } catch (error) {
    console.error(`dealwatch: push failed for message "${message}":`, error);
  }
}

/**
 * Runs one pipeline pass: picks due sources, fetches them under
 * `allSettled` (a broken source never stops the others), normalizes and
 * dedupes the results, matches against the watchlist, and delivers new
 * matches to both sinks (also isolated under `allSettled`). Never rethrows a
 * source or sink failure — those are logged and folded into the returned
 * summary instead, so one bad tick never crashes the whole run.
 */
export async function run(deps: PipelineDeps): Promise<PipelineSummary> {
  const { now, watchlist, sources, store, sinks } = deps;
  const failureThreshold = deps.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;

  // 1. Which configured sources are due? Cover every configured source, not
  // just ones with an existing health row (a brand-new source has none).
  const healthBySource = new Map(
    store.getHealth().map((entry) => [entry.source, entry]),
  );
  const health = sources.map(({ source }) =>
    healthBySource.get(source) ?? emptyHealth(source)
  );
  const due = dueSources(now, health, DEFAULT_SCHEDULE);
  const dueSet = new Set(due);
  const sourcesToFetch = sources.filter((s) => dueSet.has(s.source));

  // Prior failure counts, so a fetch failure below can tell whether it just
  // pushed the source's streak to the alert threshold.
  const priorFailures = new Map(
    health.map((entry) => [entry.source, entry.consecutiveFailures]),
  );

  // 2. Fetch every due source concurrently; a rejection is isolated to that
  // source and never stops the others (that's the point of `allSettled`).
  // Deferred via `Promise.resolve().then(...)` so a fetcher that throws
  // synchronously (instead of returning a rejected promise) still isolates
  // as a rejection here instead of throwing before `Promise.allSettled` is
  // even called.
  const settled = await Promise.allSettled(
    sourcesToFetch.map((s) => Promise.resolve().then(() => s.fetch())),
  );

  const rawDeals: RawDeal[] = [];
  const sourceFailures: Source[] = [];
  const failureAlerts: Promise<void>[] = [];
  settled.forEach((result, index) => {
    const { source } = sourcesToFetch[index];
    if (result.status === "fulfilled") {
      store.recordAttempt(source, now, true);
      rawDeals.push(...result.value);
      return;
    }

    store.recordAttempt(source, now, false);
    console.error(`dealwatch: source "${source}" fetch failed:`, result.reason);
    sourceFailures.push(source);

    const consecutiveFailures = (priorFailures.get(source) ?? 0) + 1;
    if (consecutiveFailures >= failureThreshold) {
      failureAlerts.push(
        safePush(
          sinks,
          `dealwatch: source "${source}" has failed ${consecutiveFailures} times in a row`,
        ),
      );
    }
  });
  await Promise.allSettled(failureAlerts);

  // 3. Normalize every collected RawDeal.
  const deals = rawDeals.map((raw) => normalize(raw, now));

  // 4. Drop deals already recorded as seen.
  const newDeals = store.filterNew(deals);

  // 5. Keep only deals matching the watchlist.
  const matched = newDeals.filter((deal) => match(deal, watchlist));

  // 6. Deliver matches to both sinks, isolated so one sink failing never
  // blocks or fails the other.
  if (matched.length > 0) {
    const titles = matched.map((deal) => deal.title).join(", ");
    // Deferred via `Promise.resolve().then(...)` so a sink that throws
    // synchronously (rather than returning a rejected promise) still
    // isolates as a rejection here instead of throwing before
    // `Promise.allSettled` is even called.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => sinks.saveList(matched)),
      Promise.resolve().then(() =>
        sinks.push(
          `dealwatch: ${matched.length} new matching deal(s): ${titles}`,
        )
      ),
    ]);
    const [saveListResult, pushResult] = results;
    if (saveListResult.status === "rejected") {
      console.error("dealwatch: saveList sink failed:", saveListResult.reason);
    }
    if (pushResult.status === "rejected") {
      console.error("dealwatch: push sink failed:", pushResult.reason);
    }
  }

  // 7. Record only the ALERTED (matched) deals as seen. A new deal that
  // didn't match today stays un-seen on purpose: if the watchlist changes
  // later (a term added or a floor relaxed), that deal is still eligible to
  // match and alert on a future run instead of being silently dedupe-locked
  // out by having passed through once already. This guarantees each
  // matching deal alerts exactly once, at the cost of re-normalizing and
  // re-matching non-matching deals on every run until a source stops
  // returning them.
  store.recordSeen(matched);

  return {
    due,
    fetched: rawDeals.length,
    matched: matched.length,
    sourceFailures,
  };
}
