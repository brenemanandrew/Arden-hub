'use strict';
/* The hub's own pages: Shift (home), Ship, People, Improve, and the page
   shown when a module is down. Each is a shell.page() with a small inline
   script that draws from /api/shift. Numbers are never typed into the page:
   they come from the modules, through lib/shift.js. */
const shell = require('./shell');
const esc = shell.esc;

const COMMON_CSS = 'main{max-width:1500px;margin:0 auto;padding:16px 18px 40px}' +
  '.top{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;margin-bottom:14px}.top h1{font-size:30px;font-weight:700;line-height:1.1}.top .sub{color:var(--muted);font-size:15px}.top .sp{flex:1}.top .when{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}' +
  '.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;box-shadow:0 2px 8px rgba(0,0,0,.05)}' +
  'h2{font-size:12px;letter-spacing:1.8px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline}h2 a{font-size:12px;letter-spacing:0;text-transform:none;color:var(--muted)}' +
  '.hero{font-size:44px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.5px}.hero small{font-size:18px;font-weight:600;color:var(--muted);margin-left:4px;letter-spacing:0}' +
  '.subs{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px}.subs div{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}.subs b{display:block;font-size:19px;color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:0;text-transform:none}' +
  '.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:700;background:var(--chip);color:var(--muted)}.pill i{width:9px;height:9px;border-radius:50%;background:var(--none);display:inline-block}' +
  '.pill.ok i{background:var(--good)}.pill.bad i{background:var(--bad)}.pill.warn i{background:var(--warn)}' +
  '.why{color:var(--muted);font-size:13px;margin-top:8px}.why.err{color:var(--bad);font-weight:600}' +
  '.att{list-style:none}.att li{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line);font-size:15px}.att li:first-child{border-top:0}.att li i{flex:0 0 10px;width:10px;height:10px;border-radius:50%;margin-top:6px;background:var(--none)}' +
  '.att li.bad i{background:var(--bad)}.att li.serious i{background:var(--serious)}.att li.warn i{background:var(--warn)}.att li.info i{background:var(--none)}.att li a{color:var(--muted);font-size:13px;white-space:nowrap;margin-left:auto}' +
  '.note{font-size:13px;color:var(--muted);margin-top:14px;line-height:1.45}.note b{color:var(--ink)}' +
  'table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);font-weight:600}td.n{text-align:right;font-variant-numeric:tabular-nums}' +
  '.tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:4px;background:var(--chip);color:var(--muted)}.tag.ready{background:#dff3df;color:#0a5a0a}body.dark .tag.ready{background:#143a14;color:#8be28b}' +
  '.feeds{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}';

function fmtScript() {
  return 'var esc=function(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c];});};' +
    'var n=function(v,d){return v==null||isNaN(v)?"\\u2014":Number(v).toLocaleString(undefined,{maximumFractionDigits:d==null?0:d});};' +
    'var pc=function(v){return v==null?"\\u2014":Math.round(v)+"%";};' +
    'var ago=function(m){return m==null?"never":m<1?"just now":m<60?m+" min ago":Math.floor(m/60)+" h "+(m%60)+" m ago";};' +
    'var money=function(v){return v==null?"\\u2014":"$"+Number(v).toLocaleString(undefined,{maximumFractionDigits:0});};' +
    'var clock=function(){var c=document.getElementById("clock");if(c)c.textContent=new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});};clock();setInterval(clock,15000);' +
    'function load(){return fetch("/api/shift",{credentials:"same-origin"}).then(function(r){if(r.status===401){location.href="/";throw new Error("out");}return r.json();}).then(render).catch(function(e){var w=document.getElementById("when");if(w)w.textContent="not updating: "+e.message;});}' +
    'load();setInterval(load,30000);';
}

