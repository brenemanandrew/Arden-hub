'use strict';
/* Which folder the exports are in.

   This is the one setting that makes the difference between a board and
   an empty screen, and it is the easiest to get wrong, because the
   answer is different on every machine. Staging Lane Health's own
   default is wherever somebody unzipped it, so there is no folder that
   is correct by design - only one that is correct on this PC.

   So it is asked in order, most deliberate first, and the program says
   out loud which of them answered. A wrong folder is then obvious on
   the first line of the log instead of after an afternoon of looking at
   an empty board.

     1. --report-dir          somebody said so just now
     2. PACK_REPORTS          the environment, which is how the cloud
                              copy is pointed at its own folder
     3. reports: in pack.txt  the file beside the program on the host
     4. Staging Lane Health   what that service says it is writing into,
                              from the server.json it leaves in
                              %LOCALAPPDATA%. The authority, when it is
                              there: it is the thing doing the writing.
     5. C:\REPORT             where it is on this floor

   Only a folder that exists is taken from server.json: an older copy of
   that service wrote none at all, and a stale one can name a folder
   that has since moved. Either way falling through beats pointing at
   nothing. */

const fs = require('fs');
const path = require('path');

/* Where the exports go when nothing else has said. The host's own
   startup log is the authority for this: report dir C:\StagingLaneHealth,
   and its puller writes C:\StagingLaneHealth\tmp\WHTask.XLSX.

   C:\REPORT is a dev machine leftover - a stale August set on one PC,
   whose own service actually runs out of a project folder - so it is
   tried only after the real one and only if it is there. It must never
   outrank the folder the service is really writing into.

   Spelled with a character code on purpose: 'C:\REPORT' in a single
   quoted string is C:REPORT, because \R is not an escape and JavaScript
   drops the backslash without a word. */
const HOST_FOLDER = 'C:' + String.fromCharCode(92) + 'StagingLaneHealth';
const DEV_LEFTOVER = 'C:' + String.fromCharCode(92) + 'REPORT';

function fromStagingLaneHealth(env, exists){
  const base = (env || {}).LOCALAPPDATA;
  if(!base) return '';
  try{
    const f = path.join(base, 'StagingLaneHealth', 'server.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const dir = String((j && j.reportDir) || '').trim();
    if(!dir) return '';                 // written by a copy too old to say
    return exists(dir) ? dir : '';      // named, but not there any more
  }catch(e){ return ''; }
}

/* `said` is the command line, `file` the pack.txt settings. `exists` is
   injectable so this can be tested without a disk. */
function resolveReportDir(opt){
  const o = opt || {};
  const env = o.env || {};
  const exists = o.exists || (d => { try{ return fs.statSync(d).isDirectory(); }catch(e){ return false; } });
  const said = String(o.said || '').trim();
  if(said) return { dir: said, why: 'asked for on the command line' };
  if(String(env.PACK_REPORTS || '').trim()) return { dir: String(env.PACK_REPORTS).trim(), why: 'PACK_REPORTS' };
  const file = String(((o.file || {}).reports) || '').trim();
  if(file) return { dir: file, why: 'pack.txt beside the program' };
  const host = fromStagingLaneHealth(env, exists);
  if(host) return { dir: host, why: 'Staging Lane Health, which is the one writing them' };
  /* and failing all of that, the folder it is on the host - then the
     old one on a dev PC, if that is the only one actually there. When
     neither exists the host's folder is still what gets named, so the
     board says it cannot find the right place rather than the wrong. */
  if(exists(HOST_FOLDER)) return { dir: HOST_FOLDER, why: 'the folder the service writes into' };
  if(exists(DEV_LEFTOVER)) return { dir: DEV_LEFTOVER, why: 'the old folder on this PC, which is the only one here' };
  return { dir: HOST_FOLDER, why: 'where it should be, though nothing is there' };
}

module.exports = { resolveReportDir, fromStagingLaneHealth, HOST_FOLDER, DEV_LEFTOVER };
