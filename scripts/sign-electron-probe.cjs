// Local sign-only. No notarization/upload, credential loader, keychain mutation or secret output.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const app = path.resolve(__dirname,'../dist/electron-probe/mac-arm64/FPS CamControl Probe.app');
const run = (cmd,args) => execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const identities = [...run('/usr/bin/security',['find-identity','-v','-p','codesigning'])
  .matchAll(/^\s*\d+\)\s+([a-f0-9]{40})\s+"([^"\n]+)"/gim)]
  .filter(m=>m[2]==='Developer ID Application: Aaron Hochhalter (56Q69NYP9H)');
const requested = process.env.APPLE_SIGNING_IDENTITY;
const identity = requested ? identities.find(m=>m[1].toUpperCase()===requested.toUpperCase() || m[2]===requested)?.[1] : identities[0]?.[1];
if (!identity) throw new Error('Existing approved Developer ID identity unavailable');
const entitlements = path.resolve(__dirname,'../dist/electron-probe/probe-jit.plist');
fs.writeFileSync(entitlements,'<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
const magic = new Set([0xfeedface,0xfeedfacf,0xcefaedfe,0xcffaedfe,0xcafebabe,0xbebafeca]);
const targets = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const full = path.join(dir,entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { walk(full); if (/\.(app|framework)$/.test(entry.name)) targets.push(full); }
    else {
      const fd=fs.openSync(full,'r'); const bytes=Buffer.alloc(4);
      const length=fs.readSync(fd,bytes,0,4,0); fs.closeSync(fd);
      if (length===4 && magic.has(bytes.readUInt32BE())) targets.push(full);
    }
  }
}
walk(path.join(app,'Contents'));
targets.sort((a,b)=>b.split('/').length-a.split('/').length);
try {
  for (const target of [...targets,app]) {
    const args=['--force','--options','runtime','--timestamp','--sign',identity];
    if (!/\.(node|dylib)$/.test(target)) args.push('--entitlements',entitlements);
    run('/usr/bin/codesign',[...args,target]);
  }
  run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app]);
  console.log(JSON.stringify({localSigned:true,team:'56Q69NYP9H',nestedTargets:targets.length,
    credentialPresence:Object.fromEntries(['APPLE_SIGNING_IDENTITY','APPLE_TEAM_ID','APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD'].map(k=>[k,!!process.env[k]])),notaryUpload:false}));
} catch {
  // execFile errors may carry command/environment; never print them.
  console.error('Local signing or strict verification failed; no upload attempted.');
  process.exitCode=1;
}
