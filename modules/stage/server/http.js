'use strict';
/* HTTP API and static files. No framework: a floor tool should not need an
   install step, and Node's http module is enough for a handful of routes.
   Live updates go out over Server-Sent Events, which every browser speaks
   and which survive a flaky Wi-Fi link by reconnecting on their own. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const board = require('./board');
const model = require('./model');
const months = require('./months');
const feed = require('./feedcrypt');

const WEB = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
               '.csv': 'text/csv; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.txt': 'text/plain; charset=utf-8' };

function csvCell(v){ v = String(v == null ? '' : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function rowsToCsv(rows){ return rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }

class Api {
  constructor(app){
    this.app = app;               // { cfg, ingest, dwell, puller, settings, log, version }
    this.clients = new Set();
    this.server = null;
    this.viewerSeen = 0;
  }
  listen(){
    const c = this.app.cfg.get();
    this.server = http.createServer((req, res) => this.handle(req, res).catch(e => {
      this.app.log('http error: ' + (e && e.stack || e));
      if(!res.headersSent){ res.writeHead(500, { 'Content-Type': 'text/plain' }); }
      res.end('server error: ' + (e && e.message));
    }));
    this.server.keepAliveTimeout = 65000;
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(c.port, c.host, () => resolve(this.server.address()));
    });
  }
  close(){ for(const r of this.clients){ try{ r.end(); }catch(e){} } if(this.server) this.server.close(); }
  addresses(){
    const c = this.app.cfg.get();
    const out = [];
    const ifs = os.networkInterfaces();
    for(const name of Object.keys(ifs)){
      for(const i of ifs[name]){ if(i.family === 'IPv4' && !i.internal) out.push('http://' + i.address + ':' + c.port + '/'); }
    }
    out.unshift('http://' + os.hostname() + ':' + c.port + '/');
    return out;
  }
  viewers(){ return this.clients.size; }

  /* Push to every open event stream. */
  broadcast(event, data){
    const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data || {}) + '\n\n';
    for(const r of this.clients){ try{ r.write(msg); }catch(e){} }
  }

  leaseMs(){ const c = this.app.cfg.get().cloud || {}; const m = parseInt(c.leaseMin, 10); return Math.max(1, isNaN(m) ? 10 : m) * 60000; }
  statusPayload(){
    const a = this.app;
    const files = a.ingest.diag();
    return {
      server: { version: a.version, uptimeSec: Math.round(process.uptime()), host: os.hostname(), addresses: this.addresses(), port: a.cfg.get().port,
                reportDir: a.cfg.get().reportDir, dataDir: a.cfg.dataDir, viewers: this.clients.size, now: Date.now(), platform: process.platform,
                mode: a.cloudMode ? 'cloud' : 'host', cloud: a.cloudMode ? Object.assign({ host: a.store.data.host, hostVersion: a.store.data.hostVersion || null, receivedAt: a.store.received }, a.store.feederStatus(Date.now(), this.leaseMs())) : (a.cloud ? a.cloud.status() : null) },
      puller: a.puller.status(),
      backfill: a.backfill ? a.backfill.status() : null,
      eos: a.eos ? a.eos.status() : null,
      backup: a.backup ? Object.assign(a.backup.status(), { cloudSent: a.cloud ? (a.cloud.st.backupSent || null) : null })
                       : (a.cloudMode && a.store ? { held: a.store.backupMeta() } : null),
                /* on the copy this is the host's own answer, carried in on
                   its last push, not something the copy could know itself */
                recovery: a.sapwatch ? a.sapwatch.status() : (a.cloudMode && a.store ? (a.store.data.recovery || null) : null),
                commands: a.cloudMode ? (a.store ? a.store.commandStatus() : null) : (a.commands ? a.commands.status() : null),
      files,
      newestFile: a.ingest.newestMtime(),
      dataVersion: a.ingest.version,
      dwellVersion: a.dwell.version
    };
  }

  async handle(req, res){
    const parsed = new URL(req.url, 'http://localhost');
    const u = { pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams) };
    const p = decodeURIComponent(u.pathname);
    const m = req.method;
    res.setHeader('Access-Control-Allow-Origin', '*');
    const cfg = this.app.cfg.get();

    /* the host pushes here; the secret is the only key that opens this door */
    if(p === '/api/ingest'){
      if(m !== 'POST') return this.json(res, { error: 'POST only' }, 405);
      const want = (cfg.cloud && cfg.cloud.secret) || '';
      const got = String(req.headers['x-slh-key'] || '');
      if(!want || got !== want){ res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('bad key'); return; }
      if(!this.app.cloudMode) return this.json(res, { error: 'this copy is the host, not the cloud copy' }, 400);
      /* Sealed by the host with the ingest secret. Opening it also proves
         the host sealed it, which the header key above never could - that
         only ever proved the sender knew a string. A push from an older
         build still arrives as gzipped JSON and is still taken, so the copy
         can be updated before the host without a gap in the middle. */
      let body = await readBody(req);
      let payload = null;
      if(feed.isSealed(body)){
        try{ payload = feed.open(body, want); }
        catch(e){ return this.json(res, { error: e.message }, 400); }
      } else {
        if(/gzip/i.test(String(req.headers['content-encoding'] || ''))) body = zlib.gunzipSync(body);
        payload = parseJson(body);
      }
      if(!payload) return this.json(res, { error: 'bad json' }, 400);
      const leaseMs = this.leaseMs();
      const gate = this.app.store.admit(payload, Date.now(), leaseMs);
      if(!gate.ok) return this.json(res, { error: gate.feeder.host + ' is feeding this copy', feeder: gate.feeder, leaseMs }, 409);
      try{ this.app.store.apply(payload, Date.now()); }catch(e){ return this.json(res, { error: e.message }, 400); }
      /* what the host did with the last lot, then what it should do next */
      if(payload.commandAck && payload.commandAck.length){ this.app.store.ackCommands(payload.commandAck); this.broadcast('status', this.statusPayload()); }
      return this.json(res, { ok: true, v: this.app.ingest.version, feeder: gate.feeder, leaseMs, commands: this.app.store.pendingCommands() });
    }
    /* ---- backups through the copy ----
       A host sends the backup it just took; a PC starting with nothing asks
       for the newest. Both use the ingest key, both sit before the viewer
       login like the feed does, and the copy never opens what it holds. */
    if(p === '/api/backup/put' || p === '/api/backup/latest' || p === '/api/backup/meta'){
      const want = (cfg.cloud && cfg.cloud.secret) || '';
      const got = String(req.headers['x-slh-key'] || '');
      if(!want || got !== want){ res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('bad key'); return; }
      if(!this.app.cloudMode) return this.json(res, { error: 'this copy is the host, not the cloud copy' }, 400);
      const store = this.app.store;
      if(p === '/api/backup/put'){
        if(m !== 'POST') return this.json(res, { error: 'POST only' }, 405);
        const sealed = await readBody(req);
        if(!feed.isSealedRaw(sealed)) return this.json(res, { error: 'a backup has to arrive sealed' }, 400);
        const meta = { name: String(req.headers['x-slh-backup-name'] || '').replace(/[^\w.\-]/g, '_') || 'SLH-data.zip',
                       days: parseInt(req.headers['x-slh-backup-days'], 10) || 0, at: parseInt(req.headers['x-slh-backup-at'], 10) || Date.now() };
        const r = store.putBackup(meta, sealed, String(req.headers['x-slh-backup-host'] || ''));
        if(!r.ok) return this.json(res, { error: r.reason }, 409);
        this.app.log('[cloud] holding backup ' + meta.name + ' (' + meta.days + ' days) from ' + String(req.headers['x-slh-backup-host'] || 'a host'));
        return this.json(res, { ok: true, backup: r.backup });
      }
      const meta = store.backupMeta();
      if(p === '/api/backup/meta') return this.json(res, { backup: meta });
      if(!meta || !fs.existsSync(store.backupFile)) return this.json(res, { error: 'the copy holds no backup yet' }, 404);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        'X-SLH-Backup-Name': meta.name, 'X-SLH-Backup-Days': String(meta.days), 'X-SLH-Backup-At': String(meta.at), 'X-SLH-Backup-Host': meta.host || '' });
      fs.createReadStream(store.backupFile).pipe(res);
      return;
    }
    /* a host standing by asks who is feeding, with the same key; a few bytes
       once a minute, so it can take over the moment the feeder goes quiet */
    if(p === '/api/feeder'){
      const want = (cfg.cloud && cfg.cloud.secret) || '';
      if(!want || String(req.headers['x-slh-key'] || '') !== want){ res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('bad key'); return; }
      if(!this.app.cloudMode) return this.json(res, { error: 'this copy is the host, not the cloud copy' }, 400);
      return this.json(res, this.app.store.feederStatus(Date.now(), this.leaseMs()));
    }

    /* ---- viewer login, when a password is set (a must on the internet) ----

       This used to be HTTP Basic and nothing else. Basic leans on the
       browser to put up a credentials box, and a television browser often
       has no such box: an LG set would reach the page, fail to draw the
       prompt, and close. A screen bolted to a wall also has no keyboard to
       type into a prompt that reappears every time the set reboots.

       So the password is accepted three ways and remembered in a cookie:

         - a form on a page this app draws itself, which any browser can
           render because it is only HTML;
         - ?key=... on the address, so a TV can be given one bookmark and
           never be asked again - it is swapped for the cookie and taken
           straight back out of the address bar;
         - the Basic header, still, so anything already saved keeps working.

       The cookie holds a hash rather than the password, lasts a year, and is
       marked Secure whenever the request arrived over https (Fly terminates
       TLS in front, so the proxy's header is what says so). */
    const pw = cfg.auth && cfg.auth.viewerPassword;
    /* /api/shutdown is exempt for the same reason /api/health is: a copy
       starting on this PC has to be able to ask the one already running to
       stop, and it has no password to offer. The route itself answers only
       to the loopback, and only on the host. */
    if(pw && p !== '/api/health' && p !== '/api/shutdown' && p !== '/login'){
      const given = String(u.query.key || u.query.k || '');
      if(given && given === pw){
        /* take the key back out of the address: a bookmark keeps working
           because it sets the cookie again, but the key stops being on
           screen, in the history and in every referrer from here on */
        const clean = p + cleanQuery(u.query, ['key', 'k']);
        res.writeHead(302, { 'Set-Cookie': viewerCookie(req, pw), Location: clean || '/' });
        res.end();
        return;
      }
      if(!this.viewerOk(req, pw)) return this.loginPage(res, req, p + cleanQuery(u.query, []), false);
    }
    if(p === '/login'){
      if(!pw) return this.redirect(res, '/');
      if(m === 'POST'){
        const body = await readBody(req);
        const form = new URLSearchParams(String(body || ''));
        const want = String(form.get('pw') || '');
        const to = safeNext(String(form.get('next') || '/'));
        if(want === pw){ res.writeHead(302, { 'Set-Cookie': viewerCookie(req, pw), Location: to }); res.end(); return; }
        return this.loginPage(res, req, to, true);
      }
      return this.loginPage(res, req, safeNext(String(u.query.next || '/')), false);
    }
    if(p === '/api/health') return this.json(res, { ok: true, mode: cfg.mode, v: this.app.ingest.version });

    /* The cloud copy cannot change anything: it mirrors the host. The two
       exceptions are the ways in - signing in and unlocking the wall panel
       both post, and neither changes any data the host owns. */
    if(this.app.cloudMode && (m === 'POST' || m === 'PUT' || m === 'DELETE') && p !== '/login' && p !== '/quad/unlock' && p !== '/quad/lock' && p !== '/api/command'){
      return this.json(res, { error: 'This is the cloud copy. Settings, pulls and the report folder are managed on the host PC.' }, 403);
    }
    if(m === 'OPTIONS'){ res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return; }

    // ---- pages ----
    if(p === '/' || p === '/index.html') return this.file(res, path.join(WEB, 'index.html'));
    /* the classic board draws itself in viewport units, so it is served inside
       fit.html, a fixed 1920x1080 frame scaled to the screen. ?frame=1 is that
       frame asking for the board itself; ?fit=0 opts out of the frame. */
    /* Two old names for the classic board, kept so bookmarks and the TVs
       that carry them keep working; there is one board and one name now. */
    if(p === '/launchpad' || p === '/classic') return this.redirect(res, '/board' + cleanQuery(u.query, []));
    if(p === '/board' || p === '/board.html'){
      const raw = u.query.frame != null || u.query.fit === '0';
      return this.file(res, path.join(WEB, raw ? 'board.html' : 'fit.html'));
    }
    if(p === '/admin' || p === '/admin.html') return this.file(res, path.join(WEB, 'admin.html'));
    // every page was asking for one and getting a 404 in the console
    if(p === '/favicon.ico') return this.file(res, path.join(WEB, 'logo.png'));
    if(p === '/data' || p === '/data.html') return this.file(res, path.join(WEB, 'data.html'));
    /* The runbook and the definitions, inside the app. A runbook filed
       somewhere else is a runbook nobody reads at five in the morning,
       and the one place everybody can already reach is the board. The
       files stay markdown on disk so the same text prints and mails. */
    /* The performance review: one picker over their last few worked days.
       Not in the nav - it is opened from a person on the People page, or
       straight by address when somebody is doing six of them in a row. */
    if(p === '/review' || p === '/review.html') return this.file(res, path.join(WEB, 'review.html'));
    if(p === '/help' || p === '/help.html') return this.file(res, path.join(WEB, 'help.html'));
    if(p === '/api/doc'){
      /* a fixed list, not a path from the query: the four documents that
         ship with the build, and nothing else off the disk */
      const DOCS = { runbook: 'docs/RUNBOOK.md', definitions: 'docs/DEFINITIONS.md',
                     readme: 'README.md', technical: 'README-technical.md' };
      const rel = DOCS[String(u.query.name || 'runbook').toLowerCase()];
      if(!rel) return this.json(res, { error: 'no such document' }, 404);
      const fp = path.join(__dirname, '..', rel);
      return fs.readFile(fp, 'utf8', (err, text) => {
        if(err){ res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found: ' + rel); return; }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(text);
      });
    }
    if(p === '/tv' || p === '/tv.html') return this.file(res, path.join(WEB, 'tv.html'));
    /* The phone board and the ops view were the same page under two names,
       so they are one page: it lays itself out for whatever is reading it.
       The address stays, because it is on lanyard cards and in bookmarks. */
    if(p === '/phone' || p === '/phone.html') return this.file(res, path.join(WEB, 'ops.html'));
    if(p === '/people' || p === '/people.html') return this.file(res, path.join(WEB, 'people.html'));
    if(p === '/months' || p === '/months.html') return this.file(res, path.join(WEB, 'months.html'));
    /* Five taps on the logo and a code turn on HOST VIEW: the copy stops
       hiding the parts of itself that are meant for the PC next to SAP -
       the wall panel, the pull and backfill pages, the standards. It is a
       different view of the same copy, not a different copy: nothing it
       shows can be changed from here, because the copy still refuses every
       write. The code is swapped for a cookie, so a screen is asked once. */
    if(p === '/quad/unlock'){
      const want = String((cfg.auth && cfg.auth.quadCode) || '');
      if(!want) return this.redirect(res, '/');
      if(m !== 'POST') return this.redirect(res, '/');
      const body = await readBody(req);
      const f = new URLSearchParams(String(body || ''));
      const code = String(f.get('code') || '').trim();
      /* back where they were, rather than off to one particular page: host
         view is a state of the whole copy now */
      const back = safeNext(String(f.get('next') || '/'));
      if(code && code === want){
        res.writeHead(302, { 'Set-Cookie': quadCookie(req, want), Location: back || '/' });
        res.end();
        return;
      }
      return this.redirect(res, '/?quad=bad');
    }
    /* A command for the host PC. On the copy it is queued and goes out with
       the next push reply - host view is the door, on top of the viewer
       password. On the host itself it simply runs. Either way the answer is
       what the host said, when it said it. */
    if(p === '/api/command'){
      if(m !== 'POST') return this.json(res, { error: 'POST only' }, 405);
      const { COMMANDS } = require('./commands');
      const body = await readBody(req);
      const v = parseJson(body) || {};
      const name = String(v.name || '').trim();
      if(!COMMANDS.some(c => c.name === name)) return this.json(res, { error: 'no such command', commands: COMMANDS.map(c => ({ name: c.name, lab: c.lab })) }, 400);
      if(this.app.cloudMode){
        if(!hostViewOk(req, String((cfg.auth && cfg.auth.quadCode) || ''))) return this.json(res, { error: 'host view is needed for this' }, 403);
        const c = this.app.store.queueCommand(name, 'host view');
        this.broadcast('status', this.statusPayload());
        return this.json(res, { ok: true, queued: c, note: 'the host picks it up with its next push, within a minute or so if it is running' });
      }
      if(!this.app.commands) return this.json(res, { error: 'not available' }, 404);
      const r = this.app.commands.run(name, '', 'the Admin page');
      return this.json(res, { ok: r.ok, result: r }, r.ok ? 200 : 409);
    }
    /* and the way back out, which a screen on a wall needs as much as the
       way in */
    if(p === '/quad/lock'){
      if(m !== 'POST') return this.redirect(res, '/');
      res.writeHead(302, { 'Set-Cookie': 'slhq=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' + (overHttps(req) ? '; Secure' : ''), Location: '/' });
      res.end();
      return;
    }
    /* The program itself, for download: the same zip that goes to the
       StagingArea folder, put into the copy's image by tools/deploy-cloud.cmd
       so what /deploy hands out is exactly the build that is running. Not
       linked from anywhere; behind the viewer password like everything. */
    if(p === '/deploy' || p.startsWith('/deploy/')){
      const dir = path.join(WEB, '..', 'deploy');
      let zips = [];
      try{ zips = fs.readdirSync(dir).filter(n => /^StagingLaneHealth-[\w.-]+\.zip$/i.test(n)).sort(); }catch(e){}
      const newest = zips.length ? zips[zips.length - 1] : null;
      if(p.startsWith('/deploy/')){
        const want = decodeURIComponent(p.slice(8));
        if(!newest || zips.indexOf(want) < 0) return this.json(res, { error: 'no such build here' }, 404);
        return this.file(res, path.join(dir, want), true);
      }
      const held = this.app.cloudMode && this.app.store ? this.app.store.backupMeta() : null;
      const size = newest ? Math.round(fs.statSync(path.join(dir, newest)).size / 1048576 * 10) / 10 : 0;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      /* Whoever opens this page has usually been sent here to put the
         program on a PC, and has never been told what the program is. So
         say that first, in the order somebody actually needs it: what this
         is, how to put it on, and what happens once it is there. */
      return res.end('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staging Lane Health - the program</title>' +
        '<link rel="stylesheet" href="/web/board2.css"><style>.wrap{max-width:760px;margin:0 auto;padding:22px 24px 44px}h1{font-size:23px;margin:0 0 6px}' +
        'h2{font-size:15px;margin:26px 0 8px;letter-spacing:.02em}p{font-size:14px;color:var(--ink-2);line-height:1.6;margin:0 0 10px}' +
        '.lede{font-size:15px}.box{background:var(--tile);border:1px solid var(--ring);border-radius:8px;padding:16px 18px;margin:14px 0}' +
        '.put{display:block;margin:0 0 14px}.put:last-child{margin-bottom:0}.put b{color:var(--ink)}' +
        '.big{display:inline-block;font:inherit;font-weight:800;font-size:16px;padding:12px 18px;border-radius:8px;background:var(--amber);color:#000;text-decoration:none}' +
        '.kv{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;font-size:14px}.kv b{color:var(--ink-2)}code{font-size:12px}</style></head><body>' +
        '<div class="bar" data-page="deploy" data-sub="Deploy"></div><main class="wrap">' +
        '<h1>Staging Lane Health, ready to install</h1>' +
        '<p class="lede">This is the program itself, packaged for the one PC that sits beside SAP. If you only want to look at the board, you do not need anything from this page.</p>' +

        '<div class="box">' + (newest
          ? '<div class="kv"><b>Build</b><span>' + esc(String(this.app.version || '')) + '</span><b>File</b><span><code>' + esc(newest) + '</code>, ' + size + ' MB</span></div>' +
            '<p style="margin:14px 0 0"><a class="big" href="/deploy/' + encodeURIComponent(newest) + '">Download ' + esc(newest) + '</a></p>' +
            '<p style="margin:10px 0 0">This is the build ' + (this.app.cloudMode ? 'this copy' : 'this PC') + ' is running right now, so it is never older than what you are looking at.</p>'
          : '<p><b>No build is staged here.</b> Deploying with <code>tools\\deploy-cloud.cmd</code> builds the zip and puts it in the image; a plain <code>fly deploy</code> leaves this page with nothing to hand out.</p>') + '</div>' +

        '<h2>What it is</h2>' +
        '<p>Every screen in Staging Lane Health is served by one program on one PC. That PC is signed in to SAP, takes the staging, order and task exports out of it every minute or so, works the board out from them, and hands it to whatever asks: the TVs on the floor, a phone in somebody\'s pocket, and ' + (this.app.cloudMode ? 'this copy, which is how the board is read from outside the building' : 'the copy on the internet, which is how the board is read from outside the building') + '.</p>' +
        '<p>The zip above is that program, with everything it needs inside it. There is nothing to install, no database, and nothing to set up on the network.</p>' +

        '<h2>Putting it on a PC</h2>' +
        '<div class="box">' +
        '<p class="put"><b>A PC that has never run it.</b> Unzip the folder anywhere on the PC next to SAP and double-click <b>Start Staging Lane Health.cmd</b>. It opens the board and shows the address every other screen should use.</p>' +
        '<p class="put"><b>A PC already running it.</b> Close the black service window, unzip this into the same folder over what is there, and start it again. Nothing is lost by replacing the program: the history, the settings and the logs are not kept in that folder, they live in <code>%LOCALAPPDATA%\\StagingLaneHealth</code>, and the new copy picks them up where the old one left off.</p>' +
        '</div>' +

        '<h2>The one thing to set on that PC</h2>' +
        '<p>SAP will not let a program drive it until scripting is switched on, and that is done once, in SAP itself. In SAP Logon open <b>Options</b>, then <b>Accessibility &amp; Scripting</b>, then <b>Scripting</b>. Tick <b>Enable scripting</b>, and untick both notify boxes underneath it, which otherwise put a popup on screen every time the program reads anything. Then log in to SAP and leave it logged in.</p>' +
        '<p>That is the whole setup. The zip has a <b>FIRST RUN</b> file with the same steps and what to look for on the first pull, if you want it in front of you while you work.</p>' +

        '<h2>What happens once it is running</h2>' +
        '<p>It drives SAP by itself, reads the exports as they land, and keeps the picker history day by day. It writes the shift report a few minutes after each shift ends. It sends all of it ' + (this.app.cloudMode ? 'up here' : 'up to the copy on the internet') + ', so the board works away from the building. And if SAP falls over it closes what is left of it and opens it again, rather than waiting for somebody to notice.</p>' +

        '<div class="box"><p style="margin:0">' + (held && held.name
          ? 'A copy of the host\'s data is held here too: <code>' + esc(held.name) + '</code>, ' + held.days + ' days of history, sent ' + new Date(held.at).toLocaleString() + '. A PC that starts with nothing takes it on its own, so a replacement host comes up with the year already behind the board.'
          : 'No copy of the host\'s data is held here yet. One is sent after every shift and whenever the host restarts, and a new PC takes the newest one on its first start.') + '</p></div>' +
        '</main><script src="/web/theme.js"></script></body></html>');
    }
    /* One panel built for a quarter of a wall screen, on its own. Useful
       anywhere, so the copy serves it too. */
    if(p === '/panel' || p === '/panel.html') return this.file(res, path.join(WEB, 'panel.html'));
    /* The four-up wall panel. Host only: it holds four live views open at
       once, which next to SAP is four reads of the same local data and over
       the internet is four times the traffic of a board.
       It is also a touch screen on the floor of the building the host PC is
       in, so there is nobody on the far end of the cloud copy to use it. */
    if(p === '/quad' || p === '/quad.html'){
      /* On the host it is a listed view and opens straight away. On the copy
         it is deliberately not listed anywhere, and wants the code first -
         which is obscurity rather than a lock, and enough: everyone who can
         reach this page is already past the viewer password. */
      if(cfg.mode === 'cloud' && !hostViewOk(req, String((cfg.auth && cfg.auth.quadCode) || '')))
        return this.json(res, { error: 'not available here' }, 404);
      return this.file(res, path.join(WEB, 'quad.html'));
    }    if(p === '/ops' || p === '/ops.html') return this.file(res, path.join(WEB, 'ops.html'));
    if(p === '/api/board') return this.json(res, board.build(this.app));
    /* The pack board moved out: it is its own app at ardenpack.fly.dev,
       reading the same export folder. Anyone with the old address in a
       bookmark is sent there rather than given a 404. */
    if(p === '/pack' || p === '/pack.html' || p.indexOf('/api/pack') === 0){
      res.writeHead(302, { 'Location': 'https://ardenpack.fly.dev/' });
      return res.end();
    }
    if(p === '/pickers' || p === '/pickers.html') return this.file(res, path.join(WEB, 'pickers.html'));
    /* one person over everything on file: months, the year with its holes
       estimated, last week, yesterday, and the page's own period */
    if(p === '/api/person'){
      if(!this.app.pickers) return this.json(res, { error: 'not available' }, 404);
      const who = String(u.query.who || '').trim();
      if(!who) return this.json(res, { error: 'who?' }, 400);
      const days = Math.max(1, Math.min(400, parseInt(u.query.days, 10) || 30));
      const sh = String(u.query.shift || '');
      const out = require('./person').person(this.app.pickers, who, model.dayKey(new Date()), { days, shiftName: (sh && sh !== 'live' && sh !== 'all') ? sh : null });
      if(!out) return this.json(res, { error: 'no records for ' + who }, 404);
      return this.json(res, out);
    }
    if(p === '/api/review'){
      if(!this.app.pickers) return this.json(res, { error: 'not available' }, 404);
      const who = String(u.query.who || '').trim();
      if(!who) return this.json(res, { error: 'who?' }, 400);
      const sh = u.query.shift == null ? undefined : String(u.query.shift);
      const out = require('./review').review(this.app.pickers, who, model.dayKey(new Date()), {
        days: parseInt(u.query.days, 10) || 10,
        minHours: u.query.minHours,
        /* absent means "work out their shift"; the word all means do not
           split the day at that level at all */
        shiftName: sh === undefined ? undefined : (sh === 'all' || sh === 'live' ? '' : sh)
      });
      if(!out) return this.json(res, { error: 'nothing on file for ' + who }, 404);
      if(out.empty === 'belowFloor') return this.json(res, Object.assign({
        error: who + ' has days on file but none of them a picking day'
      }, out), 404);
      return this.json(res, out);
    }
    /* History collected on another PC. The point of it is a backfill that
       drove a different SAP session, so this one never had to stop driving
       its own - three hours of a stale board is worse than a memory stick.

       Two refusals before anything is written: a file that is not one of
       ours, and a file parsed under different settings. A history read with
       another area map or another line key is wrong in a way nobody would
       notice for weeks, so it is named and refused unless somebody says to
       take it anyway. */
    if(p === '/api/history/import'){
      if(m !== 'POST') return this.json(res, { error: 'POST only' }, 405);
      if(!this.app.pickers) return this.json(res, { error: 'not available' }, 404);
      const collect = require('./collect');
      const body = await readBody(req, 400 * 1024 * 1024);
      let file;
      try{ file = collect.read(Buffer.isBuffer(body) ? body : Buffer.from(body)); }
      catch(e){ return this.json(res, { error: e.message }, 400); }
      const diff = collect.settingsDiff(collect.settingsOf(this.app), file.settings || {});
      if(diff.length && String(u.query.anyway || '') !== '1'){
        return this.json(res, {
          error: 'that history was collected under different settings',
          differences: diff, from: file.from, to: file.to, days: file.count,
          collectedBy: file.collectedBy, build: file.build,
          note: 'numbers read under a different area map or line key are not the same measurement. ' +
                'Match the settings on both PCs and collect again, or send it with anyway=1 if you are sure.'
        }, 409);
      }
      const rep = this.app.pickers.importDays(file.days, (msg, lvl) => this.app.log(msg, lvl));
      if(this.app.recommend){
        /* the recommended standards are built off the days that just
           changed, so they are stale until they are built again */
        try{ Object.keys(file.days).sort().slice(-120).forEach(k => this.app.recommend.snapshot(k)); }catch(e){}
      }
      this.broadcast('status', this.statusPayload());
      return this.json(res, Object.assign({ ok: true, collectedBy: file.collectedBy, build: file.build,
                                            settingsDiffer: diff }, rep));
    }
    if(p === '/api/pickers'){
      if(!this.app.pickers) return this.json(res, { error: 'not available' }, 404);
      const days = Math.max(1, Math.min(120, parseInt(u.query.days, 10) || 1));
      /* offset=1 is yesterday (the range ends a day early); shift=<name>
         keeps only that shift's records across the range, shift=live is
         the one running now */
      const offset = Math.max(0, Math.min(60, parseInt(u.query.offset, 10) || 0));
      const base = model.dayKey(new Date(Date.now() - offset * 86400000));
      const sh = String(u.query.shift || '');
      const rep = this.app.pickers.report(days, base, { shift: sh === 'live' ? 'live' : null, shiftName: (sh && sh !== 'live' && sh !== 'all') ? sh : null });
      rep.offset = offset;
      rep.feed = { wh: this.app.ingest.diag().wh };
      const whRows = this.app.ingest.fullRows('wh');
      if(whRows){ try{ rep.diag = model.pickerDiag(whRows, model.dayKey(new Date())); }catch(e){ rep.diag = { ok: false, note: e.message }; } }
      /* one day at a time, the minute each confirmation landed, so the activity
         strip can show how fast the scans were coming instead of a flat band */
      if(whRows && (days === 1 || sh === 'live')){
        try{ rep.marks = this.app.pickers.marks(whRows, base, { shift: sh === 'live' ? 'live' : null }); }catch(e){}
      }
      rep.wtBackDays = (this.app.cfg.get().pull || {}).wtBackDays;
      return this.json(res, rep);
    }
    /* The year a month at a time, off the daily rollup alone - no export is
       read for this, so it costs the same whether it is asked for once or
       kept open on a screen. */
    if(p === '/api/months'){
      if(!this.app.pickers) return this.json(res, { error: 'not available' }, 404);
      const want = Math.max(1, Math.min(36, parseInt(u.query.months, 10) || 13));
      /* On the copy the host's own digest wins: it reaches back over the
         whole year the backfill established, where the days pushed up here
         only cover the last few weeks. Its own rollup answers if no host has
         pushed one yet. */
      const sent = this.app.cloudMode && this.app.store ? this.app.store.data.monthly : null;
      if(sent && sent.months){
        const cut = sent.months.slice(-want);
        const total = (sent.totals && sent.totals[want]) || sumOf(cut);
        return this.json(res, Object.assign({}, sent, { months: cut, total, fromHost: true,
          from: cut.length ? cut[0].key : null, to: cut.length ? cut[cut.length - 1].key : null }));
      }
      return this.json(res, months.build(this.app.pickers, { months: want, todayKey: model.dayKey(new Date()) }));
    }
    if(p === '/api/recommend'){
      if(!this.app.recommend) return this.json(res, { error: 'not available' }, 404);
      return this.json(res, this.app.recommend.report(u.query, model.dayKey(new Date())));
    }
    if(p.startsWith('/web/')) return this.file(res, safeJoin(WEB, p.slice(5)));

    // ---- live stream ----
    if(p === '/api/events') return this.events(req, res);

    // ---- read APIs ----
    if(p === '/api/status'){
      const s = this.statusPayload();
      /* whether this screen has unlocked host view. Per request, because it
         is a cookie on one screen and not a state of the server. */
      if(s.server) s.server.hostView = cfg.mode !== 'cloud' || hostViewOk(req, String((cfg.auth && cfg.auth.quadCode) || ''));
      return this.json(res, s);
    }
    if(p === '/api/data'){
      const a = this.app;
      const etag = 'W/"' + a.ingest.version + '-' + a.dwell.version + '"';
      if(req.headers['if-none-match'] === etag){ res.writeHead(304, { ETag: etag }); res.end(); return; }
      const body = a.ingest.payload();
      body.dwell = a.dwell.payload();
      body.status = this.statusPayload();
      /* what each area usually does an hour per picker, for the board to read
         today against; under a pinned test date that date is 'today', so the
         comparison stays coherent */
      const sv = a.settings.get() || {};
      const todayK = /^\d{4}-\d{2}-\d{2}$/.test(sv.asOfDate || '') ? sv.asOfDate : model.dayKey(new Date());
      body.areaUsual = a.pickers ? a.pickers.areaUsual(14, todayK) : null;
      res.setHeader('ETag', etag);
      return this.json(res, body);
    }
    if(p === '/api/lanes') return this.json(res, this.lanesSummary());
    if(p === '/api/log') return this.json(res, { lines: this.app.puller.tail(parseInt(u.query.n, 10) || 200) });
    if(p === '/api/config' && m === 'GET') return this.json(res, { config: this.app.cfg.get(), defaults: this.app.cfg.defaults(), file: this.app.cfg.file, dataDir: this.app.cfg.dataDir });
    if(p === '/api/settings' && m === 'GET'){
      /* The classic board keeps its own kpi_flow / kpi_static / kpi_p007
         fields. They are the same numbers as the pick standards, so they are
         filled in from there rather than typed a second time. */
      const v = this.app.settings.get();
      /* on the cloud copy the standards arrive in the push, so ask the
         pickers module rather than the local config file */
      const tg = this.app.pickers ? this.app.pickers.settings().targets
               : model.parseTargets(((this.app.cfg.get().pickers || {}).targets || '').trim() || model.DEFAULT_TARGETS);
      const out = Object.assign({}, v || {});
      /* the classic board's work-load and Avg vs KPI panels between them read
         seven of these, so all seven come from the standards */
      [['kpi_flow', 'flow'], ['kpi_static', 'static'], ['kpi_p007', 'p007'],
       ['kpi_cant', 'cantilever'], ['kpi_grng', 'grainger'],
       ['kpi_whstock', 'warehouse stock'], ['kpi_comp', 'comp']].forEach(([k, area]) => {
        const t = model.targetFor(tg, area);
        if(t) out[k] = t;
      });
      /* say where those numbers came from, so a board showing the shipped
         defaults is not mistaken for one showing the standards in force */
      out.kpiSource = this.app.cloudMode
        ? ((this.app.pickers && this.app.pickers.override && this.app.pickers.override.targets) ? 'standards from host' : 'default standards, none from host')
        : (((this.app.cfg.get().pickers || {}).targets) ? 'pick standards' : 'default standards');
      [].forEach(() => {
      });
      return this.json(res, out);
    }
    if(p === '/api/tree' && m === 'GET') return this.json(res, this.app.puller.lastTree || { at: null, nodes: [] });
    if(p === '/api/reports' && m === 'GET') return this.json(res, { reports: this.listReports() });
    if(p.startsWith('/reports/')) return this.file(res, safeJoin(path.join(this.app.cfg.dataDir, 'reports'), p.slice(9)), true);
    if(p.startsWith('/files/')) return this.rawFile(res, p.slice(7));
    if(p === '/api/export/pickers.csv' || p === '/api/export/pickers.json'){
      if(!this.app.pickers) return this.json(res, { error: 'not available' }, 404);
      const days = Math.max(1, Math.min(120, parseInt(u.query.days, 10) || 1));
      const rep = this.app.pickers.report(days, model.dayKey(new Date()));
      if(p.endsWith('.json')) return this.json(res, rep);
      const rows = [['picker', 'picks', 'active_hours', 'picks_per_hour', 'target_per_hour', 'expected_picks', 'percent_of_target', 'days']]
        .concat(rep.people.map(x => [x.who, x.total, x.activeHours, x.rate, x.targetRate, x.expected, x.pct == null ? '' : x.pct, x.days]));
      res.writeHead(200, { 'Content-Type': MIME['.csv'], 'Content-Disposition': 'attachment; filename="picker_performance.csv"' });
      return res.end(rowsToCsv(rows));
    }
    if(p.startsWith('/api/export/')) return this.exportFile(res, p.slice(12));

    /* A start stops the copy that is already running (server/launcher.js).
       Loopback only, and never on the cloud copy, where the platform owns
       the process. */
    if(p === '/api/shutdown' && m === 'POST'){
      const ra = String((req.socket && req.socket.remoteAddress) || '');
      const local = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
      if(this.app.cloudMode || !local) return this.json(res, { error: 'not available' }, 404);
      this.json(res, { ok: true, stopping: true });
      setTimeout(() => { if(this.app.shutdown) this.app.shutdown('a new copy is starting'); else process.exit(0); }, 120);
      return;
    }

    // ---- write APIs ----
    if(m === 'POST' || m === 'PUT'){
      const body = await readBody(req);
      if(p === '/api/settings'){ const v = parseJson(body); if(!v || typeof v !== 'object') return this.json(res, { error: 'bad json' }, 400); this.app.settings.set(v); this.broadcast('settings', { at: Date.now() }); return this.json(res, { ok: true }); }
      if(p === '/api/config'){
        const v = parseJson(body); if(!v || typeof v !== 'object') return this.json(res, { error: 'bad json' }, 400);
        const before = JSON.stringify(this.app.cfg.get());
        const cfg = this.app.cfg.update(v);
        if(JSON.stringify(cfg) !== before){
          this.app.log('config updated'); this.app.ingest.armWatch(); this.app.ingest.refresh(); this.app.puller.pullNow(); this.broadcast('status', this.statusPayload());
          // the classic board carries the standards as its KPI numbers, and reloads them on this event
          if(v.pickers) this.broadcast('settings', { at: Date.now() });
        }
        return this.json(res, { ok: true, config: cfg, restartNeeded: v.port != null && v.port !== cfg.port });
      }
      if(p === '/api/control'){
        const v = parseJson(body) || {};
        const pu = this.app.puller;
        switch(v.action){
          case 'start': pu.requestStart(); break;
          case 'stop': pu.requestStop(); break;
          case 'pull-now': pu.requestStart(); pu.pullNow(); break;
          case 'probe': pu.st.sap.at = null; pu.maybeProbe(); break;
          case 'takeover': if(this.app.cloud) this.app.cloud.takeover(); break;
          case 'pull-wt': if(!pu.runPart('wt')) return this.json(res, { error: 'a cycle is running; try again in a moment' }, 409); break;
          /* The pack benches, which the staging pull never asks about: the
             same handling unit export with the PK bins instead of the
             lanes, into a file of its own. One SAP session drives both,
             which is why this lives here and not in a second program. */
          case 'pull-pack': {
            const pk = (cfg.pull || {}).pack || {};
            const r = await pu.runOnce('hu', {
              BinPatterns: pk.bins || 'PK*',
              StageFile: pk.file || 'PACK HU.XLSX'
            }, 300000);
            if(!r.ok) return this.json(res, { error: r.error || 'the pack export did not run' }, 409);
            await this.app.ingest.refresh();
            break;
          }
          case 'reread': this.app.ingest.files = { stage: {}, orders: {}, wh: {} }; await this.app.ingest.refresh(); break;
          default: return this.json(res, { error: 'unknown action' }, 400);
        }
        this.broadcast('status', this.statusPayload());
        return this.json(res, { ok: true, puller: pu.status() });
      }
      /* the Admin button: put SAP back now, without waiting for the watch */
      if(p === '/api/sap/recover'){
        if(!this.app.sapwatch) return this.json(res, { error: 'not available on this copy' }, 404);
        const r = this.app.sapwatch.trigger('asked for from the Admin page');
        this.broadcast('status', this.statusPayload());
        return this.json(res, Object.assign({ recovery: this.app.sapwatch.status() }, r), r.ok ? 200 : 409);
      }
      if(p === '/api/backup/now'){
        if(!this.app.backup) return this.json(res, { error: 'not available on this copy' }, 404);
        const r = this.app.backup.run('requested from the Admin page');
        this.broadcast('status', this.statusPayload());
        return this.json(res, r, r.ok ? 200 : 500);
      }
      /* the host asks the copy for the newest backup and merges it in - the
         Admin button behind a confirm, because it works even on a PC that
         has history (nothing is lost in a merge, but it is still a change) */
      if(p === '/api/backup/pull'){
        if(!this.app.backup) return this.json(res, { error: 'not available on this copy' }, 404);
        if(this.app.backfill && this.app.backfill.status().running) return this.json(res, { error: 'a backfill is running; wait for it' }, 409);
        const { Backup } = require('./backup');
        const r = await Backup.adoptFromCloud(this.app.cfg, this.app.log, { force: true });
        if(r.restored){
          try{ const t = fs.readFileSync(this.app.pickers.file, 'utf8'); this.app.pickers.history = JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t); this.app.pickers.version++; }catch(e){}
          this.app.backup.st.restored = { at: Date.now(), file: r.file, days: r.days, how: r.how };
          this.broadcast('status', this.statusPayload());
          this.broadcast('data', { v: this.app.ingest.version });
        }
        return this.json(res, r, r.restored ? 200 : 409);
      }
      if(p === '/api/backup/locate'){
        if(!this.app.backup) return this.json(res, { error: 'not available on this copy' }, 404);
        this.app.backup.locate(true);
        this.broadcast('status', this.statusPayload());
        return this.json(res, { ok: true, backup: this.app.backup.status() });
      }
      /* put a named backup from the folder back over this PC's data. Only
         from the Admin page, only a name that is in the folder, and only
         when nothing is mid-way through writing the data folder. */
      if(p === '/api/backup/restore'){
        if(!this.app.backup) return this.json(res, { error: 'not available on this copy' }, 404);
        const v = parseJson(body) || {};
        const name = String(v.name || '');
        if(!/^SLH-data-[^\\/]+\.zip$/i.test(name)) return this.json(res, { error: 'that is not the name of a backup' }, 400);
        if(this.app.backfill && this.app.backfill.status().running) return this.json(res, { error: 'a backfill is running; wait for it' }, 409);
        const file = path.join(this.app.backup.backupsDir(), name);
        if(!fs.existsSync(file)) return this.json(res, { error: 'no such backup in the folder' }, 404);
        /* a copy of what is here before it is written over, so a restore of
           the wrong backup is undoable */
        if((this.app.cfg.get().backup || {}).beforeRestore !== false){
          try{ this.app.backup.run('before restoring ' + name, { auto: true }); }catch(e){ this.app.log('backup before restore: ' + e.message, 'warn'); }
        }
        try{
          const { Backup } = require('./backup');
          const r = Backup.restoreFile(this.app.cfg, file, this.app.log);
          /* the pickers and settings objects read their files once at start;
             tell them to read again so the board shows what was restored */
          try{ this.app.pickers.history = JSON.parse(fs.readFileSync(this.app.pickers.file, 'utf8').replace(/^\uFEFF/, '')); this.app.pickers.version++; }catch(e){}
          this.app.backup.st.restored = { at: Date.now(), file, days: r.days, how: 'chosen on the Admin page' };
          this.broadcast('status', this.statusPayload());
          this.broadcast('data', { v: this.app.ingest.version });
          return this.json(res, Object.assign({ ok: true }, r));
        }catch(e){ return this.json(res, { error: e.message }, 500); }
      }
      if(p === '/api/backfill'){
        if(!this.app.backfill) return this.json(res, { error: 'not available on this copy' }, 404);
        const v = parseJson(body) || {};
        const r = this.app.backfill.start(v);
        if(!r.ok) return this.json(res, r, 409);
        this.broadcast('status', this.statusPayload());
        return this.json(res, { ok: true, backfill: this.app.backfill.status() });
      }
      if(p === '/api/dwell/repair'){ const r = this.app.dwell.repair(); this.broadcast('data', { v: this.app.ingest.version }); return this.json(res, r); }
      if(p === '/api/dwell/clear'){ this.app.dwell.clearLog(); this.broadcast('data', { v: this.app.ingest.version }); return this.json(res, { ok: true }); }
      if(p === '/api/usage/reset'){ this.app.dwell.resetUsage(); this.broadcast('data', { v: this.app.ingest.version }); return this.json(res, { ok: true }); }
      if(p === '/api/tree'){
        return new Promise(resolve => this.app.puller.discoverTree((err, tree) => { resolve(err ? this.json(res, { error: err.message }, 500) : this.json(res, tree)); }));
      }
      /* Pick the task node without anybody having to know the tree.
         Several nodes are called Warehouse Task and the ones that matter
         are told apart only by what sits above them: loading tasks hang
         off the delivery, never off a wave. */
      if(p === '/api/pull/findwt'){
        return new Promise(resolve => this.app.puller.discoverTree(async (err, tree) => {
          if(err) return resolve(this.json(res, { error: err.message }, 500));
          const found = pickTaskNode(tree.nodes || []);
          if(!found.best) return resolve(this.json(res, { error: 'No node named like a warehouse task in this tree', candidates: found.list }, 404));
          const b = found.best;
          try{
            this.app.cfg.update({ pull: { nodes: { wt: { key: b.key, label: b.text, parent: b.parentText, expand: b.chain } } } });
          }catch(e){ return resolve(this.json(res, { error: e.message }, 500)); }
          this.broadcast('status', this.statusPayload());
          return resolve(this.json(res, { ok: true, chosen: b, candidates: found.list }));
        }));
      }
      if(p === '/api/reports/eos'){
        /* the host's board asks for the end of shift report, with or without
           the floor's answers; the server builds it from its own data */
        if(!this.app.eos) return this.json(res, { error: 'reports are written on the host PC' }, 404);
        const r = this.app.eos.request(parseJson(body) || {});
        return this.json(res, r, r.ok ? 200 : 500);
      }
      if(p === '/api/reports/week'){
        if(!this.app.eos) return this.json(res, { error: 'reports are written on the host PC' }, 404);
        const r = this.app.eos.requestWeek(parseJson(body) || {});
        return this.json(res, r, r.ok ? 200 : 500);
      }
      if(p === '/api/reports/shift'){
        const name = String(u.query.name || 'Shift_Report.pptx').replace(/[^A-Za-z0-9_.-]/g, '_');
        const dir = path.join(this.app.cfg.dataDir, 'reports');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), body);
        this.app.log('shift report saved: ' + name);
        // also drop a copy in the report folder, where the old board put it
        try{ const rd = this.app.cfg.get().reportDir; if(fs.existsSync(rd)) fs.writeFileSync(path.join(rd, name), body); }catch(e){}
        return this.json(res, { ok: true, name, url: '/reports/' + encodeURIComponent(name) });
      }
      return this.json(res, { error: 'not found' }, 404);
    }
    if(m === 'DELETE' && p.startsWith('/reports/')){
      const f = safeJoin(path.join(this.app.cfg.dataDir, 'reports'), p.slice(9));
      try{ fs.unlinkSync(f); }catch(e){}
      return this.json(res, { ok: true });
    }
    this.json(res, { error: 'not found' }, 404);
  }

  events(req, res){
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    res.write('event: hello\ndata: ' + JSON.stringify({ v: this.app.ingest.version, dv: this.app.dwell.version, now: Date.now() }) + '\n\n');
    this.clients.add(res);
    this.app.puller.noteViewer();
    const ping = setInterval(() => { try{ res.write(': ping\n\n'); }catch(e){} this.app.puller.noteViewer(); }, 25000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }

  lanesSummary(){
    const d = this.app.ingest.derived;
    const now = Date.now();
    const out = { at: d.at, lanes: [], errors: d.errors };
    if(d.lanes){
      const o = d.orders || { cgDoc: {}, docStatus: {} };
      for(const bin of Object.keys(d.lanes.lanes).sort()){
        const l = d.lanes.lanes[bin];
        const docs = l.orders.map(cg => o.cgDoc[cg] || ('CG ' + cg));
        const complete = l.orders.length ? l.orders.every(cg => o.docStatus[o.cgDoc[cg]] === 'complete') : null;
        out.lanes.push({ bin, totes: l.hus, orders: l.orders, documents: docs, oldest: l.oldest, ageHours: Math.round((now - l.oldest) / 36000) / 100, picksComplete: complete, d8: !!l.d8 });
      }
      out.looseTotes = d.lanes.cgWhere; out.international = d.lanes.intl; out.d8Orders = d.lanes.d8Orders; out.totesInLanes = d.lanes.totes;
    }
    return out;
  }

  listReports(){
    const dir = path.join(this.app.cfg.dataDir, 'reports');
    try{
      return fs.readdirSync(dir).filter(n => /\.pptx$/i.test(n)).map(n => { const st = fs.statSync(path.join(dir, n)); return { name: n, size: st.size, mtime: st.mtimeMs, url: '/reports/' + encodeURIComponent(n) }; })
        .sort((a, b) => b.mtime - a.mtime);
    }catch(e){ return []; }
  }

  exportFile(res, what){
    const a = this.app;
    const m = /^(staging|orders|whtask|lanes|dwell|usage)\.(csv|json)$/i.exec(what);
    if(!m) return this.json(res, { error: 'unknown export. Try staging.csv, orders.csv, whtask.csv, lanes.csv, dwell.csv, or .json' }, 404);
    const kind = m[1].toLowerCase(), fmt = m[2].toLowerCase();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const send = (rows, objects, base) => {
      if(fmt === 'json'){ return this.json(res, objects); }
      res.writeHead(200, { 'Content-Type': MIME['.csv'], 'Content-Disposition': 'attachment; filename="' + base + '_' + stamp + '.csv"' });
      res.end(rowsToCsv(rows));
    };
    if(kind === 'staging' || kind === 'orders' || kind === 'whtask'){
      const k = kind === 'staging' ? 'stage' : kind === 'orders' ? 'orders' : 'wh';
      const rows = a.ingest.fullRows(k);
      if(!rows) return this.json(res, { error: 'no ' + kind + ' data loaded yet' }, 404);
      const f = a.ingest.files[k];
      const hIdx = Math.max(0, rows.findIndex(r => r.some(c => String(c).trim())));
      const H = rows[hIdx] || [];
      const objs = rows.slice(hIdx + 1).map(r => { const o = {}; H.forEach((h, i) => { if(String(h).trim()) o[String(h).trim()] = r[i] == null ? '' : r[i]; }); return o; });
      return send(rows.slice(hIdx), { file: f.name, written: f.mtime, rows: objs }, kind);
    }
    if(kind === 'lanes'){
      const s = this.lanesSummary();
      const rows = [['lane', 'totes', 'orders', 'documents', 'oldest_staged', 'hours_staged', 'picks_complete']]
        .concat(s.lanes.map(l => [l.bin, l.totes, l.orders.join(' '), l.documents.join(' '), fmtLocal(l.oldest), l.ageHours, l.picksComplete == null ? '' : (l.picksComplete ? 'yes' : 'no')]));
      return send(rows, s, 'lanes');
    }
    if(kind === 'dwell'){
      if(fmt === 'json') return this.json(res, a.dwell.payload());
      res.writeHead(200, { 'Content-Type': MIME['.csv'], 'Content-Disposition': 'attachment; filename="staging_dwell_log_' + stamp + '.csv"' });
      return res.end(a.dwell.csv());
    }
    if(kind === 'usage'){
      const u = a.dwell.payload().usage;
      const rows = [['lane', 'refreshes_occupied', 'refreshes_total', 'percent']].concat(Object.keys(u.use).sort().map(b => [b, u.use[b], u.snaps, u.snaps ? Math.round(u.use[b] / u.snaps * 1000) / 10 : 0]));
      return send(rows, u, 'lane_usage');
    }
  }

  rawFile(res, name){
    const c = this.app.cfg.get();
    const allowed = [c.files.stage, c.files.orders, c.files.wh, 'hu_pull_log.txt', 'sap_status.txt', 'hu_heartbeat.txt'];
    const want = allowed.find(n => n.toLowerCase() === name.toLowerCase());
    if(!want) return this.json(res, { error: 'not an exposed file' }, 404);
    return this.file(res, path.join(c.reportDir, want), true);
  }

  /* Is this request already allowed in? The cookie first, because that is
     what every screen after the first load carries; then Basic, for anything
     that saved credentials before this page existed. */
  viewerOk(req, pw){
    const want = viewerToken(pw);
    const jar = String(req.headers.cookie || '');
    for(const bit of jar.split(';')){
      const i = bit.indexOf('=');
      if(i < 0) continue;
      if(bit.slice(0, i).trim() === 'slh' && bit.slice(i + 1).trim() === want) return true;
    }
    const auth = String(req.headers.authorization || '');
    if(/^Basic /i.test(auth)){
      try{ const dec = Buffer.from(auth.slice(6), 'base64').toString('utf8'); if(dec.slice(dec.indexOf(':') + 1) === pw) return true; }catch(e){}
    }
    return false;
  }
  redirect(res, to){ res.writeHead(302, { Location: to }); res.end(); }
  /* The login page, drawn here rather than left to the browser. Served 200
     rather than 401: a television that meets a 401 tends to show its own
     error page instead of the body, which is the whole problem being fixed.
     Self-contained, because /web is behind this same gate. */
  loginPage(res, req, next, wrong){
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Staging Lane Health</title><style>' +
      'html,body{height:100%;margin:0;background:#0b0b0b;color:#fff;' +
        'font:16px/1.4 "Segoe UI",system-ui,sans-serif;display:flex;align-items:center;justify-content:center}' +
      'form{width:min(92vw,420px);text-align:center}' +
      'h1{font-size:clamp(20px,3vw,30px);font-weight:800;letter-spacing:.06em;margin:0 0 6px}' +
      'h1 b{color:#FFC000}' +
      'p{color:#c3c2b7;margin:0 0 20px;font-size:clamp(13px,1.6vw,16px)}' +
      'p.bad{color:#ff6b6b;font-weight:700}' +
      'input,button{font:inherit;font-size:clamp(16px,2vw,20px);width:100%;box-sizing:border-box;' +
        'padding:14px 16px;border-radius:9px;border:1px solid #3a3a3a;background:#1b1b1b;color:#fff}' +
      'button{margin-top:12px;background:#FFC000;color:#000;font-weight:800;border-color:#FFC000;cursor:pointer}' +
      'small{display:block;margin-top:22px;color:#6f6f6f;font-size:12px;line-height:1.6}' +
      '</style></head><body><form method="POST" action="/login">' +
      '<h1>STAGING LANE <b>HEALTH</b></h1>' +
      (wrong ? '<p class="bad">That password was not right. Try again.</p>' : '<p>Enter the viewer password to open the board.</p>') +
      '<input type="password" name="pw" autocomplete="current-password" autofocus placeholder="Password" enterkeyhint="go">' +
      '<input type="hidden" name="next" value="' + esc(next) + '">' +
      '<button type="submit">Open the board</button>' +
      '<small>On a TV, bookmark the address with <b>?key=</b> and the password on the end ' +
      'and it will never ask again.</small>' +
      '</form></body></html>');
  }
  json(res, obj, code){
    const body = JSON.stringify(obj);
    const h = { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' };
    // the data payload repeats the same bin and order strings thousands of
    // times, so gzip cuts it roughly ten to one for viewers on Wi-Fi
    const ae = res.req && res.req.headers ? String(res.req.headers['accept-encoding'] || '') : '';
    if(body.length > 20000 && /\bgzip\b/.test(ae)){
      h['Content-Encoding'] = 'gzip';
      res.writeHead(code || 200, h);
      res.end(zlib.gzipSync(body, { level: 6 }));
      return;
    }
    res.writeHead(code || 200, h);
    res.end(body);
  }
  file(res, fp, download){
    if(!fp){ res.writeHead(403); res.end('forbidden'); return; }
    fs.stat(fp, (err, st) => {
      if(err || !st.isFile()){ res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found: ' + path.basename(fp)); return; }
      const ext = path.extname(fp).toLowerCase();
      // pages, scripts and styles are small and change together: never let a
      // stale copy linger on a TV. Images and downloads can cache.
      const live = ext === '.html' || ext === '.js' || ext === '.css';
      // no-cache only works if the browser has something to revalidate with,
      // so say when the file changed and answer 304 when it has not
      const lm = new Date(st.mtimeMs); lm.setMilliseconds(0);
      const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': live ? 'no-cache' : 'max-age=300', 'Last-Modified': lm.toUTCString() };
      if(download) h['Content-Disposition'] = 'attachment; filename="' + path.basename(fp) + '"';
      const since = Date.parse(res.req && res.req.headers['if-modified-since'] || '');
      if(!download && since && since >= lm.getTime()){ delete h['Content-Length']; res.writeHead(304, h); res.end(); return; }
      res.writeHead(200, h);
      fs.createReadStream(fp).pipe(res);
    });
  }
}

function safeJoin(root, rel){
  const fp = path.normalize(path.join(root, rel));
  if(!fp.startsWith(path.normalize(root + path.sep)) && fp !== path.normalize(root)) return null;
  return fp;
}
/* The cap is an argument because one caller is not like the others: a
   history collected on another PC is a year of days, and refusing it at the
   size that protects every other route would be refusing the whole point
   of it. Everything else keeps the 50 MB it always had. */
function readBody(req, max){
  const cap = max && isFinite(max) ? max : 50 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if(n > cap){ reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/* ---- viewer login helpers ----
   The cookie carries a hash of the password rather than the password, so a
   screen that someone reads over the shoulder of gives nothing away, and it
   is derived rather than stored so it survives a restart without any state
   on disk. This guards a wall board behind one shared password; it is not
   trying to be a login system. */
function viewerToken(pw){
  return crypto.createHash('sha256').update('slh-viewer-v1:' + String(pw)).digest('hex').slice(0, 32);
}
function overHttps(req){
  // Fly terminates TLS in front, so the proxy's header is what knows
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto ? proto === 'https' : !!(req.socket && req.socket.encrypted);
}
/* the wall panel's own cookie, kept apart from the viewer one so clearing
   either does not take the other with it */
function quadToken(code){
  return crypto.createHash('sha256').update('slh-quad-v1:' + String(code)).digest('hex').slice(0, 24);
}
function quadCookie(req, code){
  return 'slhq=' + quadToken(code) + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax' +
    (overHttps(req) ? '; Secure' : '');
}
/* Escaping for the few pages this file draws itself - the login form, the
   deploy page. Module level, because more than one of them needs it. */
function esc(t){ return String(t == null ? "" : t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c])); }

/* Has this screen unlocked host view? (The cookie is still slhq, so a
   screen unlocked before this was called host view stays unlocked.) */
function hostViewOk(req, code){
  if(!code) return false;
  const want = quadToken(code);
  for(const bit of String(req.headers.cookie || '').split(';')){
    const i = bit.indexOf('=');
    if(i >= 0 && bit.slice(0, i).trim() === 'slhq' && bit.slice(i + 1).trim() === want) return true;
  }
  return false;
}
function viewerCookie(req, pw){
  return 'slh=' + viewerToken(pw) + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax' +
    (overHttps(req) ? '; Secure' : '');
}
/* the query string again without the named keys, so the address can be put
   back the way it was with the password taken out of it */
function cleanQuery(q, drop){
  const out = new URLSearchParams();
  for(const k in (q || {})) if(drop.indexOf(k) < 0) out.append(k, q[k]);
  const t = out.toString();
  return t ? '?' + t : '';
}
/* Where to go after logging in. Only somewhere on this site: a next= taken
   at face value is an open redirect, and this one arrives on a form. */
function safeNext(v){
  const t = String(v || '/');
  if(!t.startsWith('/') || t.startsWith('//')) return '/';
  return t;
}
function parseJson(buf){ try{ return JSON.parse(buf.toString('utf8') || 'null'); }catch(e){ return null; } }

/* Which of the Warehouse Task nodes is the one worth pulling.

   This monitor has several, and two of them are identical as far as a
   name goes: both called Warehouse Task, both under a parent called
   Warehouse Order. What tells them apart is further up. One hangs off a
   Wave, and a wave's warehouse order carries the picks that wave
   released - no loading, ever. The other hangs off the Outbound Delivery
   Order, which carries everything done for that delivery, loading
   included.

   So the path above the node is the whole decision, and it is the one
   thing somebody reading a flat list of nodes cannot see. */
function pickTaskNode(nodes){
  const by = {};
  nodes.forEach(n => { by[n.key] = n; });
  const chainOf = key => {
    const out = [];
    let p = by[key] && by[key].parent;
    let guard = 0;
    while(p && by[p] && guard++ < 14){ out.unshift(p); p = by[p].parent; }
    return out;
  };
  const list = nodes
    .filter(n => /task/i.test(n.text || '') && !/cartoniz/i.test(n.text || ''))
    .map(n => {
      const chain = chainOf(n.key);
      const pathText = chain.map(k => (by[k] && by[k].text) || k).concat(n.text || '').join(' > ');
      const low = pathText.toLowerCase();
      let score = 0;
      if(/^warehouse task$/i.test((n.text || '').trim())) score += 3;
      const parentKey = by[n.key] && by[n.key].parent;
      const parentText = (by[parentKey] && by[parentKey].text) || '';
      /* The one that returns everything is the plain task list straight
         under Documents. That is what the August pull used on Andrew's own
         PC, and it came back with internal moves, loading tasks,
         replenishment and putaway as well as picks.
         A task list reached through a Wave is the picks that wave released
         and can never contain a load. One under a delivery is narrower
         than the plain list too. */
      if(/^documents$/i.test(parentText.trim())) score += 5;
      if(low.indexOf('wave') >= 0) score -= 4;
      if(low.indexOf('inbound') >= 0) score -= 3;
      if(low.indexOf('delivery') >= 0) score -= 1;
      return { key: n.key, text: n.text || '', parentText: (by[parentKey] && by[parentKey].text) || '',
               path: pathText, chain, score };
    })
    .sort((a, b) => b.score - a.score);
  return { best: list[0] || null, list: list.slice(0, 10) };
}
function fmtLocal(ms){ if(!ms) return ''; const d = new Date(ms), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }

/* Adding a trimmed list of months back up. Everything here is a sum, except
   the head count, which is not: the same person picks in many months and a
   digest no longer holds the names. The host sends the counts it worked out
   for each range it offers, so this only runs for a range it did not send,
   and it says so with a null rather than a number that would be too high. */
function sumOf(list){
  let picks = 0, hours = 0, expected = 0, days = 0;
  (list || []).forEach(m => { picks += m.picks; hours += m.hours; expected += m.expected; days += m.days; });
  return { days, picks, hours: Math.round(hours * 10) / 10, expected: Math.round(expected), people: null,
           rate: hours > 0 ? Math.round((picks / hours) * 10) / 10 : null,
           pct: expected > 0 ? Math.round((picks / expected) * 100) : null };
}
module.exports = { Api, safeNext, viewerToken, cleanQuery, quadToken };
