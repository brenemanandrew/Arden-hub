# Staging Lane Health

A live picture of the staging lanes and the people picking into them, drawn
from three reports SAP EWM already produces, shown on any screen in the
building and on a phone.

One PC sits next to SAP and runs the program. Every minute or so it asks SAP
for the same three exports a person would ask for by hand - the handling
units in the lanes, the open orders, and the warehouse tasks - reads them, and
serves the boards over the network. Nobody else installs anything; a TV, a
phone or a laptop just opens an address. A copy in the cloud shows the same
thing outside the building, fed by that one PC.

This file says what the program is, what it does and does not do, and how it
arrives at each number, in plain English. The mechanics - setting up the
host PC, the cloud copy, the SAP driver, moving the host - are in
`README-technical.md`.

---

## What it does

* **Shows the staging line as it is now.** Every lane, what is in it, how long
  it has been there, whether the order in it is ready to ship or still owed
  picks, and what to clear next.
* **Shows who is picking and how they are doing**, on the shift running now,
  today, or over a week, a month, a year - against a standard for each area of
  the warehouse.
* **Recommends what those standards should be**, from what the floor has
  actually done, so a standard is an observation rather than an opinion.
* **Writes the end of shift report itself**, a few minutes after each shift,
  and a one-pager for the week every Monday - the crew ranked, the areas
  against standard, what to watch.
* **Lays the year out a month at a time**, so a month that fell away can be
  told from one that held.
* **Keeps its own history**, because SAP only ever hands over a few days at a
  time, and backs that history up to the cloud copy by itself.
* **Puts SAP back on its feet** when it crashes or goes quiet, by closing what
  is left of it and opening it again through the Okta tile, so a session that
  died at two in the morning is not still dead at six.
* **Runs on one click.** The host PC's user double-clicks one file - even if
  it is already running, in which case the copy that was running is stopped
  first. The board opens by itself once the service is up and has its
  history, not before. Everyone else opens a web address.

## What it does not do

* **It never writes to SAP.** It reads three exports. Nothing on any screen
  changes anything in the warehouse system.
* **It does not measure time; it credits it.** Nobody clocks in or out of a
  pick. The program sees *when* each confirmation landed and works out how
  long somebody was probably working from that, by a rule set out below. That
  rule is stated everywhere the numbers are shown, and it can be tuned, but it
  is a rule, not a stopwatch.
* **It cannot see picks SAP did not export.** The task export covers tasks
  created in the last few days. A pick confirmed today on a task created a
  week ago is invisible to it. Everything is built to cope with that rather
  than pretend it is not so.
* **It does not know where a person was between picks.** Time credited in an
  area is time between confirmations in that area. A picker sent to do
  something else is not charged for the gap once it is longer than the
  window; they are simply not credited either.
* **It does not hide the numbers from anyone who can open the board.** The
  cloud copy is behind a password and its feed is sealed, but a person with
  the password sees what the board sees.
* **The cloud copy changes nothing, ever.** It mirrors the host. Five taps on
  the logo and a code turn on *host view*, which stops it hiding the parts
  meant for the PC next to SAP - the wall panel, the pull, the backfill, the
  standards - but every write is still refused, and the bar still says Viewer.
  It is a fuller view of the same copy, not a second host.
* **It is not a system of record.** The picker history it keeps is the best
  record anybody has of what was picked and by whom, but it is built from
  exports, and if an export was wrong that day the history is too.

---

## How the numbers are worked out

Every screen carries a short note saying what its number is. This is the
long version, area by area.

### The lanes: totes, orders, age and what to clear

A **tote** is a handling unit the HU staging export says is in a staging bin.
A **lane** is a bin with one or more totes in it. The lane's **orders** are
the consolidation groups those totes belong to, matched against the order
report.

A lane's **age** is how long its oldest tote has been in staging. The program
notices a tote the first time it appears in an export and remembers that
moment, so age is measured from when it first saw the tote, not from when SAP
says the tote was created. That is deliberate: it is the time the tote has
been *standing in the lane* that matters to the floor. A tote that vanishes
from the export has **departed**, and its stay is written to the dwell log.

Colour follows age. Under the first threshold is fine; past it is amber; past
the second is red; past three hours is **late**. The thresholds are settings.

