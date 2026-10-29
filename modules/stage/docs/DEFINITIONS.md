# What the numbers mean

Every measurement these two dashboards produce, defined in plain English.

This is the part worth keeping. The code is one way of applying these
definitions quickly — if the code disappeared tomorrow, somebody could rebuild
it from this page. If this page disappeared, nobody could reproduce the
numbers, and every decision made on them becomes unauditable.

Anything **bold with a `code name`** is a setting that can be changed.

---

## Where the data comes from

SAP EWM, through three exports pulled off the warehouse monitor
(`/SCWM/MON`) every 30 seconds:

| Export | What it is | Used for |
|--------|-----------|----------|
| **WHTask** | every warehouse task confirmed | picks, pack, everything about people |
| **HU STAGING** | a snapshot of what is *parked* right now | lanes, dwell, totes |
| **Orders** | open orders and their picking status | order status, delivery lines |

One thing to understand before anything else: **EWM carries no money.** There
is no dollar value anywhere in the warehouse system. Value comes from a
separate ECC export (VL06O) joined on the delivery number, and it is optional
and off by default.

**HU STAGING is a snapshot, not a history.** It shows what is standing
somewhere at this moment. A domestic carton built at a bench goes straight to
LOADING and is never parked, so it never appears in it. This is why "what is
standing at each bench" reads blank on this floor, and it is correct, not
broken.

---

## People and time

### Pick
One confirmed warehouse task = one pick. Full stop. That is the only
"production" event the warehouse records with a person's name on it.

### Line
By default **a task is a line** — they're the same number. If **`lineKey`** is
set, a line is instead a distinct combination of the named columns (typically
delivery + item), so several tasks against one delivery line count once.

Two warnings, both learned the hard way:
- Setting `lineKey` makes the numbers **not comparable** to any period before
  it was set. Changing it rewrites history's meaning, not history.
- Every part of the key must be present. A row with blanks in all key columns
  is not a line, it's a row with no key — counting it as one collapses a whole
  floor into a single "line".

### Active time
Every confirmation counts the person as working for the next **30 minutes**
(**`activeMin`**). Overlapping windows merge, so a steady picker gets one
continuous stretch rather than a count of windows.

What this gives you: somebody pulled onto another job for two hours isn't
charged for the gap. What it costs you: a single pick at 2 PM credits 30
minutes of work. There is a floor of **0.25 h** so three picks in five minutes
can't produce an absurd rate.

Breaks and closed hours from the **schedule** are subtracted, so a picker whose
last scan was 12:14 isn't "still working" through lunch.

### Area hours
Each confirmation owns the clock from its own timestamp until the next one,
capped at the 30-minute window. So hours sum to *exactly* the person's active
time and no minute is counted twice. A batch confirmed in the same minute
shares the gap after it — which is the honest reading: those picks took that
long.

### Picking hours in a shift
**6.5 hours** (**`dayHours`**) — the paid shift with breaks taken out. This is
a floor-wide assumption, not a measurement, and it's the same number used by
both the picker report and the pack report so the two can be compared.

### Productive time
Active hours ÷ 6.5. Somebody active 5 hours of a 6.5-hour shift is at 77%.
Reads green from **75%** (**`prodFloor`**).

This answers *how much of the shift were they picking at all* — a completely
different question from how fast they picked while picking. Don't conflate
them.

### Percent of standard
Each area has a **standard**: picks per hour one person should manage there.

```
expected = (hours in Flow × Flow's standard)
         + (hours in Static × Static's standard)
         + … for every area worked
percent  = picks ÷ expected
```

A person is held to the standard of the area they were actually in, for the
time they were actually in it. A fast picker on slow work isn't punished for
the work; a slow picker in a fast area isn't hidden by it. It's also why a
month of nothing but cantilever and a month of nothing but flow can both read
100%.

People below **`minPicks`** are counted but not ranked — somebody who touched
three jobs isn't a picker having a bad day.

---

## Pack

