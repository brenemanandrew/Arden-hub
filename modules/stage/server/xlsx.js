'use strict';
/* Minimal .xlsx reader. No dependencies: a workbook is a zip of XML parts,
   and SAP's &XXL export is plain enough that a small parser covers it.
   Returns rows as arrays of strings. Numbers stay as their raw text (dates
   arrive as Excel serials, times as day fractions) which is what the board's
   date helpers already expect. Also reads tab or comma separated text so a
   pasted or manually saved export still works. */
const zlib = require('zlib');

function u16(b, o){ return b[o] | (b[o + 1] << 8); }
function u32(b, o){ return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function readZipEntries(buf){
  // end of central directory
  let eocd = -1;
  for(let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--){
    if(u32(buf, i) === 0x06054b50){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error('not a zip file');
  const count = u16(buf, eocd + 10);
  let off = u32(buf, eocd + 16);
  const entries = {};
  for(let n = 0; n < count; n++){
    if(u32(buf, off) !== 0x02014b50) throw new Error('bad central directory');
    const method = u16(buf, off + 10);
    const csize = u32(buf, off + 20);
    const usize = u32(buf, off + 24);
    const nlen = u16(buf, off + 28), elen = u16(buf, off + 30), clen = u16(buf, off + 32);
    const lho = u32(buf, off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    entries[name] = { method, csize, usize, lho };
    off += 46 + nlen + elen + clen;
  }
  return {
    names: Object.keys(entries),
    read(name){
      const e = entries[name];
      if(!e) return null;
      const lh = e.lho;
      if(u32(buf, lh) !== 0x04034b50) throw new Error('bad local header for ' + name);
      const nlen = u16(buf, lh + 26), elen = u16(buf, lh + 28);
      const start = lh + 30 + nlen + elen;
      const data = buf.subarray(start, start + e.csize);
      if(e.method === 0) return Buffer.from(data);
      if(e.method === 8) return zlib.inflateRawSync(data);
      throw new Error('unsupported compression ' + e.method + ' in ' + name);
    }
  };
}

function decodeXml(s){
  if(s.indexOf('&') < 0) return s;
  return s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (m, k) => {
    switch(k){
      case 'lt': return '<'; case 'gt': return '>'; case 'amp': return '&';
      case 'quot': return '"'; case 'apos': return "'";
    }
    return k[1] === 'x' ? String.fromCodePoint(parseInt(k.slice(2), 16)) : String.fromCodePoint(parseInt(k.slice(1), 10));
  });
}

function parseSharedStrings(xml){
  const out = [];
  if(!xml) return out;
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while((m = re.exec(xml))){
    // a shared string can be split into rich text runs; join every <t>
    let t = '';
    const tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while((tm = tre.exec(m[1]))) t += tm[1];
    out.push(decodeXml(t));
  }
  return out;
}

function colIndex(ref){
  let n = 0;
  for(let i = 0; i < ref.length; i++){
    const c = ref.charCodeAt(i);
    if(c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function parseSheet(xml, shared){
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm;
  while((rm = rowRe.exec(xml))){
    const row = [];
    let cm;
    cellRe.lastIndex = 0;
    while((cm = cellRe.exec(rm[1]))){
      const attrs = cm[1], inner = cm[2] || '';
      const refM = /\br="([A-Z]+)\d+"/.exec(attrs);
      const idx = refM ? colIndex(refM[1]) : row.length;
      const tM = /\bt="(\w+)"/.exec(attrs);
      const type = tM ? tM[1] : 'n';
      let val = '';
      if(type === 'inlineStr'){
        const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner); val = t ? decodeXml(t[1]) : '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if(v){
          if(type === 's'){ const i = parseInt(v[1], 10); val = shared[i] != null ? shared[i] : ''; }
          else if(type === 'b') val = v[1] === '1' ? 'TRUE' : 'FALSE';
          else val = decodeXml(v[1]);
        }
      }
      while(row.length < idx) row.push('');
      row[idx] = val;
    }
    rows.push(row);
  }
  return rows;
}

function firstSheetPath(zip){
  // follow workbook -> rels to the first sheet; fall back to sheet1
  try{
    const wb = zip.read('xl/workbook.xml').toString('utf8');
    const sm = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || /<sheet\b[^>]*\bid="([^"]+)"/.exec(wb);
    if(sm){
      const rels = zip.read('xl/_rels/workbook.xml.rels').toString('utf8');
      const rr = new RegExp('<Relationship\\b[^>]*\\bId="' + sm[1] + '"[^>]*\\bTarget="([^"]+)"').exec(rels)
              || new RegExp('<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="' + sm[1] + '"').exec(rels);
      if(rr){
        let t = rr[1].replace(/^\//, '');
        if(!/^xl\//.test(t)) t = 'xl/' + t;
        if(zip.names.indexOf(t) >= 0) return t;
      }
    }
  }catch(e){}
  return zip.names.find(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)) || 'xl/worksheets/sheet1.xml';
}

function rowsFromXlsx(buf){
  const zip = readZipEntries(buf);
  const ss = zip.read('xl/sharedStrings.xml');
  const shared = parseSharedStrings(ss ? ss.toString('utf8') : '');
  const sheet = zip.read(firstSheetPath(zip));
  if(!sheet) throw new Error('no worksheet in workbook');
  return parseSheet(sheet.toString('utf8'), shared);
}

function rowsFromText(text){
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.length);
  if(!lines.length) return [];
  const tabs = lines.slice(0, 5).some(l => l.indexOf('\t') >= 0);
  if(tabs) return lines.map(l => l.split('\t').map(c => c.trim()));
  // comma separated with quotes
  return lines.map(l => {
    const out = []; let cur = '', q = false;
    for(let i = 0; i < l.length; i++){
      const c = l[i];
      if(q){ if(c === '"'){ if(l[i + 1] === '"'){ cur += '"'; i++; } else q = false; } else cur += c; }
      else if(c === '"') q = true;
      else if(c === ','){ out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  });
}

function isXlsx(buf){ return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; }

function rowsFromBuffer(buf, name){
  if(isXlsx(buf)) return rowsFromXlsx(buf);
  if(/\.xlsx?$/i.test(name || '')) throw new Error('not a valid workbook (zip signature missing)');
  return rowsFromText(buf.toString('utf8'));
}

module.exports = { rowsFromBuffer, rowsFromXlsx, rowsFromText, isXlsx };
