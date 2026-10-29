'use strict';
/* The shared folder.

   Arden Pack does not drive SAP. Staging Lane Health does, on the host
   PC, and it writes the three exports into one folder; this reads the
   same folder. One SAP session, one driver, two readers - two drivers
   would fight over the same GUI, which is the whole reason the pack
   board lived inside that service to begin with.

   So there is no puller here and there never should be. If the exports
   stop arriving the answer is on the other service, and this says so
   rather than trying to fetch them itself.

   It presents the same small surface the pack model expects: whole rows
   by kind, a version that moves when anything is re-read, and a word
   about each file for the page to show when one is missing or stale. */

const fs = require('fs');
const path = require('path');
const { rowsFromBuffer } = require('./xlsx');

/* `not` keeps one kind off another kind's file: the SAP value exports are
   called "Open EWM Orders - ...", which the plain /order/ pattern would
   happily claim, and then the board would be built on the wrong file.
   `optional` marks the ones nobody drops yet - absent is their normal
   state, not a fault worth flagging red. */
const KINDS = {
  wh:     { pat: /^(wh ?task|whse ?task|warehouse ?task)/i, name: 'WHTask.XLSX',     label: 'warehouse task' },
  orders: { pat: /order/i, not: /sap ?data|pgi|- ?lines|- ?header|- ?picked/i,
            name: 'Orders.XLSX',     label: 'order' },
  stage:  { pat: /staging/i,                                name: 'HU STAGING.XLSX', label: 'handling unit' },
  /* ECC, not EWM. The warehouse prices nothing, so the only money that can
     reach this board comes from the delivery exports the staging service
     pulls off VL06O. Nothing here pulls them - they are read if they are in
     the folder, and absent otherwise.

     The names are what that pull writes, and both are a setting over there
     (`deliveries.delFile` / `pgiFile`), so the patterns are deliberately
     loose: `data` as well as `deliver`, because the macro this was first
     written from called the same export "Open EWM Orders - SAP Data.txt"
     and somebody dropping one by hand should still be read. */
  sapdel: { pat: /sap ?(deliver|data)/i, name: 'SAP Deliveries.TXT',
            label: 'open delivery value', optional: true },
  pgi:    { pat: /(^|[^a-z])pgi([^a-z]|$)/i, name: 'SAP PGI.TXT',
            label: 'shipped delivery value', optional: true }
};
/* What to call an export that arrived from the host rather than being
   found in the folder. The name comes off another machine, so it is not
   trusted to be a name at all - and it is not allowed to be a name
   belonging to a different kind either, or a drop could quietly change
   which file the board reads. Anything that is not plainly this kind's
   own export is written under this kind's usual name, keeping whatever
   extension it arrived with, so the reader is never told that a CSV is a
   workbook.

   The point is one file per kind: the copy's folder holds only what was
   sent to it, so there is nothing older sitting beside it. */
function dropName(kind, given){
  const k = KINDS[kind];
  if(!k) return '';
  const n = path.win32.basename(String(given || ''));      // either separator
  const ext = (n.match(/[.]([A-Za-z0-9]{1,5})$/) || [])[1] || '';
  /* the two are asked separately on purpose: a name can be unusable while
     the extension on it is still the truth about what the bytes are, and
     writing CSV bytes under .XLSX makes the reader throw */
  const extOk = /^(xlsx|xls|csv|txt)$/i.test(ext);
  const plain = /^[A-Za-z0-9 ._-]{1,120}$/.test(n);
  if(extOk && plain && k.pat.test(n)) return n;
  return extOk ? k.name.replace(/[.][^.]+$/, '.' + ext) : k.name;
}

const blank = () => ({ rows: null, name: '', mtime: 0, size: 0, readAt: null, status: 'not found', error: '' });

