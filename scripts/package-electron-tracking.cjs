const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { stageRuntime } = require('./stage-tracking-runtime.cjs');
const pkg = require('../package.json');
if (process.arch !== 'arm64' || process.platform !== 'darwin') throw new Error('Tracking packaging requires the owned Apple Silicon build host');
if (!fs.realpathSync(path.join(root, 'node_modules')).startsWith(root + path.sep)) throw new Error('Build dependencies must belong to this worktree');
// A standalone project prevents electron-builder from walking up into this
// checkout and silently packaging its system-Node addons and foreign prebuilds.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-electron-tracking-stage-'));
const install = path.join(stage, 'runtime-install');
fs.mkdirSync(install, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
const git = args => run('git', args, { stdio: 'pipe', encoding: 'utf8' }).trim();
const source = {
  sourceCommit: git(['rev-parse', 'HEAD']), sourceBranch: git(['branch', '--show-current']),
  sourceDirty: git(['status', '--porcelain']).length > 0,
  trackedChanges: git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean),
  untrackedPaths: git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean),
};
run(path.join(root, 'node_modules/.bin/tsc'), []);
fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ ...pkg, scripts: {} }, null, 2));
for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) fs.copyFileSync(path.join(root, name), path.join(install, name));
// ponytail: frozen production install + dedicated Electron rebuild, never touch Node/Rhythm addons.
run('pnpm', ['install', '--prod', '--ignore-scripts', '--frozen-lockfile'], { cwd: install });
run(path.join(root, 'node_modules/.bin/electron-rebuild'), ['--force', '--version', pkg.devDependencies.electron,
  '--arch', 'arm64', '--module-dir', install, '--only', 'node-hid,@julusian/freetype2']);
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name + '-tracking', version: pkg.version, main: 'electron/tracking/main.cjs', license: pkg.license, author: pkg.author, description: pkg.description, dependencies: {} }));
fs.mkdirSync(path.join(stage, 'electron/manual'), { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'status.html', 'production-lock.cjs']) fs.copyFileSync(path.join(root, 'electron', name), path.join(stage, 'electron', name));
for (const name of ['main.cjs', 'backend.cjs', 'setup.html', 'setup.js']) fs.copyFileSync(path.join(root, 'electron/manual', name), path.join(stage, 'electron/manual', name));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.mkdirSync(path.join(stage, 'electron/tracking'));
fs.copyFileSync(path.join(root, 'electron/tracking/main.cjs'), path.join(stage, 'electron/tracking/main.cjs'));
const trackingRuntime = path.join(stage, 'tracking-runtime');
stageRuntime({ target: trackingRuntime, download: process.argv.includes('--download') });
fs.cpSync(path.join(root, 'tracker-sidecar'), path.join(stage, 'tracker-sidecar'), { recursive: true,
  filter: file => !/(?:^|\/)(?:tests|__pycache__|\.venv)(?:\/|$)|\.pyc$/.test(file) });
const backend = path.join(stage, 'backend');
fs.mkdirSync(backend);
fs.mkdirSync(path.join(backend, 'dist'));
fs.mkdirSync(path.join(backend, 'electron'));
fs.copyFileSync(path.join(root, 'electron/sony-guardian.cjs'), path.join(backend, 'electron/sony-guardian.cjs'));
fs.copyFileSync(path.join(root, 'electron/production-lock.cjs'), path.join(backend, 'electron/production-lock.cjs'));
for (const name of ['index.js', 'embed.js', 'app', 'atem', 'config', 'devices', 'input', 'model', 'safety', 'sony', 'tracking', 'ui', 'visca']) {
  fs.cpSync(path.join(root, 'dist', name), path.join(backend, 'dist', name), { recursive: true });
}
for (const name of ['ui', 'controller-profiles']) fs.cpSync(path.join(root, name), path.join(backend, name), { recursive: true });
fs.mkdirSync(path.join(backend, 'docs'));
for (const name of ['sony-sidecar-setup.md', 'tracking.md', 'electron.md']) fs.copyFileSync(path.join(root, 'docs', name), path.join(backend, 'docs', name));
const excluded = /\/(?:test|tests|example|examples|benchmark|benchmarks|prebuilds|obj\.target|node_gyp_bins|\.deps|\.pnpm)(?:\/|$)|\.py$/;
fs.cpSync(path.join(install, 'node_modules'), path.join(backend, 'node_modules'), { recursive: true, dereference: true, filter: file => !excluded.test(file) });
let notices = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8') + '\n\nElectron / Chromium notices are included in their runtime LICENSE and LICENSES.chromium.html files.\n';
function licenses(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) licenses(file);
    else if (/^(?:license|licence|copying|notice)(?:\.|$)/i.test(entry.name)) notices += `\n\n--- ${path.relative(backend, file)} ---\n${fs.readFileSync(file, 'utf8')}\n`;
  }
}
licenses(path.join(backend, 'node_modules'));
notices += '\nTracking Python/component/model notices are in Resources/notices; wheel .dist-info licenses and notices remain in the bundled site-packages. The exact runtime/model download manifest is Resources/runtime-manifest.json.\n';
fs.writeFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), notices);
const env = { ...process.env, FPS_TRACKING_STAGE: stage, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
const builder = path.join(root, 'node_modules/.bin/electron-builder');
const previousOutput = path.join(root, 'release/tracking');
if (fs.existsSync(previousOutput)) fs.renameSync(previousOutput, path.join(root, 'release', 'tracking-prior-' + new Date().toISOString().replace(/[:.]/g, '-')));
run(builder, ['--projectDir', stage, '--config', path.join(root, 'electron-builder.tracking.cjs'), '--mac', '--arm64', '--dir', '--publish', 'never'], { env });
run(process.execPath, [path.join(root, 'scripts/sign-electron-manual.cjs'), '--sign-only', '--variant', 'tracking'], { env });
run(builder, ['--projectDir', stage, '--config', path.join(root, 'electron-builder.tracking.cjs'), '--mac', 'dmg', '--arm64', '--prepackaged', path.join(root, 'release/tracking/mac-arm64/FPS CamControl Tracking.app'), '--publish', 'never'], { env });
run(process.execPath, [path.join(root, 'scripts/test-electron-tracking-package.cjs')]);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function treeHash(directory) {
  const digest = crypto.createHash('sha256');
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else digest.update(path.relative(directory, file) + '\0' + (entry.isSymbolicLink() ? fs.readlinkSync(file) : hash(file)) + '\n');
    }
  }
  visit(directory); return digest.digest('hex');
}
const packagedResources = path.join(root, 'release/tracking/mac-arm64/FPS CamControl Tracking.app/Contents/Resources');
fs.writeFileSync(path.join(root, 'release/tracking/build-provenance.json'), JSON.stringify({
  ...source,
  packagedAt: new Date().toISOString(),
  appAsarSha256: hash(path.join(packagedResources, 'app.asar')),
  packageJsonSha256: hash(path.join(root, 'package.json')), lockSha256: hash(path.join(root, 'pnpm-lock.yaml')),
  backendTreeSha256: treeHash(path.join(packagedResources, 'backend')),
  pythonTreeSha256: treeHash(path.join(packagedResources, 'python')),
  sidecarTreeSha256: treeHash(path.join(packagedResources, 'tracker-sidecar')),
  modelTreeSha256: treeHash(path.join(packagedResources, 'models')),
  noticesTreeSha256: treeHash(path.join(packagedResources, 'notices')),
  runtimeManifestSha256: hash(path.join(packagedResources, 'runtime-manifest.json')),
  defaultsTreeSha256: treeHash(path.join(root, 'resources/defaults')),
}, null, 2));
