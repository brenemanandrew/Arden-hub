/* Shared client for the v2 pages. Fetches /api/board, listens for pushes,
   and offers the drawing helpers both pages use. Each page defines
   window.renderBoard(model). Also: the lane label mode (tote or order) and
   Shift-drag module rearranging. */
(function(){
  const S = { model: null, es: null, timer: null, failing: false, failures: 0 };
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));

  async function load(){
    try{
      const r = await fetch('/api/board', { cache: 'no-store' });
      if(!r.ok) throw new Error('HTTP ' + r.status);
      S.model = await r.json();
      S.failing = false; S.failures = 0;
      if(window.renderBoard) window.renderBoard(S.model);
      document.body.classList.remove('offline');
    }catch(e){
      S.failing = true; S.failures++;
      // one missed fetch is normal while the service restarts; only say so after a few
      if(S.failures >= 3) document.body.classList.add('offline');
      if(window.renderOffline) window.renderOffline(e);
    }
  }
  function rerender(){ if(S.model && window.renderBoard) window.renderBoard(S.model); }
  function connect(){
    load();
    try{
      S.es = new EventSource('/api/events');
      S.es.addEventListener('data', load);
      S.es.addEventListener('settings', load);
      S.es.addEventListener('status', load);
      S.es.onopen = () => { if(S.failing) load(); };
    }catch(e){}
    S.timer = setInterval(load, 60000);
  }

  /* ---- lane label mode: tote numbers first (pickers), or order numbers ---- */
  const MODE_KEY = 'slh-lanemode';
  function laneMode(){ try{ return localStorage.getItem(MODE_KEY) === 'order' ? 'order' : 'tote'; }catch(e){ return 'tote'; } }
  function setLaneMode(m){ try{ localStorage.setItem(MODE_KEY, m); }catch(e){} syncModeBtn(); rerender(); }
  function syncModeBtn(){ const b = $('modeBtn'); if(!b) return; const m = laneMode(); b.textContent = m === 'tote' ? 'Showing: TOTE #' : 'Showing: ORDER #'; b.title = 'Click to show ' + (m === 'tote' ? 'order' : 'tote') + ' numbers on the lanes'; }
  function initModeBtn(){ const b = $('modeBtn'); if(b){ b.onclick = () => setLaneMode(laneMode() === 'tote' ? 'order' : 'tote'); syncModeBtn(); } }

  /* ---- lane layout: the physical line, or paired zones ---- */
  const LAYOUT_KEY = 'slh-lanelayout';
  function laneLayout(){ try{ return localStorage.getItem(LAYOUT_KEY) === 'zones' ? 'zones' : 'line'; }catch(e){ return 'line'; } }
  function setLaneLayout(v){ try{ localStorage.setItem(LAYOUT_KEY, v); }catch(e){} syncLayoutBtn(); rerender(); }
  function syncLayoutBtn(){ const b = $('layoutBtn'); if(!b) return; b.textContent = laneLayout() === 'line' ? 'Layout: LINE' : 'Layout: ZONES'; b.title = 'Click to show lanes ' + (laneLayout() === 'line' ? 'grouped by zone' : 'in their physical order'); }
  function initLayoutBtn(){ const b = $('layoutBtn'); if(b){ b.onclick = () => setLaneLayout(laneLayout() === 'line' ? 'zones' : 'line'); syncLayoutBtn(); } }
  /* every staging lane in floor order: one area (prefix) per line, so the
     screen reads the way the floor is walked. Columns line up across rows. */
  function lineBlock(m, byBin, oldestBin){
    const all = [].concat(m.laneRows[0], m.laneRows[1], m.laneRows[2]);
    const order = [], groups = {};
    all.forEach(b => { const p = (/^([A-Z]\d{2})/i.exec(b) || [0, b])[1].toUpperCase(); if(!groups[p]){ groups[p] = []; order.push(p); } groups[p].push(b); });
    const cols = Math.max.apply(null, order.map(p => groups[p].length));
    const used = all.filter(b => byBin[b] && byBin[b].totes).length;
    const late = all.filter(b => byBin[b] && byBin[b].band === 'late').length;
    return '<div class="zone line" id="zone-line" data-mod="zone-line"><h3>Staging line <span>' + (all.length - used) + ' open</span> ' + (late ? '<span class="late">' + late + ' late</span>' : '') + '</h3>' +
      order.map(p => {
        const r = groups[p];
        const open = r.filter(b => !(byBin[b] && byBin[b].totes)).length;
        return '<div class="linerow"><a class="rlab" href="/tv?area=' + encodeURIComponent(p) + '" title="Open the ' + esc(p) + ' deep view (for a TV by that area)"><b>' + esc(p) + '</b><span>' + open + ' open</span></a>' +
          '<div class="lrow" style="grid-template-columns:repeat(' + cols + ',1fr)">' + r.map(b => laneCard(byBin[b] || { bin: b, totes: 0, orders: [], alsoIn: [] }, oldestBin)).join('') + '</div></div>';
      }).join('') + '</div>';
  }

  /* ---- helpers ---- */
  function fmtClock(ms){ const d = new Date(ms || Date.now()); return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function ago(ms){ if(!ms) return 'never'; const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : (Math.round(s / 360) / 10) + ' h ago'; }
  function feedState(f){
    if(!f) return { cls: 'bad', text: 'no data' };
    if(f.via === 'cloud' && f.pushStale) return { cls: 'bad', text: 'no update since ' + ago(f.receivedAt) };
    if(f.pull === 'sap-down') return { cls: 'bad', text: 'SAP not reachable on host' };
    if(f.pull === 'failing') return { cls: 'bad', text: 'pull failing' };
    if(f.stale) return { cls: 'warn', text: 'stale, updated ' + ago(f.updated) };
    if(f.pull === 'stopped') return { cls: 'warn', text: 'pull stopped, data from ' + ago(f.updated) };
    if(f.pull === 'paused') return { cls: 'warn', text: 'paused, data from ' + ago(f.updated) };
    return { cls: 'ok', text: 'updated ' + ago(f.updated) };
  }
  /* Exceptions are what a person has to act on, so they get an icon and a
     word, never colour alone. */
  function tagFor(l){
    if(l.hosp) return '<span class="tag hosp">PROBLEM SOLVE</span>';
    if(!l.totes) return '<span class="tag open">OPEN</span>';
    const loose = l.orders.map(o => o.loose).filter(Boolean)[0];
    if(loose) return '<span class="tag loose">&#9888; TOTE IN ' + esc(loose.toUpperCase()) + '</span>';
    if(l.orders.some(o => !o.known)) return '<span class="tag unknown">&#9888; NOT ON REPORT</span>';
    if(l.alsoIn && l.alsoIn.length) return '<span class="tag split">&#9888; SPLIT +' + esc(l.alsoIn.join(' ')) + '</span>';
    if(l.ready) return '<span class="tag ready">&#10003; READY</span>';
    const n = l.orders.reduce((a, o) => a + o.openLines, 0);
    return '<span class="tag wait">' + (n ? n + ' TO PICK' : 'PICKING') + '</span>';
  }
  function primaryLabel(l){
    const mode = laneMode();
    if(!l.totes) return '';
    if(mode === 'order'){
      return l.orders.length > 1 ? l.orders.length + ' orders' : (l.orders[0] ? l.orders[0].doc : l.totes + ' tote' + (l.totes > 1 ? 's' : ''));
    }
    const ids = l.toteIds || [];
    if(!ids.length) return l.totes + ' tote' + (l.totes > 1 ? 's' : '');
    return ids[0] + (ids.length > 1 ? ' <span class="more">+' + (ids.length - 1) + '</span>' : '');
  }
  function secondaryLabel(l){
    if(!l.totes) return '';
    const mode = laneMode();
    if(mode === 'order'){ const ids = l.toteIds || []; return ids.length ? ('tote ' + ids[0] + (ids.length > 1 ? ' +' + (ids.length - 1) : '')) : ''; }
    return l.orders.length > 1 ? l.orders.length + ' orders' : (l.orders[0] ? l.orders[0].doc : '');
  }
  function laneCard(l, oldestBin){
    const cls = ['lane', l.hosp ? 'hosp-lane' : (l.totes ? l.band : 'empty')];
    if(l.ready) cls.push('ready');
    if(l.bin === oldestBin) cls.push('oldest');
    if(l.totes && !l.hosp && (l.orders.some(o => o.loose || !o.known) || (l.alsoIn && l.alsoIn.length))) cls.push('exception');
    const tip = l.bin + (l.totes ? ': ' + l.totes + ' tote(s), oldest ' + l.age + '\n' + l.orders.map(o => o.doc + (o.complete ? ' ready' : ' ' + o.openLines + ' to pick')).join('\n') + (l.toteIds && l.toteIds.length ? '\ntotes ' + l.toteIds.join(', ') : '') : ': open');
    return '<div class="' + cls.join(' ') + '" title="' + esc(tip) + '">' +
      '<div class="lhead"><span class="bin">' + esc(l.bin) + '</span>' + (l.totes ? '<span class="age">' + esc(l.age) + '</span>' : '') + '</div>' +
      (l.multi ? '<div class="multi">' + l.orders.length + '</div>' : '') +
      (!l.totes && !l.hosp ? '<div class="openword">OPEN</div>' : '') +
      (l.totes ? '<div class="field"><span class="fl">' + (laneMode() === 'order' ? 'Order' : 'Tote') + '</span><span class="fv">' + primaryLabel(l) + '</span></div>' : '') +
      (l.ready && l.band !== 'fresh' ? '<div class="agebar ' + l.band + '"></div>' : '') +
      tagFor(l) +
      (l.hospLinked ? '<div class="link" title="this order also has a tote in problem solve"></div>' : '') +
    '</div>';
  }
  function zoneBlock(z, byBin, oldestBin){
    // a prefix with only a lane or two (E05-00) shares the row above it rather
    // than stretching one card across the whole width
    const merged = [];
    z.rows.filter(r => r.length).forEach(r => { if(r.length < 3 && merged.length) merged[merged.length - 1] = merged[merged.length - 1].concat(r); else merged.push(r.slice()); });
    const rows = merged.map(r => '<div class="lrow">' + r.map(b => laneCard(byBin[b] || { bin: b, totes: 0, orders: [], alsoIn: [] }, oldestBin)).join('') + '</div>').join('');
    const open = z.total - z.used;
    const late = z.late ? '<span class="late">' + z.late + ' late</span>' : '';
    return '<div class="zone" id="zone-' + z.id + '" data-mod="zone-' + z.id + '"><h3>' + esc(z.label) + ' <span>' + open + ' open</span> ' + late + '</h3>' + rows + '</div>';
  }
  /* What needs a person right now, worst first.

     A board that only draws the numbers makes everybody find the problem
     for themselves, every time they look. This says it: one line each for
     the few things that are actually wrong, each with the view that shows
     it. When nothing is wrong it draws nothing at all - an empty strip is
     the good news, and a row of green ticks would only teach people to
     stop reading it.

     Order is severity, not category. The feed comes first because if the
     numbers are old nothing else on the page is true. */
  function attention(b){
    if(!b || !b.summary) return [];
    const s = b.summary, p = b.pace || {}, out = [];
    const th = b.thresholds || {};
    const lateH = Math.round((th.lateMin || 180) / 60);

    if(b.feed && b.feed.stale){
      out.push({ level: 'bad', what: 'The board is not updating',
        detail: 'nothing new since ' + ago(b.feed.updated) + '. Everything below is that old.',
        go: '/admin', label: 'Why' });
    }
    /* the one thing that is not a problem but IS an action: trailers can go */
    if(s.ready > 0){
      out.push({ level: 'go', what: s.ready + (s.ready === 1 ? ' lane is' : ' lanes are') + ' ready to ship',
        detail: 'every line picked; they can leave now', go: '#clearNext', label: 'Which' });
    }
    const late = s.late || 0;
    if(late > 0){
      const o = s.oldest || {};
      out.push({ level: late > 4 ? 'bad' : 'warn',
        what: late + (late === 1 ? ' lane past ' : ' lanes past ') + lateH + ' hours',
        detail: o.lane ? ('oldest is ' + o.lane + ' at ' + o.age + (o.ready ? ', ready to ship' : '')) : '',
        go: '#clearNext', label: 'Clear next' });
    }
    const ex = s.exceptions || {};
    if(ex.total > 0){
      const bits = [];
      if(ex.loose) bits.push(ex.loose + ' still in pick');
      if(ex.split) bits.push(ex.split + ' split across lanes');
      if(ex.hospital) bits.push(ex.hospital + ' in problem solve');
      if(ex.unknown) bits.push(ex.unknown + ' not on the order report');
      out.push({ level: 'warn', what: ex.total + (ex.total === 1 ? ' order needs' : ' orders need') + ' a person',
        detail: bits.join(', '), go: '#stuck', label: 'Exceptions' });
    }
    if(s.occupancyPct >= 85){
      out.push({ level: s.occupancyPct >= 95 ? 'bad' : 'warn',
        what: 'Staging is ' + s.occupancyPct + '% full',
        detail: s.lanesUsed + ' of ' + s.lanesTotal + ' lanes in use, ' + (s.openLanes || 0) + ' open',
        go: '#map', label: 'Lane map' });
    }
    /* pace only speaks when there is a goal to be behind */
    if(p.goal > 0 && p.onPace && p.onPace.behind > 0){
      out.push({ level: 'warn', what: p.onPace.behind + ' behind where the day should be',
        detail: p.ordersClearedToday + ' of ' + p.goal + ' cleared' + (p.hoursLeft ? ', ' + p.hoursLeft + ' h left' : ''),
        go: '#pace', label: 'Pace' });
    }
    return out;
  }
  /* Put a card under the reader's eye and say so. Positioned by hand
     rather than scrollIntoView({behavior:'smooth'}), which some browsers -
     televisions especially - accept and then ignore. */
  function jumpToCard(t){
    if(!t) return false;
    const top = t.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop || 0) - 8;
    const sc = document.scrollingElement || document.documentElement;
    try{ window.scrollTo(0, top); }catch(err){ sc.scrollTop = top; }
    if(Math.abs(sc.scrollTop - top) > 4) sc.scrollTop = top;
    t.classList.add('att-lit');
    setTimeout(() => t.classList.remove('att-lit'), 1600);
    return true;
  }
  /* A card named in the address, because the strip on another page sent us
     here. Called once the cards have something in them. */
  function jumpToHash(){
    const id = (location.hash || '').replace('#', '');
    if(!id) return;
    const t = document.getElementById(id);
    if(t) setTimeout(() => jumpToCard(t), 60);
  }

  /* Draw it into an element. A card on this page is scrolled to; a card
     that lives on the live board becomes a link to it. */
  function drawAttention(el, b){
    if(typeof el === 'string') el = $(el);
    if(!el) return;
    const items = attention(b);
    if(!items.length){ el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = items.map(i =>
      '<div class="att ' + i.level + '">' +
        '<div class="att-t">' + esc(i.what) + (i.detail ? '<small>' + esc(i.detail) + '</small>' : '') + '</div>' +
        '<a class="att-go" href="' + esc(i.go) + '">' + esc(i.label) + '</a>' +
      '</div>').join('');
    /* The home page carries this strip too, and its cards are not there -
       they are on the live board. A button whose card is missing became a
       button that did nothing at all, which is how this shipped. So: if the
       card is on this page, scroll to it; if it is not, the button is a link
       to the board, and the board scrolls to it on arrival. */
    el.querySelectorAll('.att-go[href*="#"]').forEach(a => {
      const id = (a.getAttribute('href') || '').split('#')[1];
      if(!id) return;
      if(!document.getElementById(id)){ a.setAttribute('href', '/ops#' + id); a.onclick = null; return; }
      a.setAttribute('href', '#' + id);
      a.onclick = e => { e.preventDefault(); jumpToCard(document.getElementById(id)); };
    });
  }

  function rankList(items, maxMin){
    if(!items.length) return '<div class="empty-note">Nothing staged.</div>';
    const max = Math.max(maxMin || 0, items[0].ageMin || 1, 60);
    const mode = laneMode();
    return '<div class="rank">' + items.map(x => {
      const w = Math.max(3, Math.min(100, x.ageMin / max * 100)).toFixed(1);
      const who = mode === 'tote' && x.toteIds && x.toteIds.length ? ('tote ' + x.toteIds.slice(0, 2).join(', ') + (x.toteIds.length > 2 ? ' +' + (x.toteIds.length - 2) : '')) : (x.orders.slice(0, 2).join(', ') + (x.orders.length > 2 ? ' +' + (x.orders.length - 2) : ''));
      return '<div class="l">' + esc(x.bin) + '</div><div class="track"><i class="' + x.band + '" style="width:' + w + '%"></i></div>' +
        '<div class="r"><span class="a">' + esc(x.age) + '</span>' + (x.ready ? '<span class="tag ready">&#10003; READY</span>' : '') + '</div>' +
        '<div class="note">' + esc(who) + (x.note ? ' &middot; ' + esc(x.note) : '') + '</div>';
    }).join('') + '</div>';
  }
  function stuckList(items, limit){
    if(!items.length) return '<div class="empty-note">Nothing stuck. Every staged order is either ready or being picked.</div>';
    return '<div class="stuck">' + items.slice(0, limit || 8).map(x =>
      '<div class="row"><span class="l">' + esc(x.lane) + '</span><span class="d">' + esc(x.doc) + '</span><span class="why">' + esc(x.reasons.join('; ')) + '</span><span class="a">' + esc(x.age) + '</span></div>').join('') +
      (items.length > (limit || 8) ? '<div class="empty-note">+' + (items.length - (limit || 8)) + ' more on the ops page</div>' : '') + '</div>';
  }
  /* Cleared per hour: today in blue, yesterday in gray behind it as context.
     One axis, thin columns, direct label on the current hour only. */
  function paceChart(p, opts){
    opts = opts || {};
    const [h0, h1] = p.hourRange;
    const hours = []; for(let h = h0; h <= h1; h++) hours.push(h);
    const W = opts.width || 600, H = opts.height || 160, padL = 28, padB = 22, padT = 14;
    const plotW = W - padL - 6, plotH = H - padB - padT;
    const max = Math.max(1, ...hours.map(h => Math.max(p.byHour.today[h] || 0, p.byHour.yesterday[h] || 0)));
    const step = max <= 5 ? 1 : max <= 12 ? 2 : max <= 30 ? 5 : 10;
    const top = Math.ceil(max / step) * step;
    const slot = plotW / hours.length, bw = Math.min(24, slot * 0.34);
    const y = v => padT + plotH - (v / top) * plotH;
    const nowH = new Date().getHours();
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Orders cleared per hour, today and yesterday">';
    s += '<g class="grid">';
    for(let v = 0; v <= top; v += step) s += '<line x1="' + padL + '" x2="' + (W - 6) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/>';
    s += '</g><g class="axis">';
    for(let v = 0; v <= top; v += step) s += '<text x="' + (padL - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + v + '</text>';
    hours.forEach((h, i) => { if(i % (hours.length > 12 ? 2 : 1) === 0) s += '<text x="' + (padL + slot * (i + 0.5)).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + (h % 12 || 12) + (h < 12 ? 'a' : 'p') + '</text>'; });
    s += '</g>';
    hours.forEach((h, i) => {
      const cx = padL + slot * (i + 0.5);
      const ty = p.byHour.today[h] || 0, yy = p.byHour.yesterday[h] || 0;
      s += '<rect class="bar-y" x="' + (cx + 1).toFixed(1) + '" y="' + y(yy).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (y(0) - y(yy)).toFixed(1) + '" rx="3"><title>' + (h % 12 || 12) + (h < 12 ? 'am' : 'pm') + ' yesterday: ' + yy + ' orders</title></rect>';
      s += '<rect class="bar-t" x="' + (cx - bw - 1).toFixed(1) + '" y="' + y(ty).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (y(0) - y(ty)).toFixed(1) + '" rx="3"><title>' + (h % 12 || 12) + (h < 12 ? 'am' : 'pm') + ' today: ' + ty + ' orders</title></rect>';
      if(h === nowH && ty) s += '<text class="lbl" x="' + (cx - bw / 2 - 1).toFixed(1) + '" y="' + (y(ty) - 4).toFixed(1) + '" text-anchor="middle">' + ty + '</text>';
    });
    s += '<line x1="' + padL + '" x2="' + (W - 6) + '" y1="' + y(0).toFixed(1) + '" y2="' + y(0).toFixed(1) + '" stroke="var(--axis)"/>';
    s += '</svg>';
    return s;
  }
  function paceTable(p){
    const [h0, h1] = p.hourRange; let rows = '';
    for(let h = h0; h <= h1; h++) rows += '<tr><td>' + (h % 12 || 12) + (h < 12 ? ' am' : ' pm') + '</td><td class="n">' + (p.byHour.today[h] || 0) + '</td><td class="n">' + (p.byHour.yesterday[h] || 0) + '</td></tr>';
    return '<table class="tv"><thead><tr><th>Hour</th><th class="n">Today</th><th class="n">Yesterday</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ---- Shift-drag rearranging ----
     Hold Shift, then drag any module (a tile, a zone, a card). Siblings slide
     out of the way as it moves; the order is remembered on this screen.
     groups: arrays of container ids that can exchange modules. */
  function initShiftDrag(key, groups){
    let shift = false, drag = null;
    const setShift = on => { shift = on; document.body.classList.toggle('shift', on); };
    addEventListener('keydown', e => { if(e.key === 'Shift') setShift(true); });
    addEventListener('keyup', e => { if(e.key === 'Shift') setShift(false); });
    addEventListener('blur', () => setShift(false));
    const groupOf = el => groups.find(g => g.some(id => { const c = $(id); return c && c.contains(el); }));
    const containers = () => groups.flat().map(id => $(id)).filter(Boolean);
    addEventListener('pointerdown', e => {
      if(!e.shiftKey) return;
      const mod = e.target.closest('[data-mod]');
      if(!mod || !groupOf(mod)) return;
      e.preventDefault();
      const r = mod.getBoundingClientRect();
      const ghost = mod.cloneNode(true);
      ghost.className += ' drag-ghost'; ghost.removeAttribute('id'); ghost.removeAttribute('data-mod');
      ghost.style.width = r.width + 'px'; ghost.style.height = r.height + 'px';
      document.body.appendChild(ghost);
      drag = { mod, ghost, dx: e.clientX - r.left, dy: e.clientY - r.top, group: groupOf(mod) };
      mod.classList.add('dragging');
      moveGhost(e);
    });
    function moveGhost(e){ drag.ghost.style.transform = 'translate(' + (e.clientX - drag.dx) + 'px,' + (e.clientY - drag.dy) + 'px)'; }
    addEventListener('pointermove', e => {
      if(!drag) return;
      moveGhost(e);
      const under = document.elementsFromPoint(e.clientX, e.clientY);
      const target = under.map(n => n.closest && n.closest('[data-mod]')).find(n => n && n !== drag.mod && !n.classList.contains('drag-ghost') && drag.group.some(id => { const c = $(id); return c && c.contains(n); }));
      if(target){
        const tr = target.getBoundingClientRect();
        const horizontal = getComputedStyle(target.parentElement).gridAutoFlow === 'column' || getComputedStyle(target.parentElement).display.indexOf('grid') >= 0 && tr.width < target.parentElement.getBoundingClientRect().width * 0.6;
        const after = horizontal ? e.clientX > tr.left + tr.width / 2 : e.clientY > tr.top + tr.height / 2;
        if(after) target.after(drag.mod); else target.before(drag.mod);
      } else {
        // an empty container in the same group
        const c = drag.group.map(id => $(id)).find(c => c && !c.contains(drag.mod) && under.indexOf(c) >= 0);
        if(c) c.appendChild(drag.mod);
      }
    });
    const end = () => {
      if(!drag) return;
      drag.ghost.remove(); drag.mod.classList.remove('dragging');
      const layout = {};
      containers().forEach(c => { layout[c.id] = [...c.querySelectorAll(':scope > [data-mod]')].map(n => n.dataset.mod); });
      try{ localStorage.setItem(key, JSON.stringify(layout)); }catch(e){}
      drag = null;
    };
    addEventListener('pointerup', end); addEventListener('pointercancel', end);
    return {
      apply(){
        let layout = null; try{ layout = JSON.parse(localStorage.getItem(key) || 'null'); }catch(e){}
        if(!layout) return;
        const all = {}; containers().forEach(c => c.querySelectorAll(':scope > [data-mod]').forEach(n => { all[n.dataset.mod] = n; }));
        Object.keys(layout).forEach(cid => { const c = $(cid); if(!c) return; layout[cid].forEach(id => { if(all[id]){ c.appendChild(all[id]); delete all[id]; } }); });
      },
      reset(){ try{ localStorage.removeItem(key); }catch(e){} location.reload(); }
    };
  }

  /* ---- Ctrl+click docking ----
     A docked module leaves its place and shows as a small tile in the tray;
     its neighbours expand to fill. Clicking the tile brings it back. */
  function initDock(key, trayId, onChange){
    let docked = [];
    try{ docked = JSON.parse(localStorage.getItem(key) || '[]'); }catch(e){ docked = []; }
    const save = () => { try{ localStorage.setItem(key, JSON.stringify(docked)); }catch(e){} };
    const nameOf = el => { const h = el.querySelector('h2, h3, .lab, .t'); return h ? (h.childNodes[0] && h.childNodes[0].textContent || h.textContent).trim() : el.dataset.mod; };
    addEventListener('click', e => {
      if(!e.ctrlKey) return;
      const mod = e.target.closest('[data-mod]');
      if(!mod || mod.closest('#' + trayId)) return;
      e.preventDefault();
      if(docked.indexOf(mod.dataset.mod) < 0){ docked.push(mod.dataset.mod); save(); apply(); }
    });
    function apply(){
      const tray = $(trayId); if(!tray) return;
      const names = {};
      document.querySelectorAll('[data-mod]').forEach(el => {
        if(el.closest('#' + trayId)) return;
        const on = docked.indexOf(el.dataset.mod) >= 0;
        el.classList.toggle('docked', on);
        if(on) names[el.dataset.mod] = nameOf(el);
      });
      tray.innerHTML = docked.map(id => '<button class="dock-tile" data-undock="' + esc(id) + '" title="Click to bring this back">&#9633; ' + esc(names[id] || id) + '</button>').join('');
      tray.classList.toggle('has', docked.length > 0);
      tray.querySelectorAll('[data-undock]').forEach(b => { b.onclick = () => { docked = docked.filter(x => x !== b.dataset.undock); save(); apply(); }; });
      if(onChange) onChange(docked);
    }
    return { apply, list: () => docked.slice(), reset(){ docked = []; save(); apply(); } };
  }
  /* One call for any page: Shift-drag between the given container groups,
     Ctrl-click docking into #dock, a Reset button if the page has one. */
  /* Pages built from headings: wrap each h2.ch and what follows it into a
     module so it can be dragged and docked like everything else. Returns
     the ids of the containers that now hold modules. */
  function wrapSections(rootSel){
    const ids = [];
    document.querySelectorAll(rootSel + ' h2.ch').forEach((h, i) => {
      const parent = h.parentElement;
      if(!parent.id) parent.id = 'modc-' + i;
      if(ids.indexOf(parent.id) < 0) ids.push(parent.id);
      const sec = document.createElement('section');
      sec.dataset.mod = 'sec-' + (h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || i);
      parent.insertBefore(sec, h);
      let n = h;
      while(n && !(n.tagName === 'H2' && n.classList.contains('ch') && n !== h)){ const next = n.nextSibling; sec.appendChild(n); n = next; }
    });
    return ids;
  }
  function initModules(pageKey, groups, onDockChange){
    if(!$('dock')){ const d = document.createElement('div'); d.className = 'dock'; d.id = 'dock'; const bar = document.querySelector('.bar, .top'); if(bar) bar.after(d); else document.body.prepend(d); }
    const drag = initShiftDrag('slh-layout-' + pageKey, groups);
    const dock = initDock('slh-dock-' + pageKey, 'dock', onDockChange);
    const btn = $('resetLayout');
    if(btn) btn.onclick = () => { dock.reset(); drag.reset(); };
    const apply = () => { drag.apply(); dock.apply(); };
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
    return { drag, dock, apply };
  }

  window.SLH = { initDock, initModules, wrapSections, connect, load, rerender, laneLayout, setLaneLayout, initLayoutBtn, lineBlock, state: S, esc, fmtClock, ago, feedState, laneCard, zoneBlock, rankList, stuckList, paceChart, paceTable, tagFor, laneMode, setLaneMode, initModeBtn, initShiftDrag, attention, drawAttention, jumpToCard, jumpToHash };
})();
