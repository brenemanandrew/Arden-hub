'use strict';
/* One picker, over their last few worked days, for the conversation a
   supervisor has with them.

   The picker report answers "how did everyone do"; People answers "how is
   Ann doing". This answers the third question, which is the hardest one to
   answer fairly: "is Ann doing well enough, and what do I say to her".

   Three things make it different from the views either side of it.

   - It counts WORKED days, not calendar days. A review covering "the last
     ten days" that includes four days off is not a review of anything. So
     the window walks back through the days this person actually picked and
     stops at the tenth, however far back that reaches. Days off, vacation
     and light duty fall out on their own, with no roster to maintain.

     A day only counts if there was a day's work in it. Somebody who
     confirmed nine tasks between other jobs did not have a picking day, and
     letting that count as one drags a rate down for a reason that has
     nothing to do with picking. The floor is a setting; every day it
     excludes is listed, because a number that quietly dropped days is worse
     than one that kept them.

   - It compares to the crew over the SAME DATES, not the crew's own last
     ten days. Otherwise two people are being measured over two different
     stretches of the warehouse's year and the difference between them is
     partly just which weeks they are.

   - Everyone except the subject is anonymous. A supervisor needs to know
     where this person sits; the person sitting across the desk does not
     need to see their colleagues' names and rates, and this screen is
     pointed at them.

   What it deliberately does not do is invent arithmetic. Every figure comes
   from score() in pickers.js, the same function the picker page and the
   People page use, applied to a different set of days. If a number here
   disagrees with a number there, one of the two windows is different and
   nothing else. */

const model = require('./model');
const schedule = require('./schedule');
const { score, round } = require('./pickers');
const { workedHours } = require('./person');

const LOOKBACK = 400;              // the history cap
const WINDOWS = [5, 10, 15, 20];   // the windows a review is read over, unless settings say otherwise
/* A day with less picking in it than this is not a picking day. Two hours
   of a six and a half hour shift: enough that somebody was on the floor
   doing this job, little enough that a morning spent helping elsewhere is
   not scored as a bad day. */
const DEFAULT_MIN_HOURS = 2;

