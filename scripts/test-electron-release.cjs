'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { assertDelivery, cli, collectReleaseAssets } = require('./electron-release.cjs');
const pins = require('../.github/electron-release-sources.json');

function fixture(variant, root) {
  const dmg = path.join(root, `${variant}.dmg`);
  fs.writeFileSync(dmg, `${variant} signed DMG fixture`);
  const bytes = fs.statSync(dmg).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex');
  return { variant, sourceCommit: pins[variant], sourceDirty: false, version: '0.1.0',
    architecture: 'arm64', appId: `com.ajhochhalter.fpscamcontrol${variant === 'tracking' ? '.tracking' : ''}`,
    minimumMacOS: variant === 'manual' ? '13.0' : '14.0',
    appAcceptance: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', status: 'Accepted' },
    dmgAcceptance: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', status: 'Accepted' },
    codesign: 'PASS', appStaple: 'PASS', dmgStaple: 'PASS', gatekeeper: 'PASS',
    dmg: { path: dmg, bytes, sha256 } };
}

test('accepted final receipt requires exact bytes and all Apple gates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-release-test-'));
  try {
    const valid = fixture('manual', root);
    assert.doesNotThrow(() => assertDelivery(valid, 'manual', pins.manual));
    for (const change of [
      { dmgAcceptance: { ...valid.dmgAcceptance, status: 'In Progress' } },
      { appAcceptance: { ...valid.appAcceptance, id: '' } },
      { sourceDirty: true },
      { sourceCommit: pins.tracking },
      { gatekeeper: 'NOT_RUN' },
      { dmg: { ...valid.dmg, sha256: '0'.repeat(64) } },
      { dmg: { ...valid.dmg, bytes: valid.dmg.bytes + 1 } },
    ]) assert.throws(() => assertDelivery({ ...valid, ...change }, 'manual', pins.manual));
    fs.appendFileSync(valid.dmg.path, 'tampered');
    assert.throws(() => assertDelivery(valid, 'manual', pins.manual), /differs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manual dispatch cannot silently publish with missing qualification input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-release-plan-'));
  try {
    const output = path.join(root, 'output');
    const dispatch = { GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_VERSION: 'testing-2026.10.01', GITHUB_OUTPUT: output };
    assert.throws(() => cli(['plan'], dispatch), /qualification_only/);
    assert.throws(() => cli(['plan'], { ...dispatch, QUALIFICATION_ONLY: 'garbage' }), /qualification_only/);
    cli(['plan'], { ...dispatch, QUALIFICATION_ONLY: 'true' });
    assert.match(fs.readFileSync(output, 'utf8'), /qualification_only=true/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('two real fixture receipts combine and reject altered upload or duplicate variant', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-release-test-'));
  try {
    const incoming = path.join(root, 'incoming');
    fs.mkdirSync(incoming);
    for (const variant of ['manual', 'tracking']) {
      const delivery = fixture(variant, root);
      const receipt = path.join(root, `${variant}.json`);
      fs.writeFileSync(receipt, JSON.stringify(delivery));
      cli(['receipt', receipt, variant, pins[variant], 'testing-2026.10.01', path.join(incoming, `fps-${variant}`)],
        { GITHUB_SHA: pins.tracking, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' });
    }
    const publicDir = path.join(root, 'public');
    cli(['combine', incoming, publicDir, 'testing-2026.10.01']);
    const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'release-manifest.json')));
    assert.equal(manifest.assets.length, 2);
    assert.doesNotMatch(JSON.stringify(manifest), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(manifest.assets[0].sourceSha, pins.manual);
    assert.equal(manifest.assets[1].sourceSha, pins.tracking);
    cli(['verify', path.join(publicDir, 'release-manifest.json'), publicDir]);
    const duplicate = { variant: 'manual', path: path.join(publicDir, manifest.assets[0].name),
      sourceSha: pins.manual, releaseLabel: 'testing-2026.10.01', appVersion: '0.1.0', minimumOs: '13.0' };
    assert.throws(() => collectReleaseAssets([duplicate, duplicate]), /Duplicate/);
    fs.appendFileSync(path.join(incoming, 'fps-tracking', manifest.assets[1].name), 'tampered');
    assert.throws(() => cli(['combine', incoming, path.join(root, 'second'), 'testing-2026.10.01']), /differ/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
