'use strict';
/* The pack benches, from the exports this service already holds.

   Nothing in EWM is called packing, so this is built out of the two
   movements either side of it, both of which are in the warehouse task
   export with a name, a time and a weight on every row:

     ZLOD  a handling unit leaves a pack station for LOADING. One row is
           one finished unit out of the door, confirmed by the person who
           moved it. The closest thing to output the warehouse writes.

     INTL  an internal move. The ones into PACK and the PK benches are
           work arriving, which is the other half of any argument about
           whether pack is the constraint.

   What this is NOT: a count of cartons sealed. A domestic carton is built
   at the bench and goes straight to LOADING, so it never appears in the
   handling unit snapshot and is never counted on its own. Cartons per
   packer needs a handling unit creation export, which is a different pull.

   It reads whatever the service is already holding, so it is as live as
   the board is, and it works the same on the copy because the copy is
   sent the same rows. */

const PK_BIN = /^PK\d{2}$/i;            // PK02, PK13 - a bench. PK110201 is a picking bin.
const PACK_BIN = /^PACK$/i;
/* Bins that look like benches and are not. PK19, PK26 and PK27 are BOL
   and a hidden pack area on this floor: they take work in, never send a
   unit out, and sat at the bottom of the board flagged as filling up
   for ever. Set `pack.hideBins` in the configuration to change the list
   for a different floor.

   This is module state rather than an argument because isStation is
   asked from a dozen places inside one synchronous build; it is set at
   the top of readTasks and never outlives the call. */
let HIDDEN = new Set(['PK19', 'PK26', 'PK27']);
function setHiddenBins(list){
  if(list == null) return;
  HIDDEN = new Set((Array.isArray(list) ? list : String(list).split(','))
    .map(x => String(x).trim().toUpperCase()).filter(Boolean));
}
const isStation = b => (PK_BIN.test(b) || PACK_BIN.test(b)) && !HIDDEN.has(String(b).toUpperCase());
/* PK01 to PK06 are the truck pack benches; every other station is parcel.
   The two are different work at different speeds and an average across
   both describes neither, so they are counted apart. */
const TRUCK = /^PK0?[1-6]$/i;
const laneOf = bin => TRUCK.test(bin) ? 'truck' : 'parcel';
const WINDOW_MIN = 30;                  // longer than this between scans is a break
const DAY_HOURS = 6.5;                  // a paid shift with breaks taken out

/* Dates arrive as the numbers Excel keeps underneath them: 46252 is a day
   counted from the end of 1899, 0.3458 is a fraction of a day. */
const EPOCH = Date.UTC(1899, 11, 30);
function msOf(day, frac){
  const d = Number(day);
  if(!isFinite(d) || d <= 0) return null;
  const t = Number(frac);
  return EPOCH + Math.round(d) * 86400000 + (isFinite(t) && t > 0 && t < 1 ? Math.round(t * 86400000) : 0);
}
function dayKeyOf(day){
  const ms = msOf(day, 0);
  if(ms == null) return '';
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
const hourOf = frac => { const t = Number(frac); return isFinite(t) && t >= 0 && t < 1 ? t * 24 : null; };
const num = v => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.+-]/g, '')); return isFinite(n) ? n : 0; };
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* The rows the service holds are a header row and everything under it.
   Columns are asked for by name, loosely, because three systems have
   written these files and each capitalised differently. */
function table(rows, expect){
  if(!rows || !rows.length) return null;
  const want = (expect || []).map(norm);
  let h = 0;
  for(let i = 0; i < Math.min(12, rows.length); i++){
    const cells = (rows[i] || []).map(norm);
    if(want.some(w => cells.some(c => c === w || c.indexOf(w) === 0))){ h = i; break; }
  }
  const keyed = (rows[h] || []).map(norm);
  const at = name => {
    const n = norm(name);
    let i = keyed.indexOf(n);
    if(i < 0) i = keyed.findIndex(k => k.indexOf(n) === 0);
    return i;
  };
  const idx = {};
  const get = (row, name) => {
    if(!(name in idx)) idx[name] = at(name);
    const i = idx[name];
    return i < 0 ? '' : String(row[i] == null ? '' : row[i]).trim();
  };
  return { rows: rows.slice(h + 1).filter(r => r && r.some(c => String(c == null ? '' : c).trim())), get, has: n => at(n) >= 0 };
}

/* Time with something moving. Deduplicated, and with no minimum per
   confirmation: units are confirmed in bursts, forty rows sharing one
   timestamp, and crediting each a minute of its own gave people sixteen
   active hours inside a seven-hour shift.

   Counted a day at a time and capped at dayHours, the same basis the
   picker page uses: a paid shift with breaks taken out is worth at most
   that much work, and somebody who was only on the floor for three hours
   is credited with three. Without the cap a packer who clocked a long day
   on a day the export happens to span twice came out with hours no shift
   contains, and their rate read low against a picker's. */
