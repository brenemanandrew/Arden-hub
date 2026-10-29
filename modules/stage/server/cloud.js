'use strict';
/* Cloud copy.
   The host PC (the one with SAP) pushes what it knows to a copy of this app
   running somewhere reachable, every cycle, over outbound HTTPS. The copy
   runs in "cloud" mode: no SAP, no folder, no settings of its own. It shows
   the board, the ops page and the data page from whatever was last pushed,
   and says plainly when that was.

   Two halves:
     CloudPush   runs on the host: gzips the payload and POSTs it
     CloudStore  runs on the copy: stands in for ingest, dwell, puller and
                 settings, fed by POST /api/ingest */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const tls = require('tls');
const EventEmitter = require('events');
const model = require('./model');
const months = require('./months');
const feed = require('./feedcrypt');
const winca = require('./winca');

/* this PC's name in the feed; SLH_HOST_NAME stands in when two copies run on one PC for a test */
function hostName(){ return process.env.SLH_HOST_NAME || require('os').hostname(); }

/* One place that knows how to talk to the copy: the key header, the
   timeout, and which certificates to trust. Trust what Windows trusts, so a
   network that inspects HTTPS still verifies properly instead of being waved
   through. Shared by the feed push, the backup send and the backup fetch, so
   the three cannot drift apart. */
function requestOpts(c, u, method, headers){
  const opts = { method, headers: Object.assign({ 'X-SLH-Key': c.secret }, headers || {}), timeout: 60000 };
  let tlsNote = '';
  if(u.protocol === 'https:'){
    const roots = winca.cached();
    if(roots && roots.length){ opts.ca = tls.rootCertificates.concat(roots); tlsNote = 'windows store (' + roots.length + ' certificates)'; }
    else tlsNote = 'built-in certificates';
    if(c.insecureTls){ opts.rejectUnauthorized = false; tlsNote = 'NOT VERIFIED (certificate checking turned off)'; }
  }
  return { opts, tls: tlsNote };
}
/* GET the newest backup the copy holds, opened. Resolves null when it holds
   none; rejects on anything else, so the caller can tell "nothing there"
   from "could not ask". Used at start-up on a new PC, before the app has
   built any of its own objects, so it takes the config values rather than
   an app. */
/* What the copy is holding, without fetching it: name, days, when, which
   host sent it. Asked at every start, so it has to be small - the backup
   itself is only worth pulling when this answer says it has more days than
   this PC does. */
