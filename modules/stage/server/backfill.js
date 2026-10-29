'use strict';
/* One-time history backfill.

   The picker history is built from the warehouse task export, and that
   export only ever covers the window the driver asks SAP for. Normally that
   is a few days, which is all the live board needs. This runs the same
   export slice by slice with the window walked back, then feeds each day it
   finds into the daily rollup, so the week, month and year views and the
   recommended standards have a history to work with on day one.

   Three things shape how it works:

   1. SAP selects tasks by CREATION date, and a rate counts CONFIRMATIONS.
      A task created on Monday and confirmed on Tuesday belongs to Tuesday's
      numbers. So every slice asks SAP for a few days of creation dates
      BEFORE the days it means to file - the lead-in - and then files only
      the days it can see whole. The lead-in is what lets a slice be closed
      out and thrown away instead of holding a year of rows in memory, which
      is the difference between thirty days working and a year working.

   2. A day already on file may be better than what a wide pull returns.
      Live pulls read the task export many times a day and always see the
      whole day; a wide pull can miss the tail. So a day is only replaced
      when the backfill actually found more picks for it.

   3. A year is around two dozen SAP exports and the better part of an hour.
      Something will go wrong in that time - a session drops, somebody logs
      SAP out - so each slice is recorded as it lands. Starting it again
      picks up from the first slice that never finished rather than driving
      SAP over the same months a second time.

   The export is written to a folder of its own under the data directory, not
   the live report folder, so the board never sees a year of tasks and the
   normal cycle carries on afterwards untouched. */
const fs = require('fs');
const path = require('path');
const { rowsFromBuffer } = require('./xlsx');
const model = require('./model');

const MAX_ROWS = 400000;           // per slice; a fortnight of tasks is tens of thousands
/* How long one slice gets. A flat twenty minutes was fine until a floor
   turned out to write fifteen to twenty thousand task rows a day: the
   lead-in alone makes the narrowest possible window four days, and the
   widest the year button asks for is eighteen, which is a third of a
   million rows for Excel to write. So the limit follows the window, with
   twenty minutes as the floor and an hour as the ceiling. */
/* Rows SAP will carry out of the grid and into a file in one go. This is
   not our time limit - it is SAP's own. A 133,216 row window ran for ten
   minutes and then short-dumped, and the driver found no export dialog
   waiting for it ("the control could not be found by id"), so the run
   lost three windows in a row and stopped. A window past this is halved
   and tried again rather than written off. */
const BIG_ROWS = 100000;
const SLICE_MIN_MS = 20 * 60000;
const SLICE_MAX_MS = 60 * 60000;
const SLICE_MS_PER_DAY = 3 * 60000;
const sliceTimeout = s => Math.min(SLICE_MAX_MS,
  Math.max(SLICE_MIN_MS, Math.max(1, s.backDays - s.toDays + 1) * SLICE_MS_PER_DAY));
/* Days of creation dates read before the first day a slice files. Of the
   picks on the floor 96.6% are confirmed within a day of the task being
   created and none at all past three, so four days is the whole tail with
   room to spare. */
const LEAD_IN = 4;
/* Empty windows in a row before the run stops. One or two is SAP having no
   history that far back; several in a row is something else, and there is
   nothing to learn from driving the remaining months into the same wall. */
const GIVE_UP_AFTER = 3;
/* A run this long is a base rather than a top-up, and is what the marker
   records so it is not driven twice. */
const BASE_DAYS = 180;
const DAY = 86400000;

function clamp(v, lo, hi, dflt){ const n = parseInt(v, 10); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; }
function keyOf(d){ return model.dayKey(d); }
function backKey(anchor, n){ return keyOf(new Date(anchor.getTime() - n * DAY)); }

/* The slices, oldest first, as absolute dates. Absolute rather than "days
   back" so a run started last night and finished this morning means the
   same thing both times, which is what makes resuming safe. */
function planSlices(anchor, days, chunk){
  const out = [];
  for(let b = days - 1; b >= 0; b -= chunk){
    const oldest = b, newest = Math.max(0, b - chunk + 1);
    out.push({
      id: backKey(anchor, oldest) + '..' + backKey(anchor, newest),
      from: backKey(anchor, oldest),      // first day this slice files
      to: backKey(anchor, newest),        // last day this slice files
      backDays: oldest + LEAD_IN,         // creation dates asked of SAP
      toDays: newest
    });
  }
  return out;
}

/* One window into two, by the days it files - the lead-in rides along
   with each half, so the two together read more rows than the one did.
   That is the price of a window SAP will actually carry out. Null when
   there is only one day left to file and nothing to halve. */
