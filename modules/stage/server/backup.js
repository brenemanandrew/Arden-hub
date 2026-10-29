'use strict';
/* The data folder, backed up by the app itself.

   What is in the data folder is the only thing about this app that cannot
   be got again: the picker history, and in it the year the one-time
   backfill collected, which SAP will not hand over a second time once it
   has aged those months out. So the app takes the copy rather than waiting
   for somebody to remember to.

   Where it goes. To the cloud copy, sealed, which is the route that needs
   nothing set up on the host PC beyond the address and secret it already
   has - and to a folder on this PC, which is the data folder unless
   somebody typed somewhere else on the Admin page.

   When. A few minutes after every shift ends; the moment SAP stops
   answering; when the service is stopping, which is the copy that exists if
   the PC does not come back; when a backfill has just written months that
   SAP will not hand over twice; before anything is restored over what is
   here; every twelve hours if none of those has happened; and on request.

   And the other direction. Every start asks whether anything holds more
   history than this PC does, and takes it if so, merged - which is what
   makes moving the host a matter of starting it somewhere else. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zipfile = require('./zipfile');
const { deepMerge } = require('./config');

const KEEP = 30;                       // backups left in the folder; two or three a day, so a week or two
const MIN_GAP_MS = 5 * 60000;          // between automatic backups, so a flapping SAP does not write one a minute
const SKIP_DIRS = ['logs', 'backfill', 'backups', 'node_modules'];   // never in a backup: bulky, temporary, or the backups themselves

function stamp(d){ const p = n => String(n).padStart(2, '0'); d = d || new Date(); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); }
function isBackupName(n){ return /^SLH-data-.*\.zip$/i.test(n); }

/* ---- finding the folders ---------------------------------------------- */
class Backup {
  constructor(app, log){
    this.app = app;
    this.log = log || (() => {});
    this.st = { last: null, lastError: '', lastAuto: 0, restored: null, where: null };
    this.locateAt = 0;
    this.located = null;
  }
  cfg(){ return (this.app.cfg.get().backup) || {}; }
  /* Where the copy on disk goes. Every backup also goes to the cloud copy,
     which is the route that needs nothing set up; this is the one on this
     PC. By default a folder inside the data folder - always there, always
     writable. A path typed on the Admin page is used instead, for anyone who
     wants them on a share or a second drive. */
  locate(force){
    const c = this.cfg();
    const pick = (typed, fallback) => {
      const p = typed && String(typed).trim();
      if(p){
        const there = fs.existsSync(p);
        return { dir: p, ok: there, how: there ? 'set on the Admin page' : 'set on the Admin page, but that folder does not exist' };
      }
      return { dir: fallback, ok: !!fallback, how: fallback ? 'kept on this PC, and sent to the cloud copy' : 'not set' };
    };
    this.located = {
      backups: pick(c.dir, path.join(this.app.cfg.dataDir, 'backups')),
      reports: pick(c.reportsDir, null)
    };
    this.st.where = { backups: this.located.backups, reports: this.located.reports };
    return this.located;
  }
  backupsDir(){ return this.locate().backups.dir; }
  reportsDir(){ const r = this.locate().reports; return (r && r.ok) ? r.dir : null; }

