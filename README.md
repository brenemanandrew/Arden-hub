# Arden Hub

The front door to every Arden dashboard: **https://arden-hub.fly.dev**

One PIN. A black screen with the Hubbell logo. Then one tile per dashboard
(Pack, Pick, Staging Lane Health, Weekend Overtime, the CI idea board) and a
health board that checks all of them once a minute and keeps a week of history.

Node standard library only, one file per job, no build step. Same bones as
ardenot, the overtime kiosk server.

## What is in here

| Path | What |
|---|---|
| `server.js` | the web server: sign-in, home page, health board, the JSON the board reads |
| `lib/auth.js` | the door: PIN, signed 180-day cookie, lockouts, "sign out everywhere" |
| `lib/checker.js` | asks every dashboard how it is, keeps samples and events, works out uptime and answer times |
| `lib/pages.js` | the three pages as HTML strings |
| `dashboards.json` | **the list of dashboards**: name, blurb, address, how to check it |
| `public/logo.png` | the Hubbell logo from the kiosk |
| `tools/make-secrets.js` | makes the Fly secrets (PIN hash, session secret) |
| `test/test-server.js` | smoke tests against stand-in dashboards (`node test/test-server.js`) |
| `docs/LESSONS.md` | what the other dashboards taught and how the hub applies it |
| `fly.toml`, `Dockerfile` | the Fly app `arden-hub`, one machine, volume `hub_data` at `/data` |

## Pages

- `/` signed out: black screen, logo, PIN box. Signed in: the tiles, each with a
  live pill (up, slow, stale data, down).
- `/status` the health board. Light by default; the bulb switches to dark and the
  choice sticks on that device. `?tv=1` is for a wall TV: no controls, stays awake,
  reloads itself every six hours.
- `/health` public, says `ok` (Fly's check uses it).
- `/api/status` everything on the board as JSON. `/api/history?id=pack` the raw
  samples for one dashboard. `/api/check-now` (POST) runs a cycle right away.
  All three need the sign-in cookie.

## How a dashboard is checked

Each entry in `dashboards.json` may have a `health` block:

```json
{
  "id": "pack", "name": "Pack", "url": "https://ardenpack.fly.dev/", "group": "Floor boards",
  "blurb": "Pack board: orders, handling units and open deliveries from SAP.",
  "health": {
    "url": "https://ardenpack.fly.dev/api/health",
    "expect": { "status": [200], "json": { "ok": true } },
    "slowMs": 3000,
    "fields": [
      { "label": "Warehouse tasks", "path": "feed.wh.rows", "kind": "count" },
      { "label": "Tasks read", "path": "feed.wh.readAt", "kind": "time", "staleMin": 30 }
    ]
  }
}
```

- `expect.status` the answers that count as alive (default `[200]`).
  `expect.text` the exact body (ardenot's `/health` says `ok`).
  `expect.json` keys that must have these values (`"mode": "cloud"` is fine too).
- `fields` are read out of a JSON answer and shown on the card. `kind` is
  `count`, `time`, `text` or `bool`. A `time` with `staleMin` turns the card
  **STALE** when it is older than that, or missing. A `count` with `min` goes
  STALE below it.
- `slowMs` the answer time above which the card is **SLOW** (default 3000).
- `auth.bearerEnv` the name of an environment variable holding a key to send
  as `Authorization: Bearer`. `auth.basicEnv` the same for `user:password`.
- `data` an optional second request for what the dashboard holds when that lives
  behind a key: same `url`, `auth`, `fields` and `tz` keys. With no key set the
  request is skipped and the card says so; with a failed request the card is STALE,
  not DOWN, because the site itself answered.
- `tz` how to read a time like `2026-10-28 09:15` with no zone (the kiosk's form).
  Default `America/New_York`.

An entry with no `health` block is a plain link tile. An entry with no `url` is a
tile with no link, so a dashboard can be listed before it has an address.

States, worst first: **down** (no answer, wrong status, wrong body), **stale**
(answered, data too old), **slow** (answered, slowly), **up**. The home page pill
and the board use the same answer, so they never disagree.

What the board quantifies, per dashboard, from one minute-by-minute history:
answer time now, p50 and p95 over 24 hours, reachable % over 24 hours and 7 days,
fresh % over 7 days where the dashboard has data fields, outages in 7 days,
how long it has been in its current state, certificate days left, a 24-hour strip
(one cell per 10 minutes, worst state in the cell), a 24-hour answer-time line,
and the list of every state change.

## Setting it up on Fly (once)

From this folder on a PC with `fly` signed in:

```
fly apps create arden-hub
fly volumes create hub_data --size 1 --region iad -a arden-hub
node tools/make-secrets.js "2468"        (paste the line it prints)
fly deploy --remote-only --ha=false -a arden-hub
```

Secrets:

| Secret | What | Needed |
|---|---|---|
| `HUB_PASSPHRASE_HASH` | scrypt hash of the PIN, from `tools/make-secrets.js` | no: without it the PIN is `HUB_PIN`, and without that **2468** |
| `HUB_SESSION_SECRET` | signs the sign-in cookie | no: made once and kept on the volume |
| `HUB_KEY_ARDENOT` | optional, not used by default: a dashboard-PC key from ardenot, so the board can also show the kiosk's data revision, roster age and sheets waiting to print | no |

The overtime tile checks reachability only (`/health`). To also read what the
kiosk holds, add a `data` block to its entry in `dashboards.json`:

```json
"data": {
  "url": "https://ardenot.fly.dev/api/hub?op=ping",
  "auth": { "bearerEnv": "HUB_KEY_ARDENOT" },
  "tz": "America/New_York",
  "fields": [
    { "label": "Kiosk data rev", "path": "rev", "kind": "count" },
    { "label": "Last kiosk sync", "path": "at", "kind": "time" },
    { "label": "Roster rev", "path": "roster", "kind": "count" },
    { "label": "Roster published", "path": "rosterAt", "kind": "time" },
    { "label": "Sheets waiting to print", "path": "pending", "kind": "count" }
  ]
}
```

and make the key by pairing the hub with ardenot like a dashboard PC does
(the key is shown once; only its hash is kept there):

```
curl -s -X POST https://ardenot.fly.dev/api/agent/pair -H "Content-Type: application/json" \
  -d "{\"passphrase\":\"<the kiosk passphrase>\",\"name\":\"Arden Hub\",\"role\":\"monitor\"}"
fly secrets set -a arden-hub HUB_KEY_ARDENOT=<the key from the answer>
```

The key can only call `ping`, `next` and `jobs` on ardenot; it cannot read
sign-ups. Forget it any time from `ardenot.fly.dev/deploy`.

After the first deploy, every push to `main` deploys again
(`.github/workflows/deploy.yml`). That needs the repository secret
`FLY_API_TOKEN` to be allowed to deploy `arden-hub` (an org deploy token is;
a token made only for the `ardenot` app is not).

## Running it on a PC

```
set HUB_DEV=1
node server.js
```

Then open http://localhost:8080. `HUB_DEV=1` means plain http and the cookie is
not marked Secure; never set it on Fly. History goes to `./data` (ignored by git).

## Adding or changing a dashboard

Edit `dashboards.json`, run `node test/test-server.js`, push. The server refuses
to start if the file is not valid JSON or two entries share an id, so a typo
cannot take the hub down silently: the deploy fails and the old copy keeps running.

## Where it lives

This is its own repository, `brenemanandrew/arden-hub`. It began life as the
`arden-hub/` folder of the ardenot repository and shares that server's
conventions, but nothing here depends on ardenot's code.
