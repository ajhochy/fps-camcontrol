#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { zstdDecompressSync } = require('node:zlib');
const { fileEvidence, signingTargets, compareVersions, minimumOs } = require('./electron-signing-support.cjs');
const manifest = require('./tracking-runtime-manifest.json');
const ROOT = path.resolve(__dirname, '..');

function verifyAsset(file, asset) {
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error(`Missing regular cached asset: ${asset.filename}`);
  const actual = fileEvidence(file);
  if (actual.bytes !== asset.size || actual.sha256 !== asset.sha256) throw new Error(`Asset checksum mismatch: ${asset.filename}`);
  return actual;
}
function safeMembers(listing, wheel = false) {
  const members = listing.split(/\r?\n/).filter(Boolean);
  for (const name of members) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error('Archive member escapes staging directory');
    // Only this audited wheel data layout exists: SymPy's isympy manpage.
    if (wheel && /\.data\//.test(name) && !/^[^/]+\.data\/data\/share\/man\//.test(name)) throw new Error('Unsupported wheel data layout');
  }
  return members;
}
function command(tool, args, options = {}) {
  return execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp' }, ...options });
}
function acquire(asset, cache, download) {
  const file = path.join(cache, asset.filename);
  if (!fs.existsSync(file)) {
    if (!download) throw new Error(`Offline cache missing: ${asset.filename}`);
    const partial = file + '.partial';
    if (fs.existsSync(partial) && fs.lstatSync(partial).isSymbolicLink()) throw new Error('Refusing symbolic partial download');
    try {
      command('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--proto', '=https', '--proto-redir', '=https', '--continue-at', '-', '--output', partial, asset.url]);
    } catch {
      // A previous interrupted run may already have all bytes (HTTP 416).
      try { verifyAsset(partial, asset); } catch { throw new Error(`Asset download incomplete: ${asset.filename}; partial retained for resume`); }
    }
    verifyAsset(partial, asset);
    fs.renameSync(partial, file);
    fs.chmodSync(file, 0o444);
  }
  verifyAsset(file, asset);
  return file;
}
function nativeInventory(target) {
  return signingTargets(target).filter(file => fs.statSync(file).isFile()).map(file => {
    const architectures = command('/usr/bin/lipo', ['-archs', file]).trim().split(/\s+/);
    if (!architectures.includes('arm64')) throw new Error('Runtime native artifact lacks arm64');
    const required = minimumOs(command('/usr/bin/xcrun', ['vtool', '-show-build', '-arch', 'arm64', file]));
    if (compareVersions(required, manifest.minimumMacOS) > 0) throw new Error('Runtime native artifact exceeds advertised minimum macOS');
    const ids = command('/usr/bin/otool', ['-D', file]).split('\n').slice(1).map(line => line.trim()).filter(Boolean);
    const imports = command('/usr/bin/otool', ['-L', file]).split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(line => line && !ids.includes(line));
    if (imports.some(name => name.startsWith('/') && !name.startsWith('/System/Library/') && !name.startsWith('/usr/lib/'))) throw new Error('Runtime links a non-system absolute library');
    return { path: path.relative(target, file), architectures, minimumMacOS: required, imports };
  });
}
function stageRuntime({ cache = path.join(ROOT, 'dist/tracking-cache'), target, download = false } = {}) {
  if (!target || !path.isAbsolute(target)) throw new Error('Use an explicit absolute staging target');
  if (fs.existsSync(target)) throw new Error('Staging target exists; never overwrite a previous runtime');
  fs.mkdirSync(cache, { recursive: true });
  const assets = [...manifest.assets, ...manifest.notices];
  // Verify every runtime/model/license byte before creating executable staging.
  for (const asset of assets) acquire(asset, cache, download);
  fs.mkdirSync(target, { recursive: true });
  const python = manifest.assets.find(asset => asset.name === 'cpython');
  safeMembers(command('/usr/bin/tar', ['-tzf', path.join(cache, python.filename)]));
  command('/usr/bin/tar', ['-xzf', path.join(cache, python.filename), '-C', target]);
  const site = path.join(target, 'python/lib/python3.12/site-packages');
  for (const wheel of manifest.assets.filter(asset => asset.filename.endsWith('.whl'))) {
    safeMembers(command('/usr/bin/unzip', ['-Z1', path.join(cache, wheel.filename)]), true);
    command('/usr/bin/unzip', ['-q', '-n', path.join(cache, wheel.filename), '-d', site]);
  }
  const model = manifest.assets.find(asset => asset.name === 'yolox-s');
  fs.mkdirSync(path.join(target, 'models'));
  fs.copyFileSync(path.join(cache, model.filename), path.join(target, 'models', model.filename));
  const notices = path.join(target, 'notices');
  fs.mkdirSync(notices);
  const full = manifest.notices.find(asset => asset.name === 'python-full-license-source');
  // macOS tar delegates zstd to a host executable. Node's bounded build-time
  // decoder avoids adding a Homebrew dependency to staging or the shipped app.
  const licenseTar = zstdDecompressSync(fs.readFileSync(path.join(cache, full.filename)), { maxOutputLength: 512 * 1024 * 1024 });
  command('/usr/bin/tar', ['-xf', '-', '-C', notices, 'python/PYTHON.json', 'python/licenses'], { input: licenseTar });
  for (const name of ['coloredlogs', 'humanfriendly']) {
    const asset = manifest.notices.find(item => item.name === name + '-license-source');
    const member = `${name}-${name === 'coloredlogs' ? '15.0.1' : '10.0'}/LICENSE.txt`;
    command('/usr/bin/tar', ['-xzf', path.join(cache, asset.filename), '-C', notices, member]);
  }
  for (const asset of manifest.notices.filter(item => !/\.tar\./.test(item.filename))) fs.copyFileSync(path.join(cache, asset.filename), path.join(notices, asset.filename));
  fs.copyFileSync(path.join(ROOT, 'scripts/tracking-runtime-manifest.json'), path.join(target, 'runtime-manifest.json'));
  const native = nativeInventory(target);
  const receipt = { createdAt: new Date().toISOString(), architecture: manifest.architecture, minimumMacOS: manifest.minimumMacOS,
    assets: assets.map(asset => ({ filename: asset.filename, bytes: asset.size, sha256: asset.sha256 })), native,
    python: path.join(target, 'python/bin/python3'), model: path.join(target, 'models', model.filename) };
  fs.writeFileSync(path.join(target, 'staging-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o444 });
  return receipt;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), targetIndex = args.indexOf('--target');
    const result = stageRuntime({ target: targetIndex >= 0 ? args[targetIndex + 1] : undefined, download: args.includes('--download') });
    console.log(JSON.stringify({ python: result.python, model: result.model, nativeFiles: result.native.length, minimumMacOS: result.minimumMacOS }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verifyAsset, safeMembers, acquire, nativeInventory, stageRuntime, manifest };
