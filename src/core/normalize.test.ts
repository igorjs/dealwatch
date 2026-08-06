import { describe, expect, it } from "vitest";
import { normalize } from "./normalize";
import type { RawDeal } from "../types";
import { stableId } from "./id";

const NOW = new Date("2026-07-31T10:00:00.000Z");

describe("normalize", () => {
  it("builds a Deal from a Coles RawDeal with a computed discount", () => {
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
    expect(deal.id).toBe(stableId("coles", raw.url));
    expect(deal.category).toBe("pantry");
    expect(deal.discountPercent).toBe(50);
    expect(deal.priceCents).toBe(500);
    expect(deal.wasPriceCents).toBe(1000);
    expect(deal.seenAt).toBe(NOW.toISOString());
    expect(deal.source).toBe("coles");
    expect(deal.store).toBe("Coles Northcote");
    expect(deal.title).toBe("Olive Oil 1L");
    expect(deal.url).toBe(raw.url);
  });

  it("maps a Woolworths RawDeal to the right category", () => {
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
    expect(deal.category).toBe("meat-seafood");
  });

  it("preserves priceCents and leaves discountPercent null for a keyword-only Aldi RawDeal", () => {
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
    expect(deal.discountPercent).toBeNull();
    expect(deal.priceCents).toBe(300);
    expect(deal.category).toBe("other");
  });

  it("prefers a source-provided discountPercent over the computed one", () => {
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
    expect(deal.discountPercent).toBe(75);
  });

  it("assigns the same Deal.id to equivalent URLs (query vs trailing slash)", () => {
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
    expect(dealA.id).toBe(dealB.id);
  });
});
