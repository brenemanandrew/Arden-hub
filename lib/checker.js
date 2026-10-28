'use strict';
/* ============================================================
   The checker: asks every dashboard how it is, once a minute, and keeps
   the answers so the board can say more than "up right now".

   For each dashboard in dashboards.json with a `health` block it:
     1. fetches health.url (10 s limit, up to 3 redirects, Bearer key
        from the environment when `auth.bearerEnv` names one)
     2. decides UP / SLOW / STALE / DOWN:
          DOWN  - no answer, wrong status, or the body is not what
                  `expect` asks for
          SLOW  - answered, but slower than slowMs (default 3000)
          STALE - answered, but a `fields` entry with staleMin is older
                  than that, or empty when it should have a time
          UP    - everything else
     3. reads the `fields` out of a JSON body (counts, times, text) so
        the board can show what the dashboard is actually holding
     4. notes the TLS certificate's days left (https only)
   Samples are kept for 7 days (one a minute), transitions for 500 events,
   all in one plain JSON file on the data volume. Nothing in it is secret:
   it is the same information the board shows.

   Lessons this carries from the other Arden apps: a cloud copy that is
   "up" but has not been pushed to is the common failure (Staging Lane's
   feed pill goes red after 10 minutes), so data age is a first-class
   state, not a footnote; and one number must never disagree with another
   number on the same screen, so every figure here comes from the same
   sample.
   ============================================================ */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 7;
const MAX_EVENTS = 500;
const STATES = ['up', 'slow', 'stale', 'down'];          /* index = severity, worst wins */

/* ---------- fetching ---------- */
function fetchUrl(url, opts, hops) {
  opts = opts || {}; hops = hops | 0;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, err: 'bad address' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = mod.request(u, { method: 'GET', headers: Object.assign({ 'User-Agent': 'ArdenHub/1 (health check)', 'Accept': 'application/json, text/plain, text/html;q=0.5' }, opts.headers || {}),
                                 timeout: opts.timeoutMs || 10000, rejectUnauthorized: true }, (res) => {
      const code = res.statusCode | 0;
      let cert = null;
      try {
        const c = res.socket && res.socket.getPeerCertificate && res.socket.getPeerCertificate();
        if (c && c.valid_to) cert = { validTo: c.valid_to, daysLeft: Math.floor((Date.parse(c.valid_to) - Date.now()) / 86400000) };
      } catch (e) { /* plain http */ }
      if ([301, 302, 303, 307, 308].indexOf(code) >= 0 && res.headers.location && hops < 3) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, u).toString(), opts, hops + 1).then(r => Object.assign(r, { ms: Date.now() - t0, cert: r.cert || cert })));
      }
      const parts = []; let n = 0;
      res.on('data', c => { n += c.length; if (n <= 1024 * 1024) parts.push(c); });
      res.on('end', () => resolve({ ok: true, code: code, ms: Date.now() - t0, body: Buffer.concat(parts).toString('utf8'), type: String(res.headers['content-type'] || ''), cert: cert }));
      res.on('error', e => resolve({ ok: false, err: e.message, ms: Date.now() - t0 }));
    });
    req.on('timeout', () => { req.destroy(new Error('no answer in ' + Math.round((opts.timeoutMs || 10000) / 1000) + ' s')); });
    req.on('error', e => resolve({ ok: false, err: e.code === 'ENOTFOUND' ? 'address not found' : e.code === 'ECONNREFUSED' ? 'connection refused' : (e.message || String(e)), ms: Date.now() - t0 }));
    req.end();
  });
}

/* ---------- reading fields out of a body ---------- */
function dig(obj, p) {
  return String(p || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
/* ISO strings, epoch numbers, and the kiosk's "YYYY-MM-DD HH:mm" (Eastern) */
function parseWhen(v, tz) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    /* a wall-clock time in tz: find the UTC instant whose wall clock in tz reads the same */
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    const off = tzOffsetMs(guess, tz || 'America/New_York');
    return guess - off;
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}
function tzOffsetMs(utcMs, tz) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utcMs));
    const g = t => +(p.find(x => x.type === t) || {}).value;
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
  } catch (e) { return 0; }
}

