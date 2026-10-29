'use strict';
/* The feed from the host to the cloud copy, sealed.

   It already travelled over HTTPS with the certificate chain checked against
   the Windows store, so the wire was never the weak part. What was weak was
   the other end: the copy wrote every push to cloud-last.json as plain text
   on the Fly volume, where anyone with an account login could read a day of
   the warehouse's work straight off the disk.

   So the payload is sealed by the host and only ever opened in memory. The
   copy stores what it was handed, still sealed, and opens it again on start.

   What this does and does not do, plainly:

     - it protects the file at rest, and anything that gets between the two
       machines, from anybody who does not have the ingest secret;
     - it does NOT hide the numbers from a viewer. The copy has to open the
       payload to draw a board out of it, and the browser is sent the numbers
       either way. Anyone who can open the board can read them.

   AES-256-GCM, so opening it also proves the host sealed it: a payload that
   has been altered by a byte fails outright rather than being believed. That
   is strictly better than the header key it sits behind, which only ever
   proved the sender knew a string.

   The key is derived from the ingest secret both machines already share, so
   there is nothing new to configure and nothing new to lose. Derivation is
   deliberately slow, which is the point of scrypt, so the answer is kept
   rather than worked out on every push. */
const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = Buffer.from('SLH1');      // so a sealed body is told from a plain one by looking
const IV_LEN = 12;                      // 96 bits, what GCM is specified for
const TAG_LEN = 16;
/* A fixed salt rather than a random one per push: both machines have to reach
   the same key from the same secret without talking about it first, and the
   secret itself is the thing carrying the entropy. */
const SALT = Buffer.from('slh-feed-v1');

const keyCache = new Map();
function keyFor(secret){
  const s = String(secret || '');
  if(!s) throw new Error('no ingest secret, so nothing to seal the feed with');
  let k = keyCache.get(s);
  if(!k){
    k = crypto.scryptSync(s, SALT, 32);
    keyCache.set(s, k);
  }
  return k;
}

/* object -> one sealed buffer: gzip first, because JSON compresses to about a
   tenth and there is no point paying to encrypt what gzip would have thrown
   away. */
function seal(obj, secret){
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

function isSealed(buf){
  return Buffer.isBuffer(buf) && buf.length > MAGIC.length + IV_LEN + TAG_LEN &&
         buf.slice(0, MAGIC.length).equals(MAGIC);
}

/* sealed buffer -> object. Throws if the secret is wrong or a byte moved;
   there is no half-open state to reason about. */
function open(buf, secret){
  if(!isSealed(buf)) throw new Error('not a sealed payload');
  const iv = buf.slice(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.slice(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const body = buf.slice(MAGIC.length + IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), iv);
  d.setAuthTag(tag);
  let plain;
  try{ plain = Buffer.concat([d.update(body), d.final()]); }
  catch(e){ throw new Error('the payload would not open: wrong ingest secret, or it was altered on the way'); }
  return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
}

/* The same seal over bytes that are already packed - a backup zip - so the
   gzip step is skipped and nothing is parsed on the way out. A different
   mark, so a sealed feed and a sealed file are never mistaken for each
   other. */
const RAW_MAGIC = Buffer.from('SLHR');
function sealRaw(bytes, secret){
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const body = Buffer.concat([c.update(bytes), c.final()]);
  return Buffer.concat([RAW_MAGIC, iv, c.getAuthTag(), body]);
}
function isSealedRaw(buf){
  return Buffer.isBuffer(buf) && buf.length > RAW_MAGIC.length + IV_LEN + TAG_LEN && buf.slice(0, RAW_MAGIC.length).equals(RAW_MAGIC);
}
function openRaw(buf, secret){
  if(!isSealedRaw(buf)) throw new Error('not a sealed file');
  const iv = buf.slice(RAW_MAGIC.length, RAW_MAGIC.length + IV_LEN);
  const tag = buf.slice(RAW_MAGIC.length + IV_LEN, RAW_MAGIC.length + IV_LEN + TAG_LEN);
  const body = buf.slice(RAW_MAGIC.length + IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), iv);
  d.setAuthTag(tag);
  try{ return Buffer.concat([d.update(body), d.final()]); }
  catch(e){ throw new Error('the file would not open: wrong ingest secret, or it was altered on the way'); }
}

module.exports = { seal, open, isSealed, MAGIC, sealRaw, openRaw, isSealedRaw };
