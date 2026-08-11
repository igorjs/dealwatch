import { describe, expect, it } from "vitest";
import { parseColesPayload } from "../../../src/sources/coles.ts";
import type { PageLike } from "../browser.ts";
import { SourceError } from "../errors.ts";
import { driveColes, fetchColes } from "./coles.ts";

const COLES_SPECIALS_URL = "https://www.coles.com.au/on-special?filter_Special=halfprice";
const COLES_GRAPHQL_URL = "https://www.coles.com.au/api/graphql";

/**
 * A fake `PageLike` whose `waitForResponse` walks a fixed list of candidate
 * responses in order, feeding each to the driver's predicate exactly like
 * Playwright's own event-driven `waitForResponse` does, and resolves with
 * the first one the predicate accepts. Throws once the list is exhausted
 * with no match, mirroring a real timeout. No real browser or network.
 */
function makeFakePage(candidates: Array<{ url: string; body: unknown }>): {
  page: PageLike;
  gotoUrls: string[];
} {
  const gotoUrls: string[] = [];
  const page: PageLike = {
    goto: async (url) => {
      gotoUrls.push(url);
      return { status: () => 200 };
    },
    evaluate: async () => {
      throw new Error("evaluate is not used by the Coles driver");
    },
    waitForResponse: async (urlOrPredicate) => {
      const predicate = urlOrPredicate as (response: {
        url(): string;
        json(): Promise<unknown>;
      }) => boolean | Promise<boolean>;

      for (const candidate of candidates) {
        const response = { url: () => candidate.url, json: async () => candidate.body };
        if (await predicate(response)) {
          return response;
        }
      }
      throw new Error("Timeout waiting for a matching response");
    },
    on: () => {},
    close: async () => {},
  };
  return { page, gotoUrls };
}

function product(id: string): Record<string, unknown> {
  return {
    id,
    name: `Product ${id}`,
    brand: "Test Brand",
    pricing: { now: 3.5, was: 7 },
    seoToken: `product-${id}`,
    onlineHeirs: [{ category: "Pantry" }],
  };
}

function productListingBody(products: unknown[], totalCount: number): unknown {
  return { data: { results: { results: products, totalCount } } };
}

describe("driveColes", () => {
  it("returns the third GraphQL response when only it matches the schema, not the first", async () => {
    // Arrange
    const categoryTreeResponse = {
      url: COLES_GRAPHQL_URL,
      body: { data: { categories: [{ id: "petcare", name: "Pet Care", children: [] }] } },
    };
    const cartResponse = {
      url: COLES_GRAPHQL_URL,
      body: { data: { cart: { itemCount: 3, subtotal: 42.5 } } },
    };
    const productListingResponse = {
      url: COLES_GRAPHQL_URL,
      body: productListingBody([product("1")], 1),
    };
    const { page, gotoUrls } = makeFakePage([categoryTreeResponse, cartResponse, productListingResponse]);

    // Act
    const raw = await driveColes(page);

    // Assert
    expect(raw).toEqual(productListingResponse.body);
    expect(gotoUrls).toEqual([COLES_SPECIALS_URL]);
  });

  it("throws SourceError when no response matches the schema within the bound", async () => {
    // Arrange
    const nonMatching = [
      { url: COLES_GRAPHQL_URL, body: { data: { categories: [] } } },
      { url: COLES_GRAPHQL_URL, body: { data: { cart: { itemCount: 0 } } } },
    ];
    const { page } = makeFakePage(nonMatching);

    // Act
    const error = await driveColes(page).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).not.toMatch(/reese84|incap_ses|visid_incap|nlbi/i);
  });
});

describe("fetchColes", () => {
  it("flows the matched response through parseColesPayload into RawDeal[]", async () => {
    // Arrange
    const body = productListingBody([product("1"), product("2")], 2);
    const { page } = makeFakePage([{ url: COLES_GRAPHQL_URL, body }]);

    // Act
    const deals = await fetchColes(page);

    // Assert
    expect(deals).toEqual(parseColesPayload(body));
  });

  it("throws a soft-block SourceError, not a healthy empty success, when the matched response has 0 products", async () => {
    // Arrange
    const body = productListingBody([], 0);
    const { page } = makeFakePage([{ url: COLES_GRAPHQL_URL, body }]);

    // Act
    const error = await fetchColes(page).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toContain("coles returned 0 deals (possible soft bot-block)");
  });
});
