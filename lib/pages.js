'use strict';
/* ============================================================
   The three pages, built as strings so the server has no templating
   dependency. House style from the Arden kiosk and Staging Lane Health:
   black header, amber rule (#FFC000), Segoe UI / Calibri, the Hubbell
   logo at the top left, and a light "paper" body on the health board
   with a dark setting for the floor TVs.
   ============================================================ */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const HEAD = (title) => '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<title>' + esc(title) + '</title><meta name="theme-color" content="#000000"><link rel="icon" href="/icon.svg" type="image/svg+xml">' +
  '<link rel="manifest" href="/app.webmanifest">';

const BASE_CSS = ':root{--amber:#FFC000;--amber-lo:#d9a300;--amber-edge:#b88a00;--ink:#111;--paper:#fff;--line:#d9dce1;--dim:#5f6368;' +
  '--good:#0ca30c;--warn:#fab219;--serious:#ec835a;--bad:#d03b3b;--none:#8a8a86}' +
  '*{box-sizing:border-box;margin:0;padding:0}html,body{min-height:100%}' +
  'body{font-family:"Segoe UI",Calibri,Arial,sans-serif;-webkit-tap-highlight-color:transparent;line-height:1.35}' +
  'a{color:inherit}button{font:inherit}:focus-visible{outline:3px solid var(--amber);outline-offset:2px}';

/* ---------- sign in: a black screen, the logo, the PIN ---------- */
function loginPage(o) {
  o = o || {};
  return HEAD(o.title || 'Arden Dashboards') + '<style>' + BASE_CSS +
    'body{background:#000;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px 16px}' +
    'main{width:min(92vw,380px);text-align:center}' +
    '.logo{width:min(70vw,260px);height:auto;display:block;margin:0 auto 34px}' +
    'label{display:block;font-size:15px;letter-spacing:2px;text-transform:uppercase;color:#9a9a9a;margin-bottom:12px}' +
    'input{width:100%;font-size:34px;letter-spacing:14px;text-align:center;padding:14px 10px 14px 24px;border:2px solid #444;border-radius:10px;background:#0b0b0b;color:#fff;font-variant-numeric:tabular-nums}' +
    'input:focus{outline:0;border-color:var(--amber)}' +
    'button{margin-top:16px;width:100%;font-size:21px;font-weight:700;padding:15px;background:var(--amber);color:#000;border:0;border-radius:10px;cursor:pointer;box-shadow:0 3px 0 var(--amber-edge)}' +
    'button:active{transform:translateY(2px);box-shadow:0 1px 0 var(--amber-edge);background:var(--amber-lo)}' +
    '.bad{background:#3a100c;color:#ffb4ad;padding:10px 12px;border-radius:8px;margin-bottom:16px;font-size:16px}' +
    '.foot{margin-top:40px;color:#666;font-size:13px}' +
    '</style></head><body><main>' +
    '<img class="logo" src="/logo.png" alt="Hubbell">' +
    (o.msg ? '<div class="bad" role="alert">' + esc(o.msg) + '</div>' : '') +
    '<form method="post" action="/login"><label for="pin">PIN</label>' +
    (o.next ? '<input type="hidden" name="next" value="' + esc(o.next) + '">' : '') +
    '<input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="go" autofocus required aria-label="PIN">' +
    '<button type="submit">Enter</button></form>' +
    '<p class="foot">' + esc(o.subtitle || 'Hubbell Arden') + '</p>' +
    '</main></body></html>';
}

