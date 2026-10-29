'use strict';
/* Configuration and data directory.
   Everything the app writes lives under one data directory so nothing needs
   admin rights and a fresh PC only needs the folder to exist. Order of
   precedence: command line, environment, config.json, defaults. */
const fs = require('fs');
const path = require('path');
const os = require('os');

/* The folder the app was started from - where "Start Staging Lane Health.cmd"
   and the server and web folders live. The SAP exports land here, so the
   spreadsheets sit beside the thing that produced them and a person looking
   for "today's WHTask" finds it in the folder they already opened. */
const APP_ROOT = path.resolve(__dirname, '..');
/* Where the exports used to go, which is also where the retired VBS puller
   and the old folder-reading board put and looked for them. Only used now to
   recognise a copy that has never been moved. */
const LEGACY_REPORT_DIR = 'C:' + String.fromCharCode(92) + 'REPORT';

const DEFAULTS = {
  port: 8480,
  host: '0.0.0.0',
  reportDir: APP_ROOT,
  files: { stage: 'HU STAGING.XLSX', orders: 'Orders.XLSX', wh: 'WHTask.XLSX' },
  pull: {
    enabled: true,          // drive SAP from this PC. false = only read the folder
    driver: 'vbs',          // 'vbs' (cscript, what reaches SAP GUI on the floor PCs) or 'ps1'
    intervalSec: 30,        // pause between cycles
    cycleTimeoutSec: 300,   // kill a cycle that hangs longer than this
    lookbackDays: 3,        // order pull FROM date = today minus this
    wtBackDays: 3,
    /* The delivery value off ECC (VL06O), which EWM does not carry. Its
       own clock and off by default: it needs an ECC session logged in on
       this PC beside the EWM one, and if that is not there it must cost
       the board nothing. */
    deliveries: { enabled: false, everyMin: 30, variant: 'ARDEN_OPEN_DEL',
                  delFile: 'SAP Deliveries.TXT', pgiFile: 'SAP PGI.TXT', timeoutSec: 420 },          // task pull: how many days of CREATION dates to fetch.
                            // A task created before this window but picked today
                            // is invisible, which understates every pick rate.
    /* Putting SAP back when it falls over. The Okta link is the app tile's
       own address - the one that downloads a SAP GUI shortcut - and until
       somebody pastes it here nothing is ever closed, because closing a
       session this cannot reopen would be worse than the crash. */
    recover: { enabled: true, oktaUrl: '', staleMin: 10, maxPerHour: 3, downloadDir: '', shortcut: '',
               clickNames: '', clickSec: 25, shortcutHours: 2, shortcutReadySec: 75 },
    /* The pack benches. The same handling unit export as the staging one,
       asked for the PK bins instead of the lanes, into its own file - so
       what is standing at each bench can be seen at all. Run from the
       Admin page; it is not part of the minute cycle, because a bench
       queue does not change as fast as a lane does. */
    pack: { bins: 'PK*', file: 'PACK HU.XLSX' },
    settleMs: 4000,         // wait for Excel to open an export before closing it
    switchMs: 6000,         // wait between exports
    warehouse: '0103',
    monitor: 'zarden',
    dateFormat: 'MM/dd/yyyy', // SAP user profile date format, typed only as a fallback
    idleStopMin: 10,        // stop driving SAP when no viewer has been connected this long. 0 = never
    recycleEvery: 120,      // open a fresh SAP session and close the old one every this many cycles,
                            // which hands back the memory a long-running session hoards. 0 = never
    nodes: {                // monitor tree nodes. Keys are positional; a label is used first when set
      hu:     { key: 'N000000211', expand: ['C000000011', 'N000000014'], label: '', parent: '' },
      orders: { key: 'N000000011', expand: [], label: '', parent: '' },
      wt:     { key: 'N000000275', expand: ['N000000108'], label: 'Warehouse Task', parent: 'Documents' }
    },
    binPatterns: ['e*', 'I*', 'D8*', 'F*', 'TOTE*']
  },
  dwell: { capHours: 50, windowDays: 30, gapHours: 2 },
  compat: { writeLegacyFiles: true },  // hu_heartbeat.txt / sap_status.txt for the old board
  pickers: {
    targets: '',          // "Flow = 65" per line; blank uses the built-in defaults
    activeMin: 30,        // a confirmation counts the person working for this long
    hide: '',             // comma separated user ids to leave off the board
    minPicks: 0,          // below this many picks a person is listed aside, not ranked
    lineKey: '',          // task column(s) identifying a delivery line; blank = a task is a line
    dayHours: 6.5,        // true picking hours in a shift, breaks taken out
    prodFloor: 75,        // productive time (active hours against those picking hours) reads green from this percent
    /* Where percent of standard turns green and amber. One definition for
       every page: it used to be 100/85 on the review and the People page and
       100/90 on the picker page and the month gallery, so the same person
       read differently depending on which screen somebody opened.

       Green from 95 rather than 100 is deliberate. A picker at 94 is better
       than half this floor, and a screen that paints them amber is calling a
       good day a warning. Moving this line changes what the numbers LOOK
       like and nobody's rate by a single pick - which is the honest way to
       make success read as success, as against moving the standard and
       telling ninety people they got slower overnight. */
    bands: { good: 95, warn: 85 },
    /* The review page's own knobs, kept here rather than in the code
       because they are the things that get argued about: how long somebody
       has to have picked for the day to count, which windows a review is
       read over, and whether a day longer than the picking hours is allowed
       to read past 100%. Everything else on that page is the same
       arithmetic as the picker board. */
    review: {
      windows: [5, 10, 15, 20],   // worked days, four of them, shown as a trend
      minHours: 2,                // under this much picking and it was not a picking day
      capProd: true,              // hold productive time at 100% rather than showing 110%
      /* SAP's activity codes in words. A floor that starts confirming a code
         nobody listed gets the code itself on the page rather than a guess,
         and somebody types the line - which is cheaper than a release. */
      actLabels: 'INTL = internal moves\nPICK = picking\nZLOD = pack to loading\nREPL = replenishment\nPTWY = putaway\nDPUT = direct putaway\nADJT = stock adjustment (cycle count)',
      peerMinShare: 34            // % of the subject's days a peer needs to be compared at all
    },
    /* the working week, one shift per line: days, name, start-end, breaks
       as clock time = minutes. Shifts, breaks and closed hours all come from
       this; blank means the built-in week, the word none means no schedule */
    schedule: ''
  },
  mode: 'host',           // 'host' = next to SAP, reads the folder; 'cloud' = fed by pushes
  cloud: { enabled: false, url: '', secret: '', insecureTls: false,   // host -> cloud copy
           leaseMin: 10 },   // on the cloud copy: one host feeds it at a time; another may take over once this many minutes pass without a push
  /* Backups of the data folder, taken by the app itself: always to the cloud
     copy, and to a folder on this PC. These two stay blank unless somebody
     wants them somewhere other than the data folder - a share, a second
     drive - in which case a path is typed on the Admin page. */
  /* when a backup is taken. Every one of these is a moment the data is
     worth more than it was a minute ago, or the last moment there is. */
  backup: { dir: '', reportsDir: '', onShiftEnd: true, onSapDown: true,
            onClose: true,          // the service is stopping, for any reason
            onBackfill: true,       // a backfill just wrote months of history
            beforeRestore: true,    // about to write over what is here
            everyHours: 12 },       // and a floor under all of it; 0 turns it off
  /* a folder the host watches for command files - one that syncs from
     somewhere the person is, a Google Drive folder say. Blank = off. */
  control: { dir: '' },
  auth: { viewerPassword: '',                        // blank = no login (fine on a LAN)
          /* the wall panel is not for everyone who can open the board, so on
             the cloud copy it sits behind five taps on the logo and this. Not
             a secret worth defending - it keeps a floor screen out of casual
             reach, and anyone who is already past the viewer password is
             trusted. Blank turns the hidden way in off altogether. */
          quadCode: '2468' }
};

