# Arden Hub

One app for the Arden floor: **https://arden-hub.fly.dev**

One PIN (2468 by default), a black screen with the Hubbell logo, then the
whole operation in the order the work flows: **Shift, Pick, Pack, Stage, Ship**,
and beside it **People, Improve, System**. Staging Lane Health and Arden Pack
run inside the hub as modules, so nothing links out to another site except the
overtime kiosk and the idea board, which keep their own apps for now.

Node standard library only, no build step, one Fly machine, data on one volume.

## The sections

| Section | What it is | Where it comes from |
|---|---|---|
| **Shift** (`/`) | The home page. Four step cards, Pick, Pack, Stage, Ship, each with one hero number and the two or three figures under it; what needs attention, ranked; what to clear next; pace by the hour; the feed pills. | `/api/shift`, built from the modules' own APIs and cached 15 s |
| **Pick** (`/stage/pickers`) | Picks against target by person, this shift, today, 7 or 30 days. The pickers tab of Staging Lane Health. | stage module |
| **Pack** (`/pack/pack`) | The pack board: units and lines off the benches, pace against the day before, bench by hour. | pack module |
| **Stage** (`/stage/tv`) | The lane board: floor TV, ops view, classic and phone views. | stage module |
| **Ship** (`/ship`) | Orders out of the door by the hour, totes out, and what they were worth once the two ECC value exports are switched on. | stage module `/api/board` |
| **People** (`/people`) | Weekend Overtime kiosk (its own app), picker review, people, months. | links and the stage module |
| **Improve** (`/improve`) | The CI idea board (its own app), the pick standards, the definitions. | links and the stage module |
| **System** (`/system`) | The health board: both modules and every outside dashboard checked once a minute, a week of history, what changed. | `lib/checker.js` |

A module page carries the hub's black section bar at the top with the module's
own sub-pages on the right. TV views (`?tv=1`, `/stage/panel`, `/stage/phone`)
and anything loaded in an iframe are served bare, as the module wrote them.

## What is in here

| Path | What |
|---|---|
| `server.js` | the web server: sign-in, routes, the module proxy, the hub's own pages and APIs |
| `lib/modules.js` | starts the two modules as child processes, restarts them when they die, proxies `/stage/...` and `/pack/...`, rewrites their root-absolute links, injects the section bar |
| `lib/shell.js` | the section bar, the shared page frame, which section a module page belongs to |
| `lib/shift.js` | builds the Shift model from `/stage/api/board`, `/stage/api/pickers`, `/stage/api/status`, `/pack/api/pack`, `/pack/api/health` |
| `lib/sections.js` | Shift, Ship, People, Improve and the "module is down" page |
| `lib/pages.js` | the sign-in page and the health board |
| `lib/checker.js` | asks every dashboard how it is, keeps samples and events, works out uptime and answer times |
| `lib/auth.js` | the door: PIN, signed 180-day cookie, lockouts, "sign out everywhere" |
| `modules/stage/` | Staging Lane Health, build `64c5a53` (see `modules/UPSTREAM.md`) |
| `modules/pack/` | Arden Pack, build `ac3544a` |
| `dashboards.json` | the outside links (`links`) and what the System board checks |
| `tools/make-secrets.js` | makes the Fly secrets (PIN hash, session secret) |
| `test/test-server.js` | the tests: door, pages, proxy, open doors, supervision, checker (`node test/test-server.js`, about 20 s) |
| `docs/DESIGN.md` | why it is shaped this way; `docs/LESSONS.md` what the other dashboards taught |
| `fly.toml`, `Dockerfile` | the Fly app `arden-hub`, one machine, 512 MB, volume `hub_data` at `/data` |

## How the modules fit

```
browser ──► arden-hub (8080, the PIN door)
               ├── /                 Shift home       (hub)
               ├── /ship /people /improve /system     (hub)
               ├── /stage/...  ───►  Staging Lane Health child, 127.0.0.1:8481, data /data/stage
               └── /pack/...   ───►  Arden Pack child,          127.0.0.1:8482, data /data/pack
SAP host PC ──► /stage/api/ingest, /stage/api/backup/*, /stage/api/feeder   (key: HUB_STAGE_KEY)
SAP host PC ──► /pack/api/drop                                              (key: HUB_PACK_KEY)
```

