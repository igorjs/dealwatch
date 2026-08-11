import { describe, expect, it } from "vitest";
import { parseAldiPayload } from "./aldi";
// PLACEHOLDER fixture: no real Aldi product-search response is captured yet.
// See the note at the top of test/fixtures/aldi.json and in aldi.ts. Imported
// as a JSON module (not read off disk) since tests run inside the Workers
// runtime pool, which has no host filesystem access.
import aldiFixture from "../../test/fixtures/aldi.json";

function loadFixture(): unknown {
  return aldiFixture;
}

describe("parseAldiPayload", () => {
  it("maps the fixture to RawDeal[] with priceCents set and discountPercent null", () => {
    // Arrange
    const fixture = loadFixture();

    // Act
    const deals = parseAldiPayload(fixture);

    // Assert
    expect(deals.length).toBe(3);
    for (const deal of deals) {
      expect(deal.source).toBe("aldi");
      expect(deal.store).toBe("Aldi");
      expect(deal.discountPercent).toBeNull();
      // Keyword-only source: wasPriceCents stays null so normalize never derives
      // a discount that could gate the deal against a watch floor (Assumption 18).
      expect(deal.wasPriceCents).toBeNull();
      expect(typeof deal.priceCents).toBe("number");
    }
    expect(deals[0]?.title).toBe("Sourdough Vienna Loaf 660g");
    expect(deals[0]?.url).toBe(
      "https://www.aldi.com.au/product/bakers-life-sourdough-vienna-loaf-660g",
    );
    expect(deals[0]?.priceCents).toBe(349);
    expect(deals[0]?.department).toBe("Bakery");
    // deals[1]'s fixture carries a wasAmount, but Aldi deals never propagate it.
    expect(deals[1]?.wasPriceCents).toBeNull();
    expect(deals[2]?.department).toBeNull();
  });

  it("returns [] for an empty data array", () => {
    // Arrange
    const payload = { data: [] };

    // Act
    const deals = parseAldiPayload(payload);

    // Assert
    expect(deals).toEqual([]);
  });

  it("throws when an entry is missing a required field (name)", () => {
    // Arrange
    const payload = {
      data: [
        {
          sku: "000000042000099",
          price: { amount: 1.99, wasAmount: null },
          urlSlugText: "mystery-product",
          // name intentionally missing
        },
      ],
    };

    // Act + Assert
    expect(() => parseAldiPayload(payload)).toThrow();
  });

  it("throws on a wholly invalid payload", () => {
    // Act + Assert
    expect(() => parseAldiPayload({ nope: true })).toThrow();
    expect(() => parseAldiPayload("not an object")).toThrow();
    expect(() => parseAldiPayload(null)).toThrow();
  });
});
