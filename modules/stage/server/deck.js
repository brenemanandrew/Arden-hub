'use strict';
/* The end of shift deck, built here on the host so it exists whether or not
   anyone was at the board. One 16:9 slide: the numbers a peer supervisor and
   the DC manager read out from, with the crew's best and worst named. A
   second slide carries the floor's answers when a supervisor gave any.
   16:9 prints on letter or A3 landscape and fills a 1080p screen as it is.

   The zip writer and the slide primitives are the board's own (board.html),
   ported so the two never drift apart in how a deck is put together. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for(let n = 0; n < 256; n++){ let c = n; for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes){
  let c = 0xFFFFFFFF;
  for(let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/* stored (uncompressed) zip: PowerPoint is happy with it and nothing is needed to make it */
function zipBuild(files){
  const parts = [], central = [];
  let offset = 0;
  const u16 = v => Buffer.from([v & 0xFF, (v >>> 8) & 0xFF]);
  const u32 = v => Buffer.from([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
  files.forEach(f => {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)]);
    parts.push(local, name, data);
    central.push({ name, crc, size: data.length, offset });
    offset += local.length + name.length + data.length;
  });
  const dir = [];
  central.forEach(c => {
    dir.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(c.crc), u32(c.size), u32(c.size),
                            u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset)]), c.name);
  });
  const dirBytes = dir.reduce((t, a) => t + a.length, 0);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(dirBytes), u32(offset), u16(0)]);
  return Buffer.concat(parts.concat(dir, [end]));
}

