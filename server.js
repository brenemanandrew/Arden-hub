'use strict';
/* ============================================================
   arden-hub.fly.dev - every Arden dashboard, one app.

   Node standard library only. Four jobs:
     1. The door: one PIN (2468 unless a secret says otherwise), typed once
        per device, kept 180 days in a signed cookie. Wrong guesses are
        slowed down. The sign-in is a black screen with the Hubbell logo.
     2. The shell: one section bar, in the order the work moves (Shift,
        Pick, Pack, Stage, Ship, then People, Improve, System), on every
        page, the modules' pages included.
     3. The modules: Staging Lane Health and Arden Pack run as child
        processes (lib/modules.js) and are reverse-proxied under /stage and
        /pack, their links rewritten and the bar injected. Their push doors
        stay open to the SAP PC with the modules' own keys.
     4. The hub's own pages: Shift (home), Ship, People, Improve, System,
        built from the modules' answers (lib/shift.js, lib/checker.js).

   Settings come from the environment (Fly secrets):
     HUB_PASSPHRASE_HASH  scrypt hash of the PIN (tools/make-secrets.js);
                          without it HUB_PIN, and without that 2468
     HUB_SESSION_SECRET   signs the sign-in cookie; made once and kept on
                          the volume when not set
     HUB_STAGE_KEY        the ingest secret the SAP PC pushes lanes with
     HUB_PACK_KEY         the key the SAP PC pushes pack exports with
     DATA_DIR             where everything lives (/data on Fly)
     HUB_DEV=1            plain http on localhost, for testing only
     HUB_DEMO=1           modules read the sample exports instead of
                          waiting for pushes, for testing and screenshots
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeAuth } = require('./lib/auth');
const { Checker } = require('./lib/checker');
const { Modules } = require('./lib/modules');
const { shiftModel } = require('./lib/shift');
const shell = require('./lib/shell');
const pages = require('./lib/pages');
const sections = require('./lib/sections');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEV = process.env.HUB_DEV === '1';
const DEMO = process.env.HUB_DEMO === '1';
const CONFIG_FILE = process.env.HUB_CONFIG || path.join(__dirname, 'dashboards.json');
const LOGO = fs.readFileSync(path.join(__dirname, 'public', 'logo.png'));

function loadConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { console.error('Refusing to start: ' + CONFIG_FILE + ' could not be read: ' + e.message); process.exit(1); }
  if (!cfg || !Array.isArray(cfg.dashboards)) { console.error('Refusing to start: ' + CONFIG_FILE + ' has no "dashboards" list.'); process.exit(1); }
  const seen = {};
  cfg.dashboards.forEach((d, i) => {
    if (!d.id || !/^[a-z0-9-]+$/.test(d.id) || !d.name) { console.error('Refusing to start: dashboards[' + i + '] needs an id (letters, digits, dashes) and a name.'); process.exit(1); }
    if (seen[d.id]) { console.error('Refusing to start: two dashboards have the id "' + d.id + '".'); process.exit(1); }
    seen[d.id] = 1;
  });
  cfg.site = cfg.site || {}; cfg.links = cfg.links || {};
  return cfg;
}
const CONFIG = loadConfig();
const SITE = { title: CONFIG.site.title || 'Arden Dashboards', subtitle: CONFIG.site.subtitle || 'Hubbell Arden' };

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('DATA_DIR ' + DATA_DIR + ' cannot be made: ' + e.message); }
const auth = makeAuth({ dataDir: DATA_DIR, dev: DEV });
if (auth.defaultPin) console.log('AUTH: using the default PIN. Set HUB_PASSPHRASE_HASH (tools/make-secrets.js) to change it.');
const checker = new Checker(CONFIG, { file: path.join(DATA_DIR, 'history.json'), intervalMs: Math.max(15, +(CONFIG.site.intervalSeconds || 60)) * 1000 });
const modules = new Modules({ dataDir: DATA_DIR, demo: DEMO, demoDir: path.join(__dirname, 'modules', 'stage', 'sample-data'),
  stageKey: process.env.HUB_STAGE_KEY || process.env.SLH_INGEST_SECRET || '', packKey: process.env.HUB_PACK_KEY || process.env.PACK_KEY || '' });
if (!modules.opts.stageKey && !DEMO) console.log('MODULES: HUB_STAGE_KEY is not set - the SAP PC cannot push lanes and orders until it is.');
if (!modules.opts.packKey && !DEMO) console.log('MODULES: HUB_PACK_KEY is not set - the SAP PC cannot push pack exports until it is.');

/* ---------- HTTP plumbing (same belt and braces as ardenot) ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
/* The CSP is applied to the hub's own pages. Module pages carry their own
   inline scripts and styles and are served as the module wrote them. */
