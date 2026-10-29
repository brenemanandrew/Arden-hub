'use strict';
/* The only money on this board.

   The warehouse prices nothing. EWM records what was moved - quantities,
   weights, volumes, bins, handling units - and every column of all three
   of its exports was read looking for a value and there is none. The
   money comes from ECC, where the business keeps it, in two delivery
   exports the staging service pulls off VL06O and drops in the same
   folder as everything else.

     SAP Deliveries.TXT   the open book, with Tt.Del.Val against a
                          delivery. Joined to our own order export - a
                          delivery whose every line is picked - it gives
                          the value standing finished and waiting.
     SAP PGI.TXT          what actually left, with Total Del.Val and the
                          real goods-issue date and time.

   Both are at DELIVERY level, and that is as far as it goes. Nothing
   ties a shipped carton to a delivery on this floor - the delivery is
   blank on 100% of a packer's own rows - so there is no value per
   packer and no honest way to make one. Do not try.

   Two rules run through all of it. A number is shown only when it can be
   stood behind, and when it cannot the tile says which file is missing
   rather than showing a zero. And a total is reported with how much of
   the thing it covers, because a sum over the deliveries we happened to
   find a price for is not the value shipped - it is the value of what
   could be priced, which is a different sentence. */

const { table, num, dayKeyOf } = require('./packmodel');
const schedule = require('./schedule');

/* the same column under the different names three systems give it; the
   first one the file actually has, wins */
const DELIVERY = ['delivery', 'deliv', 'delivery number', 'dlv'];
const OPEN_VALUE = ['tt del val', 'total del val', 'delivery value', 'net value', 'value'];
const SHIPPED_VALUE = ['total del val', 'tt del val', 'delivery value', 'net value', 'value'];
const GI_DATE = ['ac gi date', 'actual gi date', 'gi date', 'goods issue date'];
const GI_TIME = ['ac gi time', 'actual gi time', 'gi time', 'goods issue time'];
const CURRENCY = ['curr', 'currency'];

const firstOf = (t, names) => names.find(n => t.has(n)) || '';

/* a clock that may be a fraction of a day, or may be "14:30" */
function hourOf(v){
  const s = String(v == null ? '' : v).trim();
  if(!s) return null;
  const hm = /^(\d{1,2}):(\d{2})/.exec(s);
  if(hm) return (+hm[1]) + (+hm[2]) / 60;
  const f = Number(s);
  if(isFinite(f) && f >= 0 && f < 1) return f * 24;
  return null;
}

/* One row a delivery is what these files are, but a file is a file: if a
   delivery turns up twice its value is counted once, because a total
   that double counts is worse than no total at all. */
function readValues(rows, valueNames, opt){
  const t = table(rows, [DELIVERY[0], valueNames[0]]);
  if(!t) return { ok: false, why: 'that export has no readable header' };
  const dCol = firstOf(t, DELIVERY);
  const vCol = firstOf(t, valueNames);
  if(!dCol) return { ok: false, why: 'no delivery column in that export' };
  if(!vCol) return { ok: false, why: 'no value column in that export' };
  const cCol = firstOf(t, CURRENCY);
  const dateCol = (opt && opt.dated) ? firstOf(t, GI_DATE) : '';
  const timeCol = (opt && opt.dated) ? firstOf(t, GI_TIME) : '';

  const by = new Map();
  const currencies = new Set();
  const days = new Set();
  for(const r of t.rows){
    const d = t.get(r, dCol);
    if(!d) continue;
    const rec = { value: num(t.get(r, vCol)) };
    if(dateCol){
      const day = dayKeyOf(t.get(r, dateCol));
      if(day){ rec.day = day; days.add(day); }
      if(timeCol) rec.hour = hourOf(t.get(r, timeCol));
    }
    if(cCol){ const c = t.get(r, cCol); if(c) currencies.add(c.toUpperCase()); }
    const had = by.get(d);
    if(!had || (!had.value && rec.value)) by.set(d, rec);   // the fuller row wins
  }
  return {
    ok: true, by, days: Array.from(days).sort(),
    currency: currencies.size === 1 ? Array.from(currencies)[0] : '',
    dated: !!dateCol, timed: !!timeCol, rows: t.rows.length, valueColumn: vCol
  };
}

