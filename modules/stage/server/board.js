'use strict';
/* The board model. One place that answers the four floor questions from the
   feeds that exist:
     which lane needs clearing next   -> clearNext, lane ages
     which orders are stuck and why   -> stuck
     are we on pace today             -> pace (from the dwell log + order export)
     how full is staging              -> summary + zones
   Everything the TV and the ops page draw comes from build(). */
const model = require('./model');

const DEFAULT_LANES = {
  row1: ['E00-01', 'E00-02', 'E00-03', 'E00-04', 'E00-05', 'E00-06', 'E00-07', 'E00-08', 'E00-09',
         'E01-01', 'E01-02', 'E01-03', 'E01-04', 'E01-05', 'E01-06', 'E01-07', 'E01-08', 'E01-09'],
  row2: ['E02-01', 'E02-02', 'E02-03', 'E02-04', 'E02-05', 'E02-06', 'E02-07', 'E02-08', 'E02-09',
         'E03-01', 'E03-02', 'E03-03', 'E03-04', 'E03-05', 'E03-06', 'E03-07', 'E03-08', 'E03-09'],
  bottom: ['E04-01', 'E04-02', 'E04-03', 'E04-04', 'E05-00', 'E06-01', 'E06-02', 'E06-03', 'E06-04', 'E06-05', 'E06-06'],
  hosp: ['I00-00', 'I00-01', 'I00-02']
};
const DEFAULT_WT_AREAS = ['D100 = Flow', 'D200 = Flow', 'D300 = Flow', 'D400 = Flow', 'D600 = Flow', 'D700 = Flow', 'D500 = Static',
  'P007 = P007', 'GRNG = Grainger', 'CANT = Cantilever', 'COMP = Comp', 'P0   = Warehouse Stock'].join('\n');
const DEFAULT_SHIFTS = [{ name: 'Day', start: '07:00', end: '15:30', days: [1, 2, 3, 4, 5] }];

function laneConfig(settings){
  const l = settings && settings.lanes;
  if(l && ((l.row1 || []).length || (l.row2 || []).length)) return { row1: l.row1 || [], row2: l.row2 || [], bottom: l.bottom || [], hosp: l.hosp || [] };
  return DEFAULT_LANES;
}
function prefixOf(bin){ const m = /^([A-Z]\d{2})/i.exec(bin || ''); return m ? m[1].toUpperCase() : ''; }
/* Zones pair prefixes two-up (E00/E01, E02/E03, ...) like the old board. */
function zoneDefs(lc){
  const all = [].concat(lc.row1, lc.row2, lc.bottom);
  const prefixes = [];
  all.forEach(b => { const p = prefixOf(b); if(p && prefixes.indexOf(p) < 0) prefixes.push(p); });
  const defs = [];
  for(let i = 0; i < prefixes.length; i += 2){
    const a = prefixes[i], b = prefixes[i + 1];
    defs.push({ id: ('z_' + a + (b ? '_' + b : '')).toLowerCase(), label: a + (b ? ' / ' + b : ''),
                rows: [all.filter(x => prefixOf(x) === a), b ? all.filter(x => prefixOf(x) === b) : []] });
  }
  return defs;
}
function hhmm(t){ const m = String(t == null ? '' : t).match(/(\d{1,2}):(\d{2})/); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; }
function startOfDay(ms){ const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function fmtAge(min){ if(min == null) return ''; const h = Math.floor(min / 60), m = Math.round(min % 60); return h >= 100 ? h + 'h' : h + ':' + String(m).padStart(2, '0'); }
function median(a){ if(!a.length) return null; const v = a.slice().sort((x, y) => x - y), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }

/* "Now" honours the test-mode date the way the old board did, so a saved set
   of exports can be replayed as if it were today. */
function refNow(settings){
  const v = String((settings && settings.asOfDate) || '').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(v)){
    const p = v.split('-').map(Number), n = new Date();
    return new Date(p[0], p[1] - 1, p[2], n.getHours(), n.getMinutes(), n.getSeconds()).getTime();
  }
  return Date.now();
}
function currentShift(settings, now){
  const list = (settings && Array.isArray(settings.shifts) && settings.shifts.length) ? settings.shifts : DEFAULT_SHIFTS;
  const d = new Date(now), day0 = startOfDay(now), dow = d.getDay();
  let best = null;
  for(const s of list){
    const st = hhmm(s.start), en = hhmm(s.end);
    if(st == null || en == null) continue;
    for(const off of [-1, 0]){
      const base = day0 + off * 86400000;
      const bd = (dow + off + 7) % 7;
      if(Array.isArray(s.days) && s.days.length && s.days.indexOf(bd) < 0) continue;
      const from = base + st * 60000;
      let to = base + en * 60000; if(to <= from) to += 86400000;
      if(now >= from && now < to && (!best || from > best.from)) best = { name: s.name || 'Shift', from, to };
    }
  }
  return best;
}

