import { assertEquals } from "@std/assert";
import { match } from "./match.ts";
import type { Deal, Watch } from "../types.ts";

/** A minimal, valid Deal shared across tests as a base to override. */
function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: "deal-1",
    source: "coles",
    store: "Coles Test Store",
    title: "Generic Product",
    url: "https://coles.com.au/product/generic",
    category: "other",
    priceCents: 500,
    wasPriceCents: 1000,
    discountPercent: 50,
    seenAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

Deno.test("watch term does not match when the title only contains it mid-word", () => {
  // Arrange
  const watchlist: Watch[] = [{
    term: "oil",
    minDiscountPercent: 0,
    exclude: [],
  }];
  const dealCoil = makeDeal({ title: "Engine coil replacement" });
  const dealSpoiler = makeDeal({ title: "Car spoiler kit" });

  // Act
  const coilResult = match(dealCoil, watchlist);
  const spoilerResult = match(dealSpoiler, watchlist);

  // Assert
  assertEquals(coilResult, false);
  assertEquals(spoilerResult, false);
});

Deno.test("watch term matches a whole-word occurrence in the title", () => {
  // Arrange
  const watchlist: Watch[] = [{
    term: "oil",
    minDiscountPercent: 0,
    exclude: [],
  }];
  const deal = makeDeal({ title: "Olive Oil 500ml" });

  // Act
  const result = match(deal, watchlist);

  // Assert
  assertEquals(result, true);
});

Deno.test("watch term match is case-insensitive", () => {
  // Arrange
  const watchlist: Watch[] = [{
    term: "Oil",
    minDiscountPercent: 0,
    exclude: [],
  }];
  const deal = makeDeal({ title: "olive oil 500ml" });

  // Act
  const result = match(deal, watchlist);

  // Assert
  assertEquals(result, true);
});

Deno.test("watch term with non-ASCII letters matches at a Unicode word boundary", () => {
  // Arrange
  const watchlist: Watch[] = [
    { term: "açaí", minDiscountPercent: 0, exclude: [] },
    { term: "café", minDiscountPercent: 0, exclude: [] },
  ];
  const acaiDeal = makeDeal({ title: "Fresh Açaí Bowl 200g" });
  const cafeDeal = makeDeal({ title: "Café Blend Ground Coffee 1kg" });
  const midWordDeal = makeDeal({ title: "Uncafé mystery pack" });

  // Act
  const acaiResult = match(acaiDeal, watchlist);
  const cafeResult = match(cafeDeal, watchlist);
  const midWordResult = match(midWordDeal, watchlist);

  // Assert
  assertEquals(acaiResult, true);
  assertEquals(cafeResult, true);
  assertEquals(midWordResult, false);
});

Deno.test("deal discountPercent exactly at the watch floor matches", () => {
  // Arrange
  const watchlist: Watch[] = [{
    term: "oil",
    minDiscountPercent: 50,
    exclude: [],
  }];
  const deal = makeDeal({ title: "Olive Oil 500ml", discountPercent: 50 });

  // Act
  const result = match(deal, watchlist);

  // Assert
  assertEquals(result, true);
});

Deno.test("deal discountPercent below the watch floor does not match", () => {
  // Arrange
  const watchlist: Watch[] = [{
    term: "oil",
    minDiscountPercent: 50,
    exclude: [],
  }];
  const deal = makeDeal({ title: "Olive Oil 500ml", discountPercent: 49 });

  // Act
  const result = match(deal, watchlist);

  // Assert
  assertEquals(result, false);
});

Deno.test("an exclude term present in the title rejects an otherwise matching deal", () => {
  // Arrange
  const watchlist: Watch[] = [
    { term: "oil", minDiscountPercent: 0, exclude: ["olive"] },
  ];
  const deal = makeDeal({ title: "Olive Oil 500ml" });

  // Act
  const result = match(deal, watchlist);

  // Assert
  assertEquals(result, false);
});

Deno.test("a null discountPercent matches on keyword alone, e.g. Aldi", () => {
  // Arrange
  const watchlist: Watch[] = [{
    term: "oil",
    minDiscountPercent: 50,
    exclude: [],
  }];
  const deal = makeDeal({ title: "Olive Oil 500ml", discountPercent: null });

  // Act
  const result = match(deal, watchlist);

  // Assert
  assertEquals(result, true);
});

Deno.test("a term containing '%' matches literally, satisfied at a word boundary", () => {
  // Arrange
  const watchlist: Watch[] = [{
    term: "50%off",
    minDiscountPercent: 0,
    exclude: [],
  }];
  const deal = makeDeal({ title: "Grab the 50%off bundle" });

  // Act
  const result = match(deal, watchlist);

  // Assert
  assertEquals(result, true);
});

Deno.test("a term containing '.' matches literally, not as a regex wildcard", () => {
  // Arrange
  const watchlist: Watch[] = [{
    term: "5.0",
    minDiscountPercent: 0,
    exclude: [],
  }];
  const literalDeal = makeDeal({ title: "Cola 5.0 Zero Sugar 1L" });
  const wildcardTrapDeal = makeDeal({ title: "Cola 5X0 Zero Sugar 1L" });

  // Act
  const literalResult = match(literalDeal, watchlist);
  const wildcardTrapResult = match(wildcardTrapDeal, watchlist);

  // Assert
  assertEquals(literalResult, true);
  assertEquals(wildcardTrapResult, false);
});

Deno.test("a deal matching none of the watchlist returns false", () => {
  // Arrange
  const watchlist: Watch[] = [
    { term: "oil", minDiscountPercent: 50, exclude: [] },
    { term: "bread", minDiscountPercent: 30, exclude: [] },
  ];
  const deal = makeDeal({ title: "Fresh Salmon Fillet", discountPercent: 90 });

  // Act
  const result = match(deal, watchlist);

  // Assert
  assertEquals(result, false);
});

Deno.test("a deal matching the second of multiple watch entries returns true", () => {
  // Arrange
  const watchlist: Watch[] = [
    { term: "oil", minDiscountPercent: 50, exclude: [] },
    { term: "bread", minDiscountPercent: 30, exclude: [] },
  ];
  const deal = makeDeal({ title: "Sourdough Bread Loaf", discountPercent: 40 });

  // Act
  const result = match(deal, watchlist);

  // Assert
  assertEquals(result, true);
});
