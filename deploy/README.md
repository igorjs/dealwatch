# Deploying dealwatch on a Raspberry Pi

Dealwatch runs as a `systemd` oneshot service (`dealwatch.service`) fired every
20 minutes (with jitter) by a `systemd` timer (`dealwatch.timer`). Each run is a
single pipeline pass: check which sources are due, fetch, dedupe, match against
the watchlist, write `shopping-list.json`, push new matches to ntfy, then exit.
There is no long-running daemon.

This doc covers: installing the code and Deno, creating a dedicated user,
supplying secrets via `config.local.json`, **verifying NTP time sync**,
installing the unit + timer, and checking status afterwards.

## 1. Where the code lives

Install (or `git clone`) the repo to `/opt/dealwatch`. The unit files in this
doc assume that exact path.

```sh
sudo mkdir -p /opt/dealwatch
sudo git clone <this-repo-url> /opt/dealwatch
# or: rsync a working copy over instead of cloning on-device
```

## 2. Install Deno

Any install method that puts a `deno` binary on the Pi works; this repo pins a
version via `mise.toml`, so `mise` is the easiest path if you already use it:

```sh
curl https://mise.run | sh          # if mise isn't installed yet
cd /opt/dealwatch && mise install   # installs the pinned deno version
```

Or the official installer:

```sh
curl -fsSL https://deno.land/install.sh | sh
```

Either way, note **where the `deno` binary ends up** (`~/.deno/bin/deno`, an
mise shim, etc.) — `dealwatch.service` needs to find it under systemd's minimal
PATH, which is covered in step 6.

## 3. Create the dealwatch user

The service runs as an unprivileged, dedicated user, never as `root` or your
login user:

```sh
sudo useradd --system --home-dir /opt/dealwatch --shell /usr/sbin/nologin dealwatch
sudo chown -R dealwatch:dealwatch /opt/dealwatch
```

## 4. Create `config.local.json` (secrets — never committed)

`config.example.json` in the repo root documents the shape (watchlist,
`sinks.ntfy.topicUrl`, and per-store profiles under `stores`). Copy it to
`config.local.json` in `/opt/dealwatch` and fill in the real values:

```sh
sudo -u dealwatch cp /opt/dealwatch/config.example.json /opt/dealwatch/config.local.json
sudo -u dealwatch nano /opt/dealwatch/config.local.json
```

Fill in:

- Your real `watchlist` (terms, discount floors, excludes).
- `sinks.ntfy.topicUrl` — your ntfy topic to push to.
- `stores.aldi.servicePoint` — your local Aldi store code.
- `stores.coles.headers` / `stores.woolworths.headers` — the captured request
  profile (cookies/tokens) from `scripts/STORE-CAPTURE.md`. Capture these **on
  the Pi** against the Pi's own network session, not copied from another
  machine.

`config.local.json` is gitignored — it holds real cookies and your ntfy topic.
**Never commit it, never paste its contents into an issue/PR/chat.** If a
capture is ever shared or exposed, treat those cookies as compromised and
re-capture fresh.

`shopping-list.json` and `dealwatch.db` (the sqlite dedupe/health store) are
created automatically in `/opt/dealwatch` on first run and are also gitignored.

## 5. Verify NTP time sync (do this BEFORE enabling the timer)

```sh
timedatectl
```

Look for `System clock synchronized: yes` in the output. If it says `no`, fix it
before going further:

```sh
sudo timedatectl set-ntp true
# then re-check:
timedatectl
```

**Why this matters here specifically:** dealwatch's scheduling and health
tracking both trust the system clock, not just log timestamps cosmetically.

- The self-gating schedule (`core/schedule.ts`) decides whether a source
  (Coles/Woolworths/Aldi) is "due" this tick by comparing `now` against a weekly
  boundary computed in `Australia/Sydney` time. A wrong clock can make a source
  look due when it isn't (wasted, possibly bot-detectable requests) or — worse —
  look fresh when it's actually stale, silently delaying real alerts by up to a
  week.
- Failure backoff (per-source `consecutive_failures` + `last_attempt_at`)
  compares `now` against the last attempt to decide whether an hour has passed.
  A skewed clock can defeat the backoff (hammering a broken source more often
  than intended) or make it back off longer than intended.
- A fresh Raspberry Pi image, or one that's been powered off a long time (this
  pipeline is specifically designed to tolerate power-off gaps via
  `Persistent=true` on the timer), may boot with a clock that's wrong by hours
  or years until NTP catches up. Confirming sync first avoids the first several
  runs making scheduling/backoff decisions on bad data.

## 6. Confirm the ExecStart path works for the dealwatch user

`dealwatch.service` runs `/usr/bin/env deno task run ...`, i.e. it looks up
`deno` on `PATH`. systemd services run with a **minimal PATH** that does not
include a user's `~/.deno/bin`, `~/.local/bin`, or an mise shim directory, so
`env` may not find `deno` even though it works fine in your interactive shell.

```sh
sudo -u dealwatch -H sh -lc 'command -v deno'
```

If that prints nothing, either:

- symlink deno onto a system path (simplest):
  ```sh
  sudo ln -s "$(sudo -u dealwatch -H sh -lc 'command -v deno')" /usr/local/bin/deno
  ```
- or edit `dealwatch.service` after copying it in (step 7) to uncomment and
  adjust the `Environment=PATH=...` line, or replace `/usr/bin/env deno` with
  deno's absolute path.

## 7. Install the unit and timer

```sh
sudo cp /opt/dealwatch/deploy/dealwatch.service /etc/systemd/system/
sudo cp /opt/dealwatch/deploy/dealwatch.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

Optional: do a manual one-off run first to confirm everything is wired up before
putting it on a schedule:

```sh
sudo systemctl start dealwatch.service
journalctl -u dealwatch.service -n 50 --no-pager
```

Then enable the timer (not the service — the service is oneshot and is only ever
started by the timer or a manual `systemctl start` as above):

```sh
sudo systemctl enable --now dealwatch.timer
```

## 8. Check status

```sh
# Confirm the timer is scheduled and see when it last/next fires:
systemctl list-timers dealwatch.timer

# Tail logs from the most recent (and past) runs:
journalctl -u dealwatch.service
journalctl -u dealwatch.service -f     # follow live

# Timer/service unit state:
systemctl status dealwatch.timer
systemctl status dealwatch.service
```

A healthy run logs a one-line summary from `main.ts`, e.g.:

```
dealwatch: run complete — due=[aldi] fetched=12 matched=1 failures=[]
```

If a source hits its consecutive-failure threshold you'll see a failure push on
your ntfy topic, and `failures=[...]` listing the affected source(s) in the log
line — that's the signal a store's captured request profile likely needs
re-capturing (see `scripts/STORE-CAPTURE.md`).

## Recovering from a corrupt or unwanted db

Deleting `/opt/dealwatch/dealwatch.db` and letting the next run recreate it is a
safe way to recover from a corrupt db — but every deal currently matching the
watchlist will be treated as new and re-alerted once (dedupe state is lost). See
`AGENTS.md` for the full recovery note.
