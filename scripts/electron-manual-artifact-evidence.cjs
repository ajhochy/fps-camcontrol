'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { VARIANTS, SafeError, run, fileEvidence, inspectApp } = require('./electron-signing-support.cjs');
const root = path.resolve(__dirname, '..');

function inventory(directory) {
  const result = { files: 0, bytes: 0 }, digest = crypto.createHash('sha256');
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name), relative = path.relative(directory, file);
      if (entry.isSymbolicLink()) digest.update(`${relative}\0link\0${fs.readlinkSync(file)}\n`);
      else if (entry.isDirectory()) walk(file);
      else {
        const data = fileEvidence(file); result.files++; result.bytes += data.bytes;
        digest.update(`${relative}\0${data.sha256}\n`);
      }
    }
  }
  walk(directory);
  return { ...result, treeSha256: digest.digest('hex') };
}

function runtimeEvidence(file, dmgSha256) {
  if (!file) return { status: 'NOT_RUN', reason: 'No artifact-matched runtime evidence supplied' };
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (report.dmg?.sha256 !== dmgSha256) return { status: 'UNMATCHED', path: file, reason: 'Runtime evidence does not identify this exact DMG hash' };
  const criteria = Object.values(report.criteria || {});
  const status = !report.failure && criteria.length > 0 && criteria.every(value => /^PASS\b/.test(String(value))) ? 'PASS' : 'FAIL';
  return { status, path: file, sha256: fileEvidence(file).sha256, criteria: report.criteria || {},
    evidenceBoundary: report.evidenceBoundary || 'No clean-OS or hardware claim inferred' };
}

function sourceEvidence(file, appAsarSha256) {
  if (!file || !fs.existsSync(file)) return { status: 'UNVERIFIED', reason: 'No build provenance receipt supplied' };
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (receipt.appAsarSha256 !== appAsarSha256 || !/^[a-f0-9]{40}$/.test(receipt.sourceCommit || '')) {
    return { status: 'UNMATCHED', path: file, reason: 'Build receipt does not identify this packaged app' };
  }
  return { status: receipt.sourceDirty === false ? 'COMMIT_BUILD' : 'DIRTY_BUILD', path: file,
    sha256: fileEvidence(file).sha256, sourceCommit: receipt.sourceCommit, sourceDirty: receipt.sourceDirty,
    sourceBranch: receipt.sourceBranch, packagedAt: receipt.packagedAt };
}

async function check(command, args, label) {
  try { await run(command, args, { label }); return 'PASS'; } catch { return 'NOT_VERIFIED'; }
}

async function main(argv = process.argv.slice(2)) {
  const options = { variant: 'manual' };
  const keys = new Map([['--variant', 'variant'], ['--app', 'app'], ['--dmg', 'dmg'],
    ['--runtime-evidence', 'runtime'], ['--signing-evidence', 'signing'], ['--source-receipt', 'source']]);
  for (let i = 0; i < argv.length; i++) {
    if (!keys.has(argv[i]) || !argv[i + 1]) throw new SafeError('Invalid artifact evidence argument');
    options[keys.get(argv[i])] = argv[++i];
  }
  if (!VARIANTS[options.variant]) throw new SafeError('Unknown FPS variant');
  const release = path.join(root, 'release', options.variant), variant = VARIANTS[options.variant];
  const app = options.app || path.join(release, 'mac-arm64', `${variant.name}.app`);
  const inspection = await inspectApp(app, options.variant);
  const dmg = options.dmg || path.join(release, `${variant.name}-${options.variant}-${inspection.version}-arm64.dmg`);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { label: 'Artifact strict signature verification' });
  const sourceObservation = {
    head: (await run('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(),
    branch: (await run('/usr/bin/git', ['-C', root, 'branch', '--show-current'])).stdout.trim(),
    dirty: !!(await run('/usr/bin/git', ['-C', root, 'status', '--porcelain'])).stdout.trim(),
    meaning: 'Checkout at inspection; build provenance below is the artifact-to-source association',
  };
  const appAsarSha256 = fileEvidence(path.join(app, 'Contents/Resources/app.asar')).sha256;
  const dmgInfo = fileEvidence(dmg);
  const signing = { strictVerify: 'PASS', nestedTargets: inspection.targets.length, nativeBinaries: inspection.native.length,
    appStaple: await check('/usr/bin/xcrun', ['stapler', 'validate', app], 'App staple check'),
    dmgStaple: await check('/usr/bin/xcrun', ['stapler', 'validate', dmg], 'DMG staple check'),
    appGatekeeper: await check('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], 'App Gatekeeper check'),
    dmgGatekeeper: await check('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg], 'DMG Gatekeeper check'),
    appleAcceptance: 'UNVERIFIED' };
  if (options.signing) {
    const receipt = JSON.parse(fs.readFileSync(options.signing, 'utf8'));
    if (receipt.dmg?.sha256 === dmgInfo.sha256 && receipt.appAcceptance?.status === 'Accepted' && receipt.dmgAcceptance?.status === 'Accepted') {
      signing.appleAcceptance = 'Accepted';
      signing.receipt = { path: options.signing, sha256: fileEvidence(options.signing).sha256,
        appSubmission: receipt.appAcceptance.id, dmgSubmission: receipt.dmgAcceptance.id };
    }
  }
  const pkg = require('../package.json');
  const report = { createdAt: new Date().toISOString(), variant: options.variant, sourceObservation,
    source: sourceEvidence(options.source || path.join(release, 'build-provenance.json'), appAsarSha256),
    app: { path: app, ...inventory(app), appAsarSha256, bundleIdentifier: inspection.appId,
      version: inspection.version, architecture: inspection.architecture, minOS: inspection.minimumMacOS,
      highestBinaryMinimumMacOS: inspection.highestBinaryMinimumMacOS, native: inspection.native },
    dmg: dmgInfo, versions: { buildNode: process.versions.node, electron: pkg.devDependencies.electron,
      electronBuilder: pkg.devDependencies['electron-builder'], rebuild: pkg.devDependencies['@electron/rebuild'], playwright: pkg.devDependencies.playwright },
    signing, runtime: runtimeEvidence(options.runtime, dmgInfo.sha256), cleanOS: 'NOT_TESTED', physicalHID: 'NOT_TESTED' };
  const directory = path.join(root, 'docs/ai/runs', `electron-${options.variant}-evidence`);
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, `artifact-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  console.log(JSON.stringify({ evidence: output, app: report.app.path, dmg: report.dmg, source: report.source.status,
    signing: report.signing, runtime: report.runtime.status }, null, 2));
  return report;
}

if (require.main === module) main().catch(error => {
  console.error(error instanceof SafeError ? error.message : 'Artifact evidence inspection failed; private diagnostics suppressed');
  process.exitCode = 1;
});
module.exports = { inventory, runtimeEvidence, sourceEvidence, main };
