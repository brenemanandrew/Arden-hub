'use strict';
/* The bar across the top, and the light/dark switch under it.

   Staging Lane Health has a dozen pages and a nav to match. This has
   two - the board and its settings - so the nav is two links, and the
   rest of the bar is a logo, a name, and whatever buttons the page asks
   for with data-tools. Nothing here fetches anything: a bar that cannot
   draw until a status call comes back is a bar that flickers.

     <div class="bar" data-page="pack" data-sub="Pack process"
          data-tools="reset"></div>
*/
(function(){
  const bar = document.querySelector('.bar');
  if(!bar) return;
  const d = bar.dataset;
  const tools = (d.tools || '').split(',').map(x => x.trim()).filter(Boolean);
  const PAGES = [{ id: 'pack', href: '/', name: 'Board' },
                 { id: 'admin', href: '/admin', name: 'Settings' }];

  /* keeps the bar class as well: the page looks for .bar to hang its own
     buttons on, and renaming it out from under it loses them */
  bar.className = 'top bar';
  bar.innerHTML =
    '<a href="/" class="logo-link" title="Home"><img class="logo" src="/web/logo.png" alt="Hubbell"></a>' +
    '<div class="title" id="title">ARDEN <b>PACK</b></div>' +
    (d.sub ? '<div class="sub">' + d.sub + '</div>' : '') +
    '<div class="spacer"></div>' +
    '<nav>' + PAGES.map(x =>
      '<a href="' + x.href + '"' + (x.id === d.page ? ' class="on"' : '') + '>' + x.name + '</a>').join('') +
    '</nav>' +
    '<div class="tools">' +
      '<button class="btn bartool" id="themeBtn" title="Light or dark">&#9681;</button>' +
      (tools.indexOf('reset') >= 0
        ? '<button class="btn bartool" id="resetLayout" title="Put every card back where it started">Reset layout</button>'
        : '') +
    '</div>';

  /* light or dark, remembered on this screen: a TV in the pack area and
     a laptop in an office want different ones */
  const KEY = 'ardenpack.theme';
  const apply = t => {
    document.documentElement.setAttribute('data-theme', t);
    try{ localStorage.setItem(KEY, t); }catch(e){}
  };
  let now = 'light';
  try{ now = localStorage.getItem(KEY) || 'light'; }catch(e){}
  apply(now);
  const tb = document.getElementById('themeBtn');
  if(tb) tb.onclick = () => { now = (now === 'dark' ? 'light' : 'dark'); apply(now); };

  /* Reset layout belongs to whatever page drew itself. The page wires it
     up if it wants to; this is the fallback for one that does not. */
  const rl = document.getElementById('resetLayout');
  if(rl) rl.onclick = rl.onclick || (() => {
    if(!confirm('Put every card back where it started?')) return;
    try{
      Object.keys(localStorage).filter(k => k.indexOf('slh.pack.layout') === 0)
        .forEach(k => localStorage.removeItem(k));
    }catch(e){}
    location.reload();
  });
})();
