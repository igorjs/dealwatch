-- Initial schema: dedupe state (seen_deal) and per-source health/backoff
-- (source_health). Same shape as v1's node:sqlite MIGRATIONS const in
-- src/store/db.ts, ported to a D1 migration file. `IF NOT EXISTS` matches
-- v1's idempotent-migration behavior.

CREATE TABLE IF NOT EXISTS seen_deal (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_attempt_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
