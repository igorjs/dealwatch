import { describe, expect, it } from "vitest";
import { parseColesPayload } from "./coles";
// PLACEHOLDER fixture, HIGH uncertainty: only Coles' GetProductCategories
// operation has been captured, not the half-price product-listing operation
// this schema/fixture models a best-effort guess at. See the note at the
// top of test/fixtures/coles.json and in coles.ts.
import fixture from "../../test/fixtures/coles.json";

describe("parseColesPayload", () => {
  it("maps the fixture to RawDeal[]", () => {
    // Arrange / Act
    const deals = parseColesPayload(fixture);

    // Assert
    expect(deals.length).toBe(3);
    for (const deal of deals) {
      expect(deal.source).toBe("coles");
      expect(deal.store).toBe("Coles");
      expect(deal.discountPercent).toBeNull();
      expect(typeof deal.priceCents).toBe("number");
    }
    expect(deals[0]?.title).toBe("Tim Tam Original 200g");
    expect(deals[0]?.url).toBe(
      "https://www.coles.com.au/product/tim-tam-original-200g-12345",
    );
    expect(deals[0]?.priceCents).toBe(250);
    expect(deals[0]?.wasPriceCents).toBe(500);
    expect(deals[0]?.department).toBe("Biscuits & Crackers");
    expect(deals[1]?.wasPriceCents).toBeNull();
    expect(deals[2]?.department).toBeNull();
  });

  it("returns [] for an empty results array", () => {
    // Arrange
    const payload = { data: { results: { results: [], totalCount: 0 } } };

    // Act
    const deals = parseColesPayload(payload);

    // Assert
    expect(deals).toEqual([]);
  });

  it("throws when an entry is missing a required field (name)", () => {
    // Arrange
    const payload = {
      data: {
        results: {
          results: [
            {
              id: 99999,
              brand: "Mystery",
              pricing: { now: 1.5, was: 3.0 },
              seoToken: "mystery-item-99999",
              onlineHeirs: [],
              // name intentionally missing
            },
          ],
          totalCount: 1,
        },
      },
    };

    // Act + Assert
    expect(() => parseColesPayload(payload)).toThrow();
  });

  it("throws on a wholly invalid payload", () => {
    // Act + Assert
    expect(() => parseColesPayload({ nope: true })).toThrow();
    expect(() => parseColesPayload("not an object")).toThrow();
    expect(() => parseColesPayload(null)).toThrow();
  });
});
