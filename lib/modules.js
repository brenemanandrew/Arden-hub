'use strict';
/* ============================================================
   The modules: Staging Lane Health and Arden Pack, run as child processes
   and reverse-proxied under /stage and /pack.

   Why children and a proxy rather than a rewrite: both programs are proven
   on the floor and still being developed on the host PC. Keeping them whole
   means a new build is a folder swap (modules/UPSTREAM.md). The hub owns
   the door, the navigation and the Shift page; the modules own their
   numbers.

   The proxy rewrites root-absolute links in text answers ("/api/board" ->
   "/stage/api/board") and injects the hub's section bar into HTML pages,
   except on TV pages and inside iframes (the wall panel loads quarters as
   iframes). Event streams and binary answers pass straight through.
   ============================================================ */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', 'modules');

/* Every root path a module's pages or answers can mention. Anything else
   that starts with "/" (a lane name in a string, a regex) is left alone. */
const DEFS = {
  stage: {
    name: 'Staging Lane Health', dir: 'stage', entry: 'server/main.js', port: Number(process.env.HUB_STAGE_PORT) || 8481,
    routes: ['api', 'web', 'tv', 'ops', 'pickers', 'people', 'months', 'review', 'quad', 'panel', 'data', 'admin', 'help', 'phone', 'board', 'classic', 'login', 'deploy', 'fit', 'pack', 'launchpad', 'index.html', 'favicon.ico'],
    /* reachable without the hub cookie: the host PC's push doors and the health line */
    open: [/^\/api\/ingest$/, /^\/api\/backup\//, /^\/api\/feeder$/, /^\/api\/health$/],
    health: '/api/health',
    args: (o) => ['--port', String(o.port), '--host', '127.0.0.1', '--data-dir', o.dataDir, '--no-open'].concat(o.demo ? ['--report-dir', o.demoDir, '--no-pull'] : []),
    env: (o) => Object.assign({ SLH_DATA: o.dataDir, SLH_PORT: String(o.port) }, o.demo ? { SLH_MODE: 'host' } : { SLH_MODE: 'cloud', SLH_INGEST_SECRET: o.stageKey || '' })
  },
  pack: {
    name: 'Arden Pack', dir: 'pack', entry: 'server/main.js', port: Number(process.env.HUB_PACK_PORT) || 8482,
    routes: ['api', 'web', 'pack', 'admin', 'settings', 'login', 'deploy', 'index.html', 'favicon.ico'],
    open: [/^\/api\/drop$/, /^\/api\/health$/],
    health: '/api/health',
    args: (o) => ['--port', String(o.port), '--data-dir', o.dataDir, '--report-dir', o.demo ? o.demoDir : path.join(o.dataDir, 'reports')],
    env: (o) => ({ PACK_DATA: o.dataDir, PACK_HOST: '127.0.0.1', PACK_KEY: o.packKey || '' })
  }
};

class Modules {
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || console.log;
    this.procs = {};
    this.state = {};            /* id -> { pid, started, restarts, lastExit, up } */
    this.stopping = false;
    /* whatever ends the hub ends its children: a crash leaves no orphan holding the ports */
    process.on('exit', () => this.stop(true));
  }
  ids() { return Object.keys(DEFS); }
  def(id) { return DEFS[id]; }

  start() {
    for (const id of this.ids()) this.spawn(id, 0);
  }
  spawn(id, attempt) {
    const d = DEFS[id];
    const dataDir = path.join(this.opts.dataDir, id);
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* reported below */ }
    const o = { dataDir, port: d.port, demo: !!this.opts.demo, demoDir: this.opts.demoDir, stageKey: this.opts.stageKey, packKey: this.opts.packKey };
    const entry = path.join(ROOT, d.dir, d.entry);
    const child = spawn(process.execPath, [entry].concat(d.args(o)), {
      cwd: path.join(ROOT, d.dir), env: Object.assign({}, process.env, { PORT: String(d.port), TZ: process.env.TZ || 'America/New_York' }, d.env(o)),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const st = this.state[id] = Object.assign(this.state[id] || { restarts: 0 }, { pid: child.pid, started: Date.now(), up: false, lastExit: null });
    const tag = '[' + id + '] ';
    const line = (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach(l => this.log(tag + l.replace(/^\d\d:\d\d:\d\d\s+/, '')));
    child.stdout.on('data', line); child.stderr.on('data', line);
    child.on('exit', (code, sig) => {
      st.lastExit = { code, sig, at: Date.now() }; st.up = false; st.pid = null;
      if (this.stopping) return;
      const wait = Math.min(60000, 2000 * Math.pow(2, Math.min(attempt, 5)));
      this.log(tag + 'exited (' + (sig || code) + '); starting again in ' + Math.round(wait / 1000) + ' s');
      st.restarts++;
      setTimeout(() => this.spawn(id, attempt + 1), wait).unref();
    });
    this.procs[id] = child;
    this.waitUp(id, attempt);
  }
  waitUp(id, attempt) {
    const d = DEFS[id], st = this.state[id];
    let tries = 0;
    const tick = () => {
      if (!this.procs[id] || this.procs[id].exitCode !== null) return;
      this.ping(id).then(ok => {
        if (ok) { st.up = true; this.log('[' + id + '] answering on 127.0.0.1:' + d.port); return; }
        if (++tries < 60) setTimeout(tick, 1000).unref();
        else this.log('[' + id + '] not answering after 60 s');
      });
    };
    setTimeout(tick, 800).unref();
  }
  ping(id) {
    const d = DEFS[id];
    return new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port: d.port, path: d.health, timeout: 3000 }, res => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }
  stop(hard) {
    this.stopping = true;
    for (const id of this.ids()) {
      const p = this.procs[id];
      if (!p || p.exitCode !== null) continue;
      try { p.kill(hard ? 'SIGKILL' : 'SIGTERM'); } catch (e) {}
      if (!hard) setTimeout(() => { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch (e) {} }, 3000).unref();
    }
  }
  status() {
    const out = {};
    for (const id of this.ids()) {
      const st = this.state[id] || {}, d = DEFS[id];
      out[id] = { name: d.name, port: d.port, pid: st.pid || null, up: !!st.up, started: st.started || null, restarts: st.restarts || 0, lastExit: st.lastExit || null };
    }
    return out;
  }

  /* GET a JSON answer from a module, for the hub's own pages */
  getJson(id, p, timeoutMs) {
    const d = DEFS[id];
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: d.port, path: p, timeout: timeoutMs || 8000, headers: { 'Accept': 'application/json' } }, res => {
        const parts = []; res.on('data', c => parts.push(c));
        res.on('end', () => { try { resolve({ code: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }); } catch (e) { reject(new Error('not JSON from ' + id + p)); } });
        res.on('error', reject);
      });
      req.on('error', reject); req.on('timeout', () => { req.destroy(new Error(id + ' did not answer')); });
    });
  }

  /* is this module path reachable without the hub cookie? */
  isOpen(id, p) { return DEFS[id].open.some(r => r.test(p)); }

  /* ---- the proxy ---- */
  rewriter(id) {
    const d = DEFS[id], prefix = '/' + id;
    const alt = d.routes.map(r => r.replace(/[.]/g, '\\.')).join('|');
    /* "/api/board", '/web/x.css', (/web/logo.png), href=/tv, `/ops`  -> prefixed */
    const re = new RegExp('(["\'`(=]\\s*)/(' + alt + ')(?=[/?#"\'`)\\s]|$)', 'g');
    return (s) => s.replace(re, (m, a, b) => a + prefix + '/' + b);
  }
  rewriteLocation(id, loc) {
    if (!loc || !/^\//.test(loc) || loc.indexOf('/' + id + '/') === 0) return loc;
    if (loc === '/') return '/';                 /* "home" on a module means the hub's home */
    return '/' + id + loc;
  }

  proxy(id, req, res, opts) {
    const d = DEFS[id], prefix = '/' + id;
    let p = req.url.slice(prefix.length) || '/';
    if (p[0] !== '/') p = '/' + p;
    const headers = Object.assign({}, req.headers, { host: '127.0.0.1:' + d.port, 'x-forwarded-proto': opts.proto || 'https', 'x-forwarded-for': opts.ip || '' });
    delete headers['accept-encoding'];          /* so the answer comes back plain and can be rewritten */
    const up = http.request({ host: '127.0.0.1', port: d.port, method: req.method, path: p, headers, timeout: 120000 }, (r) => {
      const type = String(r.headers['content-type'] || '');
      const h = Object.assign({}, r.headers);
      /* hop-by-hop headers belong to the link with the child, not to ours;
         Node frames our answer itself, so a stray transfer-encoding beside a
         content-length makes strict clients (fetch) drop the reply */
      ['content-length', 'transfer-encoding', 'connection', 'keep-alive'].forEach(k => { delete h[k]; });
      if (h.location) h.location = this.rewriteLocation(id, h.location);
      const textual = /^(text\/html|text\/javascript|application\/javascript|text\/css|application\/json|text\/csv|text\/plain)/i.test(type) && !/event-stream/i.test(type);
      if (!textual) {
        res.writeHead(r.statusCode, h);
        r.pipe(res);
        return;
      }
      const parts = []; r.on('data', c => parts.push(c));
      r.on('end', () => {
        let body = Buffer.concat(parts);
        if (/gzip/i.test(String(r.headers['content-encoding'] || ''))) { try { body = zlib.gunzipSync(body); delete h['content-encoding']; } catch (e) { /* leave it */ } }
        let s = body.toString('utf8');
        s = this.rewriter(id)(s);
        if (/^text\/html/i.test(type) && opts.shell && !opts.bare) s = opts.shell(s, id, p);
        const out = Buffer.from(s, 'utf8');
        h['content-length'] = String(out.length);
        res.writeHead(r.statusCode, h);
        res.end(out);
      });
      r.on('error', () => { try { res.end(); } catch (e) {} });
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', (e) => {
      if (res.headersSent) { try { res.end(); } catch (x) {} return; }
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(opts.downPage ? opts.downPage(id, d.name, e.message) : d.name + ' is not answering (' + e.message + ')');
    });
    req.pipe(up);
  }
}

module.exports = { Modules, DEFS };