function activeHours(times, opt){
  if(!times.length) return 0;
  const cap = (opt && opt.dayHours > 0 ? opt.dayHours : DAY_HOURS) * 3600000;
  const win = (opt && opt.windowMin > 0 ? opt.windowMin : WINDOW_MIN) * 60000;
  const byDay = new Map();
  for(const ms of new Set(times)){
    const d = Math.floor(ms / 86400000);
    if(!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(ms);
  }
  let total = 0;
  for(const t of byDay.values()){
    t.sort((a, b) => a - b);
    let day = 60000;                    // the last scan is worth a minute
    for(let i = 0; i < t.length - 1; i++) day += Math.min(t[i + 1] - t[i], win);
    total += Math.min(day, cap);
  }
  return total / 3600000;
}

function readTasks(rows, lineKey, hideBins){
  setHiddenBins(hideBins);
  const t = table(rows, ['warehouse task', 'activity', 'confirmed by']);
  const out = { loads: [], feeds: [], picks: [], touches: [], acts: {}, days: {}, rows: t ? t.rows.length : 0,
                ok: !!(t && t.has('activity') && t.has('confirmed by')), volUnit: '',
                /* lines are only lines when a column says so; with nothing
                   chosen a task is a line, and the page says as much rather
                   than printing the same number twice under two headings */
                linesAreTasks: !(lineKey && lineKey.length) };
  if(!out.ok) return out;
  const keys = (lineKey || []).filter(Boolean);
  for(const r of t.rows){
    const act = t.get(r, 'activity').toUpperCase();
    const who = t.get(r, 'confirmed by').toUpperCase();
    const day = t.get(r, 'confirmation date'), frac = t.get(r, 'confirmation time');
    const at = msOf(day, frac);
    if(act) out.acts[act] = (out.acts[act] || 0) + 1;
    if(!at || !who) continue;
    const rec = { who, at, hour: hourOf(frac), day: dayKeyOf(day),
                  src: t.get(r, 'source storage bin').toUpperCase(),
                  dst: (t.get(r, 'dest stor bin') || t.get(r, 'dest storage bin')).toUpperCase(),
                  /* On a ZLOD row this is the unit leaving the bench; on a
                     pick it is the unit the stock was picked INTO. Same
                     number on both sides, which is the join that puts
                     delivery lines on a packer's name. */
                  hu: t.get(r, 'source handling unit') || t.get(r, 'dest handling unit'),
                  huIn: t.get(r, 'dest handling unit'),
                  lb: num(t.get(r, 'loading weight')),
                  /* cube is the one measure of a packer's work besides
                     weight that survives on every row a packer makes */
                  vol: num(t.get(r, 'loading volume')),
                  /* the delivery line this task belongs to, when the
                     picker settings name the columns that identify one */
                  /* every part of the key has to be there or it is not a
                     line. An INTL move carries no delivery and no item, so
                     joining two blanks gave every one of them the same
                     one-character key and a whole floor collapsed to a
                     single "line" arriving. */
                  line: keys.length ? (function(){
                    const parts = keys.map(k => t.get(r, k));
                    return parts.every(x => x !== '') ? parts.join('') : '';
                  })() : '',
                  doc: keys.length ? t.get(r, keys[0]) : '' };
    if(rec.day) out.days[rec.day] = (out.days[rec.day] || 0) + 1;
    /* the floor's own unit, shown rather than assumed - a cube figure with
       no unit on it is a number nobody can argue with or about */
    if(!out.volUnit && rec.vol > 0) out.volUnit = t.get(r, 'volume unit');
    if(isStation(rec.src) || isStation(rec.dst)) out.touches.push(rec);
    if(act === 'ZLOD') out.loads.push(rec);
    else if(act === 'PICK'){ out.picks.push(rec); if(isStation(rec.dst)){ rec.fed = 'pick'; out.feeds.push(rec); } }
    else if(act === 'INTL' && isStation(rec.dst)){ rec.fed = 'move'; out.feeds.push(rec); }
  }

  /* What is in each handling unit, from the picks that filled it.

     A packer's own row says nothing about lines - the delivery and the
     item are blank on every ZLOD row in the export - but the picks that
     fed the unit carry both, and a pick's destination handling unit is
     the unit the packer later sends out. So the lines are counted here
     and credited to whoever moved the unit.

     What this cannot see: a unit built from picks that fall outside the
     window the pull asked for. Those come back as nought lines rather
     than wrong ones, and the share that resolved is reported with the
     number so nobody reads a rate built on a third of the work. */
  if(keys.length){
    const byHu = new Map();
    for(const p of out.picks){
      if(!p.huIn || !p.line) continue;
      let e = byHu.get(p.huIn);
      if(!e){ e = { lines: new Set(), docs: new Set() }; byHu.set(p.huIn, e); }
      e.lines.add(p.line);
      /* the first of the line key columns is the delivery, so the orders
         in a carton come out of the same join the lines do */
      if(p.doc) e.docs.add(p.doc);
    }
    out.huLines = byHu.size;
    for(const l of out.loads){
      const e = l.hu ? byHu.get(l.hu) : null;
      l.lines = e ? e.lines.size : 0;
      l.docs = e ? Array.from(e.docs) : [];
      l.known = !!e;
    }
    out.resolved = out.loads.filter(l => l.known).length;
  } else {
    for(const l of out.loads){ l.lines = 0; l.docs = []; l.known = false; }
    out.huLines = 0; out.resolved = 0;
  }
  return out;
}

function readOrders(rows){
  const t = table(rows, ['consolidation group', 'picking status']);
  const out = { ok: !!(t && t.has('consolidation group')), deliveries: 0, lines: 0, byLines: {}, picked: 0, partial: 0, open: 0 };
  if(!out.ok) return out;
  const g = new Map();
  for(const r of t.rows){
    const cg = t.get(r, 'consolidation group');
    if(!cg) continue;
    const st = t.get(r, 'picking status').toLowerCase();
    let x = g.get(cg);
    if(!x){ x = { lines: 0, open: 0, part: 0 }; g.set(cg, x); }
    x.lines++;
    if(st.indexOf('complet') === 0) ; else if(st.indexOf('partial') >= 0) x.part++; else x.open++;
  }
  out.deliveries = g.size;
  for(const x of g.values()){
    out.lines += x.lines;
    const k = x.lines >= 6 ? '6+' : String(x.lines);
    out.byLines[k] = (out.byLines[k] || 0) + 1;
    if(x.open === 0 && x.part === 0) out.picked++;
    else if(x.open < x.lines) out.partial++;
    else out.open++;
  }
  return out;
}

/* The handling unit snapshot, for what is standing at a bench. The staging
   pull asks only for the lanes, so until the pack bins are pulled as well
   this sees nothing and the page says so rather than drawing an empty
   queue. */
function readUnits(rows){
  const t = table(rows, ['handling unit', 'packaging material']);
  const out = { ok: !!(t && t.has('packaging material')), byBin: {}, cartons: [] };
  if(!out.ok) return out;
  for(const r of t.rows){
    const bin = t.get(r, 'storage bin').toUpperCase();
    if(bin) out.byBin[bin] = (out.byBin[bin] || 0) + 1;
    const mat = t.get(r, 'packaging material').toUpperCase();
    if(mat.indexOf('CARTON') >= 0 || mat.indexOf('PALLET') >= 0){
      out.cartons.push({ by: t.get(r, 'created by').toUpperCase(), day: dayKeyOf(t.get(r, 'created on')), bin });
    }
  }
  return out;
}

/* What the pull itself said about the task export, carried onto the page.
   Reading a log on the host is a different machine, a different tab and a
   different frame of mind from looking at an empty board, and the two
   have been kept apart for days while the answer sat in one of them.
   Both copies can do this: the host has its own log, the copy is sent the
   tail of it with every push. */
function pullNotes(app){
  let lines = [];
  try{ lines = (app.puller && app.puller.tail) ? app.puller.tail(120) : []; }catch(e){ lines = []; }
  return lines
    .filter(l => /WT:|selection screen|PROCTY|opened the task/i.test(String(l)))
    .slice(-8)
    .map(l => String(l));
}

/* ------------------------------------------------------------------ *
   A day, rolled up.

   The page used to be "whatever is in the current export", which meant
   every number on it was summed across however many days the pull
   happened to cover, and there was no way to ask for last week. The
   export cannot be widened - asking SAP for four days of creation dates
   came back with 62,693 rows and the export ran past the cycle timeout -
   so the window stays narrow and what it holds is rolled up a day at a
   time and kept, the way the picker page has always done it.

   A block is one day, or one shift of one day, reduced to numbers that
   add up. Everything the page draws has to survive being summed across
   thirty of them, which is why the weights are a histogram rather than a
   list and why active hours are capped per day before they are stored.  */

const HALF = 0.5;                       // weight histogram bin, in pounds

function blank(){
  return { out: 0, lb: 0, vol: 0, lines: 0, known: 0, orders: 0, units: 0, fedIn: 0, inLines: 0,
           linesIn: false, linesOut: false, inPick: 0, inMove: 0,
           picks: 0, moves: 0, days: 0,
           /* truck pack and parcel counted apart, with the hours a person
              spent on each apportioned by where their units went out */
           lane: { truck: { out: 0, lines: 0, hours: 0, people: {} },
                   parcel: { out: 0, lines: 0, hours: 0, people: {} } },
           pickers: {}, bench: {}, who: {}, hr: {}, bhr: {},
           w: { n: 0, whole: 0, max: 0, hist: {} } };
}
const benchOf = (b, bin) => (b.bench[bin] = b.bench[bin] ||
  { out: 0, in: 0, inPick: 0, inMove: 0, inLines: 0, lb: 0, vol: 0, lines: 0, known: 0, openMin: 0, last: 0, first: 0,
    gapMed: null, gapMax: null, gapsOver: 0, activeMin: 0, people: {} });
const whoOf = (b, who) => (b.who[who] = b.who[who] ||
  { out: 0, lb: 0, vol: 0, lines: 0, known: 0, moves: 0, hours: 0, span: 0, first: 0, last: 0, days: 0, bins: {} });
const hrOf = (into, h) => (into[h] = into[h] || [0, 0]);

/* One day of rows into one block. The timestamps go in and do not come
   out: what is kept is what can be added to another day. */
function blockOf(loads, feeds, touches, picks, opt){
  const b = blank();
  b.days = 1;
  b.out = loads.length;
  b.fedIn = feeds.length;
  /* distinct lines arriving, counted inside the day. Two days that each
     touched the same line count it twice when they are added together,
     which is right for a rate and worth knowing for a total. */
  /* Only count lines arriving when the rows actually carry one. A floor
     fed by INTL moves has no delivery on them at all, and falling back to
     the task count silently relabels picks as lines. */
  /* a pick landing at a bench and an internal move landing at a bench
     are both "work arriving" and they are not the same work: on this
     floor the moves outnumber the picks four to one, which is what makes
     arriving look wild against output until the two are shown apart */
  b.inPick = feeds.filter(r => r.fed === 'pick').length;
  b.inMove = feeds.filter(r => r.fed === 'move').length;
  const inLineSet = new Set(feeds.map(r => r.line).filter(Boolean));
  b.linesIn = inLineSet.size > 0;
  b.inLines = b.linesIn ? inLineSet.size : feeds.length;
  b.picks = picks.length;
  b.units = new Set(loads.map(r => r.hu).filter(Boolean)).size;
  picks.forEach(r => { b.pickers[r.who] = (b.pickers[r.who] || 0) + 1; });

  const benchTimes = {};
  const orderSet = new Set();
  loads.forEach(r => {
    b.lb += r.lb;
    b.vol += r.vol;
    b.lines += r.lines || 0;
    if(r.known) b.known++;
    if(isStation(r.src)){
      const L = b.lane[laneOf(r.src)];
      L.out++; L.lines += r.lines || 0; L.people[r.who] = (L.people[r.who] || 0) + 1;
    }
    (r.docs || []).forEach(d => orderSet.add(d));
    if(r.lb > 0){
      b.w.n++;
      if(Math.abs(r.lb - Math.round(r.lb)) < 1e-9) b.w.whole++;
      if(r.lb > b.w.max) b.w.max = r.lb;
      const k = String(Math.round(r.lb / HALF) * HALF);
      b.w.hist[k] = (b.w.hist[k] || 0) + 1;
    }
    if(r.hour != null) hrOf(b.hr, Math.floor(r.hour))[0]++;
    if(isStation(r.src)){
      const s = benchOf(b, r.src);
      s.out++; s.lb += r.lb; s.vol += r.vol; s.lines += r.lines || 0; if(r.known) s.known++;
      s.people[r.who] = (s.people[r.who] || 0) + 1;
      if(r.at > s.last) s.last = r.at;
      if(!s.first || r.at < s.first) s.first = r.at;
      (benchTimes[r.src] = benchTimes[r.src] || []).push(r.at);
      if(r.hour != null) hrOf(b.bhr[r.src] = b.bhr[r.src] || {}, Math.floor(r.hour))[0]++;
    }
  });
  const benchLines = {};
  feeds.forEach(r => {
    if(r.hour != null) hrOf(b.hr, Math.floor(r.hour))[1]++;
    if(isStation(r.dst)){
      const st = benchOf(b, r.dst);
      st.in++;
      if(r.fed === 'pick') st.inPick++; else st.inMove++;
      if(r.line) (benchLines[r.dst] = benchLines[r.dst] || new Set()).add(r.line);
      if(r.hour != null) hrOf(b.bhr[r.dst] = b.bhr[r.dst] || {}, Math.floor(r.hour))[1]++;
    }
  });
  /* how long the bench was open, and the middle gap between units leaving
     it. The gap is kept because on a single day it is the honest answer;
     across a range it cannot be averaged and the open time answers
     instead. */
  for(const bin in b.bench) b.bench[bin].inLines = benchLines[bin] ? benchLines[bin].size : b.bench[bin].in;
  /* and the same for the carton join: nought traced is a fact worth
     printing, not a dash */
  b.linesOut = b.known > 0;
  for(const bin in benchTimes){
    const t = benchTimes[bin].sort((x, y) => x - y);
    const s = b.bench[bin];
    s.openMin = t.length > 1 ? Math.round((t[t.length - 1] - t[0]) / 60000) : 0;
    const gaps = [];
    for(let i = 1; i < t.length; i++){ const m = (t[i] - t[i - 1]) / 60000; if(m <= 120) gaps.push(m); }
    gaps.sort((x, y) => x - y);
    s.gapMed = gaps.length ? Math.round(gaps[gaps.length >> 1] * 10) / 10 : null;
    /* the longest run of minutes with nothing leaving, and how often it
       ran past half an hour. Unlike a median these survive being added
       up: the biggest of two days is still the biggest. */
    s.gapMax = gaps.length ? Math.round(gaps[gaps.length - 1]) : null;
    s.gapsOver = gaps.filter(m => m >= 30).length;
    /* time with something moving at this bench, on the same rule a person
       gets: every gap counted up to the active window and no further */
    s.activeMin = Math.round(gaps.reduce((a, m) => a + Math.min(m, (opt && opt.windowMin) || WINDOW_MIN), 0) + 1);
  }

  const stamps = {};
  touches.forEach(r => {
    (stamps[r.who] = stamps[r.who] || []).push(r.at);
    const p = whoOf(b, r.who);
    if(isStation(r.src)) p.bins[r.src] = p.bins[r.src] || 0;
    else if(isStation(r.dst)) p.bins[r.dst] = p.bins[r.dst] || 0;
  });
  loads.forEach(r => {
    const p = whoOf(b, r.who);
    p.out++; p.lb += r.lb; p.vol += r.vol; p.lines += r.lines || 0; if(r.known) p.known++;
    if(isStation(r.src)) p.bins[r.src] = (p.bins[r.src] || 0) + 1;
    if(!stamps[r.who]) (stamps[r.who] = []).push(r.at);
  });
  for(const who in b.who){
    const t = Array.from(new Set(stamps[who] || [])).sort((x, y) => x - y);
    const p = b.who[who];
    p.days = 1;
    p.moves = Math.max(0, t.length - p.out);
    /* capped here, once, so a range is a sum of capped days and never a
       packer credited with more hours than any shift contains */
    p.hours = Math.round(activeHours(t, opt) * 1000) / 1000;
    p.span = t.length > 1 ? Math.round((t[t.length - 1] - t[0]) / 3600000 * 1000) / 1000 : 0;
    p.first = t[0] || 0;
    p.last = t[t.length - 1] || 0;
  }
  b.moves = Object.values(b.who).reduce((a, p) => a + p.moves, 0);
  b.orders = orderSet.size;
  /* a packer who worked both lanes gets their hours split the way their
     units were - the only apportionment the rows support */
  for(const who in b.who){
    const p = b.who[who];
    if(!p.out || !p.hours) continue;
    ['truck', 'parcel'].forEach(k => {
      const n = b.lane[k].people[who] || 0;
      if(n) b.lane[k].hours += p.hours * (n / p.out);
    });
  }
  ['truck', 'parcel'].forEach(k => { b.lane[k].hours = Math.round(b.lane[k].hours * 1000) / 1000; });
  return b;
}

/* Every day in the export, whole and split by shift. The shift a row
   belongs to is decided here rather than when the page asks, which is
   what the picker history does - the schedule can change afterwards
   without rewriting what was already true. */
function rollup(tasks, opt, sched){
  const byDay = {};
  const bucket = r => {
    const d = r.day;
    if(!d) return null;
    return (byDay[d] = byDay[d] || { loads: [], feeds: [], touches: [], picks: [] });
  };
  tasks.loads.forEach(r => { const g = bucket(r); if(g) g.loads.push(r); });
  tasks.feeds.forEach(r => { const g = bucket(r); if(g) g.feeds.push(r); });
  tasks.touches.forEach(r => { const g = bucket(r); if(g) g.touches.push(r); });
  tasks.picks.forEach(r => { const g = bucket(r); if(g) g.picks.push(r); });

  const shiftName = (day, h) => {
    if(!sched || h == null) return null;
    try{ return (sched.at(day, h) || {}).name || null; }catch(e){ return null; }
  };
  const out = {};
  for(const day in byDay){
    const g = byDay[day];
    const rec = { at: Date.now(), all: blockOf(g.loads, g.feeds, g.touches, g.picks, opt), shifts: {} };
    const names = new Set();
    ['loads', 'feeds', 'touches', 'picks'].forEach(k => g[k].forEach(r => {
      const n = shiftName(day, r.hour);
      if(n) names.add(n);
    }));
    for(const n of names){
      const pick = k => g[k].filter(r => shiftName(day, r.hour) === n);
      rec.shifts[n] = blockOf(pick('loads'), pick('feeds'), pick('touches'), pick('picks'), opt);
    }
    out[day] = rec;
  }
  return out;
}

/* Two blocks into one. Scalars add, maps deep-merge, the middle gap is
   dropped because a median of medians is not a median. */
function add(a, b){
  if(!a) return JSON.parse(JSON.stringify(b));
  ['out', 'lb', 'vol', 'lines', 'known', 'orders', 'units', 'fedIn', 'inLines', 'inPick', 'inMove', 'picks', 'moves', 'days']
    .forEach(k => { a[k] += b[k] || 0; });
  a.linesIn = a.linesIn || b.linesIn; a.linesOut = a.linesOut || b.linesOut;
  ['truck', 'parcel'].forEach(k => {
    const x = a.lane[k], y = (b.lane && b.lane[k]) || { out: 0, lines: 0, hours: 0, people: {} };
    x.out += y.out; x.lines += y.lines; x.hours += y.hours;
    for(const w in y.people) x.people[w] = (x.people[w] || 0) + y.people[w];
  });
  for(const w in b.pickers) a.pickers[w] = (a.pickers[w] || 0) + b.pickers[w];
  for(const bin in b.bench){
    const x = benchOf(a, bin), y = b.bench[bin];
    x.out += y.out; x.in += y.in; x.inPick += y.inPick || 0; x.inMove += y.inMove || 0;
    x.inLines += y.inLines; x.lb += y.lb; x.vol += y.vol;
    x.lines += y.lines; x.known += y.known; x.openMin += y.openMin; x.gapsOver += y.gapsOver || 0;
    x.activeMin += y.activeMin || 0;
    if(y.gapMax != null && (x.gapMax == null || y.gapMax > x.gapMax)) x.gapMax = y.gapMax;
    if(y.last > x.last) x.last = y.last;
    if(!x.first || (y.first && y.first < x.first)) x.first = y.first;
    x.gapMed = null;
    for(const w in y.people) x.people[w] = (x.people[w] || 0) + y.people[w];
  }
  for(const who in b.who){
    const x = whoOf(a, who), y = b.who[who];
    ['out', 'lb', 'vol', 'lines', 'known', 'moves', 'hours', 'span', 'days'].forEach(k => { x[k] += y[k] || 0; });
    if(y.last > x.last) x.last = y.last;
    if(!x.first || (y.first && y.first < x.first)) x.first = y.first;
    for(const bin in y.bins) x.bins[bin] = (x.bins[bin] || 0) + y.bins[bin];
  }
  for(const h in b.hr){ const t = hrOf(a.hr, h); t[0] += b.hr[h][0]; t[1] += b.hr[h][1]; }
  for(const bin in b.bhr){
    const into = a.bhr[bin] = a.bhr[bin] || {};
    for(const h in b.bhr[bin]){ const t = hrOf(into, h); t[0] += b.bhr[bin][h][0]; t[1] += b.bhr[bin][h][1]; }
  }
  a.w.n += b.w.n; a.w.whole += b.w.whole;
  if(b.w.max > a.w.max) a.w.max = b.w.max;
  for(const k in b.w.hist) a.w.hist[k] = (a.w.hist[k] || 0) + b.w.hist[k];
  return a;
}

/* A percentile out of the histogram. Half-pound bins, so the answer is
   an observed weight to within half a pound - which is finer than any
   argument anybody is going to have about it. */
function pct(hist, n, q){
  if(!n) return 0;
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  const want = Math.max(1, Math.floor(n * q));
  let acc = 0;
  for(const k of keys){ acc += hist[String(k)]; if(acc >= want) return k; }
  return keys.length ? keys[keys.length - 1] : 0;
}

/* The block as the page reads it. */
function present(b, extra){
  const ex = extra || {};
  const queueAt = ex.queue || {};
  const one = b.days === 1;
  const crew = Object.keys(b.who).filter(w => b.who[w].out > 0);
  const crewHours = crew.reduce((a, w) => a + b.who[w].hours, 0);

  const people = Object.keys(b.who).map(w => {
    const p = b.who[w];
    return { who: w, out: p.out, moves: p.moves, lb: Math.round(p.lb),
             vol: Math.round(p.vol * 10) / 10,
             /* delivery lines in the units they sent out, and the share of
                those units whose picks were inside the window - a rate off
                a third of the work is not a rate */
             lines: p.lines,
             linesRate: (p.hours > 0.2 && p.known) ? Math.round(p.lines / p.hours * 10) / 10 : null,
             seen: p.out > 0 ? Math.round(p.known / p.out * 100) : 0,
             /* cube an hour, the one workload measure besides units that
                every row a packer makes carries */
             volRate: p.hours > 0.2 ? Math.round(p.vol / p.hours * 100) / 100 : null,
             hours: Math.round(p.hours * 10) / 10, span: Math.round(p.span * 10) / 10,
             days: p.days,
             productive: p.span > 0.5 ? Math.min(100, Math.round(p.hours / p.span * 100)) : null,
             rate: p.hours > 0.2 ? Math.round(p.out / p.hours * 10) / 10 : null,
             first: one ? p.first : 0, last: one ? p.last : 0,
             stations: Object.keys(p.bins).filter(Boolean).sort(), byBin: p.bins };
  }).sort((x, y) => y.out - x.out || y.moves - x.moves);

  const prod = people.filter(p => p.productive != null && (p.out + p.moves) >= 5)
    .map(p => p.productive).sort((x, y) => x - y);

  const stations = Object.keys(b.bench).map(bin => {
    const s = b.bench[bin];
    return { bin, out: s.out, in: s.in, inPick: s.inPick, inMove: s.inMove, inLines: s.inLines, lines: s.lines,
             seen: s.out > 0 ? Math.round(s.known / s.out * 100) : 0,
             lb: Math.round(s.lb),
             vol: Math.round(s.vol * 10) / 10,
             people: Object.keys(s.people).length, last: one ? s.last : 0,
             gapMed: one ? s.gapMed : null,
             gapMax: s.gapMax, gapsOver: s.gapsOver, activeMin: s.activeMin,
             /* across a range this is bench-open minutes per unit, which is
                the only pace figure that survives being added up */
             perUnitMin: s.out > b.days ? Math.round(s.openMin / (s.out - b.days) * 10) / 10 : null,
             queue: queueAt[bin] || 0 };
  }).sort((x, y) => y.out - x.out || x.bin.localeCompare(y.bin));

  const hours = Object.keys(b.hr).map(h => ({ hour: +h, out: b.hr[h][0], in: b.hr[h][1] }))
    .sort((x, y) => x.hour - y.hour);
  const benchHours = {};
  for(const bin in b.bhr){
    benchHours[bin] = Object.keys(b.bhr[bin]).map(h => ({ hour: +h, out: b.bhr[bin][h][0], in: b.bhr[bin][h][1] }))
      .sort((x, y) => x.hour - y.hour);
  }
  const w = b.w;
  return {
    summary: {
      out: b.out, units: b.units, lb: Math.round(b.lb),
      vol: Math.round(b.vol * 10) / 10,
      volPerHour: crewHours > 0.2 ? Math.round(b.vol / crewHours * 100) / 100 : null,
      inLines: b.inLines,
      lines: b.lines,
      orders: b.orders,
      /* whether a line is a real thing on each side, rather than a task
         wearing the word */
      linesIn: !!b.linesIn, linesOut: !!b.linesOut,
      inPick: b.inPick, inMove: b.inMove,
      linesPerHour: (crewHours > 0.2 && b.known) ? Math.round(b.lines / crewHours * 10) / 10 : null,
      /* the two lanes, each with its own rate, because an average across
         truck pack and parcel describes neither of them */
      lane: ['truck', 'parcel'].reduce((o, k) => {
        const L = b.lane[k];
        o[k] = { out: L.out, lines: L.lines, hours: Math.round(L.hours * 10) / 10,
                 people: Object.keys(L.people).length,
                 linesPerHour: (L.hours > 0.2 && L.lines) ? Math.round(L.lines / L.hours * 10) / 10 : null };
        return o;
      }, {}),
      /* the share of units out whose contents could be traced back to the
         picks that filled them */
      seen: b.out > 0 ? Math.round(b.known / b.out * 100) : 0,
      packers: crew.length, helpers: Object.keys(b.who).length - crew.length,
      stations: stations.filter(s => s.out > 0).length,
      fedIn: b.fedIn,
      crewHours: Math.round(crewHours * 10) / 10,
      perHour: crewHours > 0.2 ? Math.round(b.out / crewHours * 10) / 10 : null,
      productive: prod.length ? prod[prod.length >> 1] : null,
      picks: b.picks, pickers: Object.keys(b.pickers).length,
      perDay: b.days > 1 ? Math.round(b.out / b.days) : null
    },
    stations, people, hours, benchHours,
    weights: {
      n: w.n, whole: w.whole, wholePct: w.n ? Math.round(w.whole / w.n * 100) : 0,
      median: pct(w.hist, w.n, 0.5), p90: pct(w.hist, w.n, 0.9), max: w.max,
      buckets: (() => {
        const edges = [[0, 5, 'under 5 lb'], [5, 15, '5 to 15'], [15, 30, '15 to 30'],
                       [30, 70, '30 to 70'], [70, Infinity, '70 lb and up']];
        return edges.map(([lo, hi, lab]) => {
          let n = 0;
          for(const k in w.hist){ const v = +k; if(v >= lo && v < hi) n += w.hist[k]; }
          return [lab, n];
        });
      })()
    }
  };
}

/* The two things a rollup needs from the rest of the service: what a day
   of work is worth, and which shift an hour belongs to. Both come from
   the picker settings, so one number moves both pages and a shift means
   the same thing on each. */
function settingsOf(app){
  let opt = { dayHours: DAY_HOURS, windowMin: WINDOW_MIN };
  let sched = null, shiftNames = [], lineKey = [], hideBins = null;
  try{
    const st = app.pickers && app.pickers.settings();
    if(st){
      opt = { dayHours: st.dayHours || DAY_HOURS, windowMin: st.windowMin || WINDOW_MIN };
      lineKey = st.lineKey || [];
      if(st.hideBins) hideBins = st.hideBins;
      if(st.sched && st.sched.length){
        const schedule = require('./schedule');
        sched = { at: (day, h) => schedule.shiftAt(st.sched, day, h) };
        shiftNames = schedule.names(st.sched);
      }
    }
  }catch(e){}
  return { opt, sched, shiftNames, lineKey, hideBins };
}

/* Work the line key out rather than wait to be told it.

   The Columns pane can name it and now has a button that sets it, and
   the board still came up with four dashes and a note telling somebody
   to go and press that button. A number nobody can see is not an
   improvement on a number nobody asked for, so the model finds the pair
   itself: a delivery column and an item column, both filled in on nearly
   every pick, which together group picks into something between one and
   six picks a line. That is the same test the pane applies, applied
   without being asked.

   A key saved in the settings always wins. This is the floor it falls to,
   and the page says which of the two it is using. */
let DETECTED = { v: -1, key: null };
function detectLineKey(rows, version){
  if(DETECTED.v === version) return DETECTED.key;
  let key = null;
  try{
    const t = table(rows, ['warehouse task', 'activity', 'confirmed by']);
    if(t && t.has('activity')){
      let hi = 0;
      for(let i = 0; i < Math.min(12, rows.length); i++)
        if((rows[i] || []).some(c => norm(c) === 'activity')){ hi = i; break; }
      const names = (rows[hi] || []).map(c => String(c == null ? '' : c).trim());
      const ai = names.findIndex(c => norm(c) === 'activity');
      const picks = rows.slice(hi + 1).filter(r => r && String(r[ai] == null ? '' : r[ai]).trim().toUpperCase() === 'PICK');
      if(picks.length >= 20){
        const like = (n, w) => w.some(x => norm(n).indexOf(x) >= 0);
        const no = n => ['weight', 'volume', 'qty', 'quantity', 'date', 'time', 'description', 'category', 'unit']
          .some(x => norm(n).indexOf(x) >= 0);
        const docs = names.filter(n => n && !no(n) && like(n, ['document', 'delivery']));
        const items = names.filter(n => n && !no(n) && like(n, ['item', 'position']));
        let best = null;
        for(const d of docs) for(const it of items){
          if(d === it) continue;
          const ci = names.indexOf(d), cj = names.indexOf(it);
          const seen = new Set();
          let full = 0;
          for(const r of picks){
            const a1 = String(r[ci] == null ? '' : r[ci]).trim(), b1 = String(r[cj] == null ? '' : r[cj]).trim();
            if(!a1 || !b1) continue;
            full++; seen.add(a1 + '' + b1);
          }
          if(!seen.size) continue;
          const fill = full / picks.length, per = full / seen.size;
          if(fill < 0.95 || per < 1 || per > 6) continue;
          /* the nearest to one pick a line wins: that is a line key doing
             its job rather than a column that happens to group */
          if(!best || per < best.per) best = { key: [d, it], per };
        }
        if(best) key = best.key;
      }
    }
  }catch(e){ key = null; }
  DETECTED = { v: version, key };
  return key;
}

function build(app, q){
  const ing = app.ingest;
  const { opt, sched, shiftNames, lineKey, hideBins } = settingsOf(app);

  const whRows = ing.fullRows('wh');
  /* a key in the settings wins; otherwise take the one the export itself
     points at, and say which */
  let keyFrom = lineKey.length ? 'set' : 'none';
  let useKey = lineKey;
  let betterKey = null;
  const found = detectLineKey(whRows, ing.version);
  if(!lineKey.length){
    if(found){ useKey = found; keyFrom = 'found'; }
  } else if(found && found.join(',') !== lineKey.join(',')){
    /* A key somebody saved wins - it is a decision, not a guess. But a
       saved key that finds a fraction of the lines a different pair
       finds is a decision made on bad information, and saying nothing
       about it leaves a board full of dashes and nobody any the wiser. */
    betterKey = found;
  }
  const tasks = readTasks(whRows, useKey, hideBins);
  const orders = readOrders(ing.fullRows('orders'));
  const units = readUnits(ing.fullRows('stage'));

  const queueAt = {};
  let queueKnown = false;
  for(const bin of Object.keys(units.byBin || {})){
    if(!isStation(bin)) continue;
    queueAt[bin] = units.byBin[bin];
    queueKnown = true;
  }

  /* What the export holds right now, rolled up the same way the stored
     days are, so today never has to wait for a write to show up. */
  const live = rollup(tasks, opt, sched);
  const hist = (app.packHist && app.packHist.history) || {};

  const want = (q && q.days > 0) ? q.days : 1;
  const base = (q && q.base) || Object.keys(live).sort().pop() ||
               Object.keys(hist).sort().pop() || '';
  const shift = (q && q.shift) || null;

  const keys = [];
  if(base){
    const t = Date.UTC(+base.slice(0, 4), +base.slice(5, 7) - 1, +base.slice(8, 10));
    for(let i = 0; i < want; i++){
      const d = new Date(t - i * 86400000);
      keys.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') +
                '-' + String(d.getUTCDate()).padStart(2, '0'));
    }
  }

  let total = null, had = [];
  for(const k of keys){
    /* the live export wins when it holds more of a day than the store
       does - it is the same rows, read again, and a day it covers whole
       is fresher than anything written earlier */
    const l = live[k], h = hist[k];
    const rec = (!h || (l && l.all.out + l.all.fedIn >= h.all.out + h.all.fedIn)) ? l : h;
    if(!rec) continue;
    const blk = shift ? (rec.shifts && rec.shifts[shift]) : rec.all;
    if(!blk || (!blk.out && !blk.fedIn)) continue;
    total = add(total, blk);
    had.push(k);
  }
  had.sort();
  if(!total) total = blank();

  const live0 = want === 1 && !(q && q.offset);
  const one = total.days === 1;
  const body = present(total, { queue: live0 ? queueAt : {} });

  return Object.assign({
    builtAt: Date.now(),
    version: ing.version,
    range: { days: want, base, offset: (q && q.offset) || 0, shift: shift || '', had: had.length, covered: had },
    shiftNames,
    lineKey: useKey,
    lineKeyFrom: keyFrom,
    betterKey: betterKey,
    hideBins: hideBins || [],
    volUnit: tasks.volUnit || '',
    linesAreTasks: !!tasks.linesAreTasks,
    days: had,
    day: had.length ? had[had.length - 1] : '',
    stored: Object.keys(hist).sort(),
    /* which days the export in hand actually covers, so a page that comes
       up empty for today can say whether the pull is behind rather than
       leaving somebody to go and find the log */
    exportDays: Object.keys(tasks.days).sort(),
    activities: tasks.acts,
    taskRows: tasks.rows,
    notes: pullNotes(app),
    source: (() => {
      let d = null;
      try{ d = (ing.diag() || {}).wh || null; }catch(e){}
      return d ? { name: d.name || '', rows: d.rows || 0, readAt: d.readAt || null, status: d.status || '' } : null;
    })(),
    have: { tasks: tasks.ok || had.length > 0, orders: orders.ok, units: units.ok },
    /* An export with rows in it and no ZLOD among them is a broken pull,
       and the panel that says so is what found the last one. An empty
       RANGE is a different thing entirely - history that was never kept -
       so the diagnostic is only raised against the live view. */
    gap: { loads: live0 && tasks.ok && tasks.rows > 0 && tasks.loads.length === 0,
           picksOnly: live0 && tasks.ok && tasks.loads.length === 0 && tasks.picks.length > 0 },
    queueKnown: queueKnown && live0,
    /* the open order book is a picture of right now and has no history,
       so it is only shown against a range that ends today */
    orders: (orders.ok && live0) ? {
      deliveries: orders.deliveries, lines: orders.lines,
      perDelivery: orders.deliveries ? Math.round(orders.lines / orders.deliveries * 100) / 100 : 0,
      single: orders.byLines['1'] || 0,
      singlePct: orders.deliveries ? Math.round((orders.byLines['1'] || 0) / orders.deliveries * 100) : 0,
      byLines: orders.byLines, picked: orders.picked
    } : null
  }, body);
}

