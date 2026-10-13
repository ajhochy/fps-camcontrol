'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const TEAM_ID = '56Q69NYP9H';
// Existing FPS probe/manual builds use this certificate; validate it against the
// currently valid Keychain identities before every use. Rotation is explicit.
const DEFAULT_IDENTITY = 'CF6C1EF1525E70E6E3324388A322938977779DB7';
const VARIANTS = Object.freeze({
  manual: { name: 'FPS CamControl', id: 'com.ajhochhalter.fpscamcontrol' },
  tracking: { name: 'FPS CamControl Tracking', id: 'com.ajhochhalter.fpscamcontrol.tracking' },
});
const APPLE_KEYS = new Set(['APPLE_SIGNING_IDENTITY', 'APPLE_TEAM_ID', 'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID_PASSWORD', 'APPLE_NOTARY_PROFILE', 'APPLE_NOTARY_KEYCHAIN']);
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

class SafeError extends Error {}

function resolveIdentity(requested, output) {
  const identities = new Map();
  for (const match of String(output).matchAll(/^\s*\d+\)\s+([a-f0-9]{40})\s+"([^"\n]+)"/gim)) {
    if (match[2].startsWith('Developer ID Application: ') && match[2].endsWith(`(${TEAM_ID})`)) {
      identities.set(match[1].toUpperCase(), match[2]);
    }
  }
  const wanted = String(requested || DEFAULT_IDENTITY).trim();
  if (/^[a-f0-9]{40}$/i.test(wanted)) {
    if (!identities.has(wanted.toUpperCase())) throw new SafeError('Selected Developer ID fingerprint is not currently valid for the expected team');
    return wanted.toUpperCase();
  }
  const matches = [...identities].filter(([, name]) => name === wanted);
  if (!matches.length) throw new SafeError('Requested Developer ID identity is unavailable for the expected team');
  if (matches.length !== 1) throw new SafeError('Developer ID name is ambiguous; set APPLE_SIGNING_IDENTITY to a valid SHA-1 fingerprint');
  return matches[0][0];
}

// Never source a shell script or load unrelated provider credentials. Dotenv
// values are literal: expansion, substitutions and executable loaders are absent.
function readAppleEnvironment(file, env = process.env) {
  const result = {};
  if (file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SafeError('Apple credential source must be a regular file');
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || !APPLE_KEYS.has(match[1])) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '').trim();
      if (/\r|\n|\0/.test(value)) throw new SafeError('Apple credential contains an unsupported control character');
      result[match[1]] = value;
    }
  }
  for (const name of APPLE_KEYS) if (env[name]?.trim()) result[name] = env[name].trim();
  result.APPLE_APP_SPECIFIC_PASSWORD ||= result.APPLE_ID_PASSWORD;
  for (const value of Object.values(result)) if (/\r|\n|\0/.test(value)) throw new SafeError('Apple credential contains an unsupported control character');
  return result;
}

function notaryAuth(env) {
  if (env.APPLE_TEAM_ID && env.APPLE_TEAM_ID !== TEAM_ID) throw new SafeError('Unexpected Apple team');
  if (env.APPLE_NOTARY_PROFILE) {
    const args = ['--keychain-profile', env.APPLE_NOTARY_PROFILE];
    if (env.APPLE_NOTARY_KEYCHAIN) args.push('--keychain', env.APPLE_NOTARY_KEYCHAIN);
    return { args, input: undefined, mode: 'keychain-profile' };
  }
  if (!env.APPLE_ID || !env.APPLE_APP_SPECIFIC_PASSWORD || !env.APPLE_TEAM_ID) {
    throw new SafeError('Notarization needs an existing APPLE_NOTARY_PROFILE or Apple ID/team/app-specific password; no credentials were modified');
  }
  // notarytool's secure prompt reads stdin when --password is omitted. Keep
  // passwords out of argv/process listings, child environment, diagnostics/logs.
  return { args: ['--apple-id', env.APPLE_ID, '--team-id', env.APPLE_TEAM_ID],
    input: `${env.APPLE_APP_SPECIFIC_PASSWORD}\n`, mode: 'apple-id-secure-stdin' };
}