/* A file saved by Notepad, or by a PowerShell script using the obvious
   encoding, comes back with a byte-order mark on the front, and JSON.parse
   refuses it outright. Losing a config to an invisible character is not a
   failure worth having. */
function stripBom(t){ return (t && t.charCodeAt(0) === 0xFEFF) ? t.slice(1) : t; }

function deepMerge(base, over){
  if(!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for(const k of Object.keys(over)){
    const v = over[k];
    if(v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])){
      out[k] = deepMerge(base[k], v);
    } else out[k] = v;
  }
  return out;
}

function parseArgs(argv){
  const a = {};
  for(let i = 0; i < argv.length; i++){
    const s = argv[i];
    if(s === '--no-pull') a.noPull = true;
    /* collecting history on a PC that is not the host: run the backfill,
       write what it got, stop. Nothing is pushed and nobody is watching. */
    else if(s === '--collect') a.collect = true;
    else if(s === '--collect-days') a.collectDays = parseInt(argv[++i], 10);
    else if(s === '--collect-chunk') a.collectChunk = parseInt(argv[++i], 10);
    else if(s === '--collect-out') a.collectOut = argv[++i];
    else if(s === '--no-open') a.noOpen = true;
    else if(s === '--port') a.port = parseInt(argv[++i], 10);
    else if(s === '--report-dir') a.reportDir = argv[++i];
    else if(s === '--data-dir') a.dataDir = argv[++i];
    else if(s === '--host') a.host = argv[++i];
  }
  return a;
}

