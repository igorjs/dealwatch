import { describe, expect, it } from "vitest";
import { parseColesPayload } from "../../../src/sources/coles.ts";
import type { PageLike } from "../browser.ts";
import { SourceError } from "../errors.ts";
import { driveColes, fetchColes } from "./coles.ts";
import fixture from "../../../test/fixtures/coles.json";

const COLES_SPECIALS_URL = "https://www.coles.com.au/on-special?filter_Special=halfprice";

/**
 * A fake `PageLike` whose `evaluate` returns `nextDataText` as the text read
 * off the page's `__NEXT_DATA__` script tag. `null` stands in for a page
 * with no `__NEXT_DATA__` tag at all (the Incapsula block case). No real
 * browser or network.
 */
function makeFakePage(nextDataText: string | null): { page: PageLike; gotoUrls: string[] } {
  const gotoUrls: string[] = [];
  const page: PageLike = {
    goto: async (url) => {
      gotoUrls.push(url);
      return { status: () => 200 };
    },
    evaluate: async () => nextDataText,
    close: async () => {},
  };
  return { page, gotoUrls };
}

function nextDataWith(results: unknown[]): unknown {
  return { props: { pageProps: { searchResults: { noOfResults: results.length, results } } } };
}

describe("driveColes", () => {
  it("navigates the specials page and returns the parsed __NEXT_DATA__ object", async () => {
    // Arrange
    const { page, gotoUrls } = makeFakePage(JSON.stringify(fixture));

    // Act
    const raw = await driveColes(page);

    // Assert
    expect(raw).toEqual(fixture);
    expect(gotoUrls).toEqual([COLES_SPECIALS_URL]);
  });

  it("throws SourceError when the page has no __NEXT_DATA__ (an Incapsula block page)", async () => {
    // Arrange
    const { page } = makeFakePage(null);

    // Act
    const error = await driveColes(page).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(SourceError);
  });
});

describe("fetchColes", () => {
  it("flows the fixture's __NEXT_DATA__ through parseColesPayload into RawDeal[]", async () => {
    // Arrange
    const { page } = makeFakePage(JSON.stringify(fixture));

    // Act
    const deals = await fetchColes(page);

    // Assert
    expect(deals).toEqual(parseColesPayload(fixture));
  });

  it("throws a soft-block SourceError, not a healthy empty success, when results[] has no products", async () => {
    // Arrange
    const nextData = nextDataWith([{ _type: "SINGLE_TILE", id: 0, name: "ad tile" }]);
    const { page } = makeFakePage(JSON.stringify(nextData));

    // Act
    const error = await fetchColes(page).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toContain("coles returned 0 deals (possible soft bot-block)");
  });
});
