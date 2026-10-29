'use strict';
/* Recommended pick standards, worked out from what this warehouse has
   actually done rather than from a number somebody typed once.

   The unit of evidence is one person, one area, one day: the picks they
   confirmed there and the time credited to it. A recommendation is a
   percentile of demonstrated rates, not an average, so a single wild day
   cannot set what everybody else is measured against.

   Three deliberate choices, because a standard people are judged on has to
   be defensible out loud:

   1. A day is worth at most `dayHours` of picking, 6.5 by default: a paid
      shift with breaks taken out. Anybody whose measured active time runs
      longer than that has their hours scaled back to it, which raises their
      demonstrated rate. Anybody who was only on the floor for three hours
      is credited with three, because they were not there for the rest of
      it. That is the "true work hours" basis; the raw active-time basis is
      available for comparison.

   2. Somebody who only ever picks one area and beats the middle of the crew
      counts for less than a picker carrying a normal mix. Their number is
      real, but part of it is the benefit of never switching tasks, and a
      standard set from it is a standard set for a specialist. Nobody is
      damped for being slow: there is nothing to discount.

   3. Hours carry weight, but as a square root, so somebody with ten times
      the hours counts about three times as much rather than ten. One person
      cannot become the standard by being the only one sent there.

   Nothing here changes a target on its own. It fills in a suggestion; the
   standards on the picker page are still whatever a person saved. */
const fs = require('fs');
const path = require('path');
const model = require('./model');

const DAY_HOURS = 6.5;        // a paid shift with breaks taken out
const MIN_HOURS = 0.5;        // half an hour in an area before it is evidence
const MIN_PICKS = 10;
const SPEC_DAMP = 0.4;        // a single-area high performer counts 60%
const KEEP_DAYS = 400;
const LEVELS = { typical: 50, recommended: 60, stretch: 75 };

/* A percentile of a weighted set. Walking the sorted values until the
   weight runs out keeps the answer an observed rate, which matters: a
   standard somebody can point at is easier to defend than an interpolated
   number nobody achieved. */
function wPercentile(rows, pct, wOf, vOf){
  if(!rows.length) return null;
  const a = rows.slice().sort((x, y) => vOf(x) - vOf(y));
  const total = a.reduce((t, x) => t + Math.max(0, wOf(x)), 0);
  if(!(total > 0)) return vOf(a[Math.floor((a.length - 1) * pct / 100)]);
  const want = total * (pct / 100);
  let acc = 0;
  for(const x of a){ acc += Math.max(0, wOf(x)); if(acc >= want - 1e-9) return vOf(x); }
  return vOf(a[a.length - 1]);
}
function round(n, d){ const m = Math.pow(10, d == null ? 1 : d); return Math.round(n * m) / m; }

/* Which shift a person-day belongs to, from the hour of their first pick.
   Starts are the hours shifts begin (6, 14, 22 by default); a pick before
   the first start belongs to the shift that began the night before. */
const schedule = require('./schedule');
function shiftLabel(name, sched){
  const s = (sched || []).find(x => x.name === name);
  const nice = (x) => { const hh = Math.floor(x) % 24, mm = Math.round((x - Math.floor(x)) * 60); return (hh % 12 || 12) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (hh < 12 ? 'a' : 'p'); };
  return name + ' shift' + (s ? ', ' + nice(s.start) + ' to ' + nice(s.end) : '');
}

/* One row per person, area and day. `basis` decides whether a long day is
   trimmed back to the true working hours or taken as measured. */
function personDays(history, keys, opt){
  const out = [];
  keys.forEach(k => {
    const e = history[k];
    if(!e || !e.pickers) return;
    for(const who in e.pickers){
      if(opt.hide.indexOf(who.toUpperCase()) >= 0) continue;
      const whole = e.pickers[who];
      /* a record split by shift gives each shift its own observation; an
         older one is filed under the shift its first pick fell in */
      const parts = whole.shifts && Object.keys(whole.shifts).length
        ? Object.keys(whole.shifts).map(k => [k, whole.shifts[k]])
        : [[schedule.shiftAt(opt.sched, k, whole.firstH == null ? 12 : whole.firstH).name, whole]];
      parts.forEach(([shift, r]) => {
      const act = r.activeHours || 0;
      if(!(act > 0) || !r.byArea) return;
      const cap = (opt.basis === 'day' && opt.dayHours > 0 && act > opt.dayHours) ? opt.dayHours / act : 1;
      const ah = r.areaHours || null;
      for(const a in r.byArea){
        const picks = r.byArea[a];
        // history written before per-area hours existed is spread by pick share
        const hours = (ah && ah[a] != null ? ah[a] : act * (picks / Math.max(1, r.total))) * cap;
        if(!(hours > 0)) continue;
        out.push({ day: k, who, area: a, picks, hours: round(hours, 3), rate: round(picks / hours, 1), shift });
      }
      });
    }
  });
  return out;
}

