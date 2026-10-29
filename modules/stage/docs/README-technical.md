# Staging Lane Health

The staging lane dashboard as an application. One host PC runs a small
service next to SAP; every other screen just opens a web address.

```
host PC (SAP GUI)                            any PC / floor TV
┌──────────────────────────────┐             ┌────────────────────┐
│ Staging Lane Health service  │  http/LAN   │ Chrome or Edge     │
│  - pulls SAP every 30 s      │ ──────────▶ │  /         home    │
│  - parses the exports once   │  live push  │  /board    board   │
│  - keeps dwell log, settings │             │  /data     files   │
│  - serves board + data       │             │  /admin    control │
└──────────────────────────────┘             └────────────────────┘
```

## The board (v2)

Two pages, one model (`server/board.js`, served at `/api/board`), built to
answer four questions in five seconds:

| Page | For | Answers |
|---|---|---|
| `/tv` | the floor TV (add `?zone=z_e00_e01` for a kiosk) | which lane to clear next, what is stuck, how full staging is, today's pace |
| `/ops` | leads and managers | pace against goal, cleared per hour vs yesterday, stuck orders, zones, settings |

Lane cards carry the age (h:mm), the order, and a status word: **READY**
(every line picked), **n TO PICK**, **TOTE IN INDUCT/PICK** (a loose tote), or
**NOT ON REPORT**. Colour is age only: neutral under the yellow threshold,
yellow, then red. Nothing on either page depends on the warehouse task feed;
the ops page has one card that fills in when that feed works.

The previous dashboard is still served at `/classic`.

## Picker performance (`/pickers`)

Three choices across the top: the shift scope (this shift, today), a range (yesterday, 7 or 30 days, narrowed to one shift with the dropdown beside it), and the measurement (percent of target, picks an hour drawn against the standard or against the recommended standard, or activity). How the chart is shown, the sort and the table sit with the chart; the pick standards, recommended standards and the workings are under Admin below it. One confirmed warehouse task is one pick. The task export has to carry the Warehouse Task Status column for that to be readable; the SAP pull checks the grid layout on every task pull and adds the column through Change Layout when the user's layout leaves it out (the `-WtNeedCols` parameter of `pull.ps1` lists what is required; blank turns this off). A person's bar is their picks,
split by the area the picks came from, because the mix of work explains most
of the gap between two people. Time worked is *active time*: each
confirmation counts the person as working for the next 30 minutes, and
overlapping windows merge, so somebody pulled onto another job for two hours
is not charged for the gap.

Every block on a bar carries **that area against its own standard**. The
hours behind it come from crediting each confirmation with the clock from its
own time until the next one, capped at the active window, so the area hours
add up to exactly the person's active time. That is why the block
percentages average back to the headline percentage when weighted by hours:
they are a decomposition of it, not a second opinion. Clicking a name shows
that person on their own and hides everyone else's; clicking it again brings
the floor back.

**This shift** is the default view: the shift that is on now, from the hour
it started, so the page resets itself when the next shift begins while
Today, 7 days and 30 days keep the whole record. Shifts come from the
working week set on the page, one line per shift (days, name, start to end,
breaks as clock time = minutes); a shift that runs past midnight is laid out
as one stretch of hours.

**Breaks and closed time** come from the same schedule and are taken out of
active time: nobody is credited for lunch, the fifteens, or the hours the
building is shut. Breaks are drawn as orange bands with a dotted line at
each end; closed time is squeezed out of the Activity axis into a thin
hatched gap. Somebody in when the building is meant to be shut keeps their
time - if the rules would erase most of a real day's work they are set aside
for that person and day. **Rate + activity** puts each person's picks an
hour in each hour, against their own target, above the strip of when they
were picking; over several days both are a typical day.

### Recommended standards

The button above the third tile opens a panel that works out what each
standard *could* be from what this warehouse has actually done. One person,
one area, one day is one observation (at least 30 minutes and 10 picks to
count). Then:

