'use strict';
/* The pack page. Everything on it comes from one call to /api/pack, which
   is built from the exports this service is already holding - so it is as
   live as the board is, and it needs nothing dropped on it. */

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n0 = n => (n == null ? '-' : Math.round(n).toLocaleString());
const n1 = n => (n == null ? '-' : (Math.round(n * 10) / 10).toLocaleString());
/* the export carries the floor's own clock, so it is read as written */
const clock = ms => {
  if(!ms) return '';
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
};
/* data-mod is not decoration: the shared stylesheet hides a row of tiles
   that has nothing dockable in it, and it is what lets a tile be put away
   with ctrl-click like every other card in here. */
let tileN = 0;
/* Money, short enough to live in a tile on a TV: 1.2M, 48.3k, 921.
   The exact figure goes in the sub-line, because a tile that rounds is
   fine and a tile that rounds with no way to see the real number is
   not. */
function money(n, cur){
  const v = Math.round(Number(n) || 0);
  const sign = (cur === 'USD' || !cur) ? '$' : '';
  const a = Math.abs(v);
  if(a >= 1000000) return sign + (v / 1000000).toFixed(a >= 10000000 ? 0 : 1) + 'M';
  if(a >= 1000) return sign + (v / 1000).toFixed(a >= 100000 ? 0 : 1) + 'k';
  return sign + v.toLocaleString();
}
const moneyFull = (n, cur) => (((cur && cur !== 'USD') ? cur + ' ' : '$') +
  Math.round(Number(n) || 0).toLocaleString());

const tile = (lab, val, sub) =>
  '<div class="tile" data-mod="pack-' + (++tileN) + '"><div class="lab">' + lab + '</div><div class="val">' + val + '</div>' +
  '<div class="sub">' + (sub || '&nbsp;') + '</div></div>';
const show = (id, on) => { const e = $(id); if(e) e.hidden = !on; };

/* Which bench the page is scoped to, or null for the whole floor. */
let pick = null;

/* The chart under the tiles answers one of two questions depending on
   what is selected, and they are not the same question.

   With a bench picked, it is that bench through the day: when it was busy
   and whether the work arriving lined up with the work leaving.

   With nothing picked it is every bench against every other, which is the
   comparison the tiles cannot make - a tile is a number in a box and the
   eye cannot rank fourteen of them. Out is drawn over arriving in the same
   track, so green inside blue is work that came in and went out, and blue
   showing past green is work that came in and stayed. */
function drawHours(b){
  $('hoursWhat').innerHTML = pick
    ? '<b>' + esc(pick) + '</b> through the day. <button class="more" id="allBenches">Every bench</button>'
    : 'Every bench. Click one above to follow it through the day.';
  (pick ? benchDay : allBenches)(b);
  wireAll(b);
}

/* Every bench, one row each, with units out drawn inside the work that
   arrived rather than beside it.

   Laid end to end these two read as a stack - "146 went out, 788 are
   still standing there" - which is not true, because a pick is not a
   unit. Several picks feed one carton. So the green sits INSIDE the blue
   on one shared scale and at half its height: a bar within a bar says
   "this much of that", where two bars end to end say "this plus that".
   The ratio is printed beside it either way, because a picture should not
   be the only place a number lives.

   With a line key set the arriving bar is delivery LINES rather than raw
   picks, which is a far closer comparison - one line split across two
   bins stops counting twice. Without one it is picks, and the page says
   so rather than printing the same number under a better name. */
function allBenches(b){
  const st = (b.stations || []).slice().sort((x, y) => MV(y) - MV(x) || y.in - x.in);
  if(!st.length){ $('hours').innerHTML = '<p class="hint">No bench sent or took anything.</p>'; return; }
  /* Arriving is picks AND internal moves, and on this floor the moves
     run four to one against the picks - which is why "in" looked wild
     against "out" until the two were shown apart. The bar counts picks:
     a pick is work somebody brought to the bench to be packed, where an
     internal move is as often stock being shuffled into it. */
  const lines = !!b.summary.linesIn;
  const inOf = x => (lines && x.inLines != null) ? x.inLines : (x.inPick != null ? x.inPick : x.in);
  const word = lines ? 'lines' : 'picks';
  const moves = (b.stations || []).reduce((a, x) => a + (x.inMove || 0), 0);
  const top = Math.max.apply(null, st.map(x => Math.max(MV(x), inOf(x))).concat([1]));
  const sumOut = st.reduce((a, x) => a + MV(x), 0);
  const sumIn = st.reduce((a, x) => a + inOf(x), 0);
  const floor = sumOut > 0 ? sumIn / sumOut : null;

  $('hours').innerHTML =
    '<div class="brow head"><div class="lab"></div>' +
      '<div>' + (lines ? 'Lines' : 'Picks') + ' arriving, with ' + MW(2) + ' out inside</div>' +
      '<div class="n">Out</div><div class="n">In</div><div class="r">Per ' + MW(1) + '</div></div>' +
    st.map(x => {
      const inn = inOf(x);
      const per = MV(x) > 0 ? inn / MV(x) : null;
      /* against the floor, not against one: one to one is impossible and a
         bench at the floor's own rate is simply normal */
      const off = (per != null && floor) ? per / floor : null;
      const cls = off == null ? '' : off >= 2 ? ' hot' : off >= 1.4 ? ' warm' : '';
      const title = x.bin + ': ' + n0(MV(x)) + ' ' + MW(MV(x)) + ' out, ' + n0(inn) + ' ' + word + ' in' +
        (x.inMove ? ' and ' + n0(x.inMove) + ' internal moves' : '') +
        (per == null ? ' and nothing out' : ', ' + n1(per) + ' arriving per unit out against ' + n1(floor) + ' across the floor') +
        '. Click to follow it through the day.';
      return '<button class="brow" data-bin="' + esc(x.bin) + '" title="' + esc(title) + '">' +
        '<div class="lab">' + esc(x.bin) + '</div>' +
        '<div class="track">' +
          '<span class="in" style="width:' + (inn / top * 100) + '%"></span>' +
          '<span class="out" style="width:' + (MV(x) / top * 100) + '%"></span>' +
        '</div>' +
        '<div class="n">' + n0(MV(x)) + '</div>' +
        '<div class="n in">' + n0(inn) + '</div>' +
        '<div class="r' + cls + '">' + (per == null ? 'none out' : n1(per)) + '</div></button>';
    }).join('') +
    '<p class="hint" style="margin:10px 0 0">One scale, busiest bench ' + n0(top) + '. The green sits inside the blue ' +
      'because it is a share of it, not an amount on the end of it: <b>' + (floor ? n1(floor) : '-') + ' ' + word +
      ' arrive for every unit that leaves</b> across the floor, and <b>Per unit</b> is that same number at each bench. ' +
      (lines ? '' : 'Arriving counts <b>picks</b> only: the rows feeding these benches carry no delivery line, so ' +
        'there is nothing to collapse them into. ') +
      (moves ? '<b>' + n0(moves) + '</b> internal moves also landed at these benches and are not in the bars - stock ' +
        'being shuffled into a bench is not work brought to it to be packed.' : '') + '</p>';
  $('hours').querySelectorAll('[data-bin]').forEach(el => {
    el.onclick = () => { pick = el.dataset.bin; redraw(b); };
  });
}

