'use strict';
/* ============================================================
   The Shift view: one screen for the shift running now, built from the
   modules' own answers so it can never disagree with their pages.

     Pick   /stage/api/pickers?shift=live    picks, crew % of standard
     Pack   /pack/api/pack                   units out, benches, packers
     Stage  /stage/api/board                 lanes, ready, late, clear next
     Ship   /stage/api/board + /pack value   orders cleared, $ shipped

   Every number carries where it came from and when; a module that is
   down or has no data says so on the card rather than showing a zero.
   Cached for 15 seconds so a TV refreshing every half minute does not
   ask the modules four times a minute each.
   ============================================================ */
let cache = { at: 0, model: null };

function age(ms, now) { return ms == null ? null : Math.max(0, Math.round((now - ms) / 60000)); }

async function fetchAll(modules) {
  const want = {
    board: ['stage', '/api/board'],
    pickers: ['stage', '/api/pickers?shift=live'],
    status: ['stage', '/api/status'],
    pack: ['pack', '/api/pack'],
    packHealth: ['pack', '/api/health']
  };
  const out = {};
  await Promise.all(Object.keys(want).map(async k => {
    const [id, p] = want[k];
    try { const r = await modules.getJson(id, p, 8000); out[k] = r.code === 200 ? r.body : null; if (r.code !== 200) out[k + 'Err'] = 'answered ' + r.code; }
    catch (e) { out[k] = null; out[k + 'Err'] = e.message; }
  }));
  return out;
}

