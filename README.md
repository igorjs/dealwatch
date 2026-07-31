# Dealwatch

A personal half-price grocery alert pipeline. It watches Woolworths, Coles, and Aldi for specials, matches them against a keyword watchlist, appends matches to a local `shopping-list.json` grouped by category, and pushes an alert via ntfy. Built to run on a Raspberry Pi, on a timer, doing one pass per run.

## Quick start

1. Install Deno via [mise](https://mise.jdx.dev/): `mise install`
2. Copy the example config and fill in your own values:
   ```
   cp config.example.json config.local.json
   ```
   Set your watchlist terms, your ntfy topic URL, and (once captured) each store's request profile.
3. Run the tests:
   ```
   deno task test
   ```
4. Run a pass:
   ```
   deno task run config.local.json dealwatch.db
   ```

For agent/contributor guidance (layout, conventions, recovery notes) see `AGENTS.md`.

## Running on the Pi

See `deploy/README.md` for the systemd service and timer setup.

## Note

This is personal-use software. It is not intended for redistributing data scraped from any store.
