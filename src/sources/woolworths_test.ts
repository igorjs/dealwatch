import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fetchWoolworths, parseWoolworthsPayload } from "./woolworths.ts";
import { SourceError } from "./errors.ts";
import type { RawDeal, StoreProfile } from "../types.ts";

// PLACEHOLDER fixture: no real Woolworths browse/category response is
// captured yet. See the note at the top of test/fixtures/woolworths.json
// and in woolworths.ts.
const FIXTURE_PATH = new URL(
  "../../test/fixtures/woolworths.json",
  import.meta.url,
);

async function loadFixture(): Promise<unknown> {
  const text = await Deno.readTextFile(FIXTURE_PATH);
  return JSON.parse(text);
}

const PROFILE: StoreProfile = {
  url: "https://www.woolworths.com.au/apis/ui/browse/category",
  headers: {
    "wow-auth-token": "test-token",
    cookie: "_abck=test; bm_sz=test",
  },
};

Deno.test("parseWoolworthsPayload maps the fixture to RawDeal[] with title/url/prices", async () => {
  // Arrange
  const fixture = await loadFixture();

  // Act
  const deals = parseWoolworthsPayload(fixture);

  // Assert
  assertEquals(deals.length, 3);
  for (const deal of deals) {
    assertEquals(deal.source, "woolworths");
    assertEquals(deal.store, "Woolworths");
    assertEquals(deal.discountPercent, null);
    assertEquals(typeof deal.priceCents, "number");
  }
  assertEquals(deals[0].title, "Woolworths Full Cream Milk 3L");
  assertEquals(
    deals[0].url,
    "https://www.woolworths.com.au/shop/productdetails/123456/woolworths-full-cream-milk-3l",
  );
  assertEquals(deals[0].priceCents, 450);
  assertEquals(deals[0].wasPriceCents, 900);
  assertEquals(deals[0].department, "Dairy, Eggs & Fridge");
  assertEquals(deals[1].wasPriceCents, 600);
  assertEquals(deals[2].wasPriceCents, null);
  assertEquals(deals[2].department, null);
});

Deno.test("parseWoolworthsPayload returns [] when every bundle has an empty products array", () => {
  // Arrange
  const payload = { bundles: [{ products: [] }] };

  // Act
  const deals = parseWoolworthsPayload(payload);

  // Assert
  assertEquals(deals, []);
});

Deno.test("parseWoolworthsPayload throws when an entry is missing a required field (name)", () => {
  // Arrange
  const payload = {
    bundles: [
      {
        products: [
          {
            stockcode: 999999,
            price: { price: 1.99, wasPrice: null },
            urlFriendlyName: "mystery-product",
            // name intentionally missing
          },
        ],
      },
    ],
  };

  // Act + Assert
  assertThrows(() => parseWoolworthsPayload(payload));
});

Deno.test("parseWoolworthsPayload throws on a wholly invalid payload", () => {
  // Act + Assert
  assertThrows(() => parseWoolworthsPayload({ nope: true }));
  assertThrows(() => parseWoolworthsPayload("not an object"));
  assertThrows(() => parseWoolworthsPayload(null));
});

Deno.test("fetchWoolworths posts the captured half-price request and returns parsed RawDeal[]", async () => {
  // Arrange
  const fixture = await loadFixture();
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchFn: typeof fetch = (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Promise.resolve(
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  // Act
  const deals = await fetchWoolworths(PROFILE, fetchFn);

  // Assert
  assertEquals(capturedUrl, PROFILE.url);
  assertEquals(capturedInit?.method, "POST");
  const body = JSON.parse(String(capturedInit?.body));
  assertEquals(body.categoryId, "specialsgroup.3676");
  assertEquals(body.pageNumber, 1);
  assertEquals(body.pageSize, 24);
  const headers = capturedInit?.headers as Record<string, string>;
  assertEquals(headers["wow-auth-token"], "test-token");
  assertEquals(deals.length, 3);
  const urls = deals.map((deal: RawDeal) => deal.url);
  assertEquals(new Set(urls).size, urls.length);
});

Deno.test("fetchWoolworths throws SourceError on a non-2xx response (403)", async () => {
  // Arrange
  const fetchFn: typeof fetch = () =>
    Promise.resolve(new Response(null, { status: 403 }));

  // Act + Assert
  await assertRejects(
    () => fetchWoolworths(PROFILE, fetchFn),
    SourceError,
    "403",
  );
});

Deno.test("fetchWoolworths throws SourceError, not a raw SyntaxError, on a 200 with an HTML body", async () => {
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
    () => fetchWoolworths(PROFILE, fetchFn),
    SourceError,
  );
});
