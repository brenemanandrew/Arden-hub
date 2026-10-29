'use strict';
/* Board settings (lanes, thresholds, colours, panels) kept once on the host
   so every screen shows the same board. The old build kept these in each
   browser's IndexedDB, which meant every TV had to be set up by hand. */
const fs = require('fs');
const path = require('path');

class Settings {
  constructor(cfg, log){
    this.file = path.join(cfg.dataDir, 'board-settings.json');
    this.log = log || (() => {});
    this.value = null;
    try{ this.value = JSON.parse(fs.readFileSync(this.file, 'utf8')); }catch(e){ this.value = null; }
    this.timer = null;
  }
  get(){ return this.value; }
  set(v){
    this.value = v;
    if(this.onChange) try{ this.onChange(v); }catch(e){}
    if(this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try{ fs.writeFileSync(this.file, JSON.stringify(this.value)); }catch(e){ this.log('settings save failed: ' + e.message); }
    }, 300);
  }
}

module.exports = { Settings };
