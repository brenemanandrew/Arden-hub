'use strict';
/* Dwell log and lane usage, kept once on the host instead of once per
   browser. Same rules as the board had: a tote is logged when it leaves a
   lane, a gap in observation re-baselines instead of inventing departures,
   and anything past the cap is flagged rather than counted. */
const fs = require('fs');
const path = require('path');

class Dwell {
  constructor(cfg, log){
    this.cfg = cfg;
    this.log = log || (() => {});
    this.dir = path.join(cfg.dataDir, 'dwell');
    this.openFile = path.join(this.dir, 'open.json');
    this.logFile = path.join(this.dir, 'completed.json');
    this.csvFile = path.join(this.dir, 'staging_dwell_log.csv');
    this.usageFile = path.join(this.dir, 'usage.json');
    this.open = {};
    this.completed = [];
    this.use = {};
    this.snaps = 0;
    this.lastSeen = 0;
    this.version = 0;
    this.gapAt = null;
    this.load();
  }
  load(){
    try{ const o = JSON.parse(fs.readFileSync(this.openFile, 'utf8')); this.open = o.open || {}; this.lastSeen = o.lastSeen || 0; }catch(e){}
    try{ this.completed = JSON.parse(fs.readFileSync(this.logFile, 'utf8')) || []; }catch(e){}
    try{ const u = JSON.parse(fs.readFileSync(this.usageFile, 'utf8')); this.use = u.use || {}; this.snaps = u.snaps || 0; }catch(e){}
  }
  save(){
    try{
      fs.writeFileSync(this.openFile, JSON.stringify({ open: this.open, lastSeen: this.lastSeen }));
      fs.writeFileSync(this.logFile, JSON.stringify(this.completed));
      fs.writeFileSync(this.usageFile, JSON.stringify({ use: this.use, snaps: this.snaps }));
    }catch(e){ this.log('dwell save failed: ' + e.message); }
  }
  params(){
    const d = this.cfg.get().dwell || {};
    return { capMs: Math.max(1, d.capHours || 50) * 3600000, windowMs: Math.max(1, d.windowDays || 30) * 86400000, gapMs: Math.max(0.1, d.gapHours || 2) * 3600000 };
  }
  /* present: tote -> { order, picker, lane, staged }. lanes: bin -> {...} */
  observe(present, lanes, now){
    now = now || Date.now();
    const p = this.params();
    const gap = this.lastSeen ? (now - this.lastSeen) : Infinity;
    let dropped = 0;
    if(gap > p.gapMs){
      for(const hu in this.open){ if(!present[hu]){ delete this.open[hu]; dropped++; } }
      for(const hu in this.open) this.open[hu].firstSeen = Math.min(this.open[hu].firstSeen || now, now);
      if(dropped) this.log(dropped + ' stale tote records dropped after a ' + Math.round(gap / 60000) + ' minute gap in monitoring');
      this.gapAt = now;
    }
    for(const hu in present){
      if(!this.open[hu]){
        const x = present[hu];
        this.open[hu] = { tote: hu, order: x.order, picker: x.picker, lane: x.lane, stagedSince: x.staged || now, firstSeen: now };
      }
    }
    let closed = 0;
    for(const hu in this.open){
      if(!present[hu]){
        const rec = this.open[hu];
        const startMs = rec.stagedSince || rec.firstSeen;
        const dwell = now - startMs;
        this.completed.push({ tote: rec.tote, order: rec.order, picker: rec.picker, lane: rec.lane, stagedSince: startMs, firstSeen: rec.firstSeen,
                              departed: now, dwellMs: dwell, stale: dwell > p.capMs ? 1 : 0 });
        delete this.open[hu];
        closed++;
      }
    }
    const cutoff = now - p.windowMs;
    if(this.completed.length && this.completed[0].departed < cutoff) this.completed = this.completed.filter(r => r.departed >= cutoff);
    // usage: how often each bin held a tote
    this.snaps++;
    for(const b in lanes){ if(lanes[b].hus > 0) this.use[b] = (this.use[b] || 0) + 1; }
    this.lastSeen = now;
    this.version++;
    this.save();
    if(closed) this.writeCsv();
    return { closed, dropped };
  }
  csv(){
    const head = ['consolidation', 'tote', 'picker_changed_by', 'lane', 'staged_since', 'first_seen', 'cleared_detected', 'minutes_in_staging', 'watched'];
    const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [head.join(',')];
    this.completed.slice().sort((a, b) => a.departed - b.departed).forEach(r => {
      const startMs = r.stagedSince || r.firstSeen;
      lines.push([r.order, r.tote, r.picker, r.lane, fmtTs(r.stagedSince), fmtTs(r.firstSeen), fmtTs(r.departed),
                  Math.round((r.departed - startMs) / 60000), r.stale ? 0 : 1].map(cell).join(','));
    });
    return lines.join('\r\n');
  }
  writeCsv(){
    try{ fs.writeFileSync(this.csvFile, this.csv()); }catch(e){}
    /* A second copy in the report folder, for the old board that watched it.
       That board is retired and the report folder is now the app folder, so
       this follows the same switch as the other legacy files rather than
       leaving a logs folder in among the app's own. */
    const c = this.cfg.get();
    if(!c.compat || !c.compat.writeLegacyFiles) return;
    try{
      const rd = c.reportDir;
      if(fs.existsSync(rd)){ fs.mkdirSync(path.join(rd, 'logs'), { recursive: true }); fs.writeFileSync(path.join(rd, 'logs', 'staging_dwell_log.csv'), this.csv()); }
    }catch(e){}
  }
  repair(){
    const p = this.params();
    const byMinute = {};
    this.completed.forEach(r => { const m = Math.floor(r.departed / 60000); byMinute[m] = (byMinute[m] || 0) + 1; });
    let flagged = 0, dropped = 0;
    this.completed = this.completed.filter(r => {
      const m = Math.floor(r.departed / 60000);
      const dwell = r.departed - (r.stagedSince || r.firstSeen);
      if(byMinute[m] >= 5 && dwell > p.capMs){ dropped++; return false; }
      if(dwell > p.capMs && !r.stale){ r.stale = 1; flagged++; }
      return true;
    });
    this.version++; this.save(); this.writeCsv();
    return { flagged, dropped };
  }
  clearLog(){ this.completed = []; this.version++; this.save(); this.writeCsv(); }
  resetUsage(){ this.use = {}; this.snaps = 0; this.version++; this.save(); }
  payload(){ return { v: this.version, open: this.open, completed: this.completed, usage: { use: this.use, snaps: this.snaps }, gapAt: this.gapAt, lastSeen: this.lastSeen }; }
}

function fmtTs(ms){
  if(!ms) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

module.exports = { Dwell, fmtTs };
