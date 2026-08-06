import type { Deal, Watch } from "../types";

/** Escapes regex metacharacters so a watch term is matched literally, never as a pattern. */
function escapeForRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the deal's title contains the watch term as a whole word,
 * case-insensitive. Uses Unicode-aware boundaries (letter/number/underscore)
 * rather than `\b`: JS `\b` is ASCII-only, so a term with a leading or trailing
 * non-ASCII letter (cafe with an accent, acai, uber) would never match next to
 * a space or line edge.
 */
function titleContainsTerm(title: string, term: string): boolean {
  const boundedPattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeForRegex(term)}(?![\\p{L}\\p{N}_])`,
    "iu",
  );
  return boundedPattern.test(title);
}

/** True when the deal clears the watch's discount floor, or the discount is unknown (keyword alone decides). */
function meetsDiscountFloor(deal: Deal, watch: Watch): boolean {
  return deal.discountPercent === null ||
    deal.discountPercent >= watch.minDiscountPercent;
}

/** True when none of the watch's exclude terms appear in the deal title (case-insensitive substring). */
function hasNoExcludedTerm(title: string, exclude: string[]): boolean {
  const lowerTitle = title.toLowerCase();
  return exclude.every((term) => !lowerTitle.includes(term.toLowerCase()));
}

/** True when a single watch entry matches: term hit, discount floor cleared, no exclude hit. */
function matchesWatch(deal: Deal, watch: Watch): boolean {
  return titleContainsTerm(deal.title, watch.term) &&
    meetsDiscountFloor(deal, watch) &&
    hasNoExcludedTerm(deal.title, watch.exclude);
}

/** True when the deal matches any entry in the watchlist. */
export function match(deal: Deal, watchlist: Watch[]): boolean {
  return watchlist.some((watch) => matchesWatch(deal, watch));
}
