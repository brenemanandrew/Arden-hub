'use strict';
/* Staging Lane Health host service.
     node server/main.js [--port 8480] [--report-dir C:\REPORT] [--data-dir ...] [--no-pull]
   Starts the folder reader, the SAP pull loop and the web server, then
   prints the addresses viewers can open. */
const fs = require('fs');
const path = require('path');
const { Config, migrateReportDir } = require('./config');
const { stopOld, openBoard, seedFromFile } = require('./launcher');
const { stopLegacyPuller } = require('./legacypull');
const { SapWatch } = require('./sapwatch');
const { Commands } = require('./commands');
const { Ingest } = require('./ingest');
const model = require('./model');
const { Dwell } = require('./dwell');
const { Puller } = require('./puller');
const { Settings } = require('./settings');
const { Api } = require('./http');
const { CloudPush, CloudStore } = require('./cloud');
const { Pickers } = require('./pickers');
const { Recommend } = require('./recommend');
const { Backfill } = require('./backfill');
const { Eos } = require('./eos');
const { Backup } = require('./backup');

/* Version plus a build stamp, so a copy running on some other PC can say
   which build it is: the git commit here, or BUILD.txt in a portable dist
   (written by toolsuild-portable.cmd), or failing both the newest file
   date under server and web. package.json alone never changes. */
