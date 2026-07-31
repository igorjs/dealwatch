import { assertEquals, assertThrows } from "@std/assert";
import {
  CorruptListFileError,
  groupByCategory,
  upsert,
} from "./shoppingList.ts";
import type { Deal, ListItem } from "../types.ts";

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

function readStoreFile(path: string): Record<string, ListItem> {
  return JSON.parse(Deno.readTextFileSync(path));
}

Deno.test("upsert: no file at path creates it with the given items", async () => {
  // Arrange
  const dir = await Deno.makeTempDir();
  const path = `${dir}/shopping-list.json`;
  try {
    const d = deal();

    // Act
    upsert([d], path);

    // Assert
    const stored = readStoreFile(path);
    assertEquals(Object.keys(stored), ["deal-1"]);
    assertEquals(stored["deal-1"], {
      id: "deal-1",
      title: "Test product",
      store: "Coles Test Store",
      url: "https://coles.com.au/product/1",
      category: "grocery",
      priceCents: 500,
      status: "pending",
      addedAt: "2026-07-31T00:00:00.000Z",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsert: upserting the same deal twice yields exactly one entry, updated in place", async () => {
  // Arrange
  const dir = await Deno.makeTempDir();
  const path = `${dir}/shopping-list.json`;
  try {
    const first = deal({ title: "Original title" });
    const second = deal({ title: "Updated title" });

    // Act
    upsert([first], path);
    upsert([second], path);

    // Assert: still one entry, and it reflects the latest upsert.
    const stored = readStoreFile(path);
    assertEquals(Object.keys(stored), ["deal-1"]);
    assertEquals(stored["deal-1"].title, "Updated title");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsert: re-upserting an existing id with a changed category updates the stored category", async () => {
  // Arrange
  const dir = await Deno.makeTempDir();
  const path = `${dir}/shopping-list.json`;
  try {
    upsert([deal({ category: "grocery" })], path);

    // Act
    upsert([deal({ category: "dairy" })], path);

    // Assert
    const stored = readStoreFile(path);
    assertEquals(stored["deal-1"].category, "dairy");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsert: a pre-existing item with status 'bought' is not reset to 'pending' on re-upsert", async () => {
  // Arrange: seed the file directly with a "bought" item, addedAt distinct
  // from the deal's seenAt so preservation is actually observable.
  const dir = await Deno.makeTempDir();
  const path = `${dir}/shopping-list.json`;
  try {
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
    Deno.writeTextFileSync(path, JSON.stringify({ "deal-1": boughtItem }));

    // Act: re-upsert the same id with a newer seenAt and a changed title.
    upsert(
      [deal({ title: "Restocked title", seenAt: "2026-07-31T00:00:00.000Z" })],
      path,
    );

    // Assert: status and addedAt preserved; other fields refreshed.
    const stored = readStoreFile(path);
    assertEquals(stored["deal-1"].status, "bought");
    assertEquals(stored["deal-1"].addedAt, "2026-07-01T00:00:00.000Z");
    assertEquals(stored["deal-1"].title, "Restocked title");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsert: a corrupt (non-JSON) existing file throws CorruptListFileError", async () => {
  // Arrange
  const dir = await Deno.makeTempDir();
  const path = `${dir}/shopping-list.json`;
  try {
    Deno.writeTextFileSync(path, "{ not valid json");

    // Act + Assert
    const err = assertThrows(
      () => upsert([deal()], path),
      CorruptListFileError,
    );
    assertEquals(err.name, "CorruptListFileError");

    // Assert: the corrupt file was left untouched, not silently reset.
    assertEquals(Deno.readTextFileSync(path), "{ not valid json");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("groupByCategory: groups items across two categories", () => {
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
  assertEquals(grouped, {
    grocery: [grocery],
    dairy: [dairy],
  });
});
