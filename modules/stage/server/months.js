'use strict';
/* The year, a month at a time.

   The daily rollup already holds, for every person on every day, the picks
   they confirmed in each area and the hours they were credited as working
   in each area. A month is those days added up - and the addition has to be
   done in that order, per area, because the areas run at very different
   rates and the mix changes week to week. Adding picks and dividing by
   hours across the whole month would make a month heavy on cantilever look
   like a bad month rather than a different one.

   So the headline number is the percentage of standard: what the hours
   worked should have produced at each area's own standard rate, against
   what they actually produced. A month of nothing but cantilever and a
   month of nothing but flow are then comparable, which is the whole point
   of putting twelve of them side by side.

     expected = sum over areas of (hours in that area x that area's standard)
     percent  = picks / expected

   The same arithmetic is done per day, which is what the chart in each card
   draws, so a card's bars and its headline are the same measurement at two
   resolutions rather than two measurements that happen to sit together. */
const model = require('./model');
const { targetFor } = model;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function round(n, d){ const m = Math.pow(10, d == null ? 1 : d); return Math.round(n * m) / m; }
function monthKey(dayKey){ return String(dayKey).slice(0, 7); }
function monthLabel(key){
  const p = String(key).split('-');
  const i = (parseInt(p[1], 10) || 1) - 1;
  return (MONTH_NAMES[i] || key) + ' ' + p[0];
}

/* One day's totals, per area, from the rollup's record of that day. A day
   recorded before per-area hours existed is spread by pick share, the same
   fallback the picker report uses, so an old month still reads sensibly. */
function dayTotals(entry, hide){
  const picks = {}, hours = {}, who = {};
  let total = 0, active = 0;
  for(const w in ((entry && entry.pickers) || {})){
    if(hide.indexOf(w.toUpperCase()) >= 0) continue;
    const r = entry.pickers[w];
    if(!r || !r.total) continue;
    who[w] = true;
    total += r.total;
    active += r.activeHours || 0;
    const ah = r.areaHours || null;
    for(const a in (r.byArea || {})){
      const n = r.byArea[a];
      const h = (ah && ah[a] != null) ? ah[a] : (r.activeHours || 0) * (n / Math.max(1, r.total));
      picks[a] = (picks[a] || 0) + n;
      hours[a] = (hours[a] || 0) + h;
    }
  }
  return { picks, hours, who, total, active };
}

/* What those hours should have produced. Areas with no standard of their
   own fall through to "other", which is what targetFor already does, so an
   area that appears for the first time is still measured rather than
   silently dropped out of the denominator. */
function expectedFrom(hours, targets){
  let exp = 0;
  for(const a in hours) exp += hours[a] * targetFor(targets, a);
  return exp;
}

/* months = how many calendar months back to cover, today's month included.
   Months with nothing recorded are left out rather than drawn empty: a
   gallery of blanks says less than a gallery of the months that happened. */
function build(pickers, opt){
  opt = opt || {};
  const st = pickers.settings();
  const hide = st.hide || [];
  const want = Math.max(1, Math.min(36, parseInt(opt.months, 10) || 13));
  const today = opt.todayKey || model.dayKey(new Date());
  const first = (() => {
    const d = new Date(today + 'T12:00:00');
    d.setDate(1);
    d.setMonth(d.getMonth() - (want - 1));
    return monthKey(model.dayKey(d));
  })();

  const byMonth = new Map();
  const keys = Object.keys(pickers.history || {}).sort();
  for(const k of keys){
    const mk = monthKey(k);
    if(mk < first || k > today) continue;
    const d = dayTotals(pickers.history[k], hide);
    if(!d.total) continue;
    let m = byMonth.get(mk);
    if(!m){ m = { key: mk, label: monthLabel(mk), picks: 0, hours: 0, active: 0, expected: 0,
                  picksBy: {}, hoursBy: {}, who: {}, series: [] }; byMonth.set(mk, m); }
    const exp = expectedFrom(d.hours, st.targets);
    let dayHours = 0;
    for(const a in d.hours){
      dayHours += d.hours[a];
      m.picksBy[a] = (m.picksBy[a] || 0) + d.picks[a];
      m.hoursBy[a] = (m.hoursBy[a] || 0) + d.hours[a];
    }
    m.picks += d.total;
    m.hours += dayHours;
    m.active += d.active;
    m.expected += exp;
    for(const w in d.who) m.who[w] = true;
    m.series.push({
      day: k,
      dow: new Date(k + 'T12:00:00').getDay(),
      picks: d.total,
      hours: round(dayHours, 1),
      people: Object.keys(d.who).length,
      rate: dayHours > 0 ? round(d.total / dayHours, 1) : null,
      pct: exp > 0 ? Math.round((d.total / exp) * 100) : null
    });
  }

  const months = Array.from(byMonth.values()).sort((a, b) => a.key < b.key ? -1 : 1).map(m => {
    const areas = Object.keys(m.picksBy).map(a => {
      const h = m.hoursBy[a] || 0, n = m.picksBy[a] || 0, t = targetFor(st.targets, a);
      return { area: a, picks: n, hours: round(h, 1), share: m.picks ? Math.round((n / m.picks) * 100) : 0,
               rate: h > 0 ? round(n / h, 1) : null, target: t || null,
               pct: (h > 0 && t > 0) ? Math.round((n / h / t) * 100) : null };
    }).sort((a, b) => b.picks - a.picks);
    const days = m.series.length;
    return {
      key: m.key, label: m.label, days,
      picks: m.picks,
      hours: round(m.hours, 1),
      people: Object.keys(m.who).length,
      perDay: days ? Math.round(m.picks / days) : 0,
      rate: m.hours > 0 ? round(m.picks / m.hours, 1) : null,
      expected: Math.round(m.expected),
      pct: m.expected > 0 ? Math.round((m.picks / m.expected) * 100) : null,
      areas,
      series: m.series.sort((a, b) => a.day < b.day ? -1 : 1)
    };
  });

  /* The whole span on one line, weighted the same way, so the strip above
     the gallery is the gallery added up rather than an average of averages. */
  let picks = 0, hours = 0, expected = 0, days = 0;
  const everyone = {};
  months.forEach(m => { picks += m.picks; hours += m.hours; expected += m.expected; days += m.days; });
  keys.forEach(k => {
    if(monthKey(k) < first || k > today) return;
    const e = pickers.history[k];
    for(const w in ((e && e.pickers) || {})){
      if(hide.indexOf(w.toUpperCase()) >= 0) continue;
      if((e.pickers[w] || {}).total) everyone[w] = true;
    }
  });

  return {
    at: Date.now(),
    months,
    from: months.length ? months[0].key : null,
    to: months.length ? months[months.length - 1].key : null,
    total: {
      days, picks, hours: round(hours, 1), expected: Math.round(expected),
      people: Object.keys(everyone).length,
      rate: hours > 0 ? round(picks / hours, 1) : null,
      pct: expected > 0 ? Math.round((picks / expected) * 100) : null
    },
    targets: st.targetsText,
    historyDays: Object.keys(pickers.history || {}).length
  };
}

module.exports = { build, monthLabel, monthKey, dayTotals, expectedFrom };