/* One bench, hour by hour. */
function benchDay(b){
  const rows = (b.benchHours || {})[pick] || [];
  if(!rows.length){ $('hours').innerHTML = '<p class="hint">Nothing with a time on it at ' + esc(pick) + '.</p>'; return; }
  /* One scale for both tracks. Separate scales let a bench that sent out
     one unit an hour draw a full green bar, which is the opposite of what
     this chart is for - the whole point is seeing blue run past green. */
  const top = Math.max.apply(null, rows.map(h => Math.max(h.out, h.in)).concat([1]));
  $('hours').innerHTML =
    '<div class="hrow head"><div class="lab"></div><div>Units out</div><div class="n"></div><div>Work arriving</div><div class="n"></div></div>' +
    rows.map(h =>
      '<div class="hrow"><div class="lab">' + String(h.hour).padStart(2, '0') + ':00</div>' +
      '<div class="track"><span class="out" style="width:' + (h.out / top * 100) + '%"></span></div>' +
      '<div class="n">' + n0(h.out) + '</div>' +
      '<div class="track"><span class="in" style="width:' + (h.in / top * 100) + '%"></span></div>' +
      '<div class="n">' + n0(h.in) + '</div></div>').join('') +
    '<p class="hint" style="margin:10px 0 0">One scale, busiest hour ' + n0(top) + '.</p>';
}

function wireAll(b){
  const a = $('allBenches');
  if(a) a.onclick = () => { pick = null; redraw(b); };
}

/* The benches. Each one is a button: pressing it takes the hour chart and
   the crew list down to that bench, which is the question the chart could
   not answer before - which bench is this work going to. */
/* Is a bench taking work in faster than it is shipping it out?
   Arrivals are not units - several picks feed one carton - so in > out is
   normal everywhere and means nothing on its own. What means something is
   a bench running well off the floor's own ratio, which is what this
   compares against. */
function backlog(b){
  const tin = b.stations.reduce((a, s) => a + s.in, 0);
  const tout = b.stations.reduce((a, s) => a + s.out, 0);
  const floor = tout > 0 ? tin / tout : 0;
  return b.stations.map(st => {
    if(st.in < 8) return null;
    if(st.out === 0) return { bin: st.bin, why: 'nothing has left it', hard: true };
    if(!floor) return null;
    const r = st.in / st.out / floor;
    return r >= 2 ? { bin: st.bin, why: n1(r) + '&times; the floor&rsquo;s rate of taking work in', hard: false } : null;
  }).filter(Boolean);
}

function drawBenches(b){
  const top = Math.max.apply(null, b.stations.map(x => x.out).concat([1]));
  const back = backlog(b);
  const backOf = {};
  back.forEach(x => { backOf[x.bin] = x; });
  $('benches').innerHTML = b.stations.map(st => {
    const share = st.out / top;
    const cls = st.out === 0 ? 'idle' : share > 0.66 ? 'hot' : share > 0.33 ? 'warm' : '';
    /* units are confirmed in bursts, so at some benches the middle gap is
       zero minutes - true and useless. Fall back to the pace across the
       stretch the bench was open. */
    const pace = st.gapMed != null && st.gapMed >= 0.5 ? n1(st.gapMed) + ' min apart'
               : st.perUnitMin != null ? n1(st.perUnitMin) + ' min each' : '';
    const queue = b.queueKnown ? (st.queue ? n0(st.queue) + ' waiting' : 'nothing waiting') : '';
    const bk = backOf[st.bin];
    const title = st.bin + ': ' + n0(st.out) + ' out, ' + n0(st.in) + ' arriving, ' + n0(st.lb) + ' lb' +
      (st.people ? ', ' + st.people + (st.people === 1 ? ' person' : ' people') : '') +
      '. Click to follow this bench through the day.';
    const live = st.activeMin ? n1(st.activeMin / 60) + ' h active' : '';
    return '<button class="bn ' + cls + (bk ? ' back' : '') + (pick === st.bin ? ' on' : '') +
      '" data-bin="' + esc(st.bin) + '" title="' + esc(title) + '">' +
      '<div class="b">' + esc(st.bin) + (bk ? ' <span class="flag">filling</span>' : '') + '</div>' +
      /* lines shipped is the number this floor is held to, so it is the
         one in the big type; units are underneath it */
      /* lines when there are lines, units when there are not, and it
          says which - a big bare number that changes meaning between
          one day and the next is worse than no number */
      '<div class="o">' + n0(MV(st)) + '<span class="u">' + MW(MV(st)) + '</span></div>' +
      '<div class="d">' + (MEASURE === 'lines' ? n0(st.out) + ' units &middot; ' + (pace || '') : (pace || '&nbsp;')) + '</div>' +
      '<div class="d">' + (st.lb ? n0(st.lb) + ' lb' : '&nbsp;') + '</div>' +
      '<div class="d">' + (st.people ? st.people + (st.people === 1 ? ' packer' : ' packers') : 'nobody') +
        (live ? ' &middot; ' + live : '') + '</div></button>';
  }).join('');
  $('benches').querySelectorAll('[data-bin]').forEach(el => {
    el.onclick = () => { pick = (pick === el.dataset.bin) ? null : el.dataset.bin; redraw(b); };
  });
  /* the only line here that is worth the space is the one naming a bench
     to go and look at. Everything else about what these tiles hold is in
     the README. */
  $('benchNote').innerHTML = back.length
    ? 'Filling: ' + back.map(x => '<b>' + esc(x.bin) + '</b> ' + x.why).join(', ') + '.'
    : '';
  $('benchNote').hidden = !back.length;
}
function redraw(b){
  drawHours(b);
  drawCrew(b);
  drawBenches(b);
}