class Recommend {
  constructor(cfg, pickers, log){
    this.cfg = cfg;
    this.pickers = pickers;
    this.log = log || (() => {});
    this.dir = path.join(cfg.dataDir, 'pickers');
    this.file = path.join(this.dir, 'recommend.json');
    this.snaps = {};      // dayKey -> { shiftKey -> { area -> { d1, dW } } }
    this.override = null; // set on the cloud copy from the host's push
    try{ fs.mkdirSync(this.dir, { recursive: true }); }catch(e){}
    try{ this.snaps = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; }catch(e){ this.snaps = {}; }
  }
  settings(){
    const s = (this.pickers && this.pickers.override) || (this.cfg.get().pickers) || {};
    return {
      hide: String(s.hide || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
      dayHours: (s.dayHours != null && isFinite(+s.dayHours) && +s.dayHours > 0) ? +s.dayHours : DAY_HOURS,
      sched: schedule.parseSchedule(schedule.effectiveText(s.schedule)),
      targets: model.parseTargets(s.targets || model.DEFAULT_TARGETS),
      targetsAreDefault: !String(s.targets || '').trim()
    };
  }
  keysBack(days, todayKey){
    const base = new Date(todayKey + 'T12:00:00');
    const out = [];
    for(let i = 0; i < Math.max(1, days); i++) out.push(model.dayKey(new Date(base.getTime() - i * 86400000)));
    return out;
  }

  /* The recommendation itself. Everything the page shows about how a number
     was reached comes back with it, because a standard nobody can audit is
     a standard nobody trusts. */
  report(q, todayKey){
    const st = this.settings();
    const days = Math.max(1, Math.min(400, parseInt(q && q.days, 10) || 30));
    const level = LEVELS[(q && q.level) || 'recommended'] || LEVELS.recommended;
    const basis = (q && q.basis) === 'active' ? 'active' : 'day';
    const shift = String((q && q.shift) || 'all');
    const hist = this.pickers ? this.pickers.history : {};
    const opt = { hide: st.hide, dayHours: st.dayHours, basis, sched: st.sched };

    const keys = this.keysBack(days, todayKey).filter(k => hist[k]);
    const all = personDays(hist, keys, opt);
    const rows = all.filter(r => r.hours >= MIN_HOURS && r.picks >= MIN_PICKS && (shift === 'all' || r.shift === shift));

    /* which shifts exist at all, so the page only offers real ones */
    const seen = {};
    all.forEach(r => { if(r.shift) seen[r.shift] = (seen[r.shift] || 0) + 1; });
    const order = schedule.names(st.sched);
    const shifts = Object.keys(seen).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(k => ({ key: k, label: shiftLabel(k, st.sched), personDays: seen[k] }));

    const areaNames = [];
    const byArea = {};
    rows.forEach(r => {
      if(!byArea[r.area]){ byArea[r.area] = []; areaNames.push(r.area); }
      byArea[r.area].push(r);
    });

    /* how much of each person's qualifying time went to each area, which is
       what marks a specialist */
    const personHours = {};
    rows.forEach(r => { personHours[r.who] = (personHours[r.who] || 0) + r.hours; });

    const areas = areaNames.map(area => {
      const rs = byArea[area];
      const per = {};
      rs.forEach(r => {
        const p = per[r.who] || (per[r.who] = { who: r.who, picks: 0, hours: 0, days: 0 });
        p.picks += r.picks; p.hours += r.hours; p.days++;
      });
      const persons = Object.keys(per).map(w => {
        const p = per[w];
        return { who: w, picks: p.picks, hours: round(p.hours, 2), days: p.days,
                 rate: round(p.picks / p.hours, 1),
                 share: round(p.hours / Math.max(0.01, personHours[w]), 3) };
      });
      const evi = x => Math.sqrt(x.hours);
      const med = wPercentile(persons, 50, evi, x => x.rate);
      /* the damping: only a fast specialist is discounted, and only by how
         concentrated they are */
      persons.forEach(x => {
        x.damp = (med != null && x.rate > med) ? round(1 - SPEC_DAMP * x.share, 3) : 1;
        x.weight = round(evi(x) * x.damp, 3);
      });
      const rec = wPercentile(persons, level, x => x.weight, x => x.rate);
      const plain = wPercentile(persons, level, evi, x => x.rate);
      const recR = rec == null ? null : Math.max(1, Math.round(rec));
      const current = model.targetFor(st.targets, area) || null;
      const met = recR == null ? [] : rs.filter(r => r.rate >= recR);
      const people = persons.length;
      return {
        area,
        current,
        rec: recR,
        undamped: plain == null ? null : Math.round(plain),
        typical: (() => { const v = wPercentile(persons, 50, x => x.weight, x => x.rate); return v == null ? null : Math.round(v); })(),
        stretch: (() => { const v = wPercentile(persons, 75, x => x.weight, x => x.rate); return v == null ? null : Math.round(v); })(),
        low: (() => { const v = wPercentile(persons, 25, x => x.weight, x => x.rate); return v == null ? null : Math.round(v); })(),
        perDay: recR == null ? null : Math.round(recR * st.dayHours),
        attain: rs.length ? Math.round(met.length / rs.length * 100) : null,
        people, personDays: rs.length,
        hours: round(rs.reduce((t, r) => t + r.hours, 0), 1),
        picks: rs.reduce((t, r) => t + r.picks, 0),
        specialists: persons.filter(x => x.share >= 0.85).length,
        damped: persons.filter(x => x.damp < 1).length,
        confidence: people >= 4 && rs.length >= 12 ? 'strong' : people >= 2 && rs.length >= 5 ? 'fair' : 'thin',
        delta: (recR != null && current) ? Math.round((recR - current) / current * 100) : null,
        contributors: persons.sort((a, b) => b.weight - a.weight)
      };
    }).sort((a, b) => b.picks - a.picks);

    /* the daily record, so a standard can be watched settling rather than
       taken from one day */
    const snapKeys = this.keysBack(Math.min(days, 30), todayKey).filter(k => this.snapsFor(k));
    const trend = snapKeys.slice().reverse().map(k => {
      const s = this.snapsFor(k)[shift] || {};
      return { day: k, areas: s };
    });

    return {
      ok: areas.length > 0, todayKey, days, daysWithData: keys.length,
      level, levelName: Object.keys(LEVELS).find(k => LEVELS[k] === level) || 'recommended',
      basis, dayHours: st.dayHours,
      shift, shifts,
      minHours: MIN_HOURS, minPicks: MIN_PICKS, specDamp: SPEC_DAMP,
      targetsAreDefault: st.targetsAreDefault,
      areas, trend,
      text: areas.filter(a => a.rec != null).map(a => a.area + ' = ' + a.rec).join('\n'),
      note: areas.length ? '' : 'No picking recorded in the last ' + days + ' days that is long enough to set a standard from.'
    };
  }

  snapsFor(day){ const s = this.override ? this.override[day] : this.snaps[day]; return s || null; }

  /* Written whenever a task export is read, so the record fills itself in.
     Each shift gets the day on its own (d1) and the trailing window (dW),
     because a single day says what happened and the window says what to
     expect. */
  snapshot(todayKey){
    try{
      const st = this.settings();
      const day = {};
      const shifts = ['all'].concat(this.report({ days: 1, shift: 'all' }, todayKey).shifts.map(s => s.key));
      shifts.forEach(k => {
        const d1 = this.report({ days: 1, shift: k }, todayKey);
        const dW = this.report({ days: 30, shift: k }, todayKey);
        const one = {};
        d1.areas.forEach(a => { if(a.rec != null) one[a.area] = { d1: a.rec, people: a.people }; });
        dW.areas.forEach(a => { if(a.rec != null) (one[a.area] || (one[a.area] = {})).dW = a.rec; });
        if(Object.keys(one).length) day[k] = one;
      });
      if(!Object.keys(day).length) return false;
      this.snaps[todayKey] = day;
      const keys = Object.keys(this.snaps).sort();
      while(keys.length > KEEP_DAYS) delete this.snaps[keys.shift()];
      fs.writeFileSync(this.file, JSON.stringify(this.snaps));
      return true;
    }catch(e){ this.log('recommend: ' + e.message); return false; }
  }
  payload(){
    // the last two months of the record, for the cloud copy
    const out = {};
    Object.keys(this.snaps).sort().slice(-60).forEach(k => { out[k] = this.snaps[k]; });
    return out;
  }
}

module.exports = { Recommend, wPercentile, personDays, DAY_HOURS, LEVELS };
