// Serial checks: the existing sandbox owns fixed loopback ports.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const level = process.argv[2] || 'issue';
if (!['issue', 'smoke', 'pr'].includes(level)) throw new Error('Expected issue, smoke, or pr');
const env = { ...process.env, CAMCONTROL_NO_CONTROLLER: '1' };
// Never inherit an installed app's state/resource overrides into repository tests.
for (const key of ['CAMCONTROL_HOME', 'CAMCONTROL_RESOURCES', 'CAMCONTROL_EMBEDDED', 'CAMCONTROL_SESSION',
  'DEVICES_CONFIG', 'MAPPINGS_FILE', 'SPEEDS_FILE', 'PRESETS_FILE', 'SONY_STATE_FILE', 'SONY_SERVER_EXECUTABLE']) delete env[key];
for (const key of ['TRACKING_ENABLED', 'TRACKING_SIDECAR_URL', 'TRACKING_ALLOW_REMOTE', 'TRACKER_WS_TOKEN', 'TRACKER_FRAME_TOKEN', 'CAMCONTROL_TRACKING_AVAILABLE']) delete env[key];
function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
run('pnpm', ['build']);
run(process.execPath, ['scripts/check-page-js.cjs']);
if (level !== 'smoke') {
  for (const name of ['rigSchemaTest', 'rigsTest', 'rigEditTest', 'rigsUiModelTest',
    'workingProfileTest', 'sonyConfigStoreTest', 'sonyManagerTest']) {
    run(process.execPath, [`dist/testing/${name}.js`]);
  }
  const files = directory => fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name))
      : /\.(?:spec|test)\.(?:ts|cjs|js)$/.test(entry.name) ? [path.join(directory, entry.name)] : []) : [];
  const focused = files(path.join(root, 'tests')).sort();
  if (focused.length) run(process.execPath, ['--test', '--test-concurrency=1', '-r', 'ts-node/register/transpile-only', ...focused]);
  run(process.execPath, ['--test', 'scripts/test-electron-release.cjs']);
  run('python3', ['-m', 'unittest', 'discover', '-s', 'pi-bridge/tests', '-v']);
  run(process.execPath, ['scripts/check-tracking.cjs']);
}
run(process.execPath, ['dist/testing/sandbox/sandbox.js', '--smoke']);
if (level !== 'issue') run(process.execPath, ['dist/testing/sandbox/sandbox.js', '--selftest']);
run('git', ['diff', '--check']);
console.log(`PASS ${level} repository checks. Packaged DMG tests and Apple notarization are separate gates.`);