function keyBack(todayKey, i){
  const d = new Date(todayKey + 'T12:00:00');
  d.setDate(d.getDate() - i);
  return model.dayKey(d);
}
const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : 0;
function median(a){
  if(!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* the one record for a person on a day: the whole day, or one shift of it */
function recOf(entry, who, shiftName){
  /* somebody who only moved things that day is filed beside the pickers
     rather than among them; for this page they are the same person */
  const whole = (entry && entry.pickers && entry.pickers[who]) ||
                (entry && entry.others && entry.others[who]);
  if(!whole) return null;
  const r = shiftName ? (whole.shifts && whole.shifts[shiftName]) : whole;
  /* a record counts when there is anything in it at all, picks or
     otherwise - the floor decides what is a picking day, not this */
  return (r && (r.total || (r.otherHours || 0) > 0)) ? r : null;
}

/* every day this person has a record for, newest first, each marked with
   whether it was a picking day or something less than one */
function daysFor(pickers, who, todayKey, st, shiftName, minHours){
  const out = [];
  for(let i = 0; i < LOOKBACK; i++){
    const key = keyBack(todayKey, i);
    const entry = pickers.history[key];
    const r = recOf(entry, who, shiftName);
    if(!r) continue;
    const shape = (entry && entry.shape) || schedule.dayShape(st.sched, key);
    out.push({ key, r, worked: workedHours(r, shape),
               counts: (r.activeHours || 0) >= minHours,
               lineKey: (entry && entry.lineKey) || [] });
  }
  return out;
}

/* the same merge person.js does, so a window here and a window there agree */
function merge(who, list){
  const m = { who, total: 0, lines: 0, byArea: {}, areaHours: {}, activeHours: 0, days: 0, firstH: null, lastH: null };
  m.other = {}; m.otherHours = 0;
  for(const d of list){
    const r = d.r;
    m.total += r.total;
    m.lines += (r.lines == null ? r.total : r.lines);
    m.activeHours += r.activeHours || 0;
    m.otherHours += r.otherHours || 0;
    /* a record written before this app kept non-pick work has no key for
       it at all; one written since has the key, null when there was none.
       Saying "nothing but picking" about the first kind is a claim about
       history this cannot make. */
    if(!('other' in r)) m.preCapture = (m.preCapture || 0) + 1;
    for(const k in (r.other || {})) m.other[k] = (m.other[k] || 0) + r.other[k];
    m.days++;
    if(r.firstH != null && (m.firstH == null || r.firstH < m.firstH)) m.firstH = r.firstH;
    if(r.lastH != null && (m.lastH == null || r.lastH > m.lastH)) m.lastH = r.lastH;
    const rah = r.areaHours || null;
    for(const a in (r.byArea || {})){
      m.byArea[a] = (m.byArea[a] || 0) + r.byArea[a];
      const h = rah && rah[a] != null ? rah[a] : (r.activeHours || 0) * (r.byArea[a] / Math.max(1, r.total));
      m.areaHours[a] = (m.areaHours[a] || 0) + h;
    }
  }
  return m;
}

/* Active hours against the picking hours those days were worth. Capped at
   100 by default, because a shift cannot be more than itself - but a floor
   where people routinely measure past it is a floor whose picking hours are
   set wrong, and hiding that behind a tidy 100% is how it stays wrong. The
   setting lets it show. */
function prodOf(active, days, st){
  const rv = st.review || {};
  const pct = Math.round(active / (days * st.dayHours) * 100);
  return (rv.capProd === false) ? pct : Math.min(100, pct);
}

function stat(who, list, st){
  if(!list.length) return null;
  const m = merge(who, list);
  const s = score(m, st.targets, st.windowMin);
  const worked = list.reduce((t, d) => t + (d.worked || 0), 0);
  /* Where the paid hours went.

     The People page holds picking down to the picking hours a shift is
     worth, so a long day reads as a full one with no down time. That is
     fair on a gallery and wrong here: somebody who picked for six and a
     half hours AND confirmed a thousand internal moves did not do nothing
     else, and clipping made exactly the work this section exists to show
     disappear. So nothing is clipped. Picking and other work are what was
     measured, the allowance is what the shift is owed, and down time is
     whatever paid hours are left - which can be nothing, and then over
     says by how much the measured day ran past the assumed one. A shift
     that keeps running over is a shift whose picking hours are set wrong,
     and that is worth seeing rather than rounding away.

     Paid hours are the only assumed figure on the page: nothing here can
     see a clock-in. The page says so. */
  const days = s.days;
  const paid = round(days * st.shiftHours, 2);
  const allowance = round(days * Math.max(0, st.shiftHours - st.dayHours), 2);
  const picking = round(s.activeHours, 2);
  const otherH = round(m.otherHours, 2);
  const used = allowance + picking + otherH;
  const per = n => (days ? round(n / days, 2) : 0);
  const sp = {
    paid, allowance, picking, other: otherH,
    down: round(Math.max(0, paid - used), 2),
    over: round(Math.max(0, used - paid), 2),
    perDay: days ? { paid: round(st.shiftHours, 2), allowance: per(allowance), picking: per(picking),
                     other: per(otherH), down: per(Math.max(0, paid - used)), over: per(Math.max(0, used - paid)) } : null
  };
  return {
    picks: s.total, lines: s.lines, hours: s.activeHours, worked: round(worked, 2),
    days: s.days, rate: s.rate, lineRate: s.lineRate, pct: s.pct,
    expected: s.expected, targetRate: s.targetRate,
    byArea: s.byArea, areaStat: s.areaStat,
    shift: sp,
    /* what they did that was not picking, and how long it took */
    other: Object.keys(m.other).length ? m.other : null, otherHours: round(m.otherHours, 2),
    preCapture: m.preCapture || 0,
    /* how much of the picking hours of those days was spent picking at all,
       which is a different question from how fast */
    prod: s.days ? prodOf(s.activeHours, s.days, st) : null
  };
}

/* Which shift this person is usually on, so a review does not have to be
   told. Counted over their recent days rather than their whole history: a
   mover from nights to days is on days. */
function usualShift(pickers, who, todayKey, st){
  const seen = {};
  for(let i = 0; i < 45; i++){
    const e = pickers.history[keyBack(todayKey, i)];
    const whole = e && e.pickers && e.pickers[who];
    if(!whole || !whole.shifts) continue;
    for(const k in whole.shifts){
      const r = whole.shifts[k];
      if(r && r.total) seen[k] = (seen[k] || 0) + r.total;
    }
  }
  const names = Object.keys(seen);
  if(!names.length) return null;
  return names.sort((a, b) => seen[b] - seen[a])[0];
}

/* Everyone else over the same dates. Their own weak days are dropped by the
   same rule the subject's are, so the two sides of the comparison are made
   the same way, and anyone with too little in the window to score is left
   out rather than averaged in at a number that means nothing. */
function crewOver(pickers, st, from, to, shiftName, minHours, subject, minDays){
  const rows = [];
  const seen = {};
  /* everyone else's day, merged, so the page can ask the question that
     stops a system day being blamed on a person: was this a bad day for
     them, or a bad day for the floor? */
  const perDay = {};
  for(let i = 0; i < LOOKBACK; i++){
    const key = keyBack(to, i);
    if(key < from) break;
    const entry = pickers.history[key];
    if(!entry || !entry.pickers) continue;
    const shape = entry.shape || schedule.dayShape(st.sched, key);
    for(const who in entry.pickers){
      if(who === subject) continue;
      if(st.hide.indexOf(who.toUpperCase()) >= 0) continue;
      const r = recOf(entry, who, shiftName);
      if(!r || (r.activeHours || 0) < minHours) continue;
      (seen[who] = seen[who] || []).push({ key, r, worked: workedHours(r, shape) });
      (perDay[key] = perDay[key] || []).push({ key, r, worked: workedHours(r, shape) });
    }
  }
  for(const who in seen){
    const list = seen[who];
    if(list.length < minDays) continue;
    const s = stat(who, list, st);
    if(!s || s.picks < st.minPicks) continue;
    rows.push({ pct: s.pct, rate: s.rate, prod: s.prod, days: s.days });
  }
  /* The crew's day is everyone's picks against everyone's expected, not an
     average of percentages: a person who picked for twenty minutes should
     not weigh the same as one who picked all day. */
  const byDay = {};
  for(const key in perDay){
    const list = perDay[key];
    if(list.length < 3) continue;          // too few to call it "the floor"
    const s = stat('crew', list, st);
    if(s && s.pct != null) byDay[key] = { pct: s.pct, people: list.length };
  }
  return { rows, byDay };
}

function review(pickers, who, todayKey, opt){
  opt = opt || {};
  const st = pickers.settings();
  if(!who || st.hide.indexOf(String(who).toUpperCase()) >= 0) return null;
  /* settings first, then the query, so a supervisor can try a different
     floor on one review without changing it for everybody */
  const rv = Object.assign({ windows: WINDOWS, minHours: DEFAULT_MIN_HOURS, capProd: true, peerMinShare: 34 },
                           st.review || {});
  const wins = (rv.windows && rv.windows.length) ? rv.windows : WINDOWS;
  const minHours = opt.minHours != null && isFinite(+opt.minHours) ? Math.max(0, +opt.minHours)
                 : (isFinite(+rv.minHours) ? Math.max(0, +rv.minHours) : DEFAULT_MIN_HOURS);

  /* the shift is the subject's own unless the page says otherwise; "all"
     means do not split the day up at all */
  const asked = opt.shiftName == null ? undefined : opt.shiftName;
  const shiftName = asked === undefined ? usualShift(pickers, who, todayKey, st) : (asked || null);

  let all = daysFor(pickers, who, todayKey, st, shiftName, minHours);
  /* A shift this person has no records under leaves the review empty for a
     reason nobody would guess, so fall back to the whole day and say so. */
  let shiftFellBack = false;
  if(!all.length && shiftName){
    all = daysFor(pickers, who, todayKey, st, null, minHours);
    if(all.length) shiftFellBack = true;
  }
  if(!all.length) return null;

  const worked = all.filter(d => d.counts);
  /* Records, but not one of them a picking day. "No days on file" would be
     a lie and would read as a broken tool; this is a floor doing its job on
     somebody who only ever covered for an hour, and the way out of it is a
     setting rather than a bug report. */
  if(!worked.length) return {
    who, empty: 'belowFloor', minHours, acts: rv.acts || {},
    seen: all.slice(0, 6).map(d => ({ key: d.key, picks: d.r.total, hours: round(d.r.activeHours || 0, 2),
                                      other: d.r.other || null, otherHours: round(d.r.otherHours || 0, 2) })),
    /* what they were doing instead, over everything on file */
    instead: (() => {
      const o = {}; let h = 0;
      all.forEach(d => { h += d.r.otherHours || 0; for(const k in (d.r.other || {})) o[k] = (o[k] || 0) + d.r.other[k]; });
      return Object.keys(o).length ? { acts: o, hours: round(h, 2) } : null;
    })(),
    seenCount: all.length
  };
  const windows = wins.map(n => {
    const list = worked.slice(0, n);
    const s = list.length ? stat(who, list, st) : null;
    return Object.assign({ n, has: !!s, full: list.length >= n,
                           from: list.length ? list[list.length - 1].key : null,
                           to: list.length ? list[0].key : null }, s || {});
  });

  /* the window the rest of the page details */
  /* the window asked for if it is one of the four, else the middle one */
  const want = wins.indexOf(+opt.days) >= 0 ? +opt.days : (wins[Math.min(1, wins.length - 1)] || wins[0]);
  const list = worked.slice(0, want);
  if(!list.length) return null;
  const from = list[list.length - 1].key, to = list[0].key;
  const period = Object.assign({ n: want, full: list.length >= want, from, to }, stat(who, list, st));

  /* day by day, oldest first, so it reads left to right like a calendar */
  const byDay = list.slice().reverse().map(d => {
    const s = stat(who, [d], st);
    return { key: d.key, picks: s.picks, lines: s.lines, hours: s.hours, worked: s.worked,
             rate: s.rate, pct: s.pct, prod: s.prod,
             /* what the standard asked of THAT day: the hours they were on
                it, at the standard for the work they were given. A short
                day asks for less, which is the only way a bar of picks can
                be read without punishing somebody for a half shift. */
             expected: s.expected };
  });

  /* Steady or swinging. A person at 94 every day and a person averaging 94
     between 70 and 120 are the same number and not the same conversation,
     and nothing on any of these screens has ever said which one somebody
     is. */
  const pcts = byDay.map(d => d.pct).filter(x => x != null);
  const avgPct = mean(pcts);
  const sdPct = pcts.length >= 2 ? Math.sqrt(mean(pcts.map(x => Math.pow(x - avgPct, 2)))) : 0;
  const consistency = pcts.length >= 2 ? {
    best: Math.max.apply(null, pcts), worst: Math.min.apply(null, pcts),
    spread: Math.max.apply(null, pcts) - Math.min.apply(null, pcts),
    /* population deviation: this is all of the days, not a sample of them */
    sd: Math.round(sdPct),
    mean: Math.round(avgPct),
    /* Two deviations either side of their own average. A day inside this is
       the ordinary scatter of doing the job and has no story in it; a day
       outside has a reason, and the reason is findable. Colouring every day
       under the standard red points a supervisor at forty days; this points
       at the two worth asking about. Needs enough days to mean anything. */
    limits: pcts.length >= 5
      ? { lo: Math.round(avgPct - 2 * sdPct), hi: Math.round(avgPct + 2 * sdPct) } : null,
    /* the smallest difference worth discussing: inside one deviation is
       their own day-to-day scatter, not a change in anything */
    noise: Math.max(1, Math.round(sdPct))
  } : null;

  /* Early half against late half of the same window. Not a line of best fit:
     a supervisor needs "better than it was" or "worse than it was", and half
     against half is the version that can be checked by eye on the chart
     underneath it. */
  let trend = null;
  if(pcts.length >= 4){
    const h = Math.floor(pcts.length / 2);
    const early = mean(pcts.slice(0, h)), late = mean(pcts.slice(pcts.length - h));
    const d = Math.round(late - early);
    /* A line through random scatter is still a line, and people read it as
       a decline. The difference between two halves of n days is only worth
       a word when it is bigger than the scatter would produce on its own:
       the standard error of that difference is sd x sqrt(4/n), and two of
       those is the usual bar. Below it the honest answer is "no change I
       can see", which is a finding, not a failure to find one. */
    const se = sdPct * Math.sqrt(4 / pcts.length);
    const bar = Math.max(2, Math.round(2 * se));
    const real = Math.abs(d) >= bar;
    trend = { early: Math.round(early), late: Math.round(late), change: d,
              bar, real,
              word: !real ? 'no change worth calling' : d > 0 ? 'improving' : 'slipping' };
  }

  /* the crew, over the same dates, by the same rules */
  const minDays = Math.max(1, Math.round(list.length * (rv.peerMinShare / 100)));
  const crewAll = crewOver(pickers, st, from, to, shiftName, minHours, who, minDays);
  const peers = crewAll.rows;
  const pctList = peers.map(p => p.pct).filter(x => x != null);
  const rateList = peers.map(p => p.rate).filter(x => x != null);
  const better = (arr, v) => (v == null || !arr.length) ? null : arr.filter(x => x > v).length + 1;
  /* mark the days that are outside the person's own ordinary range, and
     hang the crew's day beside each one */
  if(consistency && consistency.limits){
    byDay.forEach(d => {
      if(d.pct == null) return;
      d.out = d.pct > consistency.limits.hi ? 'high' : d.pct < consistency.limits.lo ? 'low' : null;
    });
  }
  byDay.forEach(d => { const c = crewAll.byDay[d.key]; if(c) d.crewPct = c.pct; });

  const crew = {
    n: peers.length + 1, shift: shiftName, from, to,
    byDay: crewAll.byDay,
    /* anonymous on purpose: the subject is the only person named on a page
       that is pointed at the subject */
    pcts: pctList.slice().sort((a, b) => a - b),
    rates: rateList.slice().sort((a, b) => a - b),
    pctMean: pctList.length ? Math.round(mean(pctList)) : null,
    pctMedian: pctList.length ? Math.round(median(pctList)) : null,
    rateMean: rateList.length ? round(mean(rateList), 1) : null,
    rateMedian: rateList.length ? round(median(rateList), 1) : null,
    prodMean: peers.length ? Math.round(mean(peers.map(p => p.prod).filter(x => x != null))) : null,
    rankPct: better(pctList, period.pct),
    rankRate: better(rateList, period.rate)
  };

  /* What to say out loud before quoting any of the above. Each one is a
     reason a number on this page might not mean what it looks like. */
  const notes = [];
  const span = [];
  for(let i = 0; ; i++){
    const k = keyBack(to, i);
    if(k < from) break;
    span.push(k);
  }
  const dropped = all.filter(d => !d.counts && d.key >= from && d.key <= to);
  if(dropped.length) notes.push({ kind: 'dropped',
    text: dropped.length + ' day' + (dropped.length === 1 ? '' : 's') + ' in this stretch had under ' +
          minHours + ' hours of picking and ' + (dropped.length === 1 ? 'is' : 'are') +
          ' left out - usually a day mostly spent on another job',
    days: dropped.map(d => ({ key: d.key, picks: d.r.total, hours: round(d.r.activeHours || 0, 2) })) });
  if(!period.full) notes.push({ kind: 'short',
    text: 'only ' + list.length + ' picking day' + (list.length === 1 ? '' : 's') + ' on file, not ' + want +
          '. The window is as long as the records go.' });
  /* a line key that changed mid-window means a pick stopped meaning what it
     meant, and the two halves are not the same measurement */
  const keys = {};
  list.forEach(d => { keys[(d.lineKey || []).join(',')] = true; });
  if(Object.keys(keys).length > 1) notes.push({ kind: 'linekey',
    text: 'the line setting changed during this stretch, so the earlier days and the later days ' +
          'are not counting the same thing. Treat the comparison carefully.' });
  if(crew.n < 5) notes.push({ kind: 'thin',
    text: 'only ' + crew.n + ' picker' + (crew.n === 1 ? '' : 's') + ' in this comparison, which is too few for ' +
          'an average to mean much. The standard still does.' });
  if(shiftFellBack) notes.push({ kind: 'shift',
    text: 'no records under a single shift for this person, so the whole day is used.' });

  return {
    who, today: todayKey, shiftName, shiftFellBack,
    minHours, windows, period, byDay, consistency, trend, crew, notes, capProd: rv.capProd !== false,
    dayHours: st.dayHours, shiftHours: st.shiftHours, prodFloor: st.prodFloor, windowMin: st.windowMin,
    bands: st.bands,
    acts: rv.acts || {},
    targetsText: st.targetsText,
    spanDays: span.length, offDays: span.length - list.length - dropped.length
  };
}

module.exports = { review, WINDOWS, DEFAULT_MIN_HOURS };
