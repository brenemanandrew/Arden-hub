'use strict';
/* Settings, and the diagnostics that read the export and say what it can
   and cannot answer.

   The Columns tab came across from Staging Lane Health's admin page. Its
   wording had to change on the way: over there a line key was shared
   with the picker page, so setting one moved numbers on a page two tabs
   away and it said so loudly. Out here there is no picker page. The
   warning is gone because it stopped being true, which is the only
   reason to lift something by hand rather than copy it. */

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n0 = n => Number(n || 0).toLocaleString();
function toast(m){
  const t = $('toast');
  t.textContent = m; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}
function ago(ms){
  if(!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if(s < 60) return s + 's ago';
  if(s < 3600) return Math.round(s / 60) + ' min ago';
  if(s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}

/* ---- settings ----------------------------------------------------------- */
const FIELDS = ['dayHours', 'windowMin', 'hideBins', 'lineKey', 'schedule'];
const NUMBERS = ['dayHours', 'windowMin'];
let loaded = null;                      // what the server last told us

function fill(j){
  loaded = j;
  const v = j.settings || {};
  FIELDS.forEach(k => { const el = $(k); if(el) el.value = v[k] == null ? '' : v[k]; });
  $('where').innerHTML = '<div><b>Reading</b> <code>' + esc(j.reportDir || '') + '</code></div>';

  const feed = j.feed || {};
  $('files').innerHTML = Object.keys(feed).map(k => {
    const f = feed[k];
    const ok = f.status === 'ok';
    /* an optional export that nobody has dropped is not a fault. The two
       value files are written by hand on somebody else's PC, so absent is
       their ordinary state and a red card would cry wolf every day. */
    const waiting = !ok && f.optional;
    return '<div class="f' + (ok ? '' : (waiting ? ' waiting' : ' bad')) + '">' +
      '<div class="n">' + esc(f.label || k) + '</div>' +
      '<div class="s">' + (ok
        ? n0(f.rows) + ' rows, read ' + esc(ago(f.readAt))
        : (waiting ? 'not supplied yet' : esc(f.status) + (f.error ? ' - ' + esc(f.error) : ''))) + '</div>' +
      '<div class="s" style="color:var(--muted)">' + esc(f.name || 'no file') + '</div>' +
    '</div>';
  }).join('');

  /* the week actually in force, which is not what is in the box when the
     box is empty */
  $('schedShow').innerHTML = j.scheduleText
    ? 'In force now:<br><code style="white-space:pre-wrap;display:inline-block;margin-top:4px">' +
      esc(j.scheduleText) + '</code>'
    : '';
}
async function load(){
  try{
    fill(await fetch('/api/settings', { cache: 'no-store' }).then(r => r.json()));
    $('saveMsg').textContent = '';
  }catch(e){ $('saveMsg').textContent = 'could not read the settings: ' + e.message; }
}
async function save(patch, why){
  const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                           body: JSON.stringify(patch) });
  const j = await r.json();
  if(!r.ok || j.error) throw new Error(j.error || 'the save was refused');
  await load();
  toast(why || 'Saved');
  return j;
}
$('bSave').onclick = async () => {
  const patch = {};
  FIELDS.forEach(k => { const el = $(k); if(el) patch[k] = el.value.trim(); });
  if(!(+patch.dayHours > 0)) return toast('A day has to be worth more than nothing');
  if(!(+patch.windowMin > 0)) return toast('The gap has to be more than nothing');
  /* as numbers, so the stored file keeps the shape its defaults have
     rather than drifting to "6.5" the first time anybody presses Save */
  NUMBERS.forEach(k => { patch[k] = +patch[k]; });
  $('bSave').disabled = true;
  $('saveMsg').textContent = 'saving...';
  try{ await save(patch); $('saveMsg').textContent = ''; }
  catch(e){ $('saveMsg').textContent = e.message; toast('Not saved: ' + e.message); }
  finally{ $('bSave').disabled = false; }
};
$('bRevert').onclick = () => { if(loaded) fill(loaded); toast('Put back as it was saved'); };
$('bReread').onclick = async () => {
  $('rereadMsg').textContent = 'reading...';
  try{
    await fetch('/api/reread', { cache: 'no-store' });
    await load();
    $('rereadMsg').textContent = '';
  }catch(e){ $('rereadMsg').textContent = e.message; }
};