* A day is worth at most **6.5 picking hours** - a paid shift with breaks
  taken out. Measured active time longer than that is scaled back to it,
  which raises the rate it implies; anybody on the floor for less is
  credited with what they were there for. `Active time` shows the
  uncapped view for comparison.
* Hours count as their **square root**, so ten times the hours weighs about
  three times as much, not ten. One person cannot become the standard by
  being the only one sent there.
* A picker who beats the middle of the crew **and** only works that one area
  is damped by up to 40%: part of that rate is never switching tasks, and a
  standard set from it is a standard set for a specialist. Nobody is damped
  for being slow.
* The figure is a **percentile** of what people did (Typical = 50th,
  Recommended = 60th, Stretch = 75th), never an average, so one wild day
  cannot move it. "Days meeting it" is the share of qualifying person-days
  at or above it - the honest read on whether a number is reachable.

Every row opens to show who contributed, their rate, their hours, how
concentrated they are and the weight they carried, plus what the area would
read without the damping.

A snapshot is written every time a task export is read, per shift (shift
starts are a setting, 6/14/22 by default), so the **daily record** fills
itself in: what each day on its own suggested, with the running window
beside it. Watch a number settle for a week before adopting it.

Nothing here changes a standard. "Put these in the standards box" fills in
the Pick standards field - existing spellings and any area the
recommendation has nothing to say about are left alone - and it is saved
only when you press Save. Everything the board pages call a KPI target comes
from that field.

### One-time history backfill (Admin > Backfill)

The rollup only knows the days the service has been running. The backfill
runs the warehouse task export again with the window walked back and files
everything it finds by the day it was **confirmed**, which fills the 7 and 30
day views, the Months gallery and the daily record in one go.

**The year, in one pass.** Press *Use the full year (365 days)* and run it:
27 exports, two weeks of creation dates each, roughly an hour of driving SAP.
It is meant to be run once. When it finishes, a marker is written and the
button refuses to do it again - the error says when the base was pulled and
what it covered - unless *Run it again anyway* is ticked. That is the whole
point of the one pass: the Months gallery wants a year behind it, and nobody
wants that year pulled out of SAP twice.

Each slice is recorded as it lands. If SAP drops out at slice 19 of 27,
pressing the button again collects the remaining 8 rather than starting over,
and says how many it skipped.

What it does and does not promise:

* SAP selects tasks by **creation** date while a rate counts confirmations,
  so every slice asks for four days of creation dates *before* the first day
  it means to file - the lead-in - and files only the days it can see whole.
  That is what lets a slice be closed out and thrown away instead of holding
  a year of rows in memory. The oldest day of the whole range is still short
  - picks confirmed then, from tasks created before the range, are in no
  export - so it is marked `short` in the result rather than trusted.
* A day already on file is replaced **only** if the backfill found more picks
  for it. A live pull that watched the whole day is the better record.
* The export goes to `<data>\backfill`, never the live report folder, so the
  board never sees a month of tasks.
* The normal pull is held while it runs (one SAP session, one driver) and
  released afterwards, whether it finished or failed. Run it when the floor is
  quiet: 30 days is a few minutes, a year is closer to an hour.
* The history file is held too and flushed once a slice. A year written one
  day at a time would otherwise rewrite a growing file 365 times.
* The daily record behind the recommended standards is rebuilt for the most
  recent 120 days of whatever was filed, which is as far back as the
  standards ever read. Rebuilding it for a whole year is a 30 day report per
  day per shift and nobody would see the difference.
* HU staging and Orders are pictures of right now with no history in them, so
  widening those two would backfill nothing. Lane and dwell history can only
  accumulate going forward.

## What changed from the folder version