const HUB_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
function send(res, code, body, type, extra) {
  const h = Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': HUB_CSP }, SEC_HEADERS, extra || {});
  if (!DEV) h['Strict-Transport-Security'] = 'max-age=31536000';
  res.writeHead(code, h);
  res.end(body);
}
const html = (res, code, body, extra) => send(res, code, body, 'text/html; charset=utf-8', extra);
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}
function clientIp(req) { return String(req.headers['fly-client-ip'] || req.socket.remoteAddress || '?'); }
/* where a sign-in may lead afterwards: any page of ours or of a module */
function safeNext(v) { v = String(v || ''); return /^\/(?!\/)[A-Za-z0-9_\-./?=&%+]*$/.test(v) && !/^\/(login|logout|api)/.test(v) ? v : '/'; }

const MANIFEST = JSON.stringify({ name: SITE.title, short_name: 'Arden', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#000000', theme_color: '#000000', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] });
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#000"/>' +
  '<rect y="400" width="512" height="40" fill="#FFC000"/><text x="256" y="310" font-family="Arial,sans-serif" font-size="230" font-weight="700" fill="#FFC000" text-anchor="middle">A</text></svg>';

/* ---------- system page: the health board plus the modules ---------- */
function systemPage(tv) {
  const base = pages.boardPage(Object.assign({ tv: !!tv, embedded: true }, SITE));
  const extra = '<div id="modules" style="max-width:1400px;margin:0 auto;padding:0 18px 10px"></div>';
  const page = base.replace('<main>', extra + '<main>');
  return (tv ? page : shell.inject(page, 'system', '/system')) +
    '<script>fetch("/api/system",{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(s){var m=s.modules||{};document.getElementById("modules").innerHTML="<div style=\\"display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 4px\\">"+Object.keys(m).map(function(k){var x=m[k];return "<div style=\\"background:var(--chip);border-radius:8px;padding:8px 12px;font-size:14px\\"><b>"+x.name+"</b> &middot; "+(x.up?"running":"down")+(x.pid?" (pid "+x.pid+")":"")+(x.restarts?" &middot; restarted "+x.restarts+"x":"")+" &middot; <a href=\\"/"+k+"/admin\\">settings</a></div>";}).join("")+"</div>";}).catch(function(){});</script>';
}

/* ---------- routes ---------- */
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname, m = req.method;

  if (p === '/health') return send(res, 200, 'ok', 'text/plain');
  if (p === '/logo.png') return send(res, 200, LOGO, 'image/png', { 'Cache-Control': 'max-age=86400' });
  if (p === '/icon.svg') return send(res, 200, ICON, 'image/svg+xml', { 'Cache-Control': 'max-age=86400' });
  if (p === '/app.webmanifest') return send(res, 200, MANIFEST, 'application/manifest+json', { 'Cache-Control': 'max-age=86400' });
  if (p === '/favicon.ico') return send(res, 204, '', 'text/plain');

  if (p === '/login' && m === 'POST') {
    if (!sameOrigin(req)) return html(res, 403, pages.loginPage(Object.assign({ msg: 'That request did not come from this page.' }, SITE)));
    const body = new URLSearchParams(await readBody(req, 4096));
    const next = safeNext(body.get('next'));
    const ip = clientIp(req), wait = auth.blocked(ip);
    if (wait) return html(res, 429, pages.loginPage(Object.assign({ msg: 'Too many wrong tries. Wait ' + wait + ' minute' + (wait === 1 ? '' : 's') + ' and try again.', next: next }, SITE)));
    if (!auth.checkPin(body.get('pin'))) { auth.failed(ip); return html(res, 401, pages.loginPage(Object.assign({ msg: 'That is not the PIN.', next: next }, SITE))); }
    auth.succeeded(ip);
    console.log('LOGIN: signed in from ' + ip);
    return send(res, 303, '', 'text/plain', { Location: next, 'Set-Cookie': auth.cookieHeader(auth.makeSession(), auth.SESSION_DAYS * 86400) });
  }
  if (p === '/logout') return send(res, 303, '', 'text/plain', { Location: '/', 'Set-Cookie': auth.cookieHeader('', 0) });

  /* ---- the modules ---- */
  const mod = modules.ids().find(id => p === '/' + id || p.indexOf('/' + id + '/') === 0);
  const signedIn = auth.hasSession(req);
  if (mod) {
    const sub = p.slice(mod.length + 1) || '/';
    const open = modules.isOpen(mod, sub);
    if (!open && !signedIn) {
      if (m === 'GET' && !/^\/api\//.test(sub)) return html(res, 200, pages.loginPage(Object.assign({ next: safeNext(p + u.search) }, SITE)));
      return json(res, 401, { ok: false, error: 'not signed in' });
    }
    const tv = u.searchParams.get('tv') === '1' || /^\/(panel|fit|phone)/.test(sub) || String(req.headers['sec-fetch-dest'] || '') === 'iframe';
    return modules.proxy(mod, req, res, {
      proto: DEV ? 'http' : 'https', ip: clientIp(req), bare: open || tv,
      shell: (h, id, sp) => shell.inject(h, shell.sectionOf(id, sp), '/' + id + sp.split('?')[0]),
      downPage: (id, name, why) => sections.downPage(id, name, why, modules.status())
    });
  }
  /* old names and short names */
  if (p === '/pick') return send(res, 302, '', 'text/plain', { Location: '/stage/pickers' });
  if (p === '/status') return send(res, 302, '', 'text/plain', { Location: '/system' });

  if (m === 'GET' && ['/', '/ship', '/people', '/improve', '/system'].indexOf(p) >= 0) {
    if (!signedIn) return html(res, 200, pages.loginPage(Object.assign({ next: p === '/' ? safeNext(u.searchParams.get('next')) === '/' ? '' : safeNext(u.searchParams.get('next')) : p }, SITE)));
    if (p === '/') return html(res, 200, sections.shiftPage());
    if (p === '/ship') return html(res, 200, sections.shipPage());
    if (p === '/people') return html(res, 200, sections.peoplePage(CONFIG.links));
    if (p === '/improve') return html(res, 200, sections.improvePage(CONFIG.links));
    if (p === '/system') return html(res, 200, systemPage(u.searchParams.get('tv') === '1'));
  }

  if (p.indexOf('/api/') === 0) {
    if (!signedIn) return json(res, 401, { ok: false, error: 'not signed in' });
    if (p === '/api/shift' && m === 'GET') { try { return json(res, 200, await shiftModel(modules)); } catch (e) { return json(res, 500, { ok: false, error: e.message }); } }
    if (p === '/api/system' && m === 'GET') return json(res, 200, { ok: true, modules: modules.status(), demo: DEMO, checker: checker.summary() });
    if (p === '/api/status' && m === 'GET') return json(res, 200, checker.summary());
    if (p === '/api/history' && m === 'GET') {
      const id = String(u.searchParams.get('id') || '');
      if (!CONFIG.dashboards.some(d => d.id === id)) return json(res, 404, { ok: false, error: 'no such dashboard' });
      return json(res, 200, checker.history(id));
    }
    if (p === '/api/check-now' && m === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'wrong origin' });
      await checker.runOnce();
      return json(res, 200, { ok: true, runs: checker.runs });
    }
    if (p === '/api/signout-everywhere' && m === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'wrong origin' });
      auth.signOutEverywhere();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  }

  return send(res, 404, 'not found', 'text/plain');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error('ERROR ' + req.method + ' ' + req.url.split('?')[0] + ': ' + (e && e.stack || e));
    if (!res.headersSent) send(res, 500, 'something went wrong', 'text/plain');
    else res.end();
  });
});
server.keepAliveTimeout = 65000;

function start(port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(SITE.title + ' listening on ' + (host || '') + ':' + server.address().port + (DEV ? ' (dev: plain http)' : '') + (DEMO ? ' (demo: sample exports)' : '') + ', history in ' + DATA_DIR);
      modules.start();
      checker.start();
      resolve(server.address());
    });
  });
}
function stop() { checker.stop(); modules.stop(); server.close(); }

if (require.main === module) {
  start(PORT).catch(e => { console.error('could not listen on ' + PORT + ': ' + e.message); process.exit(1); });
  const bye = () => { console.log('stopping'); stop(); setTimeout(() => process.exit(0), 2500).unref(); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}

module.exports = { server, start, stop, checker, modules, auth, CONFIG };
