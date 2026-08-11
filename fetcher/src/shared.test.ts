import { describe, expect, it } from "vitest";
import { RawDealSchema } from "../../src/types.ts";
import { parseAldiPayload } from "../../src/sources/aldi.ts";

describe("cross-repo shared import", () => {
  it("parses a valid RawDeal sample", () => {
    const sample = {
      source: "aldi",
      title: "Chocolate Block 200g",
      url: "https://www.aldi.com.au/product/chocolate-block-200g",
      store: "Aldi",
      department: "Fresh Food",
      priceCents: 350,
      wasPriceCents: null,
      discountPercent: null,
    };

    expect(RawDealSchema.safeParse(sample).success).toBe(true);
  });

  it("rejects an invalid RawDeal sample", () => {
    const invalid = { source: "aldi", title: "missing required fields" };

    expect(RawDealSchema.safeParse(invalid).success).toBe(false);
  });

  it("maps a sample Aldi payload through parseAldiPayload into a valid RawDeal", () => {
    const payload = {
      data: [
        {
          sku: "0001",
          name: "Chocolate Block 200g",
          brandName: null,
          price: { amount: 3.5, wasAmount: null },
          urlSlugText: "chocolate-block-200g",
          categoryKey: null,
          categoryName: "Fresh Food",
        },
      ],
    };

    const deals = parseAldiPayload(payload);

    expect(deals).toHaveLength(1);
    expect(RawDealSchema.safeParse(deals[0]).success).toBe(true);
  });
});