function fetchBackupMeta(c, log){
  log = log || (() => {});
  return new Promise((resolve, reject) => {
    if(!(c && c.enabled && c.url && c.secret)) return resolve(null);
    let u;
    try{ u = new URL(c.url.replace(/[/]+$/, '') + '/api/backup/meta'); }catch(e){ return reject(new Error('bad cloud URL')); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, requestOpts(c, u, 'GET').opts, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if(res.statusCode === 404) return resolve(null);
        if(res.statusCode !== 200) return reject(new Error('the copy answered ' + res.statusCode + ' ' + body.slice(0, 120)));
        let j = null;
        try{ j = JSON.parse(body); }catch(e){ return reject(new Error('the copy did not answer with details')); }
        const m = j && j.backup;
        resolve(m && m.name ? m : null);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', e => reject(e));
    req.end();
  });
}

function fetchLatestBackup(c, log){
  log = log || (() => {});
  return new Promise((resolve, reject) => {
    if(!(c && c.enabled && c.url && c.secret)) return resolve(null);
    let u;
    try{ u = new URL(c.url.replace(/\/+$/, '') + '/api/backup/latest'); }catch(e){ return reject(new Error('bad cloud URL')); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, requestOpts(c, u, 'GET').opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if(res.statusCode === 404) return resolve(null);
        if(res.statusCode !== 200) return reject(new Error('the copy answered ' + res.statusCode + ' ' + body.toString('utf8').slice(0, 120)));
        try{
          const bytes = feed.openRaw(body, c.secret);
          resolve({ bytes, meta: {
            name: String(res.headers['x-slh-backup-name'] || 'SLH-data-from-cloud.zip'),
            days: parseInt(res.headers['x-slh-backup-days'], 10) || 0,
            at: parseInt(res.headers['x-slh-backup-at'], 10) || 0,
            host: String(res.headers['x-slh-backup-host'] || '') } });
        }catch(e){ reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', e => reject(e));
    req.end();
  });
}

class CloudPush {
  constructor(app){
    this.app = app;
    this.timer = null;
    this.busy = false;
    this.st = { lastTry: null, lastOk: null, lastError: '', pushes: 0, failures: 0, bytes: 0, tls: '', standby: null };
    this.retriedWithCa = false;
    this.wantTakeover = false;
    this.probeTimer = null;
    winca.init(app.cfg.dataDir);
  }
  get cfg(){ return this.app.cfg.get().cloud || {}; }
  enabled(){ const c = this.cfg; return !!(c.enabled && c.url && c.secret); }
  /* Called on every change; coalesces bursts into one push a few seconds later. */
  schedule(){
    if(!this.enabled()) return;
    if(this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.push(); }, 3000);
  }
  payload(){
    const a = this.app;
    return {
      v: 1, sentAt: Date.now(), host: hostName(),
      takeover: this.wantTakeover || undefined,   // a deliberate switch from the Admin page
      version: a.version || null,     // which build the host runs, so the copy can say
      files: a.ingest.payload().files,
      dwell: a.dwell.payload(),
      settings: a.settings.get(),
      puller: a.puller.status(),
      /* whether this PC can put SAP back by itself, and what happened the
         last time it tried. Without it the only place that answer exists is
         the host's own Admin page, which is the one screen you cannot reach
         when the host is the thing that is broken. */
      recovery: a.sapwatch ? a.sapwatch.status() : null,
      /* the tail of the pull log, so the copy's Admin page can show why an
         export failed on the host without anyone walking over to that PC */
      pullerLog: a.puller.tail(80),
      /* what became of the commands the copy handed over last time */
      commandAck: a.commands ? a.commands.takeAcks() : [],
      pickerCfg: a.cfg.get().pickers || null,
      /* the last few weeks of the daily rollup, so the cloud copy can
         answer the week, month and recommended standards views instead of
         only today */
      pickerHist: (() => {
        if(!a.pickers) return null;
        const out = {};
        Object.keys(a.pickers.history).sort().slice(-45).forEach(k => { out[k] = a.pickers.history[k]; });
        return Object.keys(out).length ? out : null;
      })(),
      recSnap: (a.recommend && a.recommend.payload()) || null,
      /* The year a month at a time, already worked out. The raw rollup for a
         year is megabytes and the copy would only add it up again; the digest
         is a few kilobytes and is the same arithmetic, so it goes up instead
         of the days it was made from. Rebuilt only when the rollup moves. */
      monthly: this.monthlyDigest(a),
      pickerDay: (() => {
        if(!a.pickers) return null;
        const k = model.dayKey(new Date());
        return a.pickers.history[k] ? { key: k, entry: a.pickers.history[k] } : null;
      })(),
      newestFile: a.ingest.newestMtime()
    };
  }
  /* Two dozen months added up is not free, and a push happens far more often
     than the rollup changes, so the answer is kept until it moves. */
  monthlyDigest(a){
    if(!a.pickers) return null;
    const v = a.pickers.version;
    if(this.moCache && this.moCache.v === v) return this.moCache.d;
    let d = null;
    try{
      d = months.build(a.pickers, { months: 25 });
      /* The copy shows either 13 months or 25, and the strip above the
         gallery counts the people in whichever is on screen. That count
         cannot be recovered by trimming a list of months - the same person
         appears in many of them - so both are worked out here, where the
         days they were made from still exist. */
      d.totals = { 13: months.build(a.pickers, { months: 13 }).total, 25: d.total };
    }catch(e){ return null; }
    this.moCache = { v, d };
    return d;
  }
  push(){    if(this.busy || !this.enabled()) return;
    this.busy = true;
    const c = this.cfg;
    let u;
    try{ u = new URL(c.url.replace(/\/+$/, '') + '/api/ingest'); }catch(e){ this.fail('bad cloud URL'); return; }
    /* Sealed with the ingest secret, so the copy stores it sealed and the
       Fly volume never holds a plain-text day of the warehouse's work. The
       seal gzips on the way in, so this is not bigger than it used to be. */
    let body, hdr;
    try{
      body = feed.seal(this.payload(), c.secret);
      hdr = { 'Content-Type': 'application/octet-stream', 'X-SLH-Enc': '1' };
    }catch(e){
      /* no secret to seal with is a configuration problem, not something to
         paper over by sending it in the clear */
      this.fail('cannot seal the push: ' + e.message);
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const built = requestOpts(c, u, 'POST', Object.assign(hdr, { 'Content-Length': body.length }));
    const opts = built.opts;
    if(built.tls) this.st.tls = built.tls;
    this.st.lastTry = Date.now();
    const req = mod.request(u, opts, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => {
        if(res.statusCode === 200){
          this.st.lastOk = Date.now(); this.st.lastError = ''; this.st.pushes++; this.st.bytes += body.length; this.wantTakeover = false;
          if(this.st.standby) this.resume('the cloud copy accepted this PC');
          let j = null; try{ j = JSON.parse(out); }catch(e){}
          this.keepAlive(j && j.leaseMs);
          /* anything somebody queued on the copy for this PC */
          if(j && Array.isArray(j.commands) && j.commands.length && this.app.commands){
            try{ this.app.commands.fromCloud(j.commands); }catch(e){ this.app.log('[cloud] command failed: ' + e.message, 'warn'); }
          }
        }
        else if(res.statusCode === 409){ let j = null; try{ j = JSON.parse(out); }catch(e){} this.standBy(j && j.feeder ? j.feeder : { host: '?', at: null }); }
        else this.fail('HTTP ' + res.statusCode + ' ' + out.slice(0, 120));
        this.busy = false;
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => {
      /* First certificate failure: load the Windows store and try once more.
         That is the whole fix on a network that inspects HTTPS. */
      if(winca.isCertError(e) && !this.retriedWithCa && !c.insecureTls){
        this.retriedWithCa = true;
        this.busy = false;
        this.app.log('[cloud] HTTPS is being inspected by your network; loading the certificates Windows trusts and retrying');
        winca.load().then(certs => {
          if(certs && certs.length) this.push();
          else this.fail('this network inspects HTTPS and the Windows certificate store could not be read. Tick "Trust this network\'s HTTPS inspection" in Admin to push anyway.');
        });
        return;
      }
      if(winca.isCertError(e)){
        this.fail(e.message + ' - this network inspects HTTPS. If it keeps failing, tick "Trust this network\'s HTTPS inspection" in Admin.');
        return;
      }
      this.fail(e.message);
    });
    req.end(body);
  }
  fail(msg){ this.busy = false; this.st.failures++; this.st.lastError = msg; this.app.log('[cloud] push failed: ' + msg); }
  /* The backup just taken, sent to the copy sealed, so a PC that starts
     with nothing can ask the copy for it, which is the whole route. Fire
     and forget: a backup that did not reach the copy is still on this PC
     and on this disk, and the next one goes up too. */
  /* Returns a promise that settles when the copy has answered, or the
     attempt has failed. Nobody waits for it in the ordinary way of things -
     but a host being shut down has to, because that backup is the one that
     will exist when the PC does not come back. */
  sendBackup(file, meta){
    if(!this.enabled()) return;
    const c = this.cfg;
    let u, body;
    try{ u = new URL(c.url.replace(/\/+$/, '') + '/api/backup/put'); }catch(e){ return; }
    try{ body = feed.sealRaw(fs.readFileSync(file), c.secret); }catch(e){ this.app.log('[cloud] backup not sent: ' + e.message, 'warn'); return; }
    let settle = () => {};
    const sent = new Promise(r => { settle = r; });
    const mod = u.protocol === 'https:' ? https : http;
    const hdr = { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
      'X-SLH-Backup-Name': meta.name, 'X-SLH-Backup-Days': String(meta.days), 'X-SLH-Backup-At': String(meta.at), 'X-SLH-Backup-Host': hostName() };
    const req = mod.request(u, requestOpts(c, u, 'POST', hdr).opts, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => {
        const ok = res.statusCode === 200;
        this.st.backupSent = { at: Date.now(), name: meta.name, days: meta.days, bytes: body.length, ok, error: ok ? '' : (out.slice(0, 160) || ('HTTP ' + res.statusCode)) };
        this.app.log(ok ? ('[cloud] backup ' + meta.name + ' sent to the copy (' + Math.round(body.length / 1024) + ' KB)')
                        : ('[cloud] the copy did not take backup ' + meta.name + ': ' + this.st.backupSent.error), ok ? 'info' : 'warn');
        settle(ok);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', e => { this.st.backupSent = { at: Date.now(), name: meta.name, days: meta.days, ok: false, error: e.message }; this.app.log('[cloud] backup not sent: ' + e.message, 'warn'); settle(false); });
    req.end(body);
    return sent;
  }
  status(){ return Object.assign({ enabled: this.enabled(), url: this.cfg.url || '', caCount: winca.count() }, this.st); }

  /* ---- one feeder at a time ----
     The cloud copy refuses a push while another PC is feeding it. This PC
     then stands by: no SAP pulls, no pushes, no shift reports, a banner on
     its board, and a small question to the cloud once a minute so it takes
     over on its own the moment the other PC goes quiet. Take over from the
     Admin page skips the wait. */
  /* A quiet stretch (puller idle, nothing new) must not read as the feeder
     being gone, so after an accepted push the host pushes again at half the
     lease if nothing else has made it push by then. */
  keepAlive(leaseMs){
    if(this.keepTimer){ clearTimeout(this.keepTimer); this.keepTimer = null; }
    const ms = Math.max(30000, Math.round((leaseMs || 600000) / 2));
    this.keepTimer = setTimeout(() => { this.keepTimer = null; if(!this.st.standby) this.push(); }, ms);
  }
  standBy(feeder){
    if(this.keepTimer){ clearTimeout(this.keepTimer); this.keepTimer = null; }
    const first = !this.st.standby;
    this.st.standby = { feeder, since: (this.st.standby && this.st.standby.since) || Date.now(), checkedAt: Date.now() };
    this.app.puller.standby = true;
    if(first){
      this.app.log('[cloud] ' + (feeder.host || 'another PC') + ' is feeding the cloud copy; this PC is standing by (no SAP pulls, no pushes) until it goes quiet');
      this.app.puller.emit('status');
    }
    if(!this.probeTimer) this.probeTimer = setInterval(() => this.probe(), 60000);
  }
  resume(why){
    if(this.probeTimer){ clearInterval(this.probeTimer); this.probeTimer = null; }
    if(!this.st.standby) return;
    this.st.standby = null;
    this.app.puller.standby = false;
    this.app.log('[cloud] this PC feeds the cloud copy again: ' + why);
    this.app.puller.emit('status');
    this.app.puller.pullNow();
  }
  takeover(){
    this.wantTakeover = true;
    if(this.st.standby) this.resume('take over pressed on the Admin page');
    this.schedule();
    this.app.log('[cloud] taking over the cloud copy');
  }
  /* GET /api/feeder with the same key: who feeds, and whether their claim has lapsed */
  probe(){
    return new Promise(done => {
      const c = this.cfg;
      if(!this.enabled()){ done(null); return; }
      let u; try{ u = new URL(c.url.replace(/\/+$/, '') + '/api/feeder'); }catch(e){ done(null); return; }
      const mod = u.protocol === 'https:' ? https : http;
      const opts = { method: 'GET', headers: { 'X-SLH-Key': c.secret }, timeout: 15000 };
      if(u.protocol === 'https:'){ const roots = winca.cached(); if(roots && roots.length) opts.ca = tls.rootCertificates.concat(roots); if(c.insecureTls) opts.rejectUnauthorized = false; }
      const req = mod.request(u, opts, res => {
        let out = ''; res.on('data', d => { out += d; });
        res.on('end', () => {
          let j = null; try{ j = JSON.parse(out); }catch(e){}
          if(res.statusCode !== 200 || !j){ done(null); return; }
          const me = hostName();
          if(this.st.standby){
            if(!j.feeder || j.stale || j.feeder.host === me) this.resume(!j.feeder ? 'nobody is feeding it' : j.stale ? (j.feeder.host + ' has gone quiet') : 'it names this PC');
            else { this.st.standby.feeder = j.feeder; this.st.standby.checkedAt = Date.now(); }
          } else if(j.feeder && j.feeder.host !== me && !j.stale){
            this.standBy(j.feeder);
          }
          done(j);
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', () => done(null));
      req.end();
    });
  }
  /* asked once at start, before the first SAP pull, so a second PC never
     drives SAP for a copy that will not take its data */
  probeAtStart(){
    if(!this.enabled()) return Promise.resolve(null);
    return Promise.race([this.probe(), new Promise(r => setTimeout(() => r(null), 6000))]);
  }
}

/* Everything the board model needs, from the last push. */
class CloudStore extends EventEmitter {
  constructor(cfg, log){
    super();
    this.cfg = cfg; this.log = log || (() => {});
    /* what arrived, kept exactly as it arrived: still sealed */
    this.file = path.join(cfg.dataDir, 'cloud-last.enc');
    this.legacyFile = path.join(cfg.dataDir, 'cloud-last.json');
    /* the newest backup a host sent, for the next PC to take */
    this.backupFile = path.join(cfg.dataDir, 'backup-latest.enc');
    this.backupMetaFile = path.join(cfg.dataDir, 'backup-latest.json');
    this.version = 0;
    this.received = null;
    /* commands queued from host view for the host, and what it said back.
       In memory only: a command that outlives a restart of the copy is a
       command nobody remembers asking for. */
    this.commands = { pending: [], done: [], next: 1 };
    this.files = { stage: blank(), orders: blank(), wh: blank() };
    this.derived = { at: null, lanes: null, orders: null, errors: {} };
    this.data = { dwell: { open: {}, completed: [], usage: { use: {}, snaps: 0 } }, settings: null, puller: { enabled: true, sap: {} }, host: '', newestFile: null, sentAt: null };
    // stand-ins with the same surface the pages and board.js use
    const self = this;
    this.dwell = {
      get completed(){ return self.data.dwell.completed || []; },
      get open(){ return self.data.dwell.open || {}; },
      get version(){ return self.version; },
      payload(){ return Object.assign({ v: self.version }, self.data.dwell); },
      csv(){ return dwellCsv(self.data.dwell.completed || []); },
      repair(){ return { flagged: 0, dropped: 0 }; }, clearLog(){}, resetUsage(){}
    };
    this.puller = {
      status(){ const p = self.data.puller || {}; return Object.assign({ enabled: true, sap: {} }, p, { cloud: true, host: self.data.host, receivedAt: self.received }); },
      tail(n){ const l = self.data.pullerLog || []; return l.slice(-(n || 200)); }, requestStart(){}, requestStop(){}, pullNow(){}, maybeProbe(){}, noteViewer(){}, discoverTree(cb){ cb(new Error('not available on the cloud copy')); },
      lastTree: null, st: { sap: {} }, viewers: () => 0
    };
    this.settings = { get(){ return self.data.settings; }, set(){ throw new Error('settings are managed on the host PC'); } };
    this.restore();
  }
  /* What was on disk when this copy started. The sealed file first; failing
     that the plain one an older build left behind, which is then written back
     sealed and removed - otherwise a copy that has been upgraded would go on
     holding a readable payload for ever, which is the whole thing this was
     meant to stop. */
  restore(){
    const secret = (this.cfg.get().cloud || {}).secret || '';
    try{
      const raw = fs.readFileSync(this.file);
      const saved = feed.open(raw, secret);
      this.apply(saved, saved.receivedAt || null);
      return;
    }catch(e){
      if(fs.existsSync(this.file)) this.log('cloud: the saved push would not open (' + e.message + ')');
    }
    try{
      const saved = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
      this.apply(saved, saved.receivedAt || null);
      this.log('cloud: read the last push from the old plain-text file; sealing it');
      this.persist(saved);
      try{ fs.unlinkSync(this.legacyFile); this.log('cloud: the plain-text copy is gone'); }catch(e){}
    }catch(e){}
  }
  /* Keep the last push sealed. It is re-sealed here rather than the bytes
     that arrived being kept, because what is stored is not quite what was
     sent: who is feeding and when it landed are added on arrival. Sealing a
     payload costs a few milliseconds and happens once a push. */
  persist(p){
    const secret = (this.cfg.get().cloud || {}).secret || '';
    const body = Object.assign({}, p, { receivedAt: this.received, feeder: this.data.feeder || null, standby: this.data.standby || null });
    try{ fs.writeFileSync(this.file, feed.seal(body, secret)); }
    catch(e){ this.log('cloud: could not save the last push: ' + e.message); }
  }
  /* The newest backup a host sent, kept sealed as it arrived, with a note
     beside it saying what it is. The copy never opens it; it only holds it
     for the next PC. A backup with fewer days than the one already here is
     refused - a standby PC with a fortnight must not replace a year - and so
     is one from a PC that is not the feeder while somebody else is. */
  putBackup(meta, sealed, fromHost){
    const have = this.backupMeta();
    if(have && meta.days < have.days) return { ok: false, reason: 'it holds ' + meta.days + ' days and the one here holds ' + have.days };
    const f = this.data.feeder;
    if(f && f.host && fromHost && f.host !== fromHost) return { ok: false, reason: f.host + ' is feeding this copy; a backup from ' + fromHost + ' is not taken over it' };
    try{
      fs.writeFileSync(this.backupFile, sealed);
      const rec = { name: meta.name, days: meta.days, at: meta.at, host: fromHost || '', bytes: sealed.length, receivedAt: Date.now() };
      fs.writeFileSync(this.backupMetaFile, JSON.stringify(rec));
      this.data.backup = rec;
      return { ok: true, backup: rec };
    }catch(e){ return { ok: false, reason: e.message }; }
  }
  /* ---- commands for the host ---- */
  queueCommand(name, by){
    const c = { id: String(this.commands.next++), name, by: by || '', at: Date.now() };
    /* one of each at a time: asking twice is not asking for two */
    this.commands.pending = this.commands.pending.filter(x => x.name !== name).concat(c);
    return c;
  }
  /* what the next reply carries; anything older than ten minutes is dropped,
     because a restart asked for at nine is not wanted at noon */
  pendingCommands(){
    const cut = Date.now() - 10 * 60000;
    this.commands.pending = this.commands.pending.filter(c => c.at > cut);
    return this.commands.pending.map(c => ({ id: c.id, name: c.name, by: c.by }));
  }
  ackCommands(acks){
    for(const a of (Array.isArray(acks) ? acks : [])){
      if(!a || !a.id) continue;
      const was = this.commands.pending.find(c => c.id === String(a.id));
      this.commands.pending = this.commands.pending.filter(c => c.id !== String(a.id));
      this.commands.done.push({ id: String(a.id), name: a.name || (was && was.name) || '', by: was ? was.by : '', ok: !!a.ok, why: a.why || '', askedAt: was ? was.at : null, at: a.at || Date.now() });
      if(this.commands.done.length > 20) this.commands.done.shift();
    }
  }
  commandStatus(){ return { pending: this.pendingCommands(), done: this.commands.done.slice(-10) }; }
  backupMeta(){
    if(this.data.backup) return this.data.backup;
    try{ this.data.backup = JSON.parse(fs.readFileSync(this.backupMetaFile, 'utf8')); }catch(e){ this.data.backup = null; }
    return this.data.backup;
  }
  get reportDir(){ return 'cloud copy (pushed from ' + (this.data.host || 'the host PC') + ')'; }
  /* One host feeds this copy at a time. Two PCs running the host at once
     would otherwise take turns overwriting each other every few minutes and
     nobody would know why the numbers jump. The feeder is whoever pushed
     last; anyone else is refused until that PC has been quiet for the lease,
     or says outright that it is taking over. Refused hosts are remembered
     so the Admin page can name who is standing by. */
  admit(p, now, leaseMs){
    const host = String((p && p.host) || '').trim() || '(unnamed)';
    const f = this.data.feeder || null;
    const fresh = f && f.host !== host && (now - (f.at || 0)) < leaseMs;
    if(fresh && !(p && p.takeover)){
      this.data.standby = this.data.standby || {};
      this.data.standby[host] = now;
      return { ok: false, feeder: f, host };
    }
    if(f && f.host !== host) this.log('cloud: ' + host + ' takes over from ' + f.host + (p && p.takeover ? ' (deliberately)' : ' (quiet for ' + Math.round((now - (f.at || 0)) / 60000) + ' min)'));
    this.data.feeder = { host, at: now, since: (f && f.host === host && f.since) || now };
    if(this.data.standby) delete this.data.standby[host];
    return { ok: true, feeder: this.data.feeder, host };
  }
  /* who feeds and who waits, for the status page; the waiting list forgets a PC after an hour */
  feederStatus(now, leaseMs){
    const f = this.data.feeder || null;
    const sb = this.data.standby || {};
    const waiting = Object.keys(sb).filter(h => now - sb[h] < 3600000).map(h => ({ host: h, seenAt: sb[h] }));
    return { feeder: f, leaseMs, stale: !f || (now - (f.at || 0)) >= leaseMs, standby: waiting };
  }
  start(){} stop(){} armWatch(){} refresh(){ return Promise.resolve(); }
  /* A push from the host. */
  apply(p, at){
    if(!p || typeof p !== 'object' || !p.files) throw new Error('not a board payload');
    this.received = at || Date.now();
    for(const k of ['stage', 'orders', 'wh']){
      const f = p.files[k] || {};
      const rows = Array.isArray(f.data) ? f.data : null;
      this.files[k] = Object.assign(blank(), { status: f.status || 'not found', name: f.name || '', mtime: f.mtime || null, size: f.size || null, rowCount: f.rows || null, error: f.error || '', readAt: this.received, rows, full: rows });
    }
    this.data.dwell = p.dwell || this.data.dwell;
    this.data.settings = p.settings || this.data.settings;
    this.data.puller = p.puller || this.data.puller;
    this.data.recovery = p.recovery || this.data.recovery || null;
    this.data.host = p.host || this.data.host;
    this.data.hostVersion = p.version || this.data.hostVersion || null;
    if(p.feeder && !this.data.feeder) this.data.feeder = p.feeder;     // the saved copy, read back at start
    if(p.standby && !this.data.standby) this.data.standby = p.standby;
    this.data.pullerLog = Array.isArray(p.pullerLog) ? p.pullerLog : (this.data.pullerLog || []);
    this.data.pickerDay = p.pickerDay || null;
    /* the recent rollup and the recommendation record: without these the
       copy only ever knows the days it was itself running for */
    this.data.pickerHist = p.pickerHist || null;
    /* the host's own month-by-month digest, which reaches further back than
       the days it pushes: the copy shows the year without being sent it */
    if(p.monthly) this.data.monthly = p.monthly;
    this.data.recSnap = p.recSnap || null;
    this.data.pickerCfg = p.pickerCfg || null;
    this.data.newestFile = p.newestFile || null;
    this.data.sentAt = p.sentAt || null;
    this.derive();
    this.version++;
    this.persist(p);
    this.emit('change', this.version);
  }
  derive(){
    const d = { at: Date.now(), lanes: null, orders: null, errors: {} };
    if(this.files.stage.full){ try{ d.lanes = model.computeLanes(this.files.stage.full); }catch(e){ d.errors.stage = e.message; } }
    if(this.files.orders.full){ try{ d.orders = model.computeOrders(this.files.orders.full); }catch(e){ d.errors.orders = e.message; } }
    this.derived = d;
  }
  payload(){
    const out = { v: this.version, serverNow: Date.now(), reportDir: this.reportDir, files: {}, cloud: { host: this.data.host, receivedAt: this.received, sentAt: this.data.sentAt } };
    for(const k of Object.keys(this.files)){ const f = this.files[k]; out.files[k] = { status: f.status, name: f.name, mtime: f.mtime, size: f.size, rows: f.rowCount, error: f.error, readAt: f.readAt, data: f.rows }; }
    return out;
  }
  diag(){ const out = {}; for(const k of Object.keys(this.files)){ const f = this.files[k]; out[k] = { status: f.status, name: f.name, mtime: f.mtime, size: f.size, rows: f.rowCount, error: f.error, readAt: f.readAt }; } return out; }
  fullRows(kind){ const f = this.files[kind]; return f && f.full ? f.full : null; }
  newestMtime(){ return this.data.newestFile || null; }
}

function blank(){ return { status: 'not read', name: '', path: '', mtime: null, size: null, rowCount: null, rows: null, full: null, hIdx: -1, error: '', readAt: null }; }
function dwellCsv(completed){
  const head = ['consolidation', 'tote', 'picker_changed_by', 'lane', 'staged_since', 'first_seen', 'cleared_detected', 'minutes_in_staging', 'watched'];
  const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const fmt = ms => { if(!ms) return ''; const d = new Date(ms), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
  return [head.join(',')].concat(completed.slice().sort((a, b) => a.departed - b.departed).map(r => [r.order, r.tote, r.picker, r.lane, fmt(r.stagedSince), fmt(r.firstSeen), fmt(r.departed), Math.round((r.departed - (r.stagedSince || r.firstSeen)) / 60000), r.stale ? 0 : 1].map(cell).join(','))).join('\r\n');
}

module.exports = { CloudPush, CloudStore };
module.exports.fetchLatestBackup = fetchLatestBackup;
module.exports.fetchBackupMeta = fetchBackupMeta;
