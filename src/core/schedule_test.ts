import { assertEquals } from "@std/assert";
import { dueSources, type SourceHealth } from "./schedule.ts";

/** A never-attempted, never-succeeded coles health record to mutate per test. */
function coles(overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    source: "coles",
    lastSuccessAt: null,
    lastAttemptAt: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

// Reference week (no DST in effect, Sydney is AEST, UTC+10 throughout):
// Wed 2026-08-05, Thu 2026-08-06, Sat 2026-08-08. Sydney-local midnight on
// 2026-08-05 is 2026-08-04T14:00:00Z (+10h offset). All instants below were
// cross-checked with Python's zoneinfo("Australia/Sydney").

/** Sydney 2026-08-06 10:00 (Thursday), one day past this week's Wednesday boundary. */
const NOW_THURSDAY = new Date("2026-08-06T00:00:00Z");

/** Sydney 2026-08-08 10:00 (Saturday), same week as NOW_THURSDAY. */
const NOW_SATURDAY = new Date("2026-08-08T00:00:00Z");

Deno.test("dueSources: succeeded this Wednesday, now Thursday -> not due", () => {
  // Arrange
  const health = [
    coles({
      // Sydney 2026-08-05 10:00: after this week's Wednesday-midnight boundary.
      lastSuccessAt: new Date("2026-08-05T00:00:00Z"),
    }),
  ];

  // Act
  const due = dueSources(NOW_THURSDAY, health);

  // Assert
  assertEquals(due, []);
});

Deno.test("dueSources: last success was last week -> due", () => {
  // Arrange
  const health = [
    coles({
      // Sydney 2026-07-29 10:00: last week's Wednesday, before this week's boundary.
      lastSuccessAt: new Date("2026-07-29T00:00:00Z"),
    }),
  ];

  // Act
  const due = dueSources(NOW_THURSDAY, health);

  // Assert
  assertEquals(due, ["coles"]);
});

Deno.test("dueSources: succeeded last week but backing off, last attempt 10 min ago -> not due", () => {
  // Arrange
  const health = [
    coles({
      lastSuccessAt: new Date("2026-07-29T00:00:00Z"),
      consecutiveFailures: 2,
      lastAttemptAt: new Date(NOW_THURSDAY.getTime() - 10 * 60 * 1000),
    }),
  ];

  // Act
  const due = dueSources(NOW_THURSDAY, health);

  // Assert: stale by schedule, but backoff (< 1h since last attempt) wins.
  assertEquals(due, []);
});

Deno.test("dueSources: succeeded last week, backoff window elapsed (70 min) -> due", () => {
  // Arrange
  const health = [
    coles({
      lastSuccessAt: new Date("2026-07-29T00:00:00Z"),
      consecutiveFailures: 2,
      lastAttemptAt: new Date(NOW_THURSDAY.getTime() - 70 * 60 * 1000),
    }),
  ];

  // Act
  const due = dueSources(NOW_THURSDAY, health);

  // Assert
  assertEquals(due, ["coles"]);
});

Deno.test("dueSources: never succeeded, backing off, last attempt 10 min ago -> not due", () => {
  // Arrange
  const health = [
    coles({
      lastSuccessAt: null,
      consecutiveFailures: 1,
      lastAttemptAt: new Date(NOW_THURSDAY.getTime() - 10 * 60 * 1000),
    }),
  ];

  // Act
  const due = dueSources(NOW_THURSDAY, health);

  // Assert
  assertEquals(due, []);
});

Deno.test("dueSources: never succeeded, backoff window elapsed (70 min) -> due", () => {
  // Arrange
  const health = [
    coles({
      lastSuccessAt: null,
      consecutiveFailures: 1,
      lastAttemptAt: new Date(NOW_THURSDAY.getTime() - 70 * 60 * 1000),
    }),
  ];

  // Act
  const due = dueSources(NOW_THURSDAY, health);

  // Assert
  assertEquals(due, ["coles"]);
});

Deno.test("dueSources: aldi refreshes Wed+Sat, so it's due again on Saturday despite succeeding this Wednesday", () => {
  // Arrange
  const health: SourceHealth[] = [
    {
      source: "aldi",
      // Sydney 2026-08-05 10:00: succeeded this Wednesday, before Saturday's boundary.
      lastSuccessAt: new Date("2026-08-05T00:00:00Z"),
      lastAttemptAt: null,
      consecutiveFailures: 0,
    },
  ];

  // Act
  const due = dueSources(NOW_SATURDAY, health);

  // Assert
  assertEquals(due, ["aldi"]);
});

Deno.test("dueSources: coles (Wednesday-only) stays fresh on the same Saturday aldi goes due", () => {
  // Arrange: proves the schedule descriptor differentiates sources by their
  // own weekday set, rather than "Saturday" being globally due for everyone.
  const health = [
    coles({
      lastSuccessAt: new Date("2026-08-05T00:00:00Z"),
    }),
  ];

  // Act
  const due = dueSources(NOW_SATURDAY, health);

  // Assert
  assertEquals(due, []);
});

// AU DST ends 2026-04-05 (first Sunday of April): clocks move from AEDT
// (+11) back to AEST (+10) at 03:00 local. This week's only scheduled
// weekday for coles is Wednesday 2026-04-01, still inside AEDT, so the true
// Sydney-midnight boundary is 2026-04-01T00:00+11:00 = 2026-03-31T13:00:00Z.
// A naive, non-DST-aware implementation that reused "now"'s AEST (+10)
// offset instead of resolving 2026-04-01's own AEDT (+11) offset would
// compute the boundary an hour later, at 2026-03-31T14:00:00Z.
//
// `now` below is Sydney 2026-04-05 04:00 (Sunday, just after the
// changeover, AEST +10) = 2026-04-04T18:00:00Z -- so "now" and the boundary
// date sit on opposite sides of the transition, exactly the case where a
// one-hour offset mixup would misclassify a success near the boundary.
const NOW_AFTER_DST_END = new Date("2026-04-04T18:00:00Z");

Deno.test("dueSources: DST boundary - success clearly before the true Wednesday boundary is due", () => {
  // Arrange
  const health = [
    coles({
      // 2026-03-31T12:30:00Z = Sydney 2026-03-31 23:30 (AEDT): Tuesday
      // night, before the Wednesday boundary under either offset reading.
      lastSuccessAt: new Date("2026-03-31T12:30:00Z"),
    }),
  ];

  // Act
  const due = dueSources(NOW_AFTER_DST_END, health);

  // Assert
  assertEquals(due, ["coles"]);
});

Deno.test("dueSources: DST boundary - success just after the true boundary is not misclassified as due", () => {
  // Arrange
  const health = [
    coles({
      // 2026-03-31T13:30:00Z: 30 min after the *true* AEDT boundary
      // (13:00Z), but 30 min before what a wrong, non-DST-aware +10 offset
      // would compute (14:00Z). A DST-unaware implementation would
      // misclassify this as stale/due; the correct one must not.
      lastSuccessAt: new Date("2026-03-31T13:30:00Z"),
    }),
  ];

  // Act
  const due = dueSources(NOW_AFTER_DST_END, health);

  // Assert
  assertEquals(due, []);
});