| Before (dashboard.zip, Aug 2026)                       | Now                                            |
|--------------------------------------------------------|------------------------------------------------|
| VBS puller + watchdog + Task Scheduler + flag files    | One service owns the SAP pull, restarts a hung cycle itself |
| Each viewer picks a folder and grants permission to it | Viewers open a URL. Nothing to set up |
| Every browser parses 9,000 rows of XLSX every minute   | Parsed once on the host, pushed to every screen |
| Settings, dwell log and usage per browser              | Shared on the host; one board everywhere       |
| Data for people: open SAP or copy files around         | `/data`: CSV/JSON downloads and live links for Excel |
| Monitor tree nodes recorded by position                | Nodes can be set by label; the tree is readable from Admin |

## Cloud copy (optional, no IT involvement)

The cloud copy shows the same pages with everything it cannot act on
hidden: no pull controls, no configuration, no standards editor, no host
addresses. Its Home and Admin pages say only whether it is live and when it
was last updated.


The host PC can push the board to a read-only copy of this app running on
Fly.io. The host only makes outbound HTTPS connections, so nothing needs to
be opened on the work PC and no firewall rule is needed. The copy runs in
`SLH_MODE=cloud`: no SAP, no folder, no settings of its own.

```
work PC (SAP)  --push every change (gzip, secret)-->  https://<app>.fly.dev
   |                                                     |
   LAN board for the floor TVs                 password-protected board for everyone else
```

Set it up once from any PC (about 15 minutes):

1. Install flyctl: `powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"` (user profile only, no admin).
2. `fly auth signup` (or `fly auth login`), then from this folder: `fly launch --copy-config --no-deploy` and accept the app name.
3. `fly volumes create slh_data --size 1 --region iad`
4. `fly secrets set SLH_INGEST_SECRET=<long random string> SLH_VIEWER_PASSWORD=<what viewers type>`
5. `tools\deploy-cloud.cmd`
6. On the host PC: Admin, Configuration, "Cloud copy and login": switch it on, paste `https://<app>.fly.dev` and the same secret, Save. The status line under it shows pushes sent and the last success.

Deploy later changes the same way. Use `tools\deploy-cloud.cmd` rather than
`fly deploy` on its own: it stamps `BUILD.txt` with the commit first, which is
what the copy reports in its startup line and on its Admin page. Deploying
without the stamp leaves the copy claiming whatever build was stamped last,
which is worse than saying nothing.

The copy answers `https://<app>.fly.dev/tv`, `/ops`, `/data`. It says "cloud copy" in the feed pill and turns red if no push has arrived for ten minutes. Settings, START/STOP and the report folder stay on the host.

Cost: one shared-cpu-1x machine with 512 MB and a 1 GB volume, a few dollars a month. Traffic is roughly 3 to 4 GB a month per always-on screen.

## Where the files live

The SAP exports land in **the app's own folder**, beside `Start Staging Lane Health.cmd`:

    StagingLaneHealth\
      Start Staging Lane Health.cmd
      HU STAGING.XLSX      <- the three SAP exports
      Orders.XLSX
      WHTask.XLSX
      server\  web\  runtime\

They used to go to `C:\REPORT`, which is where the VBScript puller this app
replaced put them. A copy still on that folder **moves itself once** on the
next start: it brings the exports across, points itself at the new folder,
and writes a flag so it is never done again. The Pull log says what moved.
Only a copy sitting on that old default is touched - a folder somebody chose
on `/admin`, or one named with `--report-dir`, is left exactly as it is.

The two heartbeat files and the dwell-log copy that used to go in there were
for the old folder-reading board, which is retired, so they are switched off
by the same move rather than left as clutter in the app folder
(`compat.writeLegacyFiles` on `/admin` turns them back on).

Everything the app *writes for itself* stays in
`%LOCALAPPDATA%\StagingLaneHealth`: `config.json`, the picker history, the dwell
log, the pull logs and the shift PPTX files. That is deliberate - copying a
new build over the app folder then cannot take a year of history with it.

## Updating a copy

Unzip the new build somewhere and run **`Apply update.cmd`** from it. It asks
which folder to update, keeps the old program in a dated `previous-build-...`
folder beside it, replaces `server` and `web` outright (so a file a build drops
does not linger), and checks the build stamp and a few key files landed before
it says it is done.

