'use strict';
/* ============================================================
   The door. One PIN for everyone, typed once per device, then a
   signed cookie for 180 days. Same shape as ardenot's sign-in, so the
   lessons carry over:
     - wrong guesses are slowed down (5 from one address = 15 minutes;
       50 from anywhere in an hour = everyone waits 15 minutes)
     - the cookie is HMAC-signed with a secret that lives in Fly, or,
       when none is set, one made once and kept on the data volume so a
       restart does not sign every tablet out
     - a generation number lets "sign out everywhere" work without a
       session table
   The PIN itself: HUB_PASSPHRASE_HASH (scrypt, from tools/make-secrets.js)
   wins; otherwise HUB_PIN; otherwise 2468, the Arden admin convention.
   ============================================================ */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_DAYS = 180;
const COOKIE = 'hub_session';

function normalise(pin) { return String(pin || '').normalize('NFKC').replace(/\s+/g, '').trim(); }

function makeAuth(opts) {
  const dataDir = opts.dataDir;
  const dev = !!opts.dev;
  const log = opts.log || console.log;

  /* ---- the secret that signs cookies ---- */
  let secret = String(process.env.HUB_SESSION_SECRET || '').trim();
  if (!secret) {
    const f = path.join(dataDir, 'session-secret');
    try { secret = fs.readFileSync(f, 'utf8').trim(); } catch (e) { secret = ''; }
    if (!secret) {
      secret = crypto.randomBytes(32).toString('base64url');
      try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f, secret, { mode: 0o600 }); log('AUTH: made a session secret and kept it in ' + f); }
      catch (e) { log('AUTH: no HUB_SESSION_SECRET and ' + dataDir + ' is not writable - sign-ins will not survive a restart.'); }
    }
  }

  /* ---- the PIN ---- */
  const hash = String(process.env.HUB_PASSPHRASE_HASH || '').trim();
  const plain = normalise(process.env.HUB_PIN || '2468');
  if (hash) {
    const p = hash.split('$');
    if (p.length !== 6 || p[0] !== 'scrypt') { console.error('Refusing to start: HUB_PASSPHRASE_HASH is not in the scrypt$N$r$p$salt$hash form.'); process.exit(1); }
  }
  function checkPin(pin) {
    const got = normalise(pin);
    if (!got) return false;
    if (hash) {
      const p = hash.split('$'), want = Buffer.from(p[5], 'base64');
      const h = crypto.scryptSync(got.toLowerCase(), Buffer.from(p[4], 'base64'), want.length, { N: +p[1], r: +p[2], p: +p[3], maxmem: 256 * 1024 * 1024 });
      return crypto.timingSafeEqual(h, want);
    }
    const a = crypto.createHash('sha256').update(got).digest(), b = crypto.createHash('sha256').update(plain).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /* ---- sessions ---- */
  let gen = 0;
  const genFile = path.join(dataDir, 'session-gen');
  try { gen = parseInt(fs.readFileSync(genFile, 'utf8'), 10) || 0; } catch (e) { gen = 0; }
  function sign(s) { return crypto.createHmac('sha256', secret).update(s).digest('base64url'); }
  function makeSession() {
    const body = Buffer.from(JSON.stringify({ e: Date.now() + SESSION_DAYS * 86400000, g: gen, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
    return body + '.' + sign(body);
  }
  function cookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim(); });
    return out;
  }
  function hasSession(req) {
    const v = cookies(req)[COOKIE]; if (!v) return false;
    const i = v.lastIndexOf('.'); if (i < 1) return false;
    const body = v.slice(0, i), mac = v.slice(i + 1), want = sign(body);
    if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
    try { const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return o.e > Date.now() && (o.g | 0) === gen; }
    catch (e) { return false; }
  }
  function cookieHeader(v, maxAge) {
    return COOKIE + '=' + v + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (dev ? '' : '; Secure');
  }
  function signOutEverywhere() {
    gen++;
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(genFile, String(gen)); } catch (e) { /* in memory only */ }
  }

  /* ---- wrong guesses ---- */
  const fails = new Map();
  let global = { n: 0, since: Date.now(), until: 0 };
  function blocked(ip) {
    const now = Date.now();
    if (global.until > now) return Math.ceil((global.until - now) / 60000);
    const f = fails.get(ip);
    return f && f.until > now ? Math.ceil((f.until - now) / 60000) : 0;
  }
  function failed(ip) {
    const now = Date.now();
    const f = fails.get(ip) || { n: 0, first: now, until: 0 };
    if (now - f.first > 15 * 60000) { f.n = 0; f.first = now; }
    f.n++; if (f.n >= 5) { f.until = now + 15 * 60000; f.n = 0; f.first = now; }
    fails.set(ip, f);
    if (now - global.since > 3600000) global = { n: 0, since: now, until: 0 };
    if (++global.n >= 50) { global.until = now + 15 * 60000; global.n = 0; global.since = now; console.error('LOGIN: 50 wrong PINs in an hour - all sign-ins paused 15 minutes.'); }
  }
  function succeeded(ip) { fails.delete(ip); }

  return { checkPin, makeSession, hasSession, cookieHeader, signOutEverywhere, blocked, failed, succeeded,
           SESSION_DAYS, usingHash: !!hash, defaultPin: !hash && plain === '2468' };
}

module.exports = { makeAuth, normalise };
