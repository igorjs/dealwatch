import { assertEquals, assertThrows } from "@std/assert";
import {
  ConfigSchema,
  type Deal,
  DealSchema,
  type ListItem,
  ListItemSchema,
  type RawDeal,
  RawDealSchema,
  WatchSchema,
} from "./types.ts";

Deno.test("DealSchema parses a valid Deal object", () => {
  // Arrange
  const validDeal: Deal = {
    id: "abc123",
    source: "coles",
    store: "Coles Bondi Junction",
    title: "Chicken Breast 500g",
    url: "https://coles.com.au/product/chicken-breast-500g",
    category: "meat",
    priceCents: 500,
    wasPriceCents: 1000,
    discountPercent: 50,
    seenAt: "2026-07-31T00:00:00.000Z",
  };

  // Act
  const result = DealSchema.parse(validDeal);

  // Assert
  assertEquals(result, validDeal);
});

Deno.test("DealSchema throws when priceCents is a string instead of a number", () => {
  // Arrange
  const invalidDeal = {
    id: "abc123",
    source: "coles",
    store: "Coles Bondi Junction",
    title: "Chicken Breast 500g",
    url: "https://coles.com.au/product/chicken-breast-500g",
    category: "meat",
    priceCents: "5",
    wasPriceCents: 1000,
    discountPercent: 50,
    seenAt: "2026-07-31T00:00:00.000Z",
  };

  // Act & Assert
  assertThrows(() => DealSchema.parse(invalidDeal));
});

Deno.test("WatchSchema throws when term is missing", () => {
  // Arrange
  const invalidWatch = {
    minDiscountPercent: 50,
    exclude: [],
  };

  // Act & Assert
  assertThrows(() => WatchSchema.parse(invalidWatch));
});

Deno.test("WatchSchema throws when term is an empty string", () => {
  // Arrange
  const invalidWatch = {
    term: "",
    minDiscountPercent: 50,
    exclude: [],
  };

  // Act & Assert
  assertThrows(() => WatchSchema.parse(invalidWatch));
});

Deno.test("ConfigSchema parses a valid Config with a non-empty watchlist and all store profiles", () => {
  // Arrange
  const validConfig = {
    watchlist: [
      {
        term: "chicken breast",
        minDiscountPercent: 50,
        exclude: [],
      },
    ],
    sinks: {
      shoppingListPath: "./shopping-list.json",
      ntfy: {
        topicUrl: "https://ntfy.sh/dealwatch-alerts",
      },
    },
    stores: {
      aldi: {
        servicePoint: "https://api.aldi.com.au/v3/product-search",
        categoryKeys: ["fresh-food"],
      },
      coles: {
        url: "https://coles.com.au",
        headers: {},
      },
      woolworths: {
        url: "https://woolworths.com.au",
        headers: {},
      },
    },
  };

  // Act
  const result = ConfigSchema.parse(validConfig);

  // Assert
  assertEquals(result.watchlist.length, 1);
});

Deno.test("ConfigSchema throws when watchlist is empty", () => {
  // Arrange
  const invalidConfig = {
    watchlist: [],
    sinks: {
      shoppingListPath: "./shopping-list.json",
      ntfy: {
        topicUrl: "https://ntfy.sh/dealwatch-alerts",
      },
    },
    stores: {
      aldi: {
        servicePoint: "https://api.aldi.com.au/v3/product-search",
        categoryKeys: ["fresh-food"],
      },
      coles: {
        url: "https://coles.com.au",
        headers: {},
      },
      woolworths: {
        url: "https://woolworths.com.au",
        headers: {},
      },
    },
  };

  // Act & Assert
  assertThrows(() => ConfigSchema.parse(invalidConfig));
});

Deno.test("RawDealSchema parses a valid RawDeal object", () => {
  // Arrange
  const validRawDeal: RawDeal = {
    source: "woolworths",
    title: "Beef Mince 500g",
    url: "https://woolworths.com.au/product/beef-mince-500g",
    store: "Woolworths Rozelle",
    department: "Meat & Seafood",
    priceCents: 750,
    wasPriceCents: 1500,
    discountPercent: 50,
  };

  // Act
  const result = RawDealSchema.parse(validRawDeal);

  // Assert
  assertEquals(result, validRawDeal);
});

Deno.test("ListItemSchema parses a valid ListItem object", () => {
  // Arrange
  const validListItem: ListItem = {
    id: "abc123",
    title: "Chicken Breast 500g",
    store: "Coles Bondi Junction",
    url: "https://coles.com.au/product/chicken-breast-500g",
    category: "meat",
    priceCents: 500,
    status: "pending",
    addedAt: "2026-07-31T00:00:00.000Z",
  };

  // Act
  const result = ListItemSchema.parse(validListItem);

  // Assert
  assertEquals(result, validListItem);
});