A lane is **ready to ship** when the order report says every line on every
order in it is picked. It is **waiting on picks** when any line is still open.
This is the same test that draws the green mark on a lane.

**Clear next** is the lanes in use, oldest first. Ready lanes are flagged
because they can go now; the rest are there because the longer a tote stands
the more likely it is to be the one somebody asks about.

**Exceptions** are the things a person has to go and fix: a tote in problem
solve, an order split across lanes, a tote still in induct after its lines
are picked, a tote SAP has stopped reporting but the dwell log still shows in
a lane.

**Average dwell** is the median stay of the totes that left today. The median
rather than the mean, so one tote that sat for a shift does not move the
figure for everything else.

### Delivery lines picked today

Two exports count picked lines and neither is right on its own. The order
report lists lines on orders that have not shipped - so a picked line drops
out of it the moment its truck leaves, and the number shrinks all afternoon.
The task export keeps every confirmation, but only for tasks created in the
last few days. Neither ever overcounts, so the board takes **the larger of the
two**, and its footnote says which one it used.

Lines and picks are not the same thing. A delivery line can take more than
one warehouse task to fill. In this warehouse it runs at about 1.06 to 1.08
picks per line, so the two numbers sit close but not together.

### Picks, and the active-time rule

A **pick** is one confirmed warehouse task whose activity is PICK. The person
credited is the one SAP says confirmed it, at the time SAP says they did.

**Active time** is worked out like this. Every confirmation counts the person
as working for the next thirty minutes (a setting; five minutes is the
finest). Overlapping stretches are joined, so a steady picker gets one
continuous run and is never credited twice for the same minute. A gap longer
than the window is not credited at all: somebody pulled onto another job for
two hours is not charged for it, and is not paid for it either.

Breaks and hours the building is closed are taken out, using the shift
schedule. A picker whose last confirmation was at 12:14 is not still working
through lunch.

The thirty minutes is the convention the old board used and it is what every
rate on every screen is built on. Make it smaller and rates go up, because
less time is credited; make it larger and they go down. Change it with that
in mind.

On the activity strip, the pale band is credited time and the dark bars on it
are the minutes that actually carried a scan - taller the faster the scans
came. Band with no bar is the tail credited after the last pick. That is the
rule made visible.

### Hours in each area

A person's active hours are split between the areas they picked in, because
the areas run at very different speeds and the split is what makes a fair
comparison possible.

The rule: **every confirmation owns the clock from its own time until that
person's next confirmation**, capped at the window. So a pick in Flow at
09:00 followed by a pick in Cantilever at 09:20 credits Flow with twenty
minutes. The hours add up to exactly the person's active time and no minute
is counted twice. A batch confirmed in the same minute shares the gap that
follows it, which is the honest reading: those picks took that long.

Areas come from the source storage type on the task, mapped by a table of
prefixes (D1 = Flow, and so on) that can be edited on the picker page.

### Percent of standard

Each area has a **standard**: picks an hour one person should manage in it.
The defaults are set out on the picker page and can be changed there.

