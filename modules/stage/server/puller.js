'use strict';
/* Drives SAP from inside the app. Each cycle spawns the PowerShell driver,
   reads its JSON progress lines, enforces a timeout, and schedules the next
   run. Replaces the VBS loop, the watchdog, Task Scheduler and the flag
   files: START and STOP are just state here, and a hung cycle is killed and
   restarted without anyone noticing. */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DRIVER = path.join(__dirname, 'sap', 'pull.ps1');
const DRIVER_VBS = path.join(__dirname, 'sap', 'pull.vbs');
/* SAP's ROT helper (SapROTWr) is a 32-bit DLL, so the driver has to run in
   the 32-bit PowerShell. Every 64-bit Windows keeps one under SysWOW64. */
/* SAP GUI 7.x is 32-bit and 8.x is 64-bit, and the running-object table is
   friendlier to a caller of the same bitness. Start with 32-bit; if attaching
   keeps failing, alternate, and remember whichever one worked. */
let psPref = 'x86', psFailures = 0;
function powershellExe(){
  const win = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const x86 = path.join(win, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const x64 = path.join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const has = f => { try{ return fs.existsSync(f); }catch(e){ return false; } };
  if(psPref === 'x86' && has(x86)) return x86;
  if(has(x64)) return x64;
  return 'powershell.exe';
}
function noteAttach(ok){
  if(ok){ psFailures = 0; return; }
  psFailures++;
  if(psFailures >= 2){ psPref = psPref === 'x86' ? 'x64' : 'x86'; psFailures = 0; return true; }
  return false;
}
const RING = 400;

class Puller extends EventEmitter {
  constructor(cfg, log){
    super();
    this.cfg = cfg;
    this.logLine = log || (() => {});
    this.stateFile = path.join(cfg.dataDir, 'puller.json');
    this.child = null;
    this.timer = null;
    this.probeTimer = null;
    this.killTimer = null;
    this.ring = [];
    this.st = {
      stopped: false,        // STOP pressed. Persisted so a restart honours it
      why: '',               // why nothing is running, when nothing is running
      running: false,        // a cycle is in progress right now
      phase: '',             // what the driver says it is doing
      cycles: 0, failures: 0,
      lastStart: null, lastEnd: null, lastOk: null, lastOkAt: null, lastError: '',
      nextRunAt: null,
      idle: false,           // paused because nobody is watching
      sap: { ok: null, tcode: '', at: null, detail: '' },
      exports: {},           // file -> { at, bytes }
      recycles: 0, memoryPopups: 0, lastMemoryAt: null,   // SAP session housekeeping
      driver: { available: null, reason: '' }
    };
    try{ const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); this.st.stopped = !!s.stopped; }catch(e){}
    this.viewers = () => 0;
  }
  get pcfg(){ return this.cfg.get().pull; }
  persist(){ try{ fs.writeFileSync(this.stateFile, JSON.stringify({ stopped: this.st.stopped })); }catch(e){} }
  log(msg, level){
    const line = { t: Date.now(), level: level || 'info', msg: String(msg) };
    this.ring.push(line); if(this.ring.length > RING) this.ring.shift();
    this.logLine('[pull] ' + msg);
    this.emit('log', line);
  }
  status(){ return Object.assign({ enabled: !!this.pcfg.enabled, intervalSec: this.pcfg.intervalSec, held: !!this.held, standby: !!this.standby }, this.st); }
  tail(n){ return this.ring.slice(-(n || 200)); }

  start(){
    if(process.platform !== 'win32'){
      this.st.driver = { available: false, reason: 'SAP GUI scripting needs Windows' };
      this.log('not on Windows; SAP pull disabled, folder is read only', 'warn');
      return;
    }
    this.st.driver = { available: true, reason: '' };
    this.schedule(1500);
    this.probeTimer = setInterval(() => this.maybeProbe(), 60000);
    setTimeout(() => this.maybeProbe(), 500);
  }
  stop(){
    if(this.timer) clearTimeout(this.timer);
    if(this.probeTimer) clearInterval(this.probeTimer);
    this.kill('server shutting down');
  }
  schedule(ms){
    if(this.timer) clearTimeout(this.timer);
    this.st.nextRunAt = Date.now() + ms;
    this.timer = setTimeout(() => this.tick(), ms);
    this.emit('status');
  }
  /* Called by the API. */
  requestStart(){ this.st.stopped = false; this.st.idle = false; this.persist(); this.log('START pressed'); this.schedule(200); }
  requestStop(){ this.st.stopped = true; this.persist(); this.log('STOP pressed; the current cycle finishes, then no more'); this.kill('stopped from the board'); this.emit('status'); }
  pullNow(){ this.st.idle = false; this.schedule(100); }

  /* Why nothing is happening, said once, and said again when it changes.
     Four of the reasons below used to return without a word: STOP is
     remembered across a restart, so a PC could come up, print its address
     and then sit there for ever with a log that ended at "opened the
     board" and no way to tell that from a hung driver. */
  quiet(why){
    if(this.st.why === why) return;
    this.st.why = why;
    this.log(why, 'warn');
    this.emit('status');
  }
  loud(){
    if(!this.st.why) return;
    this.log('pulling again');
    this.st.why = '';
    this.emit('status');
  }
  tick(){
    this.timer = null;
    const p = this.pcfg;
    if(!p.enabled){ this.quiet('the pull is switched off (Settings > pull > enabled); the folder is still read'); this.st.nextRunAt = null; this.emit('status'); return; }
    if(this.st.stopped){ this.quiet('the pull is STOPPED and stays stopped across a restart; press START on the Admin page'); this.st.nextRunAt = null; this.emit('status'); return; }
    if(this.held){ this.quiet('a one-time job is driving SAP; the scheduled pull is waiting for it to finish'); this.schedule(5000); return; }
    if(this.standby){ this.quiet('another PC is feeding the cloud copy; this PC is standing by and will not touch SAP'); this.schedule(15000); return; }
    if(this.child){ this.schedule(2000); return; }
    // nobody watching: stop driving SAP for an audience of nobody
    const idleMin = +p.idleStopMin || 0;
    if(idleMin > 0 && this.viewers() === 0 && this.lastViewerAt && (Date.now() - this.lastViewerAt) > idleMin * 60000){
      if(!this.st.idle){ this.st.idle = true; this.log('no viewer for ' + idleMin + ' minutes; pausing SAP pulls until someone opens the board'); }
      this.schedule(30000); return;
    }
    if(this.st.idle){ this.st.idle = false; this.log('viewer connected; resuming'); }
    this.loud();
    this.runCycle();
  }
  noteViewer(){ this.lastViewerAt = Date.now(); if(this.st.idle) this.schedule(200); }

  /* { exe, args } for the configured driver host. `over` replaces named
     switches, which is how the one-time backfill asks for a wider window
     and its own output folder without touching the live pull. */
  driverCmd(action, over){
    const p = this.pcfg, c = this.cfg.get();
    if((p.driver || 'vbs') === 'vbs'){
      const n = p.nodes || {};
      const q = v => String(v == null ? '' : v);
      const args = ['//Nologo', '//B', DRIVER_VBS,
        '/Action:' + action, '/ReportDir:' + c.reportDir,
        '/StageFile:' + c.files.stage, '/OrdersFile:' + c.files.orders, '/WhFile:' + c.files.wh,
        '/Warehouse:' + q(p.warehouse), '/Monitor:' + q(p.monitor), '/LookbackDays:' + q(p.lookbackDays || 0),
        '/SettleMs:' + q(p.settleMs || 4000), '/SwitchMs:' + q(p.switchMs || 6000), '/DateFormat:' + q(p.dateFormat || 'MM/dd/yyyy'),
        '/HuNode:' + q((n.hu || {}).key), '/HuLabel:' + q((n.hu || {}).label), '/HuExpand:' + ((n.hu || {}).expand || []).join(','), '/HuParent:' + q((n.hu || {}).parent),
        '/OrdersNode:' + q((n.orders || {}).key), '/OrdersLabel:' + q((n.orders || {}).label), '/OrdersExpand:' + ((n.orders || {}).expand || []).join(','), '/OrdersParent:' + q((n.orders || {}).parent),
        '/WtNode:' + q((n.wt || {}).key), '/WtLabel:' + q((n.wt || {}).label), '/WtExpand:' + ((n.wt || {}).expand || []).join(','), '/WtParent:' + q((n.wt || {}).parent),
        '/WtBackDays:' + q(this.wtDays != null ? this.wtDays : (p.wtBackDays == null ? 3 : p.wtBackDays)),
        '/BinPatterns:' + (p.binPatterns || []).join(','),
        /* a fresh SAP session on a schedule, and at once after SAP said it
           had no memory left, which is what used to end the pull overnight */
        '/Recycle:' + ((action === 'pull' && (this.recycleNext ||
          ((+p.recycleEvery || 0) > 0 && this.st.cycles > 0 && this.st.cycles % (+p.recycleEvery) === 0))) ? 1 : 0)];
      if(over) for(const k of Object.keys(over)){
        const sw = '/' + k + ':';
        const i = args.findIndex(a => a.indexOf(sw) === 0);
        if(i >= 0) args[i] = sw + String(over[k]); else args.push(sw + String(over[k]));
      }
      const win = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const cs = path.join(win, 'System32', 'cscript.exe');
      return { exe: fs.existsSync(cs) ? cs : 'cscript.exe', args };
    }
    return { exe: powershellExe(), args: this.driverArgs(action, over) };
  }
  driverArgs(action, over){
    const p = this.pcfg, c = this.cfg.get();
    const n = p.nodes || {};
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', DRIVER,
      '-Action', action,
      '-ReportDir', c.reportDir,
      '-StageFile', c.files.stage, '-OrdersFile', c.files.orders, '-WhFile', c.files.wh,
      '-Warehouse', String(p.warehouse || ''), '-Monitor', String(p.monitor || ''),
      '-LookbackDays', String(p.lookbackDays || 0),
      '-SettleMs', String(p.settleMs || 4000), '-SwitchMs', String(p.switchMs || 6000),
      '-DateFormat', String(p.dateFormat || 'MM/dd/yyyy'),
      '-HuNode', String((n.hu || {}).key || ''), '-HuLabel', String((n.hu || {}).label || ''), '-HuExpand', ((n.hu || {}).expand || []).join(','), '-HuParent', String((n.hu || {}).parent || ''),
      '-OrdersNode', String((n.orders || {}).key || ''), '-OrdersLabel', String((n.orders || {}).label || ''), '-OrdersExpand', ((n.orders || {}).expand || []).join(','), '-OrdersParent', String((n.orders || {}).parent || ''),
      '-WtNode', String((n.wt || {}).key || ''), '-WtLabel', String((n.wt || {}).label || ''), '-WtExpand', ((n.wt || {}).expand || []).join(','), '-WtParent', String((n.wt || {}).parent || ''),
      '-BinPatterns', (p.binPatterns || []).join(',')
    ];
    /* The same overrides the VBS path takes. A one-off run that wants
       different bins or a different file - the pack bench export does
       both - should not need a different driver to say so. */
    if(over) for(const k of Object.keys(over)){
      const sw = '-' + k;
      const i = args.indexOf(sw);
      if(i >= 0) args[i + 1] = String(over[k]); else args.push(sw, String(over[k]));
    }
    return args;
  }

  /* One part on its own, from the Admin page: 'wt' runs only the warehouse
     task export so it can be fixed without waiting for whole cycles. */
  runPart(action){
    if(this.child){ this.log('busy; try again when the current cycle ends', 'warn'); return false; }
    if(this.timer){ clearTimeout(this.timer); this.timer = null; }
    this.log('--- test run: ' + action + ' ---');
    this.runCycle(action);
    return true;
  }
  /* One driver run, awaited, with the log and status wired up the same
     way a cycle is. The backfill needs several of these in a row and has to
     know how each one ended. */
  runOnce(action, over, timeoutMs){
    return new Promise(resolve => {
      if(this.child){ resolve({ ok: false, code: -1, error: 'a cycle is running' }); return; }
      let child;
      try{
        const cmd = this.driverCmd(action, over);
        child = spawn(cmd.exe, cmd.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      }catch(e){ resolve({ ok: false, code: -1, error: e.message }); return; }
      this.child = child;
      this.oneOff = true;
      this.runBig = null;
      this.runNote = '';        // collect the driver's own complaint for the caller
      this.st.running = true; this.st.phase = 'one-time export'; this.st.lastStart = Date.now();
      this.emit('status');
      let buf = '', err = '';
      child.stdout.on('data', d => { buf += d.toString('utf8'); let i; while((i = buf.indexOf('\n')) >= 0){ const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); this.onLine(l); } });
      child.stderr.on('data', d => { err += d.toString('utf8'); if(err.length > 4000) err = err.slice(-4000); });
      /* said out loud, because "the driver exited with code 1" and "Excel
         was still writing when we killed it" want two different answers */
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        this.log('the one-time export ran past its ' + Math.round((timeoutMs || 900000) / 60000) + ' minute limit; killing it', 'warn');
        try{ child.kill(); }catch(e){}
      }, timeoutMs || 900000);
      child.on('exit', code => {
        clearTimeout(t);
        if(buf.trim()) this.onLine(buf.trim());
        this.child = null;
        this.oneOff = false;
        this.st.running = false; this.st.phase = ''; this.st.lastEnd = Date.now();
        this.emit('status');
        const note = this.runNote;
        const big = this.runBig;
        this.runNote = null; this.runBig = null;
        resolve({ ok: code === 0, code, note: note || '', timedOut, tooBig: big || null,
          error: code === 0 ? '' : timedOut ? 'the export was still running after ' + Math.round((timeoutMs || 900000) / 60000) + ' minutes' :
                 (code === 2 ? 'SAP GUI not reachable' : code === 4 ? 'could not reach the warehouse monitor' :
                 note || err.trim().split('\n').pop() || 'driver exited with code ' + code) });
      });
    });
  }
  /* The delivery value, which EWM does not carry and ECC does.

     This is the only number on any of these boards that does not come
     out of the warehouse, and it is worth saying why it is bolted on
     rather than built in: VL06O lives in a different system from the
     warehouse monitor, so it needs its own logged-in session, and if
     that session is not there this must fail quietly and leave the
     board alone. Hence its own action, its own clock, and off until
     somebody says otherwise. */
  maybeDeliveries(){
    const d = (this.pcfg || {}).deliveries || {};
    if(!d.enabled) return;
    if(this.child || this.delBusy) return;
    const every = Math.max(5, +d.everyMin || 30) * 60000;
    if(this.delAt && Date.now() - this.delAt < every) return;
    this.delAt = Date.now();
    this.delBusy = true;
    const over = {
      SapDelFile: d.delFile || 'SAP Deliveries.TXT',
      SapPgiFile: d.pgiFile || 'SAP PGI.TXT',
      DelVariant: d.variant == null ? 'ARDEN_OPEN_DEL' : d.variant
    };
    this.log('pulling the delivery value off ECC (' + over.SapDelFile + ', ' + over.SapPgiFile + ')');
    this.runOnce('del', over, Math.max(60, +d.timeoutSec || 420) * 1000)
      .then(r => {
        this.delBusy = false;
        if(r.ok) this.log('ECC delivery value pulled');
        else this.log('the ECC delivery pull did not run: ' + (r.error || 'code ' + r.code) +
                      '. The board is unaffected; dollars simply stay as they were.', 'warn');
        this.emit('status');
      })
      .catch(e => { this.delBusy = false; this.log('ECC delivery pull: ' + e.message, 'warn'); });
  }

  /* Keep the scheduled cycle out of the way while a one-time job drives
     SAP. One session, one driver. */
  hold(on){
    this.held = !!on;
    if(this.held){
      if(this.timer){ clearTimeout(this.timer); this.timer = null; }
      this.st.nextRunAt = null;
    } else this.schedule(2000);
    this.emit('status');
  }
  runCycle(action){
    action = action || 'pull';
    const p = this.pcfg;
    this.st.running = true; this.st.phase = 'starting'; this.st.lastStart = Date.now(); this.st.lastError = '';
    this.emit('status');
    let child;
    try{
      const cmd = this.driverCmd(action);
      child = spawn(cmd.exe, cmd.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    }catch(e){
      this.st.running = false; this.st.lastError = 'could not start PowerShell: ' + e.message; this.st.failures++;
      this.log(this.st.lastError, 'error'); this.schedule(30000); return;
    }
    this.child = child;
    let buf = '', errBuf = '';
    child.stdout.on('data', d => { buf += d.toString('utf8'); let i; while((i = buf.indexOf('\n')) >= 0){ const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); this.onLine(line); } });
    child.stderr.on('data', d => { errBuf += d.toString('utf8'); if(errBuf.length > 4000) errBuf = errBuf.slice(-4000); });
    this.killTimer = setTimeout(() => { this.log('cycle exceeded ' + p.cycleTimeoutSec + 's; killing it', 'warn'); this.kill('timeout'); }, (p.cycleTimeoutSec || 300) * 1000);
    child.on('exit', (code) => {
      clearTimeout(this.killTimer); this.killTimer = null;
      if(buf.trim()) this.onLine(buf.trim());
      this.child = null;
      this.st.running = false; this.st.phase = ''; this.st.lastEnd = Date.now(); this.st.cycles++;
      const ok = code === 0;
      this.st.lastOk = ok;
      if(ok) this.st.lastOkAt = Date.now();
      if(code === 2){ if((p.driver || 'vbs') !== 'vbs' && noteAttach(false)) this.log('could not attach with ' + (psPref === 'x86' ? '64-bit' : '32-bit') + ' PowerShell twice; trying ' + psPref + ' next', 'warn'); }
      else noteAttach(true);
      if(!ok){
        this.st.failures++;
        if(!this.st.lastError) this.st.lastError = code === 2 ? (this.st.sap && this.st.sap.detail ? this.st.sap.detail : 'SAP GUI not reachable on this PC (is SAP open and logged in?)')
                                                : code === 4 ? 'could not reach the warehouse monitor (/SCWM/MON)'
                                                : code === 3 ? 'SAP session not ready' : ('driver exited with code ' + code);
        if(errBuf.trim()) this.log('driver stderr: ' + errBuf.trim().split('\n').slice(-3).join(' | '), 'error');
        this.log('cycle failed: ' + this.st.lastError, 'error');
      }
      /* SAP going away is an event, not a state: once per outage, on the
         first cycle that finds it gone. A machine about to be rebooted is
         worth a copy of the data folder first, and that is who listens. */
      const gone = !ok && (code === 2 || code === 3);
      if(gone && !this.sapGone) this.emit('sapdown', { code, error: this.st.lastError });
      this.sapGone = gone;
      this.writeLegacyFiles();
      this.emit('status');
      this.emit('cycle', ok);
      /* The ECC pull rides behind a good cycle rather than beside it:
         one SAP GUI, one driver at a time, and the board's own exports
         come first. Off unless somebody turns it on, and on its own
         clock, because a dollar figure does not need to be half a minute
         fresh. */
      if(ok) this.maybeDeliveries();
      // SAP down: back off a little; otherwise the normal interval
      const wait = ok ? Math.max(5, p.intervalSec || 30) * 1000 : (code === 2 || code === 3 ? 15000 : 20000);
      this.schedule(wait);
    });
  }
  /* The driver says why it gave up on stdout, as a log line, and then exits
     with a number. The number alone ("code 1") tells a caller nothing it can
     act on, so the last thing the driver complained about is kept and handed
     back with the result. Only collected while runOnce is listening. */
  noteDriver(msg){ if(typeof this.runNote === 'string' && msg) this.runNote = String(msg); }
  onLine(line){
    if(!line) return;
    let o = null;
    if(line[0] === '{'){ try{ o = JSON.parse(line); }catch(e){ o = null; } }
    if(!o){ this.log(line); return; }
    switch(o.t){
      case 'log': this.log(o.msg, o.level || 'info'); if(o.level === 'error' || o.level === 'warn') this.noteDriver(o.msg); break;
      case 'phase': this.st.phase = o.phase || ''; this.emit('status'); break;
      case 'sap': this.st.sap = { ok: !!o.ok, tcode: o.tcode || '', at: Date.now(), detail: o.detail || '' }; this.emit('status'); break;
      case 'export': this.st.exports[o.file] = { at: Date.now(), bytes: o.bytes || 0 }; this.log('exported ' + o.file + ' (' + (o.bytes || 0) + ' bytes)'); this.emit('status'); break;
      case 'error': this.st.lastError = o.msg || 'driver error'; this.log(o.msg, 'error'); this.noteDriver(o.msg); break;
      case 'memory': this.st.memoryPopups++; this.st.lastMemoryAt = Date.now(); this.recycleNext = true; this.emit('status'); break;
      case 'recycled': this.st.recycles++; this.recycleNext = false; this.emit('status'); break;
      case 'tree': this.lastTree = { at: Date.now(), nodes: o.nodes || [] }; this.emit('tree', this.lastTree); break;
      /* The task window came back bigger than one cycle can export. Ask
         for less of it from now on rather than spending every cycle on an
         export that gets killed half finished. It walks down a day at a
         time and stops at one, which is what the pack board needs
         anyway. */
      /* The window got narrowed once and had no way back. A floor that
         got quieter, or a cap that got raised, left the pull asking for
         a single day of creation dates for ever - and a one day window
         loses every task created yesterday and picked today, which
         understates every picker on the board. So a comfortable export
         gives a day back, one at a time, until it is at the lookback
         somebody actually configured. */
      case 'wtok': {
        if(this.oneOff) break;
        const want = this.pcfg.wtBackDays == null ? 3 : this.pcfg.wtBackDays;
        if(this.wtDays == null || this.wtDays >= want) break;
        const max = +o.max || 25000;
        const rows = +o.rows || 0;
        /* a lookback of 0 is one day of dates, not none - so the window
           just exported was days + 1 wide, and the next one is days + 2 */
        const wide = (o.days == null ? this.wtDays : +o.days) + 1;
        const guess = rows / wide * (wide + 1);
        /* Only a small margin, deliberately. Being too careful here costs
           understated picker numbers every day for ever; being a little
           optimistic costs one cycle, because a window that turns out too
           big narrows straight back on the next wtbig. */
        if(rows > 0 && guess > max * 0.95) break;
        this.wtDays = Math.min(want, this.wtDays + 1);
        this.log('the task export came back at ' + rows.toLocaleString() + ' rows, well inside the ' +
                 max.toLocaleString() + ' limit; asking for ' + this.wtDays + ' day(s) of creation dates again' +
                 (this.wtDays >= want ? ', which is the configured lookback' : ''), 'warn');
        this.emit('status');
        break;
      }
      case 'wtbig': {
        /* A one-time export - the backfill - is a different job with a
           different time limit, and it asks for wide windows on purpose.
           Letting its row count narrow the scheduled pull meant one
           backfill slice quietly cut the live board down to a single day. */
        if(this.oneOff){
          /* handed back to whoever asked for the run, which for the
             backfill means "cut this window in half and try again"
             rather than "SAP has nothing for those days" */
          this.runBig = { rows: o.rows || 0, max: o.max || 0, exporting: !!o.exporting };
          this.log('the one-time export came back with ' + (o.rows || 0) + ' rows, past the ' +
            (o.max || 0) + ' asked for; leaving the scheduled window alone', 'warn');
          break;
        }
        /* already at a single day and still big: there is nothing to
           narrow, the driver is exporting it anyway, and the only thing
           that helps is more time. Give this cycle it. */
        if(o.exporting){
          const want = Math.max((this.pcfg.cycleTimeoutSec || 300), 900) * 1000;
          if(this.killTimer){
            clearTimeout(this.killTimer);
            this.killTimer = setTimeout(() => { this.log('cycle exceeded ' + Math.round(want / 1000) + 's; killing it', 'warn'); this.kill('timeout'); }, want);
            this.log('a big task export is running at a one day window (' + (o.rows || 0) + ' rows); this cycle gets ' + Math.round(want / 1000) + 's to finish it', 'warn');
          }
          break;
        }
        const was = this.wtDays == null ? (this.pcfg.wtBackDays == null ? 3 : this.pcfg.wtBackDays) : this.wtDays;
        const now = Math.max(0, was - 1);
        this.wtDays = now;
        this.log('the task export is too big at ' + was + ' day(s) of creation dates (' + (o.rows || 0) +
                 ' rows); asking for ' + now + ' from here. Settings has the task lookback if you want it back.', 'warn');
        this.emit('status');
        break;
      }
      default: this.log(line);
    }
  }
  kill(why){
    if(!this.child) return;
    const pid = this.child.pid;
    this.log('terminating driver (' + why + ')', 'warn');
    try{ execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); }catch(e){}
    try{ this.child.kill(); }catch(e){}
  }
  /* SAP reachability when the driver is not running, so the board can tell
     "SAP is closed" from "the pull is stopped". */
  maybeProbe(){
    if(this.child || process.platform !== 'win32' || !this.pcfg.enabled) return;
    if(this.st.sap.at && (Date.now() - this.st.sap.at) < 45000) return;
    let out = '';
    let ch;
    try{ const cmd = this.driverCmd('probe'); ch = spawn(cmd.exe, cmd.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }catch(e){ return; }
    ch.stdout.on('data', d => { out += d.toString('utf8'); });
    const t = setTimeout(() => { try{ ch.kill(); }catch(e){} }, 20000);
    ch.on('exit', () => {
      clearTimeout(t);
      out.split(/\r?\n/).forEach(l => { if(l[0] === '{'){ try{ const o = JSON.parse(l); if(o.t === 'sap'){ this.st.sap = { ok: !!o.ok, tcode: o.tcode || '', at: Date.now(), detail: o.detail || '' }; } }catch(e){} } });
      if(!this.st.sap.at) this.st.sap = { ok: false, tcode: '', at: Date.now(), detail: 'no answer from the probe' };
      this.writeLegacyFiles();
      this.emit('status');
    });
  }
  /* Dump the monitor tree so nodes can be picked in the admin page instead of
     recorded by position. Runs once, on request. */
  discoverTree(cb){
    if(this.child){ cb(new Error('a pull cycle is running; try again in a moment')); return; }
    let out = '', err = '';
    let ch;
    try{ const cmd = this.driverCmd('tree'); ch = spawn(cmd.exe, cmd.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }catch(e){ cb(e); return; }
    this.child = ch;
    ch.stdout.on('data', d => { out += d.toString('utf8'); });
    ch.stderr.on('data', d => { err += d.toString('utf8'); });
    const t = setTimeout(() => { try{ this.kill('tree discovery timeout'); }catch(e){} }, 90000);
    ch.on('exit', code => {
      clearTimeout(t); this.child = null;
      let nodes = null; const logs = [];
      out.split(/\r?\n/).forEach(l => { if(l[0] === '{'){ try{ const o = JSON.parse(l); if(o.t === 'tree') nodes = o.nodes; else if(o.t === 'log') logs.push(o.msg); else if(o.t === 'sap') this.st.sap = { ok: !!o.ok, tcode: o.tcode || '', at: Date.now(), detail: o.detail || '' }; }catch(e){} } });
      if(nodes){ this.lastTree = { at: Date.now(), nodes }; cb(null, this.lastTree); }
      else cb(new Error((code === 2 ? 'SAP GUI not reachable. ' : '') + (logs.slice(-2).join(' | ') || err.trim() || 'no tree returned')));
    });
  }
  /* The old board and anyone else still reading the flag files. */
  writeLegacyFiles(){
    const c = this.cfg.get();
    if(!c.compat || !c.compat.writeLegacyFiles) return;
    try{
      if(!fs.existsSync(c.reportDir)) return;
      const now = new Date();
      const p = n => String(n).padStart(2, '0');
      const stamp = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) + ' ' + p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
      const sap = this.st.sap.ok ? 1 : 0;
      const body = stamp + '\r\nsap=' + sap + '\r\ntcode=' + (this.st.sap.tcode || '') + '\r\n';
      fs.writeFileSync(path.join(c.reportDir, 'sap_status.txt'), body);
      if(!this.st.stopped && this.pcfg.enabled) fs.writeFileSync(path.join(c.reportDir, 'hu_heartbeat.txt'), body);
    }catch(e){}
  }
}

module.exports = { Puller };
