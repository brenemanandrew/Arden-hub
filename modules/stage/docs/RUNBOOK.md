# Staging Lane Health — Runbook

One page. What breaks, what it looks like, what to do about it.
No code knowledge needed. Print it and tape it to the host PC.

**Host PC** = the one PC with SAP GUI open that feeds everything else.
Everything on this page is done on that PC unless it says otherwise.

---

## First 30 seconds

Open the board. Look at the top strip and the Admin page (`/admin`).
Then work down this list — the first "no" is your answer.

| # | Question | If no |
|---|----------|-------|
| 1 | Is the host PC **logged in**? (not just powered on) | → **A** |
| 2 | Is the **service window** open on it? | → **B** |
| 3 | Is **SAP GUI** open and logged in on it? | → **C** |
| 4 | Does Admin say the pull is **running** (not STOPPED / switched off)? | → **D** |
| 5 | Do all three exports read **ok** on the Data page? | → **E** |

If all five are yes and the numbers still look wrong, it's **F** or **G**.

---

## A — The PC rebooted and nobody logged in

**Looks like:** everything stale since roughly the same timestamp. Cloud copy
says it hasn't been fed. This is the most common failure, usually after
Windows Update.

**Why:** the service starts **at logon**, not at boot, and SAP GUI scripting
only works inside a logged-in session. Nothing can run on the login screen.

**Fix:** log in to the host PC. The Startup item launches the service and the
keep-alive task (every 5 min) catches it if it dies later. Then check SAP is
up — see **C**.

**Permanent fix** is Windows autologon (`netplwiz` / Sysinternals Autologon),
which is an IT decision, not something the app can do for itself. SAP still
has to be signed in afterwards.

---

## B — The service isn't running

**Looks like:** the board won't load at all; browser says it can't connect.

**Fix:** double-click **Start Staging Lane Health.cmd** in the program folder.
It stops any half-dead copy first, so running it twice is safe.

If it says Node.js was not found, the `runtime\node.exe` beside it is missing —
restore the folder from a backup copy.

---

## C — SAP fell over

**Looks like:** board frozen. Pull log says *SAP GUI not reachable* (code 2),
*SAP session not ready* (code 3), or *could not reach the warehouse
monitor* (code 4).

**What the app already does:** when SAP stops answering, or nothing fresh
arrives for 10 minutes, it closes what's left of SAP and reopens it through the
Okta tile — up to 3 times an hour. All of it is in the pull log.

It deliberately **will not** type a password, and **will not** close SAP unless
the Okta link is set on the Admin page (closing a session it can't reopen is
worse than the crash).

**Fix:** open SAP GUI on the host PC and log in normally. The pull picks up on
its own within a minute. If Okta asked for a password or a phone approval, that
is why recovery stopped — nothing is broken.

*Code 4 specifically* means SAP is fine but `/SCWM/MON` wouldn't open —
usually a SAP-side permission or transport change. That one needs a person.

---

## D — The pull is stopped or switched off

**Looks like:** everything healthy, nothing updating, and the board says so in
plain English.

- **"the pull is STOPPED"** — somebody pressed STOP. It is remembered across
  restarts on purpose. → press **START** on the Admin page.
- **"the pull is switched off"** — `pull.enabled` is false in Settings. The
  folder is still being read, just not refilled.
- **"no viewer for 10 minutes; pausing"** — normal. It resumes the moment
  somebody opens the board.
- **"another PC is feeding the cloud copy"** — a second host grabbed the lease.
  Press **Take over** on Admin if this PC should be the one.

---

## E — An export is missing, stale or wrong

Check the **Data** page. Each of the three files reports its own status.

| Status | Means | Do |
|--------|-------|-----|
| `not found` | no file by that name in the folder | check the report folder path in Settings |
| `wrong file` | e.g. the Orders export saved under the WHTask name | the board keeps the last good data; fix the name |
| `parse failed` | the file isn't a readable workbook | usually a half-written file; wait one cycle |
| `empty file` | zero bytes | SAP exported nothing — rerun that part from Admin |
| `no folder` | the report folder doesn't exist | wrong path, or a network share is down |

A locked file (Excel has it open) is *not* an error — the app keeps the last
good read and retries.

---

## F — Picker numbers suddenly dropped

**Looks like:** everyone's pick count is low, across the board, overnight.

**Cause:** the task export got too big, so the app narrowed how many days of
creation dates it asks for. A task created yesterday and picked today then
falls outside the window and nobody gets credit for it. The log says so
explicitly ("asking for 1 day(s) of creation dates").

It climbs back up by itself, one day at a time, once exports are comfortable
again. If it's stuck, check **task lookback** (`wtBackDays`, normally 3) in
Settings.

**Other cause:** somebody set **lineKey** in Settings. That changes a "pick"
from one task into one delivery line and the numbers are not comparable. Blank
it to go back.

---

## G — Arden Pack is blank but Staging Lane Health is fine

Arden Pack has **no SAP driver by design** — one session, one driver. It only
reads the folder Staging Lane Health writes to.

So: if pack is empty, the problem is on the Staging Lane Health side, or the
shared folder isn't reachable from wherever Arden Pack runs. Check the Staging
Lane Health side first; the pack app's settings page reports each file it can
and can't see.

---

## What a non-coder should never need to do

Edit config files by hand, restart anything with a command line, or touch SAP
settings. Everything on this page is a login, a double-click, or a button.

## When to escalate

Escalate if: SAP exit code **4** persists (monitor won't open), an export reads
`parse failed` for more than an hour, or the numbers are wrong in a way none of
the above explains. Those are the three that need somebody who can read the
code.

## Where to look

- **Pull log** — Admin page, live. The single most useful thing on here.
- **Log files** — `%LOCALAPPDATA%\StagingLaneHealth\logs`
- **Health check** — `/api/health` returns ok plus the data version
- **Full detail** — `README.md` (how the numbers work) and
  `README-technical.md` (how it's built)
