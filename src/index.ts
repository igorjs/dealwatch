// Cloudflare Worker entry point (v2): wires `runPipeline` (see
// `src/pipeline.ts`) into the actual Worker triggers — a Cron `scheduled`
// handler and three bearer-gated HTTP routes on `fetch`. There is no CLI
// entry point in v2 (that was v1's `src/main.ts`, now retired): a Worker has
// no process to exit and no `Deno.args`, just handlers that return.
import { launch, type BrowserSession, type SourceResult } from "./browser";
import { buildConfig } from "./config";
import { CorruptListFileError, LIST_KEY, readList } from "./listStore";
import { push } from "./push";
import { runPipeline, processSourceResults, type PipelineSummary } from "./pipeline";
import { getHealth } from "./store";
import { IngestBodySchema, type Config, type RawDeal, type Source } from "./types";

/**
 * Injection seam for the config/browser/runPipeline sequence shared by
 * `scheduled` and `POST /run`, plus `processSourceResultsFn` for
 * `POST /ingest` (which needs no browser at all, since its results already
 * arrived fetched). Every field defaults to the real implementation; tests
 * override `launchFn`/`runPipelineFn`/`processSourceResultsFn` to avoid ever
 * driving a real Browser Rendering session — the same seam
 * `src/pipeline.test.ts` uses for `PipelineDeps.fetchers`.
 */
export type RunOptions = {
  buildConfigFn?: (env: Pick<Env, "NTFY_TOPIC_URL">) => Config;
  launchFn?: (binding: Env["BROWSER"]) => Promise<BrowserSession>;
  runPipelineFn?: typeof runPipeline;
  processSourceResultsFn?: typeof processSourceResults;
};

/**
 * Upper bound on a `POST /ingest` request body, checked twice: once against
 * the `Content-Length` header before the body is read at all (cheap, but a
 * client can lie about or omit it), and once against the body's actual
 * encoded byte length after reading it (the real check). See the route's own
 * doc comment for why this cap exists.
 */
const MAX_INGEST_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Upper bound on the number of deals a single source result in a
 * `POST /ingest` body may carry. See the route's own doc comment for why
 * this cap exists.
 */
const MAX_DEALS_PER_SOURCE = 5000;

/**
 * Builds config, launches a Browser Rendering session, runs one pipeline
 * pass, and always closes the browser SESSION (not just its pages) in a
 * `finally` — `withSourcesSerial` (called inside `runPipeline`) closes each
 * page it opens, but never the session itself, so that's this function's
 * job. Shared by `scheduled` and `POST /run` so the sequence lives in one
 * place instead of being duplicated across both entry points.
 */
export async function runOnePass(
  env: Env,
  options: RunOptions = {},
): Promise<PipelineSummary> {
  const buildConfigFn = options.buildConfigFn ?? buildConfig;
  const launchFn = options.launchFn ?? launch;
  const runPipelineFn = options.runPipelineFn ?? runPipeline;

  const config = buildConfigFn(env);
  const browser = await launchFn(env.BROWSER);
  try {
    const summary = await runPipelineFn({
      now: new Date(),
      config,
      db: env.DB,
      bucket: env.LIST,
      browser,
    });
    console.log(
      `dealwatch: pass complete — fetched=${summary.fetched} matched=${summary.matched} failures=[${
        summary.sourceFailures.join(",")
      }]`,
    );
    return summary;
  } finally {
    await browser.close();
  }
}

/**
 * Constant-time bearer-token check against `env.API_TOKEN`, so a caller
 * probing the endpoint can't learn anything about the real token from
 * response-time differences. `crypto.subtle.timingSafeEqual` (available on
 * the Workers runtime's `SubtleCrypto`, see worker-configuration.d.ts) does
 * the constant-time comparison itself, but it throws if the two buffers
 * differ in length — which would itself leak a length side-channel via the
 * catch — so both inputs are first hashed to a fixed-length SHA-256 digest.
 * Comparing digests also means the routing logic never needs to branch on
 * the *raw* secret's length at all.
 */
async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}

