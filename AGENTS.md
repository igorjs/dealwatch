# AGENTS.md

This file is the source of guidance for anyone (human or agent) working on this repo. `CLAUDE.md` just points here.

## What this is

Dealwatch is a personal, local-first half-price grocery alert pipeline meant to run on a Raspberry Pi. It's a Deno/TypeScript program that watches Woolworths, Coles, and Aldi for specials, matches them against a keyword watchlist, appends matches to a local `shopping-list.json` grouped by category, and pushes an alert via ntfy. There is no server, no UI, and no multi-user support. It runs on a timer, does one pass, and exits.

## Layout

- `src/types.ts`: Zod schemas and inferred types for every boundary value (`Source`, `RawDeal`, `Deal`, `Watch`, `Config`, `ListItem`, `StoreProfile`).
- `src/config.ts`: loads and validates the config file, applies env overrides.
- `src/core/`: pure logic, no I/O:
  - `id.ts`: canonical URL and stable id (source plus URL hash).
  - `match.ts`: watchlist matching (keyword, discount floor, excludes).
  - `schedule.ts`: self-gating (is a source due?) and failure backoff.
  - `category.ts`: maps each store's raw department to a shared category.
  - `price.ts`: price and discount parsing.
  - `normalize.ts`: turns a `RawDeal` into a `Deal`.
- `src/store/db.ts`: dedupe state and per-source health/backoff, backed by `node:sqlite`.
- `src/sinks/`: `shoppingList.ts` (writes `shopping-list.json`) and `push.ts` (ntfy).
- `src/sources/`: one fetcher per store (`aldi.ts`, `coles.ts`, `woolworths.ts`) plus shared `errors.ts`.
- `src/pipeline.ts`: wires schedule, sources, normalize, dedupe, match, and sinks into one run.
- `src/main.ts`: CLI entry point, exit codes, crash notification.

## Commands

- `deno task test`: runs the whole test suite.
- `deno task run <config.json> <db.path>`: runs one pipeline pass against a given config and sqlite db.

Tests are co-located as `<name>_test.ts` next to the file they cover, and run on Deno's built-in test runner (no Jest, no Vitest).

## Conventions

- **Zod at every boundary.** Config, env, and store payloads are parsed with Zod, never cast. If a value crosses a trust boundary, it goes through a schema first.
- **Clock is always a parameter.** Anything that needs the current time takes `now: Date`. Never read the clock from `Deno.env`, `Date.now()`, or a module global. This keeps parallel `deno test` runs deterministic.
- **Dependency injection, not global mocks.** Fetch, the clock, and the db path are all passed in. Tests use spies and fakes at the call boundary. Nothing mocks another module's internals or SQLite tables directly.
- **Dependencies are exact-pinned.** No `^` or `~` ranges.

## Store captures

Each store fetcher reads a captured request profile (URL, headers) rather than reverse-engineering an API from scratch. See `scripts/STORE-CAPTURE.md` for how to capture one from DevTools.

The fixtures under `test/fixtures/` are placeholders until a real capture lands for each store. This is especially true for Coles: its deals request has not been captured yet, so `test/fixtures/coles.json` and the Coles response schema are a best-effort guess, not a verified shape. Treat any Coles-related schema change as expected once a real capture happens.

## Recovery caveat

If `dealwatch.db` gets corrupted, deleting it is a safe way to recover. The pipeline will recreate it on the next run. The tradeoff: dedupe state lives only in that db, so on the next run every deal that currently matches the watchlist will alert again, once. This is expected, not a bug. It only affects the run right after a db deletion.
