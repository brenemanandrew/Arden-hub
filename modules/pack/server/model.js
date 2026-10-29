'use strict';
/* Shared data model helpers, ported from the board so the server derives the
   same lanes and totes the screen shows. Kept dependency free and pure. */

function parseExcelDate(dstr){
  dstr = String(dstr == null ? '' : dstr).trim();
  if(!dstr) return null;
  if(/^\d{5}(\.\d+)?$/.test(dstr)){
    const serial = Math.floor(parseFloat(dstr));
    const u = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
  }
  const m = dstr.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
  if(!m) return null;
  let a = +m[1], b = +m[2], c = +m[3];
  let y, mo, d;
  if(a > 31){ y = a; mo = b; d = c; }
  else { mo = a; d = b; y = c; if(mo > 12){ d = a; mo = b; } if(y < 100) y += 2000; }
  return new Date(y, mo - 1, d);
}
function parseExcelTime(tstr){
  tstr = String(tstr == null ? '' : tstr).trim();
  if(!tstr) return 0;
  if(/^0?\.\d+$/.test(tstr)) return parseFloat(tstr) * 86400000;
  const m = tstr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if(!m) return 0;
  let h = +m[1], mi = +m[2], s = +(m[3] || 0);
  if(m[4]){ const pm = /pm/i.test(m[4]); if(pm && h < 12) h += 12; if(!pm && h === 12) h = 0; }
  return ((h * 60 + mi) * 60 + s) * 1000;
}
function binZone(bin){
  const b = String(bin || '').trim().toUpperCase();
  if(b === 'TOTE-INDUCT' || b.indexOf('INDUCT') >= 0) return 'INDUCT';
  if(/^(E\d{2}|F[A-Z0-9])-[A-Z0-9]{1,2}$/.test(b)) return 'STAGE';
  if(b === 'INTERNATIONAL' || b.indexOf('INTERNATIONAL') === 0) return 'INTL';
  if(/^D8/.test(b)) return 'D8';
  if(!b) return 'SKIP';
  return 'PICK';
}
function normCg(v){ return String(v == null ? '' : v).trim().replace(/^0+/, ''); }
/* The per-area pick standards. One definition, read by the picker report and
   by the board's pick-side card, so a rate is never typed in twice. */
/* The standards in force when nobody has saved any. Set on 2026-09-13 to the
   recommended standards worked out from this warehouse's own picking (the
   Recommended view on the picker page); Other has no recommendation and
   keeps its old value. Saved Pick Standards on the host always win. */
const DEFAULT_TARGETS = ['Flow = 36', 'Static = 31', 'P007 = 22', 'Grainger = 36',
  'Cantilever = 15', 'Comp = 26', 'Warehouse Stock = 20', 'Other = 40'].join('\n');
