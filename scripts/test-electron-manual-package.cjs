// Regression: a native probe (or no artifact) must never count as the shipping app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const app = process.env.FPS_MANUAL_APP || path.join(root, 'release/manual/mac-arm64/FPS CamControl.app');
const plist = path.join(app, 'Contents/Info.plist');
assert.ok(fs.existsSync(plist), 'c1: actual full manual ARM64 .app must exist; probe is not a deliverable');
const readPlist = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
assert.equal(readPlist('CFBundleIdentifier'), 'com.ajhochhalter.fpscamcontrol', 'c1: shipping identity');
assert.equal(readPlist('LSMinimumSystemVersion'), '13.0', 'c1: minimum macOS');
assert.match(readPlist('NSLocalNetworkUsageDescription'), /configured cameras.*ATEM.*local network/, 'c1: truthful local-network privacy purpose');
assert.equal(execFileSync('/usr/bin/lipo', ['-archs', path.join(app, 'Contents/MacOS/FPS CamControl')], { encoding: 'utf8' }).trim(), 'arm64', 'c1: actual executable architecture');
assert.ok(fs.existsSync(path.join(root, 'release/manual/FPS CamControl-manual-0.1.0-arm64.dmg')), 'c1: actual DMG required');
const resources = path.join(app, 'Contents/Resources');
for (const file of ['backend/dist/index.js', 'backend/dist/embed.js', 'backend/node_modules/yaml/package.json', 'backend/node_modules/node-hid/build/Release/HID.node', 'backend/ui/rigs/rigs.js', 'backend/docs/sony-sidecar-setup.md']) {
  assert.ok(fs.existsSync(path.join(resources, file)), `c2: existing app resource missing: ${file}`);
}
assert.ok(fs.existsSync(path.join(resources, 'backend/controller-profiles')), 'c2: controller definitions required');
assert.ok(fs.existsSync(path.join(resources, 'THIRD-PARTY-NOTICES.txt')), 'c2: bundled legal notices required');
const forbidden = /(?:probe|tracker|python|CameraWebApp|SonySDK)/i;
function inspect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    assert.ok(!forbidden.test(entry.name), `c3: forbidden shipping payload: ${entry.name}`);
    if (entry.isDirectory()) inspect(path.join(dir, entry.name));
  }
}
inspect(resources);
for (const entry of require('@electron/asar').listPackage(path.join(resources, 'app.asar'))) {
  assert.ok(!forbidden.test(entry), `c3: forbidden ASAR payload: ${entry}`);
}
console.log('PASS c1–c3: full manual artifact identity, resources, and exclusions');