module.exports = { build, rollup, add, blank, present, readTasks, settingsOf, setHiddenBins, isStation, activeHours };

/* ------------------------------------------------------------------ *
   What the task export actually carries, one activity at a time.

   The question this answers: can a packer be measured in lines, or only
   in handling units? A ZLOD row is a handling unit going to LOADING, and
   in EWM an HU-level task often leaves the item-level fields empty - so
   the column that identifies a delivery line on a PICK row can be blank
   on the row that says a packer sent something out. Rather than guess at
   column names, this reports every column in the file against each
   activity: how often it is filled, how many different values it has, and
   therefore whether it identifies a row, groups rows, or says nothing.

   It reads the export the service is already holding. No pull, no Excel,
   no trip to the host. */
function probeColumns(app, opt){
  const rows = app.ingest.fullRows('wh');
  const t = table(rows, ['warehouse task', 'activity', 'confirmed by']);
  if(!t) return { ok: false, why: 'no warehouse task export is loaded' };
  /* the header row, found the same way table() finds it */
  let hi = 0;
  for(let i = 0; i < Math.min(12, rows.length); i++){
    if((rows[i] || []).some(c => norm(c) === 'activity')){ hi = i; break; }
  }
  const names = (rows[hi] || []).map(c => String(c == null ? '' : c).trim());
  const body = rows.slice(hi + 1).filter(r => r && r.some(c => String(c == null ? '' : c).trim()));
  const ai = (rows[hi] || []).findIndex(c => norm(c) === 'activity');
  if(ai < 0) return { ok: false, why: 'the export has no Activity column' };

  const want = (opt && opt.acts) || ['ZLOD', 'PICK', 'INTL'];
  const out = { ok: true, rows: body.length, header: names, acts: {}, columns: [] };
  const sets = {};
  want.forEach(a => { out.acts[a] = 0; sets[a] = names.map(() => new Set()); });
  const filled = {};
  want.forEach(a => { filled[a] = names.map(() => 0); });

  for(const r of body){
    const a = String(r[ai] == null ? '' : r[ai]).trim().toUpperCase();
    if(!(a in out.acts)) continue;
    out.acts[a]++;
    for(let c = 0; c < names.length; c++){
      const v = String(r[c] == null ? '' : r[c]).trim();
      if(!v || v === '0' || v === '0.000') continue;
      filled[a][c]++;
      /* a column with a value a row is an id, not a key worth keeping
         every value of; cap the set so a 60,000 row file stays cheap */
      if(sets[a][c].size < 50000) sets[a][c].add(v);
    }
  }
  for(let c = 0; c < names.length; c++){
    if(!names[c]) continue;
    const col = { name: names[c], by: {} };
    let any = false;
    want.forEach(a => {
      const n = out.acts[a];
      if(!n) return;
      const f = filled[a][c], d = sets[a][c].size;
      if(f) any = true;
      col.by[a] = { filledPct: Math.round(f / n * 100), distinct: d,
                    /* rows per distinct value: 1 means it names the row,
                       more means it groups rows, 0 means it is empty */
                    per: d ? Math.round(f / d * 10) / 10 : 0 };
    });
    if(any) out.columns.push(col);
  }

  /* what the picker page was told a line is, and whether that survives on
     the rows a packer makes */
  let lineKey = [];
  try{ lineKey = ((app.pickers && app.pickers.settings()) || {}).lineKey || []; }catch(e){}
  out.lineKey = lineKey;
  const onZlod = n => {
    const c = out.columns.find(x => norm(x.name) === norm(n) || norm(x.name).indexOf(norm(n)) === 0);
    return c && c.by.ZLOD ? c.by.ZLOD : null;
  };
  out.lineKeyOnZlod = lineKey.map(n => ({ name: n, zlod: onZlod(n) }));

  /* Whether lines actually reach a packer. They are never ON a ZLOD row -
     the delivery and the item are blank on every one - so the question is
     not "is the column filled in" but "does the handling unit join find
     the picks that filled the carton". Only a real read answers that. */
  out.join = null;
  const useKey = lineKey.length ? lineKey : (detectLineKey(rows, -2) || []);
  out.keyUsed = useKey;
  if(useKey.length){
    try{
      const t2 = readTasks(rows, useKey);
      /* Whether the two sides of the join are even the same numbers. In
         some warehouses a pick fills a tote and packing builds a new
         carton, and then the handling unit a packer ships was never the
         one a pick went into - the join is not misconfigured, it is
         structurally impossible, and only the overlap shows that. */
      const shipped = new Set(t2.loads.map(l => l.hu).filter(Boolean));
      const filled = new Set(t2.picks.map(x => x.huIn).filter(Boolean));
      let both = 0;
      shipped.forEach(h => { if(filled.has(h)) both++; });
      out.join = { loads: t2.loads.length, resolved: t2.resolved, cartons: t2.huLines,
                   pct: t2.loads.length ? Math.round(t2.resolved / t2.loads.length * 100) : 0,
                   shipped: shipped.size, filled: filled.size, both,
                   sampleShipped: Array.from(shipped).slice(0, 3),
                   sampleFilled: Array.from(filled).slice(0, 3) };
    }catch(e){ out.join = null; }
  }

  /* The verdict, in the terms the question was asked in. A column groups
     usefully when it is filled on nearly every ZLOD row and has fewer
     values than rows. */
  const z = out.acts.ZLOD || 0;
  /* the ten this page already reads are time, place, person and weight -
     all of them group rows and none of them is a line */
  const KNOWN = ['warehouse task', 'activity', 'process type', 'source storage bin', 'dest stor bin',
                 'dest storage bin', 'source handling unit', 'dest handling unit', 'loading weight',
                 'confirmed by', 'confirmation date', 'confirmation time'];
  const isKnown = n => KNOWN.some(k => norm(n) === k || norm(n).indexOf(k) === 0);
  const groupers = z ? out.columns
    .filter(c => !isKnown(c.name) && c.by.ZLOD && c.by.ZLOD.filledPct >= 90 &&
                 c.by.ZLOD.distinct > 1 && c.by.ZLOD.per > 1.2)
    .sort((a, b) => a.by.ZLOD.per - b.by.ZLOD.per) : [];
  const ids = z ? out.columns
    .filter(c => !isKnown(c.name) && c.by.ZLOD && c.by.ZLOD.filledPct >= 90 &&
                 c.by.ZLOD.per <= 1.2 && c.by.ZLOD.distinct > 1) : [];
  out.verdict = {
    zlod: z,
    lineKeyUsable: lineKey.length > 0 && out.lineKeyOnZlod.every(x => x.zlod && x.zlod.filledPct >= 90),
    groupers: groupers.slice(0, 8).map(c => c.name),
    ids: ids.slice(0, 8).map(c => c.name)
  };

  /* What a line key could be, rather than ninety-eight rows and good
     luck. A line key has to be filled in on nearly every pick and has to
     group picks a little - one line split across two bins is two tasks -
     without grouping them into areas. A column that puts eighteen picks
     under one value is a bin, not a line. */
  const pk = out.acts.PICK || 0;
  /* A measure is not an identifier. Loading Volume groups picks as well
     as any document does - 847 different volumes over 2,172 picks - and
     offering it as a line key is offering nonsense with a good ratio. */
  const MEASURE = ['weight', 'volume', 'qty', 'quantity', 'quantities', 'time', 'date', 'description',
                   'country', 'unit of measure', 'uom', 'price', 'value'];
  const isMeasure = n => MEASURE.some(w => norm(n).indexOf(w) >= 0);
  const cand = pk ? out.columns.filter(c => !isKnown(c.name) && !isMeasure(c.name) && c.by.PICK &&
      c.by.PICK.filledPct >= 95 && c.by.PICK.distinct > 1 && c.by.PICK.per >= 1 && c.by.PICK.per <= 6)
    .map(c => ({ name: c.name, distinct: c.by.PICK.distinct, per: c.by.PICK.per,
                 alsoOnZlod: !!(c.by.ZLOD && c.by.ZLOD.filledPct >= 90) }))
    .sort((a, b) => a.per - b.per) : [];

  /* and the pair that usually is the answer: a document and an item on
     it. Named rather than guessed at, and the join is counted for real. */
  const like = (n, words) => words.some(w => norm(n).indexOf(w) >= 0);
  const docs = out.columns.filter(c => !isMeasure(c.name) && like(c.name, ['document', 'delivery', 'doc no', 'docno', 'order'])).slice(0, 4);
  const items = out.columns.filter(c => !isMeasure(c.name) && like(c.name, ['item', 'position', 'line'])).slice(0, 4);
  const colOf = n => names.findIndex(x => x === n);
  const pairs = [];
  if(pk && docs.length && items.length){
    const pick = body.filter(r => String(r[ai] == null ? '' : r[ai]).trim().toUpperCase() === 'PICK');
    for(const d of docs) for(const it of items){
      /* "Document Item, Document Item" is a column joined to itself: the
         word document put it in one list and the word item in the other */
      if(d.name === it.name) continue;
      const ci = colOf(d.name), cj = colOf(it.name);
      if(ci < 0 || cj < 0) continue;
      const seen = new Set();
      let full = 0;
      for(const r of pick){
        const a1 = String(r[ci] == null ? '' : r[ci]).trim(), b1 = String(r[cj] == null ? '' : r[cj]).trim();
        if(!a1 || !b1) continue;
        full++; seen.add(a1 + '' + b1);
      }
      /* the same ceiling the singles get: a pair that puts eight picks
         under one value has grouped them into something, but not a line */
      if(!seen.size || full / seen.size > 6) continue;
      pairs.push({ name: d.name + ', ' + it.name, distinct: seen.size,
                   per: Math.round(full / seen.size * 10) / 10,
                   filledPct: Math.round(full / pick.length * 100),
                   alsoOnZlod: !!(d.by.ZLOD && d.by.ZLOD.filledPct >= 90 && it.by.ZLOD && it.by.ZLOD.filledPct >= 90) });
      if(pairs.length >= 9) break;
    }
    pairs.sort((a, b) => a.per - b.per);
  }
  out.lineKeyCandidates = { picks: pk, singles: cand.slice(0, 10), pairs: pairs.slice(0, 6) };
  return out;
}