function parseTargets(text){
  const out = {};
  String(text == null ? '' : text).split('\n').forEach(line => {
    const p = line.split('=');
    if(p.length !== 2) return;
    const name = p[0].trim(), rate = parseFloat(p[1]);
    if(name && isFinite(rate) && rate > 0) out[name.toLowerCase()] = rate;
  });
  return out;
}
function targetFor(targets, area){
  return (targets || {})[String(area == null ? '' : area).toLowerCase()] || (targets || {}).other || 0;
}
function dayKey(d){ return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
const norm = r => (r || []).map(c => String(c == null ? '' : c).trim().toLowerCase());

/* Find the header row (within the first few rows) that carries any of the
   given words. Returns its index or -1. */
function headerIndex(rows, words, maxScan){
  for(let i = 0; i < Math.min(rows.length, maxScan || 8); i++){
    const r = norm(rows[i]);
    if(words.some(w => r.some(c => c.indexOf(w) >= 0))) return i;
  }
  return -1;
}
function makeFinder(H){
  return (...names) => {
    for(const n of names){ const i = H.indexOf(n); if(i >= 0) return i; }
    for(const n of names){ const i = H.findIndex(h => h.indexOf(n) >= 0); if(i >= 0) return i; }
    return -1;
  };
}

/* The HU export -> what is in each lane right now. Mirrors loadRows on the
   board minus the rendering. */
function computeLanes(rows){
  const hIdx = headerIndex(rows, ['handling unit', 'storage bin'], 6);
  if(hIdx < 0) throw new Error('no header row with Handling Unit / Storage Bin');
  const H = norm(rows[hIdx]);
  const find = makeFinder(H);
  const c = {
    hu: find('handling unit'), pack: find('packaging material', 'pack. material', 'packaging mat'),
    bin: find('storage bin'), picker: find('changed by', 'created by'),
    date: find('changed on', 'created on'), time: find('changed at', 'created at'),
    ord: find('consolidation group', 'consolidation grp', 'cons. group')
  };
  if(c.hu < 0 || c.bin < 0 || c.ord < 0) throw new Error('missing Handling Unit, Storage Bin or Consolidation Group column');
  const pick = (r, i) => (i >= 0 && i < r.length && r[i] != null) ? String(r[i]) : '';
  const cgZones = {};
  const lanes = {}, present = {}, d8 = new Set();
  let intlOrders = 0, intlTotes = 0, count = 0, totes = 0;
  for(let i = hIdx + 1; i < rows.length; i++){
    const r = rows[i] || [];
    const bin = pick(r, c.bin).trim();
    const cg = normCg(pick(r, c.ord));
    const z = binZone(bin);
    if(cg && z !== 'SKIP') (cgZones[cg] = cgZones[cg] || new Set()).add(z);
    if(z === 'INTL' && cg) intlTotes++;
    const isD8 = /^D8/i.test(bin);
    if(!isD8 && !/^([A-Z]\d{2}|F[A-Z0-9])-[A-Z0-9]{1,2}$/i.test(bin)) continue;
    const d = parseExcelDate(pick(r, c.date));
    if(!d){ if(isD8 && cg) d8.add(cg); count += isD8 ? 1 : 0; continue; }
    const ts = d.getTime() + parseExcelTime(pick(r, c.time));
    const key = bin.toUpperCase();
    if(!lanes[key]) lanes[key] = { oldest: ts, orders: [], totes: [], hus: 0, d8: isD8 };
    lanes[key].hus++;
    if(ts < lanes[key].oldest) lanes[key].oldest = ts;
    if(cg && !lanes[key].orders.includes(cg)) lanes[key].orders.push(cg);
    const hu = pick(r, c.hu).trim().replace(/^0+/, '');
    if(hu){
      lanes[key].totes.push(hu);
      if(!isD8){
        present[hu] = { order: cg, picker: pick(r, c.picker).trim().toUpperCase(), lane: key, staged: ts };
        totes++;
      }
    }
    if(isD8 && cg) d8.add(cg);
    count++;
  }
  const cgWhere = {};
  for(const cg in cgZones){
    const z = cgZones[cg];
    if(z.has('INTL')){ intlOrders++; continue; }
    if(z.has('INDUCT') || z.has('PICK')) cgWhere[cg] = (z.has('INDUCT') && z.has('PICK')) ? 'Induct + Pick' : (z.has('INDUCT') ? 'Induct' : 'Pick');
  }
  return { lanes, present, cgWhere, d8Orders: [...d8], intl: { orders: intlOrders, totes: intlTotes }, count, totes, header: rows[hIdx], cols: c };
}

/* Orders export -> status per consolidation group and per ERP document. */
function computeOrders(rows){
  const hIdx = headerIndex(rows, ['consolidation', 'picking', 'document'], 8);
  if(hIdx < 0) throw new Error('no header row with Consolidation Group / Picking Status');
  const H = norm(rows[hIdx]);
  const find = makeFinder(H);
  const cCg = find('consolidation group', 'consolidation grp', 'consolidation');
  const cDoc = find('erp document', 'document');
  const cPick = find('picking status', 'picking');
  if(cCg < 0 || cPick < 0) throw new Error('missing Consolidation Group or Picking Status column');
  const cPDate = find('actual pick date', 'actual pick');
  const cgDoc = {}, docLines = {}, docOpen = {}, pickDays = {};
  let lines = 0, picked = 0, latestPick = null;
  for(let i = hIdx + 1; i < rows.length; i++){
    const r = rows[i] || [];
    const cg = normCg(r[cCg]); if(!cg) continue;
    const st = String(r[cPick] == null ? '' : r[cPick]).trim().toLowerCase().indexOf('complet') === 0 ? 'complete' : 'partial';
    lines++; if(st === 'complete') picked++;
    if(cPDate >= 0){
      const pd = parseExcelDate(r[cPDate]);
      if(pd){ const k = dayKey(pd); pickDays[k] = (pickDays[k] || 0) + 1; if(!latestPick || pd > latestPick) latestPick = pd; }
    }
    if(cDoc >= 0){
      const doc = String(r[cDoc] == null ? '' : r[cDoc]).trim().replace(/^0+/, '');
      if(doc){ cgDoc[cg] = doc; (docLines[doc] = docLines[doc] || []).push(st); if(st !== 'complete') docOpen[doc] = (docOpen[doc] || 0) + 1; }
    }
  }
  const docStatus = {};
  for(const d in docLines) docStatus[d] = docLines[d].every(s => s === 'complete') ? 'complete' : 'partial';
  return { cgDoc, docStatus, docOpen, lines, picked, pickDays, latestPick: latestPick ? latestPick.getTime() : null, haveDate: cPDate >= 0, header: rows[hIdx] };
}

/* Which known export does this header belong to? Used to reject a file
   saved under the wrong name before the board ever sees it. */
function classifyHeader(rows){
  const scan = Math.min(rows.length, 12);
  for(let i = 0; i < scan; i++){
    const r = norm(rows[i]);
    if(r.some(x => x === 'warehouse task') && r.some(x => x.indexOf('source storage type') === 0)) return 'wh';
    if(r.some(x => x.indexOf('handling unit') === 0) && r.some(x => x.indexOf('storage bin') === 0) && r.some(x => x.indexOf('packaging material') === 0)) return 'stage';
    if(r.some(x => x.indexOf('consolidation group') === 0) && r.some(x => x.indexOf('picking status') === 0)) return 'orders';
  }
  return 'unknown';
}

/* Where each person's confirmations actually landed on a day, counted to the
   minute. The activity strip draws the active band from these merged into
   half-hour windows, which makes fifty scans a few seconds apart and two
   picks half an hour apart look identical. The marks keep the difference: a
   minute that carried eight scans is not the same minute as one that carried
   one, and a supervisor asking where the time went needs to see that. */
function pickMarks(rows, wantDay){
  const hIdx = headerIndex(rows, ['warehouse task'], 12);
  if(hIdx < 0) return null;
  const find = makeFinder(norm(rows[hIdx]));
  const cAct = find('activity'), cStat = find('warehouse task status'), cWho = find('confirmed by');
  const cDate = find('confirmation date'), cTime = find('confirmation time');
  if(cWho < 0 || cTime < 0 || cDate < 0) return null;
  const fromDate = cStat < 0;   // no status column: a confirmation date means confirmed
  const out = {};
  for(let i = hIdx + 1; i < rows.length; i++){
    const r = rows[i] || [];
    if(cAct >= 0 && String(r[cAct] == null ? '' : r[cAct]).trim().toUpperCase() !== 'PICK') continue;
    const ds = String(r[cDate] == null ? '' : r[cDate]).trim();
    if(fromDate ? !ds : String(r[cStat] == null ? '' : r[cStat]).trim().toUpperCase() !== 'C') continue;
    const d = parseExcelDate(ds);
    if(!d || dayKey(d) !== wantDay) continue;
    const who = String(r[cWho] == null ? '' : r[cWho]).trim();
    if(!who) continue;
    const ms = parseExcelTime(String(r[cTime] == null ? '' : r[cTime]));
    if(!ms && ms !== 0) continue;
    const min = Math.round(ms / 60000);
    const o = out[who] = out[who] || {};
    o[min] = (o[min] || 0) + 1;
  }
  const packed = {};
  for(const who in out){
    packed[who] = Object.keys(out[who]).map(Number).sort((a, b) => a - b).map(m => [m, out[who][m]]);
  }
  return packed;
}

/* Warehouse task export -> pick confirmations by area. Only meaningful once   the task feed works; until then the caller reports "unavailable". */
function computeTasks(rows, areaMapText, todayKey){
  const hIdx = headerIndex(rows, ['warehouse task'], 12);
  if(hIdx < 0) throw new Error('no Warehouse Task header');
  const H = norm(rows[hIdx]);
  const find = makeFinder(H);
  const cAct = find('activity'), cType = find('source storage type'), cStat = find('warehouse task status');
  const cWho = find('confirmed by'), cDate = find('confirmation date'), cTime = find('confirmation time');
  /* no status column (some SAP layouts leave it out): a confirmation date
     means confirmed, none means open. Confirmed By is not a substitute, as a
     few open rows carry a name with the open-row zero time. */
  const derivedStatus = cStat < 0 && cDate >= 0;
  if(cAct < 0 || cType < 0 || (cStat < 0 && !derivedStatus)) throw new Error('missing Activity / Source Storage Type / Warehouse Task Status (or Confirmation Date to stand in for it)');
  const rules = String(areaMapText || '').split('\n').map(l => l.split('=')).filter(p => p.length === 2)
    .map(p => ({ prefix: p[0].trim().toUpperCase(), area: p[1].trim() })).sort((a, b) => b.prefix.length - a.prefix.length);
  const areaOf = st => { const r = rules.find(x => st.indexOf(x.prefix) === 0); return r ? r.area : 'Other'; };
  const areas = {}, pickers = {}, hours = {};
  let confirmed = 0, open = 0, pickRows = 0;
  for(let i = hIdx + 1; i < rows.length; i++){
    const r = rows[i] || [];
    if(String(r[cAct] == null ? '' : r[cAct]).trim().toUpperCase() !== 'PICK') continue;
    pickRows++;
    const st = String(r[cType] == null ? '' : r[cType]).trim().toUpperCase();
    const area = areaOf(st);
    const a = areas[area] = areas[area] || { area, confirmed: 0, open: 0, times: [], who: new Set() };
    const status = derivedStatus
      ? (String(r[cDate] == null ? '' : r[cDate]).trim() ? 'C' : '')
      : String(r[cStat] == null ? '' : r[cStat]).trim().toUpperCase();
    if(status === 'C'){
      if(cDate >= 0){ const d = parseExcelDate(r[cDate]); if(d && dayKey(d) !== todayKey) continue; }
      confirmed++; a.confirmed++;
      const who = cWho >= 0 ? String(r[cWho] == null ? '' : r[cWho]).trim() : '';
      if(who){ pickers[who] = (pickers[who] || 0) + 1; a.who.add(who.toUpperCase()); }
      if(cTime >= 0){ const ms = parseExcelTime(r[cTime]); if(ms){ const h = ms / 3600000; a.times.push(h); const hk = Math.floor(h); hours[hk] = (hours[hk] || 0) + 1; } }
    } else if(!status){ open++; a.open++; }
  }
  const out = Object.values(areas).map(a => {
    let rate = null;
    if(a.times.length > 1){ const span = Math.max(0.25, Math.max.apply(null, a.times) - Math.min.apply(null, a.times)); rate = a.times.length / span; }
    return { area: a.area, confirmed: a.confirmed, open: a.open, pickers: a.who.size,
             ratePerHour: rate == null ? null : Math.round(rate * 10) / 10 };
  }).sort((a, b) => b.confirmed - a.confirmed);
  return { areas: out, confirmed, open, pickRows, pickers, hours };
}

/* Warehouse task export -> one entry per person who confirmed a pick today,
   with the areas they picked from and the clock time of each confirmation.
   The clock times are what the active-time model in pickers.js works on. */
/* The header names of a task export, so the page can offer the real columns
   instead of a guess. */
function taskColumns(rows){
  const hIdx = headerIndex(rows, ['warehouse task'], 12);
  if(hIdx < 0) return [];
  return (rows[hIdx] || []).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
}
/* shiftOf(hour) -> shift name comes from the schedule (server/schedule.js);
   this only needs to know which shift a pick belongs to */
function computePickers(rows, areaMapText, todayKey, lineKeys, shiftOf){
  const hIdx = headerIndex(rows, ['warehouse task'], 12);
  if(hIdx < 0) throw new Error('no Warehouse Task header');
  const H = norm(rows[hIdx]);
  const find = makeFinder(H);
  const cAct = find('activity'), cType = find('source storage type'), cStat = find('warehouse task status');
  const cWho = find('confirmed by'), cDate = find('confirmation date'), cTime = find('confirmation time');
  if(cWho < 0 || cTime < 0) throw new Error('missing Confirmed By or Confirmation Time');
  /* A "line" is a delivery line. One line split across two bins makes two
     warehouse tasks, so counting distinct values of the chosen column(s) is
     what separates lines from picks. With nothing chosen, a task is a line. */
  const lineCols = (Array.isArray(lineKeys) ? lineKeys : String(lineKeys || '').split(','))
    .map(x => String(x).trim().toLowerCase()).filter(Boolean)
    .map(want => H.findIndex(h => h === want || h.indexOf(want) === 0)).filter(i => i >= 0);
  const rules = String(areaMapText || '').split('\n').map(l => l.split('=')).filter(p => p.length === 2)
    .map(p => ({ prefix: p[0].trim().toUpperCase(), area: p[1].trim() })).sort((a, b) => b.prefix.length - a.prefix.length);
  const areaOf = st => { const r = rules.find(x => st.indexOf(x.prefix) === 0); return r ? r.area : 'Other'; };
  const starts = typeof shiftOf === 'function' ? shiftOf : null;
  const blank = who => ({ who, total: 0, byArea: {}, times: [], evt: [], firstH: null, lastH: null, lineSet: null, lines: 0, hourPicks: {}, hourLines: {}, shifts: {} });
  const bump = (rec, h, area, key) => {
    rec.total++;
    const hb = Math.floor(h);
    rec.hourPicks[hb] = (rec.hourPicks[hb] || 0) + 1;
    if(key && key.replace(/\u0001/g, '')){
      (rec.lineSet || (rec.lineSet = new Set())).add(key);
      (rec.hourLines[hb] || (rec.hourLines[hb] = new Set())).add(key);
    }
    rec.byArea[area] = (rec.byArea[area] || 0) + 1;
    rec.times.push(h);
    /* the pair, in confirmation order, so time can be credited to the area
       that was being picked at the time rather than split by guesswork */
    rec.evt.push([h, area]);
    if(rec.firstH == null || h < rec.firstH) rec.firstH = h;
    if(rec.lastH == null || h > rec.lastH) rec.lastH = h;
  };
  const finish = r => {
    r.lines = r.lineSet ? r.lineSet.size : r.total;
    delete r.lineSet;
    const hl = {};
    for(const h in r.hourLines) hl[h] = r.hourLines[h].size;
    r.hourLines = Object.keys(hl).length ? hl : null;
  };
  const out = {};
  for(let i = hIdx + 1; i < rows.length; i++){
    const r = rows[i] || [];
    if(cAct >= 0 && String(r[cAct] == null ? '' : r[cAct]).trim().toUpperCase() !== 'PICK') continue;
    if(cStat >= 0 && String(r[cStat] == null ? '' : r[cStat]).trim().toUpperCase() !== 'C') continue;
    if(cDate >= 0 && todayKey){ const d = parseExcelDate(r[cDate]); if(d && dayKey(d) !== todayKey) continue; }
    const who = String(r[cWho] == null ? '' : r[cWho]).trim().toUpperCase();
    if(!who) continue;
    const ms = parseExcelTime(r[cTime]);
    if(!ms && ms !== 0) continue;
    const h = ms / 3600000;
    const area = areaOf(cType >= 0 ? String(r[cType] == null ? '' : r[cType]).trim().toUpperCase() : '');
    const key = lineCols.length ? lineCols.map(ci => String(r[ci] == null ? '' : r[ci]).trim()).join('\u0001') : '';
    const rec = out[who] || (out[who] = blank(who));
    bump(rec, h, area, key);
    /* the same again for the shift the pick fell in, so a shift can be
       shown on its own with numbers that are exact rather than a share */
    if(starts){
      const sk = starts(h);
      bump(rec.shifts[sk] || (rec.shifts[sk] = blank(who)), h, area, key);
    }
  }
  for(const who in out){
    finish(out[who]);
    for(const k in out[who].shifts) finish(out[who].shifts[k]);
    if(!Object.keys(out[who].shifts).length) delete out[who].shifts;
  }
  return out;
}

/* Where every row of the task export went. Built for one question: when a
   pick rate looks too low, is the arithmetic wrong or is the export short?
   It reports the funnel and the actual values seen, so nothing has to be
   guessed about how this system spells things. */
function pickerDiag(rows, todayKey){
  const out = { ok: false, rows: 0, funnel: {}, activity: [], status: [], confDates: [], createDates: [], missing: [], createSpan: null };
  const hIdx = headerIndex(rows, ['warehouse task'], 12);
  if(hIdx < 0){ out.note = 'no Warehouse Task header found'; return out; }
  const H = norm(rows[hIdx]);
  const find = makeFinder(H);
  const c = { act: find('activity'), stat: find('warehouse task status'), who: find('confirmed by'),
              cdate: find('confirmation date'), ctime: find('confirmation time'), crdate: find('creation date') };
  const NEED = { who: ['Confirmed By', 'need'], ctime: ['Confirmation Time', 'need'],
                 act: ['Activity', 'filter'], stat: ['Warehouse Task Status', c.cdate >= 0 ? 'derived' : 'filter'],
                 cdate: ['Confirmation Date', 'filter'], crdate: ['Creation Date', 'diag'] };
  Object.keys(NEED).forEach(k => { if(c[k] < 0) out.missing.push({ key: k, label: NEED[k][0], kind: NEED[k][1] }); });
  const tally = {}; ['activity', 'status', 'confDates', 'createDates'].forEach(k => tally[k] = {});
  const f = { total: 0, isPick: 0, confirmed: 0, confirmedToday: 0, hasWho: 0, hasTime: 0 };
  const val = (r, i) => i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim();
  const bump = (k, x) => { const key = x || '(blank)'; tally[k][key] = (tally[k][key] || 0) + 1; };
  for(let i = hIdx + 1; i < rows.length; i++){
    const r = rows[i] || [];
    if(!r.length || !r.some(x => String(x == null ? '' : x).trim())) continue;
    f.total++;
    const act = val(r, c.act), st = val(r, c.stat);
    bump('activity', act.toUpperCase());
    bump('status', st.toUpperCase());
    const cd = parseExcelDate(val(r, c.cdate));
    if(cd) bump('confDates', dayKey(cd));
    const crd = parseExcelDate(val(r, c.crdate));
    if(crd) bump('createDates', dayKey(crd));
    if(c.act >= 0 && act.toUpperCase() !== 'PICK') continue;
    f.isPick++;
    // no status column: the confirmation date says confirmed or open
    if(c.stat >= 0 ? st.toUpperCase() !== 'C' : (c.cdate >= 0 && !val(r, c.cdate))) continue;
    f.confirmed++;
    if(cd && dayKey(cd) !== todayKey) continue;
    f.confirmedToday++;
    if(!val(r, c.who)) continue;
    f.hasWho++;
    const ms = parseExcelTime(val(r, c.ctime));
    if(!ms && ms !== 0) continue;
    f.hasTime++;
  }
  const top = k => Object.keys(tally[k]).map(x => [x, tally[k][x]]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  out.ok = true;
  out.rows = f.total;
  out.funnel = f;
  out.activity = top('activity');
  out.status = top('status');
  out.confDates = top('confDates');
  out.createDates = top('createDates');
  const cds = Object.keys(tally.createDates).sort();
  if(cds.length) out.createSpan = { from: cds[0], to: cds[cds.length - 1], days: cds.length };
  return out;
}

module.exports = { DEFAULT_TARGETS, parseTargets, targetFor, parseExcelDate, parseExcelTime, binZone, normCg, dayKey, headerIndex, makeFinder, computeLanes, computeOrders, computeTasks, computePickers, pickMarks, taskColumns, pickerDiag, classifyHeader, norm };
