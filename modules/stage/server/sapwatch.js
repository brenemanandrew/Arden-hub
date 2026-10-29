'use strict';
/* Putting SAP back on its feet, without anybody walking over to the PC.

   The host PC drives SAP by attaching to a SAP GUI that somebody logged in
   to. When that session dies - SAP crashes, the network drops it, somebody
   closes the window, a patch restarts it - the board stops moving and stays
   stopped until a person notices. On a night shift that can be the whole
   shift.

   So: when SAP stops answering, or the board has had nothing fresh for ten
   minutes, this closes what is left of SAP and opens it again the way a
   person would - through the Okta tile, which downloads a SAP GUI shortcut
   that logs itself in - then waits for the session to be scriptable and
   lets the puller carry on.

   What it will not do:

     - it will not type a password. The Okta tile works on the host PC
       because that PC is already signed in; if Okta wants a password or a
       push approval, recovery stops there and says so. Automating past that
       would mean holding the credentials, and this program does not.
     - it will not close SAP unless it has a way to open it again. Killing a
       session nobody can restore leaves the PC worse off than the crash
       did, so the whole thing is refused when the Okta link is missing.
     - it will not loop. Three attempts an hour, and each one has to see SAP
       come back before the next is allowed.

   Everything it does is written to the pull log, because a recovery that
   happened quietly is indistinguishable from a recovery that did not. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/* How long a shortcut Okta downloaded is worth trying again. Okta reissues
   these, so an old one is a dead end rather than a slow one; this is only
   meant to catch the case where SAP falls over twice in the same stretch.
   Setting it to 0 turns the reuse off and always goes through the tile. */
const SHORTCUT_HOURS = 2;
const DEFAULTS = {
  enabled: true,
  staleMin: 10,              // nothing fresh for this long is a dead session
  maxPerHour: 3,
  waitDownloadSec: 120,      // for the browser to fetch the shortcut
  waitReadySec: 240,         // for SAP to come up and be scriptable
  settleSec: 8,              // after the kill, before the relaunch
  clickSec: 25,              // how long to look for a button the page is waiting on
  clickNames: '',            // extra button names, comma separated; blank = the usual ones
  shortcutHours: SHORTCUT_HOURS,   // how old a downloaded shortcut may be before it is ignored
  shortcutReadySec: 75,      // and how long to humour one before going to the tile instead
  kill: ['saplogon', 'sapgui', 'sapshcut', 'sapguihelper'],
  shortcutExt: /\.(sap|sapshortcut)$/i
};

const wait = ms => new Promise(r => setTimeout(r, ms));
const WARN_EVERY_MS = 3600000;               // how often to repeat the "no way back in" line

/* A script file rather than a one-liner, and without blocking the service
   while it runs: this one waits on a browser, and spawnSync would stop the
   board answering anybody for the whole of that wait. */
function psFile(file, args, ms){
  return new Promise(resolve => {
    let out = '', done = false;
    let child;
    try{
      child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file].concat(args || []),
        { windowsHide: true });
    }catch(e){ return resolve({ code: -1, out: 'ERROR ' + e.message }); }
    const t = setTimeout(() => { if(!done){ try{ child.kill(); }catch(e){} } }, ms || 90000);
    const take = d => { out += d.toString('utf8'); if(out.length > 8000) out = out.slice(-8000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', e => { if(done) return; done = true; clearTimeout(t); resolve({ code: -1, out: 'ERROR ' + e.message }); });
    child.on('exit', code => { if(done) return; done = true; clearTimeout(t); resolve({ code, out: out.trim() }); });
  });
}

function ps(script, ms){
  try{
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: ms || 20000, windowsHide: true });
    return ((r.stdout || '') + (r.stderr || '')).trim();
  }catch(e){ return 'ERROR ' + e.message; }
}

/* the newest shortcut the browser has dropped, and when */
function newestShortcut(dir, re){
  let best = null;
  try{
    for(const n of fs.readdirSync(dir)){
      if(!re.test(n)) continue;
      const p = path.join(dir, n);
      let st; try{ st = fs.statSync(p); }catch(e){ continue; }
      if(!st.isFile()) continue;
      if(!best || st.mtimeMs > best.at) best = { file: p, name: n, at: st.mtimeMs };
    }
  }catch(e){}
  return best;
}

