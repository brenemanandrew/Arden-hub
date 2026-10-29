'use strict';
/* End of shift, without anyone pressing anything.
   The host service knows the schedule, the task export, the order report,
   the staging lanes and the dwell log, so a few minutes after a shift ends
   it writes the report itself: the same numbers the board shows, plus the
   crew ranked against the pick standards. A supervisor who does press the
   marker on the host's board builds the same deck through here, with their
   answers on a second slide, and that copy replaces the automatic one. */
const fs = require('fs');
const path = require('path');
const model = require('./model');
const schedule = require('./schedule');
const board = require('./board');
const { buildEosDeck, buildWeekDeck } = require('./deck');

function dayMs(key){ return new Date(key + 'T00:00:00').getTime(); }
/* a liveShift() answer as an absolute window */
function windowOf(live){
  const base = dayMs(live.startDay);
  return { name: live.key, day: live.startDay, from: base + live.start * 3600000, to: base + live.end * 3600000 };
}
/* The crew, ranked. Percent of standard is the honest measure: it weighs
   the mix of areas somebody worked, so a pallet picker and a flow picker
   compare. Rate breaks ties. People under the picks floor are left out. The
   bottom five never repeat anyone from the top three. */
function rank(people, floor, topN, bottomN){
  topN = topN || 3; bottomN = bottomN || 5;
  /* one pick in two minutes is not a slow picker, it is somebody who touched
     a job: at least ten picks and half an hour before anyone is ranked */
  const minPicks = Math.max(10, floor || 0);
  const ranked = people.filter(p => p.pct != null && p.total >= minPicks && (p.activeHours || 0) >= 0.5).sort((a, b) => (b.pct - a.pct) || (b.rate - a.rate));
  const top = ranked.slice(0, topN);
  const bottom = ranked.length > topN ? ranked.slice(Math.max(topN, ranked.length - bottomN)).reverse() : [];
  return { top, bottom, ranked };
}
function mainArea(p){
  let best = '', n = -1;
  for(const a in (p.byArea || {})) if(p.byArea[a] > n){ n = p.byArea[a]; best = a; }
  return best;
}
/* distinct delivery lines confirmed on a day, from the task export; the
   order report loses a line when its order ships, so the larger of the two
   is what the board shows and what the report says */
function taskLinesOn(rows, dayKey){
  const hIdx = model.headerIndex(rows, ['warehouse task'], 12);
  if(hIdx < 0) return null;
  const find = model.makeFinder(model.norm(rows[hIdx]));
  const cAct = find('activity'), cDate = find('confirmation date'), cDoc = find('document'), cItem = find('document item');
  if(cAct < 0 || cDate < 0 || cDoc < 0) return null;
  const set = new Set();
  for(let i = hIdx + 1; i < rows.length; i++){
    const r = rows[i] || [];
    if(String(r[cAct] == null ? '' : r[cAct]).trim().toUpperCase() !== 'PICK') continue;
    const d = model.parseExcelDate(String(r[cDate] == null ? '' : r[cDate]));
    if(!d || model.dayKey(d) !== dayKey) continue;
    set.add(String(r[cDoc] == null ? '' : r[cDoc]) + '\u0001' + (cItem >= 0 ? String(r[cItem] == null ? '' : r[cItem]) : ''));
  }
  return set.size;
}

/* the last complete Monday-to-Sunday week before `now`, as day keys */
function lastWeek(now){
  const d = new Date(now); d.setHours(12, 0, 0, 0);
  const back = (d.getDay() + 6) % 7;              // days since Monday
  const thisMon = new Date(d.getTime() - back * 86400000);
  const from = new Date(thisMon.getTime() - 7 * 86400000), to = new Date(thisMon.getTime() - 86400000);
  const days = []; for(let i = 0; i < 7; i++) days.push(model.dayKey(new Date(from.getTime() + i * 86400000)));
  return { from: model.dayKey(from), to: model.dayKey(to), days, endMs: thisMon.getTime() - 43200000 };
}

