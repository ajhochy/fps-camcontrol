#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pins = require('../.github/electron-release-sources.json');
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LABEL = /^testing-[0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?$/;
const variants = { manual: { appId: 'com.ajhochhalter.fpscamcontrol', minimumOs: '13.0' },
  tracking: { appId: 'com.ajhochhalter.fpscamcontrol.tracking', minimumOs: '14.0' } };

function validateReleaseInputs(input) {
  const version = input.version;
  if (typeof version !== 'string' || !LABEL.test(version)) throw new Error('Invalid testing release version/label');
  const sources = [input.manualSourceSha, input.trackingSourceSha];
  if (sources.some(sha => typeof sha !== 'string' || !SHA.test(sha))) throw new Error('Source commit must be a full lowercase SHA');
  if (sources[0] === sources[1]) throw new Error('Manual and tracking source commits must differ');
  if (typeof input.qualificationOnly !== 'boolean') throw new Error('qualificationOnly must be boolean');
  return { tag: `electron-${version}`, version, qualificationOnly: input.qualificationOnly,
    matrix: ['manual', 'tracking'].map((variant, index) => ({ variant, sourceSha: sources[index], architecture: 'arm64' })) };
}

function evidence(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('Asset must be a nonempty regular file');
  const digest = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try { let n; while ((n = fs.readSync(handle, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(handle); }
  return { bytes: stat.size, sha256: digest.digest('hex') };
}

function collectReleaseAssets(entries) {
  if (!Array.isArray(entries) || entries.length !== 2) throw new Error('Exactly two release assets required');
  const seen = new Set();
  const assets = entries.map(entry => {
    if (!variants[entry.variant] || seen.has(entry.variant)) throw new Error('Duplicate or invalid release variant');
    seen.add(entry.variant);
    if (!SHA.test(entry.sourceSha || '')) throw new Error('Invalid source SHA');
    if (!LABEL.test(entry.releaseLabel || '')) throw new Error('Invalid release label');
    if (entry.appVersion !== '0.1.0' || entry.minimumOs !== variants[entry.variant].minimumOs) throw new Error('Unexpected app version or minimum OS');
    const name = path.basename(entry.path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.dmg$/.test(name)) throw new Error('Unsafe DMG asset name');
    return { variant: entry.variant, name, ...evidence(entry.path), sourceSha: entry.sourceSha,
      releaseLabel: entry.releaseLabel, appVersion: entry.appVersion, minimumOs: entry.minimumOs,
      architecture: 'arm64', appId: variants[entry.variant].appId };
  });
  if (assets[0].name === assets[1].name) throw new Error('Duplicate asset name');
  return assets;
}

function publicAsset(asset, variant, releaseLabel) {
  const name = `FPS-CamControl-${variant}-${releaseLabel}-arm64.dmg`;
  if (asset.variant !== variant || asset.name !== name || asset.releaseLabel !== releaseLabel ||
      asset.sourceSha !== pins[variant] || asset.appVersion !== '0.1.0' ||
      asset.minimumOs !== variants[variant].minimumOs || asset.architecture !== 'arm64' ||
      asset.appId !== variants[variant].appId || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 ||
      !SHA256.test(asset.sha256 || '') || asset.apple?.status !== 'Accepted' ||
      !['codesign', 'appStaple', 'dmgStaple', 'gatekeeper'].every(key => asset.apple[key] === 'PASS') ||
      !['appSubmissionId', 'dmgSubmissionId'].every(key => /^[a-f0-9-]{36}$/i.test(asset.apple[key] || '')) ||
      asset.provenance?.type !== 'github-hosted' || !SHA.test(asset.provenance.workflowSha || '') ||
      !/^\d+$/.test(asset.provenance.runId || '') || !/^\d+$/.test(asset.provenance.runAttempt || '')) {
    throw new Error('Uploaded build receipt failed release gates');
  }
  return { variant, name, bytes: asset.bytes, sha256: asset.sha256,
    sourceSha: asset.sourceSha, releaseLabel, appVersion: '0.1.0',
    minimumOs: asset.minimumOs, architecture: 'arm64', appId: asset.appId,
    apple: { status: 'Accepted', appSubmissionId: asset.apple.appSubmissionId,
      dmgSubmissionId: asset.apple.dmgSubmissionId, codesign: 'PASS', appStaple: 'PASS',
      dmgStaple: 'PASS', gatekeeper: 'PASS' },
    provenance: { type: 'github-hosted', workflowSha: asset.provenance.workflowSha,
      runId: asset.provenance.runId, runAttempt: asset.provenance.runAttempt },
    cleanOS: 'NOT_TESTED', physicalHardware: 'NOT_TESTED' };
}

function assertDelivery(delivery, variant, sourceSha) {
  if (delivery.variant !== variant || delivery.sourceCommit !== sourceSha || delivery.sourceDirty !== false ||
      delivery.version !== '0.1.0' || delivery.architecture !== 'arm64' ||
      delivery.appId !== variants[variant].appId || delivery.minimumMacOS !== variants[variant].minimumOs ||
      delivery.appAcceptance?.status !== 'Accepted' || delivery.dmgAcceptance?.status !== 'Accepted' ||
      !SHA256.test(delivery.dmg?.sha256 || '') || !Number.isSafeInteger(delivery.dmg?.bytes) ||
      !['codesign', 'appStaple', 'dmgStaple', 'gatekeeper'].every(key => delivery[key] === 'PASS')) {
    throw new Error('Signed delivery receipt failed source, Apple acceptance or artifact gate');
  }
  if (!/^[a-f0-9-]{36}$/i.test(delivery.appAcceptance.id || '') || !/^[a-f0-9-]{36}$/i.test(delivery.dmgAcceptance.id || '')) {
    throw new Error('Apple acceptance submission IDs missing');
  }
  const actual = evidence(delivery.dmg.path);
  if (actual.sha256 !== delivery.dmg.sha256 || actual.bytes !== delivery.dmg.bytes) throw new Error('Final DMG differs from Apple delivery receipt');
}

function cli(argv = process.argv.slice(2), env = process.env) {
  const [operation, ...args] = argv;
  if (operation === 'plan') {
    const tagVersion = env.GITHUB_REF_NAME?.startsWith('electron-') ? env.GITHUB_REF_NAME.slice(9) : null;
    const version = env.GITHUB_EVENT_NAME === 'push' ? tagVersion : env.RELEASE_VERSION;
    if (!['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) throw new Error('Unsupported release event');
    if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && !['true', 'false'].includes(env.QUALIFICATION_ONLY)) {
      throw new Error('qualification_only must be explicitly true or false for manual dispatch');
    }
    const plan = validateReleaseInputs({ version, manualSourceSha: pins.manual,
      trackingSourceSha: pins.tracking,
      qualificationOnly: env.GITHUB_EVENT_NAME === 'push' ? false : env.QUALIFICATION_ONLY === 'true' });
    if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF_NAME !== plan.tag) throw new Error('Testing tag and release plan differ');
    if (!env.GITHUB_OUTPUT) throw new Error('GitHub output file missing');
    fs.appendFileSync(env.GITHUB_OUTPUT, `tag=${plan.tag}\nversion=${plan.version}\nqualification_only=${plan.qualificationOnly}\nmatrix=${JSON.stringify(plan.matrix)}\n`);
    return;
  }
  if (operation === 'receipt') {
    const [deliveryFile, variant, sourceSha, releaseLabel, outputDir] = args;
    if (!variants[variant] || !SHA.test(sourceSha || '') || !LABEL.test(releaseLabel || '') || !outputDir) throw new Error('Invalid receipt arguments');
    const delivery = JSON.parse(fs.readFileSync(deliveryFile, 'utf8'));
    assertDelivery(delivery, variant, sourceSha);
    fs.mkdirSync(outputDir, { recursive: false });
    const name = `FPS-CamControl-${variant}-${releaseLabel}-arm64.dmg`;
    const assetPath = path.join(outputDir, name);
    fs.copyFileSync(delivery.dmg.path, assetPath, fs.constants.COPYFILE_EXCL);
    const asset = { variant, name, ...evidence(assetPath), sourceSha, releaseLabel,
      appVersion: delivery.version, minimumOs: delivery.minimumMacOS,
      architecture: 'arm64', appId: variants[variant].appId };
    if (asset.sha256 !== delivery.dmg.sha256 || asset.bytes !== delivery.dmg.bytes) throw new Error('Copied asset differs from signed receipt');
    fs.writeFileSync(path.join(outputDir, 'asset.json'), `${JSON.stringify({ ...asset, apple: {
      appSubmissionId: delivery.appAcceptance.id, dmgSubmissionId: delivery.dmgAcceptance.id,
      status: 'Accepted', codesign: 'PASS', appStaple: 'PASS', dmgStaple: 'PASS', gatekeeper: 'PASS' },
      provenance: { type: 'github-hosted', workflowSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT }, cleanOS: 'NOT_TESTED', physicalHardware: 'NOT_TESTED' }, null, 2)}\n`, { flag: 'wx' });
    return;
  }
  if (operation === 'combine') {
    const [incoming, output, releaseLabel] = args;
    if (!LABEL.test(releaseLabel || '')) throw new Error('Invalid release label');
    fs.mkdirSync(output, { recursive: false });
    const assets = [];
    for (const variant of ['manual', 'tracking']) {
      const dir = path.join(incoming, `fps-${variant}`);
      const asset = publicAsset(JSON.parse(fs.readFileSync(path.join(dir, 'asset.json'), 'utf8')), variant, releaseLabel);
      const source = path.join(dir, asset.name);
      const actual = evidence(source);
      if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) throw new Error('Uploaded artifact bytes differ from receipt');
      fs.copyFileSync(source, path.join(output, asset.name), fs.constants.COPYFILE_EXCL);
      assets.push(asset);
    }
    if (new Set(assets.map(asset => asset.name)).size !== 2) throw new Error('Duplicate asset names');
    if (assets[0].provenance.workflowSha !== assets[1].provenance.workflowSha ||
        assets[0].provenance.runId !== assets[1].provenance.runId ||
        assets[0].provenance.runAttempt !== assets[1].provenance.runAttempt) throw new Error('Builds have different workflow provenance');
    fs.writeFileSync(path.join(output, 'release-manifest.json'), `${JSON.stringify({ schema: 1, tag: `electron-${releaseLabel}`,
      appVersion: '0.1.0', assets, cleanOS: 'NOT_TESTED', physicalHardware: 'NOT_TESTED',
      trackingAccuracy: 'NOT_TESTED' }, null, 2)}\n`, { flag: 'wx' });
    fs.writeFileSync(path.join(output, 'SHA256SUMS'), assets.map(asset => `${asset.sha256}  ${asset.name}`).join('\n') + '\n', { flag: 'wx' });
    return;
  }
  if (operation === 'verify') {
    const [manifestFile, downloads] = args;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.assets?.length !== 2 || !LABEL.test(manifest.tag?.slice(9) || '') ||
        manifest.tag !== `electron-${manifest.assets[0].releaseLabel}`) throw new Error('Release manifest must contain both variants');
    for (const [index, variant] of ['manual', 'tracking'].entries()) {
      const asset = publicAsset(manifest.assets[index], variant, manifest.assets[0].releaseLabel);
      const actual = evidence(path.join(downloads, asset.name));
      if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) throw new Error('Public download differs from published receipt');
    }
    return;
  }
  throw new Error('Usage: electron-release.cjs plan|receipt|combine|verify');
}

if (require.main === module) { try { cli(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { validateReleaseInputs, collectReleaseAssets, assertDelivery, cli };
