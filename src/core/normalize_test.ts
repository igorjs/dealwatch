import { assertEquals } from "@std/assert";
import { normalize } from "./normalize.ts";
import type { RawDeal } from "../types.ts";
import { stableId } from "./id.ts";

const NOW = new Date("2026-07-31T10:00:00.000Z");

Deno.test("normalize builds a Deal from a Coles RawDeal with a computed discount", () => {
  // Arrange
  const raw: RawDeal = {
    source: "coles",
    title: "Olive Oil 1L",
    url: "https://coles.com.au/product/olive-oil?utm=1",
    store: "Coles Northcote",
    department: "Pantry",
    priceCents: 500,
    wasPriceCents: 1000,
    discountPercent: null,
  };

  // Act
  const deal = normalize(raw, NOW);

  // Assert
  assertEquals(deal.id, stableId("coles", raw.url));
  assertEquals(deal.category, "pantry");
  assertEquals(deal.discountPercent, 50);
  assertEquals(deal.priceCents, 500);
  assertEquals(deal.wasPriceCents, 1000);
  assertEquals(deal.seenAt, NOW.toISOString());
  assertEquals(deal.source, "coles");
  assertEquals(deal.store, "Coles Northcote");
  assertEquals(deal.title, "Olive Oil 1L");
  assertEquals(deal.url, raw.url);
});

Deno.test("normalize maps a Woolworths RawDeal to the right category", () => {
  // Arrange
  const raw: RawDeal = {
    source: "woolworths",
    title: "Beef Mince 500g",
    url: "https://woolworths.com.au/product/beef-mince",
    store: "Woolworths Fitzroy",
    department: "Meat & Seafood",
    priceCents: 800,
    wasPriceCents: 1000,
    discountPercent: null,
  };

  // Act
  const deal = normalize(raw, NOW);

  // Assert
  assertEquals(deal.category, "meat-seafood");
});

Deno.test("normalize preserves priceCents and leaves discountPercent null for a keyword-only Aldi RawDeal", () => {
  // Arrange
  const raw: RawDeal = {
    source: "aldi",
    title: "Sourdough Loaf",
    url: "https://aldi.com.au/product/sourdough-loaf",
    store: "Aldi Preston",
    department: null,
    priceCents: 300,
    wasPriceCents: null,
    discountPercent: null,
  };

  // Act
  const deal = normalize(raw, NOW);

  // Assert
  assertEquals(deal.discountPercent, null);
  assertEquals(deal.priceCents, 300);
  assertEquals(deal.category, "other");
});

Deno.test("normalize prefers a source-provided discountPercent over the computed one", () => {
  // Arrange
  const raw: RawDeal = {
    source: "coles",
    title: "Pasta Sauce 500g",
    url: "https://coles.com.au/product/pasta-sauce",
    store: "Coles Northcote",
    department: "Pantry",
    priceCents: 500,
    wasPriceCents: 1000,
    discountPercent: 75,
  };

  // Act
  const deal = normalize(raw, NOW);

  // Assert
  assertEquals(deal.discountPercent, 75);
});

Deno.test("normalize assigns the same Deal.id to equivalent URLs (query vs trailing slash)", () => {
  // Arrange
  const base: RawDeal = {
    source: "coles",
    title: "Olive Oil 1L",
    url: "https://coles.com.au/product/olive-oil?utm=1",
    store: "Coles Northcote",
    department: "Pantry",
    priceCents: 500,
    wasPriceCents: 1000,
    discountPercent: null,
  };
  const withTrailingSlash: RawDeal = {
    ...base,
    url: "https://coles.com.au/product/olive-oil/",
  };

  // Act
  const dealA = normalize(base, NOW);
  const dealB = normalize(withTrailingSlash, NOW);

  // Assert
  assertEquals(dealA.id, dealB.id);
});
