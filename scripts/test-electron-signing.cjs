'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const support = require('./electron-signing-support.cjs');
const signer = require('./sign-electron-manual.cjs');
const artifact = require('./electron-manual-artifact-evidence.cjs');
const TEAM = support.TEAM_ID;
const NAME = `Developer ID Application: Aaron Hochhalter (${TEAM})`;
const SHA = support.DEFAULT_IDENTITY;
const OTHER = 'A'.repeat(40);
const identities = `1) ${SHA} "${NAME}"\n2) ${SHA} "${NAME}"\n3) ${OTHER} "${NAME}"`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-signing-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('identity names cannot silently select among different valid certificates', () => {
  assert.equal(support.resolveIdentity(SHA.toLowerCase(), identities), SHA);
  assert.equal(support.resolveIdentity(undefined, identities), SHA);
  assert.throws(() => support.resolveIdentity(NAME, identities), /ambiguous/);
  assert.equal(support.resolveIdentity(NAME, `1) ${SHA} "${NAME}"\n2) ${SHA} "${NAME}"`), SHA);
  assert.throws(() => support.resolveIdentity('B'.repeat(40), identities), /not currently valid/);
  assert.throws(() => support.resolveIdentity(SHA, `1) ${SHA} "Apple Development: Someone (${TEAM})"`), /not currently valid/);
});

test('credential source only loads allowlisted literal Apple values and supports existing alias', t => {
  const file = path.join(fixture(t), 'private.env');
  fs.writeFileSync(file, `APPLE_ID='developer@example.invalid'\nAPPLE_ID_PASSWORD="synthetic-password"\nAPPLE_TEAM_ID=${TEAM}\nUNRELATED_SECRET=do-not-copy\nSHELL_LOADER=$(do-not-run)\n`);
  const env = support.readAppleEnvironment(file, {});
  assert.equal(env.APPLE_APP_SPECIFIC_PASSWORD, 'synthetic-password');
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.SHELL_LOADER, undefined);
  const auth = support.notaryAuth(env);
  assert.equal(auth.mode, 'apple-id-secure-stdin');
  assert.equal(auth.input, 'synthetic-password\n');
  assert.ok(!auth.args.includes('--password'));
  assert.ok(!auth.args.includes('synthetic-password'));
  assert.throws(() => support.notaryAuth({ ...env, APPLE_TEAM_ID: 'ANOTHERTEAM' }), /Unexpected/);
  assert.deepEqual(support.notaryAuth({ APPLE_NOTARY_PROFILE: 'existing-profile' }), {
    args: ['--keychain-profile', 'existing-profile'], input: undefined, mode: 'keychain-profile',
  });
});

test('private subprocess failures never expose arguments or raw child diagnostics', async () => {
  await assert.rejects(support.run(process.execPath,
    ['-e', 'console.error("synthetic-password");process.exit(1)', 'synthetic-password'], { label: 'Private test' }),
  error => error instanceof support.SafeError && !String(error).includes('synthetic-password') && /Private test failed/.test(error.message));
  await assert.rejects(support.run(process.execPath,
    ['-e', 'console.error("HTTP status code: 403. A required agreement is missing or has expired. synthetic-password");process.exit(1)'], { label: 'Apple notary test' }),
  error => /account holder must resolve/.test(error.message) && !String(error).includes('synthetic-password'));
});