function defaultDataDir(){
  if(process.env.SLH_DATA) return process.env.SLH_DATA;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'StagingLaneHealth');
}

class Config {
  constructor(argv){
    this.args = parseArgs(argv || []);
    this.dataDir = path.resolve(this.args.dataDir || defaultDataDir());
    this.file = path.join(this.dataDir, 'config.json');
    for(const d of ['', 'logs', 'dwell', 'reports']){
      try{ fs.mkdirSync(path.join(this.dataDir, d), { recursive: true }); }catch(e){}
    }
    this.load();
  }
  load(){
    let saved = {};
    try{ saved = JSON.parse(stripBom(fs.readFileSync(this.file, 'utf8'))); }catch(e){ saved = {}; }
    this.saved = saved;
    this.values = deepMerge(DEFAULTS, saved);
    this.applyOverrides();
    return this.values;
  }
  applyOverrides(){
    const v = this.values, a = this.args;
    if(a.port) v.port = a.port;
    if(a.host) v.host = a.host;
    if(a.reportDir) v.reportDir = path.resolve(a.reportDir);
    if(a.noPull) v.pull.enabled = false;
    /* A collector drives its own SAP and nothing else. Pushing from here
       would put a second PC in front of the cloud copy and take the lease
       off the real host, which is the one thing this must not do. */
    if(a.collect){
      v.cloud = Object.assign({}, v.cloud, { enabled: false });
      v.backup = Object.assign({}, v.backup, { onShiftEnd: false, onSapDown: false, everyHours: 0 });
      v.compat = Object.assign({}, v.compat, { writeLegacyFiles: false });
    }
    if(process.env.SLH_PORT) v.port = parseInt(process.env.SLH_PORT, 10) || v.port;
    if(process.env.SLH_REPORT_DIR) v.reportDir = process.env.SLH_REPORT_DIR;
    if(process.env.PORT && !a.port) v.port = parseInt(process.env.PORT, 10) || v.port;
    if(process.env.SLH_MODE) v.mode = process.env.SLH_MODE === 'cloud' ? 'cloud' : 'host';
    if(process.env.SLH_INGEST_SECRET) v.cloud.secret = process.env.SLH_INGEST_SECRET;
    if(process.env.SLH_VIEWER_PASSWORD) v.auth.viewerPassword = process.env.SLH_VIEWER_PASSWORD;
  }
  get(){ return this.values; }
  /* Save a partial update. Only keys the caller sends are changed; overrides
     from the command line still win for this process. */
  update(patch){
    const cleaned = sanitize(patch);
    this.saved = deepMerge(this.saved, cleaned);
    fs.writeFileSync(this.file, JSON.stringify(this.saved, null, 2));
    this.values = deepMerge(DEFAULTS, this.saved);
    this.applyOverrides();
    return this.values;
  }
  defaults(){ return DEFAULTS; }
}