/* Who packed, as something to look at rather than a page of table.
   Ten rows is a glance; everyone else is one line and a button, because
   on a busy day the people who only fed the benches outnumber the
   packers three to one and burying the crew under them helps nobody. */
let crewOpen = false;
/* Click a packer and everybody else folds away; click again and they come
   back. A supervisor having a word with one person does not want the
   other twelve on the screen while they do it. */
let solo = null;
let VOL_UNIT = '';          // the floor's own volume unit, read off the export
const SHOWN = 10;
/* The header the rows never had: a big bold number with nothing above it
   is a number nobody can check. */
let LINES_OUT = false;
function crewHead(b){
  return '<div class="pk head"><div class="nm">Packer</div>' +
    '<div class="track">' + (MEASURE === 'lines' ? 'Lines out' : 'Units out') + '</div>' +
    '<div class="out">' + (MEASURE === 'lines' ? 'Lines' : 'Units') + '</div>' +
    '<div class="lr">' + (LINES_OUT ? 'Lines/h' : '&nbsp;') + '</div>' +
    '<div class="pr">Working</div></div>';
}
function packerRow(p, top){
  const v = MV(p);
  const share = top > 0 ? Math.max(2, Math.round(v / top * 100)) : 0;
  const det = [
    n1(p.hours) + ' h active of ' + n1(p.span) + ' h on',
    p.rate == null ? null : n1(p.rate) + ' units an hour',
    p.lines ? n0(p.lines) + ' lines' : null,
    /* cube is the only measure of a packer's workload besides units that
       every row they make carries: a bench of big light boxes and a bench
       of small heavy ones read the same in units and not in cube */
    p.volRate == null || !p.volRate ? null : n1(p.volRate) + ' ' + esc(VOL_UNIT) + ' an hour',
    p.stations.length ? p.stations.slice(0, 3).join(' ') : null,
    /* first and last are a time on one day and nothing at all across
       thirty, so a range says how many days they worked instead */
    p.first ? clock(p.first) + ' - ' + clock(p.last) : (p.days > 1 ? p.days + ' days' : null)
  ].filter(Boolean).join(' &middot; ');
  /* lines an hour is the figure a supervisor is asked to stand behind, so
     it says how much of this packer's work it could actually see */
  const lr = p.linesRate == null
    ? '<span class="dim">-</span>'
    : n1(p.linesRate) + (p.seen < 90 ? '<small class="part">' + p.seen + '% seen</small>' : '');
  return '<div class="pk' + (solo === p.who ? ' solo' : '') + '" data-who="' + esc(p.who) + '">' +
    '<div class="nm">' + esc(p.who) + '<small>' + n0(p.lb) + ' lb' + (p.moves ? ' &middot; ' + n0(p.moves) + ' moves' : '') + '</small></div>' +
    '<div class="track"><span style="width:' + share + '%"></span></div>' +
    '<div class="out">' + n0(v) + '</div>' +
    '<div class="lr">' + lr + '</div>' +
    '<div class="pr">' + (p.productive == null ? '&nbsp;' : p.productive + '% working') +
      '<i><span style="width:' + (p.productive == null ? 0 : p.productive) + '%"></span></i></div>' +
    '<div class="det">' + det + '</div>' +
  '</div>';
}
/* Who was on one bench. The whole-day numbers - active hours, productive
   share, rate - belong to the person's whole day and not to this bench, so
   they are not repeated here pretending otherwise. What this answers is
   who sent units out of this bench and how much of their day it was. */
function benchCrew(b){
  const on = b.people.filter(p => (p.byBin || {})[pick] > 0)
    .map(p => ({ p, n: p.byBin[pick] })).sort((x, y) => y.n - x.n);
  const top = on.length ? on[0].n : 0;
  $('crew').innerHTML = on.length
    ? on.map(({ p, n }) =>
        '<div class="pk">' +
        '<div class="nm">' + esc(p.who) + '<small>' + (p.out > n ? n0(p.out - n) + ' more off other benches' : 'only this bench') + '</small></div>' +
        '<div class="track"><span style="width:' + (top > 0 ? Math.max(2, Math.round(n / top * 100)) : 0) + '%"></span></div>' +
        '<div class="out">' + n0(n) + '</div>' +
        '<div class="pr">' + Math.round(n / p.out * 100) + '% of their day<i><span style="width:' +
          Math.round(n / p.out * 100) + '%"></span></i></div>' +
        '<div class="det">' + n1(p.hours) + ' h active' +
          (p.first ? ' &middot; ' + clock(p.first) + ' - ' + clock(p.last) : (p.days > 1 ? ' &middot; ' + p.days + ' days' : '')) +
          '</div></div>').join('')
    : '<p class="hint">Nobody sent a unit out of ' + esc(pick) + '.</p>';
  $('feeders').innerHTML = '<p class="hint" style="margin-top:10px"><b>' + esc(pick) + '</b> only. ' +
    '<button class="more" id="crewAll">Whole floor</button></p>';
  const all = $('crewAll');
  if(all) all.onclick = () => { pick = null; redraw(b); };
}
function drawCrew(b){
  if(pick) return benchCrew(b);
  LINES_OUT = !!(b.summary && b.summary.linesOut);
  const all = b.people.filter(p => p.out > 0);
  if(solo && !all.some(p => p.who === solo)) solo = null;
  const crew = solo ? all.filter(p => p.who === solo) : all;
  $('crewWhat').innerHTML = solo
    ? '<b>' + esc(solo) + '</b> on their own &middot; click the row again for everyone'
    : (all.length ? 'click a packer to see them on their own' : '');
  const fed = b.people.filter(p => p.out === 0);
  const top = all.length ? Math.max.apply(null, all.map(MV).concat([1])) : 0;
  const show = (solo || crewOpen) ? crew : crew.slice(0, SHOWN);
  $('crew').innerHTML = (show.length ? crewHead(b) : '') +
    (show.map(p => packerRow(p, top)).join('') || '<p class="hint">Nobody sent a unit out.</p>') +
    (crew.length > SHOWN
      ? '<button class="more" id="crewMore">' + (crewOpen ? 'Show the first ' + SHOWN + ' only' : 'Show all ' + crew.length + ' packers') + '</button>'
      : '');
  if(solo) $('crew').innerHTML += '<button class="more" id="crewAllBack">Show every packer</button>';
  const btn = $('crewMore');
  if(btn) btn.onclick = () => { crewOpen = !crewOpen; drawCrew(b); };
  const back = $('crewAllBack');
  if(back) back.onclick = () => { solo = null; drawCrew(b); };
  $('crew').querySelectorAll('.pk[data-who]').forEach(el => {
    el.onclick = () => { solo = (solo === el.dataset.who) ? null : el.dataset.who; drawCrew(b); };
  });
  /* the people who only fed the benches are a count, not a roll call */
  $('feeders').innerHTML = fed.length
    ? '<p class="hint" style="margin-top:10px">' + n0(fed.length) + ' feeding the benches, none out.</p>'
    : '';
}

