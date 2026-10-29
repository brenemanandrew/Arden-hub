'use strict';
/* Picker performance.
   One confirmed warehouse task = one pick. A person's bar is the picks they
   confirmed, stacked by the area the pick came from, because the mix of work
   explains most of the gap between two people. The target marker is what
   those hours should have produced at the per-area target rates, so a fast
   person on slow work is not punished for it.

   Time worked is "active time": every confirmation counts the person as
   working for the next N minutes (30 by default, the convention the old
   board used). Overlapping windows are merged, so a steady picker gets one
   continuous stretch and someone pulled onto another job for two hours is
   not charged for the gap.

   Today comes from the warehouse task export, which only ever covers today.
   Week and month come from a daily rollup this file keeps, so those views
   fill from the day the feature goes live rather than reaching backwards. */
const fs = require('fs');
const path = require('path');
const model = require('./model');
const { DEFAULT_WT_AREAS } = require('./board');

const schedule = require('./schedule');
const { DEFAULT_TARGETS, parseTargets, targetFor } = model;
const HISTORY_DAYS = 400;
const { DEFAULT_SCHEDULE } = schedule;
const MIN_HOURS = 0.25;   // floor, so three picks in five minutes cannot show a wild rate

/* The merged active windows, as [start, end] pairs in hours. Keeping the
   windows rather than just their total lets the activity view show when
   somebody actually picked, which is usually the answer to "why is this
   rate so low". */
function activeWindows(times, windowMin){
  if(!times || !times.length) return [];
  const w = Math.max(1, windowMin || 30) / 60;
  const t = times.slice().sort((a, b) => a - b);
  const out = [];
  let start = null, end = null;
  for(const x of t){
    if(start === null){ start = x; end = x + w; }
    else if(x <= end){ end = Math.max(end, x + w); }
    else { out.push([start, end]); start = x; end = x + w; }
  }
  if(start !== null) out.push([start, end]);
  return out.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
}
function activeHours(times, windowMin){
  return activeWindows(times, windowMin).reduce((t, [a, b]) => t + (b - a), 0);
}
/* Hours spent in each area. Every confirmation owns the clock from its own
   time until the next confirmation, capped at the active window, so the
   hours sum to exactly the person's active time and no minute is counted
   twice. A batch confirmed in the same minute therefore shares the gap that
   follows it, which is the honest reading: those picks took that long.
   Because these hours are exact, the per-area percentages below average
   back to the person's overall percentage when weighted by hours. */
function areaHours(evt, windowMin, blocked){
  const w = Math.max(1, windowMin || 30) / 60;
  const e = (evt || []).slice().sort((a, b) => a[0] - b[0]);
  const out = {};
  for(let i = 0; i < e.length; i++){
    const [t, a] = e[i];
    const end = Math.min(t + w, i + 1 < e.length ? Math.max(t, e[i + 1][0]) : Infinity);
    out[a] = (out[a] || 0) + Math.max(0, end - t - overlap(t, end, blocked));
  }
  for(const a in out) out[a] = Math.round(out[a] * 1000) / 1000;
  return out;
}
function round(n, d){ const m = Math.pow(10, d == null ? 1 : d); return Math.round(n * m) / m; }

/* ---- time the building is not working ----
   Closed hours and breaks are taken out of active time, so a picker whose
   last confirmation was at 12:14 is not still "working" through lunch, and
   nobody is credited with the small hours. Rules are kept as hours of the
   week (0 = Sunday midnight) and turned into a list of blocked [from, to]
   hours for whichever day is being scored. */
/* what the old settings did is now dayShape() in schedule.js; these stay
   for the one thing the schedule does not do, taking blocked time out of
   a list of windows */