/* ------------------------------------------------------------------ *
   Can the handling unit staging export bridge a carton back to a
   delivery?

   The task export cannot: a packer's row carries no delivery, and the
   unit they ship is not the unit the picks went into. But that carton
   does not vanish - it goes to a staging lane, and the staging lane is
   the one place this service already pulls every handling unit from. If
   that file names a delivery against the unit, it is the bridge the task
   export does not have and lines per packer is back on.

   This answers it with numbers rather than an opinion: how many of the
   units a packer shipped today appear in the staging file at all, and
   which of its columns carry a delivery against them. */
function probeBridge(app){
  const out = { ok: false };
  try{
    const wh = app.ingest.fullRows('wh');
    const st = app.ingest.fullRows('stage');
    if(!wh || !st) return { ok: false, why: 'both the task and the handling unit exports have to be loaded' };
    const { lineKey } = settingsOf(app);
    const key = lineKey.length ? lineKey : (detectLineKey(wh, -3) || []);
    const t = readTasks(wh, key);
    const shipped = new Set(t.loads.map(l => l.hu).filter(Boolean));
    if(!shipped.size) return { ok: false, why: 'no handling units went out in the task export' };

    const u = table(st, ['handling unit', 'packaging material']);
    if(!u) return { ok: false, why: 'the handling unit export has no recognisable header' };
    let hi = 0;
    for(let i = 0; i < Math.min(12, st.length); i++)
      if((st[i] || []).some(c => norm(c) === 'handling unit')){ hi = i; break; }
    const names = (st[hi] || []).map(c => String(c == null ? '' : c).trim());
    const hu = names.findIndex(c => norm(c) === 'handling unit');
    if(hu < 0) return { ok: false, why: 'the handling unit export has no Handling Unit column' };
    const body = st.slice(hi + 1).filter(r => r && r.some(c => String(c == null ? '' : c).trim()));

    /* which of the shipped cartons this file knows about at all */
    const here = new Map();
    for(const r of body){
      const h = String(r[hu] == null ? '' : r[hu]).trim();
      if(h && shipped.has(h) && !here.has(h)) here.set(h, r);
    }
    out.ok = true;
    out.shipped = shipped.size;
    out.rows = body.length;
    out.found = here.size;
    out.pct = Math.round(here.size / shipped.size * 100);
    out.header = names;

    /* and which columns say something about a delivery on those rows */
    const mine = Array.from(here.values());
    out.columns = names.map((n, c) => {
      if(!n || c === hu) return null;
      let filled = 0;
      const vals = new Set();
      for(const r of mine){
        const v = String(r[c] == null ? '' : r[c]).trim();
        if(!v) continue;
        filled++;
        if(vals.size < 50000) vals.add(v);
      }
      if(!filled) return null;
      return { name: n, filledPct: mine.length ? Math.round(filled / mine.length * 100) : 0,
               distinct: vals.size, per: vals.size ? Math.round(filled / vals.size * 10) / 10 : 0 };
    }).filter(Boolean);

    /* a bridge column is one that is filled on nearly every carton and
       groups them - a delivery, an order, a shipment */
    const no = n => ['weight', 'volume', 'qty', 'quantity', 'date', 'time', 'description', 'material',
                     'type', 'status', 'bin', 'unit of measure'].some(w => norm(n).indexOf(w) >= 0);
    out.bridges = out.columns
      .filter(c => !no(c.name) && c.filledPct >= 90 && c.distinct > 1 && c.per >= 1)
      .sort((a, b) => b.per - a.per)
      .slice(0, 8);
  }catch(e){ return { ok: false, why: e.message }; }
  return out;
}