function readFields(fields, json, tz, now) {
  const out = []; let stale = false;
  (fields || []).forEach(f => {
    const raw = json ? dig(json, f.path) : undefined;
    const r = { label: f.label || f.path, kind: f.kind || 'text', value: raw == null ? null : raw };
    if (f.kind === 'time') {
      const t = parseWhen(raw, tz);
      r.value = t; r.ageMin = t == null ? null : Math.max(0, Math.round((now - t) / 60000));
      if (f.staleMin) { r.staleMin = f.staleMin; r.stale = t == null || r.ageMin > f.staleMin; if (r.stale) stale = true; }
    } else if (f.kind === 'count') {
      r.value = raw == null || isNaN(+raw) ? null : +raw;
      if (f.min != null && (r.value == null || r.value < f.min)) { r.low = true; stale = true; }
    } else if (f.kind === 'bool') {
      r.value = !!raw;
      if (f.want != null && r.value !== !!f.want) { r.bad = true; stale = true; }
    } else {
      r.value = raw == null ? null : (typeof raw === 'object' ? JSON.stringify(raw).slice(0, 80) : String(raw).slice(0, 80));
    }
    out.push(r);
  });
  return { fields: out, stale: stale };
}

/* ---------- one probe ---------- */
async function probe(d, now) {
  const h = d.health;
  const headers = {};
  let keyMissing = false;
  if (h.auth && h.auth.bearerEnv) {
    const k = String(process.env[h.auth.bearerEnv] || '').trim();
    if (k) headers.Authorization = 'Bearer ' + k; else keyMissing = true;
  }
  if (h.auth && h.auth.basicEnv) {
    const k = String(process.env[h.auth.basicEnv] || '').trim();
    if (k) headers.Authorization = 'Basic ' + Buffer.from(k).toString('base64'); else keyMissing = true;
  }
  const r = await fetchUrl(h.url, { headers: headers, timeoutMs: h.timeoutMs || 10000 });
  const s = { t: now, state: 'down', ms: r.ms | 0, code: r.code | 0, err: '', cert: r.cert || null, fields: [], note: '' };
  if (!r.ok) { s.err = r.err || 'no answer'; return s; }
  const exp = h.expect || {};
  const okCodes = Array.isArray(exp.status) ? exp.status : [200];
  if (okCodes.indexOf(s.code) < 0) { s.err = 'answered ' + s.code; return s; }
  let json = null;
  if (/json/i.test(r.type) || /^\s*[\[{]/.test(r.body || '')) { try { json = JSON.parse(r.body); } catch (e) { json = null; } }
  if (exp.text != null && String(r.body || '').trim() !== String(exp.text)) { s.err = 'answered "' + String(r.body || '').trim().slice(0, 40) + '", expected "' + exp.text + '"'; return s; }
  if (exp.json) {
    if (!json) { s.err = 'did not answer with JSON'; return s; }
    for (const k of Object.keys(exp.json)) {
      if (JSON.stringify(dig(json, k)) !== JSON.stringify(exp.json[k])) { s.err = k + ' is ' + JSON.stringify(dig(json, k)) + ', expected ' + JSON.stringify(exp.json[k]); return s; }
    }
  }
  const rf = readFields(h.fields, json, h.tz, now);
  s.fields = rf.fields;
  let stale = rf.stale;
  if (keyMissing) s.note = 'no key set for ' + ((h.auth || {}).bearerEnv || (h.auth || {}).basicEnv) + ' - checked without it';
  /* An optional second request for what the dashboard is holding, when
     that lives behind a key (ardenot's op=ping). No key: skipped, and the
     board says so. A failed data request is STALE, not DOWN: the site
     itself answered. */
  const dd = h.data;
  if (dd && dd.url) {
    const dh = {}; let dKeyMissing = false;
    if (dd.auth && dd.auth.bearerEnv) { const k = String(process.env[dd.auth.bearerEnv] || '').trim(); if (k) dh.Authorization = 'Bearer ' + k; else dKeyMissing = true; }
    if (dd.auth && dd.auth.basicEnv) { const k = String(process.env[dd.auth.basicEnv] || '').trim(); if (k) dh.Authorization = 'Basic ' + Buffer.from(k).toString('base64'); else dKeyMissing = true; }
    if (dKeyMissing) {
      s.note = 'data check skipped: set ' + ((dd.auth || {}).bearerEnv || (dd.auth || {}).basicEnv) + ' to read what it holds';
    } else {
      const r2 = await fetchUrl(dd.url, { headers: dh, timeoutMs: dd.timeoutMs || 10000 });
      let j2 = null;
      if (r2.ok) { try { j2 = JSON.parse(r2.body); } catch (e) { j2 = null; } }
      if (!r2.ok || (r2.code | 0) !== 200 || !j2) { stale = true; s.note = 'data check failed: ' + (r2.err || ('answered ' + r2.code)); }
      else { const rf2 = readFields(dd.fields, j2, dd.tz || h.tz, now); s.fields = s.fields.concat(rf2.fields); if (rf2.stale) stale = true; }
    }
  }
  if (stale) s.state = 'stale';
  else if (s.ms > (h.slowMs || 3000)) s.state = 'slow';
  else s.state = 'up';
  if (s.cert && s.cert.daysLeft != null && s.cert.daysLeft < 14 && s.state === 'up') { s.state = 'slow'; s.note = 'certificate expires in ' + s.cert.daysLeft + ' days'; }
  return s;
}

/* ---------- the checker ---------- */
class Checker {
  constructor(config, opts) {
    opts = opts || {};
    this.config = config;
    this.file = opts.file || null;
    this.log = opts.log || console.log;
    this.intervalMs = opts.intervalMs || 60000;
    this.targets = (config.dashboards || []).filter(d => d.health && d.health.url);
    this.hist = {};          /* id -> [{t, s, ms}]  s = state index */
    this.last = {};          /* id -> last full sample */
    this.events = [];        /* [{t, id, from, to, why}] newest last */
    this.started = Date.now();
    this.runs = 0;
    this.running = false;
    this.timer = null;
    this.dirty = false;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.hist = o.hist || {}; this.last = o.last || {}; this.events = o.events || [];
      this.prune(Date.now());
    } catch (e) { if (e.code !== 'ENOENT') this.log('CHECKER: could not read ' + this.file + ': ' + e.message); }
  }
  save() {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), hist: this.hist, last: this.last, events: this.events }));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) { this.log('CHECKER: could not save ' + this.file + ': ' + e.message); }
  }
  prune(now) {
    const cut = now - KEEP_DAYS * 86400000;
    Object.keys(this.hist).forEach(id => {
      const a = this.hist[id]; let i = 0; while (i < a.length && a[i].t < cut) i++;
      if (i) this.hist[id] = a.slice(i);
    });
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    const now = Date.now();
    try {
      const results = await Promise.all(this.targets.map(d => probe(d, now).catch(e => ({ t: now, state: 'down', ms: 0, code: 0, err: String(e && e.message || e), cert: null, fields: [], note: '' }))));
      this.targets.forEach((d, i) => {
        const s = results[i];
        const prev = this.last[d.id];
        const from = prev ? prev.state : null;
        if (from !== s.state) {
          this.events.push({ t: now, id: d.id, from: from, to: s.state, why: s.err || s.note || (s.fields.filter(f => f.stale || f.low || f.bad).map(f => f.label).join(', ')) || '' });
          this.log('CHECK: ' + d.name + ' ' + (from || 'new') + ' -> ' + s.state.toUpperCase() + (s.err ? ' (' + s.err + ')' : '') + ' ' + s.ms + ' ms');
        }
        s.since = from === s.state && prev && prev.since ? prev.since : now;
        this.last[d.id] = s;
        (this.hist[d.id] = this.hist[d.id] || []).push({ t: now, s: STATES.indexOf(s.state), ms: s.ms });
      });
      this.runs++;
      this.prune(now);
      this.dirty = true;
    } finally { this.running = false; }
    return this.summary();
  }

  start() {
    const tick = () => { this.runOnce().catch(e => this.log('CHECKER: ' + (e && e.stack || e))); };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.saver = setInterval(() => this.save(), 5 * 60000);
    if (this.timer.unref) { this.timer.unref(); this.saver.unref(); }
  }
  stop() { clearInterval(this.timer); clearInterval(this.saver); this.save(); }

  /* ---------- what the board reads ---------- */
  stats(id, now) {
    const a = this.hist[id] || [];
    const day = now - 86400000, week = now - KEEP_DAYS * 86400000;
    /* uptime = the site answered (up, slow or stale); fresh = answered with current data */
    let n24 = 0, ok24 = 0, fresh24 = 0, n7 = 0, ok7 = 0, fresh7 = 0; const ms24 = [];
    for (const x of a) {
      if (x.t >= week) { n7++; if (x.s !== 3) ok7++; if (x.s < 2) fresh7++; }
      if (x.t >= day) { n24++; if (x.s !== 3) ok24++; if (x.s < 2) fresh24++; if (x.s !== 3) ms24.push(x.ms); }
    }
    ms24.sort((p, q) => p - q);
    const pct = (ok, n) => n ? Math.round(ok / n * 1000) / 10 : null;
    const q = f => ms24.length ? ms24[Math.min(ms24.length - 1, Math.floor(f * ms24.length))] : null;
    /* 24 h in 144 ten-minute cells, worst state in each; -1 = no sample */
    const cells = new Array(144).fill(-1);
    for (const x of a) {
      if (x.t < day) continue;
      const i = Math.min(143, Math.floor((x.t - day) / 600000));
      if (x.s > cells[i]) cells[i] = x.s;
    }
    /* latency sparkline: same cells, median ms of the cell */
    const buckets = new Array(144).fill(null).map(() => []);
    for (const x of a) { if (x.t >= day && x.s !== 3) buckets[Math.min(143, Math.floor((x.t - day) / 600000))].push(x.ms); }
    const spark = buckets.map(b => { if (!b.length) return null; b.sort((p, q2) => p - q2); return b[Math.floor(b.length / 2)]; });
    const downs = this.events.filter(e => e.id === id && e.to === 'down' && e.t >= week).length;
    return { uptime24: pct(ok24, n24), uptime7: pct(ok7, n7), fresh24: pct(fresh24, n24), fresh7: pct(fresh7, n7), samples24: n24, samples7: n7,
             p50: q(0.5), p95: q(0.95), cells: cells, spark: spark, outages7: downs };
  }

  summary() {
    const now = Date.now();
    const list = (this.config.dashboards || []).map(d => {
      const last = this.last[d.id];
      const base = { id: d.id, name: d.name, blurb: d.blurb || '', url: d.url || '', group: d.group || '', checked: !!(d.health && d.health.url) };
      if (!base.checked) return Object.assign(base, { state: 'unchecked' });
      if (!last) return Object.assign(base, { state: 'unknown', healthUrl: d.health.url });
      return Object.assign(base, { state: last.state, since: last.since, t: last.t, ms: last.ms, code: last.code, err: last.err, note: last.note, cert: last.cert, fields: last.fields, healthUrl: d.health.url }, this.stats(d.id, now));
    });
    const counts = {}; list.forEach(x => { counts[x.state] = (counts[x.state] || 0) + 1; });
    const worst = list.reduce((w, x) => Math.max(w, STATES.indexOf(x.state)), -1);
    return { ok: true, now: now, started: this.started, runs: this.runs, intervalMs: this.intervalMs, overall: worst < 0 ? 'unknown' : STATES[worst], counts: counts,
             dashboards: list, events: this.events.slice(-40).reverse() };
  }
  history(id) {
    return { ok: true, id: id, samples: (this.hist[id] || []).slice(-10080), events: this.events.filter(e => e.id === id).slice(-100) };
  }
}

module.exports = { Checker, fetchUrl, probe, parseWhen, readFields, dig, STATES };