class Eos {  constructor(app, log){
    this.app = app; this.log = log || (() => {});
    this.file = path.join(app.cfg.dataDir, 'eos.json');
    this.st = { done: {}, last: null, weeks: {}, lastWeek: null };
    try{ Object.assign(this.st, JSON.parse(fs.readFileSync(this.file, 'utf8'))); }catch(e){}
    this.prev = null; this.pending = {}; this.timer = null; this.onWritten = null;
  }
  save(){ try{ fs.writeFileSync(this.file, JSON.stringify(this.st)); }catch(e){} }
  settings(){ return this.app.settings.get() || {}; }
  sched(){ return this.app.pickers.settings().sched; }
  start(){
    this.timer = setInterval(() => { try{ this.tick(); }catch(e){ this.log('eos: ' + e.message); } }, 60000);
    setTimeout(() => { try{ this.tick(); }catch(e){ this.log('eos: ' + e.message); } }, 20000);
  }
  stop(){ if(this.timer) clearInterval(this.timer); }
  status(){
    const s = this.settings();
    return { auto: s.autoReport !== false, graceMin: this.graceMin(), last: this.st.last, lastWeek: this.st.lastWeek, pending: Object.keys(this.pending).length };
  }
  /* a copy of a finished deck into the shared reports folder, when there
     is one; the app's own copy under the data folder is the record either way */
  shareOut(name, bytes){
    const bk = this.app.backup;
    const dir = bk && bk.reportsDir();
    if(!dir) return;
    try{ fs.writeFileSync(path.join(dir, name), bytes); this.log('report: ' + name + ' copied to the reports folder'); }
    catch(e){ this.log('report: could not copy ' + name + ' to the reports folder: ' + e.message, 'warn'); }
  }
  graceMin(){ const v = parseInt(this.settings().reportGraceMin, 10); return isNaN(v) ? 10 : Math.min(120, Math.max(0, v)); }
  /* the shift that ended most recently, or the one running now */
  lastEnded(now){ return windowOf(schedule.liveShift(this.sched(), now || new Date())); }
  key(win){ return win.day + '|' + win.name; }
  tick(){
    const now = Date.now();
    const cur = this.lastEnded(new Date(now));
    const k = this.key(cur);
    /* a shift that hands straight over to the next one is never "the one
       that ended most recently", so the change of shift is what files it */
    if(this.prev && this.prev.key !== k) this.pending[this.prev.key] = this.prev.win;
    this.prev = { key: k, win: cur };
    if(now >= cur.to) this.pending[k] = cur;
    if(this.app.cloud && this.app.cloud.st && this.app.cloud.st.standby) return;   // the feeding PC writes the reports
    const grace = this.graceMin() * 60000;
    /* The end of a shift is when the day's work is complete and the machine
       is about to be left alone, so it is when the data folder is copied to
       the reports folder - whether or not the report is being written. */
    for(const pk in this.pending){
      const win = this.pending[pk];
      if(this.st.backedUp && this.st.backedUp[pk]) continue;
      if(now - win.to < grace || now - win.to > 10 * 3600000) continue;
      this.st.backedUp = this.st.backedUp || {};
      this.st.backedUp[pk] = now;
      const keys = Object.keys(this.st.backedUp).sort();
      while(keys.length > 40) delete this.st.backedUp[keys.shift()];
      this.save();
      const bk = this.app.backup;
      if(bk && (this.app.cfg.get().backup || {}).onShiftEnd !== false) bk.run('end of the ' + win.name + ' shift', { auto: true });
    }
    if(this.settings().autoReport === false) return;
    /* a new week: the week just finished gets its one-pager, once, as long
       as the service was not away for the whole of it */
    const wk = lastWeek(now);
    if(!this.st.weeks[wk.from] && now - wk.endMs > 20 * 60000 && now - wk.endMs < 7 * 86400000){
      this.st.weeks[wk.from] = { at: now, tried: true }; this.save();
      this.runWeek(wk, 'automatic');
    }
    for(const pk in this.pending){
      const win = this.pending[pk];
      // written already, or the service was down for it: let it go
      if(this.st.done[pk] || now - win.to > 10 * 3600000){ delete this.pending[pk]; continue; }
      if(now - win.to < grace) continue;
      delete this.pending[pk];
      this.run(win, [], 'automatic');
    }
  }
  /* a request from the host's board: its own window when it has one */
  request(v){
    v = v || {};
    let win;
    if(v.from && v.to){ const from = +v.from, to = +v.to; win = { name: String(v.name || 'Shift'), day: model.dayKey(new Date(from)), from, to }; }
    else win = this.lastEnded(new Date());
    const notes = Array.isArray(v.notes) ? v.notes.filter(n => n && n.q && n.a).map(n => ({ q: String(n.q), a: String(n.a) })) : [];
    return this.run(win, notes, 'requested');
  }
  /* on request from the host's board or Admin: the last complete week, or the week starting on a given Monday */
  requestWeek(v){
    v = v || {};
    let wk;
    if(v.week && /^\d{4}-\d{2}-\d{2}$/.test(v.week)){ const from = new Date(v.week + 'T12:00:00'); wk = lastWeek(new Date(from.getTime() + 8 * 86400000)); }
    else wk = lastWeek(new Date());
    return this.runWeek(wk, 'requested');
  }
  gatherWeek(wk, why){
    const app = this.app, s = this.settings(), st = app.pickers.settings();
    const rep = app.pickers.report(7, wk.to);
    const dh = st.dayHours || 6.5;
    const people = (rep.people || []).map(p => Object.assign({}, p, { mainArea: mainArea(p), util: p.activeHours > 0 ? Math.min(100, Math.round(p.activeHours / (Math.max(1, p.days || 1) * dh) * 100)) : null }));
    const { top, bottom, ranked } = rank(people, Math.max(st.minPicks || 0, 25), 5, 5);
    // day by day, from the same records the picker page reads
    const sx = (rep.series && rep.series.x) || [];
    const comp = (app.dwell && app.dwell.completed) || [];
    const dayMs0 = k => new Date(k + 'T00:00:00').getTime();
    const byDay = wk.days.map(k => {
      const i = sx.indexOf(k);
      const crew = i >= 0 ? rep.series.crew[i] : null;
      let lines = 0, n = 0, us = [];
      if(i >= 0) people.forEach(p => { const v = rep.series.people[p.who] && rep.series.people[p.who][i]; if(v){ lines += v.lines || 0; n++; if(v.hours > 0) us.push(Math.min(100, v.hours / dh * 100)); } });
      const t0 = dayMs0(k), t1 = t0 + 86400000;
      const gone = comp.filter(r => !r.stale && r.departed >= t0 && r.departed < t1);
      return { day: k, lines: i >= 0 ? lines : null, picks: crew ? crew.picks : 0, orders: comp.length ? new Set(gone.map(r => r.order).filter(Boolean)).size : null,
               pickers: n, pct: crew ? crew.pct : null, util: us.length ? Math.round(us.reduce((a, b) => a + b, 0) / us.length) : null, hours: crew ? crew.hours : 0 };
    });
    const worked = byDay.filter(r => r.picks > 0);
    const areas = {};
    people.forEach(p => { for(const a in (p.areaStat || {})){ const x = p.areaStat[a]; const o = areas[a] = areas[a] || { area: a, picks: 0, hours: 0 }; o.picks += x.picks || 0; o.hours += x.hours || 0; } });
    const areaList = Object.values(areas).map(a => ({ area: a.area, picks: a.picks, hours: a.hours, rate: a.hours > 0 ? Math.round(a.picks / a.hours * 10) / 10 : null, target: (rep.targetMap || {})[a.area] || null })).sort((a, b) => b.picks - a.picks);
    const us = people.filter(p => p.util != null).map(p => p.util);
    const gone = comp.filter(r => !r.stale && r.departed >= dayMs0(wk.from) && r.departed < dayMs0(wk.to) + 86400000);
    const dwell = gone.map(r => r.departed - (r.stagedSince || r.firstSeen)).filter(x => x > 0).sort((a, b) => a - b);
    const totals = { lines: worked.reduce((t, r) => t + (r.lines || 0), 0), picks: rep.summary.picks || 0, hours: rep.summary.hours || 0,
      orders: comp.length ? new Set(gone.map(r => r.order).filter(Boolean)).size : null, medianDwellMin: dwell.length ? Math.round(dwell[Math.floor(dwell.length / 2)] / 60000) : null,
      crewPct: rep.summary.pct, util: us.length ? Math.round(us.reduce((a, b) => a + b, 0) / us.length) : null, pickers: people.length,
      newPickers: people.filter(p => p.days === 1).length, daysWithData: worked.length, goalPerDay: Math.max(0, parseInt(s.goalLines, 10) || 0) };
    const watch = [];
    if(totals.goalPerDay){ const under = worked.filter(r => r.lines != null && r.lines < totals.goalPerDay); if(under.length) watch.push(under.length + ' of ' + worked.length + ' days under the ' + totals.goalPerDay.toLocaleString('en-US') + ' line goal: ' + under.map(r => new Date(r.day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + r.lines.toLocaleString('en-US')).join(', ')); }
    areaList.filter(a => a.target && a.rate != null && a.rate < a.target * 0.9).forEach(a => watch.push(a.area + ' ran ' + a.rate.toFixed(1) + ' against a standard of ' + a.target));
    if(totals.util != null && totals.util < st.prodFloor) watch.push('Crew productive time ' + totals.util + '% against a floor of ' + st.prodFloor + '%');
    if(bottom.length && bottom[0].pct != null && bottom[0].pct < 50) watch.push(bottom.filter(p => p.pct < 50).length + ' pickers under half of standard for the week');
    return {
      title: s.title || 'Staging Lane Health', week: wk, generatedAt: Date.now(), why, dayHours: dh, prodFloor: st.prodFloor,
      totals, byDay: worked.length ? byDay.filter(r => r.picks > 0 || r.orders) : byDay, areas: areaList, top, bottom, ranked: ranked.length, watch,
      footnote: 'picks, lines and rates from the task export by confirmation day; orders shipped from the staging log; standards from Pick Standards'
    };
  }
  runWeek(wk, why){
    const app = this.app;
    let data, bytes;
    try{ data = this.gatherWeek(wk, why); if(!data.totals.daysWithData){ this.log('week report: no picks recorded for the week of ' + wk.from + '; nothing to write'); return { ok: false, error: 'no picks recorded that week' }; } bytes = buildWeekDeck(data); }
    catch(e){ this.log('week report: could not build the week of ' + wk.from + ': ' + e.message); return { ok: false, error: e.message }; }
    const name = 'Week_Report_' + wk.from + '.pptx';
    const dir = path.join(app.cfg.dataDir, 'reports');
    try{
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), bytes);
      const rd = app.cfg.get().reportDir;
      try{ if(rd && fs.existsSync(rd)) fs.writeFileSync(path.join(rd, name), bytes); }catch(e){}
      this.shareOut(name, bytes);
    }catch(e){ this.log('week report: could not save ' + name + ': ' + e.message); return { ok: false, error: e.message }; }
    this.st.weeks[wk.from] = { name, at: Date.now() };
    this.st.lastWeek = { name, at: Date.now(), from: wk.from, to: wk.to, why };
    this.save();
    this.log('week report ' + (why === 'automatic' ? 'written' : 'built') + ': ' + name + ' (' + data.totals.pickers + ' pickers, ' + data.totals.lines + ' lines over ' + data.totals.daysWithData + ' days)');
    if(this.onWritten){ try{ this.onWritten(this.st.lastWeek); }catch(e){} }
    return { ok: true, name, url: '/reports/' + encodeURIComponent(name), last: this.st.lastWeek };
  }
  fileName(win){    const d = new Date(win.from), p = n => String(n).padStart(2, '0');
    return 'Shift_Report_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + String(win.name).replace(/\W+/g, '') + '.pptx';
  }
  gather(win, notes, why){
    const app = this.app, s = this.settings();
    const b = board.build(app);
    const rep = app.pickers.report(1, win.day, { shift: 'live', now: new Date(win.to - 60000) });
    const people = (rep.people || []).map(p => Object.assign({}, p, { mainArea: mainArea(p) }));
    const { top, bottom, ranked } = rank(people, app.pickers.settings().minPicks);
    const totals = rep.totals || people.reduce((t, p) => { t.picks += p.total; t.hours += p.activeHours; t.expected += p.expected || 0; return t; }, { picks: 0, hours: 0, expected: 0 });
    const dh = app.pickers.settings().dayHours || 6.5;
    const us = people.filter(p => p.activeHours > 0).map(p => Math.min(100, p.activeHours / dh * 100));
    const crew = { count: people.length, picks: totals.picks, hours: totals.hours, pct: totals.expected > 0 ? Math.round(totals.picks / totals.expected * 100) : null,
                   util: us.length ? Math.round(us.reduce((t, x) => t + x, 0) / us.length) : null, prodFloor: app.pickers.settings().prodFloor };
    // tasks on the shift's own day
    let tasks = null, taskLines = null, picksNote = '';
    const wh = app.ingest.files.wh;
    if(wh && wh.status === 'ok' && wh.full){
      try{
        tasks = model.computeTasks(wh.full, (s.wtAreaMap || '').trim() || board.DEFAULT_WT_AREAS, win.day);
        const tg = app.pickers.settings().targets;
        tasks.areas.forEach(a => { a.target = model.targetFor(tg, a.area) || null; });
        taskLines = taskLinesOn(wh.full, win.day);
      }catch(e){ picksNote = e.message; }
    } else picksNote = wh ? (wh.error || wh.status || 'no task export') : 'no task export';
    const areas = tasks ? tasks.areas.map(a => ({ area: a.area, confirmed: a.confirmed, open: a.open, pickers: a.pickers, rate: a.ratePerHour, target: a.target })) : [];
    // lines: the larger of the two exports, as on the board
    const O = (app.ingest.derived || {}).orders || { pickDays: {} };
    const ordersLines = (O.pickDays || {})[win.day] || 0;
    const picked = Math.max(ordersLines, taskLines || 0);
    const goal = Math.max(0, parseInt(s.goalLines, 10) || 0);
    const lines = { picked, goal, pct: goal ? Math.round(picked / goal * 100) : null, source: taskLines != null && taskLines > ordersLines ? 'task confirmations' : 'order report' };
    // staging at shift end, and what left during the shift
    const comp = (app.dwell && app.dwell.completed) || [];
    const gone = comp.filter(r => !r.stale && r.departed >= win.from && r.departed < win.to + 60000);
    const dwell = gone.map(r => r.departed - (r.stagedSince || r.firstSeen)).filter(x => x > 0).sort((a, b) => a - b);
    const sm = b.summary || {};
    const staging = { waiting: sm.waiting || 0, ready: sm.ready || 0, late: sm.late || 0, carried: sm.carried || 0, occupancyPct: sm.occupancyPct || 0, lanesUsed: sm.lanesUsed || 0, lanesTotal: sm.lanesTotal || 0,
      cleared: new Set(gone.map(r => r.order).filter(Boolean)).size, medianDwellMin: dwell.length ? Math.round(dwell[Math.floor(dwell.length / 2)] / 60000) : null };
    // watch items: what the next shift walks into
    const watch = [];
    if(goal && picked < goal) watch.push('Line goal missed by ' + (goal - picked).toLocaleString('en-US') + ' (' + lines.pct + '% of ' + goal.toLocaleString('en-US') + ')');
    areas.filter(a => a.target && a.rate != null && a.rate < a.target * 0.9).forEach(a => watch.push(a.area + ' ran ' + a.rate.toFixed(1) + ' against a standard of ' + a.target));
    if(staging.late) watch.push(staging.late + ' orders past 3 hours in staging' + (staging.carried ? ', ' + staging.carried + ' from a prior day' : ''));
    const exc = sm.exceptions || {};
    if(exc.split) watch.push(exc.split + ' complete orders split across more than one lane');
    if(exc.loose) watch.push(exc.loose + ' orders with a tote still out on the floor');
    if(exc.hospital) watch.push(exc.hospital + ' orders with a tote in problem solve');
    if(tasks && tasks.open){ const worst = areas.slice().sort((x, y) => y.open - x.open)[0]; if(worst) watch.push(tasks.open + ' pick tasks left open, most in ' + worst.area + ' (' + worst.open + ')'); }
    return {
      title: s.title || 'Staging Lane Health', shift: win, generatedAt: Date.now(), why,
      lines, picks: { confirmed: tasks ? tasks.confirmed : (crew.picks || null), open: tasks ? tasks.open : null, note: picksNote },
      staging, areas, crew, top, bottom, minorCount: (rep.minor || []).length + (people.length - ranked.length), watch, notes: notes || [],
      footnote: 'lines from the ' + lines.source + '; picks and rates from the task export; standards from Pick Standards'
    };
  }
  run(win, notes, why){
    const app = this.app;
    let data, bytes;
    try{ data = this.gather(win, notes, why); bytes = buildEosDeck(data); }
    catch(e){ this.log('eos: could not build the ' + win.name + ' report: ' + e.message); return { ok: false, error: e.message }; }
    const name = this.fileName(win);
    const dir = path.join(app.cfg.dataDir, 'reports');
    try{
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), bytes);
      const rd = app.cfg.get().reportDir;
      try{ if(rd && fs.existsSync(rd)) fs.writeFileSync(path.join(rd, name), bytes); }catch(e){}
      this.shareOut(name, bytes);
    }catch(e){ this.log('eos: could not save ' + name + ': ' + e.message); return { ok: false, error: e.message }; }
    const k = this.key(win);
    this.st.done[k] = { name, at: Date.now() };
    // keep the record short: a few weeks of shifts is plenty
    const keys = Object.keys(this.st.done); if(keys.length > 200) keys.slice(0, keys.length - 200).forEach(x => delete this.st.done[x]);
    this.st.last = { name, at: Date.now(), from: win.from, to: win.to, shift: win.name, why, notes: (notes || []).length };
    this.save();
    this.log('end of shift report ' + (why === 'automatic' ? 'written' : 'built') + ': ' + name + ' (' + data.crew.count + ' pickers, ' + data.lines.picked + ' lines)');
    if(this.onWritten){ try{ this.onWritten(this.st.last); }catch(e){} }
    return { ok: true, name, url: '/reports/' + encodeURIComponent(name), last: this.st.last };
  }
}

module.exports = { Eos, rank, windowOf, taskLinesOn };
