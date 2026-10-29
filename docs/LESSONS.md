# Lessons carried into the hub

What the other Arden dashboards (Weekend Overtime kiosk on ardenot, Staging
Lane Health, Arden Pack, the CI idea board) and their pulling scripts taught,
and what the hub does about each. Sources: the ardenot server and kit in this
repository, and the briefs in `Hubbell\claude-memory` (ot-kiosk,
staging-lane-health, ops facts, session log).

## Hosting and data

| Lesson | Where it came from | What the hub does |
|---|---|---|
| Servers go on Fly or a PC-side script. Never a Google Apps Script "Anyone" web app. | The OT hub on Apps Script got the hubbellardenteam account suspended on 2026-09-30. | The hub is a Fly app. Nothing touches Google. |
| One Fly machine (`--ha=false`). Data is files on one volume; two machines are two writers. | ardenot, Staging Lane cloud copy, the idea board. | `fly.toml` keeps one machine; the deploy workflow passes `--ha=false`. |
| Node standard library only. `npm install` into a Google Drive folder corrupts `node_modules`. | Breneland and ardenot. | No `package.json`, no dependencies. |
| An unconfigured copy is closed, not open. Refuse to start rather than run half set up. | ardenot refuses without its three secrets. | The hub refuses to start on a bad `dashboards.json` or a malformed PIN hash. The PIN itself has a documented default (2468) because that is the Arden admin convention, so first deploy works. |
| A key that encrypts data must never change. | `OT_DATA_KEY`, `CI_DATA_KEY`. | The hub stores nothing secret: history is plain JSON, so there is no key to lose. The session secret is made once and kept on the volume; losing it only signs people out. |
| Edge saves `.xlsx` numbers as `68218.0`; a digits-only keypad never matches. | The kiosk ID lockout. | PIN input strips spaces and normalises, and the sign-in page uses `inputmode="numeric"` so tablets show digits. |

## Sign-in and security

| Lesson | Where it came from | What the hub does |
|---|---|---|
| One passphrase per device, remembered for 180 days, wrong guesses slowed down (5 per address = 15 min; 50 anywhere in an hour = everyone waits). | ardenot. | Same scheme, same numbers (`lib/auth.js`). |
| `Referrer-Policy` must be `same-origin`. With `no-referrer` browsers send `Origin: null` and the site's own form posts fail the origin check. | ardenot on 2026-09-30. | Same header, same origin check on every POST. |
| Pass Fly secrets as `fly secrets set` arguments. Piping adds a BOM on Windows PowerShell. | ardenot README. | `tools/make-secrets.js` prints the one-line command. |
| Admin convention is five taps on the logo then PIN 2468. | OT App, copied by every Arden tool. | The hub's PIN is 2468 by default and the logo is the first thing on the screen. |

## What "healthy" means for a dashboard

| Lesson | Where it came from | What the hub does |
|---|---|---|
| Up is not enough. The cloud copy is a read-only mirror: if the SAP PC stops pushing, the site answers 200 and shows old numbers. Staging Lane's feed pill turns red after 10 minutes without a push. | Staging Lane Health. | STALE is a first-class state. Each dashboard can name the fields that carry a time (`feed.wh.readAt`, the kiosk's `at`) and a limit in minutes. Pack is STALE right now: its cloud copy has never been pushed to (`"status":"no folder"`, 0 rows). |
| Two numbers that disagree on one screen destroy trust. | The ops pick-side card showed 40 % while the pickers page showed 66 %. | Every figure on a card comes from the same sample. Uptime, p50, p95, the strip and the sparkline are all cut from one history. |
| A short export must never be mistaken for slow pickers. Show where the numbers come from. | The `pickerDiag` funnel panel. | Each card shows the exact health address it asked, the status code, the reason for DOWN, and the raw field values. |
| Say "not reachable" only after three failed refreshes, as a click-through banner. | Staging Lane. | The board does exactly that for its own feed. |
| Fire TV / Silk mode: hide controls, keep the screen awake, reload now and then. | Staging Lane `?tv=1`. | `/status?tv=1`: no controls, wake lock, reload every 6 hours, bigger cards. |
| Hubbell re-signs HTTPS on the work network (TLS inspection). | Staging Lane's `winca.js`. | Does not apply: the hub runs on Fly and checks public addresses. If a check is ever added for something inside the plant, it will need the same trust-store trick on a PC-side probe, not on Fly. |
| The dashboard-PC kit should be handed out by the site itself so it always matches. | ardenot `/deploy`. | Not needed here. The hub has no PC side. |

## Operational facts kept for the checks

- ardenot: `/health` is public and says `ok`. Everything under `/api` needs a
  sign-in or a paired PC key. A key may call `op=ping`, which returns the kiosk
  data revision and time, the roster revision and time, and the sheets waiting
  to print. Times are `YYYY-MM-DD HH:mm` in Eastern time, not ISO.
- Staging Lane Health cloud copy: `/api/health` returns `{"ok":true,"mode":"cloud","v":<build>}`.
  The pages sit behind a viewer password (`/login`, `?key=` on a TV bookmark).
- Arden Pack cloud copy: `/api/health` returns `{"ok":true,"v":1,"feed":{...}}`
  with one entry per SAP export (WHTask.XLSX, Orders.XLSX, HU STAGING.XLSX,
  SAP Deliveries.TXT, SAP PGI.TXT): rows, `readAt`, `status`.
- CI idea board: no health endpoint. The hub checks the front page and allows
  it six seconds because the machine auto-stops and wakes on the first hit.
- Fly app names cannot contain spaces: "Arden hub" is `arden-hub`, so the
  address is `https://arden-hub.fly.dev`.

## Added in version 2 (modules inside the hub)

| Lesson | Where it came from | What the hub does |
|---|---|---|
| A proxy must drop hop-by-hop headers. Passing the child's `Transfer-Encoding` through beside a fresh `Content-Length` makes `fetch` (undici) refuse the reply while curl shrugs. | The first v2 test run. | `lib/modules.js` strips `content-length`, `transfer-encoding`, `connection` and `keep-alive` before answering. |
| A supervisor must take its children with it. A crashed hub left two children holding the ports, and the next start looped on `EADDRINUSE`. | The test suite. | `process.on('exit')` kills the children; `stop()` sends SIGTERM then SIGKILL after 3 s. |
| Never recompute a number a module already shows. | The ops pick-side card versus the pickers page, again. | Shift repeats the modules' own figures and says, per card, where each one came from. |
| Rewrite links at the edge, not in the upstream. | Staging Lane's pages are full of root-absolute `/web/` and `/api/` paths. | One regex over text answers, keyed on the module's known top-level routes, so a lane name in a string is left alone. |
| Wall TVs do not want navigation. | `?tv=1`, the quad panels, the phone view. | Those views and any iframe load are served bare. |
| The push kit on the SAP PC must not change shape. | Thirty minutes of someone's time at the host PC per change. | The modules' push doors keep their paths and keys under `/stage` and `/pack`; the cutover is one address per program. |
