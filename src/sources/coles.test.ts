import { describe, expect, it, vi } from "vitest";
import { fetchColesViaBrowser, parseColesPayload } from "./coles";
import { SourceError } from "./errors";
import type { PageLike } from "../browser";
import type { RawDeal } from "../types";
// PLACEHOLDER fixture, HIGH uncertainty: only Coles' GetProductCategories
// operation has been captured, not the half-price product-listing operation
// this schema/fixture models a best-effort guess at. See the note at the
// top of test/fixtures/coles.json and in coles.ts.
import fixture from "../../test/fixtures/coles.json";

/** A GetProductCategories-shaped payload: same /api/graphql URL, wrong shape. */
const CATEGORY_TREE_PAYLOAD = {
  data: {
    categories: [{ id: "1", name: "Fruit & Veg" }],
  },
};

/** A fake PageLike whose waitForResponse can be scripted call-by-call. */
function fakePage(
  overrides: Partial<PageLike> = {},
): PageLike {
  return {
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    evaluate: vi.fn().mockResolvedValue(undefined),
    waitForResponse: vi.fn().mockResolvedValue({
      url: () => "https://www.coles.com.au/api/graphql",
      json: () => Promise.resolve(fixture),
    }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return { url: () => "https://www.coles.com.au/api/graphql", json: () => Promise.resolve(body) };
}

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

describe("fetchColesViaBrowser", () => {
  it("parses a matching intercepted graphql response into RawDeal[]", async () => {
    // Arrange
    const page = fakePage();

    // Act
    const deals = await fetchColesViaBrowser(page);

    // Assert
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.coles.com.au/on-special?filter_Special=halfprice",
      expect.objectContaining({ waitUntil: expect.anything() }),
    );
    expect(page.waitForResponse).toHaveBeenCalledTimes(1);
    expect(deals.length).toBe(3);
    const deal = deals[0] as RawDeal;
    expect(deal.source).toBe("coles");
  });

  it("skips a non-matching GetProductCategories-shaped response and picks the next matching one", async () => {
    // Arrange: first graphql call resolves to the category tree (wrong
    // shape), second resolves to the real product-listing fixture.
    const waitForResponse = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CATEGORY_TREE_PAYLOAD))
      .mockResolvedValueOnce(jsonResponse(fixture));
    const page = fakePage({ waitForResponse });

    // Act
    const deals = await fetchColesViaBrowser(page);

    // Assert: navigated once, but waited for a graphql response twice
    // before finding one that matched the product-listing shape.
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(waitForResponse).toHaveBeenCalledTimes(2);
    expect(deals.length).toBe(3);
  });

  it("throws SourceError when no response matches the expected shape within the attempt cap", async () => {
    // Arrange: every graphql call resolves to the wrong shape.
    const waitForResponse = vi.fn().mockResolvedValue(jsonResponse(CATEGORY_TREE_PAYLOAD));
    const page = fakePage({ waitForResponse });

    // Act + Assert
    await expect(fetchColesViaBrowser(page)).rejects.toBeInstanceOf(SourceError);
    // Bounded: gives up after the attempt cap rather than looping forever.
    expect(waitForResponse.mock.calls.length).toBeGreaterThan(1);
    expect(waitForResponse.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("throws SourceError when waitForResponse times out with no matching response", async () => {
    // Arrange
    const page = fakePage({
      waitForResponse: vi.fn().mockRejectedValue(new Error("waitForResponse timeout")),
    });

    // Act + Assert
    await expect(fetchColesViaBrowser(page)).rejects.toBeInstanceOf(SourceError);
  });

  it("throws SourceError when page.goto fails (e.g. navigation timeout)", async () => {
    // Arrange
    const page = fakePage({
      goto: vi.fn().mockRejectedValue(new Error("navigation timeout")),
    });

    // Act + Assert
    await expect(fetchColesViaBrowser(page)).rejects.toBeInstanceOf(SourceError);
  });

  it("throws SourceError on a malformed/unparseable body (json() rejects)", async () => {
    // Arrange
    const page = fakePage({
      waitForResponse: vi.fn().mockResolvedValue({
        url: () => "https://www.coles.com.au/api/graphql",
        json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
      }),
    });

    // Act + Assert
    await expect(fetchColesViaBrowser(page)).rejects.toBeInstanceOf(SourceError);
  });
});