class SapWatch {
  constructor(app, log){
    this.app = app;
    this.logFn = log || (() => {});
    this.busy = false;
    this.runs = [];                 // when recoveries were attempted, for the cap
    this.st = { last: null, lastError: '', attempts: 0, running: false, why: '' };
    this.timer = null;
    this.since = Date.now();     // nothing has succeeded yet, so time runs from here
  }
  cfg(){
    const c = (this.app.cfg.get().pull || {}).recover || {};
    return Object.assign({}, DEFAULTS, c, {
      kill: (Array.isArray(c.kill) && c.kill.length) ? c.kill : DEFAULTS.kill,
      downloadDir: (c.downloadDir && String(c.downloadDir).trim()) || path.join(os.homedir(), 'Downloads')
    });
  }
  log(m, level){ this.logFn('recovery: ' + m, level); if(this.app.puller) this.app.puller.log('recovery: ' + m, level); }
  status(){
    const c = this.cfg();
    return Object.assign({}, this.st, { enabled: !!c.enabled, staleMin: c.staleMin, ready: this.canRelaunch(), oktaUrl: c.oktaUrl || '' });
  }

  /* A shortcut we can open without a browser: one set by hand on the Admin
     page, or the last one Okta downloaded.

     Okta reissues these, so the downloaded one is a short-lived thing, not
     a way round the tile. It is worth one quick try when SAP falls over
     again soon after a recovery, and nothing more than that - which is why
     it has both an age limit and, in recover(), a much shorter wait before
     the tile is opened anyway. */
  savedShortcut(c){
    c = c || this.cfg();
    if(c.shortcut && fs.existsSync(c.shortcut)) return { file: c.shortcut, how: 'the saved shortcut ' + path.basename(c.shortcut) };
    const hours = c.shortcutHours != null ? +c.shortcutHours : SHORTCUT_HOURS;
    if(c.lastShortcut && hours > 0){
      let st; try{ st = fs.statSync(c.lastShortcut); }catch(e){ st = null; }
      if(st && st.isFile() && Date.now() - st.mtimeMs < hours * 3600000){
        return { file: c.lastShortcut, how: 'the shortcut from the last recovery (' + path.basename(c.lastShortcut) + ')', reused: true };
      }
    }
    return null;
  }
  /* A reused shortcut that did not work is not worth keeping: Okta will
     have made a new one by the next time this runs. */
  forgetShortcut(){
    try{ this.app.cfg.update({ pull: { recover: { lastShortcut: '' } } }); }catch(e){}
  }
  /* Is there a way back in? Without one, closing SAP is vandalism. */
  canRelaunch(){
    const c = this.cfg();
    if(c.oktaUrl && /^https?:\/\//i.test(c.oktaUrl)) return true;
    return !!this.savedShortcut(c);
  }

  /* ---- watching ------------------------------------------------------- */
  start(){
    if(this.timer || process.platform !== 'win32') return this;
    this.timer = setInterval(() => { try{ this.check(); }catch(e){ this.log('check failed: ' + e.message, 'warn'); } }, 60000);
    if(this.timer.unref) this.timer.unref();
    return this;
  }
  stop(){ if(this.timer){ clearInterval(this.timer); this.timer = null; } }

  /* The board has had nothing new for a while. That is not the same as SAP
     saying it is gone - a session can sit there answering while the exports
     quietly stop - so it is worth its own test. */
  check(){
    const p = this.app.puller;
    const c = this.cfg();
    if(!c.enabled || !p) return;
    const ps = p.status();
    if(!ps.enabled || ps.stopped || ps.held || ps.standby || ps.running) return;
    if(this.app.backfill && this.app.backfill.status().running) return;
    /* the clock runs from the last cycle that worked; until one has, from
        when the service started, so a host that comes up to a dead SAP is
        recovered too rather than waiting for a success that never comes */
    const last = ps.lastOkAt || this.since;
    if(!last) return;
    const mins = (Date.now() - last) / 60000;
    if(mins < c.staleMin) return;
    this.trigger('nothing fresh from SAP for ' + Math.round(mins) + ' minutes');
  }

  /* opt.force: a person asked, so the hourly limit does not apply - the
     limit is there to stop the watch looping, not to stop a supervisor */
  trigger(why, opt){
    opt = opt || {};
    if(this.busy) return { ok: false, why: 'a recovery is already running' };
    const c = this.cfg();
    if(!c.enabled) return { ok: false, why: 'recovery is turned off' };
    if(this.app.backfill && this.app.backfill.status().running) return { ok: false, why: 'a backfill is running' };
    if(!this.canRelaunch()){
      /* Once per process was too quiet: an outage on Thursday left nothing
         in Thursday's log because the line had been used up on Monday. */
      if(!this.warned || Date.now() - this.warned > WARN_EVERY_MS){
        this.warned = Date.now();
        this.log('SAP needs restarting but there is no way to open it again - set the Okta app link on the Admin page. SAP has been left alone.', 'warn');
      }
      return { ok: false, why: 'no Okta link and no saved shortcut; SAP left alone' };
    }
    const hour = Date.now() - 3600000;
    this.runs = this.runs.filter(t => t > hour);
    if(!opt.force && this.runs.length >= c.maxPerHour){
      this.log('SAP is still not answering, but ' + this.runs.length + ' restarts have already been tried this hour; leaving it for a person', 'warn');
      return { ok: false, why: 'the hourly limit has been reached' };
    }
    this.runs.push(Date.now());
    this.recover(why).catch(e => this.log('failed: ' + e.message, 'error'));
    return { ok: true };
  }

  /* ---- the recovery itself -------------------------------------------- */
  async recover(why){
    const c = this.cfg();
    this.busy = true;
    this.st.running = true; this.st.why = why; this.st.attempts++;
    const started = Date.now();
    const step = {};
    this.log('starting because ' + why);
    this.broadcast();
    try{
      /* the puller is told to stand still: a cycle that attaches to a SAP
         that is being killed is a cycle that hangs */
      const p = this.app.puller;
      const wasStopped = p ? p.status().stopped : true;
      if(p){ p.kill('SAP is being restarted'); p.stop(); }

      step.killed = this.killSap(c);
      this.log(step.killed.length ? ('closed ' + step.killed.join(', ')) : 'nothing of SAP was still running');
      await wait(c.settleSec * 1000);

      step.opened = await this.relaunch(c);
      if(!step.opened.ok){
        this.st.lastError = step.opened.why;
        this.log('could not open SAP again: ' + step.opened.why, 'error');
        return;
      }
      this.log('opened ' + step.opened.how);

      /* A shortcut is given a short leash. Okta reissues them, so one that
         has been superseded will not sign itself in, and waiting the full
         four minutes to find that out spends the outage on a dead file. */
      const viaShortcut = !!step.opened.viaShortcut;
      const canTile = !!(c.oktaUrl && /^https?:\/\//i.test(c.oktaUrl));
      let ready = await this.waitReady(c, (viaShortcut && canTile) ? c.shortcutReadySec : 0);
      if(!ready.ok && viaShortcut && canTile){
        this.log('that shortcut did not bring SAP back, so it has been thrown away; going through the Okta tile instead', 'warn');
        if(step.opened.reused) this.forgetShortcut();
        this.killSap(c);
        await wait(c.settleSec * 1000);
        const again = await this.relaunch(c, { skipShortcut: true });
        if(again.ok){ this.log('opened ' + again.how); ready = await this.waitReady(c); }
        else this.log('could not open SAP through Okta either: ' + again.why, 'error');
      }
      this.st.lastError = ready.ok ? '' : ready.why;
      if(ready.ok) this.log('SAP is answering again after ' + Math.round((Date.now() - started) / 1000) + 's');
      else this.log('SAP did not come back: ' + ready.why, 'error');

      /* pulling resumes either way: if SAP is up the next cycle works, and
         if it is not the ordinary error path reports it as it always did */
      if(p && !wasStopped) p.start();
    } finally {
      this.st.last = { at: Date.now(), why, ok: !this.st.lastError, took: Date.now() - started };
      this.st.running = false;
      this.busy = false;
      this.broadcast();
    }
  }
  broadcast(){ try{ if(this.app.api) this.app.api.broadcast('status', this.app.api.statusPayload()); }catch(e){} }

  /* Close what is left of SAP. By process name, and only the SAP GUI ones -
     nothing here touches a server process or anybody's documents. */
  killSap(c){
    const names = c.kill.map(n => String(n).replace(/[^\w.\-]/g, '')).filter(Boolean);
    if(!names.length) return [];
    const list = names.map(n => "'" + n + "'").join(',');
    const out = ps('$n=@(' + list + '); $got=@(); foreach($p in Get-Process -Name $n -ErrorAction SilentlyContinue){ try{ $p.Kill(); $got += $p.ProcessName }catch{} }; if($got){ $got -join "," }', 20000);
    return out && !/^ERROR/.test(out) ? Array.from(new Set(out.split(',').map(s => s.trim()).filter(Boolean))) : [];
  }

  /* Open SAP again. The quick way is a shortcut we already have; otherwise
     the Okta tile, which is what a person would click. */
  async relaunch(c, opt){
    opt = opt || {};
    if(!opt.skipShortcut){
      const s = this.savedShortcut(c);
      if(s){ this.open(s.file); return { ok: true, how: s.how, viaShortcut: true, reused: !!s.reused }; }
    }
    if(!(c.oktaUrl && /^https?:\/\//i.test(c.oktaUrl))) return { ok: false, why: 'no Okta app link is set' };

    const before = newestShortcut(c.downloadDir, c.shortcutExt);
    this.log('opening the Okta tile; watching ' + c.downloadDir + ' for the shortcut it downloads');
    this.open(c.oktaUrl);
    /* give the page a moment to be a page, then press whatever it is
       waiting on. A failure here is not a failure of the recovery: the
       shortcut may well arrive without any of it. */
    await wait(4000);
    try{ await this.pressLogin(c); }catch(e){ this.log('could not press the page: ' + e.message, 'warn'); }

    const until = Date.now() + c.waitDownloadSec * 1000;
    let found = null;
    while(Date.now() < until){
      await wait(2000);
      const now = newestShortcut(c.downloadDir, c.shortcutExt);
      /* newer than whatever was there when we started, and finished writing */
      if(now && (!before || now.at > before.at + 500) && Date.now() - now.at > 1500){ found = now; break; }
    }
    if(!found) return { ok: false, why: 'no SAP shortcut appeared in ' + c.downloadDir + ' within ' + c.waitDownloadSec + 's. If Okta asked for a password or a push, nobody can answer that from here; if it was waiting on a button, the log above lists the ones it could see.' };
    this.open(found.file);
    /* remembered, so the next recovery can skip the browser entirely if the
       shortcut is still good */
    try{ this.app.cfg.update({ pull: { recover: { lastShortcut: found.file } } }); }catch(e){}
    return { ok: true, how: 'the shortcut Okta downloaded (' + found.name + ')' };
  }

  /* The Okta tile usually launches on its own. When it does not, what is in
     the way is a single Sign in button on a page that is otherwise ready -
     nothing that needs a password, just a click nobody is there to make. So
     make it. Whatever happens goes in the pull log, including every button
     the page was offering, because that is the only way to find out what a
     page looked like at two in the morning. */
  async pressLogin(c){
    const script = path.join(__dirname, 'sap', 'click.ps1');
    if(!fs.existsSync(script)) return false;
    let hint = 'okta';
    try{ hint = new URL(c.oktaUrl).hostname.split('.')[0] || 'okta'; }catch(e){}
    const args = ['-WaitSec', String(Math.max(3, c.clickSec || 25)), '-TitleHint', hint];
    if(String(c.clickNames || '').trim()) args.push('-Names', String(c.clickNames).trim());
    const r = await psFile(script, args, (Math.max(3, c.clickSec || 25) + 20) * 1000);
    String(r.out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .forEach(line => this.log(line, /^pressed /.test(line) ? 'info' : 'warn'));
    return r.code === 0;
  }

  open(target){
    try{ spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
    catch(e){ this.log('could not open ' + target + ': ' + e.message, 'warn'); }
  }

  /* SAP is back when the driver's own probe can attach and find a session -
     the same test every pull cycle starts with, so "ready" here means
     ready for the thing that comes next. */
  async waitReady(c, secs){
    const p = this.app.puller;
    if(!p || !p.runOnce) return { ok: false, why: 'no driver' };
    const budget = secs > 0 ? secs : c.waitReadySec;
    const until = Date.now() + budget * 1000;
    let last = '';
    while(Date.now() < until){
      await wait(10000);
      let r;
      try{ r = await p.runOnce('probe', {}, 60000); }
      catch(e){ r = { ok: false, error: e.message }; }
      if(r && r.ok) return { ok: true };
      last = (r && (r.error || r.note)) || ('the driver answered ' + (r && r.code));
    }
    return { ok: false, why: 'gave up after ' + budget + 's (' + last + ')' };
  }
}

module.exports = { SapWatch, DEFAULTS };