function split(s, anchor){
  const oldest = s.backDays - LEAD_IN, newest = s.toDays;
  if(oldest <= newest) return null;
  const mid = newest + Math.floor((oldest - newest) / 2);
  const make = (o, n) => ({
    id: backKey(anchor, o) + '..' + backKey(anchor, n),
    from: backKey(anchor, o), to: backKey(anchor, n),
    backDays: o + LEAD_IN, toDays: n,
    /* which slice of the original plan this came out of. Only that id is
       in the plan a resumed run rebuilds, so it is what has to be marked
       done - and only once every piece of it is in. */
    parent: s.parent || s.id
  });
  /* newer half first, the way the queue runs: if this stops early the
     recent end is the part already collected */
  return [make(mid, newest), make(oldest, mid + 1)];
}

class Backfill {
  constructor(app, onChange){
    this.app = app;
    this.onChange = onChange || (() => {});
    this.file = path.join(app.cfg.dataDir, 'pickers', 'backfill.json');
    this.mem = this.load();
    this.st = { running: false, startedAt: null, doneAt: null, phase: '', step: 0, steps: 0,
                days: 0, chunk: 0, rows: 0, tasks: 0, written: [], missed: [], skipped: 0, error: '', note: '',
                base: this.mem.base || null, resumed: 0 };
  }
  /* What earlier runs got through. `base` is the marker that a wide pull has
     already been done, so the button can say so instead of driving SAP over
     the same year again; `slices` is how far the last attempt got. */
  load(){
    try{ const m = JSON.parse(fs.readFileSync(this.file, 'utf8')); return (m && typeof m === 'object') ? m : {}; }
    catch(e){ return {}; }
  }
  remember(){
    try{ fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.mem)); }
    catch(e){ this.log('could not record progress: ' + e.message, 'warn'); }
  }
  status(){ return this.st; }
  log(msg, level){ this.app.puller.log('backfill: ' + msg, level); }

  start(opts){
    if(this.st.running) return { ok: false, error: 'a backfill is already running' };
    const pu = this.app.puller;
    if(!pu) return { ok: false, error: 'no SAP driver on this copy' };
    if((this.app.cfg.get().pull.driver || 'vbs') !== 'vbs') return { ok: false, error: 'the backfill needs the VBScript driver (Configuration > pull > driver = vbs)' };
    if(pu.child) return { ok: false, error: 'a pull cycle is running; try again in a moment' };
    const days = clamp(opts && opts.days, 1, 400, 30);
    const chunk = clamp(opts && opts.chunk, 1, 45, 7);
    const force = !!(opts && opts.force);
    /* Two different things used to be one flag. `force` means "a base was
       already pulled, do it anyway"; `redo` means "read the windows this
       run already collected a second time". The host's own button wants
       both - it is re-reading days on purpose, to fill in work the old
       code threw away. A collector on another PC wants only the first: if
       it is stopped four hours into a year and started again, the windows
       it already has are hours it should not spend twice. */
    const redo = !!(opts && opts.redo);
    /* the one-pass rule: a base already established is not driven again
       unless somebody says so on purpose */
    if(!force && this.mem.base && days >= BASE_DAYS){
      return { ok: false, error: 'a ' + this.mem.base.days + '-day base was already pulled on ' +
        new Date(this.mem.base.at).toLocaleDateString() + ' (' + this.mem.base.from + ' to ' + this.mem.base.to +
        ', ' + this.mem.base.wrote + ' days written). Tick "run it again anyway" only if that history was lost.' };
    }
    /* Anchored at noon, so stepping back in whole days across a clock change
       cannot land twice on the same date or step over one. */
    const n = new Date();
    const anchor = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12, 0, 0, 0);
    const slices = planSlices(anchor, days, chunk);
    /* a slice already collected stays collected: this is what makes a run
       that died at slice 19 of 27 cost eight exports rather than twenty-seven */
    const done = (this.mem.slices && !redo) ? this.mem.slices : {};
    /* a window that came back with nothing last time is worth another go -
       SAP may have been busy - but one that worked is not driven twice */
    const todo = slices.filter(s => !done[s.id] || done[s.id].failed);
    this.st = { running: true, startedAt: Date.now(), doneAt: null, phase: 'starting', step: 0,
                steps: todo.length, days, chunk, rows: 0, tasks: 0, written: [], missed: [], skipped: 0, error: '', note: '',
                base: this.mem.base || null, resumed: slices.length - todo.length };
    this.onChange();
    this.job = this.run(slices, todo, days, chunk, anchor)
      .catch(e => { this.st.error = e.message; this.log(e.message, 'error'); })
      .then(() => {
        this.st.running = false;
        this.st.doneAt = Date.now();
        this.st.phase = this.st.error ? 'failed' : 'done';
        /* What was just collected cannot be collected again: SAP does not
           keep warehouse tasks for ever. So it is backed up the moment it
           lands, rather than waiting for the end of a shift. */
        const wrote = this.st.written.filter(d => d.wrote).length;
        if(wrote && this.app.backup && (this.app.cfg.get().backup || {}).onBackfill !== false){
          try{ this.app.backup.run('a backfill wrote ' + wrote + ' day(s) of history', { auto: true }); }
          catch(e){ this.log('backup after backfill: ' + e.message); }
        }
        this.app.puller.hold(false);
        this.log(this.st.error ? ('stopped: ' + this.st.error) : ('done: ' + this.st.written.filter(d => d.wrote).length + ' day(s) written from ' + this.st.tasks.toLocaleString() + ' tasks'));
        this.onChange();
      });
    return { ok: true, resumed: this.st.resumed };
  }

  /* Whatever the driver just wrote into the backfill folder. The export
     lands under the configured name, but SAP has been known to choose the
     extension, so the newest file wins. */
  readExport(dir, since){
    let best = null;
    for(const name of fs.readdirSync(dir)){
      const f = path.join(dir, name);
      let st;
      try{ st = fs.statSync(f); }catch(e){ continue; }
      if(!st.isFile() || st.size === 0) continue;
      if(since && st.mtimeMs < since - 2000) continue;
      if(!best || st.mtimeMs > best.mtime) best = { path: f, name, mtime: st.mtimeMs, size: st.size };
    }
    if(!best) return null;
    const rows = rowsFromBuffer(fs.readFileSync(best.path), best.name);
    return { rows, file: best };
  }

  async run(slices, todo, days, chunk, anchor){
    const app = this.app, pu = app.puller;
    const cfg = app.cfg.get();
    const dir = path.join(app.cfg.dataDir, 'backfill');
    fs.mkdirSync(dir, { recursive: true });
    /* hold the normal cycle: one SAP session, one driver at a time */
    pu.hold(true);
    /* and hold the history file: a year of days would otherwise rewrite a
       growing file once per day, which is gigabytes of writing for nothing */
    if(app.pickers.holdSave) app.pickers.holdSave(true);
    this.log('holding the normal pull while ' + todo.length + ' wide task export(s) run' +
      (this.st.resumed ? ' (' + this.st.resumed + ' already collected by an earlier run)' : ''));

    const areaMap = (app.settings.get() || {}).wtAreaMap;
    const today = keyOf(new Date());
    const oldestWanted = slices.length ? slices[0].from : today;
    let header = null;
    const touched = {};      // day -> true, for the record pass at the end

    /* Windows are driven newest first. The recent months are the ones the
       board and the standards actually read, so if the run has to stop early
       it has already collected the part worth having - and the oldest window
       of the year, the likeliest to be empty, is no longer the one standing
       between the run and everything else. */
    let inARow = 0;
    /* planned slice id -> pieces of it still outstanding. A slice that was
       never split is one piece; splitting turns one into two. The plan's
       own id is recorded only when the last piece lands, so a run that
       dies mid-split resumes by redoing that slice and nothing else. */
    const owed = {};
    const settle = s => {
      const pid = s.parent;
      if(!pid) return;
      owed[pid] = (owed[pid] || 1) - 1;
      if(owed[pid] > 0) return;
      delete owed[pid];
      this.mem.slices = this.mem.slices || {};
      this.mem.slices[pid] = { at: Date.now(), split: true };
      this.remember();
    };
    /* A worklist rather than a loop over a fixed plan, because a window
       that comes back too big is replaced by its own two halves. */
    const queue = todo.slice().reverse();
    try{
      while(queue.length){
        const s = queue.shift();
        this.st.step++;
        this.st.phase = 'export ' + this.st.step + ' of ' + this.st.steps + ': ' + s.from + ' to ' + s.to;
        this.onChange();
        this.log(this.st.phase + ' (creation dates ' + s.backDays + ' to ' + s.toDays + ' days back, ' +
          (s.backDays - s.toDays + 1) + ' days of them, up to ' + Math.round(sliceTimeout(s) / 60000) + ' minutes)');

        /* A window that comes back with nothing is not a broken run. SAP has
           only so much history in it, and a year-old selection can return no
           rows at all or be refused outright - the driver calls both of those
           a failed export and exits 1, which used to end the whole year at
           the first month that had nothing in it. So the window is recorded
           and the next one is tried. Several in a row means something
           systemic rather than an empty month, and that does stop it. */
        /* Halve this window and try the two halves instead of writing it
           off. The ceiling is SAP's, we do not know where it is, and the
           only honest way to find it is to come down until an export
           lands. Returns false when there is one day left to file and
           nothing to halve. */
        const halve = why => {
          const halves = split(s, anchor);
          if(!halves) return false;
          owed[halves[0].parent] = (owed[halves[0].parent] || 1) + 1;
          queue.unshift(halves[0], halves[1]);
          this.st.steps++;
          this.st.step--;
          this.log(s.from + ' to ' + s.to + ': ' + why + '; trying it as ' +
            halves[1].from + '..' + halves[1].to + ' and ' + halves[0].from + '..' + halves[0].to, 'warn');
          this.onChange();
          return true;
        };
        const giveUp = why => {
          this.st.missed.push({ from: s.from, to: s.to, why });
          this.mem.slices = this.mem.slices || {};
          this.mem.slices[s.id] = { at: Date.now(), failed: true, why };
          this.remember();
          /* a piece that failed still accounts for itself; the parent is
             recorded as failed too, so a later run comes back for it */
          if(s.parent && s.parent !== s.id){
            this.mem.slices[s.parent] = { at: Date.now(), failed: true, why };
            delete owed[s.parent];
          }
          this.log(s.from + ' to ' + s.to + ': nothing usable - ' + why, 'warn');
          this.onChange();
          if(++inARow >= GIVE_UP_AFTER)
            throw new Error(inARow + ' windows in a row came back with nothing (' + why +
              '). Stopping rather than driving SAP over the rest; press it again to carry on from here.');
        };

        // clear the folder so the newest file can only be this run's export
        for(const n of fs.readdirSync(dir)){ try{ fs.unlinkSync(path.join(dir, n)); }catch(e){} }
        const at = Date.now();
        /* The driver is told a ceiling and reports back rather than
           exporting past it. A cycle answers that by narrowing its own
           lookback; this answers it by halving the window and trying
           again, which is the only thing that gets the day filed. */
        const r = await pu.runOnce('wt', { ReportDir: dir, WhFile: cfg.files.wh,
          WtBackDays: s.backDays, WtToDays: s.toDays, WtMaxRows: BIG_ROWS }, sliceTimeout(s));
        /* SAP itself being gone is the whole run: the next twenty-six exports
           would fail the same way and there is nothing to learn from them */
        if(!r.ok && (r.code === 2 || r.code === 3 || r.code === 4))
          throw new Error('SAP stopped answering at the ' + s.from + ' to ' + s.to + ' window (' + (r.error || 'code ' + r.code) +
            '). Log back in and press it again; the windows already collected are kept.');
        /* A slice that ran out of time is not an empty window, and saying
           so is the difference between "SAP has nothing that far back" and
           "ask for fewer days per export". */
        /* The driver counted the grid before exporting and it is past the
           ceiling: cheap to find out, so this is the first thing tried. */
        if(r.tooBig && !r.tooBig.exporting){
          const n = r.tooBig.rows.toLocaleString();
          if(halve(n + ' rows is past the ' + r.tooBig.max.toLocaleString() + ' asked for')) continue;
          giveUp('one day came back with ' + n + ' rows, which is past the ceiling on its own; ' +
                 'there is nothing left to narrow');
          continue;
        }
        if(!r.ok && r.timedOut){
          if(halve(r.error)) continue;
          giveUp(r.error + ' on a single day, which is as narrow as a window gets');
          continue;
        }
        /* A window SAP has nothing for and a window SAP choked on look the
           same from out here - both are a failed export and exit code 1 -
           but the driver says which. "No warehouse task grid found" is an
           archived month and halving it would drive SAP over nothing twice
           more. A failure at the export step means the grid was there and
           had rows in it: that is the one worth coming down for, because a
           grid big enough to dump takes the export dialog with it and all
           the driver sees is a control that is not there. */
        if(!r.ok){
          const why = r.error || 'the driver exited with code ' + r.code;
          if(/export:/i.test(why + ' ' + (r.note || '')) &&
             halve('the grid was there but the export did not come back (' + why + ')')) continue;
          giveUp(why);
          continue;
        }

        let got = null;
        try{ got = this.readExport(dir, at); }
        catch(e){ giveUp('the export could not be read: ' + e.message); continue; }
        if(!got){ giveUp('no export file appeared'); continue; }

        const h = model.headerIndex(got.rows, ['warehouse task'], 12);
        if(h < 0){ giveUp('the export has no Warehouse Task header'); continue; }
        const find = model.makeFinder(model.norm(got.rows[h]));
        const cDate = find('confirmation date');
        if(cDate < 0) throw new Error('the task export has no Confirmation Date column, so there is no day to file these under');
        if(!header) header = got.rows[h];
        else if(model.norm(got.rows[h]).join('|') !== model.norm(header).join('|'))
          throw new Error('the export changed shape between windows; run it again with the same layout selected in SAP');

        const read = got.rows.length - h - 1;
        if(read > MAX_ROWS) throw new Error(read.toLocaleString() + ' rows in one window, over the ' + MAX_ROWS.toLocaleString() + ' rail; run it again with fewer days per export');
        inARow = 0;

        /* file by confirmation day, keeping only the days this slice can see
           whole - the lead-in days belong to the slice before it */
        const byDay = new Map();
        for(let i = h + 1; i < got.rows.length; i++){
          const row = got.rows[i];
          if(!row) continue;
          const d = model.parseExcelDate(row[cDate]);
          if(!d) continue;
          const k = keyOf(d);
          if(k < s.from || k > s.to) continue;
          if(!byDay.has(k)) byDay.set(k, []);
          byDay.get(k).push(row);
        }
        got = null;    // the rows go now, before the next slice is read

        const keys = Array.from(byDay.keys()).sort();
        for(const k of keys){
          const res = app.pickers.observeIfBetter([header].concat(byDay.get(k)), k, areaMap);
          /* the oldest day of the whole range is short by nature: its own
             lead-in reaches back before anything SAP was asked for */
          res.partial = (k <= oldestWanted);
          res.future = k > today;
          this.st.written.push(res);
          if(!res.wrote) this.st.skipped++;
          touched[k] = true;
        }
        byDay.clear();
        if(app.pickers.flushSave) app.pickers.flushSave();

        this.st.rows += read;
        this.st.tasks = this.st.rows;
        this.mem.slices = this.mem.slices || {};
        this.mem.slices[s.id] = { at: Date.now(), days: keys.length, rows: read };
        this.remember();
        settle(s);
        this.onChange();
        this.log(s.from + ' to ' + s.to + ': ' + read.toLocaleString() + ' rows read, ' + keys.length + ' day(s) filed');
      }
    } finally {
      if(app.pickers.holdSave) app.pickers.holdSave(false);
    }

    if(!this.st.rows && !this.st.resumed) throw new Error('no tasks came back at all; check the Pull log for what SAP said');

    /* The daily record behind the recommended standards. Rebuilding it is a
       thirty-day report per day per shift, so a year of it is slow enough to
       be worth saying out loud - and the standards only ever read the recent
       end of it, so the rest is work nobody would see. */
    const recDays = Object.keys(touched).sort().slice(-120);
    if(app.recommend && recDays.length){
      let n = 0;
      for(const k of recDays){
        this.st.phase = 'writing the daily record (' + (++n) + ' of ' + recDays.length + ')';
        if(n % 10 === 0) this.onChange();
        app.recommend.snapshot(k);
      }
    }

    const wrote = this.st.written.filter(d => d.wrote);
    const allDone = slices.every(x => (this.mem.slices || {})[x.id]);
    if(allDone && days >= BASE_DAYS){
      this.mem.base = { at: Date.now(), days, chunk, from: slices[0].from, to: slices[slices.length - 1].to,
                        wrote: Object.keys(touched).length };
      this.st.base = this.mem.base;
      this.remember();
    }
    this.st.note = wrote.length + ' day(s) written, ' + this.st.skipped + ' left alone' +
      (this.st.missed.length ? '. ' + this.st.missed.length + ' window(s) came back with nothing (' +
        this.st.missed.map(m => m.from.slice(0, 7)).filter((v, i, a) => a.indexOf(v) === i).join(', ') +
        ') - either SAP has no tasks that far back or it refused the selection; pressing the button again retries just those.' : '') +
      (this.st.resumed ? '. ' + this.st.resumed + ' slice(s) were already collected by an earlier run.' : '') +
      (wrote.some(d => d.partial) ? ' The oldest day is short by nature: SAP selects by creation date, so picks confirmed then from older tasks are in no export.' : '') +
      (recDays.length && recDays.length < Object.keys(touched).length
        ? ' The standards record was rebuilt for the most recent ' + recDays.length + ' days, which is all it reads.' : '');
    this.st.phase = 'done';
  }
}

module.exports = { Backfill, planSlices, sliceTimeout, LEAD_IN, BASE_DAYS };
