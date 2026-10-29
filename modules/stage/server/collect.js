'use strict';
/* Collecting history on a PC that is not the host.

   A backfill drives SAP, and the host has one SAP session, so the whole
   time it is collecting a year of warehouse tasks it is not pulling the
   floor's own exports. On this warehouse that is better than three hours
   of a board nobody can trust. The work itself is not the problem - the
   board going dark while it happens is.

   So it is done somewhere else. This PC runs the same backfill against its
   own SAP session, writes what it collected to a file, and that file is
   carried to the host and merged. The host never stops pulling, and the
   history arrives whole.

   Two things make the merge safe rather than hopeful:

   - The same rule decides which reading of a day wins here as decides it
     on the host, because it is the same function - Pickers.keepExisting.
     A day the host watched live is not overwritten by a shorter re-read
     of it from here.

   - The settings this PC parsed with travel in the file. A history read
     with a different area map, or a different line key, is wrong in a way
     nobody would notice for weeks, so the host compares them and says so
     rather than quietly taking it.

   Nothing here pushes to the cloud and nothing here is a feeder. This PC
   is a pair of hands, not a second host. */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* what the history was parsed with: a file collected under a different
   area map or line key is not the same measurement */
function settingsOf(app){
  const c = app.cfg.get();
  const p = c.pickers || {};
  return {
    areaMap: c.wtAreaMap || '',
    targets: p.targets || '',
    lineKey: p.lineKey || '',
    dayHours: p.dayHours, shiftHours: p.shiftHours,
    schedule: p.schedule || '',
    warehouse: (c.pull || {}).warehouse || '',
    monitor: (c.pull || {}).monitor || ''
  };
}

/* The whole history this PC holds, not only what today's run wrote: the
   host's own rule decides day by day what is worth taking, so sending
   more costs a bigger file and nothing else. */
function payload(app, note){
  const days = app.pickers.history;
  const keys = Object.keys(days).sort();
  return {
    slh: 'collected-history', v: 1,
    at: Date.now(),
    from: keys[0] || null, to: keys[keys.length - 1] || null,
    count: keys.length,
    collectedBy: require('os').hostname(),
    build: app.version || '',
    note: note || '',
    settings: settingsOf(app),
    days
  };
}

/* Written gzipped because a year of this is tens of megabytes of JSON and
   it travels on a memory stick. The host opens either. */
function write(app, dir, note){
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(payload(app, note));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(dir, 'collected-history-' + stamp + '.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 }));
  return { file, days: JSON.parse(body).count, bytes: fs.statSync(file).size, raw: body.length };
}

/* Read one back, whichever way it was written. */
function read(buf){
  let text;
  /* gzip starts 1f 8b; anything else is taken as the plain thing */
  if(buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) text = zlib.gunzipSync(buf).toString('utf8');
  else text = buf.toString('utf8');
  let j;
  try{ j = JSON.parse(text.replace(/^﻿/, '')); }
  catch(e){ throw new Error('that file is not a collected history (it would not parse)'); }
  if(!j || j.slh !== 'collected-history' || !j.days || typeof j.days !== 'object'){
    throw new Error('that file is not a collected history');
  }
  return j;
}

/* What is different about how the two PCs read a day. Only the settings
   that change the numbers - a different port or data folder is nobody's
   business. */
function settingsDiff(mine, theirs){
  const out = [];
  const LAB = { areaMap: 'area map', targets: 'pick standards', lineKey: 'line key',
                dayHours: 'picking hours in a shift', shiftHours: 'paid hours in a shift',
                schedule: 'schedule', warehouse: 'warehouse', monitor: 'monitor' };
  for(const k of Object.keys(LAB)){
    const a = mine[k] == null ? '' : String(mine[k]).trim();
    const b = theirs && theirs[k] != null ? String(theirs[k]).trim() : '';
    if(a !== b) out.push({ what: LAB[k], here: a, there: b });
  }
  return out;
}

/* Run the backfill on this PC and write what it got. Forced, because the
   whole point is to re-read days this warehouse already has in order to
   fill in what the old code threw away. */
async function run(app, opt){
  opt = opt || {};
  const days = Math.max(1, Math.min(400, +opt.days || 400));
  /* Days filed per SAP export. Each export also reads a four day lead-in,
     so the window SAP is asked for is chunk + 4 - and SAP will not carry
     much past a hundred thousand rows out of the grid in one go. On a
     floor writing eleven thousand task rows a day that puts the ceiling
     around chunk 5, and over it the export runs long, fails, and is
     halved and retried, which is slower than asking for less. */
  const chunk = Math.max(1, Math.min(45, +opt.chunk || 4));
  const dir = opt.out || path.join(app.cfg.dataDir, 'collected');

  app.log('collecting ' + days + ' days of history in ' + chunk + '-day slices');
  app.log('this PC is NOT a host: nothing here is pushed anywhere, and the floor is not watching it');

  /* force, but not redo: a base marker must not stop a collector, and a
     collector stopped four hours into a year must not spend those hours
     again when it is started back up. */
  const r = app.backfill.start({ days, chunk, force: true, redo: false });
  if(!r || r.ok === false) throw new Error(r && r.error ? r.error : 'the backfill would not start');
  await app.backfill.job;

  const st = app.backfill.st;
  if(st.error) app.log('the run reported: ' + st.error, 'warn');
  const wrote = (st.written || []).filter(d => d.wrote).length;
  const missed = (st.missed || []).length;
  app.log('collected ' + wrote + ' day(s)' + (missed ? ', ' + missed + ' window(s) gave nothing' : ''));

  /* A run that collected nothing still has a history behind it - whatever
     this PC already held - and writing that out under a name that says
     "collected" would send somebody to the host with a file that changes
     nothing, believing the job was done. */
  if(!wrote){
    const why = st.error ? st.error : 'SAP returned nothing for any window';
    throw new Error('nothing was collected: ' + why);
  }
  const out = write(app, dir, wrote + ' day(s) written, ' + missed + ' empty window(s)');
  app.log('wrote ' + out.file + ' (' + Math.round(out.bytes / 1024) + ' KB, ' + out.days + ' days)');
  app.log('carry that file to the host and take it in on Settings > History collected elsewhere');
  return out;
}

module.exports = { run, write, read, payload, settingsOf, settingsDiff };