/* ---------- Shift ---------- */
function shiftPage() {
  const css = COMMON_CSS +
    '.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:0;align-items:stretch;margin-bottom:16px}' +
    '.step{position:relative;background:var(--card);border:1px solid var(--line);border-top:5px solid var(--none);border-radius:10px;padding:12px 16px 14px;margin-right:22px;box-shadow:0 2px 8px rgba(0,0,0,.05)}' +
    '.step:last-child{margin-right:0}.step:not(:last-child):after{content:"";position:absolute;right:-18px;top:50%;width:0;height:0;border:9px solid transparent;border-left:12px solid var(--line);transform:translateY(-50%)}' +
    '.step.ok{border-top-color:var(--good)}.step.warn{border-top-color:var(--warn)}.step.serious{border-top-color:var(--serious)}.step.bad{border-top-color:var(--bad)}' +
    '.step h2{margin-bottom:6px}.step h2 a{text-decoration:none}' +
    '.cols{display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:14px}' +
    '.lanes .row{display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--line);font-size:15px}.lanes .row:first-child{border-top:0}.lanes .bin{font-weight:700;width:76px}.lanes .age{font-variant-numeric:tabular-nums;color:var(--muted);width:60px}.lanes .ord{color:var(--muted);font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    'svg.pace{width:100%;height:120px;display:block}' +
    '@media(max-width:1100px){.flow{grid-template-columns:1fr 1fr}.step{margin-right:0;margin-bottom:10px}.step:after{display:none}.cols{grid-template-columns:1fr}}' +
    '@media(max-width:600px){.flow{grid-template-columns:1fr}}';
  const body = '<main><div class="top"><h1 id="shiftName">Shift</h1><span class="sub" id="shiftSub">&nbsp;</span><span class="sp"></span><span class="when" id="when">loading</span><span class="when" id="clock"></span></div>' +
    '<div class="flow">' +
    '<div class="step" id="s-pick"><h2>Pick <a href="/stage/pickers">open &rarr;</a></h2><div class="hero" id="pickHero">&hellip;</div><div class="subs" id="pickSubs"></div><div class="why" id="pickWhy"></div></div>' +
    '<div class="step" id="s-pack"><h2>Pack <a href="/pack/pack">open &rarr;</a></h2><div class="hero" id="packHero">&hellip;</div><div class="subs" id="packSubs"></div><div class="why" id="packWhy"></div></div>' +
    '<div class="step" id="s-stage"><h2>Stage <a href="/stage/tv">open &rarr;</a></h2><div class="hero" id="stageHero">&hellip;</div><div class="subs" id="stageSubs"></div><div class="why" id="stageWhy"></div></div>' +
    '<div class="step" id="s-ship"><h2>Ship <a href="/ship">open &rarr;</a></h2><div class="hero" id="shipHero">&hellip;</div><div class="subs" id="shipSubs"></div><div class="why" id="shipWhy"></div></div>' +
    '</div>' +
    '<div class="cols">' +
    '<div class="card"><h2>Needs attention</h2><ul class="att" id="att"></ul></div>' +
    '<div class="card lanes"><h2>Clear next <a href="/stage/tv">all lanes &rarr;</a></h2><div id="clear"></div></div>' +
    '<div class="card"><h2>Pace by hour <a href="/stage/ops">ops view &rarr;</a></h2><svg class="pace" id="pace" viewBox="0 0 400 120" preserveAspectRatio="none"></svg><div class="why" id="paceNote"></div></div>' +
    '</div>' +
    '<div class="feeds" id="feeds"></div>' +
    '<p class="note" id="footnote">Every number here is the module\'s own: Pick from the picker report on the shift running now, Pack from the pack board for today, Stage and Ship from the lane board. A card says why when it has nothing to show.</p>' +
    '</main>';
  const script = fmtScript() +
    'function cls(id,c){var e=document.getElementById(id);e.className="step"+(c?" "+c:"");}' +
    'function subs(id,list){document.getElementById(id).innerHTML=list.map(function(x){return "<div>"+esc(x[0])+"<b>"+x[1]+"</b></div>";}).join("");}' +
    'function render(m){' +
    ' var sh=m.shift||{};document.getElementById("shiftName").textContent=sh.name?sh.name+" shift":"Shift";' +
    ' var sub=[];if(sh.from&&sh.to)sub.push(new Date(sh.from).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})+" to "+new Date(sh.to).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}));if(sh.hoursLeft!=null)sub.push(n(sh.hoursLeft,1)+" h left");document.getElementById("shiftSub").textContent=sub.join(" \\u00b7 ")||(sh.scheduleText||"");' +
    ' document.getElementById("when").textContent="updated "+ago(Math.round((Date.now()-m.now)/60000));' +
    /* pick */
    ' var p=m.pick;if(p.available){document.getElementById("pickHero").innerHTML=p.pct!=null?pc(p.pct)+"<small>of standard</small>":n(p.picks)+"<small>picks</small>";subs("pickSubs",[["Picks",n(p.picks)],["Pickers",n(p.pickers)],["Picks / h",n(p.rate,1)]]);document.getElementById("pickWhy").textContent=p.targetsAreDefault?"standards are placeholders":"";cls("s-pick",p.pct==null?"":p.bands&&p.pct>=p.bands.good?"ok":p.bands&&p.pct>=p.bands.warn?"warn":"serious");}' +
    ' else{document.getElementById("pickHero").innerHTML="\\u2014";subs("pickSubs",[]);document.getElementById("pickWhy").textContent=p.why||"";cls("s-pick",p.feedStatus&&p.feedStatus!=="ok"?"bad":"");}' +
    /* pack */
    ' var k=m.pack;if(k.available){document.getElementById("packHero").innerHTML=n(k.out)+"<small>units out</small>";var lp=k.lane||{};subs("packSubs",[["Packers",n(k.packers)],["Lines / h parcel",n(lp.parcel&&lp.parcel.linesPerHour&&lp.parcel.linesPerHour.value!=null?lp.parcel.linesPerHour.value:lp.parcel&&lp.parcel.linesPerHour,1)],["Lines / h truck",n(lp.truck&&lp.truck.linesPerHour&&lp.truck.linesPerHour.value!=null?lp.truck.linesPerHour.value:lp.truck&&lp.truck.linesPerHour,1)],["Filling",n(k.filling.length)]]);document.getElementById("packWhy").textContent=k.filling.length?"filling: "+k.filling.join(", "):"";cls("s-pack",k.filling.length?"warn":"ok");}' +
    ' else{document.getElementById("packHero").innerHTML="\\u2014";subs("packSubs",k.orders?[["Open deliveries",n(k.orders.deliveries)],["Open lines",n(k.orders.lines)],["Picked lines",n(k.orders.picked)]]:[]);document.getElementById("packWhy").textContent=k.why||"";cls("s-pack","");}' +
    /* stage */
    ' var s=m.stage;if(s.available){document.getElementById("stageHero").innerHTML=n(s.lanesUsed)+"<small>of "+n(s.lanesTotal)+" lanes</small>";subs("stageSubs",[["Ready to ship",n(s.ready)],["Waiting on picks",n(s.waiting)],["Late",n(s.late)],["Oldest",s.oldest?esc(s.oldest.lane+" "+s.oldest.age):"\\u2014"]]);document.getElementById("stageWhy").textContent=s.pushStale?"no push from the SAP PC for over 10 min":s.stale?"exports older than the stale limit":"";cls("s-stage",s.pushStale?"bad":s.late?"serious":s.exceptions&&s.exceptions.total?"warn":"ok");}' +
    ' else{document.getElementById("stageHero").innerHTML="\\u2014";subs("stageSubs",[]);document.getElementById("stageWhy").textContent=s.why||"";cls("s-stage","bad");}' +
    /* ship */
    ' var h=m.ship;if(h.available){document.getElementById("shipHero").innerHTML=n(h.ordersClearedToday)+"<small>orders out today"+(h.goal?" of "+n(h.goal):"")+"</small>";subs("shipSubs",[["Yesterday",n(h.ordersClearedYesterday)],["Totes out",n(h.totesClearedToday)],["$ shipped",h.shipped&&h.shipped.ok?money(h.shipped.total!=null?h.shipped.total:h.shipped.value):"no feed"],["Median dwell",h.medianDwellMin==null?"\\u2014":n(h.medianDwellMin)+" min"]]);document.getElementById("shipWhy").textContent=h.goal?(h.onPace===false?"behind pace, projecting "+n(h.projected):h.onPace?"on pace":""):"no daily goal set";cls("s-ship",h.goal?(h.onPace===false?"warn":"ok"):"");}' +
    ' else{document.getElementById("shipHero").innerHTML="\\u2014";subs("shipSubs",[]);document.getElementById("shipWhy").textContent="lane board not answering";cls("s-ship","bad");}' +
    /* attention */
    ' document.getElementById("att").innerHTML=(m.attention||[]).map(function(a){return "<li class=\\""+a.level+"\\"><i></i><span>"+esc(a.text)+"</span>"+(a.href?"<a href=\\""+esc(a.href)+"\\">open &rarr;</a>":"")+"</li>";}).join("")||"<li><i style=\\"background:var(--good)\\"></i><span>Nothing waiting. Every feed is fresh and no lane is late.</span></li>";' +
    /* clear next */
    ' document.getElementById("clear").innerHTML=s.available&&s.clearNext.length?s.clearNext.map(function(l){return "<div class=\\"row\\"><span class=\\"bin\\">"+esc(l.bin)+"</span><span class=\\"age\\">"+esc(l.age)+"</span><span class=\\"ord\\">"+esc((l.orders||[]).join(", "))+"</span>"+(l.ready?"<span class=\\"tag ready\\">READY</span>":"<span class=\\"tag\\">"+esc(l.note||"waiting")+"</span>")+"</div>";}).join(""):"<div class=\\"why\\">"+(s.available?"No lanes in use.":"Lane board not answering.")+"</div>";' +
    /* pace chart */
    ' var svg=document.getElementById("pace"),bh=h.byHour,hr=h.hourRange||[6,18];if(bh&&bh.today){var a=hr[0],b=hr[1],N=Math.max(1,b-a+1),mx=1,i;for(i=a;i<=b;i++){mx=Math.max(mx,bh.today[i]||0,bh.yesterday[i]||0);}var w=400/N,out="";for(i=a;i<=b;i++){var x=(i-a)*w,ty=(bh.today[i]||0)/mx*96,yy=(bh.yesterday[i]||0)/mx*96;out+="<rect x=\\""+(x+2)+"\\" y=\\""+(100-yy)+"\\" width=\\""+(w-4)+"\\" height=\\""+yy+"\\" fill=\\"var(--grid)\\"/><rect x=\\""+(x+w*0.25)+"\\" y=\\""+(100-ty)+"\\" width=\\""+(w*0.5)+"\\" height=\\""+ty+"\\" rx=\\"1\\" fill=\\"var(--amber-lo)\\"/>";if((i-a)%3===0)out+="<text x=\\""+(x+w/2)+"\\" y=\\"114\\" font-size=\\"10\\" text-anchor=\\"middle\\" fill=\\"var(--muted)\\">"+(i%12||12)+(i<12?"a":"p")+"</text>";}svg.innerHTML=out;document.getElementById("paceNote").textContent="orders cleared each hour today (amber) against yesterday (grey); "+n(h.ratePerHour,1)+" an hour so far";}else{svg.innerHTML="";document.getElementById("paceNote").textContent="no pace yet today";}' +
    /* feeds */
    ' document.getElementById("feeds").innerHTML=(m.feeds||[]).map(function(f){return "<a class=\\"pill "+(f.ok?"ok":"bad")+"\\" href=\\"/system\\" title=\\""+esc(f.detail)+"\\"><i></i>"+esc(f.label)+"</a>";}).join("");' +
    '}';
  return shell.page({ title: 'Shift', active: 'shift', css, body, script });
}

