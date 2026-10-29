'use strict';
/* Watches the report folder, parses the three SAP exports once on the host,
   and holds the reduced rows every viewer gets. Re-reads only when a file's
   size or modified time changes, so idle polling costs nothing. */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { rowsFromBuffer } = require('./xlsx');
const model = require('./model');

/* Columns forwarded to viewers. The board matches by header name, so the
   original header text is kept; everything else is dropped to keep the
   payload small (the HU export is 63 columns wide, seven matter). */
const KEEP = {
  stage: ['handling unit', 'packaging material', 'storage bin', 'changed by', 'changed on', 'changed at',
          'created by', 'created on', 'created at', 'consolidation group'],
  orders: ['consolidation group', 'erp document', 'picking status', 'actual pick date', 'goods issue status', 'sales order'],
  wh: null      // every column: the line-identifying one differs by system
};

function reduce(rows, keep, hIdx){
  if(!keep || hIdx < 0) return rows;
  const H = model.norm(rows[hIdx]);
  const idx = [];
  H.forEach((h, i) => { if(keep.some(k => h === k || h.indexOf(k) === 0)) idx.push(i); });
  if(!idx.length) return rows;
  const out = [];
  for(let i = hIdx; i < rows.length; i++){
    const r = rows[i] || [];
    out.push(idx.map(j => (r[j] == null ? '' : r[j])));
  }
  return out;
}