/* How the range reads in a heading. Taken from the answer rather than
   from whatever is selected now: two clicks in a row put two fetches in
   the air and the heading has to belong to the body under it. */
function rangeName(r){
  if(!r) return 'Today';
  if(r.days === 1) return r.offset ? 'Yesterday' : 'Today';
  return 'Last ' + r.days + ' days';
}
/* A money tile, which is mostly about the times it has no number.
   Three different nothings, and they are not the same thing: the file
   is not here yet, the file is here and says nothing left today, and
   the file is here but is about some other day. Showing $0 for all
   three would be a lie twice over. */
function valueTile(lab, v, sub){
  if(!v || !v.ok) return tile(lab, '&mdash;', (v && v.why) || 'no value feed yet');
  const known = v.deliveries > 0 || v.covers === true;
  return tile(lab, known ? money(v.total, v.currency) : '&mdash;', sub(v));
}
function draw(b){
  const r = b.range || { days: 1 };
  const asked = r.days;
  const has = !!(b && (r.had > 0 || (b.gap && b.gap.loads)));
  show('empty', !has);
  show('body', has);
  if(!has){
    /* three different nothings, and which one it is decides what anybody
       does next: no export at all, an export that does not reach the day
       being asked for, or a range nobody kept a record of */
    const ex = b.exportDays || [];
    $('emptyWhy').innerHTML = !(b.have && b.have.tasks)
      ? 'The warehouse task export has not been read yet. The Admin page says what the pull is doing.'
      : asked > 1
        ? 'Nothing kept for ' + rangeName(r).toLowerCase() + '.' +
          ((b.stored && b.stored.length)
            ? ' The benches have been recorded since <b>' + esc(b.stored[0]) + '</b>.'
            : ' The daily record starts the first time a task export is read, so there is nothing behind today yet.')
        : 'Nothing from the benches on <b>' + esc(r.base || '') + '</b>' + (r.shift ? ' for ' + esc(r.shift) : '') + '. ' +
          (ex.length
            ? 'The export in hand covers <b>' + esc(ex[0]) + (ex.length > 1 ? '</b> to <b>' + esc(ex[ex.length - 1]) : '') + '</b>.'
            : 'The export in hand has no confirmed work in it.');
    return;
  }

  const s = b.summary;
  const multi = asked > 1;
  VOL_UNIT = (b.volUnit || '').toLowerCase();
  /* lines are only offered when the export can actually produce them */
  CAN_LINES = !!s.linesOut;
  const ml = $('mLines');
  if(ml){
    ml.disabled = !CAN_LINES;
    ml.style.opacity = CAN_LINES ? '' : '.45';
    ml.title = CAN_LINES ? 'Count delivery lines rather than handling units'
      : 'This export cannot produce lines per packer - see the note below';
  }
  if(MEASURE === 'lines' && !CAN_LINES){
    MEASURE = 'units';
    document.querySelectorAll('#measure button').forEach(x => x.classList.toggle('on', x.dataset.m === 'units'));
  }
  $('measureWhy').innerHTML = CAN_LINES ? ''
    : '<b>Counting units, because lines are not available.</b> A delivery line is on the picks, never on the row a ' +
      'packer makes, and the handling unit a packer ships is not the one the picks went into - so there is nothing ' +
      'to join them by. Admin &gt; Columns shows the numbers behind that.';
  $('headline').firstChild.nodeValue = 'Pack performance ' +
    (multi ? rangeName(r).toLowerCase() : r.offset ? 'yesterday' : 'at a glance') + ' ';
  $('dayLine').innerHTML = (b.days && b.days.length > 1
      ? esc(b.days[0]) + ' to ' + esc(b.days[b.days.length - 1]) + ' &middot; ' + b.days.length + ' days with work'
      : esc(b.day || '')) +
    (r.shift ? ' &middot; ' + esc(r.shift) : '') +
    /* a day missing from a shift view is usually a day that shift did not
       run, which is not the same as a day nobody kept */
    (multi && r.had < asked
      ? ' &middot; ' + (asked - r.had) + ' of ' + asked + (r.shift ? ' without a ' + esc(r.shift) + ' shift' : ' with nothing kept')
      : '');

  if(b.gap && b.gap.loads){
    const acts = Object.entries(b.activities || {}).sort((x, y) => y[1] - x[1])
      .map(x => '<b>' + esc(x[0]) + '</b> ' + n0(x[1])).join(', ') || 'none';
    $('tiles').innerHTML = [
      tile('Task rows read', n0(b.taskRows), 'from the warehouse task export'),
      tile('Picks to a bench', n0(s.fedIn), 'picked straight to PACK or a PK bench'),
      tile('Pickers', n0(s.pickers), n0(s.picks) + ' picking tasks in the file'),
      tile('Units out the door', '0', 'no loading tasks in this export')
    ].join('');
    $('caveat').innerHTML = '<b>This export has no loading tasks in it, so there is no packing output to show.</b> ' +
      'What came back: ' + acts + '. This page needs <b>ZLOD</b> rows.' +
      /* the pull's own account of itself, so nobody has to go to another
         machine and find a log to see why this page is empty */
      (b.source ? '<br><br><b>Built from:</b> ' + esc(b.source.name || '(none)') + ', ' +
        n0(b.source.rows) + ' rows, read ' + (b.source.readAt ? new Date(b.source.readAt).toLocaleString() : 'never') +
        (b.source.status && b.source.status !== 'ok' ? ' (' + esc(b.source.status) + ')' : '') : '') +
      (b.notes && b.notes.length
        ? '<br><br><b>The pull said:</b><br><code style="font-size:12px;line-height:1.7">' +
          b.notes.map(l => esc(l)).join('<br>') + '</code>'
        : '<br><br><b>No cycle has fetched a task export since this copy started.</b>');
  } else {
    const L = s.lane || { truck: {}, parcel: {} };
    /* "today", "yesterday", "over 7 days" - the heading word, lowercased
       to sit inside a tile label */
    const rangeWord = r.days === 1 ? (r.offset ? 'yesterday' : 'today') : 'over ' + r.days + ' days';
    const seenNote = n => s.seen >= 90 ? n : n + ' &middot; ' + n0(s.seen) + '% traced';
    /* three different nothings: no key at all, a key that reached no
       carton, and a real number. Saying which is the whole job here. */
    const noKey = b.linesAreTasks ? 'no delivery column in this export'
      : 'no carton could be traced back to its picks';
    const haveOut = !!s.linesOut;
    $('tiles').innerHTML = [
      tile('Orders shipped this week', !haveOut ? '-' : (weekOrders == null ? '&hellip;' : n0(weekOrders)),
        !haveOut ? noKey : 'deliveries out over the last seven days'),
      tile('Orders out the door', !haveOut ? '-' : n0(s.orders),
        !haveOut ? noKey : seenNote('deliveries in what went out')),
      /* The warehouse prices nothing - these two come from ECC, over a
         join on the delivery number, and each says plainly when it
         cannot be stood behind rather than showing a zero. */
      valueTile('$ shipped' + (rangeWord ? ' ' + rangeWord : ''), (b.value || {}).shipped, v =>
        v.deliveries
          ? moneyFull(v.total, v.currency) + ' over ' + n0(v.deliveries) + ' deliveries' +
            (v.shiftFiltered ? ', ' + n0(v.shiftFiltered) + ' on another shift' : '')
          : (v.covers ? 'nothing went out' : 'that file is not about ' + (rangeWord || 'this range') +
             (v.fileDays && v.fileDays.length ? ' - it holds ' + v.fileDays.join(', ') : ''))),
      valueTile('$ picked, waiting', (b.value || {}).pick, v =>
        v.deliveries
          ? moneyFull(v.total, v.currency) + ' over ' + n0(v.deliveries) + ' deliveries' +
            (v.pct < 100 ? ' - ' + v.pct + '% of them priced' : '')
          : 'none of the picked deliveries are in the value file'),
      tile('Lines out the door', !haveOut ? '-' : n0(s.lines),
        !haveOut ? noKey : seenNote('delivery lines in what went out')),
      tile('Lines an hour <small>parcel</small>', L.parcel && L.parcel.linesPerHour != null ? n1(L.parcel.linesPerHour) : '-',
        L.parcel ? n0(L.parcel.out) + ' units over ' + n1(L.parcel.hours) + ' h' : ''),
      tile('Lines an hour <small>truck</small>', L.truck && L.truck.linesPerHour != null ? n1(L.truck.linesPerHour) : '-',
        L.truck ? n0(L.truck.out) + ' units over ' + n1(L.truck.hours) + ' h' : ''),
      tile('Active packers', n0(s.packers),
        s.stations + ' benches in use' + (s.helpers ? ', ' + n0(s.helpers) + ' feeding them' : ''))
    ].join('');
    $('caveat').innerHTML = 'Units sent to LOADING, not cartons sealed.';
    /* a saved line key that is being beaten by another pair is the
       difference between a board of numbers and a board of dashes, and
       it is invisible unless somebody is told */
    if(b.betterKey && !s.linesOut){
      $('tiles').insertAdjacentHTML('afterend',
        '<div class="warnbox" style="border-left-color:#C62828"><b>The line key is set to <code>' +
        esc((b.lineKey || []).join(', ')) + '</code> and it is not finding anything.</b> This export points at <code>' +
        esc(b.betterKey.join(', ')) + '</code> instead. <b>Admin &gt; Columns</b> has a <b>Use this</b> button on that row.</div>');
    }
  }

  drawBenches(b);

  drawHours(b);

  /* the three that answer "which bench stopped", "where did the time go"
     and "are we ahead of yesterday" - none of which the rest of the page
     could be made to say */
  drawHeat(b);
  drawGaps(b);
  drawPace(b);

  drawCrew(b);

  drawGoing(b);
}

