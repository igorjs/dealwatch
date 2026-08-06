import { describe, expect, it, vi } from "vitest";
import { fetchAldiViaBrowser, parseAldiPayload } from "./aldi";
import { SourceError } from "./errors";
import type { PageLike } from "../browser";
import type { AldiStoreProfile } from "../types";
// PLACEHOLDER fixture: no real Aldi product-search response is captured yet.
// See the note at the top of test/fixtures/aldi.json and in aldi.ts. Imported
// as a JSON module (not read off disk) since tests run inside the Workers
// runtime pool, which has no host filesystem access.
import aldiFixture from "../../test/fixtures/aldi.json";

function loadFixture(): unknown {
  return aldiFixture;
}

const PROFILE: AldiStoreProfile = {
  servicePoint: "G452",
  categoryKeys: ["1588161426952145", "1588161420755352"],
};

/** Builds a minimal, schema-valid Aldi product-search page payload. */
function page(
  products: { sku: string; name: string; urlSlugText: string }[],
  totalCount: number,
) {
  return {
    data: products.map((p) => ({
      sku: p.sku,
      name: p.name,
      brandName: null,
      price: { amount: 1.0, wasAmount: null },
      urlSlugText: p.urlSlugText,
      categoryKey: null,
      categoryName: null,
    })),
    meta: { pagination: { totalCount } },
  };
}

/** A fake PageLike whose goto/evaluate are driven by the given queue of JSON payloads, consumed in call order. */
function fakePage(payloads: unknown[]): PageLike {
  let i = 0;
  const evaluate = vi.fn(async () => {
    const payload = payloads[i];
    i += 1;
    if (payload === undefined) {
      throw new Error("fakePage: no more payloads configured");
    }
    return payload;
  }) as unknown as PageLike["evaluate"];
  return {
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    evaluate,
    waitForResponse: vi.fn().mockResolvedValue({
      url: () => "https://example.com",
      json: () => Promise.resolve({}),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
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

describe("fetchAldiViaBrowser", () => {
  it("navigates to both configured categoryKeys", async () => {
    // Arrange
    const single = page(
      [{ sku: "s1", name: "Product 1", urlSlugText: "product-1" }],
      1,
    );
    const fake = fakePage([single, single]);

    // Act
    await fetchAldiViaBrowser(fake, PROFILE);

    // Assert
    const calls = (fake.goto as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(calls.length).toBe(2);
    expect(calls[0]?.includes(PROFILE.categoryKeys[0]!)).toBe(true);
    expect(calls[1]?.includes(PROFILE.categoryKeys[1]!)).toBe(true);
  });

  it("pages through offset until offset >= totalCount, collecting all pages", async () => {
    // Arrange: category 1 spans 2 pages (30 + 10 = 40 total), category 2 is a single page.
    const category1Page1 = page(
      Array.from({ length: 30 }, (_, n) => ({
        sku: `c1-${n}`,
        name: `Category 1 Product ${n}`,
        urlSlugText: `c1-product-${n}`,
      })),
      40,
    );
    const category1Page2 = page(
      Array.from({ length: 10 }, (_, n) => ({
        sku: `c1-${30 + n}`,
        name: `Category 1 Product ${30 + n}`,
        urlSlugText: `c1-product-${30 + n}`,
      })),
      40,
    );
    const category2Page1 = page(
      [{ sku: "c2-0", name: "Category 2 Product", urlSlugText: "c2-product" }],
      1,
    );
    const fake = fakePage([category1Page1, category1Page2, category2Page1]);

    // Act
    const deals = await fetchAldiViaBrowser(fake, PROFILE);

    // Assert: 2 goto calls for category 1 (offset 0, offset 30), 1 for category 2.
    const calls = (fake.goto as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(calls.length).toBe(3);
    expect(calls[0]?.includes("offset=0")).toBe(true);
    expect(calls[1]?.includes("offset=30")).toBe(true);
    expect(calls[2]?.includes("offset=0")).toBe(true);
    expect(deals.length).toBe(41);
  });

  it("dedupes products appearing under both categoryKeys by url", async () => {
    // Arrange: the same product shows up on both category pages.
    const shared = page(
      [{ sku: "shared-1", name: "Shared Product", urlSlugText: "shared-product" }],
      1,
    );
    const fake = fakePage([shared, shared]);

    // Act
    const deals = await fetchAldiViaBrowser(fake, PROFILE);

    // Assert
    expect(deals.length).toBe(1);
    expect(deals[0]?.url).toBe(
      "https://www.aldi.com.au/product/shared-product",
    );
  });

  it("stops paging (defensively) without looping forever when a page returns zero items", async () => {
    // Arrange: totalCount claims more items exist, but the page comes back empty.
    const empty = page([], 999);
    const fake = fakePage([empty, empty]);

    // Act
    const deals = await fetchAldiViaBrowser(fake, {
      servicePoint: "G452",
      categoryKeys: ["only-key"],
    });

    // Assert: exactly one goto call for the single category, loop terminated on empty page.
    expect((fake.goto as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(deals).toEqual([]);
  });

  it("throws a SourceError (not a raw SyntaxError) when the evaluated body isn't valid JSON", async () => {
    // Arrange
    const fake: PageLike = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      evaluate: vi.fn().mockRejectedValue(
        new SyntaxError("Unexpected token < in JSON at position 0"),
      ),
      waitForResponse: vi.fn().mockResolvedValue({
        url: () => "https://example.com",
        json: () => Promise.resolve({}),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // Act + Assert
    await expect(fetchAldiViaBrowser(fake, PROFILE)).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("throws a SourceError when the evaluated body doesn't match the expected shape", async () => {
    // Arrange
    const fake = fakePage([{ nope: true }]);

    // Act + Assert
    await expect(fetchAldiViaBrowser(fake, PROFILE)).rejects.toBeInstanceOf(
      SourceError,
    );
  });

  it("throws a SourceError when page.goto returns a non-200 status", async () => {
    // Arrange
    const fake: PageLike = {
      goto: vi.fn().mockResolvedValue({ status: () => 403 }),
      evaluate: vi.fn().mockResolvedValue(undefined),
      waitForResponse: vi.fn().mockResolvedValue({
        url: () => "https://example.com",
        json: () => Promise.resolve({}),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // Act + Assert
    await expect(fetchAldiViaBrowser(fake, PROFILE)).rejects.toBeInstanceOf(
      SourceError,
    );
  });
});