It refuses rather than guesses: a folder with no `servermain.js` in it is not
an install and is left alone, and a service still running from that folder
stops the update instead of having its files pulled out from under it - close
the black service window first.

**Nothing an update touches is yours.** The picker history, the year the
backfill collected, `config.json`, the logs, the dwell log and the shift decks
all live in `%LOCALAPPDATA%StagingLaneHealth`, which no part of an update goes
near. That is why the data folder was kept out of the app folder.

## Backing up, and moving the host to another PC

**`Back up data.cmd`** writes everything this PC has learned to a dated zip:
the picker history, the SAP monitor tree and the rest of the configuration,
the standards, the schedule, the dwell log. It says how many days of history
it found, then opens the zip again and reads the history back out before
calling it done.

Do this. The program is replaceable - it is in a zip on a shared drive. **The
data folder is not.** SAP does not keep warehouse tasks for ever, so the
oldest months the one-time backfill collected cannot be pulled again: running
the backfill a second time next year comes back with less than it did the
first time. Until that zip exists, the year lives on one disk.

**`Restore data.cmd`** puts that zip onto another PC. That is the whole
hot-swap: back up on the old PC, restore on the new one, start the service.
The new PC comes up with the history, the standards and the SAP settings, so
**the backfill does not need running again** and it pulls without the monitor
tree being set up by hand.

What it fixes rather than copying blindly: the report folder in the restored
config is the old PC's install path and would not exist on the new one, so it
is cleared and this install's own folder applies. Anything already on the new
PC is kept in a dated folder first, so restoring over a machine that had its
own history does not silently throw it away. Close the service window before
restoring - it refuses while the service is running.

One caution: the two PCs must not both feed the cloud copy. The feeder lease
handles it (the new one takes over after ten minutes, or at once with **Take
over now** on Admin), but the old PC should be stopped rather than left going.

## Host PC setup (once)

1. In SAP Logon: Options, Accessibility & Scripting, Scripting: **Enable scripting**, untick both notification prompts.
2. Copy the `dist\StagingLaneHealth` folder (built with `tools\build-portable.cmd`) anywhere on the host, or clone this repo where Node.js is installed.
3. Log in to SAP, then double-click **Start Staging Lane Health.cmd**. Allow it on the network when Windows asks.
4. Optional: `tools\install-autostart.cmd` starts it at logon (per-user Startup folder, no admin rights).

The Home page shows the addresses viewers use. Everything else is on `/admin`.

## The viewer password

Set `SLH_VIEWER_PASSWORD` (or Admin, Configuration) and every page asks for it
once. There are three ways in and all three end in the same year-long cookie:

* the **login page** this app draws itself - plain HTML, so any browser can
  render it;
* **`?key=<password>`** on the address. The password is swapped for the cookie
  and taken straight back out of the address bar, so a bookmark keeps working
  while the key stops appearing on screen, in history and in referrers;
* the **HTTP Basic header**, still accepted, so anything that saved
  credentials before keeps working.

**On a TV, use the `?key=` form.** Bookmark
`https://<app>/tv?key=<password>&area=E03` once and the set never asks again,
even after a power cut. This matters because a television browser often cannot
draw the credentials box HTTP Basic asks it for: an LG webOS set would reach
the page, fail to put up the prompt, and close. Nothing now sends a
`WWW-Authenticate` header, so no browser is asked to draw a box it does not
have - which also means PCs that had saved a Basic password are asked once more
through the form, and then not again.

The cookie holds a hash of the password rather than the password. `/api/health`
stays open, so an uptime check needs no password.

## Viewer setup

**TVs in their own browser** (Fire TV Silk, or any smart TV): open the
address as usual. The page recognises the TV, hides the header links and
buttons a remote cannot use, keeps the screen awake, and asks once for an
OK press on the remote, which is what browsers need before they allow full
screen - the same as F11 on a PC. Add `?tv=1` to any address to get the
same behaviour on a PC.