/* Keep config writes to known keys and sane types so a bad admin form
   cannot wedge the server. */
function sanitize(p){
  const out = {};
  if(!p || typeof p !== 'object') return out;
  if(p.port != null){ const n = parseInt(p.port, 10); if(n > 0 && n < 65536) out.port = n; }
  if(typeof p.reportDir === 'string' && p.reportDir.trim()) out.reportDir = p.reportDir.trim();
  // written once by the move below, so it is never done twice
  if(p.reportDirMoved != null) out.reportDirMoved = !!p.reportDirMoved;
  if(p.files && typeof p.files === 'object'){
    out.files = {};
    for(const k of ['stage', 'orders', 'wh']) if(typeof p.files[k] === 'string' && p.files[k].trim()) out.files[k] = p.files[k].trim();
  }
  if(p.pull && typeof p.pull === 'object'){
    const q = p.pull, o = {};
    if(q.enabled != null) o.enabled = !!q.enabled;
    /* a patch, merged onto what is there - the same lesson the pickers
       block taught: a one-field write must not wipe the rest */
    if(q.deliveries && typeof q.deliveries === 'object'){
      const d = Object.assign({}, (out.pull && out.pull.deliveries) || {});
      if(q.deliveries.enabled != null) d.enabled = !!q.deliveries.enabled;
      for(const k of ['everyMin', 'timeoutSec']) if(q.deliveries[k] != null && isFinite(+q.deliveries[k])) d[k] = Math.max(1, +q.deliveries[k]);
      for(const k of ['variant', 'delFile', 'pgiFile']) if(typeof q.deliveries[k] === 'string') d[k] = q.deliveries[k];
      o.deliveries = d;
    }
    for(const k of ['intervalSec', 'cycleTimeoutSec', 'lookbackDays', 'wtBackDays', 'settleMs', 'switchMs', 'idleStopMin', 'recycleEvery']){
      if(q[k] != null && isFinite(+q[k])) o[k] = Math.max(0, +q[k]);
    }
    if(o.intervalSec != null) o.intervalSec = Math.max(5, o.intervalSec);
    if(o.cycleTimeoutSec != null) o.cycleTimeoutSec = Math.max(60, o.cycleTimeoutSec);
    if(o.lookbackDays != null) o.lookbackDays = Math.min(30, Math.max(0, Math.round(o.lookbackDays)));
    if(o.wtBackDays != null) o.wtBackDays = Math.min(30, Math.max(0, Math.round(o.wtBackDays)));
    for(const k of ['warehouse', 'monitor', 'dateFormat']) if(typeof q[k] === 'string') o[k] = q[k].trim();
    if(q.driver === 'vbs' || q.driver === 'ps1') o.driver = q.driver;
    if(q.nodes && typeof q.nodes === 'object'){
      o.nodes = {};
      for(const n of ['hu', 'orders', 'wt']){
        const src = q.nodes[n]; if(!src || typeof src !== 'object') continue;
        const d = {};
        if(typeof src.key === 'string') d.key = src.key.trim();
        if(typeof src.label === 'string') d.label = src.label.trim();
        if(typeof src.parent === 'string') d.parent = src.parent.trim();
        if(Array.isArray(src.expand)) d.expand = src.expand.map(String).filter(Boolean);
        o.nodes[n] = d;
      }
    }
    if(Array.isArray(q.binPatterns)) o.binPatterns = q.binPatterns.map(String).map(s => s.trim()).filter(Boolean).slice(0, 8);
    /* the pack bench export: which bins, and what to call the file */
    if(q.pack && typeof q.pack === 'object'){
      const k = {};
      for(const f of ['bins', 'file']) if(typeof q.pack[f] === 'string' && q.pack[f].trim()) k[f] = q.pack[f].trim();
      o.pack = k;
    }
    /* putting SAP back when it falls over. The link is the only thing that
       has to be right; everything else has a sensible default. */
    if(q.recover && typeof q.recover === 'object'){
      const r = q.recover, v = {};
      if(r.enabled != null) v.enabled = !!r.enabled;
      for(const k of ['oktaUrl', 'downloadDir', 'shortcut', 'lastShortcut', 'clickNames']) if(typeof r[k] === 'string') v[k] = r[k].trim();
      if(r.clickSec != null && isFinite(+r.clickSec)) v.clickSec = Math.max(0, Math.min(120, +r.clickSec));
      /* 0 hours means never reuse a downloaded shortcut: Okta reissues them,
         so this is only ever a shot at a second outage soon after the first */
      if(r.shortcutHours != null && isFinite(+r.shortcutHours)) v.shortcutHours = Math.max(0, Math.min(72, +r.shortcutHours));
      if(r.shortcutReadySec != null && isFinite(+r.shortcutReadySec)) v.shortcutReadySec = Math.max(15, Math.min(600, +r.shortcutReadySec));
      if(r.staleMin != null && isFinite(+r.staleMin)) v.staleMin = Math.max(2, Math.min(240, +r.staleMin));
      if(r.maxPerHour != null && isFinite(+r.maxPerHour)) v.maxPerHour = Math.max(0, Math.min(12, +r.maxPerHour));
      o.recover = v;
    }
    out.pull = o;
  }
  if(p.dwell && typeof p.dwell === 'object'){
    out.dwell = {};
    for(const k of ['capHours', 'windowDays', 'gapHours']) if(p.dwell[k] != null && isFinite(+p.dwell[k])) out.dwell[k] = Math.max(0.1, +p.dwell[k]);
  }
  if(p.compat && typeof p.compat === 'object' && p.compat.writeLegacyFiles != null) out.compat = { writeLegacyFiles: !!p.compat.writeLegacyFiles };
  if(p.pickers && typeof p.pickers === 'object'){
    /* a patch, not a replacement. This threw everything else away and only
       ever got away with it because the Configuration page happens to send
       the whole block every time; anything sending one field - a button
       that sets the line key, say - silently wiped the targets, the day
       hours and the schedule. */
    out.pickers = Object.assign({}, out.pickers || {});
    if(typeof p.pickers.targets === 'string') out.pickers.targets = p.pickers.targets;
    if(p.pickers.activeMin != null && isFinite(+p.pickers.activeMin)) out.pickers.activeMin = Math.max(5, Math.min(240, +p.pickers.activeMin));
    if(typeof p.pickers.hide === 'string') out.pickers.hide = p.pickers.hide;
    if(p.pickers.minPicks != null && isFinite(+p.pickers.minPicks)) out.pickers.minPicks = Math.max(0, Math.min(1000, +p.pickers.minPicks));
    if(typeof p.pickers.lineKey === 'string') out.pickers.lineKey = p.pickers.lineKey;
    if(p.pickers.dayHours != null && isFinite(+p.pickers.dayHours)) out.pickers.dayHours = Math.max(1, Math.min(24, +p.pickers.dayHours));
    if(p.pickers.shiftHours != null && isFinite(+p.pickers.shiftHours)) out.pickers.shiftHours = Math.max(1, Math.min(24, +p.pickers.shiftHours));
    if(p.pickers.prodFloor != null && isFinite(+p.pickers.prodFloor)) out.pickers.prodFloor = Math.max(0, Math.min(100, Math.round(+p.pickers.prodFloor)));
    if(p.pickers.bands && typeof p.pickers.bands === 'object'){
      /* only what was sent, so a one-field save does not wipe the other */
      const b = {}, q = p.pickers.bands;
      if(q.good != null && isFinite(+q.good)) b.good = Math.max(1, Math.min(300, Math.round(+q.good)));
      if(q.warn != null && isFinite(+q.warn)) b.warn = Math.max(0, Math.min(300, Math.round(+q.warn)));
      /* amber below green, always - the other way round paints a worse
         number a better colour */
      const now = Object.assign({}, (out.pickers.bands || DEFAULTS.pickers.bands), b);
      if(now.warn > now.good) b.warn = now.good;
      out.pickers.bands = b;
    }
    if(typeof p.pickers.shiftStarts === 'string') out.pickers.shiftStarts = p.pickers.shiftStarts;
    if(typeof p.pickers.schedule === 'string') out.pickers.schedule = p.pickers.schedule;
    if(p.pickers.review && typeof p.pickers.review === 'object'){
      /* ONLY the fields that were sent. update() deep merges what comes
         back out of here onto the saved config, so emitting a whole object
         with defaults in the gaps is how a one-field save wipes the rest -
         which is the bug the picker block above already carries a note
         about, and this walked straight into it. */
      const rv = {};
      const q = p.pickers.review;
      if(Array.isArray(q.windows) || typeof q.windows === 'string'){
        const list = (Array.isArray(q.windows) ? q.windows : String(q.windows).split(','))
          .map(x => Math.round(+String(x).trim())).filter(n => isFinite(n) && n >= 1 && n <= 120);
        /* four at most, in order, no repeats - the page draws four cards */
        const seen = [];
        for(const n of list) if(seen.indexOf(n) < 0) seen.push(n);
        if(seen.length) rv.windows = seen.sort((a, b) => a - b).slice(0, 4);
      }
      if(q.minHours != null && isFinite(+q.minHours)) rv.minHours = Math.max(0, Math.min(12, +q.minHours));
      if(q.capProd != null) rv.capProd = !!q.capProd;
      if(typeof q.actLabels === 'string') rv.actLabels = q.actLabels.slice(0, 4000);
      if(q.peerMinShare != null && isFinite(+q.peerMinShare)) rv.peerMinShare = Math.max(0, Math.min(100, Math.round(+q.peerMinShare)));
      out.pickers.review = rv;
    }
  }
  if(p.cloud && typeof p.cloud === 'object'){
    out.cloud = {};
    if(p.cloud.enabled != null) out.cloud.enabled = !!p.cloud.enabled;
    if(typeof p.cloud.url === 'string') out.cloud.url = p.cloud.url.trim();
    if(typeof p.cloud.secret === 'string') out.cloud.secret = p.cloud.secret.trim();
    if(p.cloud.insecureTls != null) out.cloud.insecureTls = !!p.cloud.insecureTls;
  }
  if(p.backup && typeof p.backup === 'object'){
    out.backup = {};
    if(typeof p.backup.dir === 'string'){
      out.backup.dir = p.backup.dir.trim();
      /* whoever sets a path says how it was arrived at; a write that does not
         say is a person typing it on the Admin page */
      out.backup.dirAuto = p.backup.dirAuto === true;
    }
    if(typeof p.backup.reportsDir === 'string'){
      out.backup.reportsDir = p.backup.reportsDir.trim();
      out.backup.reportsDirAuto = p.backup.reportsDirAuto === true;
    }
    if(p.backup.onShiftEnd != null) out.backup.onShiftEnd = !!p.backup.onShiftEnd;
    if(p.backup.onSapDown != null) out.backup.onSapDown = !!p.backup.onSapDown;
    if(p.backup.onClose != null) out.backup.onClose = !!p.backup.onClose;
    if(p.backup.onBackfill != null) out.backup.onBackfill = !!p.backup.onBackfill;
    if(p.backup.beforeRestore != null) out.backup.beforeRestore = !!p.backup.beforeRestore;
    if(p.backup.everyHours != null){ const n = Number(p.backup.everyHours); if(n >= 0 && n <= 24 * 30) out.backup.everyHours = n; }
  }
  if(p.control && typeof p.control === 'object'){
    out.control = {};
    if(typeof p.control.dir === 'string') out.control.dir = p.control.dir.trim();
  }
  if(p.auth && typeof p.auth === 'object'){
    out.auth = {};
    if(typeof p.auth.viewerPassword === 'string') out.auth.viewerPassword = p.auth.viewerPassword;
    if(typeof p.auth.quadCode === 'string') out.auth.quadCode = p.auth.quadCode.trim();
  }
  return out;
}

