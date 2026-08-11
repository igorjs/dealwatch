import type { RawDeal } from "../../../src/types.ts";
import { parseColesPayload } from "../../../src/sources/coles.ts";
import type { PageLike } from "../browser.ts";
import { SourceError, zeroDealSoftBlock } from "../errors.ts";

/**
 * The half-price specials page. A real browser loading it renders about 900
 * product tiles and mints the `reese84`, `visid_incap`, `nlbi` and
 * `incap_ses` cookies a plain request lacks. Page 1 of results is
 * server-rendered into the page's `__NEXT_DATA__` script tag, not returned
 * by a GraphQL call the driver could intercept: the only `/api/graphql`
 * request this page fires on load is the category tree (the same operation
 * v1 captured), not the product listing (verified 2026-08-11 against the
 * live page's `performance.getEntriesByType("resource")`).
 *
 * ONLY PAGE ONE IS FETCHED, about 48 of roughly 894 half-price products, and
 * that is deliberate. The site does page by `&page=N` (verified: page 2
 * returns 48 different products, `start: 1`), but Coles velocity-blocks a
 * session after only a handful of quick navigations. Loading pages 1, 2 and
 * 19 back to back got an Incapsula block, and the block then covered page 1
 * too, which had loaded fine moments earlier, and had not lifted 45 seconds
 * later (measured 2026-08-11). Looping 19 pages unthrottled would therefore
 * turn a partial fetch into no fetch at all. Adding paging needs a real
 * delay between pages AND evidence from a GitHub runner IP about the
 * threshold and the block's decay, which only a live `workflow_dispatch` can
 * give. Do not add it from a guess.
 */
const COLES_SPECIALS_URL = "https://www.coles.com.au/on-special?filter_Special=halfprice";

/**
 * Declared locally, not pulled from a "dom" lib: fetcher/tsconfig.json scopes
 * `lib` to plain ES2022, so `document` is not an ambient type here even
 * though the function below runs inside a real browser page (via
 * `page.evaluate`), where a real `document` exists at runtime regardless.
 */
declare const document: {
  getElementById(id: string): { textContent: string | null } | null;
};

/**
 * Reads the `__NEXT_DATA__` script tag's raw JSON text out of the rendered
 * page. Runs inside the browser page, not this process, so `page.evaluate`
 * only serialises back what this returns: a string, or `null` when the tag
 * is absent (an Incapsula block page is a tiny HTML document with an
 * `_Incapsula_Resource` script and no `__NEXT_DATA__` tag, seen directly
 * during the 2026-08-11 capture).
 */
function readNextDataText(): string | null {
  return document.getElementById("__NEXT_DATA__")?.textContent ?? null;
}

/**
 * Navigates the half-price specials page and returns the parsed
 * `__NEXT_DATA__` object. Returns the RAW parsed object: it does not
 * validate it against `ColesPayloadSchema` itself, so the caller parses
 * exactly once instead of the driver parsing once more on top.
 *
 * Only page 1 is captured this way (48 to 60 of the 894 results seen on
 * capture day); paging is not implemented here.
 *
 * Throws `SourceError` if `__NEXT_DATA__` is absent or its content is not
 * valid JSON.
 */
export async function driveColes(page: PageLike): Promise<unknown> {
  await page.goto(COLES_SPECIALS_URL, { waitUntil: "domcontentloaded" });
  const text = (await page.evaluate(readNextDataText)) as string | null;

  if (text === null) {
    throw new SourceError("coles", "no __NEXT_DATA__ script tag was found (likely a bot block page)");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError("coles", "__NEXT_DATA__ content was not valid JSON");
  }
}

/**
 * Drives the Coles `__NEXT_DATA__` payload and parses it exactly once with
 * `parseColesPayload`.
 *
 * A parsed result with 0 products is treated as a failure, not a healthy
 * empty fetch: a datacenter runner IP can be soft bot-blocked with a
 * valid-shaped, empty response instead of an HTTP error, and recording that
 * as healthy would hide the store silently until the watchlist stopped
 * matching anything without anyone noticing why.
 */
export async function fetchColes(page: PageLike): Promise<RawDeal[]> {
  const raw = await driveColes(page);
  const deals = parseColesPayload(raw);

  if (deals.length === 0) {
    throw zeroDealSoftBlock("coles");
  }

  return deals;
}