Open `http://<host>:8480/` in Chrome or Edge. Bookmark `/board#view=overview` for a floor TV, or a zone view for a kiosk. That is all.

The classic board is served inside a fixed 1920x1080 frame scaled to the screen, so a laptop, a 4K monitor and a TV all show the same layout. `/board?fit=0` skips the frame; `/board?stage=1920x965` picks another frame size.

## End of shift report

A few minutes after each shift ends (the schedule on the picker page says when), the host PC writes `Shift_Report_<date>_<shift>.pptx` into its reports folder and the report folder: one 16:9 slide that prints on letter or A3 and fills a 1080p screen. It carries lines picked against the goal, picks confirmed, orders shipped, what is still staged or past three hours, tasks left open, the rate of every area against its standard, work left by area, watch items for the next shift, and the crew: the three most productive pickers and the five least, by percent of standard, with picks, lines per hour and the area they mostly worked. Anyone with fewer than ten picks or under half an hour of active time is counted but not ranked.

Nothing has to be pressed. The `!` marker still shows on the host PC’s own board from forty minutes before shift end; pressing it asks the same questions as before and rebuilds the report with the answers on a second slide, replacing the automatic copy. The marker is not shown on the cloud copy or on viewers. Settings: `autoReport` (on by default) and `reportGraceMin` (minutes after the end before it is written, 10). Every report is listed on the Data page.

## Backups through the cloud copy

Every backup the host takes is also sent to the cloud copy, sealed the same
way as the feed (`sealRaw`, no gzip - a zip is already packed), by
`POST /api/backup/put` with the ingest key. The copy keeps only the newest,
as the bytes it was sent, in `backup-latest.enc` beside a plain
`backup-latest.json` saying what it is; it never opens it. A backup with
fewer days than the one held is refused, so a standby PC with a fortnight
cannot replace a year, and one from a PC that is not the feeder is refused
while somebody else is feeding.

At start-up a host with three days of history or fewer runs `Backup.adopt`,
which considers a backup folder on the PC (if any) and `GET /api/backup/latest`
from the copy (if the cloud is configured), takes whichever holds more days,
and merges it - days the PC already has are kept. Every reason for not
taking one is logged. Admin > Backup > "Pull the newest backup from the cloud
copy" does the same on demand, on any PC, behind a confirm.

## The feed to the cloud copy is sealed

The host seals every push with AES-256-GCM before it leaves, using a key
derived from the ingest secret the two machines already share. The copy opens
it in memory and stores it **still sealed**, as `cloud-last.enc`.

Before this, the copy wrote every push to `cloud-last.json` as plain text on
the Fly volume - a day of the warehouse's work readable by anyone with an
account login. An older copy's plain file is read once on the next start,
written back sealed, and deleted.

Opening a payload also proves the host sealed it. A byte altered anywhere -
or the wrong secret - fails outright rather than being believed, which the
`X-SLH-Key` header it sits behind could never manage: that only ever proved
the sender knew a string.

**What this does not do:** it does not hide the numbers from a viewer. The
copy has to open the payload to draw a board, and the browser is sent the
numbers either way, so anyone who can open the board can read them. This
protects the file at rest and anything between the two machines - not the data
from the people you gave the password to.

Sealing gzips on the way in, so a push is no bigger than it was. A copy still
accepts an unsealed push from an older host, so the copy can be deployed
before the host PC is updated.

## One host at a time

Two PCs running the host against the same cloud copy would take turns overwriting it every few minutes, with two SAP users’ exports, two dwell logs and two sets of standards, and nobody would know why the numbers jumped. So the cloud copy takes pushes from one host at a time: whoever pushed last. Another PC that starts the host asks the copy who is feeding it before it ever touches SAP, and if someone is, it stands by: no SAP pulls, no pushes, no shift reports, a banner on its own board, and a `STANDING BY` line on its Admin page with a **Take over now** button for a deliberate switch. It asks again once a minute and takes over on its own when the feeder has been quiet for the lease (`cloud.leaseMin` on the cloud copy, 10 minutes); the feeder keeps its claim alive between changes, so that only happens when it is really gone. The cloud copy’s Admin page names the feeder and anyone standing by. Nothing shared, nothing enforced: two hosts with no cloud copy configured only compete for SAP, so use one SAP account per host.

