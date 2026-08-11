/**
 * Entry point for the Actions job: reads the two secrets from the
 * environment, launches one stealth browser, runs Aldi, Woolworths, and
 * Coles serially (one page open at a time, closed before the next starts),
 * and POSTs every result to the Worker's ingest endpoint in a single call.
 *
 * A source failing never stops the run: fetchStore already turns a driver's
 * throw into a rejected SourceResult, so this function only ever collects
 * data, never a per-source exception. The only outcome this function treats
 * as a process failure is the ingest POST itself failing, since that is the
 * one case the Worker never hears about the run at all. That failure is
 * logged and reported by setting `process.exitCode` rather than by
 * rejecting, so the browser still closes below and GitHub Actions still
 * sees a clean shutdown with the exit code flushed, and the run log names a
 * reason instead of just the red exit status.
 */
import type { Source, SourceResult } from "../../src/types.ts";
import { launchStealth, newPage, type BrowserLike, type PageLike } from "./browser.ts";
import { fetchStore as defaultFetchStore } from "./fetchStore.ts";
import { postIngest as defaultPostIngest, type IngestTarget } from "./ingestClient.ts";

/** Every source main() fetches, run serially in this order. */
const SOURCES: readonly Source[] = ["aldi", "woolworths", "coles"];

/** The part of launchStealth()'s return value main() needs: a closable browser and a page-opening context. */
export interface LaunchedBrowser {
  browser: { close(): Promise<void> };
  context: BrowserLike;
}

/**
 * main()'s collaborators, injectable so tests never launch a real browser,
 * drive a real store, or hit the real network. Defaults to the real
 * launchStealth/fetchStore/postIngest and the process environment.
 */
export interface MainDeps {
  env: Record<string, string | undefined>;
  launchStealth: () => Promise<LaunchedBrowser>;
  fetchStore: (source: Source, page: PageLike) => Promise<SourceResult>;
  postIngest: (results: SourceResult[], target: IngestTarget) => Promise<void>;
}

const defaultDeps: MainDeps = {
  env: process.env,
  launchStealth,
  fetchStore: defaultFetchStore,
  postIngest: defaultPostIngest,
};

/** Reads `name` from `env`, throwing a message that names the missing variable but never any value. */
function requireEnvVar(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

export async function main(deps: MainDeps = defaultDeps): Promise<void> {
  const token = requireEnvVar(deps.env, "API_TOKEN");
  const url = requireEnvVar(deps.env, "WORKER_INGEST_URL");

  const { browser, context } = await deps.launchStealth();
  try {
    const results: SourceResult[] = [];
    for (const source of SOURCES) {
      const page = await newPage(context);
      try {
        results.push(await deps.fetchStore(source, page));
      } finally {
        await page.close();
      }
    }

    try {
      await deps.postIngest(results, { url, token });
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