/* What is going out: the weight spread and the line spread, side by side,
   with the two weight figures worth saying beside the ring rather than
   spent on four tiles that said the same thing four ways. */
const RINGC = ['#C8E6C9', '#81C784', '#4CAF50', '#2E7D32', '#1B5E20'];
function donut(parts, total){
  const R = 54, C = 2 * Math.PI * R;
  let at = 0;
  const arcs = parts.map((p, i) => {
    const frac = total > 0 ? p[1] / total : 0;
    const el = '<circle r="' + R + '" cx="64" cy="64" fill="none" stroke="' + RINGC[i % RINGC.length] +
      '" stroke-width="20" stroke-dasharray="' + (frac * C).toFixed(2) + ' ' + C.toFixed(2) +
      '" stroke-dashoffset="' + (-at * C).toFixed(2) + '" transform="rotate(-90 64 64)"><title>' +
      esc(p[0]) + ': ' + n0(p[1]) + '</title></circle>';
    at += frac;
    return el;
  }).join('');
  return '<svg width="128" height="128" viewBox="0 0 128 128">' + arcs + '</svg>';
}
function drawGoing(b){
  const w = b.weights;
  const total = w.buckets.reduce((a, x) => a + x[1], 0);
  $('weights').innerHTML =
    '<div class="ring">' + donut(w.buckets, total) +
      '<div>' +
        '<div class="big"><div>Middle weight<b>' + n1(w.median) + ' lb</b></div>' +
          '<div>Heaviest<b>' + n0(w.max) + ' lb</b></div></div>' +
        '<div class="leg">' + w.buckets.map((x, i) =>
          '<div><i style="background:' + RINGC[i % RINGC.length] + '"></i>' + esc(x[0]) + ' &middot; <b>' +
          n0(x[1]) + '</b> ' + (total ? Math.round(x[1] / total * 100) + '%' : '') + '</div>').join('') +
        '</div>' +
      '</div>' +
    '</div>' +
    '<p class="hint" style="margin:10px 0 0">Every unit that left a bench, by what it weighed. ' +
      n0(w.whole) + ' of ' + n0(w.n) + ' (' + w.wholePct + '%) land on an exact pound.</p>';

  if(!b.orders){ $('orderMix').innerHTML = '<p class="hint">The order export is not loaded, so the line spread is not available.</p>'; return; }
  const o = b.orders;
  const maxL = Math.max.apply(null, Object.values(o.byLines).concat([1]));
  $('orderMix').innerHTML =
    '<div class="barrow head" style="color:var(--muted);font-size:11px"><div class="lab">Lines a delivery</div>' +
      '<div class="track" style="background:none"></div><div class="n">Deliveries</div></div>' +
    Object.keys(o.byLines).sort((a, c) => (a === '6+' ? 9 : +a) - (c === '6+' ? 9 : +c)).map(k =>
      '<div class="barrow"><div class="lab">' + esc(k) + (k === '1' ? ' line' : ' lines') + '</div><div class="track">' +
      '<div class="fill" style="width:' + (o.byLines[k] / maxL * 100) + '%"></div></div>' +
      '<div class="n">' + n0(o.byLines[k]) + '</div></div>').join('') +
    '<p class="hint" style="margin:10px 0 0"><b>' + n0(o.deliveries) + '</b> deliveries open with <b>' +
      n0(o.lines) + '</b> lines on them, ' + n1(o.perDelivery) + ' each. <b>' + o.singlePct +
      '%</b> are a single line, and <b>' + n0(o.picked) + '</b> are picked and still here.</p>';
}

