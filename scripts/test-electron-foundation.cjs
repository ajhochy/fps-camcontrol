// Regression: a system-Node load or an unpackaged probe must never satisfy F2a.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
assert.equal(pkg.license, 'MIT', 'F0: main license metadata integrated');
for (const file of ['LICENSE','docs/ai/plans/2026-09-30-electron-wrapper.md']) {
  assert.equal(fs.readFileSync(path.join(root,file),'utf8'),execFileSync('git',['show',`c9098d8:${file}`],{cwd:root,encoding:'utf8'}));
}
const baseline = JSON.parse(execFileSync('git',['show','HEAD:package.json'],{cwd:root,encoding:'utf8'}));
for (const [name,command] of Object.entries(baseline.scripts)) assert.equal(pkg.scripts[name],command);
assert.ok(fs.existsSync(path.join(root,'docs/ai/decisions/2026-09-30-electron-foundation.md')));
for (const name of ['electron', '@electron/rebuild', 'electron-builder']) {
  assert.match(pkg.devDependencies[name] || '', /^\d+\.\d+\.\d+$/, `F2a: exact ${name} pin`);
}
assert.match(fs.readFileSync(path.join(root, '.npmrc'), 'utf8'), /node-linker=hoisted/);
// Regression: advertising macOS 12 when packaged Electron and HID require 13.
assert.equal(require('../electron-builder.probe.cjs').mac.minimumSystemVersion, '13.0');
for (const name of ['sandbox', 'sandbox:check', 'test:smoke:isolated']) assert.ok(pkg.scripts[name]);
const latest = path.join(root,'dist/electron-probe/last-run.json');
const evidencePath = process.argv[2] || (fs.existsSync(latest) ? JSON.parse(fs.readFileSync(latest)).evidence : null);
assert.ok(evidencePath, 'F2a: provide evidence produced by actual packaged app');
const e = JSON.parse(fs.readFileSync(evidencePath));
assert.equal(e.packaged, true);
assert.equal(e.arch, 'arm64');
assert.equal(e.utility.hidLoaded, true);
assert.equal(e.utility.enumerated, true);
assert.equal(e.utility.openedDevices, 0);
assert.ok(e.utility.nativePaths.length > 0);
assert.ok(e.utility.nativePaths.every(p => p.startsWith('node_modules/node-hid/') && p.endsWith('.node')));
assert.equal(e.utility.abi, e.abi);
assert.equal(e.utility.electron, pkg.devDependencies.electron);
assert.equal(e.renderer.sandboxed, true);
assert.equal(e.renderer.nodeIntegration, false);
assert.equal(e.renderer.contextIsolation, true);
assert.equal(e.renderer.requireType, 'undefined');
assert.equal(e.renderer.processType, 'undefined');
assert.equal(e.utility.timing.missed150, 0);
assert.equal(e.utility.timing.missed250, 0);
for (const key of ['p50', 'p95', 'p99', 'max']) assert.ok(Number.isFinite(e.utility.timing[key]));
assert.ok(e.utility.timing.durationMs >= 1800000, 'F2a: real 30-minute idle attempt');
assert.equal(e.utility.timing.max < 150, true);
assert.equal(e.quitChildExited, true);
assert.equal(e.hermetic.emptyHome, true);
assert.equal(e.hermetic.minimalPath, '/usr/bin:/bin');
assert.equal(e.hermetic.randomCwd, true);
assert.equal(e.hermetic.fromDmg, true);
assert.equal(e.hermetic.ownedUtilityExited, true);
assert.equal(e.crash.signal, 'SIGKILL');
assert.equal(e.crash.ownedUtilityExited, true);
console.log('foundation-electron-v1: packaged feasibility assertions PASS (not whole foundation)');