Nothing in EWM is called "packing". The pack board is built from the two
movements on either side of it, both in the WHTask export:

| Code | Meaning | Counted as |
|------|---------|-----------|
| **ZLOD** | a handling unit leaves a pack station for LOADING | **one finished unit out the door** |
| **INTL** | an internal move landing at a PACK/PK bin | **work arriving** |
| **PICK** | a pick landing at a PACK/PK bin | **work arriving** |

### Units out ≠ cartons packed
ZLOD is the closest thing to output the warehouse writes down, but it is a
*handling unit leaving*, not a carton sealed. Cartons per packer would need a
handling-unit *creation* export, which is a different pull that doesn't exist
yet. Don't let anyone quote "units out" as cartons.

### Work arriving is two different things
On this floor, internal moves outnumber picks roughly **four to one**. Shown
together, "arriving" looks wild against output. They're reported apart for
that reason, and "in" vs "out" is not an equation — a pick is not a unit.

### Bench
A bin matching `PK` + two digits (PK02, PK13). **`PK110201` is a picking bin,
not a bench** — the pattern is deliberately strict.

**PK19, PK26 and PK27 are excluded** (**`pack.hideBins`**): they're BOL and a
hidden pack area. They take work in and never send a unit out, so they sat at
the bottom of the board flagged as filling up forever.

### Truck pack vs parcel
**PK01–PK06 are truck pack**; every other station is parcel. Different work at
different speeds — an average across both describes neither, so they're always
counted apart.

---

## Lanes and dwell

### Dwell
A tote is logged when it **leaves** a lane. A gap in observation re-baselines
rather than inventing departures — if the app wasn't watching, it doesn't
guess. Anything past **50 hours** (**`capHours`**) is flagged rather than
counted, because it's almost always a tote that was moved while nobody was
looking.

Window: **30 days** (**`windowDays`**). Observation gap that re-baselines:
**2 hours** (**`gapHours`**).

---

## Value (optional, off by default)

`Tt.Del.Val` / `Total Del.Val` from two ECC text exports (VL06O), joined to the
warehouse data on the **delivery number** (which the Orders export carries as
`ERP Document`).

This needs a **second SAP session logged into ECC** beside the EWM one, runs on
its own 30-minute clock, and fails silently if it isn't there — the board is
unaffected and dollars simply stay as they were. That's deliberate: a dollar
figure is not worth breaking a working board for.

---

## The performance review

The review page (**/review**) answers a narrower question than the rest of the
app: *is this person doing well enough, and what do I say to them*. Four of its
rules are its own.

### The order of the page

The sections are in the order the conversation should go, and each one exists
to close off a question before it gets asked badly.

| | Answers |
|---|---|
| **5 / 10 / 15 / 20** | is this window typical of them, or a slice |
| **vs KPI · Productivity · Total picks** | how fast, how much of the shift, how much came out |
| **Where the time went** | were they given slow work? — answered before it is raised |
| **Where the shift went** | is this a *rate* problem or an *availability* one |
| **Picks by day** | the evidence, with the floor laid over it |
| **Is it moving?** | is there a signal at all |
| **Against the crew** | last, because it is the most abused number on the page |
| **Before you quote any of this** | what none of it can see |

**Total picks is scale, not a score.** Volume follows the hours somebody was
given: ten full days out-picks ten half days at identical performance. It is
on the page because it is the only figure with no assumption in it — no
standard, no active-time rule, no 6.5 — which makes it the one thing nobody
can argue with. It carries its own hours and its per-day figure so it cannot
be read without them.

### A bad day for them, or a bad day for the floor

The blue line across **Picks by day** is the rest of the shift on the same
days, converted into this person's hours: the picks they would have come to
at the floor's pace. Same axis, same question.

Where it dips with them, the day belonged to the floor — replenishment
behind, a system slow, a short-staffed morning — and is not theirs to
explain. Where it carries on without them, the day is theirs. **This is the
single check that stops a system day being read as a personal one**, and it
needs at least three other pickers on the day before it will draw anything.

