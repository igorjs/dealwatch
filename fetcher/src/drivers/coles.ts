import type { RawDeal } from "../../../src/types.ts";
import { parseColesPayload } from "../../../src/sources/coles.ts";
import type { PageLike } from "../browser.ts";
import { SourceError } from "../errors.ts";

/**
 * SCHEMA WARNING: `ColesPayloadSchema`, used here through `parseColesPayload`,
 * is a placeholder guess (see the comment above it in src/sources/coles.ts),
 * never checked against a real Coles response. WU-14 captures a live payload
 * and corrects it. This driver is written against the guess as it stands; it
 * must not loosen the parser or improve the guess.
 */

/**
 * The half-price specials page. A real browser loading it renders about 900
 * product tiles and mints the `reese84`, `visid_incap`, `nlbi` and
 * `incap_ses` cookies a plain request lacks; without them the API responds
 * 401 "missing subscription key" (2026-08-04 spike). Product data itself
 * arrives over a `/api/graphql` response fired while the page loads, so the
 * driver intercepts that response instead of scraping the rendered DOM.
 */
const COLES_SPECIALS_URL = "https://www.coles.com.au/on-special?filter_Special=halfprice";

/** Every GraphQL call this page fires goes through this one path. */
const COLES_GRAPHQL_PATH = "/api/graphql";

/**
 * Bounds how long the driver waits for a `/api/graphql` response whose body
 * structurally matches the product-listing shape. Several unrelated GraphQL
 * operations fire on this same page too (category tree, cart, and so on),
 * so the first `/api/graphql` response seen is not necessarily the right
 * one. Playwright's own `waitForResponse` already tests every response
 * against the predicate, in arrival order, and resolves on the first match,
 * so a timeout is the bound the PageLike seam supports cleanly, rather than
 * hand-rolled counting through `page.on("response", ...)`.
 */
const RESPONSE_TIMEOUT_MS = 30_000;

/**
 * True when `body` is shaped the way `parseColesPayload` expects. Reuses
 * `parseColesPayload` itself as the structural test and discards its
 * result, instead of duplicating `ColesPayloadSchema` here: that schema is
 * not exported, and a second, hand-rolled copy in this file could drift
 * from the real one, especially once WU-14 corrects it.
 */
function matchesColesPayload(body: unknown): boolean {
  try {
    parseColesPayload(body);
    return true;
  } catch {
    return false;
  }
}

async function isColesProductListingResponse(response: {
  url(): string;
  json(): Promise<unknown>;
}): Promise<boolean> {
  if (!response.url().includes(COLES_GRAPHQL_PATH)) {
    return false;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return false;
  }

  return matchesColesPayload(body);
}

/**
 * Navigates the half-price specials page and captures the `/api/graphql`
 * response whose body structurally matches the product-listing schema,
 * disambiguating among however many GraphQL calls the page fires rather
 * than taking the first one seen. Returns the RAW matched body: it does not
 * parse it into `RawDeal[]` itself, so the caller parses exactly once
 * instead of the driver parsing once per candidate response it inspects.
 *
 * Throws `SourceError` if no response matches within `RESPONSE_TIMEOUT_MS`.
 * The error message never carries a cookie, a header, or a response body.
 */
export async function driveColes(page: PageLike): Promise<unknown> {
  let response: { url(): string; json(): Promise<unknown> };

  try {
    [response] = await Promise.all([
      page.waitForResponse(isColesProductListingResponse, { timeout: RESPONSE_TIMEOUT_MS }),
      page.goto(COLES_SPECIALS_URL, { waitUntil: "domcontentloaded" }),
    ]);
  } catch {
    throw new SourceError("coles", "no product listing response was seen matching the expected schema");
  }

  return response.json();
}

/**
 * Drives the Coles half-price GraphQL response and parses it exactly once
 * with `parseColesPayload`.
 *
 * A matched response with 0 products is treated as a failure, not a
 * healthy empty fetch: a datacenter runner IP can be soft bot-blocked with
 * a valid-shaped, empty response instead of an HTTP error, and recording
 * that as healthy would hide the store silently until the watchlist
 * stopped matching anything without anyone noticing why.
 */
export async function fetchColes(page: PageLike): Promise<RawDeal[]> {
  const raw = await driveColes(page);
  const deals = parseColesPayload(raw);

  if (deals.length === 0) {
    throw new SourceError("coles", "coles returned 0 deals (possible soft bot-block)");
  }

  return deals;
}