The push doors need no hub cookie; each module checks its own key exactly as
it did as a separate app. Everything else under `/stage` and `/pack` needs the
PIN cookie. The modules' own viewer passwords stay unset.

A module that dies is started again (2 s, then doubling to a minute between
tries); while it is down its pages say so and the Shift card for it goes grey.
`/api/system` shows pid, uptime and restarts for both.

## Secrets on Fly

| Secret | What | Needed |
|---|---|---|
| `HUB_STAGE_KEY` | the ingest secret the SAP PC sends with every push to `/stage` (same value as "Ingest secret" in Staging Lane Health's settings on the host PC) | yes, or the Stage, Pick and Ship numbers never arrive |
| `HUB_PACK_KEY` | the key in `pack.txt` on the SAP PC | yes, or the Pack numbers never arrive |
| `HUB_PASSPHRASE_HASH` | scrypt hash of the PIN, from `tools/make-secrets.js` | no: without it the PIN is `HUB_PIN`, and without that **2468** |
| `HUB_SESSION_SECRET` | signs the sign-in cookie | no: made once and kept on the volume |

```
fly secrets set -a arden-hub HUB_STAGE_KEY=<ingest secret> HUB_PACK_KEY=<pack key>
```

## Pointing the SAP host PC at the hub (the cutover)

1. **Staging Lane Health** on the host PC: Settings, "Cloud copy and login".
   Cloud copy address `https://arden-hub.fly.dev/stage`, ingest secret the same
   value as `HUB_STAGE_KEY`, push on. The next push lands within a minute; the
   Stage card on Shift and the feed pill on `/stage/tv` go green.
2. **Arden Pack** on the host PC: edit `pack.txt` beside `Start Arden Pack.cmd`:
   ```
   url: https://arden-hub.fly.dev/pack
   key: <the same value as HUB_PACK_KEY>
   ```
   and start it again. `/pack/api/health` shows the row counts climbing.
3. Watch `/system` for an hour. The two "Old ... cloud copy" cards in
   `dashboards.json` can be removed once the old apps are switched off.

Until a push arrives the cards say what they are waiting on; nothing errors.

## Running it on a PC

```
set HUB_DEV=1
set HUB_DEMO=1
node server.js
```

Then open http://localhost:8080 and sign in with 2468. `HUB_DEV=1` is plain
http (never set it on Fly). `HUB_DEMO=1` makes both modules read the sample
exports in `modules/stage/sample-data` instead of waiting for a push, so every
page has lanes and orders on it. Data goes to `./data` (ignored by git).

Other knobs: `PORT`, `DATA_DIR`, `HUB_CONFIG` (another `dashboards.json`),
`HUB_STAGE_PORT` and `HUB_PACK_PORT` (the children's ports, for running two
hubs on one PC).

## Deploying

Every push to `main` runs the tests and deploys
(`.github/workflows/deploy.yml`); it needs the repository secret
`FLY_API_TOKEN`. By hand:

```
fly deploy --remote-only --ha=false -a arden-hub
```

First time only: `fly apps create arden-hub`, `fly volumes create hub_data --size 1 --region iad -a arden-hub`.

## The System board

Each entry in `dashboards.json` may have a `health` block: the address to ask,
what counts as alive (`expect.status`, `expect.text`, `expect.json`), `slowMs`,
`fields` read out of a JSON answer (`count`, `time` with `staleMin`, `text`,
`bool`), an optional keyed `data` request (`auth.bearerEnv`) and `tz` for
zone-less times. States, worst first: **down**, **stale**, **slow**, **up**.
Per dashboard the board shows answer time now, p50 and p95 over 24 h,
reachable % over 24 h and 7 days, fresh % where there are data fields, outages
in 7 days, time in the current state, certificate days left, a 24 h strip and
an answer-time line, and every state change. A check that gets no answer is
tried once more before the card goes down.

## Where it lives

Its own repository, `brenemanandrew/arden-hub`. The modules are copies of the
upstream programs with the one local change listed in `modules/UPSTREAM.md`;
taking a new build is a folder swap.
