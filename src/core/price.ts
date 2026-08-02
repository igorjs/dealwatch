/**
 * Coerces a raw store price field to integer cents.
 *
 * Store payloads express a price as a dollar amount — a number (`5`,
 * `5.5`) or a numeric string (`"5.50"`) — never already in cents. This
 * treats any finite numeric value as dollars and rounds to the nearest
 * cent (`Math.round(dollars * 100)`). A source that actually serves cents
 * is a per-store concern confirmed against real fixtures in later work
 * units, not something this shared helper guesses at.
 *
 * Anything that isn't a finite number — `null`, `undefined`, a
 * non-numeric string, `NaN`, or any other type — yields `null`. An
 * unknown price is left null, never faked to `0`.
 */
export function toCents(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const dollars = Number(trimmed);
    return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
  }
  return null;
}

/**
 * Computes the whole-percent discount between a current and "was" price,
 * both in cents. Returns `null` (rather than a faked or negative value)
 * whenever the result would be meaningless:
 * - either price is unknown (`null`)
 * - `wasCents` is zero or negative (would divide by zero / invert sign)
 * - the price increased (`wasCents < priceCents`) — never report a
 *   negative discount
 *
 * Otherwise returns `Math.round((1 - priceCents / wasCents) * 100)`.
 */
export function computeDiscountPercent(
  priceCents: number | null,
  wasCents: number | null,
): number | null {
  if (priceCents === null || wasCents === null) return null;
  if (wasCents <= 0) return null;
  if (wasCents < priceCents) return null;
  return Math.round((1 - priceCents / wasCents) * 100);
}
