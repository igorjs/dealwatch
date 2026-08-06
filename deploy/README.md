# Deploying dealwatch on Cloudflare

Dealwatch v2 runs entirely on Cloudflare: a Worker on a Cron Trigger drives
three Browser Rendering sessions (Aldi, Woolworths, Coles), dedupes and
matches against the watchlist, writes the shopping list to R2, and pushes
matches to ntfy. There is no server to manage and nothing to install on a
device. This doc covers provisioning D1 and R2, setting secrets, deploying,
and verifying a live run.

## 1. Prerequisites

- A Cloudflare account.
- `wrangler` installed and logged in:
  ```sh
  npx wrangler login
  ```
- Node 26, the version pinned in `mise.toml`. If you use `mise`, `mise install`
  picks it up automatically.

## 2. Provision D1

Create the database:

```sh
npx wrangler d1 create dealwatch
```

This prints a `database_id`. Copy it into `wrangler.jsonc`, replacing the
placeholder at `d1_databases[0].database_id`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "dealwatch",
    // Placeholder UUID. Replace with the real id printed by
    // `wrangler d1 create dealwatch` before the first deploy.
    "database_id": "00000000-0000-0000-0000-000000000000",
    "migrations_dir": "migrations"
  }
],
```

## 3. Apply migrations

```sh
npx wrangler d1 migrations apply dealwatch --remote
```

This runs `migrations/0001_init.sql` against the remote database, creating
`seen_deal` (dedupe state) and `source_health` (per-source failure tracking).

## 4. Provision R2

Create the bucket that backs the `LIST` binding. The name must match
`r2_buckets[0].bucket_name` in `wrangler.jsonc`:

```sh
npx wrangler r2 bucket create dealwatch-shopping-list
```

## 5. Set secrets

The Worker reads two secrets, both required. `API_TOKEN` gates every HTTP
route (`POST /run`, `GET /health`, `GET /shopping-list`) as a bearer token.
Generate a random one first:

```sh
openssl rand -hex 32
npx wrangler secret put API_TOKEN
```

`NTFY_TOPIC_URL` is the full ntfy.sh topic URL matches get pushed to, e.g.
`https://ntfy.sh/your-private-topic-name`:

```sh
npx wrangler secret put NTFY_TOPIC_URL
```

## 6. Browser Rendering

No provisioning step here: the `BROWSER` binding in `wrangler.jsonc` is tied
to your account, not a named resource like D1 or R2, so there's nothing to
create or name.

One thing worth knowing before you deploy: Browser Rendering needs the
Workers Paid plan. It bills on session duration and concurrency, and the Free
plan's daily duration cap is tight for three serial sessions per run, twice a
week. More on this in the caveats below.

## 7. Cron schedule

The schedule already lives in `wrangler.jsonc`:

```jsonc
"triggers": {
  // Wed and Sat, 19:00 UTC.
  "crons": ["0 19 * * 3", "0 19 * * 6"]
}
```

Edit the `crons` array to change when it fires. There's no separate
registration step: `wrangler deploy` picks up whatever's currently
configured.

## 8. Deploy

```sh
npm run deploy
```

This runs `wrangler deploy` and pushes the Worker live.

## 9. Verify a live run

Trigger a manual pass:

```sh
curl -X POST https://<your-worker>.workers.dev/run \
  -H "Authorization: Bearer <API_TOKEN>"
```

Give it a few minutes: three serial Browser Rendering sessions plus
pagination isn't instant. It returns a JSON summary
(`{ fetched, matched, sourceFailures }`) once the pass completes.

Then confirm the shopping list landed in R2:

```sh
curl https://<your-worker>.workers.dev/shopping-list \
  -H "Authorization: Bearer <API_TOKEN>"
```

If the watchlist matched anything this run, you should also see a
notification on your ntfy topic.

## Operational caveats

- **Workers Paid plan is required.** D1, R2, Browser Rendering, Cron
  Triggers, and secrets together assume it; this isn't a Free-tier setup.
- **Browser Rendering bills on session duration and concurrency.** On the
  Free tier the daily duration cap is easy to blow through if a manual
  `POST /run` verification lands on the same day a Cron fire already used
  part of the budget. Verify on a non-Cron day, accept the risk, or just use
  Paid, which doesn't have this ceiling.
- **`POST /run` has no concurrent-invocation guard.** Don't fire it
  repeatedly or in parallel: overlapping Browser Rendering sessions can hit
  the account's concurrency limit and start failing each other.
- **DB recovery re-alerts once.** If D1 ever needs to be recreated (corruption,
  accidental deletion), re-running the migrations rebuilds the schema, but
  dedupe state (`seen_deal`) is gone. Every deal that currently matches the
  watchlist will alert again, once, on the next run. This is expected, not a
  bug, and matches the recovery story v1 had with its local sqlite file.