/* ---- slide primitives: 16:9 at 12192000 x 6858000 EMU, positioned in percent ---- */
const SW = 12192000, SH = 6858000;
const pctX = p => Math.round(SW * p / 100);
const pctY = p => Math.round(SH * p / 100);
function xesc(s){
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
let _sid = 1;
function shpRect(x, y, w, h, fill, opts){
  const o = opts || {};
  _sid++;
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + _sid + '" name="r' + _sid + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="' + pctX(x) + '" y="' + pctY(y) + '"/>' +
    '<a:ext cx="' + pctX(w) + '" cy="' + pctY(h) + '"/></a:xfrm><a:prstGeom prst="' + (o.round ? 'roundRect' : 'rect') + '"><a:avLst/></a:prstGeom>' +
    (fill ? '<a:solidFill><a:srgbClr val="' + fill + '"/></a:solidFill>' : '<a:noFill/>') +
    '<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>';
}
function shpText(x, y, w, h, runs, opts){
  const o = opts || {};
  _sid++;
  const body = (Array.isArray(runs) ? runs : [runs]).map(r =>
    '<a:r><a:rPr lang="en-US" sz="' + (r.sz || 1400) + '"' + (r.b ? ' b="1"' : '') + ' dirty="0"><a:solidFill><a:srgbClr val="' + (r.col || '101417') + '"/></a:solidFill>' +
    '<a:latin typeface="Calibri"/></a:rPr><a:t>' + xesc(r.t) + '</a:t></a:r>').join('');
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + _sid + '" name="t' + _sid + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm>' +
    '<a:off x="' + pctX(x) + '" y="' + pctY(y) + '"/><a:ext cx="' + pctX(w) + '" cy="' + pctY(h) + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" anchor="' + (o.anchor || 'ctr') + '" lIns="36000" rIns="36000" tIns="0" bIns="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
    '<a:p><a:pPr algn="' + (o.align || 'l') + '"/>' + body + '</a:p></p:txBody></p:sp>';
}
/* A picture. rId is the relationship this slide declares for the image;
   pack() hands those out in the order a slide lists its images. The slide
   root already declares xmlns:r, so r:embed resolves. */
function shpPic(rId, x, y, w, h){
  _sid++;
  return '<p:pic><p:nvPicPr><p:cNvPr id="' + _sid + '" name="pic' + _sid + '"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="' + rId + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="' + pctX(x) + '" y="' + pctY(y) + '"/><a:ext cx="' + pctX(w) + '" cy="' + pctY(h) + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}
function slideXml(shapes){
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}
/* one layout, one master, one theme: the least PowerPoint opens without complaint */
function pptxSkeleton(slideCount, hasMedia){
  const ids = []; for(let i = 1; i <= slideCount; i++) ids.push(i);
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  const contentTypes = X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    (hasMedia ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    ids.map(i => '<Override PartName="/ppt/slides/slide' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>').join('') + '</Types>';
  const rootRels = X + rels + '<Relationship Id="rId1" Type="' + R + '/officeDocument" Target="ppt/presentation.xml"/></Relationships>';
  const presentation = X + '<p:presentation xmlns:a="' + A + '" xmlns:r="' + R + '" xmlns:p="' + P + '"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst>' + ids.map(i => '<p:sldId id="' + (255 + i) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</p:sldIdLst>' +
    '<p:sldSz cx="' + SW + '" cy="' + SH + '"/><p:notesSz cx="' + SH + '" cy="' + SW + '"/></p:presentation>';
  const presRels = X + rels + '<Relationship Id="rId1" Type="' + R + '/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    ids.map(i => '<Relationship Id="rId' + (i + 1) + '" Type="' + R + '/slide" Target="slides/slide' + i + '.xml"/>').join('') +
    '<Relationship Id="rId' + (slideCount + 2) + '" Type="' + R + '/theme" Target="theme/theme1.xml"/></Relationships>';
  const emptyTree = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>';
  const clrMap = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  const master = X + '<p:sldMaster xmlns:a="' + A + '" xmlns:r="' + R + '" xmlns:p="' + P + '">' + emptyTree + clrMap + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
  const masterRels = X + rels + '<Relationship Id="rId1" Type="' + R + '/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="' + R + '/theme" Target="../theme/theme1.xml"/></Relationships>';
  const layout = X + '<p:sldLayout xmlns:a="' + A + '" xmlns:r="' + R + '" xmlns:p="' + P + '" type="blank" preserve="1">' + emptyTree + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
  const layoutRels = X + rels + '<Relationship Id="rId1" Type="' + R + '/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>';
  const dk = c => '<a:srgbClr val="' + c + '"/>';
  const fill3 = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3);
  const theme = X + '<a:theme xmlns:a="' + A + '" name="Hubbell"><a:themeElements><a:clrScheme name="Hubbell"><a:dk1>' + dk('101417') + '</a:dk1><a:lt1>' + dk('FFFFFF') + '</a:lt1><a:dk2>' + dk('1D2630') + '</a:dk2><a:lt2>' + dk('EDEFF1') + '</a:lt2>' +
    '<a:accent1>' + dk('FFC000') + '</a:accent1><a:accent2>' + dk('E8871A') + '</a:accent2><a:accent3>' + dk('43A047') + '</a:accent3><a:accent4>' + dk('E5484D') + '</a:accent4><a:accent5>' + dk('5C6B7A') + '</a:accent5><a:accent6>' + dk('00838F') + '</a:accent6>' +
    '<a:hlink>' + dk('0563C1') + '</a:hlink><a:folHlink>' + dk('954F72') + '</a:folHlink></a:clrScheme>' +
    '<a:fontScheme name="Hubbell"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    '<a:fmtScheme name="Hubbell"><a:fillStyleLst>' + fill3 + '</a:fillStyleLst><a:lnStyleLst>' + '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3) + '</a:lnStyleLst>' +
    '<a:effectStyleLst>' + '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3) + '</a:effectStyleLst><a:bgFillStyleLst>' + fill3 + '</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>';
  return { contentTypes, rootRels, presentation, presRels, master, masterRels, layout, layoutRels, theme };
}
/* Slides are XML strings, as the shift report builds them, or
   { xml, images: ['image1.png', ...] } when a slide carries pictures - the
   images are numbered from rId2, rId1 being the layout every slide needs.
   media is [{ name, data }] and goes in once however many slides use it. */
function pack(slides, media){
  media = media || [];
  const sk = pptxSkeleton(slides.length, media.length > 0);
  const files = [
    { name: '[Content_Types].xml', data: sk.contentTypes }, { name: '_rels/.rels', data: sk.rootRels },
    { name: 'ppt/presentation.xml', data: sk.presentation }, { name: 'ppt/_rels/presentation.xml.rels', data: sk.presRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: sk.master }, { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: sk.masterRels },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: sk.layout }, { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: sk.layoutRels },
    { name: 'ppt/theme/theme1.xml', data: sk.theme }
  ];
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  slides.forEach((s, i) => {
    const xml = typeof s === 'string' ? s : s.xml;
    const imgs = (typeof s === 'string' ? [] : (s.images || []));
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + REL + '/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      imgs.map((n, k) => '<Relationship Id="rId' + (k + 2) + '" Type="' + REL + '/image" Target="../media/' + n + '"/>').join('') +
      '</Relationships>';
    files.push({ name: 'ppt/slides/slide' + (i + 1) + '.xml', data: xml });
    files.push({ name: 'ppt/slides/_rels/slide' + (i + 1) + '.xml.rels', data: rels });
  });
  media.forEach(m => files.push({ name: 'ppt/media/' + m.name, data: m.data }));
  return zipBuild(files);
}

/* ---- the report ---- */
const GREEN = '43A047', AMBER = 'FFC000', RED = 'E5484D', GREY = '5C6B7A', INK = '101417', MUTE = '6B747C', LINE = 'EDEFF1';
const pctCol = p => p == null ? GREY : p >= 100 ? GREEN : p >= 85 ? AMBER : RED;
const fmt = n => (n == null ? '--' : Number(n).toLocaleString('en-US'));
const fmt1 = n => (n == null ? '--' : Number(n).toFixed(1));
const DOT = ' · ';

function heading(x, y, w, text, right){
  return shpText(x, y, w, 4, [{ t: text, sz: 1050, b: true, col: GREY }]) +
    (right ? shpText(x, y, w, 4, [{ t: right, sz: 900, col: MUTE }], { align: 'r' }) : '') +
    shpRect(x, y + 3.6, w, 0.35, AMBER);
}
/* a table row: cells are { t, w (share), b, col, align } */
function row(x, y, w, h, cells, sz, band){
  let out = band ? shpRect(x, y, w, h, band) : '';
  const tot = cells.reduce((s, c) => s + c.w, 0);
  let cx = x;
  cells.forEach(c => {
    const cw = w * c.w / tot;
    out += shpText(cx, y, cw, h, [{ t: c.t, sz: sz || 1000, b: !!c.b, col: c.col || INK }], { align: c.align || 'l' });
    cx += cw;
  });
  return out;
}
function crewTable(x, y, w, title, sub, people, emptyText, last){
  /* the last column is the area someone mostly worked, or, for a week,
     how productive their time was */
  last = last || { lab: 'Mostly', v: p => p.mainArea || '', col: MUTE };
  let out = heading(x, y, w, title, sub);
  y += 5;
  const W = [3.1, 1.1, 1.3, 1.2, 2.3];
  out += row(x, y, w, 3.2, [
    { t: 'Picker', w: W[0], col: MUTE }, { t: 'Picks', w: W[1], col: MUTE, align: 'r' }, { t: 'Lines/h', w: W[2], col: MUTE, align: 'r' },
    { t: '% std', w: W[3], col: MUTE, align: 'r' }, { t: last.lab, w: W[4], col: MUTE, align: 'r' }], 850);
  y += 3.2;
  if(!people.length){ out += shpText(x, y, w, 3.6, [{ t: emptyText, sz: 950, col: MUTE }]); return { out, y: y + 4 }; }
  people.forEach((p, i) => {
    out += row(x, y, w, 3.6, [
      { t: p.who, w: W[0], b: true }, { t: fmt(p.total), w: W[1], align: 'r' }, { t: fmt1(p.lineRate), w: W[2], align: 'r' },
      { t: p.pct == null ? '--' : p.pct + '%', w: W[3], b: true, col: pctCol(p.pct), align: 'r' }, { t: last.v(p), w: W[4], col: last.colOf ? last.colOf(p) : last.col, b: !!last.colOf, align: 'r' }],
      1000, i % 2 ? null : 'F5F6F7');
    y += 3.6;
  });
  return { out, y };
}

/* d: see eos.js gather() for the shape */
function buildEosDeck(d){
  _sid = 1;
  const tm = t => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const dateStr = new Date(d.shift.from).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  let sh = '';
  // header
  sh += shpRect(0, 0, 100, 12, '000000') +
    shpText(3, 0, 55, 12, [{ t: d.title || 'Staging Lane Health', sz: 2400, b: true, col: 'FFFFFF' }]) +
    shpText(55, 1, 42, 5, [{ t: 'END OF SHIFT REPORT', sz: 1000, b: true, col: AMBER }], { align: 'r' }) +
    shpText(55, 5.5, 42, 6, [{ t: d.shift.name + ' shift' + DOT + dateStr + DOT + tm(d.shift.from) + ' to ' + tm(d.shift.to), sz: 1200, col: 'FFFFFF' }], { align: 'r', anchor: 't' }) +
    shpRect(0, 12, 100, 0.8, AMBER);

  // headline tiles
  const L = d.lines, S = d.staging, P = d.picks;
  const tiles = [
    [fmt(L.picked), 'Lines picked', L.goal ? (L.pct + '% of ' + fmt(L.goal) + ' goal') : 'delivery lines', L.goal ? pctCol(L.pct) : 'FFFFFF'],
    [fmt(P.confirmed), 'Picks confirmed', d.crew.count ? (d.crew.count + ' pickers') : 'this shift', 'FFFFFF'],
    [fmt(S.cleared), 'Orders shipped', S.medianDwellMin != null ? ('median ' + S.medianDwellMin + ' min in staging') : 'left staging', GREEN],
    [fmt(S.waiting), 'Staged, owed a pick', 'at shift end', AMBER],
    [fmt(S.late), 'Past 3 hours', S.carried ? (S.carried + ' from a prior day') : 'in staging now', S.late ? RED : GREEN],
    [fmt(P.open), 'Tasks left open', 'carried to next shift', GREY]
  ];
  tiles.forEach((t, i) => {
    const x = 3 + i * 15.9, w = 14.7;
    sh += shpRect(x, 15.5, w, 17, INK, { round: true }) +
      shpText(x, 16.5, w, 8, [{ t: t[0], sz: 2600, b: true, col: t[3] }], { align: 'ctr' }) +
      shpText(x, 24.2, w, 4, [{ t: t[1], sz: 1000, b: true, col: 'FFFFFF' }], { align: 'ctr' }) +
      shpText(x, 27.7, w, 4, [{ t: t[2], sz: 850, col: '9AA4AD' }], { align: 'ctr' });
  });

  // left column: rate against standard, work left, watch items
  const LX = 3, LW = 45;
  let y = 36;
  sh += heading(LX, y, LW, 'RATE AGAINST STANDARD', 'picks per active hour, this shift');
  y += 5;
  const areas = (d.areas || []).slice(0, 8);
  if(!areas.length) sh += shpText(LX, y, LW, 3.6, [{ t: d.picks.note || 'no task export for this shift', sz: 950, col: MUTE }]);
  areas.forEach(a => {
    const has = a.target && a.rate != null;
    const frac = has ? Math.min(1, a.rate / a.target) : 0;
    const col = !has ? GREY : a.rate >= a.target ? GREEN : a.rate >= a.target * 0.85 ? AMBER : RED;
    sh += shpText(LX, y, 12, 3.4, [{ t: a.area, sz: 1000, b: true }]) +
      shpRect(LX + 12, y + 0.9, 20, 1.7, LINE, { round: true }) +
      (frac > 0 ? shpRect(LX + 12, y + 0.9, Math.max(0.5, 20 * frac), 1.7, col, { round: true }) : '') +
      shpText(LX + 33, y, 12, 3.4, [{ t: has ? (fmt1(a.rate) + ' / ' + a.target) : (a.rate != null ? fmt1(a.rate) + ' / --' : '--'), sz: 1000, b: true, col: col }], { align: 'r' });
    y += 3.5;
  });
  y += 1.5;
  const left = (d.areas || []).filter(a => a.open > 0).sort((a, b) => b.open - a.open).slice(0, 6);
  sh += heading(LX, y, LW, 'WORK LEFT BY AREA', fmt(P.open) + ' open tasks');
  y += 5;
  if(!left.length) sh += shpText(LX, y, LW, 3.4, [{ t: 'nothing left open', sz: 950, col: MUTE }]);
  const mx = Math.max(1, ...left.map(a => a.open));
  left.forEach(a => {
    sh += shpText(LX, y, 12, 3.2, [{ t: a.area, sz: 1000, b: true }]) +
      shpRect(LX + 12, y + 0.8, 20, 1.6, LINE, { round: true }) + shpRect(LX + 12, y + 0.8, Math.max(0.5, 20 * a.open / mx), 1.6, GREY, { round: true }) +
      shpText(LX + 33, y, 12, 3.2, [{ t: fmt(a.open), sz: 1000, b: true }], { align: 'r' });
    y += 3.3;
  });
  y += 1.5;
  sh += heading(LX, y, LW, 'WATCH ITEMS', '');
  y += 5;
  const watch = (d.watch || []).slice(0, 5);
  if(!watch.length) sh += shpText(LX, y, LW, 3.4, [{ t: 'nothing outstanding', sz: 950, col: MUTE }]);
  watch.forEach(w => { sh += shpText(LX, y, LW, 3.2, [{ t: '•  ' + w, sz: 950, col: '2A3138' }]); y += 3.2; });

  // right column: the crew
  const RX = 52, RW = 45;
  let ry = 36;
  const c = d.crew;
  sh += heading(RX, ry, RW, 'CREW', c.count ? (c.count + ' pickers' + DOT + fmt(c.picks) + ' picks in ' + fmt1(c.hours) + ' active hours' + (c.pct != null ? DOT + c.pct + '% of standard' : '') + (c.util != null ? DOT + c.util + '% productive' : '')) : '');
  ry += 6;
  let r = crewTable(RX, ry, RW, 'MOST PRODUCTIVE', 'top 3 by percent of standard', d.top, c.count ? 'nobody over the picks floor with a standard' : 'no picks recorded for this shift');
  sh += r.out; ry = r.y + 2;
  r = crewTable(RX, ry, RW, 'NEEDS ATTENTION', 'lowest 5 by percent of standard', d.bottom, d.top.length ? 'everybody else is in the top group' : '');
  sh += r.out; ry = r.y + 1.5;
  if(d.minorCount) sh += shpText(RX, ry, RW, 3, [{ t: d.minorCount + ' more touched a few picks and are not ranked', sz: 850, col: MUTE }]);

  // footer
  sh += shpRect(0, 97.6, 100, 0.7, AMBER) +
    shpText(3, 93.6, 55, 3.6, [{ t: 'Generated ' + new Date(d.generatedAt).toLocaleString('en-US') + (d.why === 'automatic' ? ' automatically at shift end' : ' from the board'), sz: 850, col: '9AA4AD' }]) +
    shpText(45, 93.6, 52, 3.6, [{ t: d.footnote || '', sz: 800, col: '9AA4AD' }], { align: 'r' });

  const slides = [slideXml(sh)];
  if(d.notes && d.notes.length){
    let n = shpRect(0, 0, 100, 11, '000000') + shpText(2.5, 0, 70, 11, [{ t: 'From the floor', sz: 2200, b: true, col: 'FFFFFF' }]) +
      shpText(70, 0, 27.5, 11, [{ t: d.shift.name + ' shift' + DOT + dateStr, sz: 1200, col: 'C9D1D9' }], { align: 'r' }) + shpRect(0, 11, 100, 0.9, AMBER);
    let ny = 16;
    d.notes.slice(0, 8).forEach(nt => {
      if(ny > 88) return;
      n += shpText(4, ny, 92, 3.6, [{ t: nt.q, sz: 1100, b: true }], { anchor: 't' }); ny += 3.8;
      const lines = Math.max(1, Math.ceil(String(nt.a).length / 150));
      const h = Math.min(16, 3 + lines * 2.6);
      n += shpRect(4, ny, 92, h, 'F5F6F7', { round: true }) + shpText(5, ny, 90, h, [{ t: nt.a, sz: 1100, col: '2A3138' }]); ny += h + 2;
    });
    n += shpRect(0, 97.5, 100, 0.7, AMBER);
    slides.push(slideXml(n));
  }
  return pack(slides);
}

/* ---- the week in review ----
   One slide for a Monday: what the week produced day by day, every area
   against its standard, the crew's best and worst over the whole week with
   how productive their time was, and what to watch. d: see eos.js
   gatherWeek() for the shape. */
function buildWeekDeck(d){
  _sid = 1;
  const T = d.totals, fl = d.prodFloor;
  const utilCol = u => u == null ? GREY : u >= fl ? GREEN : u >= fl - 15 ? AMBER : RED;
  const dayName = k => new Date(k + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
  const span = new Date(d.week.from + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) + ' to ' + new Date(d.week.to + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  let sh = '';
  sh += shpRect(0, 0, 100, 12, '000000') +
    shpText(3, 0, 55, 12, [{ t: d.title || 'Staging Lane Health', sz: 2400, b: true, col: 'FFFFFF' }]) +
    shpText(55, 1, 42, 5, [{ t: 'WEEK IN REVIEW', sz: 1000, b: true, col: AMBER }], { align: 'r' }) +
    shpText(55, 5.5, 42, 6, [{ t: 'Monday ' + span + DOT + T.daysWithData + ' working day' + (T.daysWithData === 1 ? '' : 's'), sz: 1200, col: 'FFFFFF' }], { align: 'r', anchor: 't' }) +
    shpRect(0, 12, 100, 0.8, AMBER);
  const goalWeek = T.goalPerDay ? T.goalPerDay * T.daysWithData : 0;
  const tiles = [
    [fmt(T.lines), 'Lines picked', goalWeek ? (Math.round(T.lines / goalWeek * 100) + '% of ' + fmt(goalWeek) + ' for the week') : 'delivery lines', goalWeek ? pctCol(Math.round(T.lines / goalWeek * 100)) : 'FFFFFF'],
    [fmt(T.picks), 'Picks confirmed', fmt1(T.hours) + ' active hours', 'FFFFFF'],
    [fmt(T.orders), 'Orders shipped', T.medianDwellMin != null ? ('median ' + T.medianDwellMin + ' min in staging') : 'left staging', GREEN],
    [T.crewPct == null ? '--' : T.crewPct + '%', 'Crew against standard', 'picks against the standards, all week', pctCol(T.crewPct)],
    [T.util == null ? '--' : T.util + '%', 'Productive time', 'active hours of ' + d.dayHours + ' a shift, floor ' + fl + '%', utilCol(T.util)],
    [fmt(T.pickers), 'Pickers', T.newPickers ? (T.newPickers + ' picked on one day only') : 'picked this week', 'FFFFFF']
  ];
  tiles.forEach((t, i) => {
    const x = 3 + i * 15.9, w = 14.7;
    sh += shpRect(x, 15.5, w, 17, INK, { round: true }) +
      shpText(x, 16.5, w, 8, [{ t: t[0], sz: 2600, b: true, col: t[3] }], { align: 'ctr' }) +
      shpText(x, 24.2, w, 4, [{ t: t[1], sz: 1000, b: true, col: 'FFFFFF' }], { align: 'ctr' }) +
      shpText(x, 27.7, w, 4, [{ t: t[2], sz: 850, col: '9AA4AD' }], { align: 'ctr' });
  });
  // left: day by day, then the areas
  const LX = 3, LW = 45;
  let y = 36;
  sh += heading(LX, y, LW, 'DAY BY DAY', T.goalPerDay ? ('line goal ' + fmt(T.goalPerDay) + ' a day') : '');
  y += 5;
  const DW = [1.6, 1.1, 1.1, 1.1, 1.0, 1.1];
  sh += row(LX, y, LW, 3.0, [{ t: 'Day', w: DW[0], col: MUTE }, { t: 'Lines', w: DW[1], col: MUTE, align: 'r' }, { t: 'Picks', w: DW[2], col: MUTE, align: 'r' }, { t: 'Shipped', w: DW[3], col: MUTE, align: 'r' }, { t: '% std', w: DW[4], col: MUTE, align: 'r' }, { t: 'Productive', w: DW[5], col: MUTE, align: 'r' }], 850);
  y += 3.0;
  (d.byDay || []).forEach((r, i) => {
    const under = T.goalPerDay && r.lines != null && r.lines < T.goalPerDay;
    sh += row(LX, y, LW, 3.1, [{ t: dayName(r.day), w: DW[0], b: true }, { t: r.lines == null ? '--' : fmt(r.lines), w: DW[1], align: 'r', col: under ? RED : INK, b: !!under },
      { t: fmt(r.picks), w: DW[2], align: 'r' }, { t: r.orders == null ? '--' : fmt(r.orders), w: DW[3], align: 'r' },
      { t: r.pct == null ? '--' : r.pct + '%', w: DW[4], align: 'r', b: true, col: pctCol(r.pct) }, { t: r.util == null ? '--' : r.util + '%', w: DW[5], align: 'r', b: true, col: utilCol(r.util) }], 950, i % 2 ? null : 'F5F6F7');
    y += 3.1;
  });
  y += 1.5;
  sh += heading(LX, y, LW, 'AREAS AGAINST STANDARD', 'picks an active hour, all week');
  y += 5;
  (d.areas || []).slice(0, 6).forEach(a => {
    const has = a.target && a.rate != null;
    const frac = has ? Math.min(1, a.rate / a.target) : 0;
    const col = !has ? GREY : a.rate >= a.target ? GREEN : a.rate >= a.target * 0.85 ? AMBER : RED;
    sh += shpText(LX, y, 12, 3.0, [{ t: a.area, sz: 950, b: true }]) +
      shpRect(LX + 12, y + 0.8, 20, 1.5, LINE, { round: true }) + (frac > 0 ? shpRect(LX + 12, y + 0.8, Math.max(0.5, 20 * frac), 1.5, col, { round: true }) : '') +
      shpText(LX + 33, y, 12, 3.0, [{ t: has ? (fmt1(a.rate) + ' / ' + a.target) : (a.rate != null ? fmt1(a.rate) + ' / --' : '--'), sz: 950, b: true, col: col }], { align: 'r' });
    y += 3.0;
  });
  // right: the crew over the week, then what to watch
  const RX = 52, RW = 45;
  let ry = 36;
  const util = { lab: 'Productive', v: p => (p.util == null ? '--' : p.util + '%'), colOf: p => utilCol(p.util) };
  let r = crewTable(RX, ry, RW, 'MOST PRODUCTIVE', 'top 5 by percent of standard, all week', d.top, 'nobody over the floor for the week', util);
  sh += r.out; ry = r.y + 1.5;
  r = crewTable(RX, ry, RW, 'NEEDS ATTENTION', 'lowest 5 by percent of standard, all week', d.bottom, d.top.length ? 'everybody else is in the top group' : '', util);
  sh += r.out; ry = r.y + 1.2;
  sh += heading(RX, ry, RW, 'WATCH', '');
  ry += 4.6;
  const watch = (d.watch || []).slice(0, 3);
  if(!watch.length) sh += shpText(RX, ry, RW, 3, [{ t: 'nothing outstanding', sz: 900, col: MUTE }]);
  watch.forEach(w => { sh += shpText(RX, ry, RW, 2.9, [{ t: '\u2022  ' + w, sz: 880, col: '2A3138' }]); ry += 2.9; });
  sh += shpRect(0, 97.6, 100, 0.7, AMBER) +
    shpText(3, 93.6, 55, 3.6, [{ t: 'Generated ' + new Date(d.generatedAt).toLocaleString('en-US') + (d.why === 'automatic' ? ' automatically at the start of the week' : ' on request'), sz: 850, col: '9AA4AD' }]) +
    shpText(45, 93.6, 52, 3.6, [{ t: d.footnote || '', sz: 800, col: '9AA4AD' }], { align: 'r' });
  return pack([slideXml(sh)]);
}

/* the primitives are exported too, so another deck (tools/make-guide-deck.js)
   is put together the same way rather than growing a second writer */
module.exports = { buildEosDeck, buildWeekDeck, zipBuild, crc32, shpRect, shpText, shpPic, slideXml, pack, SW, SH };