/* the loose column reader and the Excel date helpers, so the value side
   finds a column the same way the rest of the board does rather than
   growing a second idea of what "Tt.Del.Val" is called */
module.exports.table = table;
module.exports.num = num;
module.exports.msOf = msOf;
module.exports.dayKeyOf = dayKeyOf;
module.exports.probeColumns = probeColumns;
module.exports.probeBridge = probeBridge;

/* ------------------------------------------------------------------ *
   The same reading, pointed at any of the exports.

   probeColumns above is built around Activity, because the question it
   answers is about one activity against another. The orders and
   handling unit exports have no activity, and the question asked of
   them is flatter: what is in here, and is any of it money?

   That last one is worth saying plainly. EWM is execution - quantities,
   weights, volumes, bins, handling units. It does not price anything;
   value lives in the sales and billing side. So the only way a value
   reaches these files is if it is riding along unnoticed, which is
   exactly what this looks for rather than assumes either way.
 * ------------------------------------------------------------------ */

/* words that would be in the name of a column carrying money */
/* SAP abbreviates, so this has to match the abbreviations: the column
   that actually carries the money on the floor is called `Tt.Del.Val`,
   not anything with the word value in it. Matched on token boundaries
   rather than as plain substrings, so `val` catches `Tt.Del.Val` and
   `Total Del.Val` without also catching `Valid From`. */