/* ---------- home: every dashboard, one tile each ---------- */
function homePage(o) {
  const groups = [];
  (o.dashboards || []).forEach(d => {
    const g = d.group || 'Dashboards';
    let grp = groups.find(x => x.name === g); if (!grp) { grp = { name: g, items: [] }; groups.push(grp); }
    grp.items.push(d);
  });
  const tile = d => {
    const href = d.url ? esc(d.url) : '';
    const open = href ? '<a class="tile" href="' + href + '" data-id="' + esc(d.id) + '">' : '<div class="tile off" data-id="' + esc(d.id) + '">';
    const close = href ? '</a>' : '</div>';
    return open + '<div class="tt">' + esc(d.name) + '</div><div class="tb">' + esc(d.blurb || '') + '</div>' +
      '<div class="tf"><span class="pill" data-pill="' + esc(d.id) + '">' + (d.health && d.health.url ? '<i class="dot"></i>checking' : (href ? 'link' : 'no address yet')) + '</span>' +
      (href ? '<span class="go">Open &rarr;</span>' : '') + '</div>' + close;
  };
  return HEAD(o.title || 'Arden Dashboards') + '<style>' + BASE_CSS +
    'body{background:#000;color:#fff}' +
    'header{display:flex;align-items:center;gap:18px;padding:14px 22px;border-bottom:5px solid var(--amber);flex-wrap:wrap}' +
    'header img{height:44px;width:auto}header .t{font-size:22px;font-weight:700;line-height:1.1}header .t small{display:block;font-size:13px;font-weight:400;color:#b5b5b5;margin-top:3px}' +
    'header .sp{flex:1}header a.lnk{color:var(--amber);text-decoration:none;font-size:15px;padding:8px 2px}' +
    'main{max-width:1240px;margin:0 auto;padding:18px 18px 40px}' +
    'h2{font-size:14px;letter-spacing:2px;text-transform:uppercase;color:#9a9a9a;margin:22px 4px 10px}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px}' +
    '.tile{display:flex;flex-direction:column;gap:8px;background:#141414;border:1px solid #2a2a2a;border-top:5px solid var(--amber);border-radius:10px;padding:18px 18px 14px;min-height:150px;text-decoration:none;color:#fff;transition:transform .08s,border-color .12s}' +
    '.tile:active{transform:translateY(2px)}@media(hover:hover){.tile:hover{border-color:#555;background:#1a1a1a}}' +
    '.tile.off{border-top-color:#444;color:#888}' +
    '.tt{font-size:24px;font-weight:700;line-height:1.1}.tb{font-size:15px;color:#b5b5b5;flex:1}' +
    '.tf{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:14px}' +
    '.go{color:var(--amber);font-weight:700}' +
    '.pill{display:inline-flex;align-items:center;gap:7px;padding:4px 10px;border-radius:999px;background:#222;color:#ddd;font-size:13px;font-weight:600;white-space:nowrap}' +
    '.pill .dot{width:10px;height:10px;border-radius:50%;background:var(--none);display:inline-block}' +
    '.pill.up .dot{background:var(--good)}.pill.slow .dot{background:var(--warn)}.pill.stale .dot{background:var(--serious)}.pill.down .dot{background:var(--bad)}' +
    '.pill.down{background:#3a100c;color:#ffb4ad}.pill.stale{background:#3b2314;color:#ffc9b3}' +
    '.sys{border-top-color:#fff}.sys .tt{display:flex;align-items:center;gap:10px}' +
    '.hero{font-size:15px;color:#b5b5b5}.hero b{color:#fff}' +
    '</style></head><body>' +
    '<header><img src="/logo.png" alt="Hubbell"><div class="t">' + esc(o.title || 'Arden Dashboards') + '<small>' + esc(o.subtitle || '') + '</small></div><div class="sp"></div>' +
    '<a class="lnk" href="/status">Health board</a><a class="lnk" href="/logout">Sign out</a></header>' +
    '<main>' +
    groups.map(g => '<h2>' + esc(g.name) + '</h2><div class="grid">' + g.items.map(tile).join('') + '</div>').join('') +
    '<h2>Everything</h2><div class="grid"><a class="tile sys" href="/status" data-id="__sys"><div class="tt">Health board</div>' +
    '<div class="tb hero" id="sysline">Checks every dashboard once a minute and keeps a week of history.</div>' +
    '<div class="tf"><span class="pill" id="syspill"><i class="dot"></i>checking</span><span class="go">Open &rarr;</span></div></a></div>' +
    '</main>' +
    '<script>' +
    'var WORD={up:"up",slow:"slow",stale:"stale data",down:"down",unknown:"checking",unchecked:"link"};' +
    'function paint(){fetch("/api/status",{credentials:"same-origin"}).then(function(r){if(r.status===401){location.href="/";return null;}return r.json();}).then(function(s){if(!s)return;' +
    's.dashboards.forEach(function(d){var p=document.querySelector("[data-pill=\\""+d.id+"\\"]");if(!p||!d.checked)return;p.className="pill "+d.state;' +
    'var extra=d.state==="up"&&d.ms!=null?" "+d.ms+" ms":d.state==="down"&&d.err?" ("+d.err+")":"";p.innerHTML="<i class=\\"dot\\"></i>"+WORD[d.state]+extra;});' +
    'var sp=document.getElementById("syspill");sp.className="pill "+s.overall;var c=s.counts;' +
    'var words=[];["down","stale","slow","up"].forEach(function(k){if(c[k])words.push(c[k]+" "+WORD[k]);});' +
    'sp.innerHTML="<i class=\\"dot\\"></i>"+(s.overall==="up"?"all up":s.overall==="unknown"?"checking":words.join(", "));' +
    'document.getElementById("sysline").innerHTML="<b>"+words.join(", ")+"</b> &middot; checked "+Math.max(0,Math.round((Date.now()-s.now)/1000))+" s ago";' +
    '}).catch(function(){});}' +
    'paint();setInterval(paint,30000);' +
    '</script></body></html>';
}

