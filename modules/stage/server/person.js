'use strict';
/* One person, over everything on file.

   The picker report answers "how did everyone do over this period". This
   answers the other question a supervisor asks - "how is Ann doing" - which
   is not one period but several at once: yesterday, last week, this month
   against the months before it, the year. All of it comes off the same daily
   rollup (pickers/history.json), grouped differently.

   Every figure here is the same arithmetic as the picker page - score() in
   pickers.js - applied to a different set of days, so a month here and a
   month on the Months gallery agree, and a day here is the day on the
   picker page. Nothing is computed a second way.

   Two things are new:

   - Worked hours, beside active hours. The app cannot see a clock-in; what it
     can see is the first and last confirmation of the day. Worked is that
     span with the scheduled breaks taken out, and is never less than the
     active time inside it. Active is the credited time the rates are built
     on. The gap between them is time on the floor that was not picking.

   - The year, with the months SAP could not give us filled in. The task
     export only reaches back so far, so a person's year is usually eight or
     nine real months and a hole. The hole is filled with that person's own
     to-date average and marked as an estimate, so the year reads as a year
     rather than as a broken bar chart - and the estimate is theirs, not the
     crew's. */
const model = require('./model');
const schedule = require('./schedule');
const { score, round } = require('./pickers');

const LOOKBACK = 400;      // days searched, which is the history cap

function keyBack(todayKey, i){
  const d = new Date(todayKey + 'T12:00:00');
  d.setDate(d.getDate() - i);
  return model.dayKey(d);
}
const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : 0;
const sum = a => a.reduce((t, x) => t + (x || 0), 0);

/* first pick to last pick, with the breaks that fell inside taken out; never
   less than the active time, which by construction sits inside it */
function workedHours(r, shape){
  const act = r.activeHours || 0;
  if(r.firstH == null || r.lastH == null || r.lastH <= r.firstH) return act;
  let span = r.lastH - r.firstH;
  for(const [a, b] of ((shape && shape.breaks) || [])){
    const lo = Math.max(a, r.firstH), hi = Math.min(b, r.lastH);
    if(hi > lo) span -= (hi - lo);
  }
  return Math.max(span, act);
}

/* the same merge the picker report does across days, so the two agree */
function mergeDays(who, list){
  const m = { who, total: 0, lines: 0, byArea: {}, areaHours: {}, activeHours: 0, days: 0, firstH: null, lastH: null, worked: 0 };
  for(const d of list){
    const r = d.r;
    m.total += r.total;
    m.lines += (r.lines == null ? r.total : r.lines);
    m.activeHours += r.activeHours || 0;
    m.days++;
    m.worked += d.worked;
    const rah = r.areaHours || null;
    for(const a in (r.byArea || {})){
      m.byArea[a] = (m.byArea[a] || 0) + r.byArea[a];
      const h = rah && rah[a] != null ? rah[a] : (r.activeHours || 0) * (r.byArea[a] / Math.max(1, r.total));
      m.areaHours[a] = (m.areaHours[a] || 0) + h;
    }
  }
  return m;
}

/* What the paid hours went on. The shift is bought whole; only some of it
   can be spent picking. Breaks and setting up are allowed for - the
   difference between the paid shift and the true picking hours, an hour and
   a half by default - and what is left over is down time nothing accounts
   for. That last figure is the one worth looking at, and it has never had a
   name on any screen before. */
function shiftSplit(days, active, st){
  const allowPer = Math.max(0, st.shiftHours - st.dayHours);
  const paid = days * st.shiftHours;
  const allowance = days * allowPer;
  const picking = Math.min(active, Math.max(0, paid - allowance));
  return {
    paid: round(paid, 2), allowance: round(allowance, 2), picking: round(picking, 2),
    down: round(Math.max(0, paid - allowance - picking), 2),
    perDay: days ? { paid: round(st.shiftHours, 2), allowance: round(allowPer, 2), picking: round(picking / days, 2), down: round(Math.max(0, paid - allowance - picking) / days, 2) } : null,
    prod: days ? Math.min(100, Math.round(active / (days * st.dayHours) * 100)) : null
  };
}

function stat(who, list, st){
  if(!list.length) return null;
  const m = mergeDays(who, list);
  const s = score(m, st.targets, st.windowMin);
  return {
    picks: s.total, lines: s.lines, hours: s.activeHours, worked: round(m.worked, 2), days: s.days,
    rate: s.rate, lineRate: s.lineRate, pct: s.pct, expected: s.expected,
    shift: shiftSplit(s.days, s.activeHours, st),
    byArea: s.byArea, areaStat: s.areaStat
  };
}

