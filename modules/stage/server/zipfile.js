'use strict';
/* A zip file, both ways, with nothing installed.

   The data backup has to be something a person can open by double-clicking
   it anywhere and something the app can open on a fresh PC without any
   help. A zip is the only format that is both, and Node ships the deflate
   half of it in zlib. What it does not ship is the container, which is a
   handful of little-endian headers and is written out here.

   Reading trusts the central directory for sizes and offsets and nothing
   else. A local header may carry zeros with the real sizes trailing the
   data (PowerShell's Compress-Archive does this), and the central directory
   is the one place every writer has to get right. */
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf){
  let c = 0xFFFFFFFF;
  for(let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const u16 = v => Buffer.from([v & 0xFF, (v >>> 8) & 0xFF]);
const u32 = v => Buffer.from([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
/* MS-DOS date and time, which is what the format still uses */
function dosStamp(d){
  d = d || new Date();
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/* entries: [{ name, data: Buffer|string, mtime? }] -> Buffer.
   Deflated, because a year of history is tens of megabytes of very
   repetitive JSON and comes out at a tenth of the size. */
function write(entries){
  const parts = [], central = [];
  let offset = 0;
  for(const e of entries){
    const name = Buffer.from(String(e.name).replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 6 });
    /* deflate can be larger than the input for tiny files; stored is honest then */
    const useStored = packed.length >= data.length;
    const body = useStored ? data : packed;
    const method = useStored ? 0 : 8;
    const crc = crc32(data);
    const st = dosStamp(e.mtime);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(st.time), u16(st.date),
      u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0)]);
    parts.push(local, name, body);
    central.push({ name, method, st, crc, comp: body.length, size: data.length, offset });
    offset += local.length + name.length + body.length;
  }
  const dir = [];
  for(const c of central){
    dir.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(c.method), u16(c.st.time), u16(c.st.date),
      u32(c.crc), u32(c.comp), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset)]), c.name);
  }
  const dirBytes = dir.reduce((t, b) => t + b.length, 0);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(dirBytes), u32(offset), u16(0)]);
  return Buffer.concat(parts.concat(dir, [end]));
}

/* Buffer -> [{ name, data: Buffer }]. Throws on anything it does not
   understand rather than returning part of an archive. */
function read(buf){
  if(!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip file');
  // the end record is at the very end unless there is a comment; scan back for it
  let eocd = -1;
  for(let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--){
    if(buf.readUInt32LE(i) === 0x06054b50){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error('not a zip file (no end record)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if(cdOff + cdSize > buf.length) throw new Error('zip central directory runs past the end of the file');

  const out = [];
  let p = cdOff;
  for(let n = 0; n < count; n++){
    if(buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip central directory is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const comp = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if(flags & 1) throw new Error('zip entry ' + name + ' is encrypted');
    if(buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip entry ' + name + ' has a damaged header');
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const body = buf.slice(start, start + comp);
    let data;
    if(method === 0) data = body;
    else if(method === 8) data = zlib.inflateRawSync(body);
    else throw new Error('zip entry ' + name + ' uses compression method ' + method + ', which this cannot read');
    if(data.length !== size) throw new Error('zip entry ' + name + ' came out the wrong size');
    if(crc32(data) !== crc) throw new Error('zip entry ' + name + ' failed its checksum');
    if(!name.endsWith('/')) out.push({ name, data });
  }
  return out;
}

module.exports = { write, read, crc32 };
