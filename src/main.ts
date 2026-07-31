import { loadConfig } from "./config.ts";
import {
  type Db,
  filterNew,
  getHealth,
  openDb,
  recordAttempt,
  recordSeen,
} from "./store/db.ts";
import {
  type PipelineDeps,
  type PipelineSummary,
  run as runPipeline,
} from "./pipeline.ts";
import { upsert } from "./sinks/shoppingList.ts";
import { push } from "./sinks/push.ts";
import { fetchAldi } from "./sources/aldi.ts";
import { fetchWoolworths } from "./sources/woolworths.ts";
import { fetchColes } from "./sources/coles.ts";
import type { Config } from "./types.ts";

/** Default location of the (gitignored) local config file, relative to cwd. */
export const DEFAULT_CONFIG_PATH = "./config.local.json";

/** Default location of the dedupe/health sqlite db, relative to cwd. */
export const DEFAULT_DB_PATH = "./dealwatch.db";

export const EXIT_SUCCESS = 0;
/** Config failed to load or validate. No crash push: we may not have a topic URL yet. */
export const EXIT_CONFIG_ERROR = 1;
/** Anything else uncaught (db open, dep wiring, the pipeline run itself). */
export const EXIT_RUNTIME_ERROR = 2;

/**
 * Assembles the real `PipelineDeps` for one run: source fetchers bound to
 * their per-store config profile, the db functions bound to an already-open
 * `db` handle, and the two sinks bound to their config. `now` and `fetchImpl`
 * are threaded straight through (Assumption 15: clock is always a
 * parameter), so this stays pure given its inputs — no I/O happens here,
 * only closures are built.
 */
export function buildDeps(
  config: Config,
  db: Db,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): PipelineDeps {
  return {
    now,
    watchlist: config.watchlist,
    sources: [
      {
        source: "aldi",
        fetch: () => fetchAldi(config.stores.aldi, fetchImpl),
      },
      {
        source: "woolworths",
        fetch: () => fetchWoolworths(config.stores.woolworths, fetchImpl),
      },
      {
        source: "coles",
        fetch: () => fetchColes(config.stores.coles, fetchImpl),
      },
    ],
    store: {
      getHealth: () => getHealth(db),
      filterNew: (deals) => filterNew(db, deals),
      recordSeen: (deals) => recordSeen(db, deals),
      recordAttempt: (source, attemptNow, ok) =>
        recordAttempt(db, source, attemptNow, ok),
    },
    sinks: {
      saveList: (deals) => upsert(deals, config.sinks.shoppingListPath),
      push: (message) => push(message, config.sinks.ntfy.topicUrl),
    },
  };
}

/**
 * Injection points for `main`. Every field defaults to the real
 * implementation, so production calls `main()` with no arguments; tests
 * override just the collaborators they need to fake, and never touch real
 * files, a real db, or the network.
 */
export type MainOptions = {
  configPath?: string;
  dbPath?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  loadConfigFn?: (path: string) => Config;
  openDbFn?: (path: string) => Db;
  runFn?: (deps: PipelineDeps) => Promise<PipelineSummary>;
  /** Best-effort crash push. Defaults to a real ntfy push once config is loaded. */
  notifyCrash?: (message: string) => Promise<void>;
};

/**
 * Runs one dealwatch pass: load config, open the db, wire deps, run the
 * pipeline once, and return a process exit code (never calls `Deno.exit`
 * itself, so it's testable without the process actually exiting).
 *
 * - Config fails to load/validate: logs the error, returns `1`. No crash
 *   push is attempted — a config error can mean we don't even have a valid
 *   ntfy topic URL to push to.
 * - Anything else uncaught (db open, dep wiring, or the pipeline run):
 *   attempts a best-effort `dealwatch crashed: <message>` ntfy push, swallows
 *   any secondary failure from that push, logs the original error, and
 *   returns `2`.
 * - Otherwise: logs a one-line run summary and returns `0`.
 */
export async function main(options: MainOptions = {}): Promise<number> {
  const {
    configPath = DEFAULT_CONFIG_PATH,
    dbPath = DEFAULT_DB_PATH,
    now = new Date(),
    fetchImpl = fetch,
    loadConfigFn = loadConfig,
    openDbFn = openDb,
    runFn = runPipeline,
    notifyCrash,
  } = options;

  let config: Config;
  try {
    config = loadConfigFn(configPath);
  } catch (error) {
    console.error(
      `dealwatch: failed to load config at "${configPath}":`,
      error,
    );
    return EXIT_CONFIG_ERROR;
  }

  // Only built once config is known good, so a config-load failure above can
  // never reach a push attempt (we may not have a valid topic URL).
  const crashNotify = notifyCrash ??
    ((message: string) => push(message, config.sinks.ntfy.topicUrl, fetchImpl));

  try {
    const db = openDbFn(dbPath);
    const deps = buildDeps(config, db, now, fetchImpl);
    const summary = await runFn(deps);
    console.log(
      `dealwatch: run complete — due=[${
        summary.due.join(",")
      }] fetched=${summary.fetched} matched=${summary.matched} failures=[${
        summary.sourceFailures.join(",")
      }]`,
    );
    return EXIT_SUCCESS;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await crashNotify(`dealwatch crashed: ${message}`);
    } catch (pushError) {
      console.error("dealwatch: crash-notify push also failed:", pushError);
    }
    console.error("dealwatch: uncaught error during run:", error);
    return EXIT_RUNTIME_ERROR;
  }
}

if (import.meta.main) {
  Deno.exit(
    await main({ configPath: Deno.args[0], dbPath: Deno.args[1] }),
  );
}