const DAYS_UNUSED = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function dayIdx(s){ return DAYS.indexOf(String(s || '').slice(0, 3).toLowerCase()); }
function daysIn(spec){
  const out = [];
  String(spec).split(',').forEach(part => {
    const m = /^\s*([a-z]{3})[a-z]*\s*(?:-\s*([a-z]{3})[a-z]*)?\s*$/i.exec(part);
    if(!m) return;
    const a = dayIdx(m[1]), b = m[2] ? dayIdx(m[2]) : a;
    if(a < 0 || b < 0) return;
    for(let d = a; ; d = (d + 1) % 7){ out.push(d); if(d === b) break; }
  });
  return out;
}
function parseClosed(text){
  const out = [];
  String(text == null ? '' : text).split('\n').forEach(line => {
    const l = line.trim();
    if(!l) return;
    // "Sat 18:00 - Mon 06:00": one span across days
    let m = /^([a-z]{3})[a-z]*\s+(\d{1,2}):(\d{2})\s*-\s*([a-z]{3})[a-z]*\s+(\d{1,2}):(\d{2})$/i.exec(l);
    if(m){
      const a = dayIdx(m[1]) * 24 + (+m[2]) + (+m[3]) / 60;
      let b = dayIdx(m[4]) * 24 + (+m[5]) + (+m[6]) / 60;
      if(dayIdx(m[1]) < 0 || dayIdx(m[4]) < 0) return;
      if(b <= a) b += 168;
      out.push([a, b]);
      return;
    }
    // "Mon-Sat 01:15-06:00": the same hours on each of those days
    m = /^([a-z ,\-]+?)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/i.exec(l);
    if(m){
      const h1 = (+m[2]) + (+m[3]) / 60, h2 = (+m[4]) + (+m[5]) / 60;
      daysIn(m[1]).forEach(d => out.push([d * 24 + h1, d * 24 + (h2 <= h1 ? h2 + 24 : h2)]));
    }
  });
  return out;
}
/* "2:00=15, 4:00=30, 6:00=15": hours after the shift starts, minutes long */
function parseBreaks(text){
  const out = [];
  const re = /(\d{1,2}):(\d{2})\s*=\s*(\d{1,3})/g;
  let m;
  while((m = re.exec(String(text == null ? '' : text)))) out.push({ off: (+m[1]) + (+m[2]) / 60, min: +m[3] });
  return out;
}
function mergeRanges(list){
  const a = list.filter(x => x[1] > x[0]).sort((x, y) => x[0] - y[0]);
  const out = [];
  a.forEach(([x, y]) => {
    const last = out[out.length - 1];
    if(last && x <= last[1]) last[1] = Math.max(last[1], y); else out.push([x, y]);
  });
  return out.map(([x, y]) => [round(x, 3), round(y, 3)]);
}
/* Blocked hours of one calendar day, 0 to 24: closed stretches and breaks. */
function blockedFor(dayKey, st){ return schedule.dayShape(st.sched, dayKey).blocked; }
function overlap(a, b, blocked){
  let n = 0;
  for(const [x, y] of (blocked || [])){ const lo = Math.max(a, x), hi = Math.min(b, y); if(hi > lo) n += hi - lo; }
  return n;
}
function subtractBlocked(wins, blocked){
  if(!blocked || !blocked.length) return wins;
  const out = [];
  wins.forEach(([a, b]) => {
    let cur = a;
    for(const [x, y] of blocked){
      if(y <= cur || x >= b) continue;
      if(x > cur) out.push([cur, x]);
      cur = Math.max(cur, y);
      if(cur >= b) break;
    }
    if(cur < b) out.push([cur, b]);
  });
  return out.map(([a, b]) => [round(a, 3), round(b, 3)]).filter(([a, b]) => b - a > 0.001);
}

/* The rate and percentage for one slice (a day, or an hour of a day), using
   that slice's own mix of work so the comparison stays fair at any size. */
function sliceScore(picks, lines, hours, byArea, targets){
  const h = Math.max(0.02, hours || 0);
  let expH = 0, targeted = 0;
  for(const a in (byArea || {})){
    const t = targetFor(targets, a);
    if(t > 0){ expH += byArea[a] / t; targeted += byArea[a]; }
  }
  const tRate = expH > 0 ? targeted / expH : 0;
  return {
    picks: picks, lines: lines == null ? picks : lines,
    hours: round(h, 2),
    rate: round(picks / h, 1),
    lineRate: round((lines == null ? picks : lines) / h, 1),
    pct: tRate > 0 ? Math.round((picks / h) / tRate * 100) : null
  };
}

/* One person's numbers from their raw counts. */
function score(rec, targets, windowMin){
  const hours = Math.max(MIN_HOURS, rec.activeHours != null ? rec.activeHours : activeHours(rec.times, windowMin));
  let expectedHours = 0, targeted = 0;
  for(const area in rec.byArea){
    const t = targetFor(targets, area);
    if(t > 0){ expectedHours += rec.byArea[area] / t; targeted += rec.byArea[area]; }
  }
  const rate = rec.total / hours;
  const lines = rec.lines == null ? rec.total : rec.lines;
  // what those same hours should have produced, given the mix of work done
  const targetRate = expectedHours > 0 ? (targeted / expectedHours) : 0;
  const expected = targetRate > 0 ? hours * targetRate : 0;
  /* Each area against its own standard, using the time actually spent
     there. This is what lets a bar say which kind of work a person is
     behind on rather than only that they are behind. */
  const areaStat = {};
  for(const area in rec.byArea){
    const n = rec.byArea[area];
    const t = targetFor(targets, area);
    const ah = (rec.areaHours && rec.areaHours[area] != null)
      ? rec.areaHours[area]
      : hours * (n / Math.max(1, rec.total));   // history written before areaHours existed
    const r = ah > 0 ? n / ah : 0;
    areaStat[area] = {
      picks: n, hours: round(ah, 2), rate: round(r, 1), target: t,
      /* a handful of picks in a couple of minutes is not a rate, so those
         are left without a percentage rather than shown at 900% */
      pct: (t > 0 && ah >= 0.05 && n >= 3) ? Math.round(r / t * 100) : null
    };
  }
  return {
    who: rec.who, total: rec.total, lines: lines, lineRate: round(lines / hours, 1), byArea: rec.byArea,
    areaStat: areaStat,
    activeHours: round(hours, 2), rate: round(rate, 1),
    targetRate: round(targetRate, 1), expected: Math.round(expected),
    pct: expected > 0 ? Math.round(rec.total / expected * 100) : null,
    firstH: rec.firstH == null ? null : round(rec.firstH, 2),
    lastH: rec.lastH == null ? null : round(rec.lastH, 2),
    days: rec.days || 1
  };
}