const VERSION = require('../package.json').version + ' ' + buildStamp();
function buildStamp(){
  const root = path.join(__dirname, '..');
  try{ return fs.readFileSync(path.join(root, 'BUILD.txt'), 'utf8').trim(); }catch(e){}
  try{
    const out = require('child_process').execFileSync('git', ['log', '-1', '--format=%h %cs'], { cwd: root, timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const s = String(out).trim(); if(s) return s;
  }catch(e){}
  let newest = 0;
  for(const d of ['server', 'web']){
    try{ for(const f of fs.readdirSync(path.join(root, d))){ try{ const m = fs.statSync(path.join(root, d, f)).mtimeMs; if(m > newest) newest = m; }catch(e){} } }catch(e){}
  }
  return newest ? 'files ' + new Date(newest).toISOString().slice(0, 10) : '';
}

function makeLogger(dataDir){
  const dir = path.join(dataDir, 'logs');
  try{ fs.mkdirSync(dir, { recursive: true }); }catch(e){}
  let stream = null, day = '';
  return function log(msg){
    const now = new Date();
    const d = now.toISOString().slice(0, 10);
    if(d !== day){ day = d; if(stream) stream.end(); stream = fs.createWriteStream(path.join(dir, 'server-' + d + '.log'), { flags: 'a' }); pruneLogs(dir); }
    const line = now.toLocaleTimeString('en-GB') + '  ' + msg;
    try{ stream.write(line + '\n'); }catch(e){}
    console.log(line);
  };
}
function pruneLogs(dir){
  try{
    const cutoff = Date.now() - 30 * 86400000;
    for(const n of fs.readdirSync(dir)){ const p = path.join(dir, n); try{ if(fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); }catch(e){} }
  }catch(e){}
}

async function main(){
  const cfg = new Config(process.argv.slice(2));
  const log = makeLogger(cfg.dataDir);
  log('Staging Lane Health v' + VERSION + ' starting');
  log('data dir   ' + cfg.dataDir);
  log('report dir ' + cfg.get().reportDir);

  const cloudMode = cfg.get().mode === 'cloud';
  let app, api;
  if(cloudMode){
    /* the cloud copy: fed by pushes from the host PC, nothing else */
    const store = new CloudStore(cfg, log);
    const pickers = new Pickers(cfg, log);
    const recommend = new Recommend(cfg, pickers, log);
    app = { cfg, ingest: store, dwell: store.dwell, puller: store.puller, settings: store.settings, pickers, recommend, log, version: VERSION, cloudMode: true, store };
    api = new Api(app);
    store.on('change', v => {
      /* the cloud copy gets the daily rollup in the push, so its own history
         file stays in step without ever seeing the task export */
      if(store.data.pickerCfg) pickers.override = store.data.pickerCfg;
      if(store.data.pickerDay && store.data.pickerDay.key){
        pickers.history[store.data.pickerDay.key] = store.data.pickerDay.entry;
        pickers.version++; pickers.save();
      }
      /* the host also pushes the recent rollup and the recommendation
         record, so the week, month and standards views work up here */
      if(store.data.pickerHist){
        for(const k in store.data.pickerHist) pickers.history[k] = store.data.pickerHist[k];
        pickers.version++; pickers.save();
      }
      if(store.data.recSnap) recommend.override = store.data.recSnap;
      api.broadcast('settings', { at: Date.now() });
      api.broadcast('data', { v, dv: v });
    });
    log('running as the CLOUD COPY: waiting for pushes from the host PC at /api/ingest');
    if(!cfg.get().cloud.secret) log('WARNING: no ingest secret set (SLH_INGEST_SECRET); pushes will be refused');
  } else {
    /* Somebody has double-clicked the program while it was already running -
       the ordinary way people restart anything. Stop that copy first, before
       this one reads or writes a single file, rather than racing it for the
       port and the data folder. */
    try{ await stopOld(cfg, log); }catch(e){ log('previous copy: ' + e.message, 'warn'); }
    /* and the puller that came before this program, which has a watchdog in
       Task Scheduler and will not stay dead on its own. Two pullers driving
       one SAP session is worse than either. */
    try{ stopLegacyPuller(cfg, log); }catch(e){ log('old VBS puller: ' + e.message, 'warn'); }
    /* One-time tidy: a copy still writing its exports to the old C:REPORT
       moves them in beside the app, before anything reads the folder. */
    try{ migrateReportDir(cfg, log); }catch(e){ log('report folder: could not move: ' + e.message); }
    /* If somebody left a cloud.txt beside the program, this PC learns where
       the cloud copy is from it - which has to happen before the history is
       looked for, because the cloud copy is one of the two places it comes
       from. Nothing typed on a new PC. */
    try{ seedFromFile(cfg, log); }catch(e){ log('setup file: ' + e.message, 'warn'); }
    /* Before anything below reads the data folder: if the cloud copy holds
       more history than this PC does, take it and merge. That is what a new
       PC comes up knowing, and what an old one catches up with. */
    let restored = null;
    try{ restored = await Backup.adopt(cfg, log); }catch(e){ log('restore: ' + e.message, 'error'); }
    /* not restoring is the common case and was silent; a PC that should
       have taken a backup and did not needs to say so where it can be read */
    if(restored && !restored.restored) log('restore: not taken - ' + restored.why);
    const ingest = new Ingest(cfg, log);    const dwell = new Dwell(cfg, log);
    const settings = new Settings(cfg, log);
    const puller = new Puller(cfg, log);
    const pickers = new Pickers(cfg, log);
    const recommend = new Recommend(cfg, pickers, log);
    app = { cfg, ingest, dwell, puller, settings, pickers, recommend, log, version: VERSION, cloudMode: false };
    api = new Api(app);
    app.backfill = new Backfill(app, () => { api.broadcast('status', api.statusPayload()); api.broadcast('data', { v: ingest.version, dv: dwell.version }); cloud.schedule(); });
    const cloud = new CloudPush(app);
    app.cloud = cloud;
    /* the end of shift report writes itself a few minutes after each shift,
       from the same data the board reads; the host's board can also ask for
       it with answers attached */
    app.backup = new Backup(app, log);
    app.backup.watch();       // and a floor under every other trigger
    if(restored && restored.restored) app.backup.st.restored = { at: Date.now(), file: restored.file, days: restored.days, how: restored.how };
    /* SAP stopping is the moment a copy is most worth having */
    puller.on('sapdown', ev => {
      if((cfg.get().backup || {}).onSapDown !== false){
        app.backup.run('SAP stopped answering (' + (ev.error || 'code ' + ev.code) + ')', { auto: true });
      }
      /* and then put it back on its feet, if this PC has been told how */
      if(app.sapwatch) app.sapwatch.trigger(ev.error || 'SAP stopped answering');
    });
    /* watches for a session that has stopped answering, or stopped
       producing, and restarts SAP through the Okta tile */
    app.sapwatch = new SapWatch(app, log).start();
    /* commands from afar: the cloud copy's push replies, and a watched folder */
    app.commands = new Commands(app, log).start();
    app.eos = new Eos(app, log);
    app.eos.onWritten = () => { api.broadcast('status', api.statusPayload()); cloud.schedule(); };
    app.eos.start();
    puller.viewers = () => api.viewers();

    ingest.on('change', v => {
      // the host keeps the dwell log, so it observes every new HU export once
      const d = ingest.derived;
      if(d && d.lanes){ try{ dwell.observe(d.lanes.present, d.lanes.lanes, Date.now()); }catch(e){ log('dwell observe failed: ' + e.message); } }
      /* the task export is a full picture of today, so re-reading it replaces
         today's rollup rather than adding to it */
      const wh = ingest.fullRows('wh');
      if(wh){
        const today = model.dayKey(new Date());
        try{
          if(pickers.observe(wh, today, (settings.get() || {}).wtAreaMap)) recommend.snapshot(today);
        }catch(e){ log('pickers: ' + e.message); }
      }
      api.broadcast('data', { v, dv: dwell.version });
      cloud.schedule();
    });
    puller.on('status', () => { api.broadcast('status', api.statusPayload()); cloud.schedule(); });
    puller.on('log', line => api.broadcast('log', line));
    puller.on('cycle', () => ingest.refresh());
    settings.onChange = () => cloud.schedule();
    setInterval(() => cloud.schedule(), 120000);   // heartbeat so the copy can tell "quiet" from "dead"
  }

  try{
    await api.listen();
  }catch(e){
    log('could not listen on port ' + cfg.get().port + ': ' + e.message);
    log('another copy may already be running. Change the port with --port or in config.json.');
    process.exit(1);
  }
  app.ingest.start();
  if(!cloudMode){
    // one feeder at a time: if another PC is feeding the cloud copy, stand by before ever touching SAP
    app.cloud.probeAtStart().then(() => app.puller.start());
  }
  /* reportDir goes in here for anything else on this PC that reads the
     same exports - Arden Pack, chiefly. It defaults to wherever this
     program was unzipped, so it is different on every machine and a
     second app guessing at it reads an empty folder and shows an empty
     board with nothing anywhere saying why. */
  fs.writeFileSync(path.join(cfg.dataDir, 'server.json'), JSON.stringify({
    pid: process.pid, port: cfg.get().port, started: Date.now(),
    addresses: api.addresses(), reportDir: cfg.get().reportDir, dataDir: cfg.dataDir,
    version: VERSION
  }, null, 2));
  log('listening. Open one of these on any PC on the network:');
  api.addresses().forEach(a => log('   ' + a));
  if(!cloudMode && !cfg.get().pull.enabled) log('SAP pull is OFF (reading the folder only)');
  if(!cloudMode && cfg.get().cloud.enabled) log('pushing to the cloud copy at ' + cfg.get().cloud.url);
  if(cfg.get().auth.viewerPassword) log('viewer password is ON');

  /* The board is opened last, not by the .cmd file at the same moment the
     service starts: by here the old copy is gone, the history has been taken
     from the cloud copy if this PC needed it, and there is something
     behind the page. */
  if(!cloudMode && !cfg.args.collect) openBoard(cfg, log);


  let stopping = false;
  const shutdown = why => {
    if(stopping) return;            // a close can arrive twice; the first one counts
    stopping = true;
    if(app.sapwatch) app.sapwatch.stop();
    if(app.commands) app.commands.stop();
    log('shutting down' + (typeof why === 'string' && why ? ': ' + why : ''));
    if(!cloudMode) app.puller.stop();
    /* a held history write is flushed before the process goes, so a restart
       never costs the day it was in the middle of */
    try{ app.pickers && app.pickers.flushSave(); }catch(e){}
    /* and then the backup nobody asked for: the one taken on the way out is
       the one that exists if this PC does not come back. Rate limited like
       every other automatic backup, so restarting twice does not write two. */
    let sent = null;
    if(!cloudMode && app.backup && (cfg.get().backup || {}).onClose !== false){
      try{ sent = (app.backup.run('the service is stopping', { auto: true }) || {}).sent; }
      catch(e){ log('backup on close: ' + e.message, 'warn'); }
    }
    app.ingest.stop(); api.close();
    /* wait for the copy to have it, but not for ever: Windows gives a
       closing console a few seconds and then takes the process anyway */
    const go = () => process.exit(0);
    if(sent && typeof sent.then === 'function'){
      let done = false;
      const once = () => { if(!done){ done = true; go(); } };
      sent.then(once, once);
      setTimeout(once, 4000);
    } else setTimeout(go, 300);
  };
  app.shutdown = shutdown;

  /* Collecting for somewhere else. The web server stays up so the run can
     be watched on the Admin page - three hours is a long time to stare at
     a console - but when it finishes this PC has no further job. */
  if(!cloudMode && cfg.args.collect){
    log('COLLECTOR MODE: this PC is not the host and is pushing nothing');
    require('./collect').run(app, { days: cfg.args.collectDays, chunk: cfg.args.collectChunk, out: cfg.args.collectOut })
      .then(out => {
        log('collected history written to ' + out.file);
        log('take it to the host: Settings > History collected elsewhere');
        setTimeout(() => shutdown('collecting finished'), 1500);
      })
      .catch(e => {
        log('collecting failed: ' + e.message, 'error');
        setTimeout(() => shutdown('collecting failed'), 1500);
      });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  /* closing the black window is how this is really stopped, and on Windows
     that arrives as SIGHUP rather than SIGINT; SIGBREAK is Ctrl-Break */
  process.on('SIGHUP', shutdown);
  process.on('SIGBREAK', shutdown);
  process.on('uncaughtException', e => { log('uncaught: ' + (e && e.stack || e)); });
  process.on('unhandledRejection', e => { log('unhandled rejection: ' + (e && e.stack || e)); });
}

main();
