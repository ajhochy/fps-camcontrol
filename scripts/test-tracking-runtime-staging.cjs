'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyAsset, safeMembers, acquire, manifest } = require('./stage-tracking-runtime.cjs');
test('exact runtime manifest pins NumPy14 and verified model, with all license sources', () => {
  assert.equal(manifest.assets.length, 13);
  assert.equal(manifest.minimumMacOS, '14.0');
  assert.match(manifest.assets.find(a => a.name === 'numpy').filename, /macosx_14_0_arm64/);
  assert.equal(manifest.notices.length, 6);
  for (const asset of [...manifest.assets, ...manifest.notices]) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/); assert.ok(asset.size > 0); assert.match(asset.url, /^https:\/\//);
  }
});
test('corrupt or symlinked asset is refused; offline mode does not fetch', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-tracking-stage-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const asset = { filename: 'model.onnx', size: 5, sha256: crypto.createHash('sha256').update('valid').digest('hex') };
  const file = path.join(directory, asset.filename);
  assert.throws(() => acquire(asset, directory, false), /Offline cache missing/);
  fs.writeFileSync(file, 'wrong'); assert.throws(() => verifyAsset(file, asset), /checksum mismatch/);
  fs.writeFileSync(file, 'valid'); assert.equal(verifyAsset(file, asset).bytes, 5);
  const link = path.join(directory, 'link'); fs.symlinkSync(file, link); assert.throws(() => verifyAsset(link, asset), /regular/);
});
test('wheel data permits audited SymPy manpage, never traversal or arbitrary executable layouts', () => {
  assert.deepEqual(safeMembers('sympy-1.14.0.data/data/share/man/man1/isympy.1\n', true), ['sympy-1.14.0.data/data/share/man/man1/isympy.1']);
  for (const entry of ['/outside', 'a/../outside', 'a\\outside', 'evil.data/scripts/startup']) assert.throws(() => safeMembers(entry, true));
});