/* ---------- the health board ---------- */
function boardPage(o) {
  o = o || {};
  const tv = !!o.tv;
  return HEAD((o.title || 'Arden Dashboards') + ' - health') + '<style>' + BASE_CSS +
    'body{background:var(--paper);color:var(--ink);--card:#fff;--muted:#5f6368;--line:#e1e0d9;--grid:#e1e0d9;--chip:#f1f1ee}' +
    'body.dark{--paper:#1a1a19;--ink:#f2f2ef;--card:#242423;--muted:#a8a8a2;--line:#2c2c2a;--grid:#383835;--chip:#2e2e2c;background:var(--paper);color:var(--ink)}' +
    'header{background:#000;color:#fff;display:flex;align-items:center;gap:16px;padding:10px 20px;border-bottom:5px solid var(--amber);flex-wrap:wrap}' +
    'header img{height:40px;width:auto}header h1{font-size:21px;font-weight:700;line-height:1.1}header h1 small{display:block;font-size:12px;font-weight:400;color:#b5b5b5;margin-top:2px}' +
    'header .sp{flex:1}header .clock{font-size:22px;font-weight:700;color:var(--amber);font-variant-numeric:tabular-nums}' +
    'header .ctl{display:flex;gap:8px;align-items:center}header button,header a.b{font-size:14px;padding:7px 12px;border:1px solid #5a5a5a;border-radius:6px;background:transparent;color:#ddd;cursor:pointer;text-decoration:none;min-height:36px}' +
    'header button:hover,header a.b:hover{border-color:#999;background:#1c1c1c}' +
    'body.tv header .ctl{display:none}' +
    'header.slim{background:var(--paper);color:var(--ink);border-bottom:0;max-width:1400px;margin:0 auto;padding:18px 18px 0}header.slim h1{font-size:30px}header.slim h1 small{color:var(--muted);font-size:14px}' +
    'header.slim button,header.slim a.b{border-color:var(--line);color:var(--ink)}header.slim button:hover,header.slim a.b:hover{background:var(--chip);border-color:var(--muted)}header.slim .clock{color:var(--ink)}body.tv header.slim{display:none}' +
    'main{max-width:1400px;margin:0 auto;padding:16px 18px 40px}' +
    '.top{display:flex;align-items:center;gap:22px;flex-wrap:wrap;margin-bottom:16px}' +
    '.hero{font-size:46px;font-weight:700;line-height:1;display:flex;align-items:center;gap:14px}.hero .ic{font-size:34px}' +
    '.kpis{display:flex;gap:10px;flex-wrap:wrap}.kpi{background:var(--chip);border-radius:8px;padding:8px 12px;font-size:14px;color:var(--muted)}.kpi b{display:block;font-size:20px;color:var(--ink);font-variant-numeric:tabular-nums}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}' +
    '.card{background:var(--card);border:1px solid var(--line);border-top:5px solid var(--none);border-radius:10px;padding:14px 16px 12px;display:flex;flex-direction:column;gap:9px;box-shadow:0 2px 8px rgba(0,0,0,.06)}' +
    '.card.up{border-top-color:var(--good)}.card.slow{border-top-color:var(--warn)}.card.stale{border-top-color:var(--serious)}.card.down{border-top-color:var(--bad)}' +
    '.ch{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.ch .n{font-size:20px;font-weight:700;line-height:1.1}.ch .n a{text-decoration:none}.ch .n small{display:block;font-size:12px;font-weight:400;color:var(--muted);margin-top:3px;word-break:break-all}' +
    '.st{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:13px;font-weight:700;white-space:nowrap;color:#fff;background:var(--none)}' +
    '.st.up{background:var(--good)}.st.slow{background:var(--warn);color:#0b0b0b}.st.stale{background:var(--serious);color:#0b0b0b}.st.down{background:var(--bad)}' +
    '.nums{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.num{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}.num b{display:block;font-size:19px;color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:0;text-transform:none}' +
    '.lab{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;display:flex;justify-content:space-between}' +
    'svg.tl{width:100%;height:22px;display:block}svg.sp{width:100%;height:44px;display:block}' +
    '.fields{font-size:13px;border-top:1px solid var(--line);padding-top:6px}.fields div{display:flex;justify-content:space-between;gap:10px;padding:2px 0}.fields span:last-child{font-variant-numeric:tabular-nums;font-weight:600;text-align:right}' +
    '.fields .stale span:last-child{color:var(--serious)}.fields .low span:last-child{color:var(--bad)}' +
    '.why{font-size:13px;color:var(--muted)}.why.err{color:var(--bad);font-weight:600}' +
    '.events{margin-top:22px}.events h2{font-size:14px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:8px}' +
    'table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}td.t{white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums}' +
    '.tip{position:fixed;pointer-events:none;background:#111;color:#fff;font-size:12px;padding:6px 8px;border-radius:6px;display:none;z-index:9;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3)}' +
    '.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin:6px 0 14px}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;margin-right:5px}' +
    'body.tv main{max-width:none;padding:14px 18px}body.tv .grid{grid-template-columns:repeat(auto-fill,minmax(400px,1fr))}body.tv .events{display:none}body.tv .hero{font-size:56px}' +
    '.banner{display:none;background:#5a1a14;color:#fff;padding:8px 20px;font-size:15px}.banner.on{display:block}' +
    '</style></head><body class="' + (tv ? 'tv' : '') + '">' +
    (o.embedded ?
      '<header class="slim"><h1>System<small>every module and dashboard, checked once a minute</small></h1><div class="sp"></div>' +
      '<div class="ctl"><button id="now" type="button">Check now</button><button id="bulb" type="button" title="Light or dark">&#9788;</button>' +
      '<a class="b" href="/system?tv=1" title="For a TV: no controls, stays awake">TV</a></div><div class="clock" id="clock"></div></header>' :
      '<header><img src="/logo.png" alt="Hubbell"><h1>' + esc(o.title || 'Arden Dashboards') + '<small>health board &middot; ' + esc(o.subtitle || '') + '</small></h1><div class="sp"></div>' +
      '<div class="ctl"><a class="b" href="/">Home</a><button id="now" type="button">Check now</button><button id="bulb" type="button" title="Light or dark">&#9788;</button>' +
      '<a class="b" href="/status?tv=1" title="For a TV: no controls, stays awake">TV</a></div><div class="clock" id="clock"></div></header>') +
    '<div class="banner" id="banner">The health board itself cannot be reached. Showing the last answer it gave.</div>' +
    '<main>' +
    '<div class="top"><div class="hero" id="hero"><span class="ic">&#8943;</span><span>Checking</span></div><div class="kpis" id="kpis"></div></div>' +
    '<div class="legend"><span><i style="background:var(--good)"></i>Up</span><span><i style="background:var(--warn)"></i>Slow</span><span><i style="background:var(--serious)"></i>Stale data</span><span><i style="background:var(--bad)"></i>Down</span><span><i style="background:var(--grid)"></i>No check yet</span><span>Strip = last 24 h, 10 min per cell, worst state in the cell. Line = median answer time per cell.</span></div>' +
    '<div class="grid" id="grid"></div>' +
    '<div class="events"><h2>What changed</h2><table id="events"></table></div>' +
    '</main><div class="tip" id="tip"></div>' +
    '<script>' + BOARD_JS + '</script></body></html>';
}

