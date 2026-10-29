/* Shared header bar and the light/dark toggle for every page.
   A page declares <div class="bar" data-page="ops" data-sub="Ops view"
   data-tools="reset,layout,mode" data-feed data-clock data-key data-settings>
   and this fills it in, so every view carries the same bar: Hubbell logo,
   title, page name, tools, feed status, nav, clock. The theme choice is per
   screen (localStorage). */
(function(){
  const KEY = 'slh-theme';
  const BULB = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path class="glass" d="M8.5 14.6a5.5 5.5 0 1 1 7 0c-.7.6-1 1.2-1 1.9V17H9.5v-.5c0-.7-.3-1.3-1-1.9z"/><path d="M9.5 19h5M10.5 21.5h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  function current(){ try{ return localStorage.getItem(KEY) || ''; }catch(e){ return ''; } }
  function apply(){
    const pref = current();
    const dark = pref ? pref === 'dark' : document.body.hasAttribute('data-default-dark');
    document.body.classList.toggle('dark', dark);
    const b = document.getElementById('themeBtn');
    if(b){ b.classList.toggle('lit', !dark); b.title = dark ? 'Lights on: switch this screen to light mode' : 'Lights off: switch this screen to dark mode'; }
  }
  function toggle(){
    const dark = document.body.classList.contains('dark');
    try{ localStorage.setItem(KEY, dark ? 'light' : 'dark'); }catch(e){}
    apply();
  }
  /* The bar, the same on every page. Left to right: the tools that act on
     this screen (theme, then reset layout, then whatever the page adds), a
     gap, and four places to go. Eight flat links used to sit here and
     wrapped to a second line on anything narrower than a wall; four items,
     two of them menus, do not. The menus open on hover for a mouse and on a
     tap for a finger. */
  const NAV = [
    { href: '/', label: 'Home', key: 'home' },
    { label: 'Views', key: 'views', items: [
      ['/tv', 'Floor TV', 'tv', 'every lane, what to clear next, what is stuck'],
      ['/ops', 'Ops view', 'ops', 'pace against goal, cleared per hour, stuck orders'],
      ['/board', 'Classic board', 'board', 'the old board, kept as it was'],
      ['/quad', 'Wall panel', 'quad', 'four views on one screen', 'host'] ] },
    { label: 'Review data', key: 'review', items: [
      ['/pickers', 'Picker performance', 'pickers', 'this shift, today, or a range, against standard'],
      ['/people', 'People', 'people', 'everyone over a week, a month, a year'],
      ['/months', 'Months', 'months', 'the year a month at a time'],
      ['/data', 'Get the data', 'data', 'exports, reports and live links, as files'] ] },
    { href: '/help', label: 'Help', key: 'help' },
    { href: '/admin', label: 'Settings', key: 'admin' }
  ];
  function renderBar(bar){
    const d = bar.dataset, page = d.page || '';
    const tools = (d.tools || '').split(',').map(s => s.trim()).filter(Boolean);
    const pageTools = [];
    if(tools.indexOf('layout') >= 0) pageTools.push('<button id="layoutBtn">Layout: LINE</button>');
    if(tools.indexOf('mode') >= 0) pageTools.push('<button id="modeBtn">Showing: TOTE #</button>');
    if('settings' in d) pageTools.push('<a href="#" id="openSettings">Settings for this screen<small>thresholds, goals, layout</small></a>');
    const nav = NAV.map(n => {
      if(n.items){
        const here = n.items.some(i => i[2] === page);
        return '<div class="dd' + (here ? ' on' : '') + '"><a href="#" class="top" role="button" aria-haspopup="true" aria-expanded="false">' + n.label + '<i>&#9662;</i></a>' +
          '<div class="menu">' + n.items.map(i =>
            '<a href="' + i[0] + '"' + (i[2] === page ? ' class="on"' : '') + (i[4] === 'host' ? ' data-host-only' : '') + '>' + i[1] + '<small>' + i[3] + '</small></a>').join('') +
          '</div></div>';
      }
      return '<a href="' + n.href + '"' + (page === n.key ? ' class="on"' : '') + '>' + n.label + '</a>';
    }).join('');
    bar.innerHTML =
      '<a href="/" class="logo-link" title="Home"><img class="logo" src="/web/logo.png" alt="Hubbell"></a>' +
      '<div class="title" id="title">STAGING LANE <b>HEALTH</b></div>' +
      '<span class="mode" id="modePill"></span>' +
      '<div class="sub" id="zoneName">' + (d.sub || '') + '</div>' +
      ('key' in d ? '<div id="key"></div>' : '') +
      '<div class="grow"></div>' +
      ('feed' in d ? '<div class="feed" id="feed"><span class="d"></span><span id="feedText">connecting</span></div>' : '') +
      '<div class="tools">' +
        '<button class="btn bulb" id="themeBtn" aria-label="Toggle light or dark mode">' + BULB + '</button>' +
        (tools.indexOf('reset') >= 0 ? '<button class="btn bartool" id="resetLayout" title="Put every module back where it started and bring docked ones back">Reset layout</button>' : '') +
        /* what a page adds for itself - layout, what the lanes show, its own
           thresholds - folds into one menu rather than three more buttons;
           with those loose, the Ops bar wrapped to two lines on a laptop */
        (pageTools.length ? '<div class="dd tool"><a href="#" class="btn bartool top" role="button" aria-haspopup="true" aria-expanded="false">This screen<i>&#9662;</i></a><div class="menu">' + pageTools.join('') + '</div></div>' : '') +
      '</div>' +
      '<div class="gap"></div>' +
      '<nav>' + nav + '</nav>' +
      ('clock' in d ? '<div class="clock" id="clock"></div>' : '');
    /* a tap opens a menu and holds it; a tap anywhere else, or Escape, lets go */
    bar.querySelectorAll('.dd > .top').forEach(t => {
      t.addEventListener('click', e => {
        e.preventDefault();
        const dd = t.parentNode, open = dd.classList.contains('open');
        bar.querySelectorAll('.dd.open').forEach(o => { o.classList.remove('open'); o.querySelector('.top').setAttribute('aria-expanded', 'false'); });
        if(!open){ dd.classList.add('open'); t.setAttribute('aria-expanded', 'true'); }
      });
    });
    document.addEventListener('click', e => { if(!e.target.closest('.bar .dd')) bar.querySelectorAll('.dd.open').forEach(o => o.classList.remove('open')); });
    document.addEventListener('keydown', e => { if(e.key === 'Escape') bar.querySelectorAll('.dd.open').forEach(o => o.classList.remove('open')); });
  }
  document.querySelectorAll('.bar[data-page]').forEach(renderBar);
  /* The cloud copy cannot pull, save or configure anything, so everything
     that only makes sense next to SAP is hidden there: mark it
     data-host-only. The answer is remembered for the session so pages do
     not flash the wrong shape while they ask. */
  /* Host or viewer, beside the title. Painted at once from what this tab
     last learned, then confirmed by the status call, so it never flickers
     between the two. */
  const sayMode = (cloud, hostView) => { const p = document.getElementById('modePill'); if(!p) return;
    p.textContent = cloud ? 'Viewer' : 'Host';
    p.title = cloud ? 'The cloud copy: it shows what the host PC sends it and cannot change anything' : 'The host PC: the copy that reads SAP and feeds the cloud';
    /* host view is a second fact, not a replacement for the first: this is
       still the viewer, and it still says so */
    let h = document.getElementById('hostViewPill');
    if(cloud && hostView){
      if(!h){
        h = document.createElement('button');
        h.id = 'hostViewPill'; h.className = 'mode hostview';
        h.title = 'Host view is on for this screen: everything the host PC shows is visible here, but nothing can be changed. Click to go back to the plain viewer.';
        h.onclick = () => { const f = document.createElement('form'); f.method = 'POST'; f.action = '/quad/lock'; document.body.appendChild(f); f.submit(); };
        p.parentNode.insertBefore(h, p.nextSibling);
      }
      h.textContent = 'Host view';
    } else if(h) h.remove();
  };
  try{
    if(sessionStorage.getItem('slh-mode') === 'cloud') document.body.classList.add('cloud');
    if(sessionStorage.getItem('slh-hostview') === '1') document.body.classList.add('hostview');
    sayMode(document.body.classList.contains('cloud'), document.body.classList.contains('hostview'));
  }catch(e){}
  fetch('/api/status', { cache: 'no-store' }).then(r => r.json()).then(s => {
    const cloud = !!(s && s.server && s.server.mode === 'cloud');
    /* host view: what the copy hides from an ordinary viewer is shown */
    const hostView = !!(s && s.server && s.server.hostView);
    document.body.classList.toggle('cloud', cloud);
    document.body.classList.toggle('hostview', cloud && hostView);
    sayMode(cloud, hostView);
    try{
      sessionStorage.setItem('slh-mode', cloud ? 'cloud' : 'host');
      sessionStorage.setItem('slh-hostview', (cloud && hostView) ? '1' : '0');
    }catch(e){}
  }).catch(() => {});
  const b = document.getElementById('themeBtn');
  if(b) b.onclick = toggle;
  apply();
  window.SLHTheme = { apply, toggle };
  /* TVs: full screen, screen kept awake, header trimmed (web/kiosk.js) */
  const k = document.createElement('script'); k.src = '/web/kiosk.js'; document.head.appendChild(k);
})();