/* Our own order export, keyed by the SAP delivery number rather than by
   the consolidation group the rest of the board groups on: the value
   file is keyed on the delivery, so the join has to be too. */
function pickedDeliveries(rows){
  const t = table(rows, ['erp document', 'picking status']);
  if(!t || !t.has('erp document')) return { ok: false, why: 'no ERP Document in the order export' };
  if(!t.has('picking status')) return { ok: false, why: 'no Picking Status in the order export' };
  const g = new Map();
  for(const r of t.rows){
    const d = t.get(r, 'erp document');
    if(!d) continue;
    const st = t.get(r, 'picking status').toLowerCase();
    let x = g.get(d);
    if(!x){ x = { lines: 0, done: 0 }; g.set(d, x); }
    x.lines++;
    if(st.indexOf('complet') === 0) x.done++;
  }
  const done = [];
  for(const [d, x] of g) if(x.lines && x.done === x.lines) done.push(d);
  return { ok: true, all: g, done };
}

/* A delivery is written with leading zeros in one system and without in
   another, so both sides are compared stripped. */
const keyOf = d => String(d == null ? '' : d).trim().replace(/^0+/, '');

/* q: { keys, shift, sched, live } - the days the board is showing, the
   shift filter, and whether the range ends today. */
function compute(app, q){
  const ing = app.ingest;
  const out = { shipped: null, pick: null };
  const want = (q && q.keys) || [];
  const shift = (q && q.shift) || null;
  const sched = (q && q.sched) || null;

  /* ---- what left, and what it was worth ---------------------------- */
  const pgiRows = ing.fullRows('pgi');
  if(!pgiRows) out.shipped = { ok: false, why: 'waiting on SAP PGI.TXT' };
  else {
    const f = readValues(pgiRows, SHIPPED_VALUE, { dated: true });
    if(!f.ok) out.shipped = f;
    else {
      let total = 0, n = 0, offShift = 0;
      for(const rec of f.by.values()){
        if(f.dated && want.length){
          if(!rec.day || want.indexOf(rec.day) < 0) continue;
          if(shift && sched && rec.hour != null){
            /* shiftAt answers with the shift itself, not its name */
            const s = schedule.shiftAt(sched, rec.day, rec.hour);
            if(s && s.name !== shift){ offShift++; continue; }
          }
        }
        total += rec.value; n++;
      }
      out.shipped = {
        ok: true, total: Math.round(total * 100) / 100, deliveries: n,
        currency: f.currency, dated: f.dated, timed: f.timed,
        fileDays: f.days, shiftFiltered: shift ? offShift : 0,
        /* a file whose dates miss the range entirely is the difference
           between "nothing shipped" and "this file is not about today" */
        covers: !f.dated || !want.length || f.days.some(d => want.indexOf(d) >= 0)
      };
    }
  }

  /* ---- what is picked and waiting, and what it is worth ------------ */
  const delRows = ing.fullRows('sapdel');
  if(!delRows) out.pick = { ok: false, why: 'waiting on SAP Deliveries.TXT' };
  else if(!q || !q.live) out.pick = { ok: false, why: 'the open book is a picture of right now, not of a day gone by' };
  else {
    const f = readValues(delRows, OPEN_VALUE, {});
    const p = pickedDeliveries(ing.fullRows('orders'));
    if(!f.ok) out.pick = f;
    else if(!p.ok) out.pick = p;
    else {
      const priced = new Map();
      for(const [k, v] of f.by) priced.set(keyOf(k), v);
      let total = 0, matched = 0;
      for(const d of p.done){
        const rec = priced.get(keyOf(d));
        if(!rec) continue;
        total += rec.value; matched++;
      }
      out.pick = {
        ok: true, total: Math.round(total * 100) / 100,
        deliveries: matched, of: p.done.length,
        pct: p.done.length ? Math.round(matched / p.done.length * 100) : 0,
        currency: f.currency, priced: f.by.size
      };
    }
  }
  return out;
}

module.exports = { compute, readValues, pickedDeliveries, keyOf };