  /* ---- taking one -------------------------------------------------------- */
  /* Every file under the data folder except the bulky and the temporary,
     as one zip, checked by opening it again before it is called done. */
  bundle(){
    const root = this.app.cfg.dataDir;
    const entries = [];
    const walk = (dir, rel) => {
      let names;
      try{ names = fs.readdirSync(dir, { withFileTypes: true }); }catch(e){ return; }
      for(const d of names){
        const r = rel ? rel + '/' + d.name : d.name;
        if(d.isDirectory()){
          if(SKIP_DIRS.indexOf(d.name.toLowerCase()) >= 0 && !rel) continue;
          walk(path.join(dir, d.name), r);
        } else if(d.isFile()){
          if(/\.log$/i.test(d.name) || d.name === 'cloud-last.enc') continue;
          try{ entries.push({ name: 'StagingLaneHealth/' + r, data: fs.readFileSync(path.join(dir, d.name)), mtime: fs.statSync(path.join(dir, d.name)).mtime }); }catch(e){}
        }
      }
    };
    walk(root, '');
    return entries;
  }
  daysIn(entries){
    const h = entries.find(e => /pickers\/history\.json$/.test(e.name));
    if(!h) return 0;
    try{ return Object.keys(JSON.parse(h.data.toString('utf8').replace(/^﻿/, ''))).length; }catch(e){ return -1; }
  }
  run(reason, opt){
    opt = opt || {};
    const now = Date.now();
    if(opt.auto && now - this.st.lastAuto < MIN_GAP_MS) return { ok: false, skipped: true, error: 'a backup was taken less than five minutes ago' };
    const where = this.locate(true).backups;
    const dir = where.dir;
    try{
      fs.mkdirSync(dir, { recursive: true });
      const entries = this.bundle();
      if(!entries.length) throw new Error('the data folder is empty');
      const bytes = zipfile.write(entries);
      /* open it again before believing it: a backup that cannot be read is
         worse than none, because somebody will rely on it */
      const back = zipfile.read(bytes);
      const days = this.daysIn(back);
      if(days < 0) throw new Error('the history inside the finished zip would not parse');
      const name = 'SLH-data-' + os.hostname() + '-' + stamp() + '.zip';
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      this.prune(dir);
      this.st.last = { at: now, file, name, bytes: bytes.length, days, reason, where: where.how };
      /* and up to the copy, so the next PC can ask for it there */
      const sent = (this.app.cloud && this.app.cloud.sendBackup) ? this.app.cloud.sendBackup(file, { name, days, at: now }) : null;
      this.st.lastError = '';
      if(opt.auto) this.st.lastAuto = now;
      this.log('backup: ' + name + ' (' + days + ' days of history, ' + Math.round(bytes.length / 1024) + ' KB) - ' + reason +
        (where.ok ? '' : '. NOTE: ' + where.how), where.ok ? 'info' : 'warn');
      return { ok: true, file, name, days, bytes: bytes.length, where: where.how, sent };
    }catch(e){
      this.st.lastError = e.message;
      this.log('backup failed (' + reason + '): ' + e.message, 'error');
      return { ok: false, error: e.message };
    }
  }
  prune(dir){
    try{
      const zips = fs.readdirSync(dir).filter(isBackupName).map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
      zips.slice(KEEP).forEach(z => { try{ fs.unlinkSync(path.join(dir, z.n)); }catch(e){} });
    }catch(e){}
  }
  newest(dir){
    try{
      const zips = fs.readdirSync(dir).filter(isBackupName).map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
      return zips.length ? path.join(dir, zips[0].n) : null;
    }catch(e){ return null; }
  }
  list(){
    const dir = this.backupsDir();
    try{
      return fs.readdirSync(dir).filter(isBackupName).map(n => { const s = fs.statSync(path.join(dir, n)); return { name: n, at: s.mtimeMs, bytes: s.size }; }).sort((a, b) => b.at - a.at);
    }catch(e){ return []; }
  }
  status(){
    const w = this.locate();
    return { last: this.st.last, lastError: this.st.lastError, restored: this.st.restored,
             backups: w.backups, reports: w.reports, roots: w.roots, list: this.list().slice(0, 10) };
  }

  /* ---- and putting one back -------------------------------------------- */
  /* When a backup was last taken, read off the folder rather than off this
     run, so a PC restarted every morning is not a PC that never backs up. */
  lastAt(){
    let newest = (this.st.last && this.st.last.at) || 0;
    try{
      const dir = this.backupsDir();
      for(const n of fs.readdirSync(dir)){
        if(!isBackupName(n)) continue;
        const t = fs.statSync(path.join(dir, n)).mtimeMs;
        if(t > newest) newest = t;
      }
    }catch(e){}
    return newest;
  }

  /* Shift ends, SAP falling over and the service stopping are all events. A
     PC can go a long time without any of them - a quiet week, a schedule
     nobody filled in, a copy left running over a shutdown - so there is also
     a plain floor: if nothing has been backed up for this many hours, take
     one. Checked every half hour, which is often enough for a floor and
     rare enough to be free. */
  watch(){
    if(this.timer) return;
    const tick = () => {
      try{
        const c = this.cfg();
        const hours = c.everyHours == null ? 12 : Number(c.everyHours);
        if(!(hours > 0)) return;
        if(this.app.backfill && this.app.backfill.status().running) return;
        const since = Date.now() - this.lastAt();
        if(since < hours * 3600000) return;
        this.run('nothing had been backed up for ' + Math.round(since / 3600000) + ' hours', { auto: true });
      }catch(e){ this.log('backup watch: ' + e.message, 'warn'); }
    };
    this.timer = setInterval(tick, 30 * 60000);
    if(this.timer.unref) this.timer.unref();
    /* not at once: let the first SAP pull and any restore settle first */
    const first = setTimeout(tick, 5 * 60000);
    if(first.unref) first.unref();
    return this;
  }
  stopWatch(){ if(this.timer){ clearInterval(this.timer); this.timer = null; } }

