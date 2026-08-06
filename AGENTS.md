# AGENTS.md

This file is the source of guidance for anyone (human or agent) working on this
repo. `CLAUDE.md` just points here.

## What this is

Dealwatch is a personal half-price grocery alert pipeline. It runs as a single
Cloudflare Worker that watches Woolworths, Coles, and Aldi for specials,
matches them against a keyword watchlist, writes matches to a shopping list in
R2, and pushes an alert via ntfy. There is no server to manage, no UI, and no
multi-user support. A Cron Trigger fires the Worker on a schedule; each
invocation does one pass over all three stores and returns.

Each store fetch runs through Cloudflare's Browser Rendering: a real headless
Chrome session, not a plain `fetch`. Coles and Woolworths sit behind
cookie-gated anti-bot protection (Incapsula and Akamai), and empirical testing
during the design of this pipeline showed a plain HTTP request gets blocked
regardless of IP or headers, while a real browser session mints valid cookies
on its own. Browser Rendering gives every run a fresh session, so there is
nothing to capture or keep fresh by hand.

## Layout

- `src/types.ts`: Zod schemas and inferred types for every boundary value
  (`Source`, `RawDeal`, `Deal`, `Watch`, `Config`, `ListItem`, `StoreProfile`).
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
- `src/browser.ts`: thin wrapper around `@cloudflare/puppeteer`, launches a
  Browser Rendering session and runs each source's fetch serially, one page
  at a time.
- `src/sources/`: one fetcher per store (`aldi.ts`, `coles.ts`,
  `woolworths.ts`), each driving a `PageLike` from `browser.ts`, plus shared
  `errors.ts`.
- `src/pipeline.ts`: wires the fetchers, normalize, dedupe, match, and sinks
  into one run (`runPipeline`).
- `src/index.ts`: the Worker entry point. Exports `scheduled` (the Cron
  Trigger handler) and `fetch` (bearer-gated `POST /run`, `GET /health`,
  `GET /shopping-list`).
- `migrations/`: D1 schema (`seen_deal`, `source_health`).

## Commands

- `npm test`: runs the whole test suite (Vitest, via
  `@cloudflare/vitest-pool-workers`).
- `npm run dev`: runs the Worker locally with `wrangler dev`.
- `npm run deploy`: deploys the Worker with `wrangler deploy`.
- `npm run cf-typegen`: regenerates `worker-configuration.d.ts` after changing
  a binding in `wrangler.jsonc`. Run this any time you add, rename, or remove
  a binding (D1, R2, Browser, secrets) so the generated `Env` type stays in
  sync.

Tests are co-located as `<name>.test.ts` next to the file they cover, and run
on Vitest, not Deno's test runner or Jest.

## Conventions

These principles carried through from v1 unchanged; only the runtime changed
(a Worker, not a Deno process).

- **Zod at every boundary.** Config, env, and store payloads are parsed with
  Zod, never cast. If a value crosses a trust boundary, it goes through a
  schema first.
- **Clock is always a parameter.** Anything that needs the current time takes
  `now: Date`. Never read the clock from a module global or an ambient
  `Date.now()` deep in a function. This keeps tests deterministic.
- **Dependency injection, not global mocks.** Fetch, the clock, the browser
  session, and the D1/R2 bindings are all passed in. Tests use spies and
  fakes at the call boundary (see `RunOptions` in `src/index.ts` and
  `PipelineDeps` in `src/pipeline.ts`). Nothing mocks another module's
  internals or D1/R2 directly.
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
