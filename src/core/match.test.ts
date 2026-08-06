import { describe, expect, it } from "vitest";
import { match } from "./match";
import type { Deal, Watch } from "../types";

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

describe("match word boundary", () => {
  it.each([
    ["Engine coil replacement", false],
    ["Car spoiler kit", false],
    ["Olive Oil 500ml", true],
  ])("title %s matches term 'oil' -> %s", (title, expected) => {
    // Arrange
    const watchlist: Watch[] = [{
      term: "oil",
      minDiscountPercent: 0,
      exclude: [],
    }];
    const deal = makeDeal({ title });

    // Act
    const result = match(deal, watchlist);

    // Assert
    expect(result).toBe(expected);
  });

  it("matches case-insensitively", () => {
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
    expect(result).toBe(true);
  });

  it("matches non-ASCII terms at a Unicode word boundary and rejects mid-word", () => {
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
    expect(acaiResult).toBe(true);
    expect(cafeResult).toBe(true);
    expect(midWordResult).toBe(false);
  });

  it("matches a term containing '%' literally, satisfied at a word boundary", () => {
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
    expect(result).toBe(true);
  });

  it("matches a term containing '.' literally, not as a regex wildcard", () => {
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
    expect(literalResult).toBe(true);
    expect(wildcardTrapResult).toBe(false);
  });
});

describe("match discount floor", () => {
  it("matches when discountPercent is exactly at the watch floor", () => {
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
    expect(result).toBe(true);
  });

  it("does not match when discountPercent is below the watch floor", () => {
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
    expect(result).toBe(false);
  });

  it("matches on keyword alone when discountPercent is null, e.g. Aldi", () => {
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
    expect(result).toBe(true);
  });
});

describe("match exclude terms", () => {
  it("rejects an otherwise matching deal whose title contains an exclude term", () => {
    // Arrange
    const watchlist: Watch[] = [
      { term: "oil", minDiscountPercent: 0, exclude: ["olive"] },
    ];
    const deal = makeDeal({ title: "Olive Oil 500ml" });

    // Act
    const result = match(deal, watchlist);

    // Assert
    expect(result).toBe(false);
  });
});

describe("match against a watchlist", () => {
  it("returns false when the deal matches none of the watchlist", () => {
    // Arrange
    const watchlist: Watch[] = [
      { term: "oil", minDiscountPercent: 50, exclude: [] },
      { term: "bread", minDiscountPercent: 30, exclude: [] },
    ];
    const deal = makeDeal({ title: "Fresh Salmon Fillet", discountPercent: 90 });

    // Act
    const result = match(deal, watchlist);

    // Assert
    expect(result).toBe(false);
  });

  it("returns true when the deal matches the second of multiple watch entries", () => {
    // Arrange
    const watchlist: Watch[] = [
      { term: "oil", minDiscountPercent: 50, exclude: [] },
      { term: "bread", minDiscountPercent: 30, exclude: [] },
    ];
    const deal = makeDeal({ title: "Sourdough Bread Loaf", discountPercent: 40 });

    // Act
    const result = match(deal, watchlist);

    // Assert
    expect(result).toBe(true);
  });
});