## People (`/people`)

Everyone who picked, over the last week, month or year, one row each: days worked, picks, lines, picks an active hour, percent of target, active hours, productive time (active hours against the true picking hours of a shift for the days worked) and the area they mostly worked, with a small trend of their daily percent. Narrow it to one shift with the dropdown, type part of a user ID to find someone, click a column to sort by it. Click a user ID to see that person on their own with every day and every area; click it again for everyone.

## Months (`/months`)

The year a month at a time, a card each, in the order they happened. Every
card carries the month's days as bars, its headline number, the crew behind
it and the five areas that did the most work.

The headline is **percent of standard**: what the hours worked should have
produced at each area's own standard rate, against what they actually did
produce.

    expected = sum over areas of (hours in that area x that area's standard)
    percent  = picks / expected

That weighting is the reason the gallery works. Adding a month's picks up and
dividing by its hours would make a month heavy on cantilever - travel time,
standard 15 - look like a bad month rather than a different one. Weighted by
area, a month of nothing but cantilever and a month of nothing but flow both
read 100% when both hit their standards, which is what makes twelve cards
comparable at a glance.

Everything else on the card is the same arithmetic at a different resolution:
each bar is one day's percent, the areas are each area's own percent for the
month, and *every day* opens the days as a table. Switch the measurement to
**picks an hour** and the dashed line becomes that month's blended standard,
which moves with the mix of work; **total picks** and **hours worked** are
raw volume with no line to hit, and are not coloured - a month with more picks
in it is not a better month.

Every card is drawn on one scale, shared across the whole gallery, so the
cards can be read against each other. Weekends are the faded bars; a faded
card is a part month, not a poor one.

It is built from the daily rollup alone - no export is read - so it costs the
same whether it is opened once or left on a screen. The cloud copy is sent
the finished digest rather than the days behind it: a year of the raw rollup
is megabytes on every push where the digest is a few kilobytes, and the copy
would only have added the days up again.

An empty gallery means the rollup has nothing in it yet. Run the year
backfill on the host PC (Admin > Backfill).

## On a phone

A phone (a screen whose short side is 600 CSS pixels or less; tablets are wider) opening `/board` gets `/phone` instead: the same numbers the wall board reads, in one column, in the order somebody walking the floor asks the questions. `/board?phone=0` keeps the wall board. The Ops view reflows to one column on a phone by itself.

## Wall panel (`/quad`, host PC only)

Four views on one 1080p screen, for a large touch panel on the floor. One
header across the top, a hairline between the quarters, nothing else - no
title bar per quarter and no border round the grid. It is built on the same
fixed 1920x1080 stage the classic board uses, scaled to fit and centred, so
the panel, a monitor and a laptop all show the same thing at different sizes.

Out of the box: the classic board top left, the staging lanes top right,
productivity bottom left, pace by hour bottom right. Each quarter has its own
dropdown in the header and the choice is remembered on that screen. The
**Quad / TL / TR / BL / BR** buttons blow one quarter up to the whole screen
and back, which is what a finger wants on a 65 inch panel; the two round
buttons reload all four and go full screen.

A note on the top two. The classic board's home screen **is** its overview -
`/board` and `/board#view=overview` draw the same screen - so putting both up
would be the same picture twice. Top right is the staging line itself
instead, which is what the board on the left summarises. Both are in the
dropdown; two taps swaps them.

Two of the quarters are laid out for the job rather than just shrunk into it.
**Months** is asked for with `?compact=1` and answers with one row of cards
that fills the height, sized in `vh` rather than pixels - the frame decides how
wide the page is laid out and scales it, so a pixel is worth whatever that
scale happens to be, while a `vh` is always a hundredth of the quarter and the
type comes out the same size on the wall whatever width is chosen. The newest
six months are shown; the areas, the day tables and the footnote are reading
rather than glancing and stay on the page you open. **Staging lanes** is laid
out at 1400 rather than 1920, so the quarter scales it by 0.68 instead of 0.50
and every lane tile is half again as big, with the clear-next and exceptions
column still beside it.

Each quarter is an ordinary page of this app, cropped just below its own
header and scaled to fill its box exactly, so a quarter keeps working when
the page inside it changes and a new view is one line in the list rather than
a rewrite. A panel declares only the width it should be laid out at - the
height follows from the shape of the quarter, so the page is handed a viewport
of its quarter's own proportions and there is never a grey band down one side,
at any quarter size, in quad or blown up to full screen.

Two of the choices exist only for this (`/panel?p=productivity` and
`/panel?p=pace`, and both are fine on their own on a spare monitor):

* **Productivity** - everyone picking on the shift that is running, ranked,
  with a bar for percent of standard and a mark on it showing where standard
  is, so "am I ahead" is answered without reading a number.
* **Pace by hour** - picks the crew put away each hour, each bar coloured by
  how that hour ran against standard. A day total hides the hour it went
  wrong; an hour is the grain a supervisor can still act on.

They are drawn at 958 x 510 - a quarter of a 1080p screen, exactly - with no
scaling and type sized for a floor rather than a desk. An ordinary desk page
shrunk into that quarter is a picture of information rather than information.

**On the cloud copy it is hidden.** It is in no menu and `/quad` answers 404
until it is unlocked: tap the **Hubbell logo on the home page five times**, then
enter the code (`auth.quadCode`, `2468` out of the box; blank turns the hidden
way in off altogether). The code is swapped for a cookie, so a screen is asked
once. This is obscurity rather than a lock - everyone who reaches that page is
already past the viewer password - and it exists to keep a floor screen out of
casual reach, not to defend anything.

On the host the panel is listed on the home page and opens straight away. It holds four live views open at
once, and it is a screen in the building the host PC is in; the cloud copy
answers `/quad` with a 404 saying so.

## The activity strip

Over a single day each person’s strip carries two things. The pale band is the time credited as working - a confirmation counts the person active for the window set beside the pick standards, five minutes at the finest. The dark bars on it are the minutes that actually carried a scan, taller the faster they came, so fifty scans a few seconds apart read solid and tall where a pair half an hour apart reads as two thin ticks. Band with no bar on it is the tail credited after the last pick, which is the active-time rule made visible.

Runs of consecutive minutes merge into one bar, so a burst is one block rather than forty ticks. The marks come from the task export for that day only, a few kilobytes; over a range the strip shows a typical day shaded by hour instead.

## Avg vs KPI

Each area’s picks divided by the hours its people spent there, against the standard for that area. The hours are split the way the picker report splits them: every confirmation owns the clock from its own time until that person’s next one, capped at the active window, so somebody moving between areas has their time divided without a minute counted twice. That makes the number picks an hour **per picker**, which is the unit a standard is set in, and it makes the board agree with the picker report on the same day. Hovering a row gives the crew behind it: picks, person-hours, how many picked and for how long each, and what was expected. An area with fewer than five picks or a quarter of an hour reads as a dash rather than a wild number.

Each row reads as a percentage of the standard, with two marks on the bar: the standard itself, and what that area has usually been doing over the last fortnight. The colour follows the second one, because a standard is where the floor is going and a shift can only be won against what the floor has been doing - so an area at two thirds of standard still shows green on a day it beats its own recent self. Hovering gives the crew, the rate, the usual and the picks expected for those hours.

It used to divide an area’s whole output by the wall-clock span from its first pick to its last and read that against a per-person standard, so two dozen people at a tenth of standard came out looking like 98% of it.

## Work pipeline

The classic board’s work pipeline follows the totes: in induct, waiting on picks in a staging lane, ready to ship once the order report says every line on that order is picked, and cleared today from the departure log. One population, one unit, a real sequence, so the arrows between the boxes mean what they say. The figure underneath is the share of what the floor has handled that is out of the door.

It used to put order lines, warehouse tasks and totes side by side from three reports that share no key (the order report and the task export have no document number in common), with a “not released” stage that subtracted a task count from a line count.

## Week in review

On the first tick of a new week the host writes `Week_Report_<monday>.pptx` for the week just finished: one 16:9 slide with lines picked against the goal for the week, picks, orders shipped, the crew against standard, productive time against its floor, pickers; a day-by-day table; every area against its standard; the five most productive and five least productive pickers for the week with their productive time; and what to watch. `POST /api/reports/week` (optionally `{"week":"YYYY-MM-DD"}`, a Monday) builds one on request. It is listed on the Data page with the shift reports.

Productive time is active hours against the true picking hours of a shift for the days worked; it reads green from the floor set beside the pick standards (75% by default), amber within fifteen points under it, red below. The phone board has a menu button for the other pages.

## Data for people

`/data` has the current HU staging, orders and warehouse task exports as CSV, JSON or the original XLSX, a lane summary, the dwell log and lane usage. Each has a stable address (for example `/api/export/lanes.csv`) that Excel's *From Web* can refresh.

## Running from source

```
npm start                     # exports in this folder, port 8480, SAP pull on
npm run dev                   # sample-data folder, pull off
npm test
node server/main.js --port 8480 --report-dir C:\REPORT --no-pull
```

Configuration lives in `%LOCALAPPDATA%\StagingLaneHealth\config.json` (editable on `/admin`). Logs, the dwell log, saved settings and shift reports are in the same folder.

## Layout

```
server/main.js      entry: config, ingest, puller, http
server/ingest.js    watches the report folder, parses XLSX once, reduces columns
server/xlsx.js      dependency-free .xlsx reader
server/model.js     lane/order derivation shared with the board
server/dwell.js     dwell log + lane usage on the host
server/puller.js    schedules and supervises the SAP driver
server/sap/pull.ps1 SAP GUI scripting driver (PowerShell port of the VBS)
server/http.js      API, event stream, static pages, exports
server/board.js     the v2 board model (lanes, clear-next, stuck, pace, zones)
web/tv.html         floor TV board (v2)
web/ops.html        ops view with settings drawer (v2)
web/board2.js|css   shared v2 client and styling
web/board.html      the classic dashboard, generated by tools/adapt-board.js
web/index|data|admin.html   home, data and admin pages
legacy/             the Aug 2026 package this was built from
tools/adapt-board.js        re-run after changing legacy/staging_lane_health.html
tools/build-portable.cmd    assemble a no-install copy with node.exe
```

The board is still the single-file dashboard; `tools/adapt-board.js` rewrites
only its data layer (about ten anchored replacements). Change the legacy file
or the tool, then run `node tools/adapt-board.js`.

## SAP driver notes

**Overnight "no memory available".** A session that runs the monitor every
half minute for a whole night hoards memory until SAP refuses with that
popup, and the pull stops until somebody notices. The driver now recognises
the popup, and every `recycleEvery` cycles (120 by default; Admin >
Configuration) it opens a fresh SAP session and closes the old one. SAP
keeps the login while one session stays open, so nothing has to be typed.
Admin > Status shows how many fresh sessions were opened and how many
memory popups were seen. If the failure is actually a server restart the
pull cannot fix that; it will resume on its own once SAP is logged in
again.


`server/sap/pull.ps1` is a line-for-line port of `Start_HU_Staging_Pull.vbs`
and carries every fix that script accumulated. It has **not yet run against a
live SAP system**; the first run on the host will confirm the COM calls. Every
step logs its own failure to the Admin log, and the monitor tree can be read
from Admin to fix node keys without editing code.