/* ---- moving the exports into the app folder ----

   Older copies put the SAP exports in C:\REPORT, which is where the VBS
   puller this app replaced used to write them. Nothing reads that folder any
   more, and a spreadsheet three folders away from the app that made it is a
   spreadsheet nobody finds. So a copy that is still on the old folder moves
   itself once, brings whatever is in there along, and writes a flag so it is
   never done again.

   It only ever fires for a copy sitting on the shipped default. A folder
   somebody actually chose is left alone, and so is one named on the command
   line or in the environment - being told where to look is an instruction,
   not a setting to be tidied away. */
function migrateReportDir(cfg, log, legacy, target){
  log = log || (() => {});
  const say = m => log('report folder: ' + m);
  const LEGACY = legacy || LEGACY_REPORT_DIR, HERE = target || APP_ROOT;
  if(cfg.args.reportDir || process.env.SLH_REPORT_DIR) return null;   // told where to look
  if(cfg.saved.reportDirMoved) return null;                          // already done
  const from = path.resolve(cfg.saved.reportDir || LEGACY);
  const to = path.resolve(HERE);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if(same(from, to)){ cfg.update({ reportDirMoved: true }); return null; }
  /* a folder somebody picked is theirs; only the shipped default moves */
  if(!same(from, path.resolve(LEGACY))) return null;

  const c = cfg.get();
  /* the exports by their configured names, whatever else in there looks like
     one of them, and the two heartbeat files the retired board watched */
  const wanted = [c.files.stage, c.files.orders, c.files.wh, 'hu_heartbeat.txt', 'sap_status.txt', 'hu_pull_log.txt'];
  const looksLikeExport = n => /(staging|order|wh ?task|whse ?task|warehouse ?task)/i.test(n) && /\.(xlsx|xls|csv)$/i.test(n);
  let names = [];
  try{ names = fs.readdirSync(from); }catch(e){ names = []; }
  const move = names.filter(n => wanted.some(w => w && w.toLowerCase() === n.toLowerCase()) || looksLikeExport(n));

  let moved = 0, kept = 0, failed = 0;
  for(const n of move){
    const src = path.join(from, n), dst = path.join(to, n);
    try{
      const ss = fs.statSync(src);
      if(!ss.isFile()) continue;
      /* anything already here and newer is the better copy: the app has been
         writing to the new folder since it started, and the old one is stale */
      let ds = null;
      try{ ds = fs.statSync(dst); }catch(e){}
      if(ds && ds.mtimeMs >= ss.mtimeMs){ kept++; continue; }
      fs.copyFileSync(src, dst);
      if(fs.statSync(dst).size !== ss.size) throw new Error('copied short');
      try{ fs.unlinkSync(src); }catch(e){ say('copied ' + n + ' but could not remove the old one (' + e.message + '); it is stale from now on'); }
      moved++;
    }catch(e){ failed++; say('could not move ' + n + ': ' + e.message); }
  }

  /* The heartbeat pair and the dwell mirror existed for the old board, which
     is retired. Writing them into the app folder would be clutter nobody
     reads, so they go off with the move; the switch stays in Admin. */
  cfg.update({ reportDir: to, reportDirMoved: true, compat: { writeLegacyFiles: false } });
  say('moved from ' + from + ' to ' + to +
      ' (' + moved + ' file(s) moved' + (kept ? ', ' + kept + ' already newer here' : '') +
      (failed ? ', ' + failed + ' failed' : '') + '). SAP exports here from the next pull.');
  return { from, to, moved, kept, failed };
}

module.exports = { Config, DEFAULTS, deepMerge, migrateReportDir, APP_ROOT, LEGACY_REPORT_DIR };