/* ---------- Ship ---------- */
function shipPage() {
  const css = COMMON_CSS + '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:14px}svg.pace{width:100%;height:200px;display:block}';
  const body = '<main><div class="top"><h1>Ship</h1><span class="sub">orders out of the door, by the hour, and what they were worth</span><span class="sp"></span><span class="when" id="when">loading</span></div>' +
    '<div class="grid">' +
    '<div class="card"><h2>Orders out today</h2><div class="hero" id="h1">&hellip;</div><div class="subs" id="s1"></div></div>' +
    '<div class="card"><h2>Value shipped today</h2><div class="hero" id="h2">&hellip;</div><div class="why" id="w2"></div></div>' +
    '<div class="card"><h2>Value pick complete</h2><div class="hero" id="h3">&hellip;</div><div class="why" id="w3"></div></div>' +
    '<div class="card"><h2>Open book</h2><div class="hero" id="h4">&hellip;</div><div class="subs" id="s4"></div></div>' +
    '</div>' +
    '<div class="card"><h2>Orders cleared by hour, today against yesterday</h2><svg class="pace" id="pace" viewBox="0 0 400 120" preserveAspectRatio="none"></svg><div class="why" id="paceNote"></div></div>' +
    '<p class="note"><b>Where the money comes from.</b> EWM carries no dollar value. Value comes from two ECC exports (VL06O) the SAP PC can pull every thirty minutes once <b>pull.deliveries.enabled</b> is switched on in Staging Lane Health\'s configuration, with an ECC session logged in beside the EWM one. Until then the two value cards say what they are waiting on. Orders cleared are counted from totes leaving the lanes, so the first shift after a restart reads low.</p>' +
    '</main>';
  const script = fmtScript() +
    'function subs(id,list){document.getElementById(id).innerHTML=list.map(function(x){return "<div>"+esc(x[0])+"<b>"+x[1]+"</b></div>";}).join("");}' +
    'function render(m){var h=m.ship;document.getElementById("when").textContent="updated "+ago(Math.round((Date.now()-m.now)/60000));' +
    ' document.getElementById("h1").innerHTML=n(h.ordersClearedToday)+(h.goal?"<small>of "+n(h.goal)+"</small>":"");subs("s1",[["Yesterday",n(h.ordersClearedYesterday)],["Totes out",n(h.totesClearedToday)],["Rate / h",n(h.ratePerHour,1)],["Projected",h.projected==null?"\\u2014":n(h.projected)],["Lines picked",n(h.linesPickedToday)]]);' +
    ' var sh=h.shipped||{};document.getElementById("h2").innerHTML=sh.ok?money(sh.total!=null?sh.total:sh.value):"\\u2014";document.getElementById("w2").textContent=sh.ok?(sh.count!=null?n(sh.count)+" deliveries":""):(sh.why||"no value feed");' +
    ' var pv=h.pickValue||{};document.getElementById("h3").innerHTML=pv.ok?money(pv.total!=null?pv.total:pv.value):"\\u2014";document.getElementById("w3").textContent=pv.ok?(pv.count!=null?n(pv.count)+" deliveries":""):(pv.why||"no value feed");' +
    ' document.getElementById("h4").innerHTML=h.openDeliveries==null?"\\u2014":n(h.openDeliveries)+"<small>open deliveries</small>";subs("s4",[["Open lines",n(h.openLines)],["Picked lines",n(h.pickedLines)]]);' +
    ' var svg=document.getElementById("pace"),bh=h.byHour,hr=h.hourRange||[6,18];if(bh&&bh.today){var a=hr[0],b=hr[1],N=Math.max(1,b-a+1),mx=1,i;for(i=a;i<=b;i++){mx=Math.max(mx,bh.today[i]||0,bh.yesterday[i]||0);}var w=400/N,out="";for(i=a;i<=b;i++){var x=(i-a)*w,ty=(bh.today[i]||0)/mx*96,yy=(bh.yesterday[i]||0)/mx*96;out+="<rect x=\\""+(x+2)+"\\" y=\\""+(100-yy)+"\\" width=\\""+(w-4)+"\\" height=\\""+yy+"\\" fill=\\"var(--grid)\\"/><rect x=\\""+(x+w*0.25)+"\\" y=\\""+(100-ty)+"\\" width=\\""+(w*0.5)+"\\" height=\\""+ty+"\\" rx=\\"1\\" fill=\\"var(--amber-lo)\\"/>";out+="<text x=\\""+(x+w/2)+"\\" y=\\"114\\" font-size=\\"9\\" text-anchor=\\"middle\\" fill=\\"var(--muted)\\">"+(i%12||12)+(i<12?"a":"p")+"</text>";}svg.innerHTML=out;document.getElementById("paceNote").textContent="amber is today, grey is yesterday, same hour";}else{document.getElementById("paceNote").textContent="no pace data yet";}' +
    '}';
  return shell.page({ title: 'Ship', active: 'ship', css, body, script });
}

