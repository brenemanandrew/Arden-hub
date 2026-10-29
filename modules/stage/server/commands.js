'use strict';
/* Telling the host what to do from somewhere else.

   The host PC only ever talks outward - it pushes to the cloud copy and
   nothing can reach in - so "restart SAP" from a phone two states away has
   to ride on something the host already does. Two channels, one set of
   commands:

     - the cloud copy. Every push the host makes gets a reply; the reply now
       carries any commands somebody queued on the copy (from host view). The
       host runs them and reports back in its next push, so the copy can say
       what happened.

     - a folder. A folder the host can see that also syncs from somewhere the
       person is - a Google Drive folder, say. Drop a file called RESTART
       SAP.txt in it from a phone; the host sees it, does it, and renames the
       file to say what happened, which syncs back to the phone. No server in
       the middle, and it works when the cloud copy is the thing that is
       broken.

   The commands are few and blunt on purpose: put SAP back, start the
   service over, pull now, back up now. Nothing here changes a setting or
   reads data out; the settings live on the Admin page and the data has its
   own routes. What is left is the set of things a person would do standing
   at the PC, and would rather not drive in for. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/* what a command is called, what a file in the folder can be called to mean
   it, and what it does. The matcher is loose - "no update.txt", "No Update
   - restart.txt", "RESTART_SAP" all mean the same thing - because the person
   typing the name is on a phone. */
const COMMANDS = [
  { name: 'restart-sap',     lab: 'Restart SAP',          match: /^(restart[\s_-]*sap|no[\s_-]*update|sap[\s_-]*down)/i,
    run: (app, why) => app.sapwatch ? app.sapwatch.trigger(why, { force: true }) : { ok: false, why: 'no SAP recovery on this copy' } },
  { name: 'restart-service', lab: 'Restart the service',  match: /^restart[\s_-]*(service|app|host|program)/i,
    run: (app, why) => restartService(app, why) },
  { name: 'pull-now',        lab: 'Pull from SAP now',    match: /^pull[\s_-]*now/i,
    run: (app, why) => { if(!app.puller) return { ok: false, why: 'no puller on this copy' }; app.puller.pullNow(); return { ok: true, why: 'a cycle was started' }; } },
  { name: 'backup-now',      lab: 'Back up now',          match: /^back[\s_-]*up/i,
    run: (app, why) => { if(!app.backup) return { ok: false, why: 'no backups on this copy' }; const r = app.backup.run(why); return { ok: !!r.ok, why: r.ok ? (r.days + ' days of history, ' + Math.round(r.bytes / 1024) + ' KB') : r.error }; } }
];
const byName = n => COMMANDS.find(c => c.name === n);
const byFile = n => COMMANDS.find(c => c.match.test(String(n || '').replace(/\.[a-z0-9]+$/i, '').trim()));

/* Starting over is: start a new copy, which asks this one to stop (that is
   what a start does since the handover went in). If the new one never comes
   up, this one is still here - the failure mode is "nothing changed", not
   "nothing running". */