### Days worth asking about

Every day under the standard used to read red, which points a supervisor at
half of them. The ones with a cause in them are the ones outside **this
person's own** ordinary range — two deviations either side of their own
average — and only those are ringed. Typically that is one day in twenty
rather than nine in twenty, and it needs five days before it will draw at
all.

### Noise, and what counts as a change

The page states the smallest difference worth discussing: one deviation of
their own day-to-day scatter. Anything smaller — between two weeks, or
between two people — is the ordinary variation of doing the job, not news.

The same rule governs **Is it moving?**. A line through scatter is still a
line and reads as a decline, so the two halves of the window must differ by
more than the scatter alone would produce before the page calls it a
direction. Below that it says *no change worth calling*, which is a finding
rather than a failure to find one.

### Worked day

A day this person actually picked on, with at least **2 hours** of active time
in it. Days off, vacation and light duty fall out on their own because there is
no record for them — no roster to maintain.

A day under the floor is left out too: somebody who confirmed nine tasks
between other jobs did not have a picking day, and scoring it as one drags the
rate down for a reason that has nothing to do with picking. **Every day it
excludes is named on the page.** A number that quietly dropped days is worse
than one that kept them.

So "the last 10 worked days" can span two or three calendar weeks. The page
always shows both — the window and the dates it reached back to.

### The crew comparison

Everyone else on the **same shift** over the **same dates** — not their own
last 10 days. Two people measured over two different stretches of the year
differ partly because of which weeks they are, and that is not performance.

Peers are filtered by the same 2-hour floor, and anyone with less than a third
of the subject's days inside the window is left out rather than averaged in at
a number that means nothing. Everyone except the subject is **anonymous**: the
page is pointed at the person being reviewed, and they do not need their
colleagues' names and rates.

### Average is not the bar

Half the crew is below average by arithmetic, not by performance. The
**standard** is the bar.

The review puts percent of standard in the large type and shows the crew spread
as context. Raw picks per hour sits beside it only because people ask for it —
raw rate punishes anyone who was given slow work, which is the exact thing
percent of standard exists to neutralise.

### Nothing on it is estimated

The People page fills a person's missing months from their own average, so a
year with only three months of records still reads as a year rather than as a
broken bar chart. Those months are drawn paler and labelled as estimates.

**None of that reaches the review.** Every figure on the review page is a day
that person actually picked, taken off the stored history. There is no filling
in, no averaging forward, and no estimate anywhere in what the page is sent —
a test asserts that, and a second one asserts the review never calls the
function that does the filling.

When somebody has fewer days on file than the window asks for, the review says
so rather than making the difference up: the window card reads *"3 days only,
not 20"*, it is drawn hatched, and a note spells it out. Four cards showing the
same number because only three days lie between them must not look like four
weeks of steady work.

### Picks by day

The bar is **what they picked that day**. Nobody finishes a shift thinking
"that was ninety-four per cent" — they think "I did two hundred and thirty",
and the percentage is already on the review three other ways.

The dashed line across each bar is **what the standard asked of that day**:
the hours they were actually on it, at the standard for the work they were
actually given. So a half day asks for half. That is the only way a chart of
pick counts can be read without a short day looking like a bad one — a day of
118 picks against 109 asked is a *good* day, and reads green.

The faint line across the whole chart is a **full day at standard** —
`picking hours × the standard for their usual mix`. It shows which days were
full days, without making the short ones look like failures.

The colour is still percent of standard, so the verdict has not moved; only
the number somebody can recognise.

### Where the shift went

Four rows in five of the warehouse task export are **not picks**. In one real
export of 11,056 confirmed tasks: 7,566 internal moves, 1,946 picks, 738 pack
hand-offs, 367 replenishments, 362 putaways, and a few adjustments. Every one
of them carries the name of whoever confirmed it and the time they did.

Until now the picker model threw all of them away at the top of the loop,
which is how a shift could read as six hours of picking and two hours of
nothing when the two hours were internal moves. They are kept now, so the
review can split the paid day four ways:

