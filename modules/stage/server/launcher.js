'use strict';
/* The two things the double-click needs that the server itself never did.

   People start this program the way they start anything else: by
   double-clicking it again. Before, that gave them a second copy which
   could not have the port, wrote "another copy may already be running" into
   a window nobody reads, and left the first one running - two copies pulling
   SAP, two pushing to the cloud. And the browser was opened by the .cmd
   file in the same breath as the service, so the board appeared before the
   service had read a thing: an empty board on a PC that was, at that moment,
   pulling a year of history down from the cloud copy.

   So: stop the old copy first, and open the board last, when there is
   something behind it. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const WAIT_MS = 15000;     // how long a copy is given to stop of its own accord
const POLL_MS = 400;

/* What the running copy wrote about itself when it came up. */
function record(cfg){
  try{ return JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'server.json'), 'utf8')); }
  catch(e){ return null; }
}

function ask(port, method, p, ms){
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: ms || 1500 }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function alive(pid){
  if(!pid) return false;
  try{ process.kill(pid, 0); return true; }
  catch(e){ return e.code === 'EPERM'; }     // there, but owned by somebody else
}

/* Is the thing on this port us? Asked rather than assumed, because a port
   number in a file is not proof: the old copy may be long gone and something
   else may have taken the port, and that something must never be stopped. */
async function ours(port){
  const r = await ask(port, 'GET', '/api/health');
  if(!r || r.code !== 200) return false;
  try{ const j = JSON.parse(r.body); return !!(j && j.ok && j.mode); }
  catch(e){ return false; }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/* Stop a copy of this program that is already running, politely, before the
   new one tries to bind anything. Returns what it did, for the log. */
async function stopOld(cfg, log){
  log = log || (() => {});
  const rec = record(cfg);
  const mine = cfg.get().port;
  if(rec && rec.pid === process.pid) return { stopped: false, why: 'the record is our own' };
  /* the port it says it had, and the port we are about to want - usually the
     same, but a copy left on another port is still a second copy pulling SAP */
  const ports = [];
  for(const p of [rec && rec.port, mine]) if(p && ports.indexOf(p) < 0) ports.push(p);

  const done = [];
  for(const port of ports){
    if(!await ours(port)) continue;
    log('a copy of this program is already running on port ' + port + '; asking it to stop');
    await ask(port, 'POST', '/api/shutdown');
    let gone = false;
    for(let waited = 0; waited < WAIT_MS; waited += POLL_MS){
      await wait(POLL_MS);
      if(!await ours(port)){ gone = true; break; }
    }
    if(gone){ log('the old copy has stopped'); done.push({ port, how: 'asked' }); continue; }
    /* It was ours - it answered as ours a moment ago - and it will not go.
       Only now, and only the process that wrote the record. */
    const pid = rec && rec.port === port ? rec.pid : null;
    if(pid && alive(pid)){
      log('the old copy did not stop when asked; closing it', 'warn');
      try{ process.kill(pid); }catch(e){ log('could not close it: ' + e.message, 'error'); }
      await wait(1200);
      done.push({ port, how: 'forced' });
    } else {
      log('a copy is running on port ' + port + ' and will not stop; this one may not be able to start', 'warn');
      done.push({ port, how: 'still there' });
    }
  }
  if(!done.length) return { stopped: false, why: 'nothing of ours was running' };
  return { stopped: true, what: done };
}

/* Open the home page, once the service is up and has its history. Windows
   only, because that is where the .cmd lives; anywhere else the address is
   printed and that is that. */
function openBoard(cfg, log){
  log = log || (() => {});
  if(process.env.SLH_NO_OPEN || (cfg.args && cfg.args.noOpen)) return false;
  if(process.platform !== 'win32') return false;
  const url = 'http://localhost:' + cfg.get().port + '/';
  try{
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log('opened the board at ' + url);
    return true;
  }catch(e){ log('could not open the board: ' + e.message + ' (open ' + url + ' by hand)', 'warn'); return false; }
}

/* ---- setting a new PC up from a file beside the program -------------

   Moving the host to another PC is meant to be: copy the folder, double
   click. The one thing the new PC cannot work out for itself is where the
   cloud copy is and the secret it shares with it - and until it knows that,
   it cannot pull the history either, so somebody has to type two things on
   the Admin page before the board means anything.

   So if a file called cloud.txt sits beside the program, it is read once and
   used for whatever this PC does not already have:

       url:    https://staging-lane-health.fly.dev
       secret: the-ingest-secret
       viewer password: what the TVs are given

   Nothing is overwritten - a PC that already knows its cloud copy keeps what
   it has - and the file is left where it is, so the same folder sets up the
   next PC too. It holds a secret in plain text, which is the trade: it is
   the same secret already sitting in this PC's config, so the file is worth
   exactly as much care as the folder it is in. */
const SEED = 'cloud.txt';

function readSeed(dir){
  let text;
  try{ text = fs.readFileSync(path.join(dir, SEED), 'utf8'); }catch(e){ return null; }
  const out = {};
  for(const raw of text.split(/\r?\n/)){
    const line = raw.trim();
    if(!line || line.startsWith('#') || line.startsWith(';')) continue;
    const cut = line.search(/[:=]/);
    if(cut < 0) continue;
    const key = line.slice(0, cut).trim().toLowerCase().replace(/[^a-z]/g, '');
    const val = line.slice(cut + 1).trim();
    if(!val) continue;
    if(key === 'url' || key === 'address' || key === 'cloud' || key === 'cloudurl') out.url = val;
    else if(key === 'secret' || key === 'key' || key === 'ingestsecret') out.secret = val;
    else if(key === 'viewerpassword' || key === 'password' || key === 'viewer') out.viewer = val;
  }
  return Object.keys(out).length ? out : null;
}

function seedFromFile(cfg, log){
  log = log || (() => {});
  const { APP_ROOT } = require('./config');
  const seed = readSeed(APP_ROOT);
  if(!seed) return { seeded: false, why: 'no ' + SEED + ' beside the program' };
  const v = cfg.get();
  const patch = {}, took = [];
  if(seed.url && !v.cloud.url){ patch.cloud = Object.assign({}, patch.cloud, { url: seed.url, enabled: true }); took.push('the cloud address'); }
  if(seed.secret && !v.cloud.secret){ patch.cloud = Object.assign({}, patch.cloud, { secret: seed.secret }); took.push('the ingest secret'); }
  if(seed.viewer && !v.auth.viewerPassword){ patch.auth = { viewerPassword: seed.viewer }; took.push('the viewer password'); }
  if(!took.length) return { seeded: false, why: SEED + ' is there, but this PC is already set up' };
  try{ cfg.update(patch); }
  catch(e){ log('setup file: ' + e.message, 'warn'); return { seeded: false, why: e.message }; }
  log('setup: took ' + took.join(' and ') + ' from ' + SEED);
  return { seeded: true, took };
}

module.exports = { stopOld, openBoard, record, ours, seedFromFile, readSeed, SEED };
