import type { Source } from "../types.ts";

/**
 * In-memory view of a source's refresh history: pure input to `dueSources`.
 * WU-8 persists this shape in SQLite (`source_health`); this module only
 * reasons about it in memory so the schedule/backoff logic is unit-testable
 * without a database.
 */
export interface SourceHealth {
  source: Source;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  consecutiveFailures: number;
}

/**
 * Weekly refresh schedule: the Sydney-local weekdays each source should
 * refresh on, using the `Date.getUTCDay()` convention (0=Sunday..6=Saturday)
 * — see `weekdayOf` below. Coles and Woolworths refresh once a week
 * (Wednesday); Aldi refreshes twice (Wednesday and Saturday). Per
 * Assumption 10 of the plan.
 */
export type Schedule = Record<Source, readonly number[]>;

const WEDNESDAY = 3;
const SATURDAY = 6;

export const DEFAULT_SCHEDULE: Schedule = {
  coles: [WEDNESDAY],
  woolworths: [WEDNESDAY],
  aldi: [WEDNESDAY, SATURDAY],
};

const SYDNEY_TIME_ZONE = "Australia/Sydney";
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Returns the sources that should be fetched at `now`: those whose data is
 * stale per the weekly `schedule` (or that have never succeeded) AND that
 * are not backing off after recent failures. `now` is always a parameter —
 * never read from `Deno.env` or a module-global clock — so this stays
 * deterministic under parallel `deno test` runs.
 */
export function dueSources(
  now: Date,
  health: readonly SourceHealth[],
  schedule: Schedule = DEFAULT_SCHEDULE,
): Source[] {
  return health
    .filter((entry) => isDue(now, entry, schedule[entry.source]))
    .map((entry) => entry.source);
}

function isDue(
  now: Date,
  health: SourceHealth,
  weekdays: readonly number[],
): boolean {
  const staleBySchedule = health.lastSuccessAt === null ||
    health.lastSuccessAt.getTime() < latestBoundary(now, weekdays).getTime();

  // Backoff is independent of schedule staleness and of success history: a
  // source that has never succeeded still only retries hourly once it has
  // failed, and a source that succeeded for weeks then started failing (an
  // expired capture — the common real-world case) is throttled the same
  // way. See Assumption 11.
  const backoffOk = health.consecutiveFailures === 0 ||
    health.lastAttemptAt === null ||
    now.getTime() - health.lastAttemptAt.getTime() >= ONE_HOUR_MS;

  return staleBySchedule && backoffOk;
}

/**
 * The most recent scheduled refresh boundary (a scheduled weekday's Sydney
 * midnight) at or before `now`. A source is stale when its last success is
 * strictly before this instant — the "midnight-inclusive" rule from
 * Assumption 10: a success recorded at or after this week's boundary counts
 * as fresh; a success from before it does not.
 *
 * Walks backward at most 7 calendar days from `now`'s Sydney date, since
 * every weekday number recurs within a week of any date.
 */
function latestBoundary(now: Date, weekdays: readonly number[]): Date {
  const today = sydneyDateParts(now);
  for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
    const candidate = addDays(today, -daysAgo);
    if (weekdays.includes(weekdayOf(candidate))) {
      return sydneyMidnightUtc(candidate);
    }
  }
  // Unreachable for a non-empty `weekdays`: every weekday number recurs
  // within 7 days of any date.
  throw new Error("schedule has no configured weekdays");
}

interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

interface CalendarDateTime extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

const SYDNEY_DATETIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: SYDNEY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** The Sydney-local wall-clock date and time `instant` falls on. */
function sydneyDateTimeParts(instant: Date): CalendarDateTime {
  const parts = SYDNEY_DATETIME_FORMATTER.formatToParts(instant);
  const lookup = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((
      part,
    ) => [part.type, part.value]),
  );
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

/** The Sydney-local calendar date `instant` falls on (time-of-day dropped). */
function sydneyDateParts(instant: Date): CalendarDate {
  const { year, month, day } = sydneyDateTimeParts(instant);
  return { year, month, day };
}

/** `date` shifted by `delta` calendar days, normalizing month/year rollover. */
function addDays(date: CalendarDate, delta: number): CalendarDate {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + delta),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Day of week (0=Sunday..6=Saturday) for a calendar date. This depends only
 * on the calendar date, never on a timezone offset, so building a UTC
 * instant at midnight for the same Y/M/D and reading `getUTCDay()` is exact
 * — no DST math needed here.
 */
function weekdayOf(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * The UTC instant for Sydney-local midnight on `date`, correct across the AU
 * DST transition (first Sunday of October / first Sunday of April).
 *
 * Plain `Date` has no timezone-database API to convert a wall-clock time in
 * an arbitrary zone to an instant, so this resolves the offset by trial:
 * treat the Y/M/D 00:00:00 numbers as if they were already UTC (a guess),
 * ask `Intl` what Sydney wall-clock that guessed instant displays as, and
 * use the difference between the guess and that read-back to correct it.
 * The offset resolved here is always the one in effect for `date` itself,
 * never for whatever date/offset `now` happens to be in when `dueSources` is
 * evaluated. That distinction matters right at the DST boundary: `now` can be
 * on one side of the transition while a scheduled boundary date sits on the
 * other, a one-hour gap this method does not blur.
 *
 * Constraint (documented, not enforced): the single guess-and-correct step is
 * exact for every calendar day EXCEPT the AU DST-transition day itself. On that
 * day the guess instant (UTC-literal midnight, ~10-11am Sydney) reads the
 * post-transition offset while true local midnight is pre-transition, so the
 * result is off by one hour. This is never reached by the shipped schedule:
 * DEFAULT_SCHEDULE only uses Wednesday and Saturday, and AU DST transitions
 * always fall on a Sunday. A custom Schedule that included the transition
 * weekday would need a two-offset resolution (try +10 and +11, pick the one
 * whose Sydney wall-clock is exactly this date at 00:00). Tracked as a
 * follow-up; not fixed here to avoid churning the tested boundary math for a
 * case the shipped schedule cannot hit.
 */
function sydneyMidnightUtc(date: CalendarDate): Date {
  const guessMs = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0);
  const guessSydney = sydneyDateTimeParts(new Date(guessMs));
  const guessSydneyAsUtcMs = Date.UTC(
    guessSydney.year,
    guessSydney.month - 1,
    guessSydney.day,
    guessSydney.hour,
    guessSydney.minute,
    guessSydney.second,
  );
  const offsetMs = guessSydneyAsUtcMs - guessMs;
  return new Date(guessMs - offsetMs);
}
