import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { AldiSourceError, fetchAldi, parseAldiPayload } from "./aldi.ts";
import type { AldiStoreProfile, RawDeal } from "../types.ts";

// PLACEHOLDER fixture: no real Aldi product-search response is captured yet.
// See the note at the top of test/fixtures/aldi.json and in aldi.ts.
const FIXTURE_PATH = new URL(
  "../../test/fixtures/aldi.json",
  import.meta.url,
);

async function loadFixture(): Promise<unknown> {
  const text = await Deno.readTextFile(FIXTURE_PATH);
  return JSON.parse(text);
}

const PROFILE: AldiStoreProfile = {
  servicePoint: "G452",
  categoryKeys: ["1588161426952145", "1588161420755352"],
};

Deno.test("parseAldiPayload maps the fixture to RawDeal[] with priceCents set and discountPercent null", async () => {
  // Arrange
  const fixture = await loadFixture();

  // Act
  const deals = parseAldiPayload(fixture);

  // Assert
  assertEquals(deals.length, 3);
  for (const deal of deals) {
    assertEquals(deal.source, "aldi");
    assertEquals(deal.store, "Aldi");
    assertEquals(deal.discountPercent, null);
    assertEquals(typeof deal.priceCents, "number");
  }
  assertEquals(deals[0].title, "Sourdough Vienna Loaf 660g");
  assertEquals(
    deals[0].url,
    "https://www.aldi.com.au/product/bakers-life-sourdough-vienna-loaf-660g",
  );
  assertEquals(deals[0].priceCents, 349);
  assertEquals(deals[0].wasPriceCents, null);
  assertEquals(deals[0].department, "Bakery");
  assertEquals(deals[1].wasPriceCents, 649);
  assertEquals(deals[2].department, null);
});

Deno.test("parseAldiPayload returns [] for an empty data array", () => {
  // Arrange
  const payload = { data: [] };

  // Act
  const deals = parseAldiPayload(payload);

  // Assert
  assertEquals(deals, []);
});

Deno.test("parseAldiPayload throws when an entry is missing a required field (name)", () => {
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
  assertThrows(() => parseAldiPayload(payload));
});

Deno.test("parseAldiPayload throws on a wholly invalid payload", () => {
  // Act + Assert
  assertThrows(() => parseAldiPayload({ nope: true }));
  assertThrows(() => parseAldiPayload("not an object"));
  assertThrows(() => parseAldiPayload(null));
});

Deno.test("fetchAldi merges results across categoryKeys and de-duplicates by url", async () => {
  // Arrange
  const fixture = await loadFixture();
  const calls: string[] = [];
  const fetchFn: typeof fetch = (input) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  // Act
  const deals = await fetchAldi(PROFILE, fetchFn);

  // Assert: one request per categoryKey, but the same 3 products both
  // times collapse to 3 unique deals (deduped by url).
  assertEquals(calls.length, 2);
  assertEquals(calls[0].includes(PROFILE.categoryKeys[0]), true);
  assertEquals(calls[1].includes(PROFILE.categoryKeys[1]), true);
  assertEquals(deals.length, 3);
  const urls = deals.map((deal: RawDeal) => deal.url);
  assertEquals(new Set(urls).size, urls.length);
});

Deno.test("fetchAldi throws AldiSourceError on a non-2xx response", async () => {
  // Arrange
  const fetchFn: typeof fetch = () =>
    Promise.resolve(new Response(null, { status: 403 }));

  // Act + Assert
  await assertRejects(
    () => fetchAldi(PROFILE, fetchFn),
    AldiSourceError,
    "403",
  );
});

Deno.test("fetchAldi throws the typed non-JSON error (not a raw SyntaxError) on an HTML body", async () => {
  // Arrange
  const fetchFn: typeof fetch = () =>
    Promise.resolve(
      new Response("<html>Access Denied</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

  // Act + Assert
  await assertRejects(
    () => fetchAldi(PROFILE, fetchFn),
    AldiSourceError,
  );
});
