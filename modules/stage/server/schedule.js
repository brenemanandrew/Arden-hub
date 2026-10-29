'use strict';
/* The working week: which shifts run on which days, when they start and
   end, and when the breaks fall. Everything else about time - what counts
   as active, which shift a pick belongs to, what is drawn as a break and
   what is collapsed as closed - is read off this.

   One shift per line:
     Mon-Fri 1st 07:00-15:30 setup 20 breaks 09:30=15, 11:30=30, 13:30=15
   days, a name, start-end, then "breaks" as clock time = minutes. An end
   earlier than the start means the shift runs past midnight.

   "setup N" is N minutes at the START of the shift - getting a truck, a
   scanner, a pick list. It is drawn so the thin first twenty minutes read
   as what they are rather than as nobody working, and it is written once
   per shift rather than as a clock time so second shift gets its own
   without anybody typing 16:00 anywhere.

   It is DRAWN and not subtracted. Breaks are taken out of active time
   because people do not pick through them; the first twenty minutes of a
   shift are different - a good number of picks land in them, and taking
   the time away while keeping the picks would hand somebody free rate. */
const DEFAULT_SCHEDULE = [
  'Mon-Fri 1st 07:00-15:30 setup 20 breaks 09:30=15, 11:30=30, 13:30=15',
  'Mon-Fri 2nd 16:00-00:30 setup 20 breaks 18:30=15, 20:00=30, 22:00=15',
  'Sat-Sun Weekend 06:00-18:00 setup 20 breaks 09:00=15, 12:00=30, 13:45=15, 15:45=15'
].join('\n');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function dayIdx(s){ return DAYS.indexOf(String(s || '').slice(0, 3).toLowerCase()); }
function daysIn(spec){
  const out = [];
  String(spec).split(',').forEach(part => {
    const m = /^\s*([a-z]{3})[a-z]*\s*(?:-\s*([a-z]{3})[a-z]*)?\s*$/i.exec(part);
    if(!m) return;
    const a = dayIdx(m[1]), b = m[2] ? dayIdx(m[2]) : a;
    if(a < 0 || b < 0) return;
    for(let d = a; ; d = (d + 1) % 7){ if(out.indexOf(d) < 0) out.push(d); if(d === b) break; }
  });
  return out;
}
function hm(h, m){ return (+h) + (+m) / 60; }
function round(n){ return Math.round(n * 1000) / 1000; }