/* ---------- People, Improve: the sections whose tools live elsewhere for now ---------- */
function tiles(o) {
  const css = COMMON_CSS + '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}' +
    'a.tile{display:flex;flex-direction:column;gap:8px;text-decoration:none;background:var(--card);border:1px solid var(--line);border-top:5px solid var(--amber);border-radius:10px;padding:16px 16px 14px;min-height:130px;box-shadow:0 2px 8px rgba(0,0,0,.05)}' +
    'a.tile:hover{border-color:#999}a.tile.ext{border-top-color:var(--none)}.tile .t{font-size:22px;font-weight:700}.tile .b{font-size:14px;color:var(--muted);flex:1}.tile .g{font-size:13px;font-weight:700;color:var(--amber-lo)}';
  const body = '<main><div class="top"><h1>' + esc(o.title) + '</h1><span class="sub">' + esc(o.sub) + '</span></div><div class="grid">' +
    o.items.map(t => '<a class="tile' + (t.ext ? ' ext' : '') + '" href="' + esc(t.href) + '"' + (t.ext ? ' target="_blank" rel="noopener"' : '') + '><div class="t">' + esc(t.name) + '</div><div class="b">' + esc(t.blurb) + '</div><div class="g">' + (t.ext ? 'Opens in its own app &rarr;' : 'Open &rarr;') + '</div></a>').join('') +
    '</div>' + (o.note ? '<p class="note">' + o.note + '</p>' : '') + '</main>';
  return shell.page({ title: o.title, active: o.active, css, body });
}
function peoplePage(links) {
  return tiles({ title: 'People', sub: 'who is here, who is on overtime, how each person is doing', active: 'people', items: [
    { name: 'Weekend Overtime', blurb: 'The sign-up kiosk, the weighted draw and the posting sheet. Same passphrase as the floor tablet.', href: links.overtime || 'https://ardenot.fly.dev/', ext: true },
    { name: 'Picker review', blurb: 'One person at a time: is this window typical of them, where the time went, what to say.', href: '/stage/review' },
    { name: 'People', blurb: 'Everyone who picked over a week, a month or a year, with productive time and trend.', href: '/stage/people' },
    { name: 'Months', blurb: 'The year a month at a time, every card on one scale.', href: '/stage/months' }
  ], note: 'The overtime kiosk still runs as its own app (ardenot.fly.dev) because the floor tablet and the dashboard PC kit are paired to it. Folding it in here is the next step once the kiosk\'s passphrase and encrypted data are moved onto this volume.' });
}
function improvePage(links) {
  const items = [
    { name: 'CI Idea Board', blurb: 'Idea cards from the floor, by QR code, into the CI planner.', href: links.ideas || 'https://hubbellideaboard.fly.dev/', ext: true },
    { name: 'Standards and recommendations', blurb: 'Pick standards in force, and what the floor has actually done, area by area.', href: '/stage/pickers' },
    { name: 'Definitions', blurb: 'What every number means, in plain English, so a decision made on it can be audited.', href: '/stage/help' }
  ];
  if (links.ops) items.unshift({ name: 'Operations site', blurb: 'Standard Work, 5S, news and the change notices on SharePoint.', href: links.ops, ext: true });
  return tiles({ title: 'Improve', sub: 'ideas, standards, and the definitions behind the numbers', active: 'improve', items, note: links.ops ? '' : 'The SharePoint Operations site will appear here once its address is added to <b>dashboards.json</b> under links.ops.' });
}

/* ---------- a module that is not answering ---------- */
function downPage(id, name, why, status) {
  const st = (status || {})[id] || {};
  const body = '<main><div class="top"><h1>' + esc(name) + ' is not answering</h1></div><div class="card"><p style="font-size:16px;margin-bottom:10px">' + esc(why) + '</p>' +
    '<p class="why">' + (st.pid ? 'The module is running (pid ' + st.pid + ', started ' + new Date(st.started).toLocaleTimeString() + ') but did not answer in time.' : 'The module process is down' + (st.lastExit ? ' since ' + new Date(st.lastExit.at).toLocaleTimeString() + ' (exit ' + (st.lastExit.sig || st.lastExit.code) + ')' : '') + '. The hub restarts it by itself; restarts so far: ' + (st.restarts || 0) + '.') + '</p>' +
    '<p class="why"><a href="/system">System page</a> shows every module and feed.</p></div></main>';
  return shell.page({ title: name + ' not answering', active: 'system', css: COMMON_CSS, body });
}

module.exports = { shiftPage, shipPage, peoplePage, improvePage, downPage, COMMON_CSS };