function build(app){
  const settings = app.settings.get() || {};
  const v2 = settings.v2 || {};
  const now = refNow(settings);
  const today0 = startOfDay(now), todayKey = model.dayKey(new Date(now)), yestKey = model.dayKey(new Date(now - 86400000));
  const yellowMin = Math.max(1, (settings.yellowHr || 1) * 60), redMin = Math.max(yellowMin + 1, (settings.redHr || 2) * 60);
  const lateMin = Math.max(redMin, (v2.lateHr || 3) * 60);
  const lc = laneConfig(settings);
  const zones = zoneDefs(lc);
  const staging = [].concat(lc.row1, lc.row2, lc.bottom).map(b => b.toUpperCase());
  const hospSet = new Set(lc.hosp.map(b => b.toUpperCase()));
  const stagingSet = new Set(staging);

  const d = app.ingest.derived || {};
  const L = d.lanes || { lanes: {}, cgWhere: {}, intl: { orders: 0, totes: 0 } };
  const O = d.orders || { cgDoc: {}, docStatus: {}, docOpen: {}, pickDays: {}, haveDate: false };
  const haveOrders = Object.keys(O.docStatus || {}).length > 0;
  const docOf = cg => O.cgDoc[cg] || ('CG ' + cg);

  /* every lane the board draws, occupied or not */
  const docLanes = {}, hospDocs = new Set();
  for(const bin in L.lanes){
    const lane = L.lanes[bin];
    (lane.orders || []).forEach(cg => { const doc = docOf(cg); (docLanes[doc] = docLanes[doc] || []).push(bin); if(hospSet.has(bin)) hospDocs.add(doc); });
  }
  const bandOf = min => min >= redMin ? 'late' : min >= yellowMin ? 'aging' : 'fresh';
  const laneRec = bin => {
    const lane = L.lanes[bin];
    const rec = { bin, zone: prefixOf(bin), hosp: hospSet.has(bin), totes: 0, orders: [], ageMin: null, age: '', band: 'empty', ready: false, waiting: false, multi: false, hospLinked: false, alsoIn: [] };
    if(!lane) return rec;
    rec.totes = lane.hus;
    rec.toteIds = (lane.totes || []).slice(0, 12);
    rec.ageMin = Math.max(0, Math.round((now - lane.oldest) / 60000));
    rec.age = fmtAge(rec.ageMin);
    rec.band = bandOf(rec.ageMin);
    rec.orders = (lane.orders || []).map(cg => {
      const doc = docOf(cg), st = O.docStatus[doc];
      const others = (docLanes[doc] || []).filter(b => b !== bin && stagingSet.has(b));
      return { cg, doc, complete: st === 'complete', known: !!st, openLines: O.docOpen[doc] || 0, loose: L.cgWhere[cg] || '', alsoIn: others, inHospital: hospDocs.has(doc) };
    });
    rec.multi = rec.orders.length > 1;
    rec.ready = !rec.hosp && rec.orders.length > 0 && rec.orders.every(o => o.complete);
    rec.waiting = !rec.hosp && rec.orders.some(o => !o.complete);
    rec.hospLinked = !rec.hosp && rec.orders.some(o => o.inHospital);
    rec.alsoIn = [...new Set(rec.orders.flatMap(o => o.alsoIn))];
    return rec;
  };
  const lanes = staging.map(laneRec);
  const hospital = lc.hosp.map(b => laneRec(b.toUpperCase()));
  const byBin = {}; lanes.forEach(l => { byBin[l.bin] = l; });

  /* summary numbers */
  const used = lanes.filter(l => l.totes > 0);
  const docs = {};
  used.forEach(l => l.orders.forEach(o => { const r = docs[o.doc] || (docs[o.doc] = { doc: o.doc, oldestMin: l.ageMin, lane: l.bin, complete: o.complete, known: o.known, lanes: new Set(), loose: o.loose, openLines: o.openLines, inHospital: o.inHospital }); r.lanes.add(l.bin); if(l.ageMin > r.oldestMin){ r.oldestMin = l.ageMin; r.lane = l.bin; } }));
  const docList = Object.values(docs);
  const oldestLane = used.filter(l => !l.ready).sort((a, b) => b.ageMin - a.ageMin)[0] || used.sort((a, b) => b.ageMin - a.ageMin)[0] || null;
  const summary = {
    lanesTotal: lanes.length, lanesUsed: used.length, occupancyPct: lanes.length ? Math.round(used.length / lanes.length * 100) : 0,
    totes: used.reduce((n, l) => n + l.totes, 0),
    orders: docList.length, ready: docList.filter(x => x.complete).length, waiting: docList.filter(x => !x.complete).length,
    unknown: docList.filter(x => !x.known).length, haveOrders,
    late: docList.filter(x => x.oldestMin >= lateMin).length, carried: used.filter(l => (now - l.ageMin * 60000) < today0).reduce((n, l) => n + l.orders.length, 0),
    oldest: oldestLane ? { lane: oldestLane.bin, ageMin: oldestLane.ageMin, age: oldestLane.age, doc: oldestLane.orders[0] ? oldestLane.orders[0].doc : '', ready: oldestLane.ready } : null,
    hospitalTotes: hospital.reduce((n, l) => n + l.totes, 0),
    international: L.intl, looseTotes: Object.keys(L.cgWhere || {}).length
  };

  /* clear next: oldest first, ready lanes flagged since they can go now */
  const clearNext = used.slice().sort((a, b) => b.ageMin - a.ageMin).slice(0, 10).map(l => ({
    bin: l.bin, ageMin: l.ageMin, age: l.age, band: l.band, ready: l.ready, orders: l.orders.map(o => o.doc), totes: l.totes,
    note: l.ready ? 'ready to ship' : l.orders.some(o => o.loose) ? ('tote still in ' + l.orders.map(o => o.loose).filter(Boolean)[0].toLowerCase()) : l.orders.some(o => !o.known) ? 'not on order report' : (l.orders.reduce((n, o) => n + o.openLines, 0) + ' lines to pick')
  }));

  /* stuck: something a person has to go and fix */
  const stuck = [];
  docList.forEach(x => {
    const reasons = [];
    if(x.lanes.size > 1) reasons.push('split across ' + [...x.lanes].join(', '));
    if(!x.complete && x.loose) reasons.push('tote still in ' + x.loose.toLowerCase());
    if(x.inHospital) reasons.push('tote in problem solve');
    if(!x.known && haveOrders) reasons.push('not on the order report');
    if(!x.complete && x.known && x.oldestMin >= lateMin && !x.loose) reasons.push(x.openLines + ' lines still to pick after ' + fmtAge(x.oldestMin));
    if(reasons.length) stuck.push({ doc: x.doc, lane: x.lane, ageMin: x.oldestMin, age: fmtAge(x.oldestMin), ready: x.complete, reasons });
  });
  stuck.sort((a, b) => b.ageMin - a.ageMin);
  const exc = { total: stuck.length, loose: 0, split: 0, hospital: 0, unknown: 0, overdue: 0 };
  stuck.forEach(x => x.reasons.forEach(r => { if(/^tote still in/.test(r)) exc.loose++; else if(/^split/.test(r)) exc.split++; else if(/problem solve/.test(r)) exc.hospital++; else if(/not on the order/.test(r)) exc.unknown++; else exc.overdue++; }));
  summary.exceptions = exc;
  summary.openLanes = lanes.length - used.length;

  /* pace: departures from the dwell log, today by hour, yesterday as context */
  const comp = (app.dwell && app.dwell.completed) || [];
  const perHour = (dayStart) => { const h = new Array(24).fill(0), ords = new Array(24).fill(null).map(() => new Set()); comp.forEach(r => { if(r.stale) return; const t = r.departed - dayStart; if(t >= 0 && t < 86400000){ const k = Math.floor(t / 3600000); h[k]++; if(r.order) ords[k].add(r.order); } }); return { totes: h, orders: ords.map(s => s.size) }; };
  const todayH = perHour(today0), yestH = perHour(today0 - 86400000);
  const clearedToday = comp.filter(r => !r.stale && r.departed >= today0 && r.departed < today0 + 86400000);
  const ordersToday = new Set(clearedToday.map(r => r.order).filter(Boolean)).size;
  const ordersYest = new Set(comp.filter(r => !r.stale && r.departed >= today0 - 86400000 && r.departed < today0).map(r => r.order).filter(Boolean)).size;
  const shift = currentShift(settings, now);
  const goal = +v2.goalOrders || 0;
  const elapsedH = shift ? Math.max(0.25, (now - shift.from) / 3600000) : Math.max(0.25, (now - today0) / 3600000);
  const shiftH = shift ? (shift.to - shift.from) / 3600000 : 8;
  const rate = ordersToday / elapsedH;
  const pace = {
    ordersClearedToday: ordersToday, totesClearedToday: clearedToday.length, ordersClearedYesterday: ordersYest,
    medianDwellMin: (() => { const m = median(clearedToday.map(r => r.dwellMs)); return m == null ? null : Math.round(m / 60000); })(),
    goal, projected: shift ? Math.round(ordersToday + rate * Math.max(0, (shift.to - now) / 3600000)) : null,
    ratePerHour: Math.round(rate * 10) / 10, shift, hoursLeft: shift ? Math.round(Math.max(0, (shift.to - now) / 3600000) * 10) / 10 : null,
    linesPickedToday: O.pickDays[todayKey] || 0, linesPickedYesterday: O.pickDays[yestKey] || 0, latestPick: O.latestPick || null, haveLineDates: !!O.haveDate,
    byHour: { today: todayH.orders, yesterday: yestH.orders, totesToday: todayH.totes }, hourRange: shift ? [Math.floor(new Date(shift.from).getHours()), Math.min(23, Math.ceil(new Date(shift.to).getHours()) + 1)] : [6, 22],
    onPace: goal ? (ordersToday + rate * Math.max(0, shiftH - elapsedH) >= goal) : null,
    logCoverageDays: comp.length ? Math.round((now - Math.min.apply(null, comp.map(r => r.departed))) / 86400000) : 0
  };

  /* zones */
  const zoneOut = zones.map(z => { const bins = z.rows[0].concat(z.rows[1]).map(b => b.toUpperCase()); const zl = bins.map(b => byBin[b]).filter(Boolean); return { id: z.id, label: z.label, total: zl.length, used: zl.filter(l => l.totes > 0).length, late: zl.filter(l => l.band === 'late').length, rows: z.rows.map(r => r.map(b => b.toUpperCase())) }; });

  /* pick side (task feed): honest about being unavailable */
  let pickSide = { available: false, reason: '' };
  const wh = app.ingest.files.wh;
  if(wh && wh.status === 'ok' && wh.full){
    try{
      const t = model.computeTasks(wh.full, (settings.wtAreaMap || '').trim() || DEFAULT_WT_AREAS, todayKey);
      /* the same standards the picker report uses, so nothing is entered twice */
      /* the standards in force, wherever they came from: on the cloud copy
         they arrive in the push, not the local config */
      const tg = app.pickers ? app.pickers.settings().targets
               : model.parseTargets(((app.cfg.get().pickers || {}).targets || '').trim() || model.DEFAULT_TARGETS);
      t.areas.forEach(a => {
        /* target is per person, so what the area should be producing is the
           standard times the number of people who worked it */
        a.target = model.targetFor(tg, a.area) || null;
        a.expectedRate = (a.target && a.pickers) ? Math.round(a.target * a.pickers * 10) / 10 : null;
      });
      t.targetsFromStandards = true;
      pickSide = Object.assign({ available: true, written: wh.mtime }, t);
    }
    catch(e){ pickSide = { available: false, reason: e.message }; }
  } else pickSide.reason = wh ? (wh.error || wh.status || 'not loaded') : 'not loaded';

  /* feed health */
  const files = app.ingest.diag();
  const pu = app.puller.status();
  const newest = app.ingest.newestMtime();
  const staleMs = Math.max(5, settings.staleMin || 30) * 60000;
  const feed = {
    updated: newest, stale: !newest || (Date.now() - newest) > staleMs,
    stage: files.stage.status, orders: files.orders.status, wh: files.wh.status,
    pull: !pu.enabled ? 'folder' : pu.stopped ? 'stopped' : pu.idle ? 'paused' : (pu.sap && pu.sap.ok === false) ? 'sap-down' : pu.running ? 'pulling' : (pu.lastOk === false ? 'failing' : 'ok'),
    testMode: settings.asOfDate || '',
    via: app.cloudMode ? 'cloud' : 'host',
    cloudHost: app.cloudMode ? (app.store.data.host || '') : '',
    receivedAt: app.cloudMode ? app.store.received : null,
    pushStale: app.cloudMode ? (!app.store.received || (Date.now() - app.store.received) > 10 * 60000) : false
  };

  return {
    v: app.ingest.version + '.' + (app.dwell ? app.dwell.version : 0), now, todayKey,
    title: (v2.title || settings.title || 'Staging Lane Health'),
    thresholds: { yellowMin, redMin, lateMin },
    summary, lanes, hospital, zones: zoneOut, clearNext, stuck, pace, pickSide, feed,
    laneRows: [lc.row1.map(b => b.toUpperCase()), lc.row2.map(b => b.toUpperCase()), lc.bottom.map(b => b.toUpperCase())]
  };
}

module.exports = { build, DEFAULT_LANES, DEFAULT_SHIFTS, DEFAULT_WT_AREAS, currentShift, fmtAge };