function build(r, now) {
  const b = r.board, pk = r.pickers, st = r.status, pa = r.pack, ph = r.packHealth;
  const attention = [];
  const feeds = [];

  /* ---- Stage ---- */
  let stage = { available: false, why: r.boardErr || 'no answer' };
  if (b && b.summary) {
    const s = b.summary, p = b.pace || {}, f = b.feed || {};
    stage = {
      available: true, lanesUsed: s.lanesUsed, lanesTotal: s.lanesTotal, occupancyPct: s.occupancyPct, totes: s.totes,
      orders: s.orders, ready: s.ready, waiting: s.waiting, late: s.late, oldest: s.oldest || null,
      exceptions: s.exceptions || null, hospitalTotes: s.hospitalTotes || 0,
      clearNext: (b.clearNext || []).slice(0, 6).map(l => ({ bin: l.bin, age: l.age, ageMin: l.ageMin, ready: !!l.ready, orders: l.orders || [], note: l.note || '' })),
      stuck: (b.stuck || []).slice(0, 6),
      thresholds: b.thresholds || null,
      updated: f.updated || null, updatedAgeMin: age(f.updated, now), stale: !!f.stale, via: f.via || '', pushStale: !!f.pushStale, receivedAt: f.receivedAt || null,
      files: { stage: f.stage, orders: f.orders, wh: f.wh }
    };
    feeds.push({ id: 'stage', label: 'Staging lanes and orders', ok: !f.stale && !f.pushStale, detail: f.via === 'cloud' ? (f.receivedAt ? 'last push ' + age(f.receivedAt, now) + ' min ago' : 'no push received yet') : ('read ' + age(f.updated, now) + ' min ago') });
    if (f.pushStale) attention.push({ level: 'bad', text: 'The SAP PC has not pushed lanes and orders for over 10 minutes.', href: '/system' });
    else if (f.stale) attention.push({ level: 'warn', text: 'The lane and order exports are older than the stale limit.', href: '/system' });
    if (s.late) attention.push({ level: 'serious', text: s.late + ' order' + (s.late === 1 ? '' : 's') + ' past the late line in staging' + (s.oldest ? ', oldest ' + s.oldest.lane + ' at ' + s.oldest.age : '') + '.', href: '/stage/tv' });
    if (s.exceptions && s.exceptions.total) attention.push({ level: 'warn', text: s.exceptions.total + ' exception' + (s.exceptions.total === 1 ? '' : 's') + ' to fix: ' + ['loose', 'split', 'hospital', 'unknown', 'overdue'].filter(k => s.exceptions[k]).map(k => s.exceptions[k] + ' ' + k).join(', ') + '.', href: '/stage/ops' });
    if (p.goal && p.onPace === false) attention.push({ level: 'warn', text: 'Behind pace: ' + p.ordersClearedToday + ' of ' + p.goal + ' orders cleared, projecting ' + (p.projected == null ? '?' : p.projected) + '.', href: '/stage/ops' });
  } else attention.push({ level: 'bad', text: 'Staging Lane Health is not answering (' + stage.why + ').', href: '/system' });

  /* ---- Pick ---- */
  let pick = { available: false, why: r.pickersErr || 'no answer' };
  if (pk) {
    const sm = pk.summary || {}, fw = (pk.feed && pk.feed.wh) || {};
    const whOk = fw.status === 'ok';
    pick = {
      available: whOk && sm.pickers > 0, feedStatus: fw.status || 'missing', feedError: fw.error || '', feedRows: fw.rows || 0, feedReadAgeMin: age(fw.readAt, now),
      pickers: sm.pickers || 0, picks: sm.picks || 0, hours: sm.hours || 0, rate: sm.rate || 0, expected: sm.expected || 0, pct: sm.pct == null ? null : sm.pct,
      shiftName: pk.shiftName || null, scheduleText: pk.scheduleText || '', shift: pk.shift || null, dayHours: pk.dayHours, bands: pk.bands || null,
      top: (pk.people || []).slice(0, 5).map(x => ({ id: x.id || x.user || x.name, name: x.name || x.id || x.user, picks: x.picks, pct: x.pct })),
      minor: (pk.minor || []).length, targetsAreDefault: !!pk.targetsAreDefault,
      why: !whOk ? ('warehouse task export: ' + (fw.error || fw.status || 'not read')) : (sm.pickers ? '' : 'no picks on this shift yet')
    };
    feeds.push({ id: 'wh', label: 'Warehouse tasks', ok: whOk, detail: whOk ? (fw.rows + ' rows, read ' + age(fw.readAt, now) + ' min ago') : (fw.error || fw.status || 'missing') });
    if (!whOk) attention.push({ level: 'warn', text: 'No usable warehouse task export, so Pick and Pack rates are blank: ' + (fw.error || fw.status) + '.', href: '/system' });
    if (whOk && pk.targetsAreDefault) attention.push({ level: 'info', text: 'Pick standards are still the placeholders; every percent is against a guess until real ones are saved.', href: '/stage/pickers' });
  } else attention.push({ level: 'bad', text: 'The picker report is not answering (' + pick.why + ').', href: '/system' });

  /* ---- Pack ---- */
  let pack = { available: false, why: r.packErr || 'no answer' };
  if (pa && pa.summary) {
    const sm = pa.summary, src = pa.source || {}, have = pa.have || {};
    const filling = (pa.stations || []).filter(x => x.filling || x.flag === 'filling').map(x => x.bin || x.name || x.id);
    pack = {
      available: !!have.tasks, why: have.tasks ? '' : 'no warehouse task rows for today',
      out: sm.out || 0, units: sm.units || 0, lb: sm.lb || 0, vol: sm.vol || 0, volUnit: pa.volUnit || '', packers: sm.packers || 0, helpers: sm.helpers || 0, stations: sm.stations || 0,
      lines: sm.lines || 0, inLines: sm.inLines || 0, linesPerHour: sm.linesPerHour, perHour: sm.perHour, productive: sm.productive,
      lane: sm.lane || null, filling, stationList: (pa.stations || []).slice(0, 12).map(x => ({ bin: x.bin || x.name, out: x.out, people: x.people, filling: !!(x.filling || x.flag === 'filling') })),
      orders: pa.orders || null, source: { rows: src.rows, readAgeMin: age(src.readAt, now), status: src.status },
      value: pa.value || null
    };
    if (filling.length) attention.push({ level: 'warn', text: 'Filling up at ' + filling.join(', ') + ': work arriving faster than it leaves.', href: '/pack/pack' });
  } else attention.push({ level: 'bad', text: 'Arden Pack is not answering (' + pack.why + ').', href: '/system' });
  if (ph && ph.feed) {
    ['wh', 'orders', 'stage', 'sapdel', 'pgi'].forEach(k => { const f = ph.feed[k]; if (!f) return; if (f.optional && f.status !== 'ok') return;
      feeds.push({ id: 'pack-' + k, label: 'Pack: ' + (f.label || k), ok: f.status === 'ok', detail: f.status === 'ok' ? (f.rows + ' rows, read ' + age(f.readAt, now) + ' min ago') : (f.error || f.status) }); });
  }

  /* ---- Ship ---- */
  const pace = (b && b.pace) || {};
  const val = (pa && pa.value) || {};
  const ship = {
    available: !!b, ordersClearedToday: pace.ordersClearedToday || 0, ordersClearedYesterday: pace.ordersClearedYesterday || 0, totesClearedToday: pace.totesClearedToday || 0,
    goal: pace.goal || 0, projected: pace.projected, onPace: pace.onPace, ratePerHour: pace.ratePerHour || 0, hoursLeft: pace.hoursLeft, medianDwellMin: pace.medianDwellMin,
    linesPickedToday: pace.linesPickedToday || 0, linesPickedYesterday: pace.linesPickedYesterday || 0,
    byHour: pace.byHour || null, hourRange: pace.hourRange || null,
    shipped: val.shipped || { ok: false, why: 'no value feed' }, pickValue: val.pick || { ok: false, why: 'no value feed' },
    openDeliveries: pa && pa.orders ? pa.orders.deliveries : null, openLines: pa && pa.orders ? pa.orders.lines : null, pickedLines: pa && pa.orders ? pa.orders.picked : null
  };

  /* ---- the shift clock ---- */
  const shift = { name: (pk && pk.shiftName) || (pace.shift && pace.shift.name) || null, from: pace.shift ? pace.shift.from : null, to: pace.shift ? pace.shift.to : null,
                  hoursLeft: pace.hoursLeft, scheduleText: (pk && pk.scheduleText) || '', names: (pk && pk.shiftNames) || [] };

  /* ---- host side, when the copy knows ---- */
  let host = null;
  if (st && st.server) {
    const pl = st.puller || {}, cl = st.server.cloud || {};
    host = { version: st.server.version, mode: st.server.mode, pullEnabled: !!pl.enabled, pullRunning: !!pl.running, pullLastOk: pl.lastOkAt || pl.lastOk || null, pullError: pl.lastError || '', sap: pl.sap || null, feeder: cl.standby || null };
  }

  const order = { bad: 0, serious: 1, warn: 2, info: 3 };
  attention.sort((x, y) => order[x.level] - order[y.level]);
  return { ok: true, now, shift, pick, pack, stage, ship, feeds, attention, host };
}

async function shiftModel(modules) {
  const now = Date.now();
  if (cache.model && now - cache.at < 15000) return cache.model;
  const r = await fetchAll(modules);
  const model = build(r, now);
  cache = { at: now, model };
  return model;
}

module.exports = { shiftModel, build };
