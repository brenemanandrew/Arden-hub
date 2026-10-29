'use strict';
/* What a day of work is worth, which shift an hour belongs to, what
   identifies a delivery line, and which bins are not really benches.

   The pack model borrowed all of this from the picker settings when it
   lived inside Staging Lane Health - one number, both pages. Out here
   there is no picker page, so it is kept in a small file of its own and
   the same shape is handed to the model, so the model did not have to
   change to move house.

   Everything has a working default. Nothing has to be set for the board
   to come up. */

const fs = require('fs');
const path = require('path');
const schedule = require('./schedule');

const DEFAULTS = {
  /* a paid shift with the breaks taken out: what one person's day is
     worth at most, however long their scans run */
  dayHours: 6.5,
  /* longer than this between scans and they were doing something else */
  windowMin: 30,
  /* the task columns that identify a delivery line. Blank lets the model
     work it out from the export, which it does well. */
  lineKey: '',
  /* bins that look like pack benches and are not - BOL, a hidden pack
     area. They take work in and never ship, and sat at the bottom of the
     board flagged as filling up for ever. */
  hideBins: 'PK19, PK26, PK27',
  /* PK01-PK06 are truck pack; everything else is parcel */
  truckBins: 'PK01-PK06',
  schedule: ''
};

class Settings {
  constructor(file, log){
    this.file = file;
    this.log = log || (() => {});
    this.values = Object.assign({}, DEFAULTS);
    this.load();
  }
  load(){
    try{
      const t = fs.readFileSync(this.file, 'utf8');
      const v = JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
      if(v && typeof v === 'object') this.values = Object.assign({}, DEFAULTS, v);
    }catch(e){}
  }
  save(){
    try{
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    }catch(e){ this.log('settings: ' + e.message); }
  }
  set(patch){
    if(!patch || typeof patch !== 'object') return this.values;
    for(const k of Object.keys(DEFAULTS)) if(patch[k] != null) this.values[k] = patch[k];
    this.save();
    return this.values;
  }
  /* the shape the pack model asks for. It calls this `pickers.settings()`
     because that is where it used to come from; the name stayed so the
     model did not have to be edited to move. */
  settings(){
    const v = this.values;
    const text = schedule.effectiveText(v.schedule);
    return {
      dayHours: (+v.dayHours > 0) ? +v.dayHours : DEFAULTS.dayHours,
      windowMin: (+v.windowMin > 0) ? +v.windowMin : DEFAULTS.windowMin,
      lineKey: String(v.lineKey || '').split(',').map(x => x.trim()).filter(Boolean),
      hideBins: String(v.hideBins == null ? DEFAULTS.hideBins : v.hideBins)
        .split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
      scheduleText: text,
      sched: schedule.parseSchedule(text)
    };
  }
}

module.exports = { Settings, DEFAULTS };