/* One stored record from one raw one: a day, or one shift of it. Active
   time has the closed hours and breaks taken out, unless that would erase
   most of a real day's work (somebody in on a Sunday), in which case the
   rules are clearly not describing that day and are left aside. */
function buildRec(r, st, blocked){
  const raw = activeWindows(r.times, st.windowMin);
  const rawH = raw.reduce((t, [a, b]) => t + (b - a), 0);
  let win = subtractBlocked(raw, blocked), useBlocked = blocked;
  const cutH = win.reduce((t, [a, b]) => t + (b - a), 0);
  if(r.total >= 10 && cutH < rawH * 0.25){ win = raw; useBlocked = null; }
  /* picks and active minutes per clock hour, so the trend can show how a
     shift actually went rather than one number for the whole day */
  const byHour = {};
  for(const h in r.hourPicks) byHour[h] = { n: r.hourPicks[h], active: 0, lines: (r.hourLines && r.hourLines[h]) || null };
  win.forEach(([a, b]) => {
    for(let h = Math.floor(a); h < b; h++){
      const lo = Math.max(a, h), hi = Math.min(b, h + 1);
      if(hi > lo){ (byHour[h] || (byHour[h] = { n: 0, active: 0, lines: null })).active += (hi - lo); }
    }
  });
  for(const h in byHour) byHour[h].active = round(byHour[h].active, 3);
  /* Time on work that was not picking. The picking windows are taken out of
     it, so the two can be added together without charging a minute twice -
     and so the picking figure every other page rests on does not move by a
     second because of anything here. */
  const oWin = subtractBlocked(subtractBlocked(activeWindows(r.oTimes || [], st.windowMin), useBlocked), win);
  const oH = round(oWin.reduce((t, [a, b]) => t + (b - a), 0), 3);
  const oAct = r.oAct && Object.keys(r.oAct).length ? r.oAct : null;
  return { total: r.total, lines: r.lines, byArea: r.byArea, byHour,
           /* only when there is some, so a day of plain picking costs the
              history file nothing it did not cost before */
           other: oAct, otherHours: oAct ? oH : 0,
           areaHours: areaHours(r.evt, st.windowMin, useBlocked),
           activeHours: round(win.reduce((t, [a, b]) => t + (b - a), 0), 3),
           windows: win, firstH: r.firstH, lastH: r.lastH };
}

const liveShift = (now, sched) => schedule.liveShift(sched, now);

