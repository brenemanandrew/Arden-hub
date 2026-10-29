'use strict';
/* Windows trusted certificates, for Node.
   A corporate network that inspects HTTPS re-signs every connection with the
   company's own certificate authority. Windows trusts it, so Edge and Chrome
   are happy, but Node ships its own fixed list of authorities and refuses the
   connection ("self-signed certificate in certificate chain").

   This reads the certificates Windows already trusts and hands them to Node,
   so the push is verified against the same authority the browser uses. It is
   not a way around certificate checking: nothing is trusted that this PC did
   not already trust. */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PS = `$ErrorActionPreference='SilentlyContinue'
$out = New-Object System.Text.StringBuilder
foreach($s in @('Cert:\\LocalMachine\\Root','Cert:\\CurrentUser\\Root','Cert:\\LocalMachine\\CA','Cert:\\CurrentUser\\CA')){
  Get-ChildItem $s | ForEach-Object {
    [void]$out.AppendLine('-----BEGIN CERTIFICATE-----')
    [void]$out.AppendLine([Convert]::ToBase64String($_.RawData,'InsertLineBreaks'))
    [void]$out.AppendLine('-----END CERTIFICATE-----')
  }
}
[Console]::Out.Write($out.ToString())`;

let cache = null;          // array of PEM strings, or null when not loaded
let loading = null;        // in-flight promise
let cacheFile = null;

function split(pem){
  const out = [];
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  let m;
  while((m = re.exec(pem))) out.push(m[0]);
  return out;
}

function init(dataDir){
  cacheFile = path.join(dataDir, 'windows-ca.pem');
  if(cache) return;
  try{
    const st = fs.statSync(cacheFile);
    // a week old is fine; roots change rarely and a stale one only costs a retry
    if(Date.now() - st.mtimeMs < 7 * 86400000){
      const certs = split(fs.readFileSync(cacheFile, 'utf8'));
      if(certs.length) cache = certs;
    }
  }catch(e){}
}

function cached(){ return cache; }

/* Reads the store through PowerShell. Only ever used for certificates, so the
   COM problems that stop PowerShell driving SAP do not apply here. */
function load(){
  if(loading) return loading;
  loading = new Promise(resolve => {
    if(process.platform !== 'win32'){ resolve(null); return; }
    const win = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const exe = path.join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(fs.existsSync(exe) ? exe : 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        const certs = stdout ? split(stdout) : [];
        if(certs.length){
          cache = certs;
          try{ if(cacheFile) fs.writeFileSync(cacheFile, certs.join('\n') + '\n'); }catch(e){}
        }
        resolve(certs.length ? certs : null);
      });
  }).then(v => { loading = null; return v; });
  return loading;
}

/* Error codes OpenSSL raises when it cannot build a chain to a trusted root,
   which is exactly what HTTPS inspection looks like from Node's side. */
const CERT_CODES = ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE'];
function isCertError(e){
  if(!e) return false;
  if(e.code && CERT_CODES.indexOf(e.code) >= 0) return true;
  return /self.?signed|unable to verify|certificate chain|CERT_/i.test(e.message || '');
}

module.exports = { init, load, cached, isCertError, count: () => (cache ? cache.length : 0) };
