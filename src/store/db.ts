import { DatabaseSync } from "node:sqlite";
import type { Deal, Source } from "../types.ts";
import type { SourceHealth } from "../core/schedule.ts";

/** An open, migrated dedupe/health store. */
export type Db = DatabaseSync;

/**
 * Idempotent schema migration: safe to run on every `openDb` call, including
 * against a db file that was already migrated by a previous run.
 */
const MIGRATIONS = `
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
`;

/** Opens (creating if absent) the sqlite db at `path` and applies migrations. */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(MIGRATIONS);
  return db;
}

/** Returns only the deals whose id is not already recorded in `seen_deal`. */
export function filterNew(db: Db, deals: Deal[]): Deal[] {
  const stmt = db.prepare("SELECT 1 FROM seen_deal WHERE id = ?");
  return deals.filter((deal) => stmt.get(deal.id) === undefined);
}

/**
 * Persists `deals` into `seen_deal`, keyed by id. Already-recorded ids are
 * left untouched (`INSERT OR IGNORE`), so this is safe to call with deals
 * that overlap a previous run.
 */
export function recordSeen(db: Db, deals: Deal[]): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO seen_deal (id, source, title, url, first_seen_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const deal of deals) {
    stmt.run(deal.id, deal.source, deal.title, deal.url, deal.seenAt);
  }
}

const UPSERT_SUCCESS = `
  INSERT INTO source_health (source, last_success_at, last_attempt_at, consecutive_failures)
  VALUES (?, ?, ?, 0)
  ON CONFLICT(source) DO UPDATE SET
    last_success_at = excluded.last_success_at,
    last_attempt_at = excluded.last_attempt_at,
    consecutive_failures = 0
`;

const UPSERT_FAILURE = `
  INSERT INTO source_health (source, last_success_at, last_attempt_at, consecutive_failures)
  VALUES (?, NULL, ?, 1)
  ON CONFLICT(source) DO UPDATE SET
    last_attempt_at = excluded.last_attempt_at,
    consecutive_failures = consecutive_failures + 1
`;

/**
 * Upserts `source_health` for one attempt. `last_attempt_at` is always set
 * to `now`. On success, `last_success_at` moves to `now` and
 * `consecutive_failures` resets to 0. On failure, `last_success_at` is left
 * as-is and `consecutive_failures` increments. `now` is a parameter (never
 * read from a clock) so this stays deterministic under test.
 */
export function recordAttempt(
  db: Db,
  source: Source,
  now: Date,
  ok: boolean,
): void {
  const nowIso = now.toISOString();
  if (ok) {
    db.prepare(UPSERT_SUCCESS).run(source, nowIso, nowIso);
  } else {
    db.prepare(UPSERT_FAILURE).run(source, nowIso);
  }
}

interface SourceHealthRow {
  source: Source;
  last_success_at: string | null;
  last_attempt_at: string | null;
  consecutive_failures: number;
}

/**
 * Reads all `source_health` rows, parsing the stored ISO-string timestamps
 * back to `Date | null` to match `core/schedule.ts`'s `SourceHealth` shape.
 */
export function getHealth(db: Db): SourceHealth[] {
  const rows = db
    .prepare(
      "SELECT source, last_success_at, last_attempt_at, consecutive_failures FROM source_health",
    )
    .all() as unknown as SourceHealthRow[];

  return rows.map((row) => ({
    source: row.source,
    lastSuccessAt: row.last_success_at === null
      ? null
      : new Date(row.last_success_at),
    lastAttemptAt: row.last_attempt_at === null
      ? null
      : new Date(row.last_attempt_at),
    consecutiveFailures: row.consecutive_failures,
  }));
}
