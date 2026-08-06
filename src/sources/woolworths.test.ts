import { describe, expect, it, vi } from "vitest";
import { fetchWoolworthsViaBrowser, parseWoolworthsPayload } from "./woolworths";
import { SourceError } from "./errors";
import type { PageLike } from "../browser";
import type { RawDeal, StoreProfile } from "../types";
import fixture from "../../test/fixtures/woolworths.json";

const PROFILE: StoreProfile = {
  url: "https://www.woolworths.com.au/apis/ui/browse/category",
};

/** Builds a single Woolworths browse/category product for a fake page response. */
function product(stockcode: number, name: string) {
  return {
    stockcode,
    name,
    urlFriendlyName: name.toLowerCase().replace(/\s+/g, "-"),
    price: { price: 1, wasPrice: 2 },
    department: "Pantry",
  };
}

/**
 * A fake PageLike whose `goto` reports a 200 navigation and whose
 * `evaluate` returns `{ status: 200, body }` from a queue of page bodies
 * (one entry consumed per call, in order). Bodies exhaust into the last
 * entry if `evaluate` is called more times than provided (guards against an
 * infinite-loop test hanging on `undefined`).
 */
function fakePage(pageBodies: unknown[]): PageLike {
  let call = 0;
  return {
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    evaluate: vi.fn(async (..._args: unknown[]) => {
      const body = pageBodies[Math.min(call, pageBodies.length - 1)];
      call += 1;
      return { status: 200, body };
    }) as PageLike["evaluate"],
    waitForResponse: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

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

describe("fetchWoolworthsViaBrowser", () => {
  it("navigates the half-price page first, then posts in-page with credentials included", async () => {
    // Arrange
    const page = fakePage([
      { bundles: [{ products: [product(1, "Milk")] }], totalRecordCount: 1 },
    ]);

    // Act
    await fetchWoolworthsViaBrowser(page, PROFILE);

    // Assert: goto hits the human-facing half-price page, not the bare API URL.
    expect(page.goto).toHaveBeenCalledTimes(1);
    const [gotoUrl] = vi.mocked(page.goto).mock.calls[0]!;
    expect(gotoUrl).toBe("https://www.woolworths.com.au/shop/browse/specials/half-price");

    // The in-page evaluate call is handed the category API URL and a body
    // whose pageNumber starts at 1.
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    const [, apiUrl, requestBody] = vi.mocked(page.evaluate).mock.calls[0]!;
    expect(apiUrl).toBe(PROFILE.url);
    expect(requestBody).toMatchObject({
      categoryId: "specialsgroup.3676",
      pageNumber: 1,
      sortType: "TraderRelevance",
    });
  });

  it("pages through pageNumber and stops once the collected count reaches totalRecordCount", async () => {
    // Arrange: 5 total records across 3 pages of 2, 2, 1.
    const page = fakePage([
      {
        bundles: [{ products: [product(1, "A"), product(2, "B")] }],
        totalRecordCount: 5,
      },
      {
        bundles: [{ products: [product(3, "C"), product(4, "D")] }],
      },
      {
        bundles: [{ products: [product(5, "E")] }],
      },
    ]);

    // Act
    const deals = await fetchWoolworthsViaBrowser(page, PROFILE);

    // Assert: exactly 3 pages fetched, stopping once 5 products collected.
    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(deals.length).toBe(5);
    const pageNumbers = vi.mocked(page.evaluate).mock.calls.map((call) => {
      const body = call[2] as Record<string, unknown>;
      return body.pageNumber;
    });
    expect(pageNumbers).toEqual([1, 2, 3]);
  });

  it("enforces the defensive page cap when totalRecordCount is absurdly large", async () => {
    // Arrange: a page body that always reports 1 product but claims millions
    // of total records, and never runs out of "next" pages (evaluate always
    // resolves the same single-product page) — without a cap this loops
    // forever.
    let evaluateCalls = 0;
    const page: PageLike = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      evaluate: vi.fn(async (..._args: unknown[]) => {
        evaluateCalls += 1;
        return {
          status: 200,
          body: {
            bundles: [{ products: [product(evaluateCalls, `Item ${evaluateCalls}`)] }],
            totalRecordCount: 10_000_000,
          },
        };
      }) as PageLike["evaluate"],
      waitForResponse: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // Act
    const deals = await fetchWoolworthsViaBrowser(page, PROFILE);

    // Assert: terminates at the cap rather than looping forever.
    expect(evaluateCalls).toBeGreaterThan(0);
    expect(evaluateCalls).toBeLessThan(1000);
    expect(deals.length).toBe(evaluateCalls);
  });

  it("merges bundles across multiple pages into one RawDeal[], not just the first page's", async () => {
    // Arrange
    const page = fakePage([
      {
        bundles: [{ products: [product(1, "First Page Item")] }],
        totalRecordCount: 2,
      },
      {
        bundles: [{ products: [product(2, "Second Page Item")] }],
      },
    ]);

    // Act
    const deals = await fetchWoolworthsViaBrowser(page, PROFILE);

    // Assert
    const titles = deals.map((deal: RawDeal) => deal.title);
    expect(titles).toEqual(["First Page Item", "Second Page Item"]);
  });

  it("throws a SourceError when the navigation fails (non-2xx)", async () => {
    // Arrange
    const page: PageLike = {
      goto: vi.fn().mockResolvedValue({ status: () => 503 }),
      evaluate: vi.fn(),
      waitForResponse: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // Act + Assert
    await expect(fetchWoolworthsViaBrowser(page, PROFILE)).rejects.toBeInstanceOf(SourceError);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("throws a SourceError when the in-page fetch returns a non-2xx status", async () => {
    // Arrange
    const page: PageLike = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      evaluate: vi.fn().mockResolvedValue({ status: 403, body: undefined }),
      waitForResponse: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // Act + Assert
    await expect(fetchWoolworthsViaBrowser(page, PROFILE)).rejects.toBeInstanceOf(SourceError);
  });

  it("throws a SourceError, not a raw error, on a malformed/unparseable body", async () => {
    // Arrange
    const page = fakePage([{ nope: true }]);

    // Act + Assert
    await expect(fetchWoolworthsViaBrowser(page, PROFILE)).rejects.toBeInstanceOf(SourceError);
  });
});
