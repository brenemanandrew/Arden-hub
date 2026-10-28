'use strict';
/* ============================================================
   arden-hub.fly.dev - the front door to every Arden dashboard.

   Node standard library only, like ardenot. It does three things:
     1. Keeps the door: one PIN (2468 unless a secret says otherwise),
        typed once per device, remembered 180 days in a signed cookie.
        Wrong guesses are slowed down. The sign-in is a black screen with
        the Hubbell logo and nothing else.
     2. Shows the home page: one tile per dashboard from dashboards.json
        (Pack, Pick, Staging Lane Health, Weekend Overtime, ...), each
        with a live up / slow / stale / down pill.
     3. Runs the checker (lib/checker.js) once a minute and serves the
        health board at /status: uptime, answer times, data age, what
        changed, for every dashboard, with a week of history on the
        data volume.

   Settings come from the environment (Fly secrets):
     HUB_PASSPHRASE_HASH  scrypt hash of the PIN (tools/make-secrets.js);
                          without it HUB_PIN, and without that 2468
     HUB_SESSION_SECRET   signs the sign-in cookie; made once and kept on
                          the volume when not set
     HUB_KEY_ARDENOT      a dashboard-PC key from ardenot (see README) so
                          the checker can read what the kiosk holds
     DATA_DIR             where history lives (/data on Fly)
     HUB_DEV=1            plain http on localhost, for testing only
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeAuth } = require('./lib/auth');
const { Checker } = require('./lib/checker');
const pages = require('./lib/pages');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEV = process.env.HUB_DEV === '1';
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
  cfg.site = cfg.site || {};
  return cfg;
}
const CONFIG = loadConfig();
const SITE = { title: CONFIG.site.title || 'Arden Dashboards', subtitle: CONFIG.site.subtitle || 'Hubbell Arden' };

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('DATA_DIR ' + DATA_DIR + ' cannot be made: ' + e.message); }
const auth = makeAuth({ dataDir: DATA_DIR, dev: DEV });
if (auth.defaultPin) console.log('AUTH: using the default PIN. Set HUB_PASSPHRASE_HASH (tools/make-secrets.js) to change it.');
const checker = new Checker(CONFIG, { file: path.join(DATA_DIR, 'history.json'), intervalMs: Math.max(15, +(CONFIG.site.intervalSeconds || 60)) * 1000 });

/* ---------- HTTP plumbing (same belt and braces as ardenot) ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};
function send(res, code, body, type, extra) {
  const h = Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS, extra || {});
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
/* the only places a sign-in may lead afterwards */
function safeNext(v) { v = String(v || ''); return v === '/status' || v === '/status?tv=1' ? v : '/'; }

const MANIFEST = JSON.stringify({ name: SITE.title, short_name: 'Arden', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#000000', theme_color: '#000000', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] });
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#000"/>' +
  '<rect y="400" width="512" height="40" fill="#FFC000"/><text x="256" y="310" font-family="Arial,sans-serif" font-size="230" font-weight="700" fill="#FFC000" text-anchor="middle">A</text></svg>';

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

  const signedIn = auth.hasSession(req);

  if (p === '/' && m === 'GET') {
    if (!signedIn) return html(res, 200, pages.loginPage(Object.assign({ next: safeNext(u.searchParams.get('next')) === '/' ? '' : safeNext(u.searchParams.get('next')) }, SITE)));
    return html(res, 200, pages.homePage(Object.assign({ dashboards: CONFIG.dashboards }, SITE)));
  }
  if (p === '/status' && m === 'GET') {
    const tv = u.searchParams.get('tv') === '1';
    if (!signedIn) return html(res, 200, pages.loginPage(Object.assign({ msg: '', next: tv ? '/status?tv=1' : '/status' }, SITE)));
    return html(res, 200, pages.boardPage(Object.assign({ tv: tv }, SITE)));
  }

  if (p.indexOf('/api/') === 0) {
    if (!signedIn) return json(res, 401, { ok: false, error: 'not signed in' });
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

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(SITE.title + ' listening on ' + PORT + (DEV ? ' (dev: plain http)' : '') + ', ' + checker.targets.length + ' dashboards checked every ' + (checker.intervalMs / 1000) + ' s, history in ' + DATA_DIR);
    checker.start();
  });
  const bye = () => { console.log('stopping'); checker.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}

module.exports = { server, checker, auth, CONFIG };
