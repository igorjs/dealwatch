import { describe, expect, it, vi } from "vitest";
import type { StoreProfile } from "../../../src/types.ts";
import * as woolworthsParser from "../../../src/sources/woolworths.ts";
import type { PageLike } from "../browser.ts";
import { SourceError } from "../errors.ts";
import { driveWoolworths, fetchWoolworths } from "./woolworths.ts";

const CATEGORY_URL = "https://www.woolworths.com.au/apis/ui/browse/category";
const HALF_PRICE_PAGE_URL = "https://www.woolworths.com.au/shop/browse/specials/half-price";

/**
 * A fake `PageLike` that serves one `{ status, body }` result per
 * `evaluate` call, in call order, and records every `goto`/`evaluate` call
 * in one combined ordered log so tests can assert call ORDER between the
 * warm navigation and the POSTs, not just that both happened.
 */
function makeFakePage(
  responses: Array<{ status: number; body: unknown }>,
): { page: PageLike; calls: string[] } {
  const calls: string[] = [];
  let call = 0;
  const page: PageLike = {
    goto: async (url) => {
      calls.push(`goto:${url}`);
      return { status: () => 200 };
    },
    evaluate: async () => {
      calls.push("evaluate");
      const response = responses[call];
      call += 1;
      return response;
    },
    close: async () => {},
  };
  return { page, calls };
}

function product(stockcode: number): Record<string, unknown> {
  return {
    stockcode,
    name: `Product ${stockcode}`,
    urlFriendlyName: `product-${stockcode}`,
    price: { price: 3.5, wasPrice: 7 },
    department: "Pantry",
  };
}

function rawPage(products: unknown[], totalRecordCount?: number): Record<string, unknown> {
  return { bundles: [{ products }], totalRecordCount };
}

describe("driveWoolworths", () => {
  it("navigates the half-price page before the first category POST", async () => {
    // Arrange
    const profile: StoreProfile = { url: CATEGORY_URL };
    const { page, calls } = makeFakePage([{ status: 200, body: rawPage([product(1)], 1) }]);

    // Act
    await driveWoolworths(page, profile);

    // Assert
    expect(calls[0]).toBe(`goto:${HALF_PRICE_PAGE_URL}`);
    expect(calls[1]).toBe("evaluate");
  });

  it("pages by pageNumber until totalRecordCount is collected, merging every page", async () => {
    // Arrange
    const profile: StoreProfile = { url: CATEGORY_URL };
    const responses = [
      { status: 200, body: rawPage([product(1), product(2)], 3) },
      { status: 200, body: rawPage([product(3)], 3) },
    ];
    const { page, calls } = makeFakePage(responses);

    // Act
    const merged = await driveWoolworths(page, profile);

    // Assert
    expect(calls.filter((c) => c === "evaluate")).toHaveLength(2);
    expect(merged.bundles).toHaveLength(2);
    expect(merged.totalRecordCount).toBe(3);
  });

  it("throws SourceError when the category API responds with a 4xx status", async () => {
    // Arrange
    const profile: StoreProfile = { url: CATEGORY_URL };
    const { page } = makeFakePage([{ status: 403, body: undefined }]);

    // Act
    const error = await driveWoolworths(page, profile).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toContain("403");
  });

  it("throws SourceError when the category API returns a non-JSON body instead of JSON", async () => {
    // Arrange
    const profile: StoreProfile = { url: CATEGORY_URL };
    const { page } = makeFakePage([{ status: 200, body: undefined }]);

    // Act
    const error = await driveWoolworths(page, profile).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toContain("non-JSON body");
  });

  it("caps paging at 90 pages even when totalRecordCount always claims more", async () => {
    // Arrange
    const profile: StoreProfile = { url: CATEGORY_URL };
    const responses = Array.from({ length: 90 }, (_, i) => ({
      status: 200,
      body: rawPage([product(i)], 10_000_000),
    }));
    const { page, calls } = makeFakePage(responses);

    // Act
    const merged = await driveWoolworths(page, profile);

    // Assert
    expect(calls.filter((c) => c === "evaluate")).toHaveLength(90);
    expect(merged.bundles).toHaveLength(90);
  });

  it("keeps paging when page 1 omits totalRecordCount, instead of stopping after one page", async () => {
    // Arrange: three full pages then an empty one, and the feed never
    // reports a total. Treating an unreported total as 0 would stop after
    // page 1 and silently drop the rest.
    const profile: StoreProfile = { url: CATEGORY_URL };
    const responses = [
      { status: 200, body: { bundles: [{ products: [product(1), product(2)] }] } },
      { status: 200, body: { bundles: [{ products: [product(3), product(4)] }] } },
      { status: 200, body: { bundles: [{ products: [product(5), product(6)] }] } },
      { status: 200, body: { bundles: [] } },
    ];
    const { page, calls } = makeFakePage(responses);

    // Act
    const merged = await driveWoolworths(page, profile);

    // Assert
    expect(calls.filter((c) => c === "evaluate")).toHaveLength(4);
    expect(merged.bundles).toHaveLength(3);
    expect(merged.totalRecordCount).toBe(0);
  });

  it("stops on an empty page even when totalRecordCount claims more records remain", async () => {
    // Arrange
    const profile: StoreProfile = { url: CATEGORY_URL };
    const responses = [
      { status: 200, body: rawPage([product(1)], 10_000_000) },
      { status: 200, body: { bundles: [] } },
    ];
    const { page, calls } = makeFakePage(responses);

    // Act
    const merged = await driveWoolworths(page, profile);

    // Assert
    expect(calls.filter((c) => c === "evaluate")).toHaveLength(2);
    expect(merged.bundles).toHaveLength(1);
  });
});

describe("fetchWoolworths", () => {
  it("calls parseWoolworthsPayload exactly once on the merged raw JSON, yielding RawDeal[]", async () => {
    // Arrange
    const profile: StoreProfile = { url: CATEGORY_URL };
    const responses = [
      { status: 200, body: rawPage([product(1), product(2)], 3) },
      { status: 200, body: rawPage([product(3)], 3) },
    ];
    const { page } = makeFakePage(responses);
    const parseSpy = vi.spyOn(woolworthsParser, "parseWoolworthsPayload");

    // Act
    const deals = await fetchWoolworths(page, profile);

    // Assert
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(deals).toHaveLength(3);
    expect(deals.map((d) => d.title)).toEqual(["Product 1", "Product 2", "Product 3"]);
    parseSpy.mockRestore();
  });

  it("throws a soft-block SourceError, not a healthy empty success, on 0 deals with totalRecordCount 0", async () => {
    // Arrange
    const profile: StoreProfile = { url: CATEGORY_URL };
    const { page } = makeFakePage([{ status: 200, body: rawPage([], 0) }]);

    // Act
    const error = await fetchWoolworths(page, profile).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toContain(
      "woolworths returned 0 deals (possible soft bot-block)",
    );
  });
});