/* ---- what the export carries -------------------------------------------- */
function drawCols(j){
  if(!j || !j.ok){
    $('colsOut').innerHTML = '<p class="hint">' + esc((j && j.why) || 'nothing to read') + '</p>';
    $('colsMsg').textContent = '';
    return;
  }
  const acts = Object.keys(j.acts).filter(a => j.acts[a] > 0);
  const v = j.verdict || {};
  const cell = x => x
    ? '<td class="num">' + x.filledPct + '%</td><td class="num">' + n0(x.distinct) +
      '</td><td class="num">' + (x.per || '-') + '</td>'
    : '<td class="num">-</td><td class="num">-</td><td class="num">-</td>';

  /* A line key is never filled in on a ZLOD row - that is the shape of an
     HU task, not a fault - so what matters is whether the handling unit
     join reaches the picks that filled the carton. */
  const jn = j.join;
  const lk = (j.lineKey && j.lineKey.length)
    ? 'Lines are counted by <b>' + j.lineKey.map(esc).join(', ') + '</b>. They are never on a packer&rsquo;s own ' +
      'row - a handling unit going to LOADING carries no delivery and no item - so they are fetched through the ' +
      'carton: the unit a pick went <i>into</i> is the unit the packer later sends <i>out</i>.' +
      (jn
        ? ' In this export that join reaches <b class="' + (jn.pct >= 90 ? 'ok-t' : 'bad-t') + '">' + jn.pct +
          '%</b> of the ' + n0(jn.loads) + ' units out (' + n0(jn.resolved) + ' traced, from ' +
          n0(jn.cartons) + ' cartons the picks filled).' +
          '<br><b>' + n0(jn.shipped) + '</b> handling units were shipped and <b>' + n0(jn.filled) +
          '</b> were filled by picks; <b class="' + (jn.both ? 'ok-t' : 'bad-t') + '">' + n0(jn.both) +
          '</b> of them are the same number.' +
          (jn.both === 0
            ? ' <b>None of them match, so the two are different handling units</b> - a pick fills a tote and ' +
              'packing builds a new carton, and nothing in this export says which tote became which carton. ' +
              'Lines per packer cannot be had this way, whatever the line key is. Shipped look like <code>' +
              (jn.sampleShipped || []).map(esc).join('</code>, <code>') + '</code>; filled like <code>' +
              (jn.sampleFilled || []).map(esc).join('</code>, <code>') + '</code>.'
            : (jn.pct >= 90
                ? ' Lines per packer an hour is a number worth standing behind.'
                : ' <b>Below ninety percent the rate is built on part of the work</b> - the board says so beside ' +
                  'every figure. A wider task lookback is what closes the gap, not a different sum.'))
        : '')
    : '<b>No line key is set</b>, so a task counts as a line. That is usually right here, and the table below ' +
      'says whether this export has anything better to offer.';

  const lc = j.lineKeyCandidates || { singles: [], pairs: [] };
  const cur = (j.lineKey || []).join(', ');
  const all = (lc.pairs || []).concat(lc.singles || []);
  /* the row in use is not always the best row, and the table already
     sorted the best to the top - say so rather than leaving it to be
     noticed by somebody reading ninety rows */
  const best = all[0];
  const beaten = (best && cur && best.name !== cur)
    ? '<p style="margin-top:10px"><b class="bad-t">The key in use is not the best one in this export.</b> ' +
      '<code>' + esc(cur) + '</code> is in use; <code>' + esc(best.name) + '</code> finds ' +
      n0(best.distinct) + ' lines at ' + best.per + ' picks each. Press <b>Use this</b> on its row.</p>'
    : '';
  const opt = x => '<tr><td><code>' + esc(x.name) + '</code></td>' +
    '<td class="num">' + n0(x.distinct) + '</td>' +
    '<td class="num">' + x.per + '</td>' +
    '<td>' + (x.alsoOnZlod ? '<span class="ok-t">yes</span>' : '<span class="bad-t">no</span>') + '</td>' +
    '<td>' + (cur === x.name
      ? '<span class="ok-t">in use</span>'
      : '<button class="btn" data-use="' + esc(x.name) + '">Use this</button>') + '</td></tr>';
  const suggest = all.length
    ? '<p style="margin-top:14px"><b>What a line key could be.</b> Each of these is filled in on nearly every pick ' +
      'and groups picks into fewer things, which is what separates a line from a pick - one line split across two ' +
      'bins is two tasks. <b>Picks each</b> near 1 means almost nothing is split; much above 2 and the column is ' +
      'probably a bin or an order rather than a line. <b>On ZLOD</b> is whether the same column is filled in on the ' +
      'rows a packer makes, which decides whether packers can be measured in lines as well.</p>' +
      '<table><thead><tr><th>Column(s)</th><th class="num">Lines</th><th class="num">Picks each</th>' +
      '<th>On ZLOD</th><th></th></tr></thead>' +
      '<tbody>' + all.map(opt).join('') + '</tbody></table>' +
      '<p class="hint">Out of ' + n0(lc.picks) + ' picks. <b>Use this</b> writes it to the line key on the ' +
      'Settings tab and leaves everything else alone. It changes only this board - the picker page it used to ' +
      'share the setting with is a separate service now, with its own copy.</p>'
    : '<p style="margin-top:14px">No column in this export groups picks into lines, so a task is the only thing ' +
      'there is to count and <b>blank is the right setting</b>.</p>';

  $('colsOut').innerHTML =
    '<div class="box" style="margin:10px 0">' +
      '<p>' + lk + '</p>' + beaten +
      '<p><b>' + n0(v.zlod) + '</b> ZLOD rows read. ' +
        (v.groupers && v.groupers.length
          ? 'Columns that <b>group</b> them, so each could count something coarser than a handling unit: <b>' +
            v.groupers.map(esc).join('</b>, <b>') + '</b>.'
          : 'No column groups them: apart from the time, bin, person and weight the board already reads, every ' +
            'populated column either names the row or is empty - so a handling unit is the only thing there is ' +
            'to count, and lines per packer cannot come from this export.') +
        (v.ids && v.ids.length ? ' Columns that <b>name</b> one row each: ' + v.ids.map(esc).join(', ') + '.' : '') +
      '</p>' + suggest +
    '</div>' +
    '<table><thead><tr><th>Column</th>' +
      acts.map(a => '<th class="num" colspan="3">' + esc(a) + ' (' + n0(j.acts[a]) + ')</th>').join('') +
      '</tr><tr><th></th>' +
      acts.map(() => '<th class="num">Filled</th><th class="num">Values</th><th class="num">Rows each</th>').join('') +
      '</tr></thead><tbody>' +
      j.columns.map(c => '<tr><td>' + esc(c.name) + '</td>' + acts.map(a => cell(c.by[a])).join('') + '</tr>').join('') +
    '</tbody></table>';
  $('colsMsg').textContent = j.columns.length + ' columns with anything in them, out of ' + j.header.length;

  /* one press rather than typing a column name twice and getting the
     spelling wrong - and it patches the one field, not the block */
  $('colsOut').querySelectorAll('[data-use]').forEach(el => {
    el.onclick = async () => {
      const name = el.dataset.use;
      if(!confirm('Count a line by "' + name + '"?\n\nThis changes what lines mean on this board.')) return;
      el.disabled = true;
      try{
        await save({ lineKey: name }, 'Lines are now counted by ' + name);
        $('bCols').onclick();
      }catch(e){ el.disabled = false; toast('Not set: ' + e.message); }
    };
  });
}
/* The one question the task export cannot answer: a packer's carton goes
   to a staging lane, and the staging lane is the one place the other
   service already pulls every handling unit from. If that file names a
   delivery against the carton, lines per packer is back on. */