  /* The newest backup sitting in a folder on this PC: its own backups
     folder, or a folder somebody typed on the Admin page. */
  static localCandidate(cfg, log){
    const c = (cfg.get().backup) || {};
    const typed = c.dir && String(c.dir).trim();
    const dir = typed || path.join(cfg.dataDir, 'backups');
    const how = typed ? 'the folder set on the Admin page' : 'this PC own backups folder';
    if(!fs.existsSync(dir)) return { why: 'no backups folder on this PC yet' };
    const tmp = new Backup({ cfg }, log);
    const file = tmp.newest(dir);
    if(!file) return { why: 'no backups yet in ' + dir };
    let days = 0, at = 0;
    try{ days = tmp.daysIn(zipfile.read(fs.readFileSync(file))); at = fs.statSync(file).mtimeMs; }
    catch(e){ return { why: path.basename(file) + ' would not open: ' + e.message }; }
    return { file, days, at, how, name: path.basename(file) };
  }
  static localDays(cfg){
    try{ const t = fs.readFileSync(path.join(cfg.dataDir, 'pickers', 'history.json'), 'utf8'); return Object.keys(JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t)).length; }catch(e){ return 0; }
  }
  /* What this PC starts with. Every start asks: is there a backup anywhere
     with more history than this PC has? If there is, take it and merge - the
     merge keeps every day this PC already had, so there is nothing to lose
     and the answer is the union.

     This used to refuse outright on a PC with more than a few days of its
     own, which meant a PC that had been running a week could only be brought
     up to date by somebody pressing the button on the Admin page. The day
     count decides it now, not how new the PC is.

     The cloud copy is asked for its BACKUP DETAILS first and the backup
     itself only if it is worth having, so the ordinary start - where this PC
     is already the one that sent it - costs one small request.
  */
  static async adopt(cfg, log, deps){
    log = log || (() => {});
    deps = deps || {};
    const cloud = require('./cloud');
    const fetchCloud = deps.fetchCloud || cloud.fetchLatestBackup;
    const fetchMeta = deps.fetchMeta || (deps.fetchCloud
      ? (async (c, l) => { const g = await deps.fetchCloud(c, l); return g && g.meta; })
      : cloud.fetchBackupMeta);
    const have = Backup.localDays(cfg);
    const picks = [];
    const local = Backup.localCandidate(cfg, log);
    if(local.file) picks.push({ from: 'folder', days: local.days, at: local.at, file: local.file, how: local.how, name: local.name });
    const cc = cfg.get().cloud || {};
    let cloudWhy = '', meta = null;
    if(cc.enabled && cc.url && cc.secret){
      try{ meta = await fetchMeta(cc, log); if(!meta) cloudWhy = 'the cloud copy holds no backup yet'; }
      catch(e){ cloudWhy = 'could not ask the cloud copy: ' + e.message; }
    } else cloudWhy = 'no cloud copy is set up on this PC';
    if(meta) picks.push({ from: 'cloud', days: meta.days, at: meta.at, name: meta.name,
                          how: 'the cloud copy (sent by ' + (meta.host || 'the last host') + ')' });
    if(!picks.length) return { restored: false, why: 'nothing to take: ' + (local.why || 'no backup on this PC') + '; ' + cloudWhy };
    picks.sort((a, b) => (b.days - a.days) || (b.at - a.at));
    const best = picks[0];
    if(best.days <= have) return { restored: false, why: best.name + ' from ' + best.how + ' holds ' + best.days +
      ' days and this PC already has ' + have + '; nothing to gain' };
    let file = best.file;
    if(!file){
      /* worth having: now fetch it */
      let got = null;
      try{ got = await fetchCloud(cc, log); }
      catch(e){ return { restored: false, why: 'could not fetch the backup from the cloud copy: ' + e.message }; }
      if(!got) return { restored: false, why: 'the cloud copy no longer holds a backup' };
      const dir = path.join(cfg.dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'from-cloud-' + String(got.meta.name).replace(/[^w.-]/g, '_'));
      fs.writeFileSync(file, got.bytes);
    }
    try{
      const r = Backup.restoreFile(cfg, file, log, { merge: true });
      log('restore: this PC had ' + have + ' day(s); took ' + best.name + ' from ' + best.how + ' - now ' + r.days + ' days' + (r.kept ? ' (' + r.kept + ' of its own kept)' : ''));
      return Object.assign({ restored: true, file, how: best.how, from: best.from }, r);
    }catch(e){
      log('restore: could not use ' + best.name + ': ' + e.message, 'error');
      return { restored: false, why: e.message, file };
    }
  }
  /* the Admin button: the copy's newest backup merged in now, whatever this
     PC already has - a merge loses nothing, and somebody asked */
  static async adoptFromCloud(cfg, log, opt){
    log = log || (() => {});
    opt = opt || {};
    const cc = cfg.get().cloud || {};
    if(!(cc.enabled && cc.url && cc.secret)) return { restored: false, why: 'no cloud copy is set up on this PC (Admin > Configuration)' };
    let got;
    try{ got = await (opt.fetchCloud || require('./cloud').fetchLatestBackup)(cc, log); }
    catch(e){ return { restored: false, why: 'could not ask the cloud copy: ' + e.message }; }
    if(!got) return { restored: false, why: 'the cloud copy holds no backup yet - the other PC has not sent one' };
    const have = Backup.localDays(cfg);
    if(!opt.force && got.meta.days <= have) return { restored: false, why: 'the copy holds ' + got.meta.days + ' days and this PC has ' + have };
    const dir = path.join(cfg.dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'from-cloud-' + got.meta.name.replace(/[^\w.\-]/g, '_'));
    fs.writeFileSync(file, got.bytes);
    try{
      const r = Backup.restoreFile(cfg, file, log, { merge: true });
      const how = 'the cloud copy (sent by ' + (got.meta.host || 'the last host') + ')';
      log('restore: took ' + got.meta.name + ' from ' + how + ' - now ' + r.days + ' days' + (r.kept ? ' (' + r.kept + ' of its own kept)' : ''));
      return Object.assign({ restored: true, file, how, from: 'cloud' }, r);
    }catch(e){ return { restored: false, why: e.message, file }; }
  }
  static restoreFile(cfg, file, log, opt){
    opt = opt || {};
    const dataDir = cfg.dataDir;
    const entries = zipfile.read(fs.readFileSync(file));
    let days = 0, wrote = 0, kept = 0;
    /* what this PC already knew, so a merge can keep it */
    let mine = null;
    if(opt.merge){
      try{ mine = JSON.parse(fs.readFileSync(path.join(dataDir, 'pickers', 'history.json'), 'utf8').replace(/^﻿/, '')); }catch(e){ mine = null; }
    }
    for(const e of entries){
      const rel = e.name.replace(/^StagingLaneHealth\//, '');
      if(!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const dst = path.join(dataDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      let data = e.data;
      if(rel === 'config.json'){
        try{
          let c = JSON.parse(data.toString('utf8').replace(/^﻿/, ''));
          /* Merging: what this PC already has set wins - the cloud address
             and secret it was just given, a port, anything - and the backup
             fills in what it lacks: the SAP monitor tree, the standards, the
             schedule. Replacing the file wholesale wiped the very settings
             the new PC had used to fetch the backup. */
          if(opt.merge){
            let local = null;
            try{ const t = fs.readFileSync(dst, 'utf8'); local = JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t); }catch(err){ local = null; }
            if(local && typeof local === 'object') c = deepMerge(c, local);
          }
          delete c.reportDir;
          c.reportDirMoved = true;
          data = Buffer.from(JSON.stringify(c, null, 2));
        }catch(err){}
      }
      if(rel === 'pickers/history.json'){
        let h;
        try{ h = JSON.parse(data.toString('utf8').replace(/^﻿/, '')); }catch(err){ throw new Error('the history in that backup would not parse'); }
        if(mine && typeof mine === 'object'){
          /* the backup's days come in; a day this PC already has stays as
             this PC has it - it watched that day itself and the backup did not */
          for(const k in mine){ if(mine[k] && typeof mine[k] === 'object'){ if(h[k]) kept++; h[k] = mine[k]; } }
        }
        days = Object.keys(h).length;
        data = Buffer.from(JSON.stringify(h));
      }
      fs.writeFileSync(dst, data);
      wrote++;
    }
    if(!wrote) throw new Error('that zip holds nothing');
    try{ cfg.load(); }catch(e){}
    return { days, files: wrote, kept: mine ? Object.keys(mine).length : 0 };
  }
}

module.exports = { Backup, KEEP, MIN_GAP_MS };