const BOARD_JS = `
var WORD={up:"Up",slow:"Slow",stale:"Stale data",down:"Down",unknown:"Checking",unchecked:"Link only"};
var ICON={up:"\\u2713",slow:"\\u25D4",stale:"\\u29D7",down:"\\u2715",unknown:"\\u2026",unchecked:"\\u2197"};
var COL={0:"var(--good)",1:"var(--warn)",2:"var(--serious)",3:"var(--bad)"};
var NAME={0:"up",1:"slow",2:"stale data",3:"down"};
var esc=function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});};
var last=null,fails=0;
function fmtAge(ms){if(ms==null)return "never";var m=Math.round(ms/60000);if(m<1)return "just now";if(m<60)return m+" min";var h=Math.floor(m/60);if(h<48)return h+" h "+(m%60)+" m";return Math.floor(h/24)+" d";}
function fmtTime(t){var d=new Date(t);return d.toLocaleDateString([],{month:"short",day:"numeric"})+" "+d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});}
function pct(v){return v==null?"\\u2014":(v>=99.95?"100":v.toFixed(1))+"%";}
function ms(v){return v==null?"\\u2014":v>=1000?(v/1000).toFixed(1)+" s":v+" ms";}
function timeline(d,now){var cells=d.cells||[],w=144,out="";var start=now-86400000;
 for(var i=0;i<w;i++){var s=cells[i];out+='<rect x="'+i+'" y="0" width="0.86" height="10" rx="0.2" fill="'+(s<0?"var(--grid)":COL[s])+'" data-i="'+i+'"/>';}
 return '<svg class="tl" viewBox="0 0 144 10" preserveAspectRatio="none" data-start="'+start+'" data-kind="tl" data-id="'+esc(d.id)+'">'+out+'</svg>';}
function spark(d,now){var a=d.spark||[],max=0,i;for(i=0;i<a.length;i++)if(a[i]!=null&&a[i]>max)max=a[i];if(!max)max=1;
 var pts=[],segs=[];for(i=0;i<a.length;i++){if(a[i]==null){if(pts.length){segs.push(pts);pts=[];}continue;}pts.push((i+0.5).toFixed(1)+","+(42-a[i]/max*38).toFixed(1));}
 if(pts.length)segs.push(pts);
 var path=segs.map(function(p){if(p.length===1){var xy=p[0].split(",");return '<circle cx="'+xy[0]+'" cy="'+xy[1]+'" r="1.4" fill="var(--amber-lo)"/>';}return '<polyline points="'+p.join(" ")+'" fill="none" stroke="var(--amber-lo)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';}).join("");
 return '<svg class="sp" viewBox="0 0 144 44" preserveAspectRatio="none" data-start="'+(now-86400000)+'" data-kind="sp" data-id="'+esc(d.id)+'" data-max="'+max+'"><line x1="0" y1="43" x2="144" y2="43" stroke="var(--grid)" stroke-width="0.5"/>'+path+'</svg>';}
function fieldRow(f){var v;
 if(f.kind==="time"){v=f.value==null?"never":fmtAge(Date.now()-f.value)+" ago";if(f.staleMin&&f.stale)v+=" (limit "+f.staleMin+" min)";}
 else if(f.kind==="count")v=f.value==null?"\\u2014":Number(f.value).toLocaleString();
 else if(f.kind==="bool")v=f.value?"yes":"no";else v=f.value==null?"\\u2014":f.value;
 return '<div class="'+(f.stale?"stale":"")+(f.low||f.bad?" low":"")+'"><span>'+esc(f.label)+'</span><span>'+esc(v)+'</span></div>';}
function card(d,now){
 var st=d.state,chk=d.checked;
 var head='<div class="ch"><div class="n">'+(d.url?'<a href="'+esc(d.url)+'">'+esc(d.name)+'</a>':esc(d.name))+(d.healthUrl?'<small>'+esc(d.healthUrl)+'</small>':'')+'</div><span class="st '+st+'">'+ICON[st]+' '+WORD[st]+'</span></div>';
 if(!chk)return '<div class="card unchecked">'+head+'<div class="why">'+esc(d.blurb||"No health check for this one, only a link.")+'</div></div>';
 if(st==="unknown")return '<div class="card unknown">'+head+'<div class="why">First check is running.</div></div>';
 var why=d.err?'<div class="why err">'+esc(d.err)+'</div>':(d.note?'<div class="why">'+esc(d.note)+'</div>':'');
 var hasData=d.fields&&d.fields.some(function(f){return f.staleMin||f.min!=null||f.want!=null;});
 var nums='<div class="nums"><div class="num">Now<b>'+ms(d.ms)+'</b></div><div class="num">24 h up<b>'+pct(d.uptime24)+'</b></div><div class="num">'+(hasData?'7 d fresh<b>'+pct(d.fresh7):'7 d up<b>'+pct(d.uptime7))+'</b></div><div class="num">p95<b>'+ms(d.p95)+'</b></div></div>';
 var since='<div class="lab"><span>'+WORD[st].toLowerCase()+' for '+fmtAge(now-d.since)+'</span><span>'+(d.outages7?d.outages7+" outage"+(d.outages7>1?"s":"")+" in 7 d":"no outages in 7 d")+(d.cert&&d.cert.daysLeft!=null?" \\u00b7 cert "+d.cert.daysLeft+" d":"")+'</span></div>';
 var fields=d.fields&&d.fields.length?'<div class="fields">'+d.fields.map(fieldRow).join("")+'</div>':'';
 return '<div class="card '+st+'">'+head+why+nums+since+timeline(d,now)+'<div class="lab"><span>answer time, 24 h</span><span>p50 '+ms(d.p50)+'</span></div>'+spark(d,now)+fields+'</div>';}
function render(s){last=s;var now=s.now;
 var hero=document.getElementById("hero"),c=s.counts||{};
 var words=[];["down","stale","slow","up"].forEach(function(k){if(c[k])words.push(c[k]+" "+WORD[k].toLowerCase());});
 hero.innerHTML='<span class="ic" style="color:'+(s.overall==="up"?"var(--good)":s.overall==="down"?"var(--bad)":s.overall==="stale"?"var(--serious)":s.overall==="slow"?"var(--warn)":"var(--none)")+'">'+ICON[s.overall]+'</span><span>'+(s.overall==="up"?"All up":s.overall==="unknown"?"Checking":esc(words.join(", ")))+'</span>';
 var checked=s.dashboards.filter(function(d){return d.checked;});
 var ups=checked.map(function(d){return d.uptime7;}).filter(function(v){return v!=null;});
 var avg=ups.length?ups.reduce(function(a,b){return a+b;},0)/ups.length:null;
 document.getElementById("kpis").innerHTML='<div class="kpi">Dashboards<b>'+checked.length+'</b></div><div class="kpi">Checks run<b>'+s.runs.toLocaleString()+'</b></div><div class="kpi">7 d reachable, average<b>'+pct(avg)+'</b></div><div class="kpi">Checked<b>'+(function(a){return a==="just now"?a:a+" ago";})(fmtAge(Date.now()-now))+'</b></div>';
 document.getElementById("grid").innerHTML=s.dashboards.map(function(d){return card(d,now);}).join("");
 var names={};s.dashboards.forEach(function(d){names[d.id]=d.name;});
 document.getElementById("events").innerHTML=(s.events||[]).map(function(e){return '<tr><td class="t">'+fmtTime(e.t)+'</td><td><b>'+esc(names[e.id]||e.id)+'</b> '+(e.from?esc(WORD[e.from].toLowerCase())+' \\u2192 ':'')+'<b>'+esc(WORD[e.to].toLowerCase())+'</b>'+(e.why?' <span style="color:var(--muted)">'+esc(e.why)+'</span>':'')+'</td></tr>';}).join("")||'<tr><td class="t">nothing yet</td></tr>';
}
function load(){return fetch("/api/status",{credentials:"same-origin"}).then(function(r){if(r.status===401){location.href="/?next=/status";throw new Error("signed out");}return r.json();}).then(function(s){fails=0;document.getElementById("banner").className="banner";render(s);}).catch(function(){fails++;if(fails>=3)document.getElementById("banner").className="banner on";});}
document.getElementById("now").onclick=function(){var b=this;b.disabled=true;b.textContent="Checking\\u2026";fetch("/api/check-now",{method:"POST",credentials:"same-origin"}).then(function(){return load();}).then(function(){b.disabled=false;b.textContent="Check now";},function(){b.disabled=false;b.textContent="Check now";});};
document.getElementById("bulb").onclick=function(){document.body.classList.toggle("dark");try{localStorage.setItem("hub_dark",document.body.classList.contains("dark")?"1":"0");}catch(e){}};
try{if(localStorage.getItem("hub_dark")==="1"||(location.search.indexOf("tv=1")>=0&&localStorage.getItem("hub_dark")!=="0"))document.body.classList.add("dark");}catch(e){}
var tip=document.getElementById("tip");
document.addEventListener("mousemove",function(ev){var svg=ev.target.closest&&ev.target.closest("svg[data-kind]");if(!svg||!last){tip.style.display="none";return;}
 var r=svg.getBoundingClientRect(),i=Math.max(0,Math.min(143,Math.floor((ev.clientX-r.left)/r.width*144)));var start=+svg.dataset.start;var d=last.dashboards.filter(function(x){return x.id===svg.dataset.id;})[0];if(!d)return;
 var t0=start+i*600000,txt=fmtTime(t0)+" \\u2013 "+new Date(t0+600000).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})+": ";
 if(svg.dataset.kind==="tl"){var s=(d.cells||[])[i];txt+=s==null||s<0?"no check":NAME[s];}else{var v=(d.spark||[])[i];txt+=v==null?"no answer":"median "+ms(v);}
 tip.textContent=txt;tip.style.display="block";tip.style.left=Math.min(window.innerWidth-240,ev.clientX+12)+"px";tip.style.top=(ev.clientY+14)+"px";});
function clock(){document.getElementById("clock").textContent=new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});}
clock();setInterval(clock,15000);load();setInterval(load,30000);
if(document.body.classList.contains("tv")){var lock=function(){if(navigator.wakeLock)navigator.wakeLock.request("screen").catch(function(){});};lock();document.addEventListener("visibilitychange",function(){if(!document.hidden)lock();});
 setTimeout(function(){location.reload();},6*3600000);}
`;

module.exports = { loginPage, homePage, boardPage, esc };
