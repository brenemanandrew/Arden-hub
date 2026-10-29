'use strict';
/* Telling the copy on the internet what is in the folder.

   The PC beside SAP is the only one that can see the export folder, so
   it is the one that says what is in it. The copy out on the internet
   has no folder of its own worth reading - whatever it holds, this put
   there - and it forgets everything the moment that machine is
   suspended, which is most of the night.

   So this sends on every change, and again whenever the copy answers
   that it is holding nothing. That second one is the important one: it
   is one small call every few minutes, and it is what fills the board
   back in after the copy has been asleep.

   It sends the file itself, not rows read out of it. The copy runs the
   same reader this does, so handing it the bytes means both sides agree
   by construction - and nothing has to survive a trip through CSV,
   where an 18 digit handling unit quietly loses its last three digits.

   This is a sender, not a puller. It drives no SAP session and asks the
   other service for nothing; it only copies a file that is already on
   the disk beside it.

   The key is not the viewer password. The password is for people
   opening the page; this runs where nobody is there to type one. */

const fs = require('fs');
const tls = require('tls');
const winca = require('./winca');
const { KINDS } = require('./ingest');

class Push {
  constructor(opt, log){
    this.url = String((opt && opt.url) || '').trim().replace(/\/+$/, '');
    this.key = String((opt && opt.key) || '').trim();
    this.ingest = opt && opt.ingest;
    this.log = log || (() => {});
    this.sent = {};            // kind -> the file signature already up there
    this.seen = -1;            // the ingest version this last looked at
    this.busy = false;
  }
  get on(){ return !!(this.url && this.key); }
  lib(){ return this.url.indexOf('https:') === 0 ? require('https') : require('http'); }

  /* A corporate network that inspects HTTPS re-signs every connection with
     the company's own authority. Windows trusts it, so the browser opens
     the board happily, but Node carries its own fixed list of authorities
     and refuses: "self-signed certificate in certificate chain". Every push
     fails while the board beside it looks perfectly healthy.

     So the certificates Windows already trusts are added to Node's own.
     This is not a way around certificate checking - nothing is trusted here
     that this PC did not already trust - and it is the same fix, out of the
     same module, that Staging Lane Health uses to reach its own copy from
     this very machine. Both readers on one PC, behaving the same way. */
  tlsOpts(){
    if(this.url.indexOf('https:') !== 0) return {};
    const roots = winca.cached();
    return (roots && roots.length) ? { ca: tls.rootCertificates.concat(roots) } : {};
  }

  /* what is on the disk for one kind, and the stamp that says whether the
     copy already has this exact file */
  fileOf(kind){
    const loc = this.ingest.locate(kind);
    if(!loc) return null;
    return { path: loc.path, name: loc.name, sig: loc.name + '|' + loc.st.mtimeMs + '|' + loc.st.size };
  }

  sendOne(kind){
    const f = this.fileOf(kind);
    if(!f) return Promise.resolve(false);
    let buf;
    try{ buf = fs.readFileSync(f.path); }
    catch(e){ return Promise.resolve(false); }   // being written; the next pass gets it
    if(!buf.length) return Promise.resolve(false);
    const u = new URL(this.url + '/api/drop');
    return new Promise(resolve => {
      const req = this.lib().request(Object.assign({
        method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length,
                   'X-Pack-Key': this.key, 'X-Pack-Kind': kind, 'X-File-Name': f.name }
      }, this.tlsOpts()), res => {
        res.resume();
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if(ok) this.sent[kind] = f.sig;
        else this.log('push ' + kind + ': the copy said ' + res.statusCode);
        resolve(ok);
      });
      req.setTimeout(120000, () => { req.destroy(new Error('timed out')); });
      req.on('error', e => {
        /* remembered rather than acted on here, so one pass reports one
           diagnosis instead of three identical lines */
        if(winca.isCertError(e)) this.certErr = true;
        this.log('push ' + kind + ' failed: ' + e.message);
        resolve(false);
      });
      req.end(buf);
    });
  }

  /* `force` ignores what the copy is believed to already have, which is
     what a copy that just told us it is empty needs */
  async pass(force){
    let ok = 0, tried = 0;
    for(const kind of Object.keys(KINDS)){
      const f = this.fileOf(kind);
      if(!f) continue;
      if(!force && this.sent[kind] === f.sig) continue;
      tried++;
      if(await this.sendOne(kind)) ok++;
    }
    return { ok, tried };
  }

  async all(why, force){
    if(!this.on || this.busy) return;
    this.busy = true;
    try{
      this.certErr = false;
      let r = await this.pass(force);
      /* The first certificate failure is the only one worth reacting to:
         read the Windows store once, then send the same pass again. After
         that the roots are cached, on disk for a week, and this never runs
         again on this network. */
      if(this.certErr && !this.triedCa){
        this.triedCa = true;
        this.log('HTTPS here is being inspected by your network; loading the certificates Windows trusts and trying again');
        const certs = await winca.load();
        if(certs && certs.length){
          this.log('trusting ' + certs.length + ' certificates from the Windows store');
          this.certErr = false;
          r = await this.pass(force);
        } else {
          this.log('the Windows certificate store could not be read, so the push cannot be verified and will keep failing');
        }
      }
      if(r.tried) this.log('sent ' + r.ok + ' of ' + r.tried + ' to ' + this.url + ' (' + why + ')');
    } finally { this.busy = false; }
  }

  /* the copy's own health, which it answers without a password */
  remoteEmpty(){
    const u = new URL(this.url + '/api/health');
    return new Promise(resolve => {
      const req = this.lib().get(Object.assign({ hostname: u.hostname, port: u.port || undefined,
                                   path: u.pathname, headers: { 'Cache-Control': 'no-cache' } },
                                 this.tlsOpts()), res => {
        let t = '';
        res.on('data', d => { t += d; if(t.length > 65536) req.destroy(); });
        res.on('end', () => {
          try{
            const feed = (JSON.parse(t) || {}).feed || {};
            const kinds = Object.keys(feed);
            /* nothing at all, or every file it knows about is empty */
            resolve(!kinds.length || kinds.every(k => !(feed[k] && feed[k].rows)));
          }catch(e){ resolve(false); }      // unreachable or odd: not a reason to resend
        });
      });
      req.setTimeout(20000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  start(){
    if(!this.on) return;
    this.all('starting up');
    /* the folder moves when the host writes a new export. Watching the
       version covers every way a re-read can happen - the folder watch,
       the slow sweep, somebody pressing re-read - without this having to
       know about any of them. */
    setInterval(() => {
      if(this.ingest.version === this.seen) return;
      this.seen = this.ingest.version;
      this.all('the folder changed');
    }, 5000).unref();
    setInterval(async () => {
      if(await this.remoteEmpty()) this.all('the copy was holding nothing', true);
    }, 300000).unref();
  }
}

module.exports = { Push };
