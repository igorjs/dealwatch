import { describe, expect, it } from "vitest";
import { parseColesPayload } from "./coles";
// Real capture from https://www.coles.com.au/on-special?filter_Special=halfprice
// on 2026-08-11, trimmed to the fields the parser reads. See its `_capture`
// note for what was dropped.
import fixture from "../../test/fixtures/coles.json";

function payloadWith(results: unknown[]): unknown {
  return { props: { pageProps: { searchResults: { noOfResults: results.length, results } } } };
}

describe("parseColesPayload", () => {
  it("returns exactly 3 deals from the real fixture, skipping the SINGLE_TILE ad entry", () => {
    // Arrange / Act
    const deals = parseColesPayload(fixture);

    // Assert
    expect(deals.length).toBe(3);
  });

  it("maps the first product's real fields onto a RawDeal", () => {
    // Arrange / Act
    const deals = parseColesPayload(fixture);
    const first = deals[0];

    // Assert
    expect(first?.title).toBe("Muffins English");
    expect(first?.priceCents).toBe(320);
    expect(first?.wasPriceCents).toBe(640);
    expect(first?.discountPercent).toBeNull();
    expect(first?.department).toBe("Packaged Breakfast Snacks");
    expect(first?.url).toBe(
      "https://www.coles.com.au/product/tip-top-muffins-english-400g-332394",
    );
  });

  it("derives the Philips product's url from brand, name, size and id", () => {
    // Arrange / Act
    const deals = parseColesPayload(fixture);
    const philips = deals.find((deal) => deal.title.includes("Sonicare"));

    // Assert
    expect(philips?.url).toBe(
      "https://www.coles.com.au/product/philips-sonicare-electric-toothbrush-series-1100-white-1-pack-1609540",
    );
  });

  it("gives a product with an empty onlineHeirs a null department instead of throwing", () => {
    // Arrange
    const payload = payloadWith([
      {
        _type: "PRODUCT",
        id: 1,
        name: "Mystery Item",
        brand: "Mystery",
        size: "1 Pack",
        onlineHeirs: [],
        pricing: { now: 1.5, was: 3 },
      },
    ]);

    // Act
    const deals = parseColesPayload(payload);

    // Assert
    expect(deals[0]?.department).toBeNull();
  });

  it("throws when a PRODUCT entry has no pricing", () => {
    // Arrange
    const payload = payloadWith([
      {
        _type: "PRODUCT",
        id: 2,
        name: "No Pricing Item",
        brand: "Mystery",
        size: "1 Pack",
        onlineHeirs: [],
      },
    ]);

    // Act + Assert
    expect(() => parseColesPayload(payload)).toThrow();
  });
});