function run(command, args, { input, timeout = 120000, label = path.basename(command) } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8' };
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    let stdout = '', stderr = '', size = 0;
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new SafeError(`${label} timed out; private diagnostics suppressed`)); }, timeout);
    const collect = (name, buffer) => {
      size += buffer.length;
      if (size > 16 * 1024 * 1024) { child.kill('SIGTERM'); return; }
      if (name === 'stdout') stdout += buffer; else stderr += buffer;
    };
    child.stdout.on('data', buffer => collect('stdout', buffer));
    child.stderr.on('data', buffer => collect('stderr', buffer));
    child.on('error', () => { clearTimeout(timer); reject(new SafeError(`${label} could not start; private diagnostics suppressed`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || size > 16 * 1024 * 1024) {
        const agreement = label.startsWith('Apple notary') && /HTTP status code:\s*403/.test(stderr + stdout) && /required agreement is missing or has expired/.test(stderr + stdout);
        reject(new SafeError(agreement
          ? 'Apple notary HTTP 403: a required Apple Developer agreement is missing or expired; the account holder must resolve it'
          : `${label} failed; private diagnostics suppressed`));
      }
      else resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function notaryRequest(action, artifactOrId, auth, runner = run) {
  const args = ['notarytool', action];
  if (artifactOrId) args.push(artifactOrId);
  args.push(...auth.args, '--output-format', 'json');
  const result = await runner('/usr/bin/xcrun', args, { input: auth.input, timeout: action === 'submit' ? 900000 : 60000, label: `Apple notary ${action}` });
  try {
    // A secure prompt can precede the JSON on stdout; never forward it.
    const start = result.stdout.indexOf('{');
    return JSON.parse(result.stdout.slice(start));
  } catch { throw new SafeError(`Apple notary ${action} returned invalid structured output`); }
}

function isMachO(file) {
  const fd = fs.openSync(file, 'r');
  try { const bytes = Buffer.alloc(4); return fs.readSync(fd, bytes, 0, 4, 0) === 4 && MACHO_MAGIC.has(bytes.readUInt32BE()); }
  finally { fs.closeSync(fd); }
}

function signingTargets(root) {
  const targets = [];
  const canonicalRoot = fs.realpathSync(root);
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(file);
        if (resolved !== canonicalRoot && !resolved.startsWith(canonicalRoot + path.sep)) throw new SafeError('Packaged symbolic link escapes its Contents directory');
        continue;
      }
      if (entry.isDirectory()) {
        walk(file);
        if (/\.(app|framework|xpc|bundle)$/.test(entry.name)) targets.push(file);
      } else if (entry.isFile() && isMachO(file)) targets.push(file);
    }
  }
  walk(root);
  return targets.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b));
}

function needsJit(target, app) {
  // Electron/V8 processes alone need MAP_JIT. Python, native addons, dylibs,
  // crashpad and ShipIt receive hardened runtime without Electron entitlements.
  return target === app || (target.endsWith('.app') && target.startsWith(path.join(app, 'Contents/Frameworks') + path.sep));
}

function fileEvidence(file) {
  const stat = fs.statSync(file);
  const digest = crypto.createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let length;
    while ((length = fs.readSync(fd, chunk, 0, chunk.length, null))) digest.update(chunk.subarray(0, length));
  } finally { fs.closeSync(fd); }
  return { path: file, bytes: stat.size, sha256: digest.digest('hex') };
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function minimumOs(buildOutput) {
  const versions = [...String(buildOutput).matchAll(/\b(?:minos|version)\s+(\d+\.\d+(?:\.\d+)?)/g)].map(match => match[1]);
  const explicit = [...String(buildOutput).matchAll(/\bminos\s+(\d+\.\d+(?:\.\d+)?)/g)].map(match => match[1]);
  const choices = explicit.length ? explicit : versions;
  if (!choices.length) throw new SafeError('Mach-O has no inspectable minimum macOS version');
  return choices.sort(compareVersions).at(-1);
}

async function inspectApp(app, variant, runner = run) {
  if (!VARIANTS[variant]) throw new SafeError('Variant must be manual or tracking');
  if (!path.isAbsolute(app) || !app.endsWith('.app') || !fs.existsSync(app) || !fs.lstatSync(app).isDirectory() || fs.lstatSync(app).isSymbolicLink()) {
    throw new SafeError('App must be an explicit existing .app directory, not a symbolic link');
  }
  const plist = path.join(app, 'Contents/Info.plist');
  const value = async key => (await runner('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { label: 'App metadata inspection' })).stdout.trim();
  const id = await value('CFBundleIdentifier');
  if (id !== VARIANTS[variant].id) throw new SafeError('App bundle identity does not match the selected FPS variant');
  const version = await value('CFBundleShortVersionString');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/.test(version)) throw new SafeError('App version contains unsafe filename characters');
  const minOs = await value('LSMinimumSystemVersion');
  if (!/^\d+(?:\.\d+){1,2}$/.test(minOs)) throw new SafeError('App minimum macOS metadata is invalid');
  const targets = signingTargets(path.join(app, 'Contents'));
  const native = [];
  for (const file of targets.filter(target => fs.statSync(target).isFile())) {
    const arch = (await runner('/usr/bin/lipo', ['-archs', file], { label: 'Mach-O architecture inspection' })).stdout.trim().split(/\s+/);
    if (!arch.includes('arm64')) throw new SafeError(`Packaged binary lacks arm64: ${path.relative(app, file)}`);
    const build = await runner('/usr/bin/xcrun', ['vtool', '-show-build', '-arch', 'arm64', file], { label: 'Mach-O minimum OS inspection' });
    const required = minimumOs(build.stdout);
    if (compareVersions(required, minOs) > 0) throw new SafeError(`Packaged binary requires macOS ${required}, above advertised ${minOs}: ${path.relative(app, file)}`);
    native.push({ path: path.relative(app, file), architectures: arch, minimumMacOS: required });
  }
  if (!native.length) throw new SafeError('Packaged app has no Mach-O executables');
  return { appId: id, version, architecture: 'arm64', minimumMacOS: minOs,
    highestBinaryMinimumMacOS: native.map(item => item.minimumMacOS).sort(compareVersions).at(-1), targets, native };
}

module.exports = { TEAM_ID, DEFAULT_IDENTITY, VARIANTS, SafeError, resolveIdentity,
  readAppleEnvironment, notaryAuth, run, notaryRequest, isMachO, signingTargets, needsJit, fileEvidence,
  compareVersions, minimumOs, inspectApp };