/* Range and shift, in the picker page's vocabulary so the two read the
   same. Today is the live export; everything behind it comes out of the
   stored daily rollup, which is why a brand new install shows today and
   fills the rest in as the days go past. */
let RANGE = 'today', RSHIFT = 'all';
/* Units or lines, for the whole page at once. A supervisor is held to
   lines; the floor's export does not always carry them, and switching
   the board between the two beats arguing about which a bare number is. */
let MEASURE = 'units';
let CAN_LINES = false;
function wireMeasure(){
  document.querySelectorAll('#measure button').forEach(el => {
    el.onclick = () => {
      if(el.dataset.m === 'lines' && !CAN_LINES) return;
      MEASURE = el.dataset.m;
      document.querySelectorAll('#measure button').forEach(x => x.classList.toggle('on', x === el));
      load();
    };
  });
}
/* the word for one of whatever is being counted, so no label has to be
   written twice */
const MW = n => (MEASURE === 'lines' ? (n === 1 ? 'line' : 'lines') : (n === 1 ? 'unit' : 'units'));
/* and the figure itself, falling back when lines are not to be had */
const MV = o => (MEASURE === 'lines' && o && o.lines != null) ? o.lines : (o ? o.out : 0);
function query(){
  const days = RANGE === 'today' || RANGE === 'yesterday' ? 1 : +RANGE;
  const off = RANGE === 'yesterday' ? 1 : 0;
  return 'days=' + days + (off ? '&offset=' + off : '') +
         (RSHIFT !== 'all' ? '&shift=' + encodeURIComponent(RSHIFT) : '');
}
function wireRange(){
  document.querySelectorAll('#range button').forEach(el => {
    el.onclick = () => {
      RANGE = el.dataset.range;
      document.querySelectorAll('#range button').forEach(x => x.classList.toggle('on', x === el));
      pick = null; crewOpen = false;
      load();
    };
  });
  const rs = $('rangeShift');
  if(rs) rs.onchange = () => { RSHIFT = rs.value; pick = null; load(); };
}
/* the dropdown is whatever the schedule says, filled in once the first
   answer comes back and left alone after that so a redraw does not reset
   what somebody chose */
let shiftsFilled = false;
function fillShifts(names){
  const rs = $('rangeShift');
  if(!rs || shiftsFilled || !names || !names.length) return;
  rs.innerHTML = '<option value="all">All shifts</option>' +
    names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
  rs.value = RSHIFT;
  shiftsFilled = true;
}

/* Clicking a range and then a shift puts two fetches in the air at once,
   and the slower one used to land last and win. Only the newest is
   allowed to draw. */
let seq = 0;

/* ------------------------------------------------------------------ *
   Bench by hour.

   The hour chart answers "when was the floor busy" and the bench rows
   answer "which bench did the work", but neither answers the one a
   supervisor walks the floor with: which bench went quiet, and when. A
   grid of benches down and hours across does, because a hole in a row is
   visible from across the room in a way a number in a table is not.    */
function drawHeat(b){
  const bh = b.benchHours || {};
  const bins = (b.stations || []).map(s => s.bin).filter(x => bh[x] && bh[x].length);
  if(!bins.length){ $('heat').innerHTML = '<p class="hint">Nothing with a time on it yet.</p>'; return; }
  let lo = 24, hi = 0, top = 1;
  bins.forEach(bin => bh[bin].forEach(h => {
    if(h.hour < lo) lo = h.hour;
    if(h.hour > hi) hi = h.hour;
    if(h.out > top) top = h.out;
  }));
  const hours = [];
  for(let h = lo; h <= hi; h++) hours.push(h);
  const cell = (bin, h) => {
    const r = (bh[bin] || []).find(x => x.hour === h);
    const n = r ? r.out : 0;
    /* an hour with nothing in it is the point of the whole card, so it
       keeps the background rather than becoming a pale green */
    const a = n > 0 ? 0.18 + 0.82 * Math.pow(n / top, 0.6) : 0;
    const st = n > 0 ? 'background:rgba(46,125,50,' + a.toFixed(3) + ')' : '';
    return '<div class="hcell" style="' + st + '" title="' + esc(bin) + ' at ' +
      String(h).padStart(2, '0') + ':00 - ' + n0(n) + ' out"></div>';
  };
  $('heat').innerHTML =
    '<div class="heat" style="grid-template-columns:62px repeat(' + hours.length + ', 1fr)">' +
      '<div></div>' + hours.map(h => '<div class="htop">' + String(h).padStart(2, '0') + '</div>').join('') +
      bins.map(bin => '<div class="hlab">' + esc(bin) + '</div>' + hours.map(h => cell(bin, h)).join('')).join('') +
    '</div>' +
    '<p class="hint" style="margin:10px 0 0">Units out, each hour, each bench. The busiest single hour was ' +
      n0(top) + '. <b>A gap in a row is a bench that stopped.</b></p>';
}

/* Where the time went: the longest quiet stretch at each bench. A bench
   averaging a unit every four minutes with a seventy minute hole in it
   did not have a pace problem, it had an hour of something else. */
