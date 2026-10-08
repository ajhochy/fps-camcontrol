'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fileEvidence, inspectApp } = require('./electron-signing-support.cjs');
const manifest = require('./tracking-runtime-manifest.json');
const root = path.resolve(__dirname, '..');
const app = process.env.FPS_TRACKING_APP || path.join(root, 'release/tracking/mac-arm64/FPS CamControl Tracking.app');
async function main() {
  const inspection = await inspectApp(app, 'tracking');
  assert.equal(inspection.minimumMacOS, '14.0');
  const resources = path.join(app, 'Contents/Resources');
  for (const file of ['backend/dist/index.js', 'backend/dist/embed.js', 'backend/dist/tracking/sidecarProcess.js',
    'backend/node_modules/node-hid/build/Release/HID.node', 'backend/ui/rigs/rigs.js', 'backend/docs/sony-sidecar-setup.md', 'backend/docs/tracking.md', 'backend/docs/electron.md',
    'python/bin/python3', 'tracker-sidecar/main.py', 'notices/python/PYTHON.json', 'notices/python/licenses/LICENSE.openssl-3.txt',
    'notices/coloredlogs-15.0.1/LICENSE.txt', 'notices/humanfriendly-10.0/LICENSE.txt', 'notices/flatbuffers-LICENSE.txt', 'notices/yolox-LICENSE.txt',
    'runtime-manifest.json', 'THIRD-PARTY-NOTICES.txt']) assert.ok(fs.existsSync(path.join(resources, file)), `Missing tracking resource: ${file}`);
  const staged = JSON.parse(fs.readFileSync(path.join(resources, 'runtime-manifest.json')));
  assert.deepEqual(staged, manifest, 'The pinned manifest shipped, not a host resolver result');
  const model = manifest.assets.find(asset => asset.name === 'yolox-s');
  assert.equal(fileEvidence(path.join(resources, 'models', model.filename)).sha256, model.sha256);
  const site = path.join(resources, 'python/lib/python3.12/site-packages');
  assert.ok(!fs.existsSync(path.join(site, 'numpy/.dylibs')), 'NumPy must use system Accelerate, not excluded compiler runtimes');
  for (const name of ['onnxruntime', 'numpy', 'PIL', 'websockets', 'sympy']) assert.ok(fs.existsSync(path.join(site, name)));
  const asar = require('@electron/asar');
  const entries = asar.listPackage(path.join(resources, 'app.asar'));
  assert.ok(entries.includes('/electron/tracking/main.cjs'));
  assert.ok(!entries.some(name => /(?:python|\.onnx|tracker-sidecar)/i.test(name)), 'Executable runtime/model must stay outside ASAR');
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.ok(!/(?:CameraWebApp|SonySDK)/i.test(entry.name), 'No Sony redistributable payload');
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
    }
  }
  walk(resources);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  console.log(`PASS tracking package: correct identity, macOS14, ${inspection.native.length} signed arm64 Mach-O files, model hash, runtime/notices outside ASAR`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
