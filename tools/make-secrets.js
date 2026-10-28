'use strict';
/* Makes the Fly secrets for arden-hub.
     node tools/make-secrets.js "2468"          both secrets
     node tools/make-secrets.js --pin-only "2468"
   Prints the `fly secrets set` line to paste. The PIN is hashed with scrypt
   (scrypt$N$r$p$salt$hash, the same form ardenot uses); the hub never sees
   the PIN itself after that. Nothing is written to disk. */
const crypto = require('crypto');

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const h = crypto.scryptSync(String(pin).normalize('NFKC').replace(/\s+/g, '').trim().toLowerCase(), salt, 32, { N: N, r: r, p: p, maxmem: 256 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), h.toString('base64')].join('$');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const pinOnly = args[0] === '--pin-only';
  const pin = pinOnly ? args[1] : args[0];
  if (!pin) { console.error('Usage: node tools/make-secrets.js [--pin-only] "<PIN>"'); process.exit(1); }
  const out = ['HUB_PASSPHRASE_HASH=' + hashPin(pin)];
  if (!pinOnly) out.push('HUB_SESSION_SECRET=' + crypto.randomBytes(32).toString('base64url'));
  console.log('\nPaste this (one line) from the arden-hub folder:\n');
  console.log('  fly secrets set -a arden-hub ' + out.join(' ') + '\n');
}

module.exports = { hashPin };
