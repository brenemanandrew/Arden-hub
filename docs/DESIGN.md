# Design notes

Written for whoever picks this up next: what the hub is for, why it is shaped
this way, and what is deliberately left for later.

## The brief it answers

Version 1 was a front door: PIN, logo, a tile per dashboard, a health board.
The ask that followed was to make the hub *contain* everything as one
self-contained app, and to give each section a revamp "that establishes flow
and clarity", looked at with fresh eyes as a lean distribution engineer.

## The flow is the navigation

An order on this floor goes Pick, Pack, Stage, Ship. The section bar says
exactly that, in that order, and nothing else is on the left of it:

```
Shift | Pick  Pack  Stage  Ship  |  People  Improve  System
```

Shift is the home page, the one screen a lead looks at first. It shows the
four steps as four cards with one hero number each, so a lead reads it left to
right the way the work moves, and the colour of each card's top edge says
where to look. The right-hand group is the support work: who is here, what we
are changing, and whether the machinery is healthy. Every page of every module
carries the same bar, so a person never has to know which program built the
page they are on.

## Modules, not a rewrite

Staging Lane Health is 40 commits of hard-won floor knowledge (dwell, splits,
problem solve, picker targets, the sealed push from the SAP PC). Arden Pack is
the same for the benches. Rewriting them inside the hub would have been months
of work to arrive at a worse copy. Instead the hub runs both as child
processes and stands in front of them:

- `lib/modules.js` starts each child on a loopback port with its own data
  folder under the hub's volume, restarts it with backoff when it dies, and
  reports pid, uptime and restarts.
- Requests under `/stage` and `/pack` are proxied. Root-absolute links in the
  module's HTML, JavaScript and CSS (`/web/...`, `/api/...`, `/tv`) are rewritten
  under the prefix on the way out, so the modules are unchanged. The one local
  patch is Arden Pack binding to 127.0.0.1.
- HTML answers get the hub's section bar injected after `<body>` and a style
  that hides the module's own logo, title and nav links; the module's tools
  (theme bulb, reset layout, feed pill, clock) stay.
- TV views, panels, phone views and iframe loads are served bare: a wall TV
  does not want a bar.
- The push doors (`/stage/api/ingest`, `/stage/api/backup/*`,
  `/stage/api/feeder`, `/pack/api/drop`) and the two `/api/health` lines are
  open without the hub cookie, guarded by the modules' own keys, so the SAP PC
  kit works with a one-line address change.

Taking a new upstream build is a folder swap (`modules/UPSTREAM.md`).

## The Shift model

`lib/shift.js` asks the modules for their own numbers and never computes a
figure the module already shows: the Pick hero is the picker report's live
percentage of target, Pack is the pack board's units today, Stage is lanes in
use with ready, waiting and late beside it, Ship is orders cleared today. Two
numbers that disagree on one screen destroy trust, so the hub repeats rather
than re-derives. When a module has nothing to show the card says why in its
own words (no warehouse task rows today; lane board not answering).

"Needs attention" is a ranked list with a level (bad, serious, warn, info), a
sentence, and a link to the page where the fix is. The levels use the same
four colours as everything else: good `#0ca30c`, warning `#fab219`, serious
`#ec835a`, critical `#d03b3b`, with Hubbell amber `#FFC000` for the brand
line only, never for a state.

## What is deliberately left

- **Weekend Overtime stays its own app.** The floor tablet and the dashboard PC
  kit are paired to ardenot's keys and encrypted data. Folding it in means
  moving that data and its passphrase onto this volume and re-pairing the
  tablet; People links out until then.
- **Ship value is waiting on two ECC exports** (`SAP Deliveries.TXT`,
  `SAP PGI.TXT`, from VL06O). The host PC can pull them once
  `pull.deliveries.enabled` is on with an ECC session beside the EWM one.
  The Ship cards say what they are waiting on.
- **SharePoint** goes in `links.ops` in `dashboards.json` when the address is
  known; Improve shows the card as soon as it is set.
- **The two "Old ... cloud copy" checks** on System exist to compare during
  the cutover; delete them once the old apps are off.
- The pack and stage children each take about 150 MB when the exports are
  loaded, which is why the machine is 512 MB.