/**
 * Checks the `Authorization: Bearer <token>` header against `env.API_TOKEN`.
 * Missing header, malformed header, and a present-but-wrong token are all
 * treated identically (return `false`) so a caller can never distinguish
 * "no token" from "wrong token" from the response alone.
 */
async function checkAuth(req: Request, env: Env): Promise<boolean> {
  const header = req.headers.get("Authorization");
  if (header === null) return false;

  const [scheme, token] = header.split(" ", 2);
  if (scheme !== "Bearer" || token === undefined || token === "") return false;

  return await timingSafeStringEqual(token, env.API_TOKEN);
}

/**
 * Builds the `{ scheduled, fetch }` handler pair. A plain factory (rather
 * than inlining `runOnePass(env)` calls straight into the default export)
 * so tests can construct a handler with a fake `launchFn`/`runPipelineFn`
 * threaded into every route that invokes the pipeline (`scheduled` and
 * `POST /run`), and drive it through the real `fetch`/`scheduled` entry
 * points — auth, routing, D1/R2 access and all — without ever attempting a
 * real Browser Rendering launch. Production uses `createHandler()` with no
 * arguments, i.e. every default.
 */
export function createHandler(runOptions: RunOptions = {}): ExportedHandler<Env> {
  return {
    /**
     * Cron trigger entry point. Never rethrows: an uncaught throw here just
     * becomes an unhandled Cron failure with no forensic value beyond
     * what's already logged, so every failure mode is caught, logged, and
     * (best effort) pushed as a crash notification instead.
     *
     * `runPipeline` itself already swallows the failure modes that matter
     * (source fetch, normalize, R2, push) — this try/catch is only for
     * failures OUTSIDE that: `buildConfig` throwing on a bad
     * `NTFY_TOPIC_URL` secret, or `launch()` failing to get a browser at
     * all.
     */
    async scheduled(_event, env, _ctx) {
      let config: Config | undefined;
      try {
        const buildConfigFn = runOptions.buildConfigFn ?? buildConfig;
        config = buildConfigFn(env);
        await runOnePass(env, { ...runOptions, buildConfigFn: () => config as Config });
      } catch (error) {
        console.error("dealwatch: uncaught error during scheduled run:", error);
        // Only attempt a crash push if config built successfully — if
        // `buildConfig` itself threw, there may be no valid topic URL to
        // push to at all.
        if (config !== undefined) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            await push(`dealwatch crashed: ${message}`, config.ntfy.topicUrl);
          } catch (pushError) {
            console.error("dealwatch: crash-notify push also failed:", pushError);
          }
        }
      }
    },

    async fetch(req, env, _ctx) {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === "/run") {
        if (!(await checkAuth(req, env))) {
          return new Response("unauthorized", { status: 401 });
        }
        // Unlike `scheduled` (which has nothing to answer and so only logs
        // + best-effort crash-notifies), a caller here is waiting on a
        // response — an uncaught throw must still become a clear 500, not
        // an unhandled worker error with no logged cause.
        try {
          const summary = await runOnePass(env, runOptions);
          return Response.json(summary);
        } catch (error) {
          console.error("dealwatch: POST /run failed:", error);
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      /**
       * Receives one Actions Playwright run's per-source fetch results and
       * hands them straight to `processSourceResults`, the same "process"
       * half of the pipeline `POST /run` drives via `runPipeline` (see
       * `src/pipeline.ts`), just fed results captured by a GitHub Actions job
       * instead of a Browser Rendering session launched by this Worker.
       *
       * `API_TOKEN` is the only gate on this route. A leaked token would
       * otherwise let a caller poison the shopping list with arbitrary R2
       * writes, or flood D1's `seen_deal`/`source_health` tables, just by
       * POSTing an oversized or malformed body, since there is no per-source
       * upstream validation the way a real store scrape would have. The size
       * guards below (`MAX_INGEST_BODY_BYTES`, checked both before and after
       * reading the body) and the per-source deal cap (`MAX_DEALS_PER_SOURCE`)
       * bound that blast radius; they do not eliminate it. That residual
       * risk is accepted here: this is a personal, single-user tool, not a
       * multi-tenant service worth a heavier auth model.
       */
      if (req.method === "POST" && url.pathname === "/ingest") {
        if (!(await checkAuth(req, env))) {
          return new Response("unauthorized", { status: 401 });
        }

        try {
          // Size guard, before reading the body at all: cheap, but not a
          // guarantee on its own, since a caller can lie about or omit
          // Content-Length. Its absence is not itself a reason to reject; a
          // chunked client legitimately omits it.
          const contentLength = req.headers.get("Content-Length");
          if (contentLength !== null && Number(contentLength) > MAX_INGEST_BODY_BYTES) {
            return Response.json({ error: "body too large" }, { status: 400 });
          }

          // Size guard, after reading: the real check, measured against the
          // body actually received. Byte length via TextEncoder, not
          // `.length`, so multi-byte characters count correctly.
          const bodyText = await req.text();
          if (new TextEncoder().encode(bodyText).byteLength > MAX_INGEST_BODY_BYTES) {
            return Response.json({ error: "body too large" }, { status: 400 });
          }

          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(bodyText);
          } catch {
            return Response.json({ error: "invalid JSON" }, { status: 400 });
          }

          const parsedBody = IngestBodySchema.safeParse(parsedJson);
          if (!parsedBody.success) {
            return Response.json({ error: "invalid request body" }, { status: 400 });
          }
          const { results: ingestResults } = parsedBody.data;

          const oversizedSource = ingestResults.some(
            (result) =>
              result.status === "fulfilled" && result.deals.length > MAX_DEALS_PER_SOURCE,
          );
          if (oversizedSource) {
            return Response.json(
              { error: "too many deals in one source result" },
              { status: 400 },
            );
          }

          // Reshape the wire contract (`deals`/`reason` per types.ts's
          // SourceResult) into the fulfilled/rejected shape
          // `processSourceResults` expects (`value`/`reason`, mirroring
          // Promise.allSettled, see browser.ts's SourceResult).
          const results: SourceResult<Source, RawDeal[]>[] = ingestResults.map((result) =>
            result.status === "fulfilled"
              ? { source: result.source, status: "fulfilled", value: result.deals }
              : { source: result.source, status: "rejected", reason: result.reason }
          );

          const buildConfigFn = runOptions.buildConfigFn ?? buildConfig;
          const processSourceResultsFn = runOptions.processSourceResultsFn ??
            processSourceResults;
          const summary = await processSourceResultsFn(
            {
              now: new Date(),
              config: buildConfigFn(env),
              db: env.DB,
              bucket: env.LIST,
            },
            results,
          );
          return Response.json(summary);
        } catch (error) {
          console.error("dealwatch: POST /ingest failed:", error);
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      if (req.method === "GET" && url.pathname === "/health") {
        if (!(await checkAuth(req, env))) {
          return new Response("unauthorized", { status: 401 });
        }
        const health = await getHealth(env.DB);
        return Response.json(health);
      }

      if (req.method === "GET" && url.pathname === "/shopping-list") {
        if (!(await checkAuth(req, env))) {
          return new Response("unauthorized", { status: 401 });
        }

        // "Absent" and "corrupt" are different failure modes and must not
        // be conflated: check presence directly via `bucket.head()` first
        // (a `null` result means the object genuinely doesn't exist yet,
        // e.g. no pipeline run has ever matched anything) and surface that
        // as 404. If the object exists, `readList` either returns its
        // parsed content or throws `CorruptListFileError` for a malformed
        // object — a real bug worth a loud 500, not a silently-empty 404.
        const exists = await env.LIST.head(LIST_KEY);
        if (exists === null) {
          return new Response("not found", { status: 404 });
        }
        try {
          const grouped = await readList(env.LIST);
          return Response.json(grouped);
        } catch (error) {
          if (error instanceof CorruptListFileError) {
            console.error("dealwatch: shopping list object is corrupt:", error);
            return new Response("shopping list is corrupt", { status: 500 });
          }
          throw error;
        }
      }

      return new Response("not found", { status: 404 });
    },
  } satisfies ExportedHandler<Env>;
}

export default createHandler();