test('Mach-O discovery catches extensionless code, handles fat64, and signs inside-out', t => {
  const app = path.join(fixture(t), 'Example.app');
  const contents = path.join(app, 'Contents');
  const nested = path.join(contents, 'Frameworks', 'Example Helper.app');
  fs.mkdirSync(path.join(nested, 'Contents/MacOS'), { recursive: true });
  const executable = path.join(nested, 'Contents/MacOS/extensionless');
  fs.writeFileSync(executable, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  const fat = path.join(contents, 'fat-helper');
  fs.writeFileSync(fat, Buffer.from([0xca, 0xfe, 0xba, 0xbf]));
  fs.writeFileSync(path.join(contents, 'fake.node'), 'not native');
  fs.symlinkSync('fat-helper', path.join(contents, 'internal-link'));
  const targets = support.signingTargets(contents);
  assert.ok(targets.includes(executable));
  assert.ok(targets.includes(fat));
  assert.ok(targets.indexOf(executable) < targets.indexOf(nested));
  assert.ok(!targets.some(p => p.endsWith('fake.node')));
  fs.symlinkSync('/bin/sh', path.join(contents, 'escape'));
  assert.throws(() => support.signingTargets(contents), /escapes/);
});

test('only Electron app bundles receive JIT entitlement; Python/native helpers do not', async () => {
  const app = '/tmp/Example.app', helper = `${app}/Contents/Frameworks/Example Helper.app`;
  const targets = [`${helper}/Contents/MacOS/Example Helper`, `${app}/Contents/Resources/python/bin/python3`, `${app}/Contents/Resources/native.node`, helper];
  const calls = [];
  await signer.signApp(app, { targets }, SHA, async (command, args) => { calls.push({ command, args }); return { stdout: '', stderr: '' }; });
  for (const { args } of calls.filter(call => call.args.includes('--sign'))) {
    assert.ok(args.includes('--timestamp'));
    assert.ok(args.includes('runtime'));
    assert.equal(args.includes('--entitlements'), [helper, app].includes(args.at(-1)));
    assert.ok(!args.includes('--deep'));
  }
  assert.deepEqual(calls.at(-1).args.slice(0, 3), ['--verify', '--deep', '--strict']);
});

test('minimum OS parser ignores linker version and compares numeric versions', () => {
  assert.equal(support.minimumOs('cmd LC_BUILD_VERSION\n minos 13.0\n sdk 26.5\n tool 4\n version 23.0'), '13.0');
  assert.equal(support.minimumOs('cmd LC_VERSION_MIN_MACOSX\n version 10.15\n sdk 11.0'), '10.15');
  assert.equal(support.compareVersions('10.9', '10.15'), -1);
  assert.throws(() => support.minimumOs(''), /no inspectable/);
});

test('app inspection refuses a wrong identity, foreign binary or higher actual minimum', async t => {
  const app = path.join(fixture(t), 'Example.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/MacOS/Example'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  let arch = 'arm64', minimum = '13.0', id = support.VARIANTS.manual.id;
  const runner = async (cmd, args) => ({ stdout: cmd.endsWith('PlistBuddy') ?
    args[1].includes('CFBundleIdentifier') ? id : args[1].includes('LSMinimumSystemVersion') ? '13.0' : '0.1.0'
    : cmd.endsWith('lipo') ? arch : `minos ${minimum}`, stderr: '' });
  assert.equal((await support.inspectApp(app, 'manual', runner)).highestBinaryMinimumMacOS, '13.0');
  arch = 'x86_64'; await assert.rejects(support.inspectApp(app, 'manual', runner), /lacks arm64/);
  arch = 'arm64'; minimum = '14.0'; await assert.rejects(support.inspectApp(app, 'manual', runner), /above advertised/);
  minimum = '13.0'; id = 'com.example.other'; await assert.rejects(support.inspectApp(app, 'manual', runner), /identity does not match/);
});

test('notary Accepted is mandatory and submission/failure receipts cannot be overwritten', async t => {
  const dir = fixture(t), archive = path.join(dir, 'artifact.zip');
  fs.writeFileSync(archive, 'fixture');
  const auth = { args: ['--keychain-profile', 'fixture'] };
  await assert.rejects(signer.accepted(archive, auth, dir, 'app', {
    runner: async (_, args) => ({ stdout: JSON.stringify(args[1] === 'submit' ? { id: '11111111-1111-1111-1111-111111111111' } : { status: 'Invalid' }) }),
  }), /not reported Accepted/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'app-not-accepted.json'))).status, 'Invalid');
  assert.throws(() => signer.writeEvidence(dir, 'app-submission.json', {}), /EEXIST/);
});

