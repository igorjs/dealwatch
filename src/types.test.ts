import { describe, expect, it } from "vitest";
import {
  ConfigSchema,
  type Deal,
  DealSchema,
  type IngestBody,
  IngestBodySchema,
  type ListItem,
  ListItemSchema,
  type RawDeal,
  RawDealSchema,
  StoreProfileSchema,
  WatchSchema,
} from "./types";

describe("DealSchema", () => {
  it("parses a valid Deal object", () => {
    // Arrange
    const validDeal: Deal = {
      id: "abc123",
      source: "coles",
      store: "Coles Bondi Junction",
      title: "Chicken Breast 500g",
      url: "https://coles.com.au/product/chicken-breast-500g",
      category: "meat",
      priceCents: 500,
      wasPriceCents: 1000,
      discountPercent: 50,
      seenAt: "2026-07-31T00:00:00.000Z",
    };

    // Act
    const result = DealSchema.parse(validDeal);

    // Assert
    expect(result).toEqual(validDeal);
  });

  it("throws when priceCents is a string instead of a number", () => {
    // Arrange
    const invalidDeal = {
      id: "abc123",
      source: "coles",
      store: "Coles Bondi Junction",
      title: "Chicken Breast 500g",
      url: "https://coles.com.au/product/chicken-breast-500g",
      category: "meat",
      priceCents: "5",
      wasPriceCents: 1000,
      discountPercent: 50,
      seenAt: "2026-07-31T00:00:00.000Z",
    };

    // Act & Assert
    expect(() => DealSchema.parse(invalidDeal)).toThrow();
  });
});

describe("WatchSchema", () => {
  it.each([
    ["missing", { minDiscountPercent: 50, exclude: [] }],
    ["an empty string", { term: "", minDiscountPercent: 50, exclude: [] }],
  ])("throws when term is %s", (_label, invalidWatch) => {
    // Arrange (invalidWatch provided by test.each)

    // Act & Assert
    expect(() => WatchSchema.parse(invalidWatch)).toThrow();
  });
});

describe("ConfigSchema", () => {
  // Arrange
  const validConfig = {
    watchlist: [
      {
        term: "chicken breast",
        minDiscountPercent: 50,
        exclude: [],
      },
    ],
    ntfy: {
      topicUrl: "https://ntfy.sh/dealwatch-alerts",
    },
    stores: {
      aldi: {
        servicePoint: "G452",
        categoryKeys: ["1588161426952145"],
      },
      coles: {
        url: "https://coles.com.au",
      },
      woolworths: {
        url: "https://woolworths.com.au",
      },
    },
  };

  it("parses a valid Config with a non-empty watchlist, top-level ntfy, and all store profiles", () => {
    // Act
    const result = ConfigSchema.parse(validConfig);

    // Assert
    expect(result.watchlist.length).toBe(1);
    expect(result.ntfy.topicUrl).toBe("https://ntfy.sh/dealwatch-alerts");
  });

  it("throws when watchlist is empty", () => {
    // Arrange
    const invalidConfig = { ...validConfig, watchlist: [] };

    // Act & Assert
    expect(() => ConfigSchema.parse(invalidConfig)).toThrow();
  });
});

describe("StoreProfileSchema", () => {
  it("parses a bare url-only profile with no headers field", () => {
    // Arrange
    const profile = { url: "https://coles.com.au" };

    // Act
    const result = StoreProfileSchema.parse(profile);

    // Assert
    expect(result).toEqual({ url: "https://coles.com.au" });
  });
});

describe("RawDealSchema", () => {
  it("parses a valid RawDeal object", () => {
    // Arrange
    const validRawDeal: RawDeal = {
      source: "woolworths",
      title: "Beef Mince 500g",
      url: "https://woolworths.com.au/product/beef-mince-500g",
      store: "Woolworths Rozelle",
      department: "Meat & Seafood",
      priceCents: 750,
      wasPriceCents: 1500,
      discountPercent: 50,
    };

    // Act
    const result = RawDealSchema.parse(validRawDeal);

    // Assert
    expect(result).toEqual(validRawDeal);
  });
});

describe("ListItemSchema", () => {
  it("parses a valid ListItem object", () => {
    // Arrange
    const validListItem: ListItem = {
      id: "abc123",
      title: "Chicken Breast 500g",
      store: "Coles Bondi Junction",
      url: "https://coles.com.au/product/chicken-breast-500g",
      category: "meat",
      priceCents: 500,
      status: "pending",
      addedAt: "2026-07-31T00:00:00.000Z",
    };

    // Act
    const result = ListItemSchema.parse(validListItem);

    // Assert
    expect(result).toEqual(validListItem);
  });
});

describe("IngestBodySchema", () => {
  it("parses a body with one fulfilled result and one rejected result", () => {
    // Arrange
    const validRawDeal: RawDeal = {
      source: "woolworths",
      title: "Beef Mince 500g",
      url: "https://woolworths.com.au/product/beef-mince-500g",
      store: "Woolworths Rozelle",
      department: "Meat & Seafood",
      priceCents: 750,
      wasPriceCents: 1500,
      discountPercent: 50,
    };
    const validBody: IngestBody = {
      results: [
        { source: "woolworths", status: "fulfilled", deals: [validRawDeal] },
        { source: "coles", status: "rejected", reason: "timed out" },
      ],
    };

    // Act
    const result = IngestBodySchema.parse(validBody);

    // Assert
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ status: "fulfilled", source: "woolworths" });
    expect(result.results[1]).toMatchObject({ status: "rejected", source: "coles" });
  });

  it.each([
    [
      "a fulfilled result's deal has a string priceCents",
      {
        results: [
          {
            source: "woolworths",
            status: "fulfilled",
            deals: [
              {
                source: "woolworths",
                title: "Beef Mince 500g",
                url: "https://woolworths.com.au/product/beef-mince-500g",
                store: "Woolworths Rozelle",
                department: "Meat & Seafood",
                priceCents: "750",
                wasPriceCents: 1500,
                discountPercent: 50,
              },
            ],
          },
        ],
      },
    ],
    [
      "a result has an unknown source",
      {
        results: [{ source: "iga", status: "rejected", reason: "unsupported store" }],
      },
    ],
    [
      "a rejected result has no reason field",
      {
        results: [{ source: "coles", status: "rejected" }],
      },
    ],
  ])("throws when %s", (_label, invalidBody) => {
    // Arrange (invalidBody provided by test.each)

    // Act & Assert
    expect(() => IngestBodySchema.parse(invalidBody)).toThrow();
  });
});
