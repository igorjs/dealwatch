# Dealwatch

A personal half-price grocery alert pipeline. It watches Woolworths, Coles,
and Aldi for specials, matches them against a keyword watchlist, writes
matches to a shopping list in R2, and pushes an alert via ntfy. It runs as a
single Cloudflare Worker, fired by a Cron Trigger, doing one pass over all
three stores per invocation.

## Quick start

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

For agent/contributor guidance (layout, conventions, recovery notes) see
`AGENTS.md`.

## Deploying

See `deploy/README.md` for the full walkthrough: provisioning D1 and R2,
setting Worker secrets, and running `npm run deploy`.

## Note

This is personal-use software. It is not intended for redistributing data
scraped from any store.
