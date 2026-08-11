import { describe, expect, it } from "vitest";
import { parseWoolworthsPayload } from "./woolworths";
import fixture from "../../test/fixtures/woolworths.json";

describe("parseWoolworthsPayload", () => {
  it("maps the fixture to RawDeal[] with title/url/prices", () => {
    // Act
    const deals = parseWoolworthsPayload(fixture);

    // Assert
    expect(deals.length).toBe(3);
    for (const deal of deals) {
      expect(deal.source).toBe("woolworths");
      expect(deal.store).toBe("Woolworths");
      expect(deal.discountPercent).toBeNull();
      expect(typeof deal.priceCents).toBe("number");
    }
    expect(deals[0]?.title).toBe("Woolworths Full Cream Milk 3L");
    expect(deals[0]?.url).toBe(
      "https://www.woolworths.com.au/shop/productdetails/123456/woolworths-full-cream-milk-3l",
    );
    expect(deals[0]?.priceCents).toBe(450);
    expect(deals[0]?.wasPriceCents).toBe(900);
    expect(deals[0]?.department).toBe("Dairy, Eggs & Fridge");
    expect(deals[1]?.wasPriceCents).toBe(600);
    expect(deals[2]?.wasPriceCents).toBeNull();
    expect(deals[2]?.department).toBeNull();
  });

  it("returns [] when every bundle has an empty products array", () => {
    // Arrange
    const payload = { bundles: [{ products: [] }] };

    // Act
    const deals = parseWoolworthsPayload(payload);

    // Assert
    expect(deals).toEqual([]);
  });

  it("throws when an entry is missing a required field (name)", () => {
    // Arrange
    const payload = {
      bundles: [
        {
          products: [
            {
              stockcode: 999999,
              price: { price: 1.99, wasPrice: null },
              urlFriendlyName: "mystery-product",
              // name intentionally missing
            },
          ],
        },
      ],
    };

    // Act + Assert
    expect(() => parseWoolworthsPayload(payload)).toThrow();
  });

  it("throws on a wholly invalid payload", () => {
    // Act + Assert
    expect(() => parseWoolworthsPayload({ nope: true })).toThrow();
    expect(() => parseWoolworthsPayload("not an object")).toThrow();
    expect(() => parseWoolworthsPayload(null)).toThrow();
  });
});
