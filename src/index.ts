// Cloudflare Worker entry point (v3): wires `processSourceResults` (see
// `src/pipeline.ts`) into three bearer-gated HTTP routes on `fetch`:
// `POST /ingest`, `GET /health`, and `GET /shopping-list`. GitHub Actions is
// the sole scheduler now, so there is no Cron `scheduled` handler and no CLI
// entry point (that was v1's `src/main.ts`, retired even earlier): a Worker
// has no process to exit and no `Deno.args`, just handlers that return.
import { buildConfig } from "./config";
import { CorruptListFileError, LIST_KEY, readList } from "./listStore";
import { processSourceResults } from "./pipeline";
import { getHealth } from "./store";
import { IngestBodySchema, type Config } from "./types";

/**
 * Injection seam for `POST /ingest`, which needs no browser or fetch step at
 * all since its results already arrived fetched (a GitHub Actions Playwright
 * job did that work before the request landed here). Every field defaults to
 * the real implementation; tests override `processSourceResultsFn` to avoid
 * ever touching the real D1/R2 bindings or ntfy endpoint when they don't
 * need to.
 */
export type RunOptions = {
  buildConfigFn?: (env: Pick<Env, "NTFY_TOPIC_URL">) => Config;
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
 * Builds the `{ fetch }` handler. A plain factory so tests can construct a
 * handler with a fake `processSourceResultsFn` (or `buildConfigFn`) threaded
 * into `POST /ingest`, and drive it through the real `fetch` entry point,
 * auth, routing, D1/R2 access and all, without ever touching the real ntfy
 * endpoint or a real D1/R2 write when they don't need to. Production uses
 * `createHandler()` with no arguments, i.e. every default.
 */
export function createHandler(runOptions: RunOptions = {}): ExportedHandler<Env> {
  return {
    async fetch(req, env, _ctx) {
      const url = new URL(req.url);

      /**
       * Receives one Actions Playwright run's per-source fetch results and
       * hands them straight to `processSourceResults` (see
       * `src/pipeline.ts`), the results already fetched by a GitHub Actions
       * job rather than a Browser Rendering session launched by this Worker.
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
            ingestResults,
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
