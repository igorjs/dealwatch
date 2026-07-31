import { assertEquals } from "@std/assert";
import {
  filterNew,
  getHealth,
  openDb,
  recordAttempt,
  recordSeen,
} from "./db.ts";
import type { Deal, Source } from "../types.ts";

/** A minimal, valid Deal to mutate per test via overrides. */
function deal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: "deal-1",
    source: "coles",
    store: "Coles Test Store",
    title: "Test product",
    url: "https://coles.com.au/product/1",
    category: "other",
    priceCents: 500,
    wasPriceCents: 1000,
    discountPercent: 50,
    seenAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

Deno.test("filterNew drops an already-seen id and keeps a new one; recordSeen persists it", async () => {
  // Arrange: each test gets its own temp db file, cleaned up after.
  const path = await Deno.makeTempFile({ suffix: ".db" });
  const db = openDb(path);
  try {
    const seen = deal({ id: "seen-1" });
    const fresh = deal({ id: "fresh-1" });
    recordSeen(db, [seen]);

    // Act
    const firstPass = filterNew(db, [seen, fresh]);

    // Assert: only the never-seen id survives.
    assertEquals(firstPass.map((d) => d.id), ["fresh-1"]);

    // Act: persist the newly-seen deal, then filter again.
    recordSeen(db, [fresh]);
    const secondPass = filterNew(db, [seen, fresh]);

    // Assert: now both ids are known, nothing is new.
    assertEquals(secondPass, []);
  } finally {
    db.close();
    await Deno.remove(path);
  }
});

Deno.test("recordAttempt: two failures then a success resets consecutive_failures and sets last_success_at", async () => {
  // Arrange
  const path = await Deno.makeTempFile({ suffix: ".db" });
  const db = openDb(path);
  const source: Source = "coles";
  try {
    // Act
    recordAttempt(db, source, new Date("2026-07-30T00:00:00.000Z"), false);
    recordAttempt(db, source, new Date("2026-07-30T01:00:00.000Z"), false);
    recordAttempt(db, source, new Date("2026-07-30T02:00:00.000Z"), true);
    const health = getHealth(db);
    const colesHealth = health.find((entry) => entry.source === "coles");

    // Assert
    assertEquals(colesHealth?.consecutiveFailures, 0);
    assertEquals(
      colesHealth?.lastSuccessAt,
      new Date("2026-07-30T02:00:00.000Z"),
    );
    assertEquals(
      colesHealth?.lastAttemptAt,
      new Date("2026-07-30T02:00:00.000Z"),
    );
  } finally {
    db.close();
    await Deno.remove(path);
  }
});

Deno.test("recordAttempt: a single failure from a clean state sets consecutive_failures to 1, leaves last_success_at null", async () => {
  // Arrange
  const path = await Deno.makeTempFile({ suffix: ".db" });
  const db = openDb(path);
  const source: Source = "woolworths";
  try {
    // Act
    recordAttempt(db, source, new Date("2026-07-30T00:00:00.000Z"), false);
    const health = getHealth(db);
    const woolworthsHealth = health.find((entry) =>
      entry.source === "woolworths"
    );

    // Assert
    assertEquals(woolworthsHealth?.consecutiveFailures, 1);
    assertEquals(
      woolworthsHealth?.lastAttemptAt,
      new Date("2026-07-30T00:00:00.000Z"),
    );
    assertEquals(woolworthsHealth?.lastSuccessAt, null);
  } finally {
    db.close();
    await Deno.remove(path);
  }
});

Deno.test("openDb: migrating the same db path twice does not error", async () => {
  // Arrange
  const path = await Deno.makeTempFile({ suffix: ".db" });
  try {
    const first = openDb(path);
    first.close();

    // Act: re-opening (and re-migrating, CREATE TABLE IF NOT EXISTS) must not throw.
    const second = openDb(path);

    // Assert: the db is still usable and empty.
    assertEquals(getHealth(second), []);
    second.close();
  } finally {
    await Deno.remove(path);
  }
});
