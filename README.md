# Dealwatch

A personal half-price grocery alert pipeline. It watches Woolworths, Coles,
and Aldi for specials, matches them against a keyword watchlist, writes
matches to a shopping list in R2, and pushes an alert via ntfy.

It's split into two parts: a fetcher (`fetcher/`) that GitHub Actions runs
on a schedule, driving a real browser session against each store, and a
Cloudflare Worker (`src/`) that receives the fetcher's results, dedupes and
matches them against the watchlist, and delivers the alert. See `AGENTS.md`
for the full layout.

## Quick start

Worker:

1. Install dependencies:
   ```
   npm install
   ```
2. Run the tests:
   ```
   npm test
   ```
3. Run the Worker locally:
   ```
   npm run dev
   ```

Fetcher:

1. Install dependencies and the browser it drives:
   ```
   npm --prefix fetcher ci
   npx --prefix fetcher playwright install --with-deps chromium
   ```
2. Run the fetcher's tests:
   ```
   npm --prefix fetcher test
   ```

For agent/contributor guidance (layout, conventions, recovery notes) see
`AGENTS.md`.

## Deploying

See `deploy/README.md` for the full walkthrough: provisioning D1 and R2,
setting the Worker's secrets, deploying it, and setting up the GitHub
Actions secrets the fetcher needs.

## Note

This is personal-use software. It is not intended for redistributing data
scraped from any store.