class Ingest extends EventEmitter {
  constructor(cfg, log){
    super();
    this.cfg = cfg;
    this.log = log || (() => {});
    this.version = 0;
    this.files = { stage: blank(), orders: blank(), wh: blank() };
    this.derived = { lanes: null, orders: null, at: null };
    this.timer = null;
    this.watcher = null;
    this.reading = false;
    this.pending = false;
  }
  get reportDir(){ return this.cfg.get().reportDir; }
  fileName(kind){ return this.cfg.get().files[kind]; }
  start(){
    this.refresh();
    this.armWatch();
    this.timer = setInterval(() => this.refresh(), 10000);
  }
  stop(){
    if(this.timer) clearInterval(this.timer);
    if(this.watcher){ try{ this.watcher.close(); }catch(e){} }
  }
  armWatch(){
    if(this.watcher){ try{ this.watcher.close(); }catch(e){} this.watcher = null; }
    try{
      let t = null;
      this.watcher = fs.watch(this.reportDir, { persistent: false }, () => {
        if(t) clearTimeout(t);
        t = setTimeout(() => this.refresh(), 1500);
      });
      this.watcher.on('error', () => { this.watcher = null; });
    }catch(e){ this.watcher = null; }
  }
  /* Find the file for a kind: exact name first, then a loose match so a
     renamed export still works. */
  locate(kind){
    const dir = this.reportDir;
    const want = this.fileName(kind);
    const exact = path.join(dir, want);
    try{ const st = fs.statSync(exact); if(st.isFile()) return { path: exact, name: want, st }; }catch(e){}
    let names = [];
    try{ names = fs.readdirSync(dir); }catch(e){ return null; }
    const pat = kind === 'stage' ? /staging/i : kind === 'orders' ? /order/i : /^(wh ?task|whse ?task|warehouse ?task)/i;
    const cands = names.filter(n => pat.test(n) && /\.(xlsx|xls|csv|txt)$/i.test(n) && !/^~\$/.test(n))
      .sort((a, b) => (/\.xlsx?$/i.test(a) ? 0 : 1) - (/\.xlsx?$/i.test(b) ? 0 : 1));
    for(const n of cands){
      try{ const p = path.join(dir, n); const st = fs.statSync(p); if(st.isFile()) return { path: p, name: n, st }; }catch(e){}
    }
    return null;
  }
  async refresh(){
    if(this.reading){ this.pending = true; return; }
    this.reading = true;
    let changed = false;
    try{
      if(!fs.existsSync(this.reportDir)){
        for(const k of Object.keys(this.files)){
          if(this.files[k].status !== 'no folder'){ this.files[k] = Object.assign(blank(), { status: 'no folder', name: this.fileName(k) }); changed = true; }
        }
      } else {
        if(!this.watcher) this.armWatch();
        for(const kind of ['stage', 'orders', 'wh']){
          if(this.readOne(kind)) changed = true;
        }
      }
    }catch(e){ this.log('ingest error: ' + (e && e.message)); }
    this.reading = false;
    if(changed){
      this.version++;
      this.derive();
      this.emit('change', this.version);
    }
    if(this.pending){ this.pending = false; setImmediate(() => this.refresh()); }
  }
  readOne(kind){
    const cur = this.files[kind];
    const loc = this.locate(kind);
    if(!loc){
      if(cur.status === 'not found') return false;
      this.files[kind] = Object.assign(blank(), { status: 'not found', name: this.fileName(kind) });
      return true;
    }
    const mtime = loc.st.mtimeMs, size = loc.st.size;
    if(cur.name === loc.name && cur.mtime === mtime && cur.size === size) return false;   // unchanged
    const rec = Object.assign(blank(), { name: loc.name, path: loc.path, mtime, size, readAt: Date.now() });
    if(size === 0){ rec.status = 'empty file'; this.files[kind] = rec; return true; }
    let buf;
    try{ buf = fs.readFileSync(loc.path); }
    catch(e){
      // being written or locked: keep the last good read, try again on the next tick
      if(cur.status === 'ok'){ this.log(kind + ': ' + loc.name + ' locked, keeping last good read'); return false; }
      rec.status = 'unreadable'; rec.error = e.message; this.files[kind] = rec; return true;
    }
    try{
      const rows = rowsFromBuffer(buf, loc.name);
      const cls = model.classifyHeader(rows);
      if(cls !== 'unknown' && cls !== kind){
        rec.status = 'wrong file';
        rec.error = 'this is the ' + label(cls) + ' export saved under the ' + label(kind) + ' name';
        rec.rows = null;
        this.log(kind + ': ' + rec.error + ' - board keeps the previous ' + label(kind) + ' data');
        // keep serving the previous good rows, report the problem
        if(cur.status === 'ok' && cur.rows){ rec.rows = cur.rows; rec.hIdx = cur.hIdx; rec.rowCount = cur.rowCount; rec.status = 'wrong file'; }
        this.files[kind] = rec; return true;
      }
      const hIdx = kind === 'stage' ? model.headerIndex(rows, ['handling unit', 'storage bin'], 6)
                 : kind === 'orders' ? model.headerIndex(rows, ['consolidation', 'picking', 'document'], 8)
                 : model.headerIndex(rows, ['warehouse task'], 12);
      rec.rowCount = Math.max(0, rows.length - (hIdx >= 0 ? hIdx + 1 : 0));
      rec.rows = reduce(rows, KEEP[kind], hIdx);
      rec.hIdx = hIdx >= 0 ? 0 : -1;
      rec.status = 'ok';
      rec.full = rows;    // kept for CSV export and server side derivation
      this.log(kind + ': read ' + loc.name + ' (' + rec.rowCount + ' rows)');
    }catch(e){
      rec.status = 'parse failed'; rec.error = e.message;
      if(cur.status === 'ok' && cur.rows){ rec.rows = cur.rows; rec.full = cur.full; rec.rowCount = cur.rowCount; rec.hIdx = cur.hIdx; }
      this.log(kind + ': parse failed for ' + loc.name + ': ' + e.message);
    }
    this.files[kind] = rec;
    return true;
  }
  derive(){
    const d = { at: Date.now(), lanes: null, orders: null, errors: {} };
    const s = this.files.stage;
    if(s.full){ try{ d.lanes = model.computeLanes(s.full); }catch(e){ d.errors.stage = e.message; } }
    const o = this.files.orders;
    if(o.full){ try{ d.orders = model.computeOrders(o.full); }catch(e){ d.errors.orders = e.message; } }
    this.derived = d;
  }
  /* What the board asks for. */
  payload(){
    const out = { v: this.version, serverNow: Date.now(), reportDir: this.reportDir, files: {} };
    for(const k of Object.keys(this.files)){
      const f = this.files[k];
      out.files[k] = { status: f.status, name: f.name, mtime: f.mtime, size: f.size, rows: f.rowCount, error: f.error || '', readAt: f.readAt,
                       data: f.rows || null };
    }
    return out;
  }
  diag(){
    const out = {};
    for(const k of Object.keys(this.files)){
      const f = this.files[k];
      out[k] = { status: f.status, name: f.name, mtime: f.mtime, size: f.size, rows: f.rowCount, error: f.error || '', readAt: f.readAt };
    }
    return out;
  }
  fullRows(kind){ const f = this.files[kind]; return f && f.full ? f.full : null; }
  newestMtime(){
    let m = 0;
    for(const k of Object.keys(this.files)){ const f = this.files[k]; if(f.status === 'ok' && f.mtime > m) m = f.mtime; }
    return m || null;
  }
}

function blank(){ return { status: 'not read', name: '', path: '', mtime: null, size: null, rowCount: null, rows: null, full: null, hIdx: -1, error: '', readAt: null }; }
function label(k){ return k === 'stage' ? 'HU staging' : k === 'orders' ? 'order' : k === 'wh' ? 'warehouse task' : k; }

module.exports = { Ingest };