test('final ZIP and DMG are built after app staple; final DMG is accepted then stapled', async t => {
  const directory = fixture(t), calls = [], app = path.join(directory, 'FPS CamControl.app');
  fs.mkdirSync(app);
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command.endsWith('ditto') && args.includes('-c')) fs.writeFileSync(args.at(-1), 'zip');
    if (command.endsWith('hdiutil')) fs.writeFileSync(args.at(-1), 'dmg');
    if (args[0] === 'notarytool') return { stdout: JSON.stringify(args[1] === 'submit' ? { id: '11111111-1111-1111-1111-111111111111' } : args[1] === 'log' ? { jobId: '11111111-1111-1111-1111-111111111111', status: 'Accepted' } : { status: 'Accepted' }) };
    return { stdout: '', stderr: '' };
  };
  const result = await signer.finalizeApp(app, { args: ['--keychain-profile', 'fixture'] }, directory, SHA, { version: '0.1.0' }, runner);
  const appStaple = calls.findIndex(c => c.args[0] === 'stapler' && c.args[1] === 'staple' && c.args[2] === app);
  const zip = calls.findIndex(c => c.args.at(-1) === result.zip.path);
  const dmg = calls.findIndex(c => c.command.endsWith('hdiutil'));
  assert.ok(appStaple < zip && zip < dmg);
  assert.equal(result.appAcceptance.status, 'Accepted');
  assert.equal(result.dmgAcceptance.status, 'Accepted');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'app-notary-log.json'))).jobId, result.appAcceptance.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'dmg-notary-log.json'))).jobId, result.dmgAcceptance.id);
  assert.ok(calls.some(c => c.command.endsWith('spctl') && c.args.includes('context:primary-signature')));
});

test('Accepted receipt is not enough when completed Apple log belongs to another submission', async t => {
  const dir = fixture(t), archive = path.join(dir, 'artifact.zip');
  fs.writeFileSync(archive, 'fixture');
  await assert.rejects(signer.accepted(archive, { args: ['--keychain-profile', 'fixture'] }, dir, 'app', {
    runner: async (_, args) => ({ stdout: JSON.stringify(args[1] === 'submit' ? { id: '11111111-1111-1111-1111-111111111111' }
      : args[1] === 'log' ? { jobId: '22222222-2222-2222-2222-222222222222', status: 'Accepted' } : { status: 'Accepted' }) }),
  }), /completed log does not match/);
  assert.ok(fs.existsSync(path.join(dir, 'app-accepted.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'app-notary-log.json')));
});

test('CLI keeps sign-only compatibility and validates explicit paths/variants', () => {
  assert.equal(signer.options(['--sign-only']).variant, 'manual');
  assert.equal(signer.options(['--variant', 'tracking', '--app', '/tmp/Tracking.app']).variant, 'tracking');
  assert.throws(() => signer.options(['--app', 'relative.app']), /absolute/);
  assert.throws(() => signer.options(['--variant', 'other']), /manual or tracking/);
  assert.throws(() => signer.options(['--dmg', '/tmp/a.dmg']), /dmg-only/);
  assert.throws(() => signer.options(['--sign-only', '--check-credentials']), /one signing operation/);
});

test('artifact reports never carry a prior runtime pass or commit onto a different app', t => {
  const directory = fixture(t), runtime = path.join(directory, 'runtime.json'), source = path.join(directory, 'source.json');
  fs.writeFileSync(runtime, JSON.stringify({ dmg: { sha256: 'a'.repeat(64) }, criteria: { c1: 'PASS fixture' } }));
  assert.equal(artifact.runtimeEvidence(runtime, 'a'.repeat(64)).status, 'PASS');
  assert.equal(artifact.runtimeEvidence(runtime, 'b'.repeat(64)).status, 'UNMATCHED');
  assert.equal(artifact.runtimeEvidence(undefined, 'a'.repeat(64)).status, 'NOT_RUN');
  fs.writeFileSync(source, JSON.stringify({ sourceCommit: 'a'.repeat(40), sourceDirty: false, appAsarSha256: 'a'.repeat(64) }));
  assert.equal(artifact.sourceEvidence(source, 'a'.repeat(64)).status, 'COMMIT_BUILD');
  assert.equal(artifact.sourceEvidence(source, 'b'.repeat(64)).status, 'UNMATCHED');
});
