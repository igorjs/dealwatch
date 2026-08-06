import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CorruptListFileError,
  groupByCategory,
  readList,
  upsertList,
} from "./listStore";
import type { Deal, ListItem } from "./types";

/** A minimal, valid Deal to mutate per test via overrides. */
function deal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: "deal-1",
    source: "coles",
    store: "Coles Test Store",
    title: "Test product",
    url: "https://coles.com.au/product/1",
    category: "grocery",
    priceCents: 500,
    wasPriceCents: 1000,
    discountPercent: 50,
    seenAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Storage is isolated per test *file*, not per test (see vitest.config.ts).
 * So every test in this file shares one R2 bucket; each test must use its
 * own unique object key so tests can't collide with each other.
 */
function uniqueKey(): string {
  return `shopping-list-${crypto.randomUUID()}.json`;
}

async function readRawObject(
  key: string,
): Promise<Record<string, ListItem>> {
  const object = await env.LIST.get(key);
  if (object === null) {
    throw new Error(`expected object at "${key}" to exist`);
  }
  return JSON.parse(await object.text());
}

describe("upsertList", () => {
  it("creates the object when absent, with the given items", async () => {
    // Arrange
    const key = uniqueKey();
    const d = deal();

    // Act
    await upsertList(env.LIST, [d], key);

    // Assert
    const stored = await readRawObject(key);
    expect(Object.keys(stored)).toEqual(["deal-1"]);
    expect(stored["deal-1"]).toEqual({
      id: "deal-1",
      title: "Test product",
      store: "Coles Test Store",
      url: "https://coles.com.au/product/1",
      category: "grocery",
      priceCents: 500,
      status: "pending",
      addedAt: "2026-07-31T00:00:00.000Z",
    });
  });

  it("upserting the same deal id twice yields exactly one entry, updated in place", async () => {
    // Arrange
    const key = uniqueKey();
    const first = deal({ title: "Original title" });
    const second = deal({ title: "Updated title" });

    // Act
    await upsertList(env.LIST, [first], key);
    await upsertList(env.LIST, [second], key);

    // Assert: still one entry, and it reflects the latest upsert.
    const stored = await readRawObject(key);
    expect(Object.keys(stored)).toEqual(["deal-1"]);
    expect(stored["deal-1"]?.title).toBe("Updated title");
  });

  it("re-upserting an existing id with a changed category updates the stored category", async () => {
    // Arrange
    const key = uniqueKey();
    await upsertList(env.LIST, [deal({ category: "grocery" })], key);

    // Act
    await upsertList(env.LIST, [deal({ category: "dairy" })], key);

    // Assert
    const stored = await readRawObject(key);
    expect(stored["deal-1"]?.category).toBe("dairy");
  });

  it("does not reset a pre-existing 'bought' item back to 'pending' on re-upsert", async () => {
    // Arrange: seed the object directly with a "bought" item, addedAt
    // distinct from the deal's seenAt so preservation is actually
    // observable.
    const key = uniqueKey();
    const boughtItem: ListItem = {
      id: "deal-1",
      title: "Test product",
      store: "Coles Test Store",
      url: "https://coles.com.au/product/1",
      category: "grocery",
      priceCents: 500,
      status: "bought",
      addedAt: "2026-07-01T00:00:00.000Z",
    };
    await env.LIST.put(key, JSON.stringify({ "deal-1": boughtItem }));

    // Act: re-upsert the same id with a newer seenAt and a changed title.
    await upsertList(
      env.LIST,
      [deal({ title: "Restocked title", seenAt: "2026-07-31T00:00:00.000Z" })],
      key,
    );

    // Assert: status and addedAt preserved; other fields refreshed.
    const stored = await readRawObject(key);
    expect(stored["deal-1"]?.status).toBe("bought");
    expect(stored["deal-1"]?.addedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(stored["deal-1"]?.title).toBe("Restocked title");
  });

  it("throws CorruptListFileError when the existing object is not valid JSON", async () => {
    // Arrange
    const key = uniqueKey();
    await env.LIST.put(key, "{ not valid json");

    // Act + Assert
    await expect(upsertList(env.LIST, [deal()], key)).rejects.toThrow(
      CorruptListFileError,
    );

    // Assert: the corrupt object was left untouched, not silently reset.
    const object = await env.LIST.get(key);
    expect(await object?.text()).toBe("{ not valid json");
  });
});

describe("readList", () => {
  it("returns an empty grouping when the object is absent", async () => {
    // Arrange
    const key = uniqueKey();

    // Act
    const result = await readList(env.LIST, key);

    // Assert
    expect(result).toEqual({});
  });

  it("returns the current object's items grouped by category", async () => {
    // Arrange
    const key = uniqueKey();
    await upsertList(env.LIST, [deal({ id: "deal-a", category: "grocery" })], key);
    await upsertList(env.LIST, [deal({ id: "deal-b", category: "dairy" })], key);

    // Act
    const result = await readList(env.LIST, key);

    // Assert
    expect(Object.keys(result).sort()).toEqual(["dairy", "grocery"]);
    expect(result["grocery"]?.map((item) => item.id)).toEqual(["deal-a"]);
    expect(result["dairy"]?.map((item) => item.id)).toEqual(["deal-b"]);
  });

  it("throws CorruptListFileError when the existing object is not valid JSON", async () => {
    // Arrange
    const key = uniqueKey();
    await env.LIST.put(key, "{ not valid json");

    // Act + Assert
    await expect(readList(env.LIST, key)).rejects.toThrow(
      CorruptListFileError,
    );
  });
});

describe("groupByCategory", () => {
  it("groups items across two categories", () => {
    // Arrange
    const grocery: ListItem = {
      id: "a",
      title: "Olive oil",
      store: "Coles",
      url: "https://coles.com.au/a",
      category: "grocery",
      priceCents: 500,
      status: "pending",
      addedAt: "2026-07-31T00:00:00.000Z",
    };
    const dairy: ListItem = {
      id: "b",
      title: "Cheese",
      store: "Coles",
      url: "https://coles.com.au/b",
      category: "dairy",
      priceCents: 300,
      status: "pending",
      addedAt: "2026-07-31T00:00:00.000Z",
    };

    // Act
    const grouped = groupByCategory([grocery, dairy]);

    // Assert
    expect(grouped).toEqual({
      grocery: [grocery],
      dairy: [dairy],
    });
  });
});
