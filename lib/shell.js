'use strict';
/* ============================================================
   The shell: one section bar on every page, hub pages and module pages
   alike, laid out in the order the work moves.

     Shift  Pick  Pack  Stage  Ship  |  People  Improve  System

   Module pages keep their own tool bar (theme, layout, feed pill, clock)
   but their own nav links and logo are hidden, so there is one way to
   move around. The theme key is the modules' own (slh-theme), so light
   or dark follows the viewer across every page.
   ============================================================ */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const NAV = [
  { key: 'shift', label: 'Shift', href: '/', hint: 'the floor right now, pick to ship' },
  { key: 'pick', label: 'Pick', href: '/stage/pickers', hint: 'pickers against standard' },
  { key: 'pack', label: 'Pack', href: '/pack/pack', hint: 'benches, packers, what is going out' },
  { key: 'stage', label: 'Stage', href: '/stage/tv', hint: 'the lanes, what to clear next' },
  { key: 'ship', label: 'Ship', href: '/ship', hint: 'orders out, value shipped' },
  { gap: true },
  { key: 'people', label: 'People', href: '/people', hint: 'overtime, roster, review' },
  { key: 'improve', label: 'Improve', href: '/improve', hint: 'ideas, standard work' },
  { key: 'system', label: 'System', href: '/system', hint: 'feeds, health, settings' }
];

/* which section a module page belongs to, for the highlight */
function sectionOf(id, p) {
  if (id === 'pack') return 'pack';
  if (id === 'stage') {
    if (/^\/(pickers|people|months|review)/.test(p)) return 'pick';
    if (/^\/(admin|data|help)/.test(p)) return 'system';
    return 'stage';
  }
  return id;
}

/* the sub-navigation under a section, for the pages a module has */
const SUB = {
  pick: [['/stage/pickers', 'Pickers'], ['/stage/people', 'People'], ['/stage/months', 'Months'], ['/stage/review', 'Review']],
  stage: [['/stage/tv', 'Floor TV'], ['/stage/ops', 'Ops view'], ['/stage/board', 'Classic'], ['/stage/phone', 'Phone']],
  pack: [['/pack/pack', 'Pack board'], ['/pack/admin', 'Pack settings']],
  system: [['/system', 'Health'], ['/stage/admin', 'Stage settings'], ['/stage/data', 'Get the data'], ['/stage/help', 'Help']]
};

const CSS = '.hubbar{position:sticky;top:0;z-index:50;background:#000;color:#fff;border-bottom:4px solid #FFC000;font-family:"Segoe UI",Calibri,Arial,sans-serif;display:flex;align-items:stretch;gap:0;height:46px;padding:0 10px 0 14px}' +
  '.hubbar .hlogo{display:flex;align-items:center;margin-right:14px}.hubbar .hlogo img{height:28px;width:auto;display:block}' +
  '.hubbar a.hs{display:flex;align-items:center;padding:0 13px;color:#ddd;text-decoration:none;font-size:15px;font-weight:600;letter-spacing:.2px;border-bottom:4px solid transparent;margin-bottom:-4px;white-space:nowrap}' +
  '.hubbar a.hs:hover{color:#fff;background:#161616}.hubbar a.hs.on{color:#fff;border-bottom-color:#FFC000}' +
  '.hubbar .hgap{flex:1}.hubbar .hsep{width:1px;background:#333;margin:10px 6px}' +
  '.hubbar .hsub{display:flex;align-items:center;gap:2px;margin-right:8px}.hubbar .hsub a{color:#aaa;text-decoration:none;font-size:13px;padding:5px 9px;border-radius:5px}.hubbar .hsub a:hover{color:#fff;background:#1c1c1c}.hubbar .hsub a.on{color:#FFC000}' +
  '.hubbar a.hout{display:flex;align-items:center;color:#888;text-decoration:none;font-size:13px;padding:0 8px}.hubbar a.hout:hover{color:#fff}' +
  '@media(max-width:900px){.hubbar{height:auto;flex-wrap:wrap;padding:4px 8px}.hubbar a.hs{padding:8px 9px;font-size:14px}.hubbar .hsub{display:none}}' +
  /* the module's own bar: keep its tools, lose its nav, logo and name */
  'body .bar .logo-link,body .bar .title,body .bar nav{display:none !important}body .bar{padding-left:14px}';

function bar(active, cur) {
  const sub = SUB[active] || [];
  return '<div class="hubbar" id="hubbar"><a class="hlogo" href="/" title="Shift"><img src="/logo.png" alt="Hubbell"></a>' +
    NAV.map(n => n.gap ? '<span class="hsep"></span>' : '<a class="hs' + (n.key === active ? ' on' : '') + '" href="' + n.href + '" title="' + esc(n.hint) + '">' + n.label + '</a>').join('') +
    '<span class="hgap"></span>' +
    (sub.length ? '<span class="hsub">' + sub.map(s => '<a href="' + s[0] + '"' + (cur && cur === s[0] ? ' class="on"' : '') + '>' + s[1] + '</a>').join('') + '</span>' : '') +
    '<a class="hout" href="/logout" title="Sign this device out">Sign out</a></div>';
}

/* put the bar into a module page (or one of ours) */
function inject(html, active, cur) {
  const style = '<style id="hubbar-css">' + CSS + '</style>';
  let out = html;
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, style + '</head>');
  else out = style + out;
  const b = bar(active, cur);
  if (/<body[^>]*>/i.test(out)) out = out.replace(/<body[^>]*>/i, m => m + b);
  else out = b + out;
  return out;
}

/* a hub page of our own, in the modules' visual language */
function page(o) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>' + esc(o.title) + '</title><meta name="theme-color" content="#000000"><link rel="icon" href="/icon.svg" type="image/svg+xml">' +
    '<style id="hubbar-css">' + CSS + '</style>' +
    '<style>:root{--amber:#FFC000;--amber-lo:#d9a300;--good:#0ca30c;--warn:#fab219;--serious:#ec835a;--bad:#d03b3b;--none:#8a8a86}' +
    '*{box-sizing:border-box;margin:0;padding:0}html,body{min-height:100%}' +
    'body{font-family:"Segoe UI",Calibri,Arial,sans-serif;line-height:1.35;background:var(--paper);color:var(--ink);' +
    '--paper:#fff;--ink:#111;--card:#fff;--muted:#5f6368;--line:#e1e0d9;--grid:#e1e0d9;--chip:#f1f1ee}' +
    'body.dark{--paper:#1a1a19;--ink:#f2f2ef;--card:#242423;--muted:#a8a8a2;--line:#2c2c2a;--grid:#383835;--chip:#2e2e2c}' +
    'a{color:inherit}button{font:inherit}:focus-visible{outline:3px solid var(--amber);outline-offset:2px}' +
    (o.css || '') + '</style></head><body>' + bar(o.active, o.cur) + (o.body || '') +
    '<script>(function(){try{var t=localStorage.getItem("slh-theme");if(t==="dark")document.body.classList.add("dark");}catch(e){}})();</script>' +
    (o.script ? '<script>' + o.script + '</script>' : '') + '</body></html>';
}

module.exports = { NAV, SUB, CSS, bar, inject, page, sectionOf, esc };
