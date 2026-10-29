#!/usr/bin/env node
'use strict';
/* Arden Pack - the pack process on one screen.

   It reads the folder Staging Lane Health writes its SAP exports into
   and works out what the pack benches did with them: what went out of
   each bench, who was on it, how the day ran hour by hour, and what the
   order book looks like behind it.

   It drives nothing. One SAP session on the host, one driver, two
   readers - a second driver would fight the first over the same GUI,
   which is why the pack board used to live inside that service. If the
   exports stop arriving the answer is over there, and this says so
   rather than trying to fetch them itself.

     beside SAP     node server/main.js --report-dir "C:\\StagingLaneHealth"
     in the cloud   the same program, pointed at whatever folder it has

   A password is asked for only when one is set, so the same program is
   safe on the internet and quick on a laptop.
     PACK_PASSWORD=something   node server/main.js
*/
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Ingest, KINDS, dropName } = require('./ingest');
const winca = require('./winca');
const { Settings } = require('./settings');
const { Push } = require('./push');
const { resolveReportDir } = require('./reports');
const { PackHist } = require('./packhist');
const packmodel = require('./packmodel');
const value = require('./value');
const model = require('./model');

const WEB = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
               '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
/* Settings can sit in a file beside the program rather than on a command
   line, because the PC that runs this is started by somebody double
   clicking it. Lines are `name: value`, # is a comment. */
