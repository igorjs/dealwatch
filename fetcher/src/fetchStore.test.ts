import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawDeal } from "../../src/types.ts";
import type { PageLike } from "./browser.ts";
import * as aldiDriver from "./drivers/aldi.ts";
import * as colesDriver from "./drivers/coles.ts";
import * as woolworthsDriver from "./drivers/woolworths.ts";
import { fetchStore } from "./fetchStore.ts";

const FAKE_PAGE: PageLike = {
  goto: async () => null,
  evaluate: async () => undefined,
  close: async () => {},
};

function deal(source: RawDeal["source"]): RawDeal {
  return {
    source,
    title: "Example product",
    url: "https://example.test/product",
    store: "Example Store",
    department: null,
    priceCents: 100,
    wasPriceCents: 200,
    discountPercent: 50,
  };
}

describe("fetchStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aldi success becomes a fulfilled result carrying fetchAldi's deals", async () => {
    // Arrange
    const deals = [deal("aldi")];
    vi.spyOn(aldiDriver, "fetchAldi").mockResolvedValue(deals);

    // Act
    const result = await fetchStore("aldi", FAKE_PAGE);

    // Assert
    expect(result).toEqual({ source: "aldi", status: "fulfilled", deals });
  });

  it("woolworths success becomes a fulfilled result carrying fetchWoolworths's deals", async () => {
    // Arrange
    const deals = [deal("woolworths")];
    vi.spyOn(woolworthsDriver, "fetchWoolworths").mockResolvedValue(deals);

    // Act
    const result = await fetchStore("woolworths", FAKE_PAGE);

    // Assert
    expect(result).toEqual({ source: "woolworths", status: "fulfilled", deals });
  });

  it("coles success becomes a fulfilled result carrying fetchColes's deals", async () => {
    // Arrange
    const deals = [deal("coles")];
    vi.spyOn(colesDriver, "fetchColes").mockResolvedValue(deals);

    // Act
    const result = await fetchStore("coles", FAKE_PAGE);

    // Assert
    expect(result).toEqual({ source: "coles", status: "fulfilled", deals });
  });

  it("a driver throw becomes a rejected result carrying the error's message, not its stack", async () => {
    // Arrange
    const error = new Error("bot challenge detected");
    error.stack = "Error: bot challenge detected\n    at deep/internal/trace.ts:42:1";
    vi.spyOn(colesDriver, "fetchColes").mockRejectedValue(error);

    // Act
    const result = await fetchStore("coles", FAKE_PAGE);

    // Assert
    expect(result).toEqual({ source: "coles", status: "rejected", reason: "bot challenge detected" });
    if (result.status === "rejected") {
      expect(result.reason).not.toContain("deep/internal/trace.ts");
    }
  });

  it("never rethrows, even for a non-Error throw", async () => {
    // Arrange
    vi.spyOn(woolworthsDriver, "fetchWoolworths").mockRejectedValue("plain string failure");

    // Act
    const result = await fetchStore("woolworths", FAKE_PAGE);

    // Assert
    expect(result).toEqual({ source: "woolworths", status: "rejected", reason: "plain string failure" });
  });
});