For one person, over any period:

    expected = (hours in Flow x Flow's standard)
             + (hours in Static x Static's standard)
             + ... for every area they worked
    percent  = picks / expected

So a person is held to the standard of *the area they were actually in*, for
*the time they were actually in it*. A fast picker on slow work is not
punished for the work; a slow picker in a fast area is not hidden by it.

The same arithmetic, added up across everyone, gives the **crew** percent for
a shift, a day, or a month. And it is why a month of nothing but cantilever
and a month of nothing but flow can both read 100%: each is measured against
its own standard.

People with only a handful of picks are counted but not ranked - somebody who
touched three jobs is not a picker having a bad day.

### Productive time

Active hours against the true picking hours of a shift - the shift's length
with its breaks taken out (6.5 hours by default, a setting). Somebody active
for 5 hours of a 6.5-hour shift is at 77%. The floor for green is a setting
too. It is a measure of how much of the shift the person was picking at all,
separate from how fast they picked when they were.

### The standards themselves, and the recommended ones

The standards in force are whatever is typed on the picker page. The program
also works out what they *should* be, from the record, so the number typed
can be an observation.

For each area it takes every **person-day** on file - one person, one day, in
that area - and keeps the ones with enough in them to be evidence: at least
half an hour and ten picks. The rate on each of those days is picks over
hours in that area. Then it reads three points off the spread:

* **Typical** - the middle of the pack (the median): half of person-days beat it.
* **Recommended** - the 60th percentile: something six in ten person-days beat.
* **Stretch** - the 75th percentile: the best quarter.

Two corrections. A person who only ever works one area pulls that area's
figure toward their own pace, so a specialist's days are **damped** - they
count, but not at full weight. And a single wild day is **capped** so it
cannot set the standard by itself.

Thin evidence is said to be thin. An area with a dozen person-days behind it
is shown with that number beside it, and the ten-pick floor means the days
that survive are the batched ones, which flatters the area. When the data and
the floor's own knowledge disagree on a thin area, trust the floor.

### Avg vs KPI on the classic board

For each area today: the area's picks divided by the **person-hours** worked
in it (the same per-area split as above), read against the area's standard,
shown as a percentage. It needs at least five picks and a quarter of an hour
before it will show a number.

The colour is not against the standard. It is against **what the area has
usually been doing** - the median of the last fourteen days. A standard is
where the floor is going; a shift can only be won against what the floor has
been doing, so green means better than usual, not better than standard. Both
marks are drawn on the bar. A footnote names the crew behind the number: how
many people, how many hours each, so 24 people for 3 hours can be told from 3
people for 24.

### Pace by hour

Picks the crew put away in each clock hour of the shift running now, each
bar coloured by how that hour ran against standard. A day total hides the
hour it went wrong; an hour is the grain a supervisor can still act on. The
hour's work is assumed to be the same mix of areas as the person's whole day,
because the export does not say which area each hour was in.

### Months

Every day on file is added up per area, then:

    expected for the month = sum over areas of (hours in that area x standard)
    percent                = picks / expected

Weighted by area, on purpose. Adding a month's picks up and dividing by its
hours would make a month heavy on cantilever look like a bad month rather
than a different one. Every card in the gallery is drawn on one shared scale
so the months can be read against each other; weekends are the faded bars.

### The work pipeline

One population, one unit - totes - in the order they really move: **in
induct**, **waiting on picks** in a staging lane, **ready to ship**, and
**cleared today** (from the dwell log). Every stage is counted from the HU
export and the departure log, so the arrows mean what they say: the same
totes move from one box to the next. The share cleared is totes gone today
against gone plus everything still on the floor.

### The end of shift report, and the week

A few minutes after each shift ends (the grace period is a setting) the
program writes one slide: lines against goal, picks, orders shipped, what is
still staged or past three hours, every area against its standard, work left
by area, watch items, and the crew - the three most productive and the five
least, by percent of standard. Anyone under ten picks or half an hour is
listed but not ranked. The week's one-pager does the same over the week, with
each day as a row. Both go to the reports folder and, when there is one, to
the shared reports folder, when one is set.

### The one-time backfill

SAP hands over tasks by **creation** date; a rate counts **confirmations**.
So the backfill asks for each window with four extra days of creation dates
in front of it - the lead-in - and files only the days it can see whole,
which lets a window be closed out and forgotten instead of holding a year in
memory. Windows are driven newest first, so a run that stops early keeps the
months that matter. A window SAP has nothing for is recorded and skipped;
several in a row stops the run, because that is where SAP's retention ends.

**A narrowed window climbs back.** When an export comes back comfortably inside
the cap the puller gives itself a day back, one per cycle, until it is at the
lookback somebody configured. Without that a floor that got quieter stayed on a
one-day window for ever - and a one-day window of creation dates loses every
task created yesterday and picked today, which understates every picker on the
board. The margin is deliberately thin: being careful here costs understated
numbers every day, and being optimistic costs one cycle, because a window that
turns out too big narrows straight back.

The driver refuses a window past 25,000 rows, because a scheduled cycle has
300 seconds to get it out of Excel and a bigger one is killed half way. That
cap is a cycle's problem, not the backfill's: a slice gets twenty minutes and
the backfill has its own 400,000-row rail, so it turns the cap off for its own
windows. It also runs with the narrowing switched off - one wide slice used to
step the live board's lookback down a day, which is the opposite of what
anybody asked for.

**Days per export is not the width of the window.** Every slice asks for the
four-day lead-in as well, so three days to file is seven days of creation dates
asked of SAP. The lead-in is paid once per export, which means very small
chunks cost *more* SAP time, not less: one day to file still drags five days of
rows out of Excel. At roughly 15,000 task rows a day that is 75,000 rows to
file one day, against 165,000 to file seven.

So the width of the window, not the chunk, is what decides whether a slice
finishes, and each one is given three minutes per day of window - twenty
minutes at the floor, an hour at the ceiling. A slice that runs out of time
says so, is skipped, and the run carries on; press it again with fewer days
per export and it picks up what it missed. Around a week to file is the sweet
spot at that volume.

**SAP does not keep warehouse tasks for ever.** The oldest months the backfill
collected cannot be pulled again; run it next year and it comes back with
less. That is why the history is backed up.

### Collecting it on another PC

A backfill drives SAP, and this PC has one SAP session. For the whole run it
is not pulling the floor's own exports, so the board sits still — on a year,
upwards of three hours of numbers nobody should trust.

It does not have to happen here. Another PC with SAP open can do the
collecting against its own session, and the file it writes is taken in on the
host without the host ever stopping.

**On the other PC**

1. Copy the whole program folder across, `runtime\node.exe` included.
2. Copy the host's `config.json` into that PC's data folder
   (`%LOCALAPPDATA%\StagingLaneHealth`). This is what makes the days get read
   the same way — the same area map, the same standards, the same line key.
3. Open SAP and log in.
4. Run **Collect history elsewhere.cmd**. It takes the days and the slice size
   as arguments if you want something other than 400 and 14.

It pushes nothing, feeds nothing and is not a host — the collect flag turns
the cloud push, the backups and the legacy files off so it cannot be mistaken
for one. When it finishes it writes a gzipped file into the `collected`
folder of that PC's data folder and stops.

**On the host**

Settings → **History collected elsewhere** → choose the file → *Take it in*.

Two things it checks before writing anything. A file that is not one of ours
is refused. And a file read under **different settings** is refused with the
differences named — a history parsed under another area map or another line
key is wrong in a way nobody notices for weeks. If you are sure, there is a
*Take it anyway*.

**What wins, day by day.** The same rule the live pull uses when it re-reads
a day, so the two cannot drift: more picks wins outright, and on equal picks
the reading that carries the work that was not picking wins. A day this PC
watched live is never replaced by a shorter reading of it from somewhere
else. The result says how many days were new, how many were improved, and how
many were already better here.

### Delivery value, which the warehouse does not know

EWM prices nothing - it is execution: quantities, weights, volumes, bins,
handling units. Every money figure on any of these boards comes from **ECC**, on
**VL06O**, and the Arden Master Shift Report has pulled it by hand into
pipe-delimited text for years. The pull now does the same two exports on its own
clock:

* **`SAP Deliveries.TXT`** - the open book, from the saved selection
  `ARDEN_OPEN_DEL`. Delivery, `Tt.Del.Val`, create date, sold-to, weight,
  currency. Joined to a picking status this is *value of orders pick complete*.
* **`SAP PGI.TXT`** - what actually left, goods issue date set to today.
  Delivery, `Total Del.Val`, actual GI date and time, bill of lading, carrier.
  This is *value shipped today*.

The join back to the warehouse is the delivery number: the order export already
carries **ERP Document**, which is the same key.

**It is off until somebody turns it on** (`pull.deliveries.enabled`), and it is
its own driver action on its own interval - thirty minutes by default - run only
after a *successful* cycle. All three of those are deliberate. VL06O lives in a
different system from the warehouse monitor, so it needs an **ECC session logged
in on the host beside the EWM one**; if that session is not there the pull fails,
says so, and the board carries on with the dollars it already had. One SAP GUI
means one driver at a time, and the exports the board actually runs on come
first. A dollar figure does not need to be thirty seconds fresh.

The driver finds ECC by trying each open session and keeping the one where
`/nvl06o` actually opens, rather than guessing at a connection number.

### The pack page moved out

The pack board is its own app now, at **ardenpack.fly.dev**, in the repo at
`F:\Projects\Arden Pack`. `/pack` here redirects to it.

It came out because two boards were sharing one set of settings and getting in
each other's way: a line key set for pack changed what a line meant on the
picker page, and the narrow task window pack could live with is the same window
the picker rates are measured on. One of those is a reporting choice and the
other is somebody's performance number, and they should not move together.

**It still reads this service's export folder** and runs no puller of its own -
one SAP session on the host, one driver, two readers. Nothing here has to push
anything to it. The **Pull pack benches** button on the Admin page stays here,
because this is the service that drives SAP.

### The one-time backfill

SAP hands over tasks by **creation** date; a rate counts **confirmations**.
So the backfill asks for each window with four extra days of creation dates
in front of it - the lead-in - and files only the days it can see whole,
which lets a window be closed out and forgotten instead of holding a year in
memory. Windows are driven newest first, so a run that stops early keeps the
months that matter. A window SAP has nothing for is recorded and skipped;
several in a row stops the run, because that is where SAP's retention ends.

The driver refuses a window past 25,000 rows, because a scheduled cycle has
300 seconds to get it out of Excel and a bigger one is killed half way. That
cap is a cycle's problem, not the backfill's: a slice gets twenty minutes and
the backfill has its own 400,000-row rail, so it turns the cap off for its own
windows. It also runs with the narrowing switched off - one wide slice used to
step the live board's lookback down a day, which is the opposite of what
anybody asked for.

**Days per export is not the width of the window.** Every slice asks for the
four-day lead-in as well, so three days to file is seven days of creation dates
asked of SAP. The lead-in is paid once per export, which means very small
chunks cost *more* SAP time, not less: one day to file still drags five days of
rows out of Excel. At roughly 15,000 task rows a day that is 75,000 rows to
file one day, against 165,000 to file seven.

So the width of the window, not the chunk, is what decides whether a slice
finishes, and each one is given three minutes per day of window - twenty
minutes at the floor, an hour at the ceiling. A slice that runs out of time
says so, is skipped, and the run carries on; press it again with fewer days
per export and it picks up what it missed. Around a week to file is the sweet
spot at that volume.

**SAP does not keep warehouse tasks for ever.** The oldest months the backfill
collected cannot be pulled again; run it next year and it comes back with
less. That is why the history is backed up.

### The pack page

Everything on `/pack` is built from the same warehouse task export the picker
numbers come from. Two row types carry it:

* **ZLOD** - a handling unit leaving a PK bench for LOADING. This is the
  output half: the tiles, the green track, "who packed".
* **INTL** and **PICK** - a move or a pick landing in a `PACK` or `PK##` bin.
  This is the workload half: the blue track, "work in".

`PK02` is a bench; `PK110201` is a picking bin. Only the two-digit form and
the bin literally named `PACK` count as a station.

**These are not cartons sealed.** A domestic carton is built at the bench and
leaves without being counted on its own, so there is no carton-per-packer
number here and no honest way to make one from this export. That needs a
handling unit **creation** export - `/SCWM/MON` Handling Unit, or `SE16N` on
`/SCWM/HUHDR` with created-on and created-by - which is a different pull.

**Reading a bench tile.** The big number is units sent to LOADING. Under it:
how often one left (the middle gap between confirmations, or, when units are
confirmed in bursts and that gap is zero, the pace across the stretch the
bench was open), then pounds or what is standing at the bench, then how many
people were on it and the last time anything moved. Colour is output against
the busiest bench - green over two thirds, gold over a third, dashed for a
bench that sent nothing out.

**What is waiting at each bench** is only there when the handling unit export
has been pulled for the PK bins. The staging pull asks for the lanes only, so
a unit standing in a PK bin never appears in it; the **Pull pack benches**
button on the Admin page is what fills that in.

**"Filling".** Arrivals are not units - several picks can feed one carton - so
more in than out is normal everywhere and means nothing on its own. A bench is
flagged when its own in-to-out ratio runs at twice the floor's, or when it has
taken work in all day and sent nothing out. That line is the only thing on the
page worth walking over to look at.

**Through the day** answers one of two questions depending on what is
selected. With nothing picked it is **every bench against every other** - the
comparison the tiles cannot make, because a tile is a number in a box and the
eye cannot rank fifteen of them. One row a bench, with units out ranked
against units out, work arriving ranked against work arriving, and a **per
unit** figure beside them.

**Units out are drawn inside the work that arrived, not beside it.** Laid end
to end the two read as a stack - "146 went out, 788 are still standing there" -
which is not true and is not nearly true: a pick is not a unit. Several picks
feed one carton. So the green sits *within* the blue, on one shared scale and
at half its height, because a bar inside a bar says "this much of that" where
two bars end to end say "this plus that".

**Arriving is counted in delivery lines when a line key is set**, which is a
far closer comparison than raw picks - one line picked out of two bins stops
counting twice. The key is the picker setting (`Configuration > pickers >
lineKey`), so one setting moves both pages, and **Admin > Columns** names the
column that should be in it. With nothing set a task counts as a line, and the
chart says so rather than printing the same number under a better heading.

**Per unit** is the one honest comparison between the two: lines arriving for
each unit sent out, with the floor's own average printed under the chart to
read it against. A bench well above the floor is being fed harder than the
rest or is not clearing what it is given, and that is also what the **Filling**
flag on the tiles is computed from.

Click a bench, in the chart or in the tiles, and it becomes **that bench hour
by hour**, with the crew list scoped to it as well.

**The page is yours to arrange.** **Edit layout** in the top bar puts a handle
on every card: drag it to move the card, pick a width (a third, a half, two
thirds, the page), or hide it. Hidden cards sit in a tray and come back with a
click, so nothing is a one-way door. The arrangement is kept in that browser,
per screen - a TV in the pack area and a supervisor's laptop can show different
things from the same service. **Copy layout** writes it out as text and **Paste
a layout** reads one back, which is how an arrangement moves between screens or
gets sent to somebody. **Start over** puts it all back.

Four sections are on the page by default, because they are what the floor asked
for: **Pack performance at a glance**, **Pack station health** (the bench tiles
with the hour chart under them), **Packer performance** and **What is going
out**. Everything else starts in the tray and is one click from coming back.

**At a glance** is orders out this week and in this window, lines out, lines an
hour split **parcel** against **truck pack** (PK01 to PK06, counted apart
because an average across the two describes neither), and active packers. A
packer who works both lanes has their hours split the way their units were,
which is the only apportionment the rows support. **$ shipped** is on the row
and says it has no feed, rather than being quietly left off a board somebody
will ask about.

**Click a packer** and everyone else folds away; click the row again, or *Show
every packer*, and they come back.

These three wait in the tray:

* **Pace** - this window against the one before it, hour by hour, as a running
  total. Green is today adding up; the grey mark behind it is where yesterday
  had got to by the same hour. It answers "are we ahead or behind right now",
  which is what gets asked at eleven in the morning.
* **Bench by hour** - benches down, hours across, shaded by units out. A hole
  in a row is a bench that stopped, and that is visible from across the room in
  a way a table is not.
* **Where the time went** - the longest run of minutes with nothing leaving
  each bench, and how often it ran past thirty. A bench can hold a good average
  and still have an hour missing from it. Measured inside one day, so it is
  blank on a multi-day range.

**Range and shift.** Today, Yesterday, 7 day and 30 day, with a shift
dropdown, in the same vocabulary the picker page uses. **Today** is the live
export, redrawn whenever the pull brings a new one. Everything behind it comes
out of a daily record kept at `<dataDir>/pack/history.json` - one entry a day,
holding the whole day and each shift of it separately, 400 days deep, written
every time a task export is read and again by the backfill.

The record exists because the export cannot be widened. It asks SAP for a
window of **creation** dates, and four days of them came back with 62,693 rows
and ran past the cycle timeout, so the puller narrows its own window instead.
A day already in the record is only replaced by a reading that holds more of
it, because the older days inside any window are partial by nature - a task
created five days ago and packed yesterday is not in a three-day window.
Today is the exception: the export is the whole of today, so today is replaced
outright on every read.

Three things do not survive a range and are only shown against Today:

* **what is standing at each bench** - a snapshot of right now, with no history
* **the order mix** - the open delivery book, likewise
* **the clock times** on a bench tile and in the crew list, which mean nothing
  across thirty days; a range shows days worked instead

Two more change shape rather than disappear. The **middle gap** between units
leaving a bench is only honest for one day - a median of medians is not a
median - so a range falls back to bench-open minutes per unit. And **weights**
are kept as a half-pound histogram rather than a list, so the middle weight and
the heavy end are accurate to half a pound across any range.

A shift view is a sum of days that shift ran: the heading says how many of the
days asked for had no such shift, which on a Saturday is simply the answer.
Active hours are capped per shift as well as per day, exactly as the picker
records are, so the shifts of one day can add up to slightly more than the day.

**Cube, not just weight.** `Loading Volume` is filled in on every row a packer
makes, so the board carries cube out of the door beside pounds: a tile for the
day, a figure on each bench tile, and **cube an hour** on each packer's line
next to units an hour. It is the only measure of packing effort besides units
that survives on every ZLOD row - a bench of big light boxes and a bench of
small heavy ones read the same in units and do not in cube. The unit is read
off the export rather than assumed.

**Lines per packer, through the handling unit.** The delivery and the item are
filled in on 100% of pick rows and **0%** of the rows a packer makes - a
handling unit going to LOADING carries neither - so the lines are not on the
packer's row and have to be fetched. A pick's **destination** handling unit is
the carton the stock went into; a ZLOD row's **source** handling unit is that
same carton leaving the bench. Join the two and the delivery lines inside
everything a packer sent out can be counted and put against their name. It is
the column **Lines/h** in *Who packed*, and a tile for the floor.

What the join cannot see is a carton built from picks that fall outside the
window the pull asked for - which, on a one to three day creation-date window,
is routine. Those come back as **nought lines rather than wrong ones**, and
every lines figure carries **% seen**: the share of that packer's units whose
contents could be traced back to the picks that filled them. A rate off a
third of the work is not a rate, and the board says which it is rather than
leaving a supervisor to find out in a review. Where the share is low, the fix
is a wider task lookback or a backfill, not a different sum.

It needs a line key. Without one there is nothing to join on, the rate is
blank rather than guessed, and the tile points at **Admin > Columns**.

**Hours and productive time** are worked out exactly as they are for pickers:
time with something moving, deduplicated, each gap capped at the active window
(30 minutes by default), counted a day at a time and capped at `dayHours` -
6.5 by default, a paid shift with breaks taken out. Somebody who was only on
the floor for three hours is credited with three. The cap is per day, so an
export spanning two days can carry two of them. Change `dayHours` in the
picker settings and both pages move together. Productive time is that active
time against the stretch between a person's first scan and their last, so a
low share is gaps in the day rather than a slow packer.

---

## When SAP falls over

The host PC drives SAP by attaching to a session somebody logged in to. When
that session dies - SAP crashes, the network drops it, a patch restarts it -
the board stops moving and stays stopped until a person notices, which on a
night shift can mean the whole shift.

So the program watches for two things: SAP telling the driver it is gone, and
**ten minutes with nothing fresh** (a session can sit there answering while the
exports quietly stop). On either, it closes what is left of SAP, opens the Okta
tile for SAP - which downloads a SAP GUI shortcut that logs itself in - runs
that shortcut, waits for the session to be scriptable again, and carries on
pulling. Every step goes in the pull log.

Two things happen before the shortcut is expected. Okta issues a new SAP
shortcut periodically, so an old one is a dead end rather than a shortcut: the
last downloaded one is only tried when SAP falls over again within a couple of
hours, it is given about a minute to prove itself rather than the full four, and
if it fails it is thrown away and the tile is opened instead. Saving one by hand
is not a way round the tile for the same reason. And when the tile stops one
click short - the session is fine, but a **Sign in**
button is waiting for somebody - that button is pressed. Edge and Chrome do not
publish the contents of a page to Windows automation, but they do publish
whatever has the keyboard focus, which on a page waiting for a click is the
thing it is waiting on. Only names like Sign in, Log in, Continue and Launch are
pressed, the wording is editable on the Admin page, and every control the window
offered goes in the log either way.

Three things it deliberately will not do:

* **It will not type a password.** The tile works on the host PC because that
  PC is already signed in to Okta. If Okta asks for a password or a phone
  approval, recovery stops there and says so in the log - automating past that
  would mean the program holding somebody's credentials, and it does not. The
  only key it ever sends is Enter, into a text box on that page, which is what
  pressing Enter in a sign-in form means.
* **It will not close SAP unless it can open it again.** Until the Okta link is
  set on the Admin page, a crash is reported and nothing is closed: a session
  nobody can restore is worse than the crash was.
* **It will not loop.** Three restarts an hour at most, never during a
  backfill, never while another one is still going.

Set it up once on the Admin page, under *When SAP falls over*: paste the Okta
app link for **PS1 005 - SCM Production** (the tile's own link from its
`...` menu, not the address of the dashboard). *Restart SAP now* on that page
does the whole thing on demand, which is the way to prove it works before you
need it.

## Reaching the host from far away

The host PC only ever talks outward, so nothing can log in to it. Three
things stand in for that:

* **Commands through the cloud copy.** Turn on host view on the copy (five
  taps on the logo, the code) and the Settings page has *From afar*: restart
  SAP, restart the service, pull now, back up now. The copy queues the
  request; the host picks it up with its next push - within a minute if it is
  running - does it, and reports back on the same page.
* **A control folder.** Give the host a folder that also syncs from your
  phone - a Google Drive folder - and drop a file into it called
  `RESTART SAP.txt` (or `NO UPDATE.txt`), `RESTART SERVICE.txt`, `PULL NOW.txt`
  or `BACK UP.txt`. Within about fifteen seconds the host does it and renames
  the file to `done - ...` with what happened written inside, which syncs
  back to you. This one works even when the cloud copy is what is broken.
* **A keep-alive.** `tools\install-keepalive.cmd`, once, on the host: a task
  checks every five minutes that the service is running and starts it if not.
  It is the only one of the three that helps when the service itself has
  died - neither of the others can reach a PC that is not running it - and
  nothing at all helps a PC that is switched off.

And `/deploy` on the copy - not linked from anywhere, behind the viewer
password - hands out the build it is running as the zip a host PC installs,
with a note on the backup it is holding for the next PC.

## Where the data lives, and backups

Everything the program writes for itself - the picker history, the bench
history behind the pack page, the settings, the dwell log, the reports - lives
in `%LOCALAPPDATA%\StagingLaneHealth` on the host PC. Replacing the program
never touches it.

The program backs that folder up **by itself**, at every moment
the data is worth more than it was or is about to be at risk:

* a few minutes after **every shift ends**;
* the moment **SAP stops answering**;
* when the **service is stopping** - closing the window, a restart, a PC
  being shut down. That is the backup that exists if the PC never comes back;
* when a **backfill finishes**, because months of history just landed that
  SAP will not hand over twice;
* **before anything is restored** over what is here, so the wrong backup is
  undoable;
* and a floor under all of it: if **twelve hours** pass with no backup for any
  of those reasons, one is taken anyway;
* plus whenever somebody presses **Back up now**.

Every one goes **to the cloud copy**, sealed, and to a folder on this PC -
the data folder, unless a path is typed on the Admin page. Automatic backups
are rate limited to one every five minutes, so a bad afternoon cannot fill the
folder, and the newest thirty are kept.

And back the other way, **at every start**: the program asks the cloud copy
what it is holding - a few hundred bytes, not the backup itself - and if that
has more history than this PC does, takes it and merges it in. The merge keeps
every day this PC already had, so the answer is the union of the two and there
is nothing to lose by it. That is true of a brand new PC and of one that has
been running for a month; nobody has to press anything.

## Running it

On the host PC, next to SAP: double-click **Start Staging Lane Health.cmd**.
It stops whatever copy was running, stops the old VBS puller and its Task
Scheduler watchdog if that PC still has them, reads `cloud.txt` if one is
beside it, takes the history from the cloud copy if that has more than this PC,
starts serving, and then opens the board. Everyone else opens the address it
shows. That is the whole of it; the rest is in `README-technical.md`.

### Moving the host to another PC

Copy the folder, double-click. To make that literally true, fill in
`cloud.txt` (there is a `cloud.txt.example` beside it): the cloud address and
the ingest secret. A PC that starts knowing those pulls the newest backup
from the cloud copy by itself - the whole year of history - without anything
being typed on the Admin page.
The file holds the secret in plain text, which is the trade; it is the same
secret already in that PC's config.