function drawGaps(b){
  const rows = (b.stations || []).filter(s => s.gapMax != null && s.out > 1)
    .sort((x, y) => y.gapMax - x.gapMax);
  if(!rows.length){
    $('gaps').innerHTML = '<p class="hint">' + ((b.range && b.range.days > 1)
      ? 'A quiet stretch is only measured inside one day; pick Today or Yesterday.'
      : 'Not enough confirmations at any bench to measure a quiet stretch.') + '</p>';
    return;
  }
  const top = rows[0].gapMax || 1;
  const colour = m => m >= 60 ? '#C62828' : m >= 30 ? 'var(--hubbell-gold, #FFC000)' : '#2E7D32';
  $('gaps').innerHTML =
    '<div class="pace head"><div class="lab">Bench</div><div>Longest quiet stretch</div>' +
      '<div class="n">Min</div><div class="d">Over 30</div></div>' +
    rows.map(s => '<div class="pace"><div class="lab">' + esc(s.bin) + '</div>' +
      '<div class="track"><span class="now" style="width:' + (s.gapMax / top * 100) +
        '%;background:' + colour(s.gapMax) + '"></span></div>' +
      '<div class="n">' + n0(s.gapMax) + '</div>' +
      '<div class="d">' + (s.gapsOver ? n0(s.gapsOver) + '&times;' : '-') + '</div></div>').join('') +
    '<p class="hint" style="margin:10px 0 0">The longest run of minutes with nothing leaving the bench, and how many ' +
      'times it ran past thirty. A bench can hold a good average and still have an hour missing from it.</p>';
}

/* Pace: this window against the one before it, hour by hour, running
   total. "Are we ahead or behind right now" is what the board gets asked
   at eleven in the morning and could not answer. */
/* orders over the last seven days, which is a different window from the
   one the page is showing, so it is its own small fetch and is cached
   until the shift filter moves */
let weekOrders = null, weekQ = '';
async function loadWeek(b){
  const sh = (b.range && b.range.shift) || '';
  const q = 'days=7' + (sh ? '&shift=' + encodeURIComponent(sh) : '');
  if(q === weekQ) return;
  weekQ = q;
  try{
    const w = await fetch('/api/pack?' + q, { cache: 'no-store' }).then(r => r.json());
    weekOrders = (w && w.summary) ? w.summary.orders : null;
  }catch(e){ weekOrders = null; }
  const t = $('tiles');
  if(t && t.firstChild && weekOrders != null){
    const v = t.firstChild.querySelector('.val');
    if(v) v.innerHTML = n0(weekOrders);
  }
}

let paceCache = null;
async function drawPace(b){
  const r = b.range || { days: 1, offset: 0 };
  const prevOffset = (r.offset || 0) + r.days;
  const q = 'days=' + r.days + '&offset=' + prevOffset + (r.shift ? '&shift=' + encodeURIComponent(r.shift) : '');
  $('paceWhat').textContent = r.days > 1 ? 'against the ' + r.days + ' days before' : 'against the day before';
  let prev = null;
  if(paceCache && paceCache.q === q) prev = paceCache.data;
  else {
    try{
      prev = await fetch('/api/pack?' + q, { cache: 'no-store' }).then(x => x.json());
      paceCache = { q, data: prev };
    }catch(e){ prev = null; }
  }
  const nowH = b.hours || [], wasH = (prev && prev.hours) || [];
  if(!nowH.length){ $('pace').innerHTML = '<p class="hint">Nothing out yet.</p>'; return; }
  const sum = (rows, h) => rows.filter(x => x.hour <= h).reduce((a, x) => a + x.out, 0);
  let lo = 24, hi = 0;
  nowH.concat(wasH).forEach(x => { if(x.hour < lo) lo = x.hour; if(x.hour > hi) hi = x.hour; });
  const top = Math.max(sum(nowH, hi), sum(wasH, hi), 1);
  const line = [];
  for(let h = lo; h <= hi; h++){
    const a = sum(nowH, h), c = sum(wasH, h);
    const d = c > 0 ? Math.round((a - c) / c * 100) : null;
    line.push('<div class="pace"><div class="lab">' + String(h).padStart(2, '0') + ':00</div>' +
      '<div class="track"><span class="was" style="width:' + (c / top * 100) + '%"></span>' +
      '<span class="now" style="width:' + (a / top * 100) + '%"></span></div>' +
      '<div class="n">' + n0(a) + '</div>' +
      '<div class="d ' + (d == null ? '' : d >= 0 ? 'up' : 'down') + '">' +
        (d == null ? '-' : (d >= 0 ? '+' : '') + d + '%') + '</div></div>');
  }
  const endA = sum(nowH, hi), endB = sum(wasH, hi);
  const verdict = !endB ? 'Nothing to compare against yet.'
    : '<b>' + n0(endA) + ' against ' + n0(endB) + '</b>' +
      (endA === endB ? '.' : ', ' + n1(Math.abs(endA - endB) / endB * 100) + '% ' + (endA > endB ? 'ahead.' : 'behind.'));
  $('pace').innerHTML =
    '<div class="pace head"><div class="lab">By</div><div>Running total</div><div class="n">Out</div><div class="d">vs</div></div>' +
    line.join('') +
    '<p class="hint" style="margin:10px 0 0">Green is this ' + (r.days > 1 ? 'window' : 'day') + ' adding up hour by ' +
      'hour; the grey mark behind it is where the ' + (r.days > 1 ? 'window before' : 'day before') + ' had got to by ' +
      'the same hour. ' + verdict + '</p>';
}

/* ------------------------------------------------------------------ *
   The layout editor.

   The board already had shift-drag and ctrl-click docking, which work
   and which nobody finds. This is the same three powers - move, resize,
   hide - with a handle on every card and a button to turn it on, plus a
   way to copy the arrangement out as text and paste one back in. The
   arrangement lives in this browser; the text is how it travels.        */

const WIDTHS = [['w-third', '⅓'], ['w-half', '½'], ['w-twothirds', '⅔'], ['w-full', '1']];
const LKEY = 'slh.pack.layout.v2';
/* what the floor asked for is on the page; the rest waits in the tray.
   Hiding beats deleting - somebody will want the heat grid one morning. */
const HIDE_BY_DEFAULT = ['pace', 'heat', 'gaps', 'caveat'];
let editing = false;