function drawBridge(j){
  const o = $('bridgeOut');
  if(!j || !j.ok){
    o.innerHTML = '<div class="box" style="margin:10px 0"><p class="hint">' +
      esc((j && j.why) || 'nothing to read') + '</p></div>';
    return;
  }
  const good = j.bridges && j.bridges.length;
  o.innerHTML = '<div class="box" style="margin:10px 0">' +
    '<p><b>' + n0(j.found) + '</b> of the <b>' + n0(j.shipped) +
      '</b> handling units a packer shipped (<b class="' + (j.pct >= 50 ? 'ok-t' : 'bad-t') + '">' + j.pct +
      '%</b>) are in the handling unit export, out of ' + n0(j.rows) + ' rows in it. ' +
      (j.pct < 20
        ? 'Too few for this to be a bridge - a carton goes to a staging lane, so if it is not in that file the ' +
          'file is not being pulled wide enough yet.'
        : 'That is enough to join on.') + '</p>' +
    (good
      ? '<p><b class="ok-t">These columns carry something against those cartons</b> and could be the delivery:</p>' +
        '<table><thead><tr><th>Column</th><th class="num">Filled</th><th class="num">Values</th>' +
        '<th class="num">Cartons each</th></tr></thead><tbody>' +
        j.bridges.map(c => '<tr><td><code>' + esc(c.name) + '</code></td><td class="num">' + c.filledPct +
          '%</td><td class="num">' + n0(c.distinct) + '</td><td class="num">' + c.per +
          '</td></tr>').join('') + '</tbody></table>' +
        '<p class="hint">A column with <b>more than one carton each</b> is a delivery several cartons went on - ' +
          'which is exactly the link the task export is missing. That column is the way in, and the board could ' +
          'count lines per packer through it.</p>'
      : '<p><b class="bad-t">Nothing in that file names a delivery against those cartons.</b> Every column is ' +
        'either empty on them, or names the carton itself. This route is closed too, and lines per packer needs ' +
        'a pull nobody is making yet.</p>') +
    '</div>';
}
$('bBridge').onclick = async () => {
  $('colsMsg').textContent = 'reading the handling unit export...';
  try{
    drawBridge(await fetch('/api/pack/bridge', { cache: 'no-store' }).then(r => r.json()));
    $('colsMsg').textContent = '';
  }catch(e){ $('colsMsg').textContent = e.message; }
};
$('bCols').onclick = async () => {
  $('colsMsg').textContent = 'reading...';
  try{ drawCols(await fetch('/api/pack/columns', { cache: 'no-store' }).then(r => r.json())); }
  catch(e){ $('colsMsg').textContent = e.message; }
};