function parseSchedule(text){
  const out = [];
  String(text == null ? '' : text).split('\n').forEach(line => {
    let l = line.trim();
    if(!l) return;
    /* "setup 20" can sit anywhere after the hours; it is lifted out before
       the rest is read so it does not have to fight the breaks for the end
       of the line */
    let setup = 0;
    const sm = /\bset-?up\s+(\d{1,3})\b/i.exec(l);
    if(sm){ setup = Math.max(0, Math.min(240, +sm[1])); l = (l.slice(0, sm.index) + ' ' + l.slice(sm.index + sm[0].length)).replace(/\s+/g, ' ').trim(); }
    const m = /^([a-z ,\-]+?)\s+(\S+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(?:\s+breaks?\s+(.*))?$/i.exec(l);
    if(!m) return;
    const days = daysIn(m[1]);
    if(!days.length) return;
    const start = hm(m[3], m[4]);
    let end = hm(m[5], m[6]);
    if(end <= start) end += 24;
    const breaks = [];
    const re = /(\d{1,2}):(\d{2})\s*=\s*(\d{1,3})/g;
    let b;
    while((b = re.exec(m[7] || ''))){
      let t = hm(b[1], b[2]);
      if(t < start) t += 24;                 // a break after midnight on a shift that crosses it
      if(t >= start && t <= end) breaks.push({ t, min: +b[3] });
    }
    out.push({ days, name: m[2], start, end, breaks, setup });
  });
  return out;
}
/* blank means the built-in week above; the word none means no schedule at
   all, every hour counts and there is one shift */
function effectiveText(text){
  const t = String(text == null ? '' : text).trim();
  if(!t) return DEFAULT_SCHEDULE;
  return t.toLowerCase() === 'none' ? '' : text;
}
function weekday(dayKey){ return new Date(dayKey + 'T12:00:00').getDay(); }
function prevKey(dayKey){ const d = new Date(dayKey + 'T12:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }
/* the shifts that begin on this day */
function shiftsOn(sched, dayKey){ const wd = weekday(dayKey); return sched.filter(s => s.days.indexOf(wd) >= 0); }
/* the tail of yesterday's shifts that runs into this day, in this day's hours */
function spillInto(sched, dayKey){
  return shiftsOn(sched, prevKey(dayKey)).filter(s => s.end > 24).map(s => ({
    name: s.name, start: s.start - 24, end: s.end - 24, fromPrev: true,
    breaks: s.breaks.filter(b => b.t >= 24).map(b => ({ t: b.t - 24, min: b.min }))
  }));
}
function clip(a, b){ const x = Math.max(0, a), y = Math.min(24, b); return y > x ? [round(x), round(y)] : null; }
function merge(list){
  const a = list.filter(Boolean).sort((x, y) => x[0] - y[0]);
  const out = [];
  a.forEach(([x, y]) => { const l = out[out.length - 1]; if(l && x <= l[1]) l[1] = Math.max(l[1], y); else out.push([x, y]); });
  return out;
}
/* One day's shape: working windows, breaks, closed stretches, all in
   hours 0 to 24 of that calendar day. `wrap` is how far yesterday's last
   shift reaches into this morning, which a typical-day view needs. */
function dayShape(sched, dayKey){
  if(!sched || !sched.length) return { working: [[0, 24]], breaks: [], closed: [], setup: [], blocked: [], wrap: 0, shifts: [] };
  const own = shiftsOn(sched, dayKey), spill = spillInto(sched, dayKey);
  const working = merge(own.map(s => clip(s.start, s.end)).concat(spill.map(s => clip(0, s.end))));
  const breaks = merge(own.concat(spill).reduce((acc, s) => acc.concat(s.breaks.map(b => clip(b.t, b.t + b.min / 60))), []));
  const closed = [];
  let cur = 0;
  working.forEach(([a, b]) => { if(a > cur) closed.push([round(cur), a]); cur = b; });
  if(cur < 24) closed.push([round(cur), 24]);
  /* only the shifts that START today: a shift that ran in from yesterday
     had its setup yesterday. Drawn, never blocked - see the note up top. */
  const setup = merge(own.filter(s => s.setup > 0).map(s => clip(s.start, s.start + s.setup / 60)));
  return { working, breaks, closed, setup, blocked: merge(closed.concat(breaks)), wrap: Math.max(0, ...spill.map(s => s.end)),
           shifts: own.map(s => ({ name: s.name, start: s.start, end: s.end })).concat(spill.map(s => ({ name: s.name, start: s.start, end: s.end, fromPrev: true }))) };
}
/* Which shift a pick at hour h of dayKey belongs to. A pick outside every
   window (early, late, between shifts) goes to the nearest one. */
function shiftAt(sched, dayKey, h){
  if(!sched || !sched.length) return { name: 'Day', start: 0, fromPrev: false };
  const cands = shiftsOn(sched, dayKey).map(s => ({ name: s.name, start: s.start, end: s.end, fromPrev: false }))
    .concat(spillInto(sched, dayKey).map(s => ({ name: s.name, start: s.start, end: s.end, fromPrev: true })));
  if(!cands.length){
    // a day with no shift of its own: whatever ran most recently
    const y = shiftsOn(sched, prevKey(dayKey));
    return y.length ? { name: y[y.length - 1].name, start: y[y.length - 1].start - 24, fromPrev: true } : { name: 'Day', start: 0, fromPrev: false };
  }
  const hit = cands.find(s => h >= s.start && h < s.end);
  if(hit) return hit;
  let best = null, bd = Infinity;
  cands.forEach(s => { const d = h < s.start ? s.start - h : h - s.end; if(d < bd){ bd = d; best = s; } });
  return best;
}
/* The shift that is on now, or the one that ended most recently, and the
   day records that hold it. */
function liveShift(sched, now){
  const pad = n => String(n).padStart(2, '0');
  const key = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = key(now), yesterday = prevKey(today);
  const h = now.getHours() + now.getMinutes() / 60;
  const s = shiftAt(sched, today, h);
  // between shifts, shiftAt picks the nearer; for a live view the one that has ended is the honest choice
  let pick = s;
  if(!(h >= s.start && h < (s.end == null ? 24 : s.end))){
    const cands = shiftsOn(sched, today).map(x => ({ name: x.name, start: x.start, end: x.end, fromPrev: false }))
      .concat(spillInto(sched, today).map(x => ({ name: x.name, start: x.start, end: x.end, fromPrev: true })))
      .filter(x => x.end <= h).sort((a, b) => b.end - a.end);
    if(cands.length) pick = cands[0];
  }
  const fromPrev = !!pick.fromPrev;
  const offset = {};
  if(fromPrev){ offset[yesterday] = 0; offset[today] = 24; } else offset[today] = 0;
  return { key: pick.name, label: pick.name + ' shift', start: fromPrev ? pick.start + 24 : pick.start, end: fromPrev ? pick.end + 24 : pick.end,
           startDay: fromPrev ? yesterday : today, keys: Object.keys(offset), offset, nowH: fromPrev ? h + 24 : h };
}
function names(sched){ const out = []; (sched || []).forEach(s => { if(out.indexOf(s.name) < 0) out.push(s.name); }); return out; }

module.exports = { DEFAULT_SCHEDULE, effectiveText, parseSchedule, dayShape, shiftAt, liveShift, shiftsOn, names, weekday, prevKey };
