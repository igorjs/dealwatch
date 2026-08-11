# AGENTS.md

This file is the source of guidance for anyone (human or agent) working on this
repo. `CLAUDE.md` just points here.

## What this is

Dealwatch is a personal half-price grocery alert pipeline. It watches
Woolworths, Coles, and Aldi for specials, matches them against a keyword
watchlist, writes matches to a shopping list in R2, and pushes an alert via
ntfy. There is no server to manage by hand, no UI, and no multi-user support.

The pipeline is split across two deployables in this one repo:

- **The fetcher** (`fetcher/`), a Node and Playwright project. GitHub
  Actions runs it on a schedule, with a manual trigger too. It drives a real
  headless Chrome session against each store in turn, one page at a time,
  then POSTs every store's results to the Worker in a single request.
- **The Worker** (`src/`), a Cloudflare Worker that only ingests. It has no
  fetch step of its own: it receives a fetcher run's results over HTTP,
  normalizes and dedupes them, matches them against the watchlist, writes
  matches to the R2 shopping list, and pushes an alert.

GitHub Actions is the only scheduler for the pipeline; the Worker does not
run on a timer of its own.

A real browser session, not a plain `fetch`, is what lets the fetcher work
at all. Coles and Woolworths sit behind cookie-gated anti-bot protection
(Incapsula and Akamai), and empirical testing during the design of this
pipeline showed a plain HTTP request gets blocked regardless of IP or
headers, while a real browser session mints valid cookies on its own.

## Layout

- `src/types.ts`: Zod schemas and inferred types for every boundary value
  (`Source`, `RawDeal`, `Deal`, `Watch`, `Config`, `ListItem`, `StoreProfile`,
  `SourceResult`, `IngestBody`). `SourceResult` and `IngestBody` describe the
  `POST /ingest` wire contract shared by the Worker and the fetcher.
- `src/config.ts`: builds the validated `Config` from the bundled watchlist,
  store profiles, and the `NTFY_TOPIC_URL` secret.
- `src/core/`: pure logic, no I/O:
  - `id.ts`: canonical URL and stable id (source plus URL hash).
  - `match.ts`: watchlist matching (keyword, discount floor, excludes).
  - `category.ts`: maps each store's raw department to a shared category.
  - `price.ts`: price and discount parsing.
  - `normalize.ts`: turns a `RawDeal` into a `Deal`.
- `src/store.ts`: dedupe state (`seen_deal`) and per-source health/backoff
  (`source_health`), backed by D1.
- `src/listStore.ts`: reads and upserts the shopping list object in R2.
- `src/push.ts`: posts an alert to an ntfy topic URL.
- `src/sources/`: one pure parser per store (`parseAldiPayload` in
  `aldi.ts`, `parseColesPayload` in `coles.ts`, `parseWoolworthsPayload` in
  `woolworths.ts`), each turning a store's raw JSON payload into
  `RawDeal[]`. No I/O of their own: the fetcher's drivers fetch the raw
  payload, then hand it to these same parsers.
- `src/pipeline.ts`: `processSourceResults`, which takes an already-fetched
  `SourceResult[]` and runs normalize, dedupe, match, and both sinks (R2,
  ntfy) for one ingest.
- `src/index.ts`: the Worker entry point. Exports `fetch` only: three
  bearer-gated routes, `POST /ingest`, `GET /health`, `GET /shopping-list`.
- `migrations/`: D1 schema (`seen_deal`, `source_health`).
- `fetcher/`: the other deployable. A separate Node and Playwright project
  with its own `package.json`, run by GitHub Actions rather than bundled
  into the Worker:
  - `src/browser.ts`: launches a stealth Playwright Chromium session.
  - `src/drivers/`: one driver per store (`aldi.ts`, `coles.ts`,
    `woolworths.ts`). Each drives a page against the live store, then hands
    the raw payload to the matching parser in `src/sources/`.
  - `src/fetchStore.ts`: runs one store's driver and turns its outcome into
    a `SourceResult`, catching the driver's throw rather than letting it
    escape.
  - `src/ingestClient.ts`: POSTs `{ results }` to the Worker's `/ingest`
    route with a bearer token.
  - `src/main.ts`: the entry point. Launches one browser, runs all three
    stores serially (one page open at a time), and POSTs the combined
    results in a single request.
- `.github/workflows/fetch.yml`: runs the fetcher on a schedule, with a
  manual trigger too. This is the only scheduler in the pipeline.

## Commands

Worker, run from the repo root:

- `npm test`: runs the Worker's test suite (Vitest, via
  `@cloudflare/vitest-pool-workers`). It only globs `src/**/*.test.ts`, so it
  does not run the fetcher's tests.
- `npm run dev`: runs the Worker locally with `wrangler dev`.
- `npm run deploy`: deploys the Worker with `wrangler deploy`.
- `npm run cf-typegen`: regenerates `worker-configuration.d.ts` after changing
  a binding in `wrangler.jsonc`. Run this any time you add, rename, or remove
  a binding (D1, R2, secrets) so the generated `Env` type stays in sync.

Fetcher, its own project, run from `fetcher/`:

- `npm --prefix fetcher ci`: installs the fetcher's dependencies.
- `npx --prefix fetcher playwright install --with-deps chromium`: installs
  the Chromium build the fetcher drives.
- `npm --prefix fetcher test`: runs the fetcher's test suite (plain Vitest,
  no Workers pool, no D1 or R2).
- `npm --prefix fetcher start`: runs the fetcher once against the live
  stores and POSTs the results to `WORKER_INGEST_URL`. Needs `API_TOKEN` and
  `WORKER_INGEST_URL` set in the environment; this is what the GitHub
  Actions workflow runs on a schedule.

Tests are co-located as `<name>.test.ts` next to the file they cover, and run
on Vitest, not Deno's test runner or Jest.

## Conventions

These principles carried through from v1 unchanged. They apply to both
deployables here: the Worker (Cloudflare's runtime) and the fetcher (a plain
Node process).

- **Zod at every boundary.** Config, env, and store payloads are parsed with
  Zod, never cast. If a value crosses a trust boundary, it goes through a
  schema first.
- **Clock is always a parameter.** Anything that needs the current time takes
  `now: Date`. Never read the clock from a module global or an ambient
  `Date.now()` deep in a function. This keeps tests deterministic.
- **Dependency injection, not global mocks.** Fetch, the clock, the D1/R2
  bindings, and (in the fetcher) the browser session are all passed in.
  Tests use spies and fakes at the call boundary (see `RunOptions` in
  `src/index.ts`, `ProcessDeps` in `src/pipeline.ts`, and `MainDeps` in
  `fetcher/src/main.ts`). Nothing mocks another module's internals or D1/R2
  directly.
- **Dependencies are exact-pinned.** No `^` or `~` ranges (`.npmrc` sets
  `save-exact=true`).

## Recovery caveat

Dedupe state and per-source health live in D1, in the `seen_deal` and
`source_health` tables. If that data gets corrupted, dropping and recreating
those tables (or the whole D1 database) is a safe way to recover; the schema
in `migrations/0001_init.sql` recreates them on the next run. The tradeoff:
every deal that currently matches the watchlist will alert again, once, on
the first run after the reset. This is expected, not a bug. It only affects
that one run.
