import { describe, expect, it, vi } from "vitest";
import type { AldiStoreProfile } from "../../../src/types.ts";
import * as aldiParser from "../../../src/sources/aldi.ts";
import type { PageLike } from "../browser.ts";
import { SourceError } from "../errors.ts";
import { driveAldi, fetchAldi } from "./aldi.ts";

/**
 * A fake `PageLike` that serves one raw JSON body per `goto`/`evaluate`
 * pair, in call order, and records every navigated URL so tests can assert
 * on paging behaviour without a real browser or network.
 */
function makeFakePage(bodies: string[]): { page: PageLike; gotoUrls: string[] } {
  const gotoUrls: string[] = [];
  let call = 0;
  const page: PageLike = {
    goto: async (url) => {
      gotoUrls.push(url);
      return { status: () => 200 };
    },
    evaluate: async () => {
      const body = bodies[call];
      call += 1;
      return body;
    },
    close: async () => {},
  };
  return { page, gotoUrls };
}

function product(id: string): Record<string, unknown> {
  return {
    sku: id,
    name: `Product ${id}`,
    brandName: null,
    price: { amount: 3.5, wasAmount: null },
    urlSlugText: `product-${id}`,
    categoryKey: null,
    categoryName: "Fresh Food",
  };
}

function rawPage(products: unknown[], totalCount: number): string {
  return JSON.stringify({ data: products, meta: { pagination: { totalCount } } });
}

describe("driveAldi", () => {
  it("pages a single categoryKey's 120-item feed at offsets 0, 30, 60 and 90 with no duplicates", async () => {
    // Arrange
    const profile: AldiStoreProfile = { servicePoint: "G452", categoryKeys: ["1588161420755352"] };
    const pages = [0, 30, 60, 90].map((offset) =>
      rawPage(
        Array.from({ length: 30 }, (_, i) => product(`lto-${offset + i}`)),
        120,
      ),
    );
    const { page, gotoUrls } = makeFakePage(pages);

    // Act
    const merged = await driveAldi(page, profile);

    // Assert
    expect(gotoUrls).toHaveLength(4);
    expect(gotoUrls[0]).toContain("offset=0");
    expect(gotoUrls[1]).toContain("offset=30");
    expect(gotoUrls[2]).toContain("offset=60");
    expect(gotoUrls[3]).toContain("offset=90");
    expect(merged.data).toHaveLength(120);
    const skus = new Set((merged.data as { sku: string }[]).map((p) => p.sku));
    expect(skus.size).toBe(120);
  });

  it("stops after a page shorter than the limit, with no extra navigation", async () => {
    // Arrange
    const profile: AldiStoreProfile = { servicePoint: "G452", categoryKeys: ["1588161426952145"] };
    const pages = [
      rawPage(Array.from({ length: 30 }, (_, i) => product(`ss-${i}`)), 40),
      rawPage(Array.from({ length: 10 }, (_, i) => product(`ss-${30 + i}`)), 40),
    ];
    const { page, gotoUrls } = makeFakePage(pages);

    // Act
    const merged = await driveAldi(page, profile);

    // Assert
    expect(gotoUrls).toHaveLength(2);
    expect(merged.data).toHaveLength(40);
  });

  it("fetches and merges both categoryKeys", async () => {
    // Arrange
    const profile: AldiStoreProfile = {
      servicePoint: "G452",
      categoryKeys: ["1588161426952145", "1588161420755352"],
    };
    const pages = [
      rawPage([product("ss-0"), product("ss-1")], 2),
      rawPage([product("lto-0"), product("lto-1")], 2),
    ];
    const { page, gotoUrls } = makeFakePage(pages);

    // Act
    const merged = await driveAldi(page, profile);

    // Assert
    expect(gotoUrls).toHaveLength(2);
    expect(gotoUrls[0]).toContain("categoryKey=1588161426952145");
    expect(gotoUrls[1]).toContain("categoryKey=1588161420755352");
    const skus = (merged.data as { sku: string }[]).map((p) => p.sku);
    expect(skus).toEqual(["ss-0", "ss-1", "lto-0", "lto-1"]);
  });

  it("throws SourceError when a page's body is HTML instead of JSON", async () => {
    // Arrange
    const profile: AldiStoreProfile = { servicePoint: "G452", categoryKeys: ["1588161426952145"] };
    const challengeBody = "<html><body>Access Denied</body></html>";
    const { page } = makeFakePage([challengeBody]);

    // Act + Assert
    const error = await driveAldi(page, profile).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).not.toContain("Access Denied");
  });

  it("stops at the page cap when the feed never reports a totalCount and never returns a short page", async () => {
    // Arrange: every page is full (30 items) and carries no totalCount, so
    // neither normal termination condition can ever fire.
    const profile: AldiStoreProfile = { servicePoint: "G452", categoryKeys: ["1588161420755352"] };
    const endlessFullPage = JSON.stringify({
      data: Array.from({ length: 30 }, (_unused, i) => product(`endless-${i}`)),
      meta: {},
    });
    const gotoUrls: string[] = [];
    const page: PageLike = {
      goto: async (url) => {
        gotoUrls.push(url);
        return { status: () => 200 };
      },
      evaluate: async () => endlessFullPage,
      close: async () => {},
    };

    // Act
    const result = await driveAldi(page, profile);

    // Assert
    expect(gotoUrls).toHaveLength(20);
    expect(result.data).toHaveLength(600);
  });
});

describe("fetchAldi", () => {
  it("calls parseAldiPayload exactly once on the merged raw JSON", async () => {
    // Arrange
    const profile: AldiStoreProfile = { servicePoint: "G452", categoryKeys: ["1588161420755352"] };
    const pages = [0, 30, 60, 90].map((offset) =>
      rawPage(
        Array.from({ length: 30 }, (_, i) => product(`lto-${offset + i}`)),
        120,
      ),
    );
    const { page } = makeFakePage(pages);
    const parseSpy = vi.spyOn(aldiParser, "parseAldiPayload");

    // Act
    const deals = await fetchAldi(page, profile);

    // Assert
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(deals).toHaveLength(120);
    parseSpy.mockRestore();
  });

  it("throws a soft-block SourceError, not a healthy empty success, on 0 deals with totalCount 0", async () => {
    // Arrange
    const profile: AldiStoreProfile = { servicePoint: "G452", categoryKeys: ["1588161426952145"] };
    const { page } = makeFakePage([rawPage([], 0)]);

    // Act + Assert
    const error = await fetchAldi(page, profile).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toContain("aldi returned 0 deals (possible soft bot-block)");
  });
});
