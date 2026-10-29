'use strict';
/* The old VBS puller, stopped for good, at the start of every run.

   Before this program there was Start_HU_Staging_Pull.vbs, driven by a
   watchdog registered in Task Scheduler that relaunches it within a minute
   of it being killed - which is why it would not stay dead. Two pullers
   driving the same SAP session is worse than either: they fight over the
   window, one of them exports half a file, and the board reads whatever was
   on disk at the time.

   tools\Stop old VBS puller.cmd has done this by hand since the changeover.
   Doing it by hand means remembering to, on every PC the host ever moves to,
   so it happens here instead: quietly, at every start, before SAP is
   touched. On a PC that never had the old puller every step is a no-op and
   nothing is said.

   It is the same three steps the .cmd does, in the same order, and the .cmd
   stays for the case where somebody wants to watch it work. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/* the watchdog tasks, by the names they were registered under */
const TASKS = ['HU Pull Watchdog (logon)', 'HU Pull Watchdog (1 min)', 'HU Pull Watchdog (3 min)'];
/* what the old puller and its watchdog call themselves on a command line.
   Narrow on purpose: this kills scripts, and somebody else's wscript is
   none of our business. */
const NAMES = ['Start_HU_Staging_Pull', 'HU_Watchdog', 'Start HU Staging Pull', 'whtaskpull'];
const FLAG_DIR = 'C:\\REPORT';

function sh(exe, args, ms){
  try{
    const r = spawnSync(exe, args, { encoding: 'utf8', timeout: ms || 8000, windowsHide: true });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  }catch(e){ return { code: -1, out: String(e.message) }; }
}

/* 1. the watchdog tasks. Registered by the user who set them up, so no admin
   rights are needed to remove them, and a task that is not there exits
   non-zero, which is the ordinary case and not worth a word. */
function removeTasks(){
  const gone = [];
  for(const t of TASKS){
    const r = sh('schtasks', ['/Delete', '/TN', t, '/F'], 6000);
    if(r.code === 0) gone.push(t);
  }
  return gone;
}

/* 2. the flag the old script reads at the top of every cycle, so a copy that
   is mid-cycle stops of its own accord rather than being killed in the
   middle of writing an export. Only where the old folder still exists: this
   program moved its exports out of C:\REPORT, and re-creating it would put
   back the very folder the move was for. */
function writeFlag(){
  try{
    if(!fs.existsSync(FLAG_DIR)) return false;
    fs.writeFileSync(path.join(FLAG_DIR, 'hu_stop.flag'),
      'stop requested by Staging Lane Health at ' + new Date().toLocaleString() + '\r\n');
    try{ fs.unlinkSync(path.join(FLAG_DIR, 'hu_heartbeat.txt')); }catch(e){}
    return true;
  }catch(e){ return false; }
}

/* 3. anything still running. Matched on the command line, because every one
   of them is wscript.exe by process name. */
function endRunning(){
  if(process.platform !== 'win32') return [];
  const ps = [
    '$names = @(' + NAMES.map(n => "'" + n + "'").join(',') + ')',
    '$hits = @()',
    'foreach($p in Get-CimInstance Win32_Process){',
    "  if($p.Name -notmatch '^(wscript|cscript)\\.exe$'){ continue }",
    '  $cl = $p.CommandLine; if(-not $cl){ continue }',
    "  foreach($n in $names){ if($cl -like ('*' + $n + '*')){ $hits += $p; break } }",
    '}',
    'foreach($h in $hits){ try{ Stop-Process -Id $h.ProcessId -Force -ErrorAction Stop; Write-Output ("ended " + $h.ProcessId) }catch{ Write-Output ("kept " + $h.ProcessId) } }'
  ].join('; ');
  const r = sh('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], 15000);
  return (r.out || '').split(/\r?\n/).map(s => s.trim()).filter(s => /^ended \d+$/.test(s));
}

/* Everything, once, at start-up. Returns what it actually did; says nothing
   in the log unless something was there to stop. */
function stopLegacyPuller(cfg, log){
  log = log || (() => {});
  if(process.platform !== 'win32') return { skipped: 'not Windows' };
  if(cfg && cfg.get && cfg.get().stopLegacyPuller === false) return { skipped: 'turned off in config' };
  const tasks = removeTasks();
  const flag = writeFlag();
  const ended = endRunning();
  if(tasks.length) log('old VBS puller: removed the watchdog task' + (tasks.length > 1 ? 's ' : ' ') + tasks.join(', '));
  if(ended.length) log('old VBS puller: stopped ' + ended.length + ' running cop' + (ended.length > 1 ? 'ies' : 'y'));
  if(flag && (tasks.length || ended.length)) log('old VBS puller: stop flag written to ' + FLAG_DIR);
  return { tasks, flag, ended };
}

module.exports = { stopLegacyPuller, TASKS, NAMES };
