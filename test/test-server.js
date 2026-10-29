'use strict';
/* Smoke tests: the door, the pages, and the checker against a stand-in
   set of dashboards. Run: node test/test-server.js */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arden-hub-test-'));
let passed = 0;
function ok(name, cond) { if (!cond) { console.error('FAIL ' + name); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } }

/* stand-in dashboards */
let flaky = 0;
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/ok') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (u.pathname === '/json') return j({ ok: true, feed: { rows: 5, readAt: new Date(Date.now() - 2 * 3600000).toISOString() } });
  if (u.pathname === '/fresh') return j({ ok: true, feed: { rows: 5, readAt: new Date(Date.now() - 60000).toISOString() } });
  if (u.pathname === '/slow') return setTimeout(() => j({ ok: true }), 120);
  if (u.pathname === '/down') { res.writeHead(500); return res.end('boom'); }
  if (u.pathname === '/ping') {
    if (req.headers.authorization !== 'Bearer testkey123456789012345') { res.writeHead(401); return res.end('{"ok":false}'); }
    return j({ ok: true, rev: 12, at: '2026-10-28 09:15', roster: 3, pending: 0 });
  }
  if (u.pathname === '/redir') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
  if (u.pathname === '/flaky') { flaky++; if (flaky % 2 === 1) return; /* first of each pair never answers */ return j({ ok: true }); }
  if (u.pathname === '/never') return; /* never answers */
  res.writeHead(404); res.end('nope');
});

