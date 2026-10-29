'use strict';
/* What the benches did, kept a day at a time.

   The pack page used to be "whatever is in the current task export",
   which made every number on it the sum of however many days the pull
   happened to cover and left no way to ask for last week. The export
   cannot simply be widened: four days of creation dates came back with
   62,693 rows and the export ran past the cycle timeout, so the puller
   now narrows its own window instead. The way to have a week is to keep
   each day as it goes past, which is what the picker history has always
   done, so this is built the same shape as that one:

     <dataDir>/pack/history.json     dayKey -> { at, all, shifts: { name } }

   A day already in the store is only replaced by a reading that holds
   more of it. The task export asks SAP for a window of CREATION dates,
   so the older days inside it are always partial - a task created five
   days ago and packed yesterday is not in a three-day window - and
   overwriting a whole day with a partial one would quietly delete work
   that was really done. Today is the exception: the export is a full
   picture of today, so today is replaced outright every time it is read. */

const fs = require('fs');
const path = require('path');
const packmodel = require('./packmodel');

const HISTORY_DAYS = 400;               // the same cap the picker history keeps

class PackHist {
  constructor(cfg, log){
    this.cfg = cfg;
    this.log = log || (() => {});
    this.dir = path.join(cfg.dataDir, 'pack');
    this.file = path.join(this.dir, 'history.json');
    this.history = {};
    this.dirty = false;
    try{ fs.mkdirSync(this.dir, { recursive: true }); }catch(e){}
    try{
      const t = fs.readFileSync(this.file, 'utf8');
      this.history = JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t) || {};
    }catch(e){ this.history = {}; }
  }

  /* Rolled-up days in, kept days out. `today` is replaced; anything
     older has to beat what is already stored to take its place. */
  observe(rolled, today){
    let changed = false;
    for(const day in rolled){
      const next = rolled[day];
      const cur = this.history[day];
      const better = !cur || day === today ||
        (next.all.out + next.all.fedIn) > (cur.all.out + cur.all.fedIn);
      if(!better) continue;
      this.history[day] = next;
      changed = true;
    }
    if(!changed) return false;
    const keys = Object.keys(this.history).sort();
    while(keys.length > HISTORY_DAYS) delete this.history[keys.shift()];
    this.dirty = true;
    this.save();
    return true;
  }

  /* Rows straight from an export, for the backfill, which has its own
     slices and no interest in what the page is holding. */
  observeRows(rows, opt, sched, today){
    const tasks = packmodel.readTasks ? packmodel.readTasks(rows, (opt && opt.lineKey) || []) : null;
    if(!tasks || !tasks.ok) return false;
    return this.observe(packmodel.rollup(tasks, opt, sched), today || null);
  }

  /* temp file and rename, so a half-written history is never what is
     left behind when the PC goes down mid-save */
  save(){
    if(!this.dirty) return;
    try{
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.history));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    }catch(e){ this.log('pack history: ' + e.message); }
  }

  /* what the cloud copy is sent - the copy answers the same ranges the
     host does, and 45 days is what the picker history pushes */
  recent(days){
    const keys = Object.keys(this.history).sort().slice(-(days || 45));
    const out = {};
    keys.forEach(k => { out[k] = this.history[k]; });
    return out;
  }
  merge(into){
    if(!into) return;
    let n = 0;
    for(const day in into){ this.history[day] = into[day]; n++; }
    return n;
  }
  stats(){
    const keys = Object.keys(this.history).sort();
    return { days: keys.length, first: keys[0] || '', last: keys[keys.length - 1] || '' };
  }
}

module.exports = { PackHist, HISTORY_DAYS };