const MONEY_WORDS = ['value', 'val', 'amount', 'amt', 'net', 'gross', 'price', 'cost',
                     'currency', 'curr', 'revenue', 'extended', 'charge'];
const MONEY_RE = new RegExp('(^|[^a-z])(' + MONEY_WORDS.join('|') + ')([^a-z]|$)', 'i');
/* and words that look like money and are not: a net WEIGHT is not money */
const NOT_MONEY = ['weight', 'wght', 'wgt', 'volume', 'vol', 'capacity', 'length', 'width',
                   'height', 'quantity', 'qty', 'time', 'date', 'duration', 'hours', 'tare',
                   'tolerance', 'dimension', 'age'];
/* applied to the shape test as well as the name: "Loading Weight" and
   "Confirmation Time" both look exactly like a price to anything that
   is only counting decimal places, and a time here is a fraction of a
   day, so it is decimal by construction. */
const notMoney = n => NOT_MONEY.some(w => n.indexOf(w) >= 0) || / at$/.test(n.trim());

/* the header is the first row with a few things in it - these files do
   not always start at the top */
function headerRowOf(rows){
  for(let i = 0; i < Math.min(12, rows.length); i++){
    const r = rows[i] || [];
    if(r.filter(c => String(c == null ? '' : c).trim()).length > 3) return i;
  }
  return 0;
}
/* a column of numbers with a decimal part and a spread to it could be a
   price even when nobody named it one */
