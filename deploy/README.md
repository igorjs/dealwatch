# Deploying dealwatch

Dealwatch is split across two deployables: a fetcher that GitHub Actions
runs on a schedule, driving a real browser session against Aldi, Woolworths,
and Coles, and a Cloudflare Worker that receives the fetcher's results,
dedupes and matches them against the watchlist, writes the shopping list to
R2, and pushes matches to ntfy. This doc covers provisioning D1 and R2 for
the Worker, setting both halves' secrets, deploying the Worker, and
verifying a live run.

## 1. Prerequisites

- A Cloudflare account.
- `wrangler` installed and logged in:
  ```sh
  npx wrangler login
  ```
- Node 26 for the Worker's tooling (wrangler, vitest), the version pinned in
  `mise.toml`. If you use `mise`, `mise install` picks it up automatically.
- Node 18 or newer for the fetcher itself: `fetcher/package.json` pins
  `engines.node >= 18`. GitHub Actions installs Node 20 for the scheduled
  job, so that's the version to match locally if you want to run the
  fetcher the same way Actions does.
- A GitHub repository with Actions enabled, and optionally the `gh` CLI, to
  set the repository secrets the fetcher needs (step 7).

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

## 5. Set the Worker's secrets

The Worker reads two secrets, both required. `API_TOKEN` gates every HTTP
route (`POST /ingest`, `GET /health`, `GET /shopping-list`) as a bearer
token. It's the same token the fetcher sends with every ingest request, so
generate it once and reuse it in step 7:

```sh
openssl rand -hex 32
npx wrangler secret put API_TOKEN
```

> **`API_TOKEN` is a value you invent here.** Nobody issues it. It exists only
> so the Worker can tell your fetcher apart from anyone else who finds the
> URL, which matters because this repo is public.
>
> It is **not** `CLOUDFLARE_API_TOKEN`. That's a real Cloudflare account
> credential, used by Terraform in `infra/` to provision R2, and this repo
> already has one set as an Actions secret. Never reuse it as `API_TOKEN`:
> doing so would hand an account-level credential to the fetcher job and put
> it in the `Authorization` header of every ingest request. Two unrelated
> things with similar names.

`NTFY_TOPIC_URL` is the full ntfy.sh topic URL matches get pushed to, e.g.
`https://ntfy.sh/your-private-topic-name`:

```sh
npx wrangler secret put NTFY_TOPIC_URL
```

## 6. Deploy the Worker

```sh
npm run deploy
```

This runs `wrangler deploy` and pushes the Worker live. Note the URL it
prints, e.g. `https://dealwatch.<your-subdomain>.workers.dev`: the fetcher
needs `<that URL>/ingest` as `WORKER_INGEST_URL` in the next step.

## 7. Set the fetcher's GitHub Actions secrets

This repository is public, so the fetcher's schedule lives in a GitHub
Actions workflow, `.github/workflows/fetch.yml`, whose triggers are
intentionally limited to `schedule` and `workflow_dispatch`. It never
triggers on `pull_request`: a fork's pull request must never be able to
reach these secrets.

Two repository secrets must exist before the first scheduled run:

- `API_TOKEN`: the same bearer token you set on the Worker in step 5. The two
  values must match exactly, and again, this is not `CLOUDFLARE_API_TOKEN`.
- `WORKER_INGEST_URL`: the full URL of the Worker's `/ingest` route from
  step 6, e.g. `https://dealwatch.<your-subdomain>.workers.dev/ingest`.
  Treat this as a secret too. It is the only address that accepts writes, so
  publishing it hands an attacker half the problem.

You'll see a third secret, `CLOUDFLARE_API_TOKEN`, already set on the repo.
That one belongs to the Terraform config in `infra/` and the fetcher never
reads it. Leave it alone.

Set them with the `gh` CLI:

```sh
gh secret set API_TOKEN
gh secret set WORKER_INGEST_URL
```

Or set them in the GitHub UI, under the repository's Settings, Secrets and
variables, Actions.

## 8. Schedule

The schedule already lives in `.github/workflows/fetch.yml`, currently set
to fire twice a week: Wednesday and Saturday at 19:00 UTC. Edit the time
fields in the workflow's schedule trigger to change when it fires. There's
no separate registration step: GitHub Actions picks up whatever's committed
to the workflow file on the default branch.

## 9. Verify a live run

There is no `POST /run` route any more. Trigger the fetcher manually with:

```sh
gh workflow run fetch.yml
```

Or use the "Run workflow" button on the "Fetch deals" workflow in the
repository's Actions tab. Give it a few minutes: three serial browser
sessions plus pagination isn't instant. Watch the run's logs in the Actions
tab; the job only fails if the ingest POST itself failed, since a single
store failing to fetch is recorded as a per-source failure, not a process
failure.

Once the run completes, confirm the shopping list landed in R2:

```sh
curl https://<your-worker>.workers.dev/shopping-list \
  -H "Authorization: Bearer <API_TOKEN>"
```

If the watchlist matched anything this run, you should also see a
notification on your ntfy topic.

## Operational caveats

- **The repository being public shapes the workflow's triggers.**
  `.github/workflows/fetch.yml` only reacts to `schedule` and
  `workflow_dispatch`. Never add a `pull_request` trigger: that would let a
  forked pull request's workflow run see `API_TOKEN` and
  `WORKER_INGEST_URL`.
- **`POST /ingest` has caps, not just a bearer check.** The body is capped
  at 5 MB and each source's result at 5,000 deals; both return a 400 rather
  than let a malformed or oversized request through. A leaked `API_TOKEN`
  could still be used to poison the shopping list or flood D1's dedupe
  table with junk; there's no heavier auth model here, this is a personal,
  single-user tool.
- **Runs never overlap.** The workflow's `concurrency` group
  (`fetch-deals`, `cancel-in-progress: false`) means a manual run started
  while a scheduled run is still going waits its turn instead of racing it.
- **DB recovery re-alerts once.** If D1 ever needs to be recreated
  (corruption, accidental deletion), re-running the migrations rebuilds the
  schema, but dedupe state (`seen_deal`) is gone. Every deal that currently
  matches the watchlist will alert again, once, on the next run. This is
  expected, not a bug.
