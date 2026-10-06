const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
if (process.arch !== 'arm64' || process.platform !== 'darwin') throw new Error('Manual packaging requires the owned Apple Silicon build host');
if (!fs.realpathSync(path.join(root, 'node_modules')).startsWith(root + path.sep)) throw new Error('Build dependencies must belong to this worktree');
// A standalone project prevents electron-builder from walking up into this
// checkout and silently packaging its system-Node addons and foreign prebuilds.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-electron-manual-stage-'));
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
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'electron/manual/main.cjs', license: pkg.license, author: pkg.author, description: pkg.description, dependencies: {} }));
fs.mkdirSync(path.join(stage, 'electron/manual'), { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'status.html', 'production-lock.cjs']) fs.copyFileSync(path.join(root, 'electron', name), path.join(stage, 'electron', name));
for (const name of ['main.cjs', 'backend.cjs', 'setup.html', 'setup.js']) fs.copyFileSync(path.join(root, 'electron/manual', name), path.join(stage, 'electron/manual', name));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
const backend = path.join(stage, 'backend');
fs.mkdirSync(backend);
fs.mkdirSync(path.join(backend, 'dist'));
fs.mkdirSync(path.join(backend, 'electron'));
fs.copyFileSync(path.join(root, 'electron/sony-guardian.cjs'), path.join(backend, 'electron/sony-guardian.cjs'));
fs.copyFileSync(path.join(root, 'electron/production-lock.cjs'), path.join(backend, 'electron/production-lock.cjs'));
for (const name of ['index.js', 'embed.js', 'app', 'atem', 'config', 'devices', 'input', 'model', 'safety', 'sony', 'ui', 'visca']) {
  fs.cpSync(path.join(root, 'dist', name), path.join(backend, 'dist', name), { recursive: true });
}
for (const name of ['ui', 'controller-profiles']) fs.cpSync(path.join(root, name), path.join(backend, name), { recursive: true });
fs.mkdirSync(path.join(backend, 'docs'));
fs.copyFileSync(path.join(root, 'docs/sony-sidecar-setup.md'), path.join(backend, 'docs/sony-sidecar-setup.md'));
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
fs.writeFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), notices);
const env = { ...process.env, FPS_MANUAL_STAGE: stage, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
const builder = path.join(root, 'node_modules/.bin/electron-builder');
const previousOutput = path.join(root, 'release/manual');
if (fs.existsSync(previousOutput)) fs.renameSync(previousOutput, path.join(root, 'release', 'manual-prior-' + new Date().toISOString().replace(/[:.]/g, '-')));
run(builder, ['--projectDir', stage, '--config', path.join(root, 'electron-builder.manual.cjs'), '--mac', '--arm64', '--dir', '--publish', 'never'], { env });
run(process.execPath, [path.join(root, 'scripts/sign-electron-manual.cjs'), '--sign-only'], { env });
run(builder, ['--projectDir', stage, '--config', path.join(root, 'electron-builder.manual.cjs'), '--mac', 'dmg', '--arm64', '--prepackaged', path.join(root, 'release/manual/mac-arm64/FPS CamControl.app'), '--publish', 'never'], { env });
run(process.execPath, [path.join(root, 'scripts/test-electron-manual-package.cjs')]);
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
fs.writeFileSync(path.join(root, 'release/manual/build-provenance.json'), JSON.stringify({
  ...source,
  packagedAt: new Date().toISOString(),
  appAsarSha256: hash(path.join(root, 'release/manual/mac-arm64/FPS CamControl.app/Contents/Resources/app.asar')),
  packageJsonSha256: hash(path.join(root, 'package.json')), lockSha256: hash(path.join(root, 'pnpm-lock.yaml')),
  backendTreeSha256: treeHash(path.join(root, 'release/manual/mac-arm64/FPS CamControl.app/Contents/Resources/backend')),
  defaultsTreeSha256: treeHash(path.join(root, 'resources/defaults')),
}, null, 2));