function moneyShaped(values){
  if(values.length < 8) return false;
  let decimals = 0, nums = 0;
  const seen = new Set();
  for(const v of values){
    const n = Number(String(v).replace(/[, $]/g, ''));
    if(!isFinite(n) || !String(v).trim()) continue;
    nums++;
    seen.add(n);
    if(Math.abs(n % 1) > 1e-9) decimals++;
  }
  if(!nums || seen.size < 8) return false;
  /* mostly fractional, and not all the same handful of values */
  return decimals / nums > 0.5 && seen.size / nums > 0.1;
}

function probeExport(app, kind){
  const rows = app.ingest.fullRows(kind);
  if(!rows || !rows.length) return { ok: false, kind, why: 'that export is not loaded' };
  const hi = headerRowOf(rows);
  const names = (rows[hi] || []).map(c => String(c == null ? '' : c).trim());
  const body = rows.slice(hi + 1).filter(r => r && r.some(c => String(c == null ? '' : c).trim()));
  if(!names.length || !body.length) return { ok: false, kind, why: 'that export has no rows in it' };

  const out = { ok: true, kind, rows: body.length, header: names, columns: [], money: [] };
  for(let c = 0; c < names.length; c++){
    if(!names[c]) continue;
    const vals = [];
    const set = new Set();
    for(const r of body){
      const v = String(r[c] == null ? '' : r[c]).trim();
      if(!v) continue;
      vals.push(v);
      if(set.size < 50000) set.add(v);
    }
    const n = names[c].toLowerCase();
    const barred = notMoney(n);
    const named = !barred && MONEY_RE.test(n);
    const shaped = !barred && !named && moneyShaped(vals.slice(0, 4000));
    const col = {
      name: names[c],
      filledPct: Math.round(vals.length / body.length * 100),
      distinct: set.size,
      per: set.size ? Math.round(vals.length / set.size * 10) / 10 : 0,
      sample: Array.from(set).slice(0, 3),
      money: named ? 'named' : (shaped ? 'shaped' : null)
    };
    out.columns.push(col);
    if(col.money) out.money.push(col);
  }
  return out;
}
module.exports.probeExport = probeExport;