function restartService(app, why){
  const { APP_ROOT } = require('./config');
  const cmd = path.join(APP_ROOT, 'Start Staging Lane Health.cmd');
  if(process.platform !== 'win32' || !fs.existsSync(cmd)) return { ok: false, why: 'no Start Staging Lane Health.cmd beside the program' };
  try{
    spawn('cmd', ['/c', 'start', '', '/min', cmd], { cwd: APP_ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { ok: true, why: 'a new copy was started; it will take over from this one' };
  }catch(e){ return { ok: false, why: e.message }; }
}

const POLL_MS = 15000;
const SETTLE_MS = 3000;      // a file still being written is not a command yet

class Commands {
  constructor(app, log){
    this.app = app;
    this.log = log || (() => {});
    this.done = [];            // the last few, for the Admin page and the next push
    this.seen = new Set();     // cloud command ids already run
    this.timer = null;
  }
  list(){ return COMMANDS.map(c => ({ name: c.name, lab: c.lab })); }
  status(){ return { folder: this.folder() || '', done: this.done.slice(-10) }; }
  folder(){ const c = this.app.cfg.get().control || {}; return (c.dir && String(c.dir).trim()) || ''; }

  /* run one by name; every result is remembered and logged */
  run(name, why, from){
    const c = byName(name);
    if(!c) return this.note(name, { ok: false, why: 'no such command' }, why, from);
    let r;
    try{ r = c.run(this.app, why || (c.lab + ' asked for from ' + (from || 'afar'))) || { ok: true }; }
    catch(e){ r = { ok: false, why: e.message }; }
    return this.note(name, r, why, from);
  }
  note(name, r, why, from){
    const rec = { name, ok: !!r.ok, why: r.why || '', asked: why || '', from: from || '', at: Date.now() };
    this.done.push(rec); if(this.done.length > 20) this.done.shift();
    this.log('command ' + name + (from ? ' from ' + from : '') + ': ' + (rec.ok ? 'done' : 'refused') + (rec.why ? ' - ' + rec.why : ''), rec.ok ? 'info' : 'warn');
    try{ if(this.app.api) this.app.api.broadcast('status', this.app.api.statusPayload()); }catch(e){}
    return rec;
  }

  /* ---- the cloud channel -------------------------------------------- */
  /* commands that came back in a push reply: each once, by id */
  fromCloud(list){
    const acks = [];
    for(const c of (Array.isArray(list) ? list : [])){
      if(!c || !c.id || this.seen.has(c.id)) continue;
      this.seen.add(c.id);
      if(this.seen.size > 200) this.seen.delete(this.seen.values().next().value);
      const rec = this.run(c.name, c.lab ? (c.lab + ' asked for from the cloud copy') : '', 'the cloud copy' + (c.by ? ' (' + c.by + ')' : ''));
      acks.push({ id: c.id, name: c.name, ok: rec.ok, why: rec.why, at: rec.at });
    }
    if(acks.length) this.pendingAcks = (this.pendingAcks || []).concat(acks);
    return acks;
  }
  /* what the next push should carry, then forgotten - the copy keeps them */
  takeAcks(){ const a = this.pendingAcks || []; this.pendingAcks = []; return a; }

  /* ---- the folder channel --------------------------------------------- */
  start(){
    if(this.timer) return this;
    this.timer = setInterval(() => { try{ this.checkFolder(); }catch(e){ this.log('control folder: ' + e.message, 'warn'); } }, POLL_MS);
    if(this.timer.unref) this.timer.unref();
    return this;
  }
  stop(){ if(this.timer){ clearInterval(this.timer); this.timer = null; } }

  checkFolder(){
    const dir = this.folder();
    if(!dir) return;
    let names;
    try{ names = fs.readdirSync(dir); }catch(e){ return; }
    for(const n of names){
      if(/^done - /i.test(n) || /^\./.test(n) || /^~\$/.test(n)) continue;   // already answered, or Drive/Office scratch
      const c = byFile(n);
      if(!c) continue;
      const file = path.join(dir, n);
      let st; try{ st = fs.statSync(file); }catch(e){ continue; }
      if(!st.isFile()) continue;
      if(Date.now() - st.mtimeMs < SETTLE_MS) continue;          // still landing
      /* answer first, so a command is never run twice if the run itself
         takes the process down (restarting the service does exactly that) */
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
      const answered = path.join(dir, 'done - ' + n.replace(/\.[a-z0-9]+$/i, '') + ' ' + stamp + '.txt');
      try{ fs.renameSync(file, answered); }catch(e){ this.log('control folder: could not take ' + n + ': ' + e.message, 'warn'); continue; }
      const rec = this.run(c.name, c.lab + ' asked for by ' + n + ' in the control folder', 'the control folder');
      const lines = [
        c.lab + ' - ' + (rec.ok ? 'DONE' : 'REFUSED'),
        rec.why || '',
        '',
        'asked by: ' + n,
        'answered: ' + new Date(rec.at).toLocaleString() + ' by ' + (process.env.COMPUTERNAME || 'the host PC'),
        '',
        'Drop a new file in this folder to ask again. Names that work:',
        '  RESTART SAP.txt   (or NO UPDATE.txt)',
        '  RESTART SERVICE.txt',
        '  PULL NOW.txt',
        '  BACK UP.txt'
      ];
      try{ fs.writeFileSync(answered, lines.join('\r\n') + '\r\n'); }catch(e){}
    }
  }
}

module.exports = { Commands, COMMANDS, byFile, byName };
