'use strict';
/* Smoke tests for the hub: the door, the hub pages, the two modules
   running as children behind the proxy (demo mode, sample exports),
   the open push doors, supervision, and the checker against stand-in
   dashboards. Run: node test/test-server.js  (about 20 s, no network) */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arden-hub-test-'));
let passed = 0;
function ok(name, cond) { if (!cond) { console.error('FAIL ' + name); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* stand-in dashboards for the checker */
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
  const cfg = { site: { title: 'Test hub', subtitle: 'tests', intervalSeconds: 3600 }, links: { overtime: 'https://ardenot.example/', ideas: 'https://ideas.example/', ops: '' }, dashboards: [
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
  process.env.HUB_CONFIG = cfgFile; process.env.HUB_DEV = '1'; process.env.HUB_DEMO = '1';
  process.env.HUB_STAGE_PORT = '18481'; process.env.HUB_PACK_PORT = '18482';
  process.env.DATA_DIR = path.join(tmp, 'data'); process.env.HUB_KEY_TEST = 'testkey123456789012345';
  delete process.env.HUB_PIN; delete process.env.HUB_PASSPHRASE_HASH; delete process.env.HUB_SESSION_SECRET;

  const app = require('../server');
  const addr = await app.start(0, '127.0.0.1');
  const hub = 'http://127.0.0.1:' + addr.port;
  const get = (p, h) => fetch(hub + p, { headers: h || {}, redirect: 'manual' });
  const post = (p, body, h) => fetch(hub + p, { method: 'POST', redirect: 'manual', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded', Origin: hub }, h || {}), body: body });

  /* wait for both children to answer through the proxy (the stage module parses three workbooks first) */
  const deadline = Date.now() + 40000; let stageUp = false, packUp = false;
  while (Date.now() < deadline && !(stageUp && packUp)) {
    try { stageUp = (await get('/stage/api/health')).status === 200; } catch (e) { stageUp = false; }
    try { packUp = (await get('/pack/api/health')).status === 200; } catch (e) { packUp = false; }
    if (stageUp && packUp) { const st = app.modules.status(); stageUp = st.stage.up; packUp = st.pack.up; }
    if (!(stageUp && packUp)) await sleep(500);
  }
  ok('both modules start as children and answer on their health lines', stageUp && packUp);

  /* public bits */
  let r = await get('/health'); ok('/health is public and says ok', r.status === 200 && await r.text() === 'ok');
  r = await get('/logo.png'); ok('/logo.png is served', r.status === 200 && r.headers.get('content-type') === 'image/png');
  r = await get('/'); let t = await r.text();
  ok('signed-out home is the black sign-in with the logo and a PIN box', r.status === 200 && t.indexOf('/logo.png') > 0 && t.indexOf('name="pin"') > 0 && t.indexOf('background:#000') > 0 && t.indexOf('id="hubbar"') < 0);
  r = await get('/stage/pickers'); t = await r.text(); ok('a module page asks for the PIN first and remembers where to go', r.status === 200 && t.indexOf('name="next" value="/stage/pickers"') > 0);
  r = await get('/api/shift'); ok('/api/shift is 401 when signed out', r.status === 401);
  r = await get('/stage/api/board'); ok('a module API is 401 when signed out', r.status === 401);
  r = await get('/system'); t = await r.text(); ok('/system asks for the PIN first', t.indexOf('name="next" value="/system"') > 0);

  /* the push doors stay open without the hub cookie, guarded by the modules' own keys */
  r = await get('/pack/api/health'); const ph = await r.json(); ok('/pack/api/health is open and is the module\'s own answer', r.status === 200 && ph.ok === true && !!ph.feed);
  r = await get('/stage/api/health'); ok('/stage/api/health is open', r.status === 200);
  r = await fetch(hub + '/pack/api/drop', { method: 'POST', headers: { 'X-Pack-Kind': 'whtask', 'X-File-Name': 'x.xlsx' }, body: 'nope' }); ok('a pack drop without the key is refused by the module, not the hub', r.status === 403 && /bad key/.test(await r.text()));
  r = await fetch(hub + '/stage/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); ok('a stage push without the secret is refused by the module', r.status === 401 || r.status === 403);

  /* the door */
  r = await post('/login', 'pin=1111'); ok('wrong PIN is refused', r.status === 401 && (await r.text()).indexOf('not the PIN') > 0);
  r = await post('/login', 'pin=2468&next=//evil.example'); ok('right PIN signs in and ignores a strange next', r.status === 303 && r.headers.get('location') === '/' && /hub_session=/.test(r.headers.get('set-cookie')));
  const cookie = r.headers.get('set-cookie').split(';')[0];
  r = await post('/login', 'pin=2468&next=/stage/pickers?shift=1'); ok('next into a module page is honoured', r.headers.get('location') === '/stage/pickers?shift=1');
  r = await post('/login', 'pin=2468', { Origin: 'https://elsewhere.example' }); ok('a cross-site post is refused', r.status === 403);
  r = await post('/login', 'pin=2+4+6+8'); ok('spaces in the PIN do not count', r.status === 303);

  /* signed in: the hub's own pages */
  const H = { Cookie: cookie };
  r = await get('/', H); t = await r.text();
  ok('Shift home has the section bar and the four flow steps', r.status === 200 && t.indexOf('id="hubbar"') > 0 && ['s-pick', 's-pack', 's-stage', 's-ship'].every(id => t.indexOf('id="' + id + '"') > 0));
  ok('the section bar goes Shift, Pick, Pack, Stage, Ship, People, Improve, System', ['/stage/pickers', '/pack/pack', '/stage/tv', '/ship', '/people', '/improve', '/system'].every(h => t.indexOf('href="' + h + '"') > 0));
  for (const [p, mark] of [['/ship', 'id="when"'], ['/people', 'Weekend Overtime'], ['/improve', 'Idea'], ['/system', 'id="grid"']]) {
    r = await get(p, H); t = await r.text(); ok(p + ' is served with the section bar', r.status === 200 && t.indexOf('id="hubbar"') > 0 && t.indexOf(mark) > 0);
  }
  r = await get('/people', H); t = await r.text(); ok('People links the overtime kiosk address from the config', t.indexOf('https://ardenot.example/') > 0);
  r = await get('/system?tv=1', H); t = await r.text(); ok('System TV mode drops the bars and flags the body', t.indexOf('class="tv"') > 0 && t.indexOf('id="hubbar"') < 0);
  r = await get('/pick', H); ok('/pick goes to the pickers tab', r.status === 302 && r.headers.get('location') === '/stage/pickers');
  r = await get('/status', H); ok('/status goes to System', r.status === 302 && r.headers.get('location') === '/system');

  /* signed in: the modules behind the proxy */
  r = await get('/stage/tv', H); t = await r.text();
  ok('the stage TV is proxied with the section bar injected', r.status === 200 && t.indexOf('id="hubbar"') > 0 && t.toLowerCase().indexOf('<!doctype') === 0);
  ok('root links inside the module are rewritten under /stage', t.indexOf('/stage/web/') > 0 && !/["'(]\/web\//.test(t));
  r = await get('/stage/tv?tv=1', H); t = await r.text(); ok('a TV view (?tv=1) is served bare, without the section bar', r.status === 200 && t.indexOf('id="hubbar"') < 0);
  r = await get('/stage/panel', H); t = await r.text(); ok('a panel is served bare too', r.status === 200 && t.indexOf('id="hubbar"') < 0);
  r = await get('/stage/tv', Object.assign({ 'Sec-Fetch-Dest': 'iframe' }, H)); t = await r.text(); ok('an iframe load is served bare', t.indexOf('id="hubbar"') < 0);
  r = await get('/stage/web/board2.css', H); ok('module assets come through with their own type', r.status === 200 && /text\/css/.test(r.headers.get('content-type')));
  r = await get('/stage/pickers', H); t = await r.text(); const pickOn = /<a[^>]*class="[^"]*\bon\b[^"]*"[^>]*>Pick<\/a>|<a[^>]*>Pick<\/a>/.exec(t);
  ok('the pickers tab sits under Pick in the section bar', r.status === 200 && pickOn && /\bon\b/.test(pickOn[0]));
  r = await get('/pack/pack', H); t = await r.text(); ok('the pack board is proxied with the section bar', r.status === 200 && t.indexOf('id="hubbar"') > 0 && t.indexOf('/pack/web/') > 0);
  r = await get('/stage/api/board', H); const board = await r.json(); ok('the stage API answers through the proxy with the sample lanes', r.status === 200 && board.summary && board.summary.lanesTotal === 47);
  r = await get('/stage/no-such-page', H); ok('a module 404 passes through as a 404', r.status === 404);

  /* the Shift model is built from the modules' own APIs */
  r = await get('/api/shift', H); const sm = await r.json();
  ok('/api/shift aggregates stage and pack', r.status === 200 && sm.ok === true && sm.stage && sm.stage.available === true && sm.stage.lanesTotal === 47 && !!sm.pack && !!sm.feeds);
  ok('it names what needs attention with a level and a link', Array.isArray(sm.attention) && sm.attention.every(a => a.level && a.text && a.href));
  r = await get('/api/system', H); const sys = await r.json();
  ok('/api/system reports both children running', sys.modules.stage.up === true && sys.modules.pack.up === true && sys.modules.pack.pid > 0 && sys.demo === true);
  if (!(sys.modules.stage.up && sys.modules.pack.up)) console.error('   modules were: ' + JSON.stringify(sys.modules));

  /* supervision: a module that dies comes back */
  const pid = sys.modules.pack.pid;
  process.kill(pid, 'SIGKILL');
  await sleep(300);
  r = await get('/pack/pack', H); t = await r.text();
  ok('while a module is down its pages say so instead of erroring', r.status === 502 && t.indexOf('Arden Pack') > 0 && t.indexOf('id="hubbar"') > 0);
  let back = false; const d2 = Date.now() + 15000;
  while (Date.now() < d2 && !back) { await sleep(500); try { back = (await get('/pack/api/health')).status === 200; } catch (e) { back = false; } }
  r = await get('/api/system', H); const sys2 = await r.json();
  ok('the supervisor restarts it and counts the restart', back && sys2.modules.pack.pid !== pid && sys2.modules.pack.restarts === 1);

  /* the checker */
  /* the checker already ran once when the hub started; count from there */
  const runs0 = (await (await get('/api/status', H)).json()).runs;
  r = await post('/api/check-now', '', H); ok('check-now runs a cycle', r.status === 200 && (await r.json()).runs === runs0 + 1);
  r = await get('/api/status', H); const s = await r.json();
  const by = {}; s.dashboards.forEach(d => { by[d.id] = d; });
  ok('a plain "ok" answer is UP', by.a.state === 'up' && by.a.uptime24 === 100 && by.a.samples24 === runs0 + 1);
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
  r = await get('/api/history?id=a', H); const hst = await r.json(); ok('history is served per dashboard', hst.samples.length === runs0 + 1 && hst.samples[0].s === 0);
  r = await get('/api/history?id=zzz', H); ok('unknown dashboard is a 404', r.status === 404);
  await post('/api/check-now', '', H);
  r = await get('/api/status', H); const s2 = await r.json();
  ok('a second cycle keeps the state and adds no events', s2.runs === runs0 + 2 && s2.events.length === 9 && s2.dashboards.find(d => d.id === 'a').samples24 === runs0 + 2);
  app.checker.dirty = true; app.checker.save();
  ok('history is written to the data folder', fs.existsSync(path.join(tmp, 'data', 'history.json')));

  /* sign out everywhere + lockout */
  r = await post('/api/signout-everywhere', '', H); ok('sign out everywhere answers ok', r.status === 200);
  r = await get('/api/shift', H); ok('old cookies stop working after it', r.status === 401);
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

  app.stop(); mock.close();
  await sleep(800);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log((process.exitCode ? 'FAILED' : 'all passed') + ' (' + passed + ' checks)');
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})().catch(e => { console.error(e); process.exit(1); });
process.on('uncaughtException', e => { console.error(e); process.exit(1); });