const secs = () => [...document.querySelectorAll('#sheet > .sec')];
function layoutNow(){
  return { v: 1, order: secs().map(s => s.dataset.sec),
    width: Object.fromEntries(secs().map(s => [s.dataset.sec, (WIDTHS.find(w => s.classList.contains(w[0])) || ['w-full'])[0]])),
    hidden: secs().filter(s => s.classList.contains('gone')).map(s => s.dataset.sec) };
}
function saveLayout(){ try{ localStorage.setItem(LKEY, JSON.stringify(layoutNow())); }catch(e){} }
function applyLayout(L){
  if(!L) return;
  const sheet = $('sheet'), by = {};
  secs().forEach(s => { by[s.dataset.sec] = s; });
  (L.order || []).forEach(id => { if(by[id]) sheet.appendChild(by[id]); });
  secs().forEach(s => {
    const w = (L.width || {})[s.dataset.sec];
    if(w){ WIDTHS.forEach(x => s.classList.remove(x[0])); s.classList.add(w); }
    s.classList.toggle('gone', (L.hidden || []).indexOf(s.dataset.sec) >= 0);
  });
  drawTray();
}
function loadLayout(){
  let L = null;
  try{ L = JSON.parse(localStorage.getItem(LKEY) || 'null'); }catch(e){}
  if(!L) L = { v: 2, order: secs().map(x => x.dataset.sec), width: {}, hidden: HIDE_BY_DEFAULT.slice() };
  applyLayout(L);
}
/* hidden cards come back from a tray, the way a docked module does on
   the board, so hiding one is never a one way door */
function drawTray(){
  const hid = secs().filter(s => s.classList.contains('gone'));
  const t = $('tray');
  t.innerHTML = hid.map(s => '<button class="dock-tile" data-show="' + esc(s.dataset.sec) + '">&#9633; ' +
    esc(s.dataset.name || s.dataset.sec) + '</button>').join('');
  t.classList.toggle('has', hid.length > 0);
  t.querySelectorAll('[data-show]').forEach(b => {
    b.onclick = () => { const s = secs().find(x => x.dataset.sec === b.dataset.show); if(!s) return;
      s.classList.remove('gone'); saveLayout(); drawTray(); };
  });
}

function buildBars(){
  secs().forEach(s => {
    if(s.querySelector(':scope > .secbar')) return;
    const bar = document.createElement('div');
    bar.className = 'secbar';
    bar.innerHTML = '<span class="gr" draggable="true" title="Drag to move this card">&#8597;</span>' +
      '<span class="nm">' + esc(s.dataset.name || s.dataset.sec) + '</span>' +
      WIDTHS.map(w => '<button data-w="' + w[0] + '" title="' + w[1] + ' of the width">' + w[1] + '</button>').join('') +
      '<button class="x" data-hide="1" title="Hide this card">Hide</button>';
    s.prepend(bar);
    bar.querySelectorAll('[data-w]').forEach(b => {
      b.onclick = () => { WIDTHS.forEach(x => s.classList.remove(x[0])); s.classList.add(b.dataset.w); saveLayout(); markWidths(); };
    });
    bar.querySelector('[data-hide]').onclick = () => { s.classList.add('gone'); saveLayout(); drawTray(); };
    /* drag by the handle only, so a chart inside the card can still be
       clicked while the editor is open */
    const gr = bar.querySelector('.gr');
    gr.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', s.dataset.sec); s.classList.add('drag'); });
    gr.addEventListener('dragend', () => { s.classList.remove('drag'); });
  });
  markWidths();
}
function markWidths(){
  secs().forEach(s => s.querySelectorAll('.secbar [data-w]').forEach(b =>
    b.classList.toggle('on', s.classList.contains(b.dataset.w))));
}
function wireSheetDrop(){
  const sheet = $('sheet');
  sheet.addEventListener('dragover', e => {
    if(!editing) return;
    e.preventDefault();
    const dragging = sheet.querySelector('.sec.drag');
    if(!dragging) return;
    const over = e.target.closest && e.target.closest('.sec');
    if(!over || over === dragging) return;
    const r = over.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    if(after) over.after(dragging); else over.before(dragging);
  });
  sheet.addEventListener('drop', e => { if(!editing) return; e.preventDefault(); saveLayout(); });
}
function setEditing(on){
  editing = on;
  document.body.classList.toggle('editing', on);
  if(on) buildBars();
  const b = $('editBtn');
  if(b){ b.textContent = on ? 'Done editing' : 'Edit layout'; b.classList.toggle('primary', on); }
  $('layoutIo').classList.remove('show');
}
function initEditor(){
  wireSheetDrop();
  loadLayout();
  const bar = document.querySelector('.bar');
  if(bar && !$('editBtn')){
    const b = document.createElement('button');
    b.className = 'btn bartool'; b.id = 'editBtn'; b.textContent = 'Edit layout';
    b.title = 'Move, resize or hide the cards on this page';
    b.onclick = () => setEditing(!editing);
    const reset = $('resetLayout');
    if(reset) reset.parentElement.insertBefore(b, reset); else bar.appendChild(b);
  }
  $('edDone').onclick = () => setEditing(false);
  $('edReset').onclick = () => {
    if(!confirm('Put every card back where it started?')) return;
    try{ localStorage.removeItem(LKEY); }catch(e){}
    location.reload();
  };
  $('edExport').onclick = () => {
    const io = $('layoutIo');
    io.value = JSON.stringify(layoutNow(), null, 1);
    io.classList.add('show'); io.select();
    try{ document.execCommand('copy'); }catch(e){}
  };
  $('edImport').onclick = () => {
    const io = $('layoutIo');
    if(!io.classList.contains('show')){ io.value = ''; io.classList.add('show'); io.focus(); return; }
    let L = null;
    try{ L = JSON.parse(io.value); }catch(e){ alert('That is not a layout: ' + e.message); return; }
    applyLayout(L); saveLayout(); markWidths();
    io.classList.remove('show');
  };
}

async function load(){
  const mine = ++seq;
  try{
    const b = await fetch('/api/pack?' + query(), { cache: 'no-store' }).then(r => r.json());
    if(mine !== seq) return;
    tileN = 0;                 // the same tiles keep the same names across a redraw
    fillShifts(b.shiftNames);
    draw(b);
    loadWeek(b);
  }catch(e){}
}
wireRange();
wireMeasure();
initEditor();
load();
/* the same live stream the board uses: when the exports change, redraw */
try{
  const es = new EventSource('/api/events');
  es.addEventListener('data', load);
}catch(e){}
setInterval(load, 60000);