function person(pickers, who, todayKey, opt){
  opt = opt || {};
  const st = pickers.settings();
  const shiftName = opt.shiftName || null;
  const days = Math.max(1, Math.min(LOOKBACK, opt.days || 30));
  if(!who || st.hide.indexOf(String(who).toUpperCase()) >= 0) return null;

  /* every day this person has a record for, newest first */
  const all = [];
  for(let i = 0; i < LOOKBACK; i++){
    const key = keyBack(todayKey, i);
    const e = pickers.history[key];
    if(!e || !e.pickers) continue;
    const whole = e.pickers[who];
    if(!whole) continue;
    const r = shiftName ? (whole.shifts && whole.shifts[shiftName]) : whole;
    if(!r || !r.total) continue;
    const shape = e.shape || schedule.dayShape(st.sched, key);
    all.push({ key, r, worked: workedHours(r, shape) });
  }
  if(!all.length) return null;
  const S = list => stat(who, list, st);
  const toDate = S(all);

  /* the last twelve months, this one included */
  const [ty, tm] = todayKey.split('-').map(Number);
  const months = [];
  for(let i = 11; i >= 0; i--){
    let y = ty, mo = tm - i;
    while(mo < 1){ mo += 12; y--; }
    const key = y + '-' + String(mo).padStart(2, '0');
    const s = S(all.filter(d => d.key.slice(0, 7) === key));
    months.push(Object.assign({ key, label: new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'short' }) + (mo === 1 || i === 11 ? ' ' + String(y).slice(2) : ''),
                                has: !!s, est: false }, s || {}));
  }

  /* the year: the same twelve, with the holes filled from this person's own
     average month. The rate and the percentage are theirs to date - which is
     the honest estimate of what a missing month would have read - and the
     volume is their average month's. */
  const real = months.filter(m => m.has);
  const avg = real.length ? {
    picks: Math.round(mean(real.map(m => m.picks))), lines: Math.round(mean(real.map(m => m.lines))),
    hours: round(mean(real.map(m => m.hours)), 1), worked: round(mean(real.map(m => m.worked)), 1),
    days: Math.round(mean(real.map(m => m.days))), rate: toDate.rate, lineRate: toDate.lineRate, pct: toDate.pct
  } : null;
  if(avg) avg.shift = shiftSplit(avg.days, avg.hours, st);
  const year = months.map(m => m.has ? m : Object.assign({ key: m.key, label: m.label, has: false, est: true }, avg || {}));
  const yearTotal = {
    picks: sum(year.map(m => m.picks)), lines: sum(year.map(m => m.lines)), hours: round(sum(year.map(m => m.hours)), 1),
    worked: round(sum(year.map(m => m.worked)), 1), days: sum(year.map(m => m.days)),
    rate: toDate.rate, pct: toDate.pct, realMonths: real.length, estMonths: 12 - real.length
  };

  /* last week is the calendar week before this one, Monday to Sunday, which
     is the week the report went out for */
  const t = new Date(todayKey + 'T12:00:00');
  const dow = (t.getDay() + 6) % 7;                 // Monday = 0
  const thisMon = new Date(t); thisMon.setDate(t.getDate() - dow);
  const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7);
  const lastSun = new Date(thisMon); lastSun.setDate(thisMon.getDate() - 1);
  const wk = { from: model.dayKey(lastMon), to: model.dayKey(lastSun) };
  const lastWeek = Object.assign({ from: wk.from, to: wk.to }, S(all.filter(d => d.key >= wk.from && d.key <= wk.to)) || { has: false });
  lastWeek.has = lastWeek.picks > 0;
  const tw = { from: model.dayKey(thisMon), to: todayKey };
  const thisWeek = Object.assign({ from: tw.from, to: tw.to }, S(all.filter(d => d.key >= tw.from && d.key <= tw.to)) || {});
  thisWeek.has = thisWeek.picks > 0;

  /* yesterday, and if they did not pick yesterday, the last day they did */
  const yKey = keyBack(todayKey, 1);
  const yRec = all.find(d => d.key === yKey);
  const yesterday = Object.assign({ key: yKey, has: !!yRec, lastDay: all[0].key }, yRec ? S([yRec]) : {});

  /* the page's own period, for the area breakdown and the day-by-day */
  const inPeriod = new Set();
  for(let i = 0; i < days; i++) inPeriod.add(keyBack(todayKey, i));
  const pList = all.filter(d => inPeriod.has(d.key));
  /* window is the span asked for; days (from the stat) is how many of them they picked on */
  const period = Object.assign({ window: days, from: keyBack(todayKey, days - 1), to: todayKey, has: pList.length > 0 }, S(pList) || {});
  const byDay = pList.slice().reverse().map(d => {
    const s = S([d]);
    return { key: d.key, picks: s.picks, lines: s.lines, hours: s.hours, worked: s.worked, rate: s.rate, pct: s.pct, shift: s.shift };
  });

  return {
    who, today: todayKey, shiftName, dayHours: st.dayHours, shiftHours: st.shiftHours, prodFloor: st.prodFloor,
    bands: st.bands,
    toDate: Object.assign({ from: all[all.length - 1].key, to: all[0].key }, toDate),
    months, year, yearTotal, lastWeek, thisWeek, yesterday, period, byDay
  };
}

module.exports = { person, workedHours };