class Ingest {
  constructor(dir, log){
    this.dir = dir;
    this.log = log || (() => {});
    this.version = 0;
    /* one entry per kind, taken from the table rather than listed again
       here - a kind added above was silently untracked when this was a
       hand-written list */
    this.files = {};
    for(const k of Object.keys(KINDS)) this.files[k] = blank();
    this.watcher = null;
    this.timer = null;
  }
  start(){
    this.refresh();
    this.arm();
    /* a folder watch misses a write now and then - on a network share it
       misses a good many - so there is a slow sweep behind it */
    setInterval(() => this.refresh(), 60000).unref();
  }
  arm(){
    if(this.watcher){ try{ this.watcher.close(); }catch(e){} this.watcher = null; }
    try{
      this.watcher = fs.watch(this.dir, { persistent: false }, () => {
        if(this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(), 1500);
      });
      this.watcher.on('error', () => { this.watcher = null; });
    }catch(e){ this.watcher = null; }
  }
  /* the configured name first, then anything that looks like it, so a
     renamed export still lands */
  locate(kind){
    const k = KINDS[kind];
    try{
      const exact = path.join(this.dir, k.name);
      const st = fs.statSync(exact);
      if(st.isFile()) return { path: exact, name: k.name, st };
    }catch(e){}
    let names = [];
    try{ names = fs.readdirSync(this.dir); }catch(e){ return null; }
    /* A folder can hold yesterday's export beside today's - on the host
       because the service writes a dated name - and reading the older of
       the two is the kind of wrong nobody notices. Newest wins. */
    const stamp = n => { try{ return fs.statSync(path.join(this.dir, n)).mtimeMs; }catch(e){ return 0; } };
    const cands = names
      .filter(n => k.pat.test(n) && !(k.not && k.not.test(n)) && /\.(xlsx|xls|csv|txt)$/i.test(n) && !/^~\$/.test(n))
      .sort((a, b) => (/\.xlsx?$/i.test(a) ? 0 : 1) - (/\.xlsx?$/i.test(b) ? 0 : 1) ||
                      (stamp(b) - stamp(a)));
    for(const n of cands){
      try{
        const p = path.join(this.dir, n);
        const st = fs.statSync(p);
        if(st.isFile()) return { path: p, name: n, st };
      }catch(e){}
    }
    return null;
  }
  readOne(kind){
    const cur = this.files[kind];
    const loc = this.locate(kind);
    if(!loc){
      if(cur.status === 'not found') return false;
      this.files[kind] = Object.assign(blank(), { name: KINDS[kind].name });
      return true;
    }
    if(cur.name === loc.name && cur.mtime === loc.st.mtimeMs && cur.size === loc.st.size) return false;
    const rec = Object.assign(blank(), { name: loc.name, mtime: loc.st.mtimeMs, size: loc.st.size, readAt: Date.now() });
    if(loc.st.size === 0){ rec.status = 'empty file'; this.files[kind] = rec; return true; }
    let buf;
    try{ buf = fs.readFileSync(loc.path); }
    catch(e){
      /* being written, or locked by whatever is producing it: keep the
         last good read rather than blanking the board */
      if(cur.status === 'ok') return false;
      rec.status = 'unreadable'; rec.error = e.message; this.files[kind] = rec; return true;
    }
    try{
      rec.rows = rowsFromBuffer(buf, loc.name);
      rec.status = 'ok';
      this.log(kind + ': read ' + loc.name + ' (' + rec.rows.length + ' rows)');
    }catch(e){ rec.status = 'unreadable'; rec.error = e.message; }
    this.files[kind] = rec;
    return true;
  }
  refresh(){
    let changed = false;
    if(!fs.existsSync(this.dir)){
      for(const k of Object.keys(this.files)){
        if(this.files[k].status !== 'no folder'){
          this.files[k] = Object.assign(blank(), { status: 'no folder', name: KINDS[k].name });
          changed = true;
        }
      }
    } else {
      if(!this.watcher) this.arm();
      for(const k of Object.keys(this.files)) if(this.readOne(k)) changed = true;
    }
    if(changed) this.version++;
    return changed;
  }
  fullRows(kind){ const f = this.files[kind]; return (f && f.rows) || null; }
  diag(){
    const out = {};
    for(const k of Object.keys(this.files)){
      const f = this.files[k];
      out[k] = { name: f.name, rows: f.rows ? f.rows.length : 0, readAt: f.readAt,
                 status: f.status, error: f.error, label: KINDS[k].label,
                 optional: !!KINDS[k].optional };
    }
    return out;
  }
  newestMtime(){
    return Math.max.apply(null, Object.values(this.files).map(f => f.mtime || 0).concat([0]));
  }
}

module.exports = { Ingest, KINDS, dropName };
