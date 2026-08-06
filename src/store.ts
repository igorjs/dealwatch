import { z } from "zod";
import { SourceSchema, type Deal, type Source } from "./types";

/**
 * Per-source fetch health: when it last succeeded/was attempted, and how
 * many attempts have failed in a row since the last success. Mirrors v1's
 * `core/schedule.ts` `SourceHealth` shape (that module has no v2 port; this
 * is the only place the type is still needed).
 */
export interface SourceHealth {
  source: Source;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  consecutiveFailures: number;
}

/**
 * Returns only the deals whose id is not already recorded in `seen_deal`.
 * One `SELECT 1 ... WHERE id = ?` per deal, sent as a single `db.batch()`
 * round-trip rather than N sequential awaits.
 */
export async function filterNew(
  db: D1Database,
  deals: Deal[],
): Promise<Deal[]> {
  if (deals.length === 0) return [];

  const stmt = db.prepare("SELECT 1 FROM seen_deal WHERE id = ?");
  const results = await db.batch(
    deals.map((deal) => stmt.bind(deal.id)),
  );

  return deals.filter((_deal, index) => results[index]?.results.length === 0);
}

/**
 * Persists `deals` into `seen_deal`, keyed by id. Already-recorded ids are
 * left untouched (`INSERT OR IGNORE`), so this is safe to call with deals
 * that overlap a previous run.
 */
export async function recordSeen(
  db: D1Database,
  deals: Deal[],
): Promise<void> {
  if (deals.length === 0) return;

  const stmt = db.prepare(
    "INSERT OR IGNORE INTO seen_deal (id, source, title, url, first_seen_at) VALUES (?, ?, ?, ?, ?)",
  );
  await db.batch(
    deals.map((deal) =>
      stmt.bind(deal.id, deal.source, deal.title, deal.url, deal.seenAt)
    ),
  );
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
export async function recordAttempt(
  db: D1Database,
  source: Source,
  now: Date,
  ok: boolean,
): Promise<void> {
  const nowIso = now.toISOString();
  if (ok) {
    await db.prepare(UPSERT_SUCCESS).bind(source, nowIso, nowIso).run();
  } else {
    await db.prepare(UPSERT_FAILURE).bind(source, nowIso).run();
  }
}

/** The shape of a `source_health` row as it crosses the D1 boundary. */
const SourceHealthRowSchema = z.object({
  source: SourceSchema,
  last_success_at: z.string().nullable(),
  last_attempt_at: z.string().nullable(),
  consecutive_failures: z.number(),
});

/**
 * Reads all `source_health` rows, parsing the stored ISO-string timestamps
 * back to `Date | null`. Each row is parsed with zod (never cast) since a
 * D1 row is a trust boundary.
 */
export async function getHealth(db: D1Database): Promise<SourceHealth[]> {
  const { results } = await db
    .prepare(
      "SELECT source, last_success_at, last_attempt_at, consecutive_failures FROM source_health",
    )
    .all();

  return results.map((rawRow) => {
    const row = SourceHealthRowSchema.parse(rawRow);
    return {
      source: row.source,
      lastSuccessAt: row.last_success_at === null
        ? null
        : new Date(row.last_success_at),
      lastAttemptAt: row.last_attempt_at === null
        ? null
        : new Date(row.last_attempt_at),
      consecutiveFailures: row.consecutive_failures,
    };
  });
}
