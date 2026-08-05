import { describe, expect, it } from "vitest";
import { storeProfiles, watchlist } from "./config";
import {
  AldiStoreProfileSchema,
  StoreProfileSchema,
  WatchSchema,
} from "./types";

describe("watchlist", () => {
  it("is non-empty", () => {
    // Arrange (module-level watchlist import)

    // Act & Assert
    expect(watchlist.length).toBeGreaterThan(0);
  });

  it.each(watchlist.map((watch) => [watch.term, watch]))(
    "entry %s validates against WatchSchema",
    (_term, watch) => {
      // Act & Assert
      expect(() => WatchSchema.parse(watch)).not.toThrow();
    },
  );
});

describe("storeProfiles", () => {
  it("validates aldi against AldiStoreProfileSchema with both category keys", () => {
    // Act
    const result = AldiStoreProfileSchema.parse(storeProfiles.aldi);

    // Assert
    expect(result.categoryKeys).toHaveLength(2);
    expect(result.categoryKeys).toEqual([
      "1588161426952145",
      "1588161420755352",
    ]);
  });

  it("validates woolworths against StoreProfileSchema as a bare url", () => {
    // Act
    const result = StoreProfileSchema.parse(storeProfiles.woolworths);

    // Assert
    expect(result.url).toBe(
      "https://www.woolworths.com.au/apis/ui/browse/category",
    );
  });

  it("validates coles against StoreProfileSchema as a bare url", () => {
    // Act
    const result = StoreProfileSchema.parse(storeProfiles.coles);

    // Assert
    expect(result.url).toBe(
      "https://www.coles.com.au/on-special?filter_Special=halfprice",
    );
  });
});