function fileSettings(){
  const out = {};
  for(const f of [path.join(__dirname, '..', 'pack.txt'), path.join(process.cwd(), 'pack.txt')]){
    let t = '';
    try{ t = fs.readFileSync(f, 'utf8'); }catch(e){ continue; }
    t.split(/\r?\n/).forEach(l => {
      const m = l.match(/^\s*([a-zA-Z]+)\s*[:=]\s*(.*?)\s*$/);
      if(m && !/^\s*#/.test(l)) out[m[1].toLowerCase()] = m[2];
    });
    break;
  }
  return out;
}
const FILE = fileSettings();
const REPORTS = resolveReportDir({
  said: argOf('--report-dir', ''), env: process.env, file: FILE
});
const CFG = {
  port: Number(argOf('--port', process.env.PORT || 8482)),
  /* the folder Staging Lane Health writes its exports into, asked for
     in order and able to say which answer it took */
  reports: REPORTS,
  reportDir: REPORTS.dir,
  /* where this program keeps the daily record it builds for itself */
  dataDir: argOf('--data-dir', process.env.PACK_DATA ||
    (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ArdenPack') : path.join(os.tmpdir(), 'ArdenPack'))),
  password: String(process.env.PACK_PASSWORD || argOf('--password', '')).trim(),
  /* the copy on the internet, and the key it answers to. Only the PC
     beside SAP sets these - it is the only one that can see the folder,
     so it is the one that does the telling. */
  pushUrl: String(process.env.PACK_PUSH_URL || argOf('--push', FILE.url || '')).trim().replace(/[/]+$/, ''),
  key: String(process.env.PACK_KEY || argOf('--key', FILE.key || '')).trim(),
  open: args.indexOf('--no-open') < 0
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* the day keys a range covers, counting back from its base - the same
   walk the board makes over its own stored days */
function daysBack(base, n){
  const out = [];
  if(!base) return out;
  const t = Date.UTC(+base.slice(0, 4), +base.slice(5, 7) - 1, +base.slice(8, 10));
  for(let i = 0; i < n; i++){
    const d = new Date(t - i * 86400000);
    out.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') +
             '-' + String(d.getUTCDate()).padStart(2, '0'));
  }
  return out;
}

fs.mkdirSync(CFG.dataDir, { recursive: true });
/* Where the Windows certificates get cached once they have been read, so a
   network that inspects HTTPS costs one PowerShell call a week rather than
   one every time this starts. */
winca.init(CFG.dataDir);
const settings = new Settings(path.join(CFG.dataDir, 'settings.json'), log);
const ingest = new Ingest(CFG.reportDir, log);
const packHist = new PackHist({ dataDir: CFG.dataDir }, log);
const push = new Push({ url: CFG.pushUrl, key: CFG.key, ingest }, log);

/* The model was written against the service it used to live in, so it is
   handed the same three things by the same names: somewhere to get rows,
   somewhere to get the day's rules, and a pull log to quote. There is no
   puller out here, so that last one is empty and the page has nothing to
   say about a pull - which is the truth. */
const app = {
  ingest,
  pickers: settings,
  packHist,
  puller: { tail: () => [] },
  cfg: { dataDir: CFG.dataDir },
  log
};

/* Keep the daily record in step with the folder. The export is a whole
   picture of today, so today is replaced on every read; an older day
   inside the window only lands if it holds more than what is stored. */
function observe(){
  const wh = ingest.fullRows('wh');
  if(!wh) return;
  try{
    const st = packmodel.settingsOf(app);
    const tasks = packmodel.readTasks(wh, st.lineKey, st.hideBins);
    if(tasks.ok) packHist.observe(packmodel.rollup(tasks, st.opt, st.sched), model.dayKey(new Date()));
  }catch(e){ log('pack history: ' + e.message); }
}

/* ---- the web side ------------------------------------------------------- */
const token = () => crypto.createHash('sha256').update('arden-pack|' + CFG.password).digest('hex').slice(0, 32);
function signedIn(req){
  if(!CFG.password) return true;
  return String(req.headers.cookie || '').split(';').some(c => c.trim() === 'pack=' + token());
}
function loginPage(msg){
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Arden Pack</title><style>' +
    'html,body{height:100%;margin:0;background:#0b0b0b;color:#fff;font:16px/1.4 "Segoe UI",system-ui,sans-serif;' +
    'display:flex;align-items:center;justify-content:center}form{width:min(92vw,420px);text-align:center}' +
    'h1{font-size:clamp(20px,3vw,30px);font-weight:800;letter-spacing:.06em;margin:0 0 6px}h1 b{color:#FFC000}' +
    'p{color:#c3c2b7;margin:0 0 20px}p.bad{color:#ff6b6b;font-weight:700}' +
    'input,button{font:inherit;font-size:clamp(16px,2vw,20px);width:100%;box-sizing:border-box;padding:14px 16px;' +
    'border-radius:9px;border:1px solid #3a3a3a;background:#1b1b1b;color:#fff}' +
    'button{margin-top:12px;background:#FFC000;color:#000;font-weight:800;border-color:#FFC000;cursor:pointer}' +
    '</style></head><body><form method="POST" action="/login"><h1>ARDEN <b>PACK</b></h1>' +
    (msg ? '<p class="bad">' + msg + '</p>' : '<p>Enter the viewer password.</p>') +
    '<input type="password" name="pw" autofocus placeholder="Password" enterkeyhint="go">' +
    '<button type="submit">Open the board</button></form></body></html>';
}
function send(res, code, type, body){
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, obj, code) => send(res, code || 200, MIME['.json'], JSON.stringify(obj));
function readBody(req, limit){
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if(n > (limit || 2e6)){ reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
/* an export arrives as the file itself, so this one keeps the bytes */
function readRaw(req, limit){
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if(n > (limit || 80e6)){ reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/* compared without leaking how much of it was right */
function sameKey(given){
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(CFG.key);
  return !!CFG.key && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  try{
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    const q = Object.fromEntries(u.searchParams);

    if(p === '/api/health') return json(res, { ok: true, v: ingest.version, feed: ingest.diag() });

    if(p === '/login'){
      if(req.method !== 'POST') return send(res, 200, MIME['.html'], loginPage());
      const body = await readBody(req, 4096);
      const given = decodeURIComponent((body.split('pw=')[1] || '').split('&')[0].replace(/\+/g, ' '));
      if(CFG.password && given === CFG.password){
        res.writeHead(302, { 'Set-Cookie': 'pack=' + token() + '; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly', 'Location': '/' });
        return res.end();
      }
      return send(res, 401, MIME['.html'], loginPage('That is not it. Try again.'));
    }
    /* The PC beside SAP comes in with a key rather than a password,
       because nobody is sitting there to type one. It is the one caller
       that is allowed through without signing in, and all it may do is
       hand over an export. */
    if(p === '/api/drop'){
      if(req.method !== 'POST') return json(res, { error: 'post an export here' }, 405);
      if(!sameKey(req.headers['x-pack-key'])){
        log('a drop arrived with the wrong key' + (CFG.key ? '' : ', and no key is set here'));
        return json(res, { error: 'bad key' }, 403);
      }
      const kind = String(req.headers['x-pack-kind'] || '').toLowerCase();
      const name = dropName(kind, req.headers['x-file-name']);
      if(!name) return json(res, { error: 'unknown kind' }, 400);
      let buf;
      try{ buf = await readRaw(req); }
      catch(e){ return json(res, { error: e.message }, 413); }
      if(!buf.length) return json(res, { error: 'empty' }, 400);
      try{
        fs.mkdirSync(CFG.reportDir, { recursive: true });
        /* written beside and moved into place, so a re-read never catches
           half a file */
        const dest = path.join(CFG.reportDir, name);
        const tmp = dest + '.part';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, dest);
      }catch(e){
        log('drop ' + name + ' failed: ' + e.message);
        return json(res, { error: e.message }, 500);
      }
      log('took ' + name + ' (' + kind + ', ' + buf.length + ' bytes) from the host');
      if(ingest.refresh()) observe();
      return json(res, { ok: true, feed: ingest.diag() });
    }

    if(!signedIn(req)) return send(res, 200, MIME['.html'], loginPage());

    /* The program itself, for download. The same zip that goes on the host
       PC by hand, put into this image by tools-deploy.cmd, so what this
       hands out is exactly the build the copy is running - it can never be
       older than what you are looking at.

       Behind the viewer password, like everything else here, and linked
       from nowhere: somebody is sent to it, they do not stumble into it. */
    if(p === '/deploy' || p.indexOf('/deploy/') === 0){
      const dir = path.join(__dirname, '..', 'deploy');
      let zips = [];
      try{ zips = fs.readdirSync(dir).filter(n => /^ArdenPack-[\w.-]+\.zip$/i.test(n)).sort(); }catch(e){}
      const newest = zips.length ? zips[zips.length - 1] : null;
      if(p.indexOf('/deploy/') === 0){
        const want = decodeURIComponent(p.slice(8));
        if(!newest || zips.indexOf(want) < 0) return json(res, { error: 'no such build here' }, 404);
        const file = path.join(dir, want);
        let st; try{ st = fs.statSync(file); }catch(e){ return json(res, { error: 'no such build here' }, 404); }
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': st.size,
                             'Content-Disposition': 'attachment; filename="' + want + '"' });
        return fs.createReadStream(file).pipe(res);
      }
      const e = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const mb = newest ? Math.round(fs.statSync(path.join(dir, newest)).size / 1048576 * 10) / 10 : 0;
      let build = ''; try{ build = fs.readFileSync(path.join(__dirname, '..', 'BUILD.txt'), 'utf8').trim(); }catch(err){}
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      /* Whoever opens this has been sent here to put the program on a PC and
         has probably never been told what it is. So: what it is, how to put
         it on, and the one step the zip cannot carry for them. */
      return res.end('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Arden Pack - the program</title>' +
        '<link rel="stylesheet" href="/web/board2.css"><style>' +
        '.wrap{max-width:760px;margin:0 auto;padding:22px 24px 44px}h1{font-size:23px;margin:0 0 6px}' +
        'h2{font-size:15px;margin:26px 0 8px;letter-spacing:.02em}' +
        'p{font-size:14px;color:var(--ink-2);line-height:1.6;margin:0 0 10px}.lede{font-size:15px}' +
        '.box{background:var(--tile);border:1px solid var(--ring);border-radius:8px;padding:16px 18px;margin:14px 0}' +
        '.put{display:block;margin:0 0 14px}.put:last-child{margin-bottom:0}.put b{color:var(--ink)}' +
        '.big{display:inline-block;font:inherit;font-weight:800;font-size:16px;padding:12px 18px;' +
        'border-radius:8px;background:var(--amber);color:#000;text-decoration:none}' +
        '.kv{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;font-size:14px}.kv b{color:var(--ink-2)}' +
        'code{font-size:12px}pre{background:var(--tile);border:1px solid var(--ring);border-radius:6px;' +
        'padding:10px 12px;font-size:12px;overflow:auto;margin:8px 0}</style></head><body>' +
        '<main class="wrap">' +
        '<h1>Arden Pack, ready to install</h1>' +
        '<p class="lede">This is the program itself, packaged for the one PC that sits beside SAP. ' +
        'If you only want to look at the board, you need nothing from this page.</p>' +

        '<div class="box">' + (newest
          ? '<div class="kv"><b>Build</b><span>' + e(build || newest.replace(/^ArdenPack-|\.zip$/g, '')) + '</span>' +
            '<b>File</b><span><code>' + e(newest) + '</code>, ' + mb + ' MB</span></div>' +
            '<p style="margin:14px 0 0"><a class="big" href="/deploy/' + encodeURIComponent(newest) + '">Download ' + e(newest) + '</a></p>' +
            '<p style="margin:10px 0 0">This is the build this copy is running right now, so it is never older than what you are looking at.</p>'
          : '<p><b>No build is staged here.</b> Deploying with <code>tools-deploy.cmd</code> builds the zip and puts it in the image; ' +
            'a plain <code>fly deploy</code> leaves this page with nothing to hand out.</p>') + '</div>' +

        '<h2>What it is</h2>' +
        '<p>Arden Pack reads the SAP exports Staging Lane Health already writes, and shows the pack end of the building: ' +
        'what the benches sent out, who was on them, and what came in. It drives no SAP session of its own - ' +
        'one session on the host, one driver, two readers.</p>' +
        '<p>The zip above is that program with everything inside it, Node included. Nothing to install, no database.</p>' +

        '<h2>Putting it on the PC</h2>' +
        '<div class="box">' +
        '<p class="put"><b>It has to be the Staging Lane Health host.</b> That is the PC with the export folder on it. ' +
        'Arden Pack finds the folder by asking Staging Lane Health where it writes, so on any other machine it has nothing to read.</p>' +
        '<p class="put"><b>A PC that has never run it.</b> Unzip anywhere and double-click <b>Start Arden Pack.cmd</b>. ' +
        'Then open <code>http://localhost:8482/</code>.</p>' +
        '<p class="put"><b>A PC already running it.</b> Close the black window, unzip this over what is there, start it again. ' +
        'Nothing is lost: the settings and the daily record live in <code>%LOCALAPPDATA%\\ArdenPack</code>, not in that folder.</p>' +
        '</div>' +

        '<h2>The one step the zip cannot do for you</h2>' +
        '<p>The key is deliberately left out of the download, so it never travels in a file anyone might forward. ' +
        'Make a file called <b>pack.txt</b> beside <code>Start Arden Pack.cmd</code>, holding two lines:</p>' +
        '<pre>url: https://ardenpack.fly.dev\nkey: &lt;the pack key&gt;</pre>' +
        '<p>Without it the board still works perfectly on that PC and this copy stays empty for ever, ' +
        'which is the most confusing way this can go wrong - nothing looks broken. ' +
        'Watch that Notepad does not save it as <code>pack.txt.txt</code>.</p>' +

        '<h2>Checking it worked</h2>' +
        '<p>The window prints what it decided. The line to read is the second one - the folder it settled on, ' +
        'and which answer told it. Then open <code>/api/health</code> here: once the host is sending, ' +
        'the version climbs past 1 and the files show real row counts.</p>' +
        '</main></body></html>');
    }

    if(p === '/api/pack'){
      /* days back from a base day, an offset for yesterday, a shift by
         name - the same vocabulary the picker page uses next door */
      const days = Math.max(1, Math.min(400, parseInt(q.days, 10) || 1));
      const off = Math.max(0, Math.min(400, parseInt(q.offset, 10) || 0));
      const sh = String(q.shift || '');
      const base = model.dayKey(new Date(Date.now() - off * 86400000));
      const want = { days, base, offset: off, shift: (sh && sh !== 'all') ? sh : null };
      const out = packmodel.build(app, want);
      /* The money is worked out beside the board rather than inside it:
         it comes from a different system, over a join the warehouse
         exports know nothing about, and it must never be able to take
         the board down with it. */
      try{
        const st = packmodel.settingsOf(app);
        out.value = value.compute(app, {
          keys: daysBack(base, days), shift: want.shift, sched: st.sched,
          live: days === 1 && !off
        });
      }catch(e){ out.value = { shipped: { ok: false, why: e.message }, pick: { ok: false, why: e.message } }; }
      return json(res, out);
    }
    if(p === '/api/pack/columns') return json(res, packmodel.probeColumns(app));
    if(p === '/api/pack/bridge') return json(res, packmodel.probeBridge(app));
    /* the same reading of any one export, which is how a question like
       'is there a value in here' gets answered rather than argued about */
    if(p === '/api/pack/profile'){
      const kind = String(q.kind || 'orders').toLowerCase();
      if(!KINDS[kind]) return json(res, { ok: false, why: 'there is no export called that' }, 400);
      return json(res, packmodel.probeExport(app, kind));
    }
    if(p === '/api/settings'){
      if(req.method === 'POST'){
        let v = null;
        try{ v = JSON.parse(await readBody(req, 65536)); }catch(e){ return json(res, { error: 'bad json' }, 400); }
        settings.set(v);
        ingest.version++;        // the rules changed, so every answer is new
        observe();
        return json(res, { ok: true, settings: settings.values });
      }
      /* scheduleText is the week actually in force: blank settings mean
         the built-in one, and a page that showed only the blank would be
         telling the reader there are no shifts */
      let scheduleText = '';
      try{ scheduleText = settings.settings().scheduleText || ''; }catch(e){}
      return json(res, { settings: settings.values, feed: ingest.diag(),
                         reportDir: CFG.reportDir, scheduleText });
    }
    if(p === '/api/reread'){ ingest.refresh(); observe(); return json(res, { ok: true, feed: ingest.diag() }); }
    /* The board redraws when the folder moves rather than on a timer, so
       a new export is on the screen within seconds of landing. */
    if(p === '/api/events'){
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const NL = String.fromCharCode(10);
      res.write('retry: 4000' + NL + NL);
      let seen = ingest.version;
      const tick = setInterval(() => {
        if(ingest.version !== seen){
          seen = ingest.version;
          res.write('event: data' + NL + 'data: ' + seen + NL + NL);
        } else res.write(': ping' + NL + NL);
      }, 5000);
      req.on('close', () => clearInterval(tick));
      return;
    }

    if(p === '/' || p === '/index.html' || p === '/pack') return serveFile(res, path.join(WEB, 'pack.html'));
    if(p === '/admin' || p === '/settings') return serveFile(res, path.join(WEB, 'admin.html'));
    if(p.startsWith('/web/')) return serveFile(res, path.join(WEB, p.slice(5)));

    return send(res, 404, 'text/plain; charset=utf-8', 'not here');
  }catch(e){
    log('error: ' + (e && e.stack || e));
    if(!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'server error: ' + (e && e.message));
  }
});

function serveFile(res, file){
  fs.readFile(file, (err, buf) => {
    if(err) return send(res, 404, 'text/plain; charset=utf-8', 'not here');
    send(res, 200, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', buf);
  });
}

server.listen(CFG.port, process.env.PACK_HOST || '0.0.0.0', () => {
  log('Arden Pack listening on ' + CFG.port);
  log('reading ' + CFG.reportDir + '  (' + CFG.reports.why + ')');
  log('keeping its daily record in ' + CFG.dataDir);
  if(!CFG.password) log('no viewer password set (PACK_PASSWORD), so the board is open');
  if(push.on) log('sending what it reads to ' + CFG.pushUrl);
  else if(CFG.pushUrl) log('a push address is set but no key, so nothing is being sent');
  else if(CFG.key) log('holding a key, so the host may send exports here');
  ingest.start();
  observe();
  push.start();
  /* the folder moves when the host writes a new export; the record
     follows it rather than waiting to be asked */
  setInterval(() => { if(ingest.refresh()) observe(); }, 20000).unref();
  if(CFG.open && process.platform === 'win32'){
    try{ require('child_process').exec('start "" http://localhost:' + CFG.port + '/'); }catch(e){}
  }
});

process.on('SIGINT', () => { try{ packHist.save(); }catch(e){} process.exit(0); });
process.on('SIGTERM', () => { try{ packHist.save(); }catch(e){} process.exit(0); });