(async () => {
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + mock.address().port;
  const cfg = { site: { title: 'Test hub', subtitle: 'tests', intervalSeconds: 3600 }, dashboards: [
    { id: 'a', name: 'Alpha', url: base + '/', group: 'G1', health: { url: base + '/ok', expect: { text: 'ok' } } },
    { id: 'b', name: 'Bravo', url: base + '/', group: 'G1', health: { url: base + '/json', expect: { json: { ok: true } }, fields: [{ label: 'Rows', path: 'feed.rows', kind: 'count' }, { label: 'Read', path: 'feed.readAt', kind: 'time', staleMin: 30 }] } },
    { id: 'c', name: 'Charlie', url: base + '/', health: { url: base + '/slow', slowMs: 50 } },
    { id: 'd', name: 'Delta', url: base + '/', health: { url: base + '/down' } },
    { id: 'e', name: 'Echo link', url: '' },
    { id: 'f', name: 'Foxtrot', url: base + '/', health: { url: base + '/redir', expect: { text: 'ok' }, data: { url: base + '/ping', auth: { bearerEnv: 'HUB_KEY_TEST' }, tz: 'America/New_York', fields: [{ label: 'Rev', path: 'rev', kind: 'count' }, { label: 'Synced', path: 'at', kind: 'time' }] } } },
    { id: 'g', name: 'Golf', url: base + '/', health: { url: base + '/ping', data: { url: base + '/ping', auth: { bearerEnv: 'HUB_KEY_MISSING' } } } },
    { id: 'h', name: 'Hotel', url: base + '/', health: { url: base + '/fresh', fields: [{ label: 'Read', path: 'feed.readAt', kind: 'time', staleMin: 30 }] } },
    { id: 'i', name: 'India', url: base + '/', health: { url: base + '/flaky', timeoutMs: 400, retryDelayMs: 50 } },
    { id: 'j', name: 'Juliet', url: base + '/', health: { url: base + '/never', timeoutMs: 400, retryDelayMs: 50 } }
  ] };
  const cfgFile = path.join(tmp, 'dashboards.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  process.env.HUB_CONFIG = cfgFile; process.env.HUB_DEV = '1'; process.env.DATA_DIR = path.join(tmp, 'data'); process.env.HUB_KEY_TEST = 'testkey123456789012345';
  delete process.env.HUB_PIN; delete process.env.HUB_PASSPHRASE_HASH; delete process.env.HUB_SESSION_SECRET;

  const app = require('../server');
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const hub = 'http://127.0.0.1:' + app.server.address().port;
  const get = (p, h) => fetch(hub + p, { headers: h || {}, redirect: 'manual' });
  const post = (p, body, h) => fetch(hub + p, { method: 'POST', redirect: 'manual', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded', Origin: hub }, h || {}), body: body });

  /* public bits */
  let r = await get('/health'); ok('/health is public and says ok', r.status === 200 && await r.text() === 'ok');
  r = await get('/logo.png'); ok('/logo.png is served', r.status === 200 && r.headers.get('content-type') === 'image/png');
  r = await get('/'); let t = await r.text();
  ok('signed-out home is the black sign-in with the logo and a PIN box', r.status === 200 && t.indexOf('/logo.png') > 0 && t.indexOf('name="pin"') > 0 && t.indexOf('background:#000') > 0 && t.indexOf('Alpha') < 0);
  ok('no inline tile names leak before sign-in', t.indexOf('Bravo') < 0);
  r = await get('/status'); t = await r.text(); ok('/status asks for the PIN first and remembers where to go', t.indexOf('name="next" value="/status"') > 0);
  r = await get('/api/status'); ok('/api/status is 401 when signed out', r.status === 401);

  /* the door */
  r = await post('/login', 'pin=1111'); ok('wrong PIN is refused', r.status === 401 && (await r.text()).indexOf('not the PIN') > 0);
  r = await post('/login', 'pin=2468&next=/evil'); ok('right PIN signs in and ignores a strange next', r.status === 303 && r.headers.get('location') === '/' && /hub_session=/.test(r.headers.get('set-cookie')));
  const cookie = r.headers.get('set-cookie').split(';')[0];
  r = await post('/login', 'pin=2468&next=/status'); ok('next=/status is honoured', r.headers.get('location') === '/status');
  r = await post('/login', 'pin=2468', { Origin: 'https://elsewhere.example' }); ok('a cross-site post is refused', r.status === 403);
  r = await post('/login', 'pin=2+4+6+8'); ok('spaces in the PIN do not count', r.status === 303);

  /* signed in */
  const H = { Cookie: cookie };
  r = await get('/', H); t = await r.text();
  ok('home lists every dashboard as a tile', r.status === 200 && ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo link', 'Foxtrot'].every(n => t.indexOf(n) > 0));
  ok('home groups tiles and links to the health board', t.indexOf('G1') > 0 && t.indexOf('href="/status"') > 0);
  ok('a dashboard with no address is a tile with no link', t.indexOf('no address yet') > 0);
  r = await get('/status', H); t = await r.text(); ok('health board page is served', r.status === 200 && t.indexOf('health board') > 0 && t.indexOf('id="grid"') > 0);
  r = await get('/status?tv=1', H); t = await r.text(); ok('TV mode flags the body', t.indexOf('class="tv"') > 0);

  /* the checker */
  r = await post('/api/check-now', '', H); ok('check-now runs a cycle', r.status === 200 && (await r.json()).runs === 1);
  r = await get('/api/status', H); const s = await r.json();
  const by = {}; s.dashboards.forEach(d => { by[d.id] = d; });
  ok('a plain "ok" answer is UP', by.a.state === 'up' && by.a.uptime24 === 100 && by.a.samples24 === 1);
  ok('old data is STALE and the field says why', by.b.state === 'stale' && by.b.fields[1].stale === true && by.b.fields[1].ageMin >= 119 && by.b.fields[0].value === 5);
  ok('stale counts as reachable but not fresh', by.b.uptime24 === 100 && by.b.fresh24 === 0 && by.a.fresh24 === 100);
  ok('a slow answer is SLOW', by.c.state === 'slow' && by.c.ms >= 100);
  ok('a 500 is DOWN with the reason', by.d.state === 'down' && by.d.err === 'answered 500');
  ok('a link-only entry is unchecked', by.e.state === 'unchecked' && by.e.checked === false);
  ok('redirects are followed and the keyed data request is read', by.f.state === 'up' && by.f.fields[0].value === 12 && by.f.fields[1].kind === 'time');
  const synced = by.f.fields[1].value; const want = Date.UTC(2026, 9, 28, 13, 15); /* 09:15 Eastern (EDT, UTC-4) */
  ok('the kiosk time form is read as Eastern', synced === want);
  ok('a missing key skips the data request and says so', by.g.state === 'down' && /skipped|HUB_KEY_MISSING|answered 401/.test(by.g.note + by.g.err));
  ok('fresh data is UP', by.h.state === 'up' && by.h.fields[0].stale === false);
  ok('no answer once, then an answer, is SLOW with a note', by.i.state === 'slow' && /second try/.test(by.i.note));
  ok('no answer twice is DOWN', by.j.state === 'down' && /no answer/.test(by.j.err));
  ok('overall is the worst state and counts add up', s.overall === 'down' && s.counts.down === 3 && s.counts.stale === 1 && s.counts.slow === 2 && s.counts.up === 3);
  ok('what changed lists the first results', s.events.length === 9 && s.events.every(e => e.from === null));
  ok('the 24 h strip has 144 cells with the newest filled', by.a.cells.length === 144 && by.a.cells[143] === 0 && by.a.cells[0] === -1);
  r = await get('/api/history?id=a', H); const hst = await r.json(); ok('history is served per dashboard', hst.samples.length === 1 && hst.samples[0].s === 0);
  r = await get('/api/history?id=zzz', H); ok('unknown dashboard is a 404', r.status === 404);
  await post('/api/check-now', '', H);
  r = await get('/api/status', H); const s2 = await r.json();
  ok('a second cycle keeps the state and adds no events', s2.runs === 2 && s2.events.length === 9 && s2.dashboards.find(d => d.id === 'a').samples24 === 2);
  app.checker.dirty = true; app.checker.save();
  ok('history is written to the data folder', fs.existsSync(path.join(tmp, 'data', 'history.json')));

  /* sign out everywhere + lockout */
  r = await post('/api/signout-everywhere', '', H); ok('sign out everywhere answers ok', r.status === 200);
  r = await get('/api/status', H); ok('old cookies stop working after it', r.status === 401);
  for (let i = 0; i < 5; i++) r = await post('/login', 'pin=0000');
  r = await post('/login', 'pin=2468'); ok('five wrong PINs lock that address out', r.status === 429 && (await r.text()).indexOf('Too many') > 0);

  /* PIN from the environment and from a hash */
  const { makeAuth } = require('../lib/auth');
  const { hashPin } = require('../tools/make-secrets');
  process.env.HUB_PIN = '1357';
  let a2 = makeAuth({ dataDir: path.join(tmp, 'd2'), dev: true });
  ok('HUB_PIN replaces the default', a2.checkPin('1357') && !a2.checkPin('2468'));
  process.env.HUB_PASSPHRASE_HASH = hashPin('9999');
  a2 = makeAuth({ dataDir: path.join(tmp, 'd3'), dev: true });
  ok('HUB_PASSPHRASE_HASH wins over HUB_PIN', a2.checkPin('9999') && !a2.checkPin('1357') && a2.usingHash);
  const a3 = makeAuth({ dataDir: path.join(tmp, 'd3'), dev: true });
  ok('a session secret made once is reused from the data folder', a3.hasSession({ headers: { cookie: 'hub_session=' + a2.makeSession() } }));

  app.checker.stop(); app.server.close(); mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log((process.exitCode ? 'FAILED' : 'all passed') + ' (' + passed + ' checks)');
})().catch(e => { console.error(e); process.exit(1); });