class Pickers {
  constructor(cfg, log){
    this.cfg = cfg;
    this.log = log || (() => {});
    this.dir = path.join(cfg.dataDir, 'pickers');
    this.file = path.join(this.dir, 'history.json');
    this.history = {};    // dayKey -> { at, pickers: { who: { total, byArea, activeHours, firstH, lastH } } }
    this.version = 0;
    this.override = null;   // set on the cloud copy from the host's push
    try{ fs.mkdirSync(this.dir, { recursive: true }); }catch(e){}
    // a byte-order mark would make a restored year look like no year at all
    try{ const t = fs.readFileSync(this.file, 'utf8'); this.history = JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t) || {}; }catch(e){ this.history = {}; }
  }
  settings(){
    const s = this.override || (this.cfg.get().pickers) || {};
    return {
      targets: parseTargets(s.targets || DEFAULT_TARGETS),
      targetsText: s.targets || DEFAULT_TARGETS,
      windowMin: Math.max(5, s.activeMin || 30),
      hide: String(s.hide || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
      minPicks: Math.max(0, s.minPicks || 0),
      dayHours: (s.dayHours != null && isFinite(+s.dayHours) && +s.dayHours > 0) ? +s.dayHours : 6.5,
      /* the whole paid shift. The difference between this and dayHours is
         what breaks and setting up are allowed to cost - 8 less 6.5, so an
         hour and a half - and anything past that is down time with no
         explanation in it. */
      shiftHours: (s.shiftHours != null && isFinite(+s.shiftHours) && +s.shiftHours > 0) ? +s.shiftHours : 8,
      prodFloor: (s.prodFloor != null && isFinite(+s.prodFloor)) ? Math.max(0, Math.min(100, +s.prodFloor)) : 75,
      bands: (() => {
        const b = Object.assign({ good: 95, warn: 85 }, s.bands || {});
        b.good = Math.max(1, +b.good || 95);
        b.warn = Math.min(b.good, Math.max(0, +b.warn || 0));
        return b;
      })(),
      lineKey: String(s.lineKey || '').split(',').map(x => x.trim()).filter(Boolean),
      /* the review page's own settings, defaulted here so a config written
         before they existed still answers */
      review: (() => {
        const rv = Object.assign({ windows: [5, 10, 15, 20], minHours: 2, capProd: true, peerMinShare: 34,
                                   actLabels: '' }, s.review || {});
        /* CODE = label a line, the shape the standards and the area map use.
           Parsed here so the page is handed words rather than a format. */
        rv.acts = {};
        String(rv.actLabels || '').split('\n').forEach(line => {
          const p = line.split('=');
          if(p.length !== 2) return;
          const code = p[0].trim().toUpperCase(), lab = p[1].trim();
          if(code && lab) rv.acts[code] = lab;
        });
        return rv;
      })(),
      scheduleText: schedule.effectiveText(s.schedule),
      sched: schedule.parseSchedule(schedule.effectiveText(s.schedule))
    };
  }
  save(){
    /* A backfill writes a year of days one at a time. Rewriting a growing
       history file on each of them is gigabytes of writing for a file only
       the last version of matters, so it can be held and flushed once a
       slice instead. */
    if(this.held){ this.dirty = true; return; }
    this.dirty = false;
    /* written beside itself and moved into place: a rename is atomic, so a
       copy that is stopped mid-save leaves the old history whole rather than
       half a file that will not parse */
    try{
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.history));
      fs.renameSync(tmp, this.file);
    }
    catch(e){ this.log('pickers: could not save history: ' + e.message); }
  }
  holdSave(on){ this.held = !!on; if(!on) this.save(); }
  flushSave(){ if(this.dirty){ const h = this.held; this.held = false; this.save(); this.held = h; } }
  /* Called after every task export read. Replaces today's entry, because the
     export is a full picture of today rather than a delta. */
  observe(rows, todayKey, areaMapText){
    if(!rows) return false;
    const st = this.settings();
    const areaMap = String(areaMapText || '').trim() || DEFAULT_WT_AREAS;
    let raw;
    try{ raw = model.computePickers(rows, areaMap, todayKey, st.lineKey, h => schedule.shiftAt(st.sched, todayKey, h).name); }
    catch(e){ return false; }
    if(!raw || !Object.keys(raw).length) return false;
    const shape = schedule.dayShape(st.sched, todayKey);
    const blocked = shape.blocked;
    const day = {}, others = {};
    for(const who in raw){
      const r = raw[who];
      const rec = buildRec(r, st, blocked);
      if(r.shifts){
        rec.shifts = {};
        for(const k in r.shifts) rec.shifts[k] = buildRec(r.shifts[k], st, blocked);
      }
      /* Somebody who confirmed nothing but internal moves is not a picker
         having a bad day, and must not arrive on the picker board as one at
         a rate of nought. They are kept beside it instead, where the review
         can find them and say what they were doing. */
      (rec.total > 0 ? day : others)[who] = rec;
    }
    this.history[todayKey] = { at: Date.now(), pickers: day, others, blocked, shape: { working: shape.working, breaks: shape.breaks, closed: shape.closed, setup: shape.setup, wrap: shape.wrap },
                               columns: model.taskColumns(rows), lineKey: st.lineKey };
    // keep the file from growing without limit
    const keys = Object.keys(this.history).sort();
    while(keys.length > HISTORY_DAYS) delete this.history[keys.shift()];
    this.version++;
    this.save();
    return true;
  }
  /* Same as observe, but a day already on file is only replaced when the
     new rows hold more picks for it. The one-time backfill reads a wide
     window that can miss the tail of a day, and a live pull that watched
     the whole day is the better record. */
  /* Whether an entry carries non-pick work at all. A day filed before the
     app kept it has no key for it anywhere; one filed since has the key on
     every record, null when there was none. */
  static carriesOther(e){
    for(const map of [(e && e.pickers) || {}, (e && e.others) || {}])
      for(const w in map) if('other' in map[w]) return true;
    return false;
  }
  /* Picks filed against a day, whoever read it. */
  static totalPicks(e){
    let n = 0;
    for(const w in ((e && e.pickers) || {})) n += e.pickers[w].total || 0;
    return n;
  }
  /* Which of two readings of the same day to keep. One rule, used by the
     live pull re-reading a day and by a history collected on another PC
     being imported, so the two can never drift apart:

       more picks wins outright - a short read has lost rows to retention
       equal picks, and the one on file carries work that was not picking
         while the new one does not - keep what is on file
       otherwise the new one goes in */
  static keepExisting(before, fresh){
    if(!before) return false;
    const had = Pickers.totalPicks(before), got = Pickers.totalPicks(fresh);
    return had > got || (had === got && Pickers.carriesOther(before) && !Pickers.carriesOther(fresh));
  }
  /* A day map collected somewhere else, merged in. The point of it is a
     backfill that ran on a different PC against its own SAP session, so
     this one never had to stop driving its own and the board never went
     stale for three hours. */
  importDays(map, log){
    const say = log || (() => {});
    const rep = { days: 0, added: 0, improved: 0, kept: 0, skipped: 0, from: null, to: null };
    const keys = Object.keys(map || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    for(const k of keys){
      const inc = map[k];
      /* a day that is not a day is not written over a day that is */
      if(!inc || typeof inc !== 'object' || !inc.pickers || typeof inc.pickers !== 'object'){ rep.skipped++; continue; }
      let ok = true;
      for(const w in inc.pickers){
        const r = inc.pickers[w];
        if(!r || typeof r !== 'object' || !isFinite(+r.total)){ ok = false; break; }
      }
      if(!ok){ rep.skipped++; say('import: ' + k + ' is malformed and was left alone', 'warn'); continue; }
      rep.days++;
      if(!rep.from || k < rep.from) rep.from = k;
      if(!rep.to || k > rep.to) rep.to = k;
      const before = this.history[k] || null;
      if(Pickers.keepExisting(before, inc)){ rep.kept++; continue; }
      this.history[k] = inc;
      if(before) rep.improved++; else rep.added++;
    }
    if(rep.added || rep.improved){
      const all = Object.keys(this.history).sort();
      while(all.length > HISTORY_DAYS) delete this.history[all.shift()];
      this.version++;
      this.save();
    }
    say('import: ' + rep.added + ' day(s) new, ' + rep.improved + ' improved, ' +
        rep.kept + ' already better here' + (rep.skipped ? ', ' + rep.skipped + ' skipped' : ''));
    return rep;
  }
  observeIfBetter(rows, dayKey, areaMapText){
    const before = this.history[dayKey] || null;
    const had = Pickers.totalPicks(before);
    if(!this.observe(rows, dayKey, areaMapText)) return { day: dayKey, wrote: false, picks: 0, had, note: 'nothing confirmed' };
    const fresh = this.history[dayKey];
    const got = Pickers.totalPicks(fresh);
    /* The old test was "as many picks as before, so keep what is on file",
       which was right when picks were the only thing a day held. They are
       not any more: a day re-read since the app started keeping work that
       was not picking carries that too, and refusing it on equal picks is
       how a backfill runs for an hour and changes nothing. So an equal day
       wins when it brings the non-pick work and the one on file does not.
       Strictly more picks still wins outright - a short re-export of an old
       day has lost rows, and its non-pick work is just as short, so taking
       it would understate the work and overstate the time nothing accounts
       for, which on a review is the wrong way round to be wrong. */
    if(Pickers.keepExisting(before, fresh)){
      this.history[dayKey] = before;      // put the fuller record back
      this.save();
      return { day: dayKey, wrote: false, picks: got, had, note: 'kept the record already on file' };
    }
    const gained = before && had === got && !Pickers.carriesOther(before) && Pickers.carriesOther(fresh);
    return { day: dayKey, wrote: true, picks: got, had,
             note: gained ? 'filled in the work that was not picking' : (had ? 'replaced ' + had + ' picks' : '') };
  }

  /* days = 1 for today, 7 and 30 for the rolling views. */
  /* What each area usually produces an hour per picker, over the days
     already recorded, today left out. A standard is where the floor is
     going; a shift can only be won against what the floor has been doing,
     so the board shows today against both. Median across days, so one wild
     day cannot move it, and the same per-area hours the report uses. */
  areaUsual(days, todayKey){
    const st = this.settings();
    const seen = {};
    const base = new Date(todayKey + 'T12:00:00');
    for(let i = 1; i <= Math.max(1, days); i++){
      const e = this.history[model.dayKey(new Date(base.getTime() - i * 86400000))];
      if(!e || !e.pickers) continue;
      const picks = {}, hours = {};
      for(const who in e.pickers){
        if(st.hide.indexOf(who.toUpperCase()) >= 0) continue;
        const r = e.pickers[who], ah = r.areaHours || null;
        for(const a in (r.byArea || {})){
          const n = r.byArea[a];
          const h = (ah && ah[a] != null) ? ah[a] : (r.activeHours || 0) * (n / Math.max(1, r.total));
          if(!(h > 0)) continue;
          picks[a] = (picks[a] || 0) + n; hours[a] = (hours[a] || 0) + h;
        }
      }
      // a day counts for an area once it has enough of it to be evidence
      for(const a in picks) if(hours[a] >= 0.5 && picks[a] >= 10) (seen[a] = seen[a] || []).push(picks[a] / hours[a]);
    }
    const out = {};
    for(const a in seen){
      const v = seen[a].sort((x, y) => x - y);
      out[a] = { rate: round(v[Math.floor(v.length / 2)], 1), days: v.length };
    }
    return out;
  }
  /* The marks for the window the report just covered, with the same day
     offsets, so a shift that began last night lays out as one stretch. Only
     worth sending for a single day: over a range the strip draws a typical
     day instead, and the export only reaches back a few days anyway. */
  marks(rows, todayKey, opt){
    if(!rows) return null;
    const st = this.settings();
    const live = (opt && opt.shift === 'live') ? liveShift(opt.now || new Date(), st.sched) : null;
    const want = {};
    if(live) live.keys.forEach(k => { want[k] = live.offset[k] || 0; });
    else want[todayKey] = 0;
    const out = {};
    for(const k in want){
      const m = model.pickMarks(rows, k);
      if(!m) continue;
      for(const who in m){
        if(st.hide.indexOf(who.toUpperCase()) >= 0) continue;
        const list = out[who] = out[who] || [];
        m[who].forEach(pair => list.push([pair[0] + want[k] * 60, pair[1]]));
      }
    }
    for(const who in out) out[who].sort((a, b) => a[0] - b[0]);
    return Object.keys(out).length ? out : null;
  }
  report(days, todayKey, opt){
    const st = this.settings();
    opt = opt || {};
    /* the live view: the shift that is on now, from its own records, laid
       out as one stretch of hours even when it began yesterday */
    const live = opt.shift === 'live' ? liveShift(opt.now || new Date(), st.sched) : null;
    /* a named shift over a range: each day contributes that shift's own
       records, and a one-day view is clipped to that shift's hours */
    const shiftName = (!live && opt.shiftName) ? String(opt.shiftName) : null;
    const want = [];
    if(live){ live.keys.forEach(k => want.push(k)); days = 1; }
    else {
      const base = new Date(todayKey + 'T12:00:00');
      for(let i = 0; i < Math.max(1, days); i++){
        const d = new Date(base.getTime() - i * 86400000);
        want.push(model.dayKey(d));
      }
    }
    const merged = {}, byDay = {}, areaSeen = {};
    let daysWithData = 0;
    const blocked = [], breaks = [], working = [], setup = [];
    want.forEach(k => {
      const entry = this.history[k];
      if(!entry || !entry.pickers) return;
      const off = live ? (live.offset[k] || 0) : 0;
      if(days === 1){
        const sh = entry.shape || schedule.dayShape(st.sched, k);
        /* a live view covers its own shift's window, not the whole day's; so
           does a named shift */
        const named = shiftName ? ((sh.shifts || []).find(x => x.name === shiftName) || null) : null;
        const win = live ? { start: live.start, end: live.end } : (named ? { start: named.start, end: named.end } : null);
        const within = ([a, b]) => !win || (b + off > win.start && a + off < win.end);
        const clipTo = ([a, b]) => win ? [Math.max(a + off, win.start), Math.min(b + off, win.end)] : [a + off, b + off];
        (sh.blocked || entry.blocked || []).filter(within).forEach(r => blocked.push(clipTo(r)));
        (sh.breaks || []).filter(within).forEach(r => breaks.push(clipTo(r)));
        /* the first minutes of the shift, for the pages that draw a day */
        (sh.setup || []).filter(within).forEach(r => setup.push(clipTo(r)));
        (sh.working || []).filter(within).forEach(r => working.push(clipTo(r)));
      }
      let any = false;
      byDay[k] = {};
      for(const who in entry.pickers){
        if(st.hide.indexOf(who.toUpperCase()) >= 0) continue;
        const whole = entry.pickers[who];
        const r = live ? (whole.shifts && whole.shifts[live.key]) : shiftName ? (whole.shifts && whole.shifts[shiftName]) : whole;
        if(!r) continue;
        any = true;
        const m = merged[who] || (merged[who] = { who, total: 0, lines: 0, byArea: {}, areaHours: {}, activeHours: 0, days: 0, firstH: null, lastH: null });
        m.total += r.total;
        m.lines += (r.lines == null ? r.total : r.lines);
        m.activeHours += r.activeHours || 0;
        m.days++;
        for(const a in r.byArea){ m.byArea[a] = (m.byArea[a] || 0) + r.byArea[a]; areaSeen[a] = (areaSeen[a] || 0) + r.byArea[a]; }
        /* a day recorded before per-area hours existed is spread by pick
           share, so an old week still reads sensibly */
        const rah = r.areaHours || null;
        for(const a in r.byArea){
          const h = rah && rah[a] != null ? rah[a] : (r.activeHours || 0) * (r.byArea[a] / Math.max(1, r.total));
          m.areaHours[a] = (m.areaHours[a] || 0) + h;
        }
        if(r.firstH != null && (m.firstH == null || r.firstH + off < m.firstH)) m.firstH = r.firstH + off;
        if(r.lastH != null && (m.lastH == null || r.lastH + off > m.lastH)) m.lastH = r.lastH + off;
        byDay[k][who] = { total: r.total, activeHours: r.activeHours, rate: r.activeHours ? round(r.total / Math.max(MIN_HOURS, r.activeHours), 1) : 0 };
        if(days === 1 && r.windows) m.windows = (m.windows || []).concat(r.windows.map(([a, b]) => [a + off, b + off]));
        if(live){
          /* the hours of a live shift are read straight from its records */
          m.byHour = m.byHour || {};
          for(const h in (r.byHour || {})) m.byHour[+h + off] = r.byHour[h];
        } else if(days > 1){
          /* the hours of a typical day: active time in each clock hour,
             summed over the days, so a view can show when somebody usually
             picks without pretending a month is one day */
          m.hourActive = m.hourActive || {}; m.hourPicks = m.hourPicks || {};
          for(const h in (r.byHour || {})){
            m.hourActive[h] = (m.hourActive[h] || 0) + ((r.byHour[h] && r.byHour[h].active) || 0);
            m.hourPicks[h] = (m.hourPicks[h] || 0) + ((r.byHour[h] && r.byHour[h].n) || 0);
          }
        }
      }
      if(any || !(live || shiftName)) daysWithData++;
    });
    /* People who only ever confirmed a handful of tasks are not pickers
       having a bad day, they are somebody who touched a few jobs. They are
       counted in the aside rather than ranked against a picking target. */
    const all = Object.keys(merged).map(w => {
      const s = score(merged[w], st.targets, st.windowMin);
      s.windows = merged[w].windows || null;
      s.hourActive = merged[w].hourActive || null;
      s.hourPicks = merged[w].hourPicks || null;
      return s;
    });
    const people = all.filter(x => x.total >= st.minPicks).sort((a, b) => b.rate - a.rate);
    const minor = all.filter(x => x.total < st.minPicks).sort((a, b) => b.total - a.total);
    const areas = Object.keys(areaSeen).sort((a, b) => areaSeen[b] - areaSeen[a]);

    /* The trend. One day means the hours of that day; more than one means the
       days themselves. Both shapes are the same so the page draws them the
       same way. */
    const series = { by: days === 1 ? 'hour' : 'day', x: [], people: {}, crew: [] };
    if(days === 1){
      const entry = this.history[todayKey];
      const src = {};
      if(live) Object.keys(merged).forEach(w => { src[w] = { byHour: merged[w].byHour || {} }; });
      else Object.assign(src, (entry && entry.pickers) || {});
      let lo = null, hi = null;
      Object.keys(src).forEach(w => {
        for(const h in (src[w].byHour || {})){
          const n = +h;
          if(lo == null || n < lo) lo = n;
          if(hi == null || n > hi) hi = n;
        }
      });
      if(lo != null) for(let h = lo; h <= hi; h++) series.x.push(h);
      people.forEach(pp => {
        const bh = (src[pp.who] || {}).byHour || {};
        const mixShare = pp.byArea;
        series.people[pp.who] = series.x.map(h => {
          const b = bh[h];
          if(!b || !b.n) return null;
          /* the hour's work is assumed to be the same mix as their day, which
             is all the export supports without keeping an area per hour */
          const scaled = {};
          for(const a in mixShare) scaled[a] = mixShare[a] * (b.n / Math.max(1, pp.total));
          return sliceScore(b.n, b.lines, b.active || (b.n ? 0.25 : 0), scaled, st.targets);
        });
      });
      series.crew = series.x.map((h, i) => {
        let picks = 0, lines = 0, hours = 0;
        people.forEach(pp => { const v = series.people[pp.who][i]; if(v){ picks += v.picks; lines += v.lines; hours += v.hours; } });
        return hours > 0 ? { picks, lines, hours: round(hours, 2), rate: round(picks / hours, 1), lineRate: round(lines / hours, 1),
                             pct: null } : null;
      });
    } else {
      series.x = want.slice().reverse().filter(k => this.history[k]);
      people.forEach(pp => {
        series.people[pp.who] = series.x.map(k => {
          const r = ((this.history[k] || {}).pickers || {})[pp.who];
          return r ? sliceScore(r.total, r.lines, r.activeHours, r.byArea, st.targets) : null;
        });
      });
      series.crew = series.x.map((k, i) => {
        let picks = 0, lines = 0, hours = 0;
        people.forEach(pp => { const v = series.people[pp.who][i]; if(v){ picks += v.picks; lines += v.lines; hours += v.hours; } });
        return hours > 0 ? { picks, lines, hours: round(hours, 2), rate: round(picks / hours, 1), lineRate: round(lines / hours, 1), pct: null } : null;
      });
    }
    /* the crew percentage, against the crew's own blended target */
    series.crew.forEach((c, i) => {
      if(!c) return;
      let num = 0, den = 0;
      people.forEach(pp => { const v = series.people[pp.who][i]; if(v && v.pct != null){ num += v.pct * v.hours; den += v.hours; } });
      c.pct = den > 0 ? Math.round(num / den) : null;
    });
    const totals = people.reduce((t, p) => {
      t.picks += p.total; t.hours += p.activeHours; t.expected += p.expected; return t;
    }, { picks: 0, hours: 0, expected: 0 });
    return {
      days: Math.max(1, days), daysWithData, todayKey,
      live: live ? { key: live.key, label: live.label, start: live.start, end: live.end, startDay: live.startDay, nowH: round(live.nowH, 2),
                     since: live.startDay + ' ' + String(Math.floor(live.start)).padStart(2, '0') + ':' + String(Math.round((live.start % 1) * 60)).padStart(2, '0') } : null,
      blocked: days === 1 ? mergeRanges(blocked) : [],
      breaks: days === 1 ? mergeRanges(breaks) : [],
      setup: days === 1 ? mergeRanges(setup) : [],
      working: days === 1 ? mergeRanges(working) : [],
      /* over several days: the shape of a typical weekday (or weekend day
         if the period has no weekdays), for the typical-day views */
      typical: days === 1 ? null : (() => {
        const wk = want.find(k => { const d = schedule.weekday(k); return d >= 1 && d <= 5; }) || want[0];
        const sh = schedule.dayShape(st.sched, wk);
        return { day: wk, working: sh.working, breaks: sh.breaks, closed: sh.closed, setup: sh.setup, wrap: sh.wrap };
      })(),
      shiftNames: schedule.names(st.sched),
      shiftName,
      scheduleText: st.scheduleText,
      people, minor, areas, byDay, series,
      minPicks: st.minPicks,
      dayHours: st.dayHours,
      prodFloor: st.prodFloor,
      bands: st.bands,
      /* so the settings form shows what is in force rather than what the
         page happens to default to when nothing has been saved */
      review: st.review,
      targets: st.targetsText,
      targetsAreDefault: !String(((this.override || this.cfg.get().pickers || {}).targets) || '').trim(),
      windowMin: st.windowMin,
      lineKey: st.lineKey, linesAreTasks: !st.lineKey.length,
      columns: (() => { const e = this.history[todayKey]; return (e && e.columns) || []; })(),
      shift: (() => {
        // the span the activity view is drawn across
        let lo = null, hi = null;
        people.concat(minor).forEach(x => {
          if(x.firstH != null && (lo == null || x.firstH < lo)) lo = x.firstH;
          if(x.lastH != null && (hi == null || x.lastH > hi)) hi = x.lastH;
        });
        if(live) return { from: Math.floor(live.start), to: Math.max(Math.ceil(live.end || 0), Math.ceil(live.nowH + 0.25), hi == null ? 0 : Math.ceil(hi + 0.5)) };
        return { from: lo == null ? 6 : Math.floor(lo), to: hi == null ? 18 : Math.ceil(hi + 0.5) };
      })(),
      targetMap: areas.reduce((o, a) => { o[a] = targetFor(st.targets, a); return o; }, {}),
      summary: {
        pickers: people.length, picks: totals.picks,
        hours: round(totals.hours, 1),
        rate: totals.hours > 0 ? round(totals.picks / totals.hours, 1) : 0,
        expected: totals.expected,
        pct: totals.expected > 0 ? Math.round(totals.picks / totals.expected * 100) : null
      },
      historyDays: Object.keys(this.history).length
    };
  }
}

module.exports = { Pickers, parseTargets, activeHours, areaHours, blockedFor, subtractBlocked, liveShift, score, round, MIN_HOURS, DEFAULT_TARGETS, DEFAULT_SCHEDULE };