/* ---- what each export carries ------------------------------------------- */
function drawExport(j){
  const o = $('expOut');
  if(!j || !j.ok){
    o.innerHTML = '<p class="hint">' + esc((j && j.why) || 'nothing to read') + '</p>';
    $('expMsg').textContent = '';
    return;
  }
  /* the money answer first, because it is the only reason anybody opens
     this tab twice */
  const m = j.money || [];
  const verdict = m.length
    ? '<p><b class="ok-t">Something in here could be money.</b> ' +
      m.map(c => '<code>' + esc(c.name) + '</code>' + (c.money === 'named' ? ' (named like a value)' : ' (decimals with a spread)')).join(', ') +
      '. Worth looking at the values before believing it.</p>'
    : '<p><b class="bad-t">There is no money in this export.</b> No column is named like a value, and none ' +
      'holds decimals with the spread a price would have. That is what EWM is: it records what was moved, ' +
      'not what it was worth. A value would have to come from the sales or billing side and be joined on ' +
      'the delivery.</p>';
  o.innerHTML =
    '<div class="box" style="margin:10px 0">' + verdict +
      '<p class="hint">' + n0(j.rows) + ' rows, ' + j.columns.length + ' columns with anything in them, out of ' +
      j.header.length + '.</p></div>' +
    '<table><thead><tr><th>Column</th><th class="num">Filled</th><th class="num">Values</th>' +
      '<th class="num">Rows each</th><th>Looks like</th></tr></thead><tbody>' +
      j.columns.map(c => '<tr><td>' + esc(c.name) + (c.money ? ' <span class="ok-t">money?</span>' : '') + '</td>' +
        '<td class="num">' + c.filledPct + '%</td>' +
        '<td class="num">' + n0(c.distinct) + '</td>' +
        '<td class="num">' + (c.per || '-') + '</td>' +
        '<td class="hint">' + esc((c.sample || []).join(' | ').slice(0, 70)) + '</td></tr>').join('') +
    '</tbody></table>';
  $('expMsg').textContent = '';
}
$('bExp').onclick = async () => {
  $('expMsg').textContent = 'reading...';
  try{
    const k = encodeURIComponent($('expKind').value);
    drawExport(await fetch('/api/pack/profile?kind=' + k, { cache: 'no-store' }).then(r => r.json()));
  }catch(e){ $('expMsg').textContent = e.message; }
};
$('expKind').onchange = () => $('bExp').onclick();

/* ---- the tabs ----------------------------------------------------------- */
document.querySelectorAll('.tabs button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + b.dataset.pane));
    /* reading every column of a 60,000 row export is not free, so it
       happens when the tab is opened rather than on the way past it */
    if(b.dataset.pane === 'cols' && !$('colsOut').innerHTML) $('bCols').onclick();
    if(b.dataset.pane === 'exports' && !$('expOut').innerHTML) $('bExp').onclick();
  };
});
load();