| Part | Where it comes from |
|---|---|
| **Picking** | measured — active time on confirmed picks |
| **Other warehouse work** | measured — active time on everything else they confirmed, with any overlap with picking removed so no minute is counted twice |
| **Breaks & setup** | the allowance: paid shift hours minus picking hours (8 − 6.5 = 1.5) |
| **Unaccounted for** | whatever paid hours are left after the other three |

**Nothing is clipped.** The People page holds picking down to the picking
hours a shift is worth, so a long day reads as a full one; that is fair on a
gallery and wrong on a review, because it made exactly the work this section
exists to show disappear. Here, if picking plus other work plus the allowance
comes to more than the paid shift, the page says **how far past it went**.
A shift that routinely runs over is a shift whose picking hours are set too
low — worth seeing, and not the picker's fault.

**Paid hours are the only assumed figure on the page.** Nothing in this app
can see a clock-in; paid hours are the shift length times the days they
picked. Everything else in the split is measured. The page says so.

### What they were doing instead

A person with records but no picking day — somebody who spent the week on
putaway — used to get "no picking days on file", which reads as a broken
pull. The review now lists what they actually confirmed and how long it took,
so the answer to *why does this picker have no picks* is on the screen rather
than in somebody's head.

Activity codes are **SAP's own**. What each one means is a setting, on the
picker page under the review knobs, one `CODE = label` to a line — the same
shape the standards and the area map use. Out of the box, as the floor
describes them:

| Code | Means |
|---|---|
| `PICK` | picking |
| `INTL` | internal moves |
| `ZLOD` | pack to loading |
| `REPL` | replenishment |
| `PTWY` | putaway |
| `DPUT` | direct putaway |
| `ADJT` | stock adjustment — a clerical correction from the cycle count team, not physical work |

A code with no line shows as **the code**, never as a guess, and the page says
it can be named on the picker page. A review that mislabels somebody's work is
worse than one that makes you ask what `DPUT` means — and a code this
warehouse starts using next year should cost somebody a typed line rather than
a release.

### The four knobs

All on the **picker page**, under *Pick standards → Performance review*. They
change the review page only; everything else on it is the same arithmetic as
the picker board.

| Setting | Default | What it does |
|---|---|---|
| **Windows, in worked days** | 5, 10, 15, 20 | The four cards across the top. Up to four, any length from 1 to 120 days. |
| **A day counts as picking from** | 2 hours | The floor. Under this much active time, the day was not a picking day and is left out — and named on the page. |
| **Compare a picker only from this share of the days** | 34% | A peer with less than this much of the subject's window in them is left out of the crew comparison rather than averaged in at a number that means nothing. |
| **Productive time over 100%** | hold at 100% | Whether a day with more active time than the shift's picking hours reads 100% or 110%. See below. |

A review can also be asked for a different floor without changing it for
everybody, by adding `&minHours=0` to the address — useful for seeing what the
floor is doing before deciding to move it.

### Productive time past 100%

Active hours are measured, not assumed: a day can measure more than the 6.5
picking hours a shift is worth. By default the review holds that at 100%,
because a shift cannot be more than itself.

But a floor where people routinely measure past it is a floor whose **picking
hours are set wrong**, and a tidy 100% is how that stays unnoticed. Switching
the setting to *show it* surfaces the overage instead.

### Day to day

The spread between the best and the worst day in the window. Someone averaging
94% every day and someone averaging 94% while swinging between 70 and 120 are
the same number and not the same conversation.

---

## The one that bites

**Task lookback** (**`wtBackDays`**, normally 3) is how many days of *creation*
dates the task export asks for. A task created Monday and picked Tuesday is
invisible if the window is one day — and that **understates every picker on the
board** without anything looking broken.

The app narrows this automatically when exports get too big to finish, and
climbs back a day at a time when they're comfortable again. It says so in the
log both ways. If picker numbers drop floor-wide overnight, check this first.
