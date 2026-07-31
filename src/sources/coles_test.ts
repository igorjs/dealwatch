import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fetchColes, parseColesPayload } from "./coles.ts";
import { SourceError } from "./errors.ts";
import type { RawDeal, StoreProfile } from "../types.ts";

// PLACEHOLDER fixture, HIGH uncertainty: only Coles' GetProductCategories
// operation has been captured, not the half-price product-listing operation
// this schema/fixture models a best-effort guess at. See the note at the
// top of test/fixtures/coles.json and in coles.ts.
const FIXTURE_PATH = new URL(
  "../../test/fixtures/coles.json",
  import.meta.url,
);

async function loadFixture(): Promise<unknown> {
  const text = await Deno.readTextFile(FIXTURE_PATH);
  return JSON.parse(text);
}

const PROFILE: StoreProfile = {
  url: "https://www.coles.com.au/api/graphql",
  headers: {
    "ocp-apim-subscription-key": "test-subscription-key",
  },
};

Deno.test("parseColesPayload maps the fixture to RawDeal[]", async () => {
  // Arrange
  const fixture = await loadFixture();

  // Act
  const deals = parseColesPayload(fixture);

  // Assert
  assertEquals(deals.length, 3);
  for (const deal of deals) {
    assertEquals(deal.source, "coles");
    assertEquals(deal.store, "Coles");
    assertEquals(deal.discountPercent, null);
    assertEquals(typeof deal.priceCents, "number");
  }
  assertEquals(deals[0].title, "Tim Tam Original 200g");
  assertEquals(
    deals[0].url,
    "https://www.coles.com.au/product/tim-tam-original-200g-12345",
  );
  assertEquals(deals[0].priceCents, 250);
  assertEquals(deals[0].wasPriceCents, 500);
  assertEquals(deals[0].department, "Biscuits & Crackers");
  assertEquals(deals[1].wasPriceCents, null);
  assertEquals(deals[2].department, null);
});

Deno.test("parseColesPayload returns [] for an empty results array", () => {
  // Arrange
  const payload = { data: { results: { results: [], totalCount: 0 } } };

  // Act
  const deals = parseColesPayload(payload);

  // Assert
  assertEquals(deals, []);
});

Deno.test("parseColesPayload throws when an entry is missing a required field (name)", () => {
  // Arrange
  const payload = {
    data: {
      results: {
        results: [
          {
            id: 99999,
            brand: "Mystery",
            pricing: { now: 1.5, was: 3.0 },
            seoToken: "mystery-item-99999",
            onlineHeirs: [],
            // name intentionally missing
          },
        ],
        totalCount: 1,
      },
    },
  };

  // Act + Assert
  assertThrows(() => parseColesPayload(payload));
});

Deno.test("parseColesPayload throws on a wholly invalid payload", () => {
  // Act + Assert
  assertThrows(() => parseColesPayload({ nope: true }));
  assertThrows(() => parseColesPayload("not an object"));
  assertThrows(() => parseColesPayload(null));
});

Deno.test("fetchColes returns RawDeal[] on a successful response", async () => {
  // Arrange
  const fixture = await loadFixture();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  // Act
  const deals = await fetchColes(PROFILE, fetchFn);

  // Assert
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, PROFILE.url);
  assertEquals(calls[0].init?.method, "POST");
  const deal = deals[0] as RawDeal;
  assertEquals(deal.source, "coles");
  assertEquals(deals.length, 3);
});

Deno.test("fetchColes throws SourceError on a non-2xx response (429)", async () => {
  // Arrange
  const fetchFn: typeof fetch = () =>
    Promise.resolve(new Response(null, { status: 429 }));

  // Act + Assert
  await assertRejects(
    () => fetchColes(PROFILE, fetchFn),
    SourceError,
    "429",
  );
});

Deno.test("fetchColes throws SourceError (not a raw SyntaxError) on a 200 HTML body", async () => {
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
    () => fetchColes(PROFILE, fetchFn),
    SourceError,
  );
});
